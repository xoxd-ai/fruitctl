// SPDX-License-Identifier: MIT
// D11: hash-chained action journal. One JSONL file per broker session UUID.
// Each record commits to its predecessor, so an edit, deletion, insertion or
// reordering anywhere in the file breaks verification from that point on.
// Records summarize what the broker returned; they never hold images or
// secret text, only the SHA-256 of each returned frame.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LENGTH_CLASSES, SECRET_PROVIDERS, SECRET_REF } from './secrets.mjs';

export const JOURNAL_SCHEMA = 'fruitctl.journal.v1';
export const GENESIS_HASH = '0'.repeat(64);
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MAX_TEXT = 256;
const MAX_PROVENANCE_BYTES = 2048;
const MAX_VERIFY_BYTES = 256 * 1024 * 1024;
// Credential-like parameter names. `key` alone is a keyboard key, not a secret.
const CREDENTIAL_FIELD = /pass(word|phrase|wd)?|secret|token|credential|api_?key|private_?key|otp|pin_?code|auth/i;
const REDACTED = '[redacted]';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const bounded = value => typeof value === 'string' && value.length > MAX_TEXT
  ? value.slice(0, MAX_TEXT) : value;

/** Deterministic JSON: object keys sorted at every depth. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item ?? null)).join(',')}]`;
  if (object(value)) {
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function recordHash(record) {
  const { hash: _hash, ...body } = record;
  return sha256(canonicalJson(body));
}

function redactValue(value, depth = 0) {
  if (depth > 4) return REDACTED;
  if (Array.isArray(value)) return value.slice(0, 64).map(item => redactValue(item, depth + 1));
  if (!object(value)) return bounded(value);
  return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) =>
    [key, CREDENTIAL_FIELD.test(key) ? REDACTED : redactValue(item, depth + 1)]));
}

// D16: what a type_secret record may name, each only in its expected shape.
// A refused request can carry a value in any field, x included.
const SECRET_STEP_FIELDS = {
  ref: value => typeof value === 'string' && SECRET_REF.test(value),
  x: Number.isInteger,
  y: Number.isInteger,
  provider: value => SECRET_PROVIDERS.includes(value),
  length_class: value => LENGTH_CLASSES.includes(value),
};

/** Action parameters without the action name. A type_secret step keeps only
 * a well-formed {ref, x, y, provider, length_class}; every other field of it,
 * and every credential-like field anywhere, is replaced before anything
 * reaches disk. */
export function redactParams(action) {
  const { action: _name, ...params } = object(action) ? action : {};
  const redacted = redactValue(params);
  if (action?.action === 'type_secret') {
    for (const key of Object.keys(redacted)) {
      if (!Object.hasOwn(SECRET_STEP_FIELDS, key) || !SECRET_STEP_FIELDS[key](params[key])) redacted[key] = REDACTED;
    }
  }
  return redacted;
}

/** SHA-256 of the decoded bytes of a returned base64 frame, or null. */
export function frameSha256(image) {
  if (typeof image !== 'string' || !image.length) return null;
  return sha256(Buffer.from(image, 'base64'));
}

function provenanceOf(result) {
  if (!object(result) || result.provenance === undefined) return undefined;
  const text = canonicalJson(result.provenance);
  return Buffer.byteLength(text) <= MAX_PROVENANCE_BYTES
    ? JSON.parse(text) : { truncated: true, sha256: sha256(text) };
}

/** Bounded, image-free summary of one action's outcome. */
export function summarizeResponse(response) {
  if (!object(response)) return { summary: { outcome: 'not_run' }, frame: null };
  if (response.error) {
    return { summary: { outcome: 'error', error: { code: response.error.code ?? null,
      message: bounded(String(response.error.message ?? '')),
      ...(typeof response.error.data?.reason === 'string' ? { reason: bounded(response.error.data.reason) } : {}) } },
    frame: null, provenance: provenanceOf(response.error.data) };
  }
  const result = object(response.result) ? response.result : {};
  const summary = { outcome: 'ok' };
  if (typeof result.detail === 'string') summary.detail = bounded(result.detail);
  for (const key of ['x', 'y', 'scaledWidth', 'scaledHeight']) {
    if (Number.isFinite(result[key])) summary[key] = result[key];
  }
  if (Array.isArray(result.elements)) summary.elements = result.elements.length;
  return { summary, frame: frameSha256(result.image), provenance: provenanceOf(result) };
}

