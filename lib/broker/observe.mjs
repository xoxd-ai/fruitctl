// SPDX-License-Identifier: MIT
// Broker action observation for the D11 journal and D30 latency telemetry.
// A watch wraps one serialized lane batch. It records what the lane returned
// and never gates, delays or alters admission, input or the returned result.
import { randomUUID } from 'node:crypto';
import { isPreAdmissionRefusal } from '../mcp/capabilities.js';
import path from 'node:path';
import { Journal, redactParams, summarizeResponse } from './journal.mjs';
import { LatencyTelemetry, telemetryOptions } from './telemetry.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const MAX_METHOD = 256;

/** Journal and telemetry from `config.journal` / `config.telemetry`. The
 * journal defaults on under the broker state dir (`{ enabled: false }` turns
 * it off); telemetry stays off until a directory is configured. */
export function brokerObservability(config, { stateDir, log = () => {} }) {
  const journalConfig = config.journal ?? {};
  if (!object(journalConfig) || (journalConfig.enabled !== undefined && typeof journalConfig.enabled !== 'boolean') ||
      (journalConfig.dir !== undefined && (typeof journalConfig.dir !== 'string' || !path.isAbsolute(journalConfig.dir)))) {
    throw new Error('Invalid journal configuration');
  }
  const reporter = name => {
    let last;
    return error => {
      const message = String(error?.message || 'write failed').slice(0, 256);
      if (message !== last) log(`Fruitctl ${name} write failed: ${message}`);
      last = message;
    };
  };
  const journal = journalConfig.enabled === false ? null
    : new Journal({ dir: journalConfig.dir ?? path.join(stateDir, 'journal'), onError: reporter('journal') });
  const options = telemetryOptions(config.telemetry);
  const telemetry = options ? new LatencyTelemetry({ ...options, onError: reporter('telemetry') }) : null;
  return { journal, telemetry };
}

export class ActionObserver {
  constructor({ journal = null, telemetry = null, now = () => performance.now() } = {}) {
    this.journal = journal;
    this.telemetry = telemetry;
    this.now = now;
  }

  batch(lane, actions) {
    if ((!this.journal && !this.telemetry) || !Array.isArray(actions) || !actions.length ||
        actions.some(action => !object(action) || typeof action.action !== 'string')) return null;
    return new BatchWatch(this, lane, actions);
  }

  flush() {
    return Promise.all([this.journal?.flush(), this.telemetry?.flush()]);
  }

  status() {
    return { ...(this.journal ? { journal: this.journal.status() } : {}),
      ...(this.telemetry ? { telemetry: this.telemetry.status() } : {}) };
  }
}

class BatchWatch {
  constructor(observer, lane, actions) {
    this.observer = observer;
    this.lane = lane;
    // Copy the request before the executor sees it; the journal records intent.
    // Client action names are unvalidated until the executor sees them; bound
    // them like any other journalled text.
    this.actions = actions.map(action => ({ method: action.action.slice(0, MAX_METHOD), params: redactParams(action) }));
    // The lease owner (the broker client UUID) names the journal session.
    this.session = lane.owner ?? (lane.anonymousSession ||= randomUUID());
    this.requestedAt = observer.now();
    this.mark = this.requestedAt;
    this.marks = [];
    this.settled = false;
  }

  /** The lane's resolved description of the same steps (D16 adds each
   * type_secret's length_class once its ref resolves). */
  describe(actions) {
    if (this.settled || !Array.isArray(actions) || actions.length !== this.actions.length ||
        actions.some(action => !object(action) || typeof action.action !== 'string')) return;
    this.actions = actions.map(action => ({ method: action.action.slice(0, MAX_METHOD), params: redactParams(action) }));
  }

  /** The lane dequeued this batch and has a ready executor. */
  admitted() {
    if (this.settled || this.admittedAt !== undefined) return;
    this.admittedAt = this.observer.now();
    this.mark = this.admittedAt;
  }

  progress() {
    if (this.settled || this.admittedAt === undefined) return;
    const now = this.observer.now();
    this.marks.push(now - this.mark);
    this.mark = now;
  }

  done(responses) { this.settle(Array.isArray(responses) ? responses : [], null); }

  failed(error) { this.settle(Array.isArray(error?.responses) ? error.responses : [], error); }

  settle(responses, error) {
    if (this.settled) return;
    this.settled = true;
    const end = this.observer.now();
    const route = this.lane.presentation?.route ?? 'unknown';
    const target = this.lane.name ?? 'unknown';
    const admitted = this.admittedAt !== undefined;
    const refused = Boolean(error) && isPreAdmissionRefusal(error);
    const completed = Math.min(responses.length, this.actions.length);
    // Executors without per-action progress share the unmarked time evenly.
    const inFlight = error && admitted && !refused && completed < this.actions.length ? 1 : 0;
    const unmarked = Math.max(0, completed + inFlight - this.marks.length);
    const share = unmarked ? Math.max(0, end - this.mark) / unmarked : 0;
    const latency = index => index < this.marks.length
      ? { latencyMs: this.marks[index] } : { latencyMs: share, estimated: true };
    const failure = error ? { code: typeof error.code === 'string' || Number.isInteger(error.code) ? error.code : null,
      message: String(error.message || 'Operation failed').slice(0, 256) } : undefined;
    const entries = [];
    const samples = [];
    this.actions.forEach(({ method, params }, index) => {
      let outcome, summary, frame, provenance, timing;
      if (index < completed) {
        ({ summary, frame, provenance } = summarizeResponse(responses[index]));
        outcome = summary.outcome;
        timing = latency(index);
      } else if (refused) {
        outcome = 'refused';
      } else if (error && !admitted) {
        outcome = 'not_admitted';
      } else if (error && index === completed) {
        outcome = 'failed';
        timing = latency(index);
      } else {
        outcome = 'not_run';
      }
      summary ||= { outcome, ...(failure && outcome !== 'not_run' ? { error: failure } : {}) };
      entries.push({ session: this.session, target, method, params, result: summary,
        frame, ...(provenance === undefined ? {} : { provenance }) });
      // One telemetry sample per executed action; a batch that never reached
      // the executor counts once under its first method.
      if (timing) {
        samples.push({ session: this.session, target, method, route, outcome, ...timing,
          ...(index === 0 ? { queueMs: this.admittedAt - this.requestedAt } : {}) });
      } else if (index === 0 && (outcome === 'refused' || outcome === 'not_admitted')) {
        samples.push({ session: this.session, target, method, route, outcome,
          latencyMs: end - this.requestedAt });
      }
    });
    void this.observer.journal?.append(entries);
    void this.observer.telemetry?.record(samples);
  }
}
