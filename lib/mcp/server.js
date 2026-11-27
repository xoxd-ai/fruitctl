// SPDX-License-Identifier: MIT
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { vncCommandTool, actionQueueTool, controlTools, validateActionParameters, validateActionBatch, normalizeKeyNames,
  BATCH_ONLY_ACTIONS, INPUT_REFUSED_CODE, inputRefusal, EXPECT_TIMEOUT_MS, RESERVED_EXPECTATIONS } from '../../tools/index.js';
import { ResponseBudget, MAX_BATCH_RESPONSE_BYTES, MAX_BATCH_RESPONSES,
  validateResponse, responseMetadata } from './protocol.js';
import { replyBudget } from '../deadlines.mjs';
import { advertisedCapabilities, presentationLabels, unattestedLabels,
  TYPED_REFUSAL_CODES, DESKTOP_REFUSAL_CODES, BRIDGE_ERROR_CODES, desktopRefusalData } from './capabilities.js';
import { computerTool, translateComputerAction, admitComputerPlan, extendedActions } from '../../tools/computer-alias.js';

export const TOOL_TIMEOUT_MS = 30000;

// One error shape for every failed result: {code?, message, data?}. A native
// JSON-RPC error keeps its code and data (for example -32010 stale_screen
// with data.reason); a transport or local failure carries its message only,
// except a typed pre-admission refusal (for example unsupported_on_route).
export function errorRecord(message, error) {
  return { ...(error?.code === undefined ? {} : { code: error.code }), message: String(message),
    ...(error?.data === undefined ? {} : { data: error.data }) };
}

// Locally typed refusals keep their code on a thrown error, and a
// desktop-state refusal also its data (reason, dialog owner); any other
// thrown error (transport, deadline, cancellation) carries its message only.
const TYPED_REFUSALS = new Set(['unsupported_action', 'unsupported_expectation', ...TYPED_REFUSAL_CODES,
  ...DESKTOP_REFUSAL_CODES, ...BRIDGE_ERROR_CODES]);
function thrownError(error) {
  if (!TYPED_REFUSALS.has(error?.code)) return undefined;
  const data = desktopRefusalData(error);
  return { code: error.code, ...(data ? { data } : {}) };
}

// One line for the agent when the broker's desktop state shows something in
// the way. Health always reports it; a screenshot only when it matters.
function desktopStateText(state, always) {
  if (!state || typeof state !== 'object') return undefined;
  if (state.sentinel !== 'ok') return always ? `desktop state: unknown (${state.reason ?? 'unavailable'})` : undefined;
  const parts = [];
  if (state.locked === true) parts.push(state.console === 'loginwindow' ? 'login window' : 'screen locked');
  if (state.display_asleep === true) parts.push('display asleep');
  if (state.consent_dialog && typeof state.consent_dialog === 'object') {
    parts.push(`${state.consent_dialog.kind} dialog from ${state.consent_dialog.owner} on screen; input is refused until a human answers it`);
  }
  if (state.screen_saver === true) parts.push('screen saver running');
  if (typeof state.secure_input_holder === 'string' && state.secure_input_holder !== 'unknown') {
    parts.push(`Secure Input held by ${state.secure_input_holder}`);
  }
  if (state.other_input_owner && typeof state.other_input_owner === 'object') {
    parts.push(`other input owner: ${state.other_input_owner.owner}`);
  }
  if (!parts.length) return always ? 'desktop state: clear' : undefined;
  return `desktop state: ${parts.join('; ')}`;
}

/** Expand action_queue steps into native actions. A step's expect becomes
 * private observation primitives around it, evaluated with fresh captures in
 * the same executor operation so an unmet expectation stops the batch:
 * expect_baseline before the step, then expect_change, then wait_for_stable.
 * `owners[i]` names the step (and role) that native action i belongs to. */