export class Journal {
  constructor({ dir, now = () => new Date(), onError = () => {} }) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Journal directory must be absolute');
    this.dir = dir;
    this.now = now;
    this.onError = onError;
    this.heads = new Map();
    this.tail = Promise.resolve();
    this.failures = 0;
    this.lastError = null;
  }

  fileFor(session) {
    if (!SESSION.test(session)) throw new Error('Journal session must be a UUID');
    return path.join(this.dir, `${session.toLowerCase()}.jsonl`);
  }

  async prepare() {
    if (this.prepared) return;
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
      throw new Error('Journal directory must be user-owned with mode 0700');
    }
    this.prepared = true;
  }

  async head(session, file) {
    if (this.heads.has(session)) return this.heads.get(session);
    // Continue an existing chain only after it verifies; never extend a broken one.
    const existing = await fs.stat(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    let head = { seq: 0, hash: GENESIS_HASH };
    if (existing) {
      const verified = await verifyJournal(file);
      if (!verified.ok) throw new Error(`Existing journal fails verification: ${verified.reason}`);
      head = { seq: verified.records, hash: verified.head };
    }
    this.heads.set(session, head);
    return head;
  }

  /** Serialize appends. Journal failures are recorded, never thrown into the
   * action path: the input already happened and its result still returns. */
  append(entries) {
    const work = this.tail.then(async () => {
      await this.prepare();
      for (const entry of entries) {
        const file = this.fileFor(entry.session);
        const head = await this.head(entry.session, file);
        const record = { schema: JOURNAL_SCHEMA, seq: head.seq + 1, ts: this.now().toISOString(),
          session: entry.session, target: entry.target, method: entry.method,
          params: entry.params, result: entry.result, frame_sha256: entry.frame ?? null,
          ...(entry.provenance === undefined ? {} : { provenance: entry.provenance }),
          prev_hash: head.hash };
        record.hash = recordHash(record);
        await fs.appendFile(file, JSON.stringify(record) + '\n', { mode: 0o600 });
        this.heads.set(entry.session, { seq: record.seq, hash: record.hash });
      }
    }).catch(error => {
      // A failed append may have left a partial record. Forget cached heads so
      // the next append re-verifies the file instead of extending it blindly.
      this.heads.clear();
      this.failures++;
      this.lastError = String(error?.message || 'Journal write failed').slice(0, 256);
      this.onError(error);
    });
    this.tail = work;
    return work;
  }

  flush() { return this.tail; }

  status() {
    return { dir: this.dir, failures: this.failures, ...(this.lastError ? { last_error: this.lastError } : {}) };
  }
}

/** Verify one journal file. Returns { ok, records, head, session } or
 * { ok: false, line, reason } naming the first record that breaks the chain. */
export async function verifyJournal(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_VERIFY_BYTES) return { ok: false, line: 0, reason: 'not a bounded regular file' };
  const text = await fs.readFile(file, 'utf8');
  if (text.length && !text.endsWith('\n')) {
    return { ok: false, line: text.split('\n').length, reason: 'truncated final record' };
  }
  const lines = text.split('\n').slice(0, -1);
  let previous = GENESIS_HASH;
  let session;
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    let record;
    try { record = JSON.parse(lines[index]); } catch { return { ok: false, line, reason: 'invalid JSON' }; }
    if (!object(record) || record.schema !== JOURNAL_SCHEMA) return { ok: false, line, reason: 'unknown schema' };
    if (record.seq !== line) return { ok: false, line, reason: 'sequence gap or reorder' };
    if (typeof record.session !== 'string' || !SESSION.test(record.session) ||
        (session !== undefined && record.session !== session)) {
      return { ok: false, line, reason: 'session mismatch' };
    }
    session = record.session;
    if (record.prev_hash !== previous) return { ok: false, line, reason: 'previous hash mismatch' };
    if (typeof record.hash !== 'string' || !HASH.test(record.hash) || recordHash(record) !== record.hash) {
      return { ok: false, line, reason: 'record hash mismatch' };
    }
    previous = record.hash;
  }
  return { ok: true, records: lines.length, head: previous, ...(session ? { session } : {}) };
}