export function expandQueue(steps) {
  const actions = [];
  const owners = [];
  steps.forEach(({ expect, ...action }, step) => {
    const add = (native, role) => { actions.push(native); owners.push({ step, role }); };
    const timeout = expect?.timeout_ms ?? EXPECT_TIMEOUT_MS;
    if (expect?.change_in) add({ action: 'expect_baseline' }, 'change_in');
    add(action, 'step');
    if (expect?.change_in) add({ action: 'expect_change', ...expect.change_in, timeout_ms: timeout }, 'change_in');
    if (expect?.stable_ms !== undefined) {
      // timeout_ms bounds settling; the unchanged window itself comes on top.
      add({ action: 'wait_for_stable', stable_ms: expect.stable_ms,
        timeout_ms: timeout + expect.stable_ms }, 'stable_ms');
    }
  });
  return { actions, owners };
}

function reservedExpectation(steps) {
  for (let index = 0; index < steps.length; index++) {
    const kind = RESERVED_EXPECTATIONS.find(name => steps[index].expect?.[name] !== undefined);
    if (kind) return { index, kind };
  }
}

// One-line summaries of the structured observation results.
function observationText({ diff, zoom, stable }) {
  const lines = [];
  if (diff) {
    lines.push(`diff: changed ${diff.changed} (ratio ${diff.changed_ratio}, baseline ${diff.baseline}); boxes ` +
      `${JSON.stringify(diff.boxes)}${diff.boxes_truncated ? ' (truncated)' : ''}`);
  }
  if (zoom) {
    lines.push(`zoom region: ${JSON.stringify(zoom.region)}; image ${zoom.image_width}×${zoom.image_height}`);
  }
  if (stable) lines.push(`stable: ${stable.stable_for_ms}ms after ${stable.elapsed_ms}ms (${stable.captures} captures)`);
  return lines;
}

// Every tool result carries D7 route/indicator labels in structured output.
// A failure cannot attest the indicator, so `present` becomes `unknown`.
export function errorResult(message, labels, error) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true,
    ...(labels ? { structuredContent: { error: errorRecord(message, error), ...unattestedLabels(labels) } } : {}) };
}

// Typed alias refusals and failures keep their code beside the message: an
// alias code (unsupported_action, invalid_arguments, unsupported_key), a
// broker/executor string code, or a daemon's integer JSON-RPC code.
const errorCode = (value) => typeof value === 'string' || Number.isInteger(value) ? value : undefined;

function aliasErrorResult(error, labels, alias) {
  const code = errorCode(error?.code);
  const data = desktopRefusalData(error);
  return { content: [{ type: 'text', text: `Error: ${error?.message ?? error}` }], isError: true,
    structuredContent: { error: String(error?.message ?? error), ...(code === undefined ? {} : { code }),
      ...(data ? { data } : {}), ...(alias ? { alias } : {}), ...unattestedLabels(labels) } };
}

function formatResponse(response, labels, action) {
  if (response.error) {
    // An interrupted Host input carries its readback frame (#157).
    const readback = response.error.data?.readback;
    if (readback && typeof readback.image === 'string') {
      const { image, ...frame } = readback;
      const result = errorResult(response.error.message, labels,
        { ...response.error, data: { ...response.error.data, readback: frame } });
      result.content.push({ type: 'image', data: image,
        mimeType: frame.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png' });
      return result;
    }
    return errorResult(response.error.message, labels, response.error);
  }
  const { detail, image, x, y, scaledWidth, scaledHeight, elements, timing, ax_snapshot: axSnapshot } = response.result;
  const content = [];
  if (detail) content.push({ type: 'text', text: detail });
  if (image) content.push({ type: 'image', data: image,
    mimeType: response.result.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png' });
  if (elements) content.push({ type: 'text', text: JSON.stringify(elements) });
  if (axSnapshot) content.push({ type: 'text', text: JSON.stringify(axSnapshot) });
  if (timing) content.push({ type: 'text', text: JSON.stringify(timing) });
  if (x !== undefined && y !== undefined) content.push({ type: 'text', text: `cursor: (${x}, ${y})` });
  for (const text of observationText(response.result)) content.push({ type: 'text', text });
  const clipboard = response.result.clipboard;
  if (clipboard?.redacted) {
    content.push({ type: 'text', text: 'clipboard: withheld; it contains a declared secret' });
  } else if (typeof clipboard?.text === 'string') {
    content.push({ type: 'text', text: clipboard.text });
    content.push({ type: 'text', text: `clipboard: ${clipboard.bytes} bytes, ${clipboard.encoding}` +
      `${clipboard.fresh ? ', fresh' : `, ${clipboard.age_ms}ms old`}${clipboard.truncated ? ', truncated' : ''}` });
  }
  if (scaledWidth !== undefined && !image) {
    content.push({ type: 'text', text: `display: ${scaledWidth}×${scaledHeight}` });
  }
  if (action === 'health') content.push({ type: 'text', text: `route: ${labels.route}; indicator: ${labels.indicator}` });
  const desktop = desktopStateText(response.result.desktop_state, action === 'health');
  if (desktop) content.push({ type: 'text', text: desktop });
  if (!content.length) content.push({ type: 'text', text: 'OK' });
  // The image already has its native MCP content block. Retain only its
  // metadata in structured output instead of serializing base64 twice.
  // Executor-supplied route/indicator fields never override the session's.
  const { image: _image, ...structuredContent } = response.result;
  return { content, structuredContent: { ...structuredContent, ...labels } };
}

/** Executors own target serialization and cancellation. A batch is one call;
 * the ordinary deadline includes every action and time waiting for ownership.
 * Optional onResponse preserves completed progress if the transport is lost. */
export class McpSession {
  constructor(executor, { timeoutMs = TOOL_TIMEOUT_MS,
    maxBatchResponseBytes = MAX_BATCH_RESPONSE_BYTES } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TOOL_TIMEOUT_MS) {
      throw new Error('Invalid MCP tool deadline');
    }
    new ResponseBudget({ maxBytes: maxBatchResponseBytes });
    this.executor = executor;
    this.timeoutMs = timeoutMs;
    this.maxBatchResponseBytes = maxBatchResponseBytes;
    this.display = { width: null, height: null };
    // Capability metadata last reported by a health result; undefined until
    // observed. Executors that expose live metadata take precedence.
    this.capabilities = undefined;
    this.generation = executor?.generation;
  }

  /** TIN-8604: metadata learned on an earlier broker connection does not
   * describe a reconnected one, so it is dropped when the connection changes. */
  forgetEarlierConnection() {
    if (this.executor?.generation === this.generation) return;
    this.generation = this.executor.generation;
    this.display = { width: null, height: null };
    this.capabilities = undefined;
  }

  // `timeoutMs` narrows the deadline when one tool call spans several batches;
  // timeout messages still name the tool deadline the caller was promised.
  async execute(actions, signal, { timeoutMs = this.timeoutMs } = {}) {
    if (!Array.isArray(actions) || !actions.length || actions.length > MAX_BATCH_RESPONSES) {
      throw new Error('Invalid executor action batch');
    }
    // Punctuation key names become their characters before anything is sent.
    actions = actions.map(normalizeKeyNames);
    for (const action of actions) validateActionParameters(action);
    validateActionBatch(actions);
    if (signal?.aborted) throw new Error('Tool request cancelled');
    const controller = new AbortController();
    const deadline = performance.now() + Math.max(0, Math.min(this.timeoutMs, timeoutMs));
    const progress = [];
    const progressBudget = new ResponseBudget({ maxBytes: this.maxBatchResponseBytes,
      maxResponses: actions.length });
    let active = true;
    let timer;
    let onAbort;
    const interruption = new Promise((_, reject) => {
      const interrupt = (message) => {
        const error = new Error(message);
        controller.abort(error);
        error.responses = [...progress];
        reject(error);
      };
      onAbort = () => interrupt('Tool request cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => interrupt(`Tool request timed out after ${this.timeoutMs}ms`),
        Math.max(0, deadline - performance.now()));
    });
    try {
      const responses = await Promise.race([
        Promise.resolve().then(() => {
          const remaining = deadline - performance.now();
          if (controller.signal.aborted || remaining <= 0) {
            throw controller.signal.reason || new Error(`Tool request timed out after ${this.timeoutMs}ms`);
          }
          return this.executor.execute(actions, {
            signal: controller.signal, timeoutMs: replyBudget(remaining),
            onResponse: (response) => {
              if (!active || controller.signal.aborted || performance.now() >= deadline) return;
              try {
                progress.push(progressBudget.add(responseMetadata(validateResponse(response))));
              } catch (error) {
                controller.abort(error);
                error.responses = [...progress];
                throw error;
              }
            },
          });
        }),
        interruption,
      ]);
      if (controller.signal.aborted || performance.now() >= deadline) {
        const error = controller.signal.reason || new Error(`Tool request timed out after ${this.timeoutMs}ms`);
        controller.abort(error);
        error.responses = [...progress];
        throw error;
      }
      if (!Array.isArray(responses) || responses.length > actions.length) {
        throw new Error('Invalid executor batch response');
      }
      this.forgetEarlierConnection();
      const validated = [];
      const budget = new ResponseBudget({ maxBytes: this.maxBatchResponseBytes,
        maxResponses: actions.length });
      for (const response of responses) {
        try { validated.push(budget.add(validateResponse(response))); }
        catch (error) { error.responses = validated; throw error; }
        const result = response.result;
        if (result?.scaledWidth !== undefined) {
          this.display = { width: result.scaledWidth, height: result.scaledHeight };
        }
        const advertised = advertisedCapabilities(result?.capabilities);
        if (advertised) this.capabilities = advertised;
        if (response.error) break;
      }
      if (!validated.some((response) => response.error) && validated.length !== actions.length) {
        const error = new Error('Executor returned incomplete batch results');
        error.responses = validated;
        throw error;
      }
      return validated;
    } catch (error) {
      controller.abort(error);
      // Executors may attach partial results even without onResponse. Admit
      // those with the same limits before retaining or formatting them.
      const partial = [];
      const budget = new ResponseBudget({ maxBytes: this.maxBatchResponseBytes,
        maxResponses: actions.length });
      const candidates = Array.isArray(error.responses) ? error.responses : progress;
      try {
        for (const response of candidates) {
          const admitted = budget.add(responseMetadata(validateResponse(response)));
          partial.push(admitted);
          if (admitted.error) break;
        }
      } catch (invalid) { error = invalid; }
      error.responses = partial;
      throw error;
    } finally {
      active = false;
      this.forgetEarlierConnection();
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async release(signal) {
    if (signal?.aborted) throw new Error('Tool request cancelled');
    if (typeof this.executor.release !== 'function') return;
    const controller = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    let timer;
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      const interrupt = (message) => {
        const error = new Error(message);
        controller.abort(error);
        reject(error);
      };
      onAbort = () => interrupt('Tool request cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => interrupt(`Ownership release timed out after ${this.timeoutMs}ms`), this.timeoutMs);
    });
    try {
      await Promise.race([Promise.resolve().then(() => {
        const remaining = deadline - performance.now();
        if (controller.signal.aborted || remaining <= 0) {
          throw controller.signal.reason || new Error(`Ownership release timed out after ${this.timeoutMs}ms`);
        }
        return this.executor.release({ signal: controller.signal, timeoutMs: replyBudget(remaining) });
      }), interrupted]);
      if (controller.signal.aborted || performance.now() >= deadline) {
        const error = controller.signal.reason || new Error(`Ownership release timed out after ${this.timeoutMs}ms`);
        controller.abort(error);
        throw error;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** D7 labels read after each call: the Host indicator can change. */
  labels() { return presentationLabels(this.executor.presentation); }

  /** Live executor metadata, else the last health advertisement, else undefined. */
  aliasCapabilities() {
    this.forgetEarlierConnection();
    return advertisedCapabilities(this.executor.capabilities) ?? this.capabilities;
  }

  /** Anthropic computer / OpenAI computer_call alias: translate, admit against
   * capabilities, then run as one batch with action_queue's semantics. */
  async computer(input, signal) {
    // The probe and the batch share one tool deadline, as action_queue does.
    const deadline = performance.now() + this.timeoutMs;
    let plan;
    try {
      plan = translateComputerAction(input);
      if (extendedActions(plan).length && this.aliasCapabilities() === undefined) {
        // A broker client learns capabilities only from health. One read-only
        // probe precedes admission; it never authorizes input on its own.
        await this.execute([{ action: 'health' }], signal);
      }
      admitComputerPlan(plan, this.aliasCapabilities());
    } catch (error) {
      return aliasErrorResult(error, this.labels(), plan
        ? { shape: plan.shape, action: plan.action, ...(error.missing ? { missing: error.missing } : {}) }
        : { action: error.action ?? 'unknown' });
    }
    const alias = { shape: plan.shape, action: plan.action, actions: plan.steps.map(step => step.action) };
    let responses;
    let failure;
    try { responses = await this.execute(plan.steps, signal, { timeoutMs: deadline - performance.now() }); }
    catch (error) { responses = error.responses || []; failure = error; }
    if (plan.steps.length === 1) {
      if (failure) return aliasErrorResult(failure, this.labels(), alias);
      const [response] = responses;
      const formatted = formatResponse(response, this.labels(), plan.steps[0].action);
      const code = errorCode(response.error?.code) === undefined ? {} : { code: response.error.code };
      return { ...formatted, structuredContent: { ...formatted.structuredContent, ...code, alias } };
    }
    const lines = [];
    let completed = 0;
    let failedIndex;
    let code;
    for (let i = 0; i < responses.length; i++) {
      const response = responses[i];
      const action = plan.steps[i].action;
      if (response.error) {
        lines.push(`[${i + 1}] ${action}: ERROR — ${response.error.message}`);
        failedIndex = i + 1;
        code = errorCode(response.error.code);
        break;
      }
      lines.push(`[${i + 1}] ${action}: ${response.result?.detail || 'OK'}`);
      completed++;
    }
    if (failure) {
      failedIndex = completed + 1;
      lines.push(`[${failedIndex}] ${plan.steps[completed]?.action || 'batch'}: ERROR — ${failure.message}`);
      code = errorCode(failure.code);
    }
    const data = failure ? desktopRefusalData(failure) : undefined;
    return {
      content: [{ type: 'text', text: `${plan.action}:\n${lines.join('\n')}` }],
      ...(failedIndex === undefined ? {} : { isError: true }),
      structuredContent: { completed, alias, ...(failedIndex === undefined ? { ...this.labels() }
        : { failedIndex, ...(code === undefined ? {} : { code }), ...(data ? { data } : {}),
          ...unattestedLabels(this.labels()) }) },
    };
  }

  async command(input, signal) {
    // D27: a hold cannot outlive its call, so one vnc_command cannot open or
    // close one. Refused before the executor; nothing is written.
    if (BATCH_ONLY_ACTIONS.has(input.action)) {
      const refusal = inputRefusal('hold_outside_batch',
        `${input.action} is only valid inside one action_queue batch`);
      return errorResult(refusal.message, this.labels(), refusal);
    }
    try {
      const [response] = await this.execute([input], signal);
      return formatResponse(response, this.labels(), input.action);
    } catch (error) { return errorResult(error.message, this.labels(), thrownError(error)); }
  }

  async queue(input, signal) {
    const steps = input.actions;
    // Reserved expectations are refused before anything executes.
    const reserved = reservedExpectation(steps);
    if (reserved) {
      const message = `Expectation ${reserved.kind} is reserved and not supported yet`;
      return {
        content: [{ type: 'text', text: `[${reserved.index + 1}] ${steps[reserved.index].action}: ERROR — ${message}` }],
        isError: true,
        structuredContent: { completed: 0, failedIndex: reserved.index + 1,
          error: errorRecord(message, { code: 'unsupported_expectation' }), ...unattestedLabels(this.labels()) },
      };
    }
    const { actions, owners } = expandQueue(steps);
    let responses;
    let failure;
    let failureError;
    try { responses = await this.execute(actions, signal); }
    catch (error) {
      responses = error.responses || []; failure = error.message;
      // A pre-admission hold refusal keeps its typed code and reason.
      failureError = error.code === INPUT_REFUSED_CODE ? error : thrownError(error);
    }
    // Per step: its own result line, then any expectation outcomes.
    const lines = steps.map(() => []);
    const notes = steps.map(() => []);
    const settled = steps.map(() => 0);
    let failedStep;
    let failedError;
    for (let i = 0; i < responses.length; i++) {
      const response = responses[i];
      const { step, role } = owners[i];
      const prefix = role === 'step' ? '' : `expect ${role}: `;
      if (response.error) {
        lines[step].push(`ERROR — ${prefix}${response.error.message}`);
        failedStep = step;
        // Typed native failures (e.g. stale_screen) keep their code and data.
        failedError = errorRecord(response.error.message, response.error);
        break;
      }
      settled[step]++;
      if (role === 'step') lines[step].push(response.result?.detail || 'OK');
      else if (response.result?.diff && role === 'change_in') {
        notes[step].push(`change_in observed (ratio ${response.result.diff.changed_ratio})`);
      } else if (response.result?.stable) notes[step].push(`stable ${response.result.stable.stable_for_ms}ms`);
    }
    if (failure && failedStep === undefined) {
      // The interrupted native action's step; past the last step when every
      // action answered but the batch still failed (for example its deadline).
      failedStep = owners[responses.length]?.step ?? steps.length;
      failedError = errorRecord(failure, failureError);
    } else if (failure) {
      // A native typed error at the same step outranks the transport message.
      failedError ??= errorRecord(failure, failureError);
    }
    const ownedBy = steps.map((_, step) => owners.filter(owner => owner.step === step).length);
    let completed = 0;
    while (completed < steps.length && completed !== failedStep && settled[completed] === ownedBy[completed]) completed++;
    const results = [];
    for (let step = 0; step <= Math.min(failedStep ?? steps.length - 1, steps.length - 1); step++) {
      if (step !== failedStep && !lines[step].length) break;
      if (step === failedStep && failure) lines[step].push(`ERROR — ${failure}`);
      results.push(`[${step + 1}] ${steps[step].action}: ${lines[step].join('; ')}` +
        (notes[step].length ? ` [${notes[step].join('; ')}]` : ''));
    }
    if (failedStep === steps.length) results.push(`[${failedStep + 1}] batch: ERROR — ${failure}`);
    const failedIndex = failedStep === undefined ? undefined : failedStep + 1;
    return {
      content: [{ type: 'text', text: results.join('\n') }],
      ...(failedIndex === undefined ? {} : { isError: true }),
      structuredContent: { completed, ...(failedIndex === undefined ? { ...this.labels() }
        : { failedIndex, error: failedError, ...unattestedLabels(this.labels()) }) },
    };
  }
}

export function createMcpServer({ executor, name = 'fruitctl', version = '0.1.0',
  timeoutMs, maxBatchResponseBytes } = {}) {
  if (typeof executor?.execute !== 'function') throw new Error('MCP executor is required');
  const session = new McpSession(executor, { timeoutMs, maxBatchResponseBytes });
  const server = new McpServer({ name, version }, { capabilities: { tools: {} } });
  const command = vncCommandTool();
  server.registerTool(command.name, {
    description: command.description, inputSchema: command.inputSchema,
  }, (input, extra) => session.command(input, extra.signal));
  const queue = actionQueueTool();
  server.registerTool(queue.name, {
    description: queue.description, inputSchema: queue.inputSchema,
  }, (input, extra) => session.queue(input, extra.signal));
  for (const tool of controlTools()) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema },
      async (input, extra) => {
        try { await session.release(extra.signal); }
        catch (error) { return errorResult(error.message, session.labels()); }
        // Ownership was released: the session no longer holds an indicator.
        const labels = unattestedLabels(session.labels());
        return tool.name === 'task_complete'
          ? { content: [{ type: 'text', text: input.summary }], structuredContent: { summary: input.summary, ...labels } }
          : { content: [{ type: 'text', text: input.reason }], isError: true, structuredContent: { reason: input.reason, ...labels } };
      });
  }
  // Registered last so the four original tools keep their discovery order.
  const computer = computerTool();
  server.registerTool(computer.name, {
    description: computer.description, inputSchema: computer.inputSchema,
  }, (input, extra) => session.computer(input, extra.signal));
  return { server, session };
}

export async function startMcp({ executor, transport = new StdioServerTransport(), ...options }) {
  const { server, session } = createMcpServer({ executor, ...options });
  let closing;
  const close = () => closing ||= (async () => {
    await executor.close?.();
    await server.close();
  })();
  server.server.onclose = () => { void close().catch(() => {}); };
  await server.connect(transport);
  return { server, session, close };
}
