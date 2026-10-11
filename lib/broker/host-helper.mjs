// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { crc32, inflate } from 'node:zlib';
import { promisify } from 'node:util';
import { NdjsonParser, ResponseBudget, responseMetadata } from '../mcp/protocol.js';
import { retirementDeadline } from '../deadlines.mjs';
import { nativeCapabilities, preAdmissionRefusal } from '../mcp/capabilities.js';

const INPUT_ACTIONS = new Set(['mouse_click', 'mouse_double_click', 'mouse_move', 'hover',
  'nudge', 'mouse_drag', 'scroll', 'key_tap', 'key_combo', 'key_type', 'paste']);
const HELPER_TIMEOUT_MS = 500;
const RENEW_INTERVAL_MS = 500;
const INPUT_PERMIT_MS = 1000;
const MAX_LEASE_MS = 3000;
const NATIVE_PERMIT_PROTOCOL = 'fruitctl.native-input-permit.v1';
const NATIVE_GEOMETRY_FIELDS = ['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight',
  'connectionGeneration', 'allocation'];
const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
const CAPTURE_REASONS = new Set(['capture_not_enabled', 'screen_capture_permission_required',
  'configured_display_unavailable', 'own_application_exclusion_unavailable',
  'incomplete_capture', 'capture_failed', 'image_encoding_failed']);
const CAPTURE_PHASES = new Set(['shareable_content', 'capture_image']);
const APPLE_ERROR_DOMAINS = new Set(['SCStreamErrorDomain', 'NSCocoaErrorDomain',
  'NSPOSIXErrorDomain', 'NSOSStatusErrorDomain']);
const CAPTURE_DIAGNOSTIC_FIELDS = new Set(['schema', 'phase', 'apple_domain', 'apple_code']);
const sanitizedRefusals = new WeakMap();
const inflateAsync = promisify(inflate);
const integer = (value, minimum = 1) => Number.isSafeInteger(value) && value >= minimum;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sameBounds = (left, right) => object(left) && object(right) &&
  ['x', 'y', 'width', 'height'].every(key => Number.isFinite(left[key]) && left[key] === right[key]);
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Only locally constructed, pending-matched refusals can accompany a broker
// cleanup failure. Keep the validated text separate from mutable Error fields.
export function hostHelperRefusalMessage(error) {
  return sanitizedRefusals.get(error);
}

function helperRefusal(error, requestId) {
  const prefix = 'Host helper refused request';
  // Correlation comes only from our locally generated, pending-matched UUID.
  // Neither remote free text nor an arbitrary error object crosses this seam.
  if (!CAPTURE_REASONS.has(error.message) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return new Error(prefix);
  }
  const parts = [`${prefix}: ${error.message}`];
  const data = error.data;
  if (object(data) && data.schema === 'fruitctl.host-capture-error.v1' &&
      CAPTURE_PHASES.has(data.phase) && Object.keys(data).length <= 4 &&
      Object.keys(data).every(key => CAPTURE_DIAGNOSTIC_FIELDS.has(key)) &&
      (!Object.hasOwn(data, 'apple_domain') || APPLE_ERROR_DOMAINS.has(data.apple_domain)) &&
      (!Object.hasOwn(data, 'apple_code') ||
        (Object.hasOwn(data, 'apple_domain') && Number.isInteger(data.apple_code) &&
          data.apple_code >= -2147483648 && data.apple_code <= 2147483647))) {
    parts.push(`phase=${data.phase}`);
    if (Object.hasOwn(data, 'apple_domain')) parts.push(`apple_domain=${data.apple_domain}`);
    if (Object.hasOwn(data, 'apple_code')) parts.push(`apple_code=${data.apple_code}`);
  }
  parts.push(`request=${requestId}`);
  const message = parts.join('; ');
  const refusal = new Error(message.length <= 320 ? message : prefix);
  sanitizedRefusals.set(refusal, refusal.message);
  return refusal;
}

function validateConfiguration(config) {
  if (!object(config) || typeof config.sshHost !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.@:[\]-]{0,255}$/.test(config.sshHost) ||
      !Array.isArray(config.command) || config.command.length !== 2 ||
      typeof config.command[0] !== 'string' || !config.command[0].startsWith('/') ||
      !config.command[0].endsWith('/FruitctlHost') ||
      /[\x00-\x1f\x7f]/.test(config.command[0]) || config.command[1] !== '--stdio' ||
      !integer(config.displayId)) throw new Error('Invalid host-helper configuration');
  if (config.mapping !== undefined) {
    const mapping = config.mapping;
    if (!object(mapping) || typeof mapping.qualificationReceipt !== 'string' ||
        !mapping.qualificationReceipt.trim() || mapping.displayId !== config.displayId ||
        !['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight'].every(key => integer(mapping[key])) ||
        !sameBounds(mapping.displayBounds, mapping.displayBounds) ||
        mapping.displayBounds.width <= 0 || mapping.displayBounds.height <= 0) {
      throw new Error('Invalid qualified host-helper mapping');
    }
  }
}

/** The executable's --stdio mode only attaches to a resident same-user app.
 * No opener, bootstrap, service restart, remote shell script, or GUI launch. */
class HelperChannel {
  constructor(config, spawnImpl, onFailure, now) {
    this.pending = new Map();
    this.onFailure = onFailure;
    this.now = now;
    const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    this.child = spawnImpl('ssh', ['-T', '-oBatchMode=yes', '-oForwardAgent=no',
      '-oClearAllForwardings=yes', '-oControlMaster=no', '-oControlPath=none', '-oControlPersist=no',
      '--', config.sshHost, config.command.map(shellQuote).join(' ')],
    { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.childClosed = new Promise(resolve => this.child.once('close', resolve));
    const parser = new NdjsonParser(message => this.receive(message),
      { maxFrameBytes: MAX_IMAGE_BYTES * 2 });
    this.parser = parser;
    this.child.stdout.on('data', chunk => {
      try {
        parser.push(chunk);
        // Large capture frames should not pin their high-water backing buffer
        // throughout the idle broker lifetime after the image is consumed.
        if (!parser.bytes && parser.buffer.length > 65536) parser.buffer = Buffer.alloc(0);
      } catch { this.fail(new Error('Invalid host-helper protocol')); }
    });
    this.child.stdout.once('end', () => {
      try { parser.end(); } catch { /* the transport is rejected either way */ }
      this.fail(new Error('Host-helper transport ended'));
    });
    // Never relay arbitrary remote stderr or protocol values into receipts.
    this.child.stderr?.on('data', () => {});
    this.child.stdin.on('error', () => this.fail(new Error('Host-helper input failed')));
    this.child.once('error', () => this.fail(new Error('Host-helper transport failed')));
    this.child.once('exit', () => this.fail(new Error('Host-helper transport exited')));
  }

  receive(message) {
    if (this.failed || this.closed) return false;
    if (!object(message) || typeof message.id !== 'string' || !this.pending.has(message.id) ||
        typeof message.success !== 'boolean' ||
        (message.success ? !object(message.result) || message.error !== undefined : !object(message.error))) {
      throw new Error('Invalid host-helper response');
    }
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    pending.finish(message.success ? null : helperRefusal(message.error, message.id), message.result);
  }

  request(action, params, { signal, timeoutMs = HELPER_TIMEOUT_MS } = {}) {
    if (this.failed || this.closed) return Promise.reject(this.failed || new Error('Host-helper channel closed'));
    if (signal?.aborted) return Promise.reject(new Error('Host-helper request cancelled'));
    const id = randomUUID();
    const sentAt = this.now();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, result) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve({ result, sentAt, roundTripMs: this.now() - sentAt });
      };
      const abort = () => this.fail(new Error('Host-helper request cancelled'));
      this.pending.set(id, { finish });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => this.fail(new Error('Host-helper receipt deadline exceeded')), timeoutMs);
      this.child.stdin.write(JSON.stringify({ action, params, id }) + '\n', error => {
        if (error) this.fail(new Error('Host-helper input failed'));
      });
    });
  }

  fail(error) {
    if (this.failed || this.closed) return;
    this.failed = error;
    for (const pending of this.pending.values()) pending.finish(error);
    this.pending.clear();
    this.onFailure(error);
    void this.close().catch(() => {});
  }

  close({ signal, timeoutMs = 1250, deadline } = {}) {
    let cutoff;
    try {
      const now = this.now();
      cutoff = Math.min(now + 1250, retirementDeadline({ timeoutMs, deadline, now }));
    } catch (error) { return Promise.reject(error); }
    this.closeDeadline = Math.min(this.closeDeadline ?? Infinity, cutoff);
    const alive = () => this.child.exitCode === null && this.child.signalCode === null;
    if (!this.closing) {
      this.closed = true;
      this.parser?.stop();
      for (const pending of this.pending.values()) pending.finish(new Error('Host-helper channel closed'));
      this.pending.clear();
      const listeners = [];
      const failure = Object.assign(new Error('Host-helper owned SSH exit unconfirmed'), { code: 'release_unconfirmed' });
      this.forceClose = () => {
        if (alive() && !this.closeKillSent) {
          this.closeKillSent = true;
          try { this.child.kill('SIGKILL'); } catch { /* A signal is not exit proof. */ }
        }
      };
      const interrupted = new Promise((_, reject) => {
        this.abortClose = () => { this.forceClose(); reject(failure); };
      });
      this.observeCloseSignal = observed => {
        if (!observed) return;
        const abort = this.abortClose;
        listeners.push([observed, abort]);
        observed.addEventListener('abort', abort, { once: true });
        if (observed.aborted) abort();
      };
      const actualClosure = this.childClosed.then(() => {
        if (this.now() >= this.closeDeadline) throw failure;
      });
      this.closing = Promise.race([actualClosure, interrupted]).finally(() => {
        clearTimeout(this.forceCloseTimer); clearTimeout(this.closeTimer);
        for (const [observed, abort] of listeners) observed.removeEventListener('abort', abort);
        this.observeCloseSignal = null;
      });
      // Keep the actual childClosed promise and sticky closing result even
      // when a caller's shorter inherited cutoff cannot confirm exit.
      this.closing.catch(() => {});
      this.child.stdin.end();
      if (alive()) { try { this.child.kill('SIGTERM'); } catch { /* Await real close. */ } }
    }
    this.observeCloseSignal?.(signal);
    if (this.observeCloseSignal) {
      clearTimeout(this.forceCloseTimer); clearTimeout(this.closeTimer);
      const remaining = this.closeDeadline - this.now();
      if (remaining <= 0) this.abortClose();
      else {
        this.forceCloseTimer = setTimeout(this.forceClose, Math.min(250, remaining * 3 / 4));
        this.closeTimer = setTimeout(this.abortClose, remaining);
      }
    }
    return this.closing;
  }
}

function validateHealth(result, config) {
  if (!object(result) || typeof result.instance_id !== 'string' || !result.instance_id ||
      result.capture_backend !== 'owned_sck' || result.raw_vnc_exclusion !== false ||
      result.display_id !== config.displayId || !integer(result.displayGeneration, 0) ||
      result.capture_enabled !== true || result.screen_capture_permission !== true ||
      result.renewal_interval_ms !== RENEW_INTERVAL_MS || result.input_permit_ms !== INPUT_PERMIT_MS ||
      result.maximum_round_trip_ms !== HELPER_TIMEOUT_MS) throw new Error('Host-helper health binding failed');
  return result;
}

function validateReady(receipt, owner, sequence, challenge, refreshPermit = true) {
  // A delayed renewal must not revive an expired input owner. Check at the
  // acknowledgement boundary as well as in the independent watchdog.
  owner.assertPermit();
  const result = receipt.result;
  if (!object(result) || receipt.roundTripMs > HELPER_TIMEOUT_MS ||
      result.instance_id !== owner.instanceId || result.session_id !== owner.sessionId ||
      result.sequence !== sequence || result.challenge !== challenge ||
      result.display_id !== owner.config.displayId || result.displayGeneration !== owner.generation ||
      result.capture_backend !== 'owned_sck' || result.raw_vnc_exclusion !== false ||
      result.capture_enabled !== true || result.capture_ready !== true ||
      result.overlay_ready !== true || result.ready !== true ||
      !integer(result.ui_heartbeat_age_ms, 0) || result.ui_heartbeat_age_ms > 250 ||
      !integer(result.lease_remaining_ms) || result.lease_remaining_ms > MAX_LEASE_MS ||
      result.renewal_interval_ms !== RENEW_INTERVAL_MS || result.input_permit_ms !== INPUT_PERMIT_MS ||
      result.maximum_round_trip_ms !== HELPER_TIMEOUT_MS) throw new Error('Host-helper activity receipt mismatch');
  if (refreshPermit) owner.refreshPermit(Math.min(receipt.sentAt + INPUT_PERMIT_MS,
    receipt.sentAt + result.lease_remaining_ms));
  return result;
}

function validateNativePermit(response, binding, challenge, granted = false) {
  const result = response?.result;
  if (response?.error || !object(result) ||
      !Object.keys(binding).every(key => result[key] === binding[key]) ||
      typeof result.challenge !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.challenge) ||
      (challenge !== undefined && result.challenge !== challenge) ||
      result.native_permit_protocol !== NATIVE_PERMIT_PROTOCOL ||
      result.input_permit_ms !== INPUT_PERMIT_MS || result.maximum_round_trip_ms !== HELPER_TIMEOUT_MS ||
      !integer(result.native_permit_remaining_ms) || result.native_permit_remaining_ms > INPUT_PERMIT_MS) {
    throw new Error(`Native independent input-permit ${granted ? 'grant' : 'challenge'} unavailable or unconfirmed`);
  }
  return result;
}

// Validate a complete decoded PNG before passing it to an agent. Node's native
// CRC and asynchronous bounded inflater keep large images off the JS heartbeat
// loop. The host encoder supplies pixels; no hiding or masking occurs here.
async function validateImage(result, maximumDimension) {
  if (result.mimeType !== 'image/png' || typeof result.image !== 'string' ||
      !result.image.length || result.image.length > MAX_IMAGE_BYTES * 4 / 3 + 4 ||
      result.image.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.image) ||
      !['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight'].every(key => integer(result[key])) ||
      result.nativeWidth > 16384 || result.nativeHeight > 16384 ||
      result.nativeWidth * result.nativeHeight > 33554432 ||
      result.scaledWidth > result.nativeWidth || result.scaledHeight > result.nativeHeight ||
      !sameBounds(result.display_bounds, result.display_bounds) ||
      result.display_bounds.width <= 0 || result.display_bounds.height <= 0 ||
      result.pixels_per_point_x !== result.nativeWidth / result.display_bounds.width ||
      result.pixels_per_point_y !== result.nativeHeight / result.display_bounds.height ||
      result.cursor_included !== true) throw new Error('Invalid host-helper capture geometry');
  const ratio = Math.min(1, maximumDimension / Math.max(result.nativeWidth, result.nativeHeight));
  if (result.scaledWidth !== Math.max(1, Math.round(result.nativeWidth * ratio)) ||
      result.scaledHeight !== Math.max(1, Math.round(result.nativeHeight * ratio))) {
    throw new Error('Host-helper capture scaling mismatch');
  }
  const png = Buffer.from(result.image, 'base64');
  if (png.length > MAX_IMAGE_BYTES || png.length < 45 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Invalid host-helper PNG');
  }
  let offset = 8;
  const compressed = [];
  let channels;
  let colorType;
  let hasPalette = false;
  let dataEnded = false;
  let chunks = 0;
  while (offset + 12 <= png.length) {
    // ImageIO emits a small chunk set; bound adversarial tiny-chunk work as
    // well as byte and pixel allocations on the shared broker thread.
    if (++chunks > 4096) break;
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length || length > MAX_IMAGE_BYTES) break;
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) ||
        (/^[A-Z]/.test(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type))) break;
    if (crc32(png.subarray(offset + 4, offset + 8 + length)) !== png.readUInt32BE(offset + 8 + length)) break;
    if (offset === 8 && (type !== 'IHDR' || length !== 13 ||
        png.readUInt32BE(offset + 8) !== result.scaledWidth ||
        png.readUInt32BE(offset + 12) !== result.scaledHeight)) break;
    if (type === 'IHDR') {
      if (offset !== 8 || png[offset + 16] !== 8 ||
          ![0, 2, 3, 4, 6].includes(png[offset + 17]) ||
          png[offset + 18] !== 0 || png[offset + 19] !== 0 || png[offset + 20] !== 0) break;
      colorType = png[offset + 17];
      channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    }
    if (type === 'PLTE') {
      if (hasPalette || compressed.length || !length || length > 768 || length % 3 ||
          [0, 4].includes(colorType)) break;
      hasPalette = true;
    }
    if (type === 'IDAT') {
      if (dataEnded || (colorType === 3 && !hasPalette)) break;
      compressed.push(png.subarray(offset + 8, offset + 8 + length));
    } else if (compressed.length) dataEnded = true;
    if (type === 'IEND') {
      if (length === 0 && end === png.length && compressed.length && channels) {
        const rowBytes = result.scaledWidth * channels + 1;
        const expectedBytes = rowBytes * result.scaledHeight;
        let pixels;
        try { pixels = await inflateAsync(Buffer.concat(compressed), { maxOutputLength: expectedBytes }); }
        catch { throw new Error('Incomplete or corrupt host-helper PNG pixels'); }
        if (pixels.length !== expectedBytes) throw new Error('Incomplete host-helper PNG pixels');
        for (let row = 0; row < result.scaledHeight; row++) {
          if (pixels[row * rowBytes] > 4) throw new Error('Invalid host-helper PNG scanline');
        }
        return;
      }
      break;
    }
    offset = end;
  }
  throw new Error('Incomplete or corrupt host-helper PNG');
}

/** Optional target-side capture wraps, rather than replaces, the owned VNC
 * input executor. An unqualified mapping permits observations but no input. */
export class HostHelperExecutor {
  constructor({ nativeExecutor, hostHelper, spawnImpl = spawn, now = () => performance.now(),
    responseBudgetFactory = () => new ResponseBudget() }) {
    validateConfiguration(hostHelper);
    this.native = nativeExecutor;
    this.now = now;
    this.responseBudgetFactory = responseBudgetFactory;
    this.config = structuredClone(hostHelper);
    this.sessionId = randomUUID();
    this.sequence = 0;
    this.tail = Promise.resolve();
    this.helperTail = Promise.resolve();
    this.channel = new HelperChannel(this.config, spawnImpl, error => this.fail(error), now);
  }

  get display() { return this.native.display; }

  get capabilities() {
    const native = this.native.capabilities ?? nativeCapabilities();
    const actions = ['screenshot', 'health', 'wait'];
    if (this.config.mapping) actions.push(...INPUT_ACTIONS);
    // Actions describe this wrapper's routes. Unknown native metadata remains
    // explicit; a route or qualified mapping does not prove runtime support.
    return Object.freeze({ backend: 'owned_sck', known: native.known,
      actions: Object.freeze(actions.filter(action => action === 'screenshot' ||
        (!native.known || (native.actions.includes(action) &&
          (!INPUT_ACTIONS.has(action) || this.supportsNativeMapping(native)))))),
      native, inputMappingQualified: Boolean(this.config.mapping) });
  }

  supportsNativeMapping(native) {
    return ['health', 'adopt_observation', 'begin_input_permit', 'grant_input_permit']
      .every(action => native.actions.includes(action));
  }

  preflight(actions) {
    if (this.failed) throw this.failed;
    const native = this.native.capabilities ?? nativeCapabilities();
    for (const action of actions) {
      if (INPUT_ACTIONS.has(action.action) && !this.config.mapping) {
        throw preAdmissionRefusal('Host-helper input mapping is not qualified');
      }
      if (!['screenshot', 'health', 'wait'].includes(action.action) && !INPUT_ACTIONS.has(action.action)) {
        throw preAdmissionRefusal('Action unavailable with owned host-helper capture');
      }
      if (action.action === 'wait' && action.ms !== undefined &&
          (!integer(action.ms, 50) || action.ms > 10000)) {
        throw preAdmissionRefusal('Invalid host-helper wait duration');
      }
      if (action.action !== 'screenshot' && native.known &&
          (!native.actions.includes(action.action) ||
            (INPUT_ACTIONS.has(action.action) && !this.supportsNativeMapping(native)))) {
        throw preAdmissionRefusal('Action unavailable on native backend');
      }
    }
  }

  async ready() {
    const { result } = await this.channel.request('health', { display_id: this.config.displayId,
      capture_backend: 'owned_sck' });
    const health = validateHealth(result, this.config);
    this.instanceId = health.instance_id;
    this.generation = health.displayGeneration;
    this.helperReleased = true; // This connection has not acquired activity.
    return this;
  }

  fail(error, closeOptions) {
    if (this.failed) return;
    this.failed = error;
    clearInterval(this.heartbeat);
    clearTimeout(this.permitTimer);
    this.activeController?.abort(error);
    this.releaseController?.abort(error);
    // Invalidating synchronously prevents any successor input from being sent.
    if (!this.nativeClosing) {
      try { this.nativeClosing = Promise.resolve(this.native.close({ graceful: false, ...closeOptions })); }
      catch (closeError) { this.nativeClosing = Promise.reject(closeError); }
      this.nativeClosing.catch(() => {});
    }
    this.helperClosing ??= this.channel?.close(closeOptions);
  }

  assertPermit() {
    if (this.activityActive && (!Number.isFinite(this.permitUntil) || this.now() >= this.permitUntil)) {
      throw new Error('Host-helper input permit expired');
    }
  }

  refreshPermit(until) {
    if (!Number.isFinite(until) || this.now() >= until) throw new Error('Host-helper input permit expired');
    this.permitUntil = until;
    clearTimeout(this.permitTimer);
    this.permitTimer = setTimeout(() => {
      if (!this.activityActive || this.failed) return;
      try {
        if (this.now() >= this.permitUntil) this.fail(new Error('Host-helper input permit expired'));
        else this.refreshPermit(this.permitUntil);
      } catch (error) { this.fail(error); }
    }, Math.max(1, until - this.now()));
  }

  helperOperation(operation) {
    const task = this.helperTail.then(() => {
      if (this.failed) throw this.failed;
      return operation();
    });
    this.helperTail = task.catch(() => {});
    return task;
  }

  activity(action, signal) {
    return this.helperOperation(async () => {
      this.assertPermit();
      const sequence = ++this.sequence;
      let challenge = randomUUID();
      let binding;
      let nativeStartedAt;
      if (this.nativeBinding && !this.nativeReleasing) {
        if (typeof this.native.inputPermitControl !== 'function') {
          throw new Error('Native independent input-permit protocol unavailable');
        }
        binding = { instance_id: this.instanceId, session_id: this.sessionId,
          display_id: this.config.displayId, displayGeneration: this.generation,
          ...this.nativeBinding, sequence };
        nativeStartedAt = this.now();
        const response = await this.native.inputPermitControl('begin_input_permit', binding,
          { signal, timeoutMs: HELPER_TIMEOUT_MS });
        challenge = validateNativePermit(response, binding).challenge;
        this.assertPermit();
      }
      const receipt = await this.channel.request(action, { session_id: this.sessionId,
        sequence, challenge, display_id: this.config.displayId, capture_backend: 'owned_sck' }, { signal });
      const result = validateReady(receipt, this, sequence, challenge, !binding);
      if (binding) {
        const remaining = HELPER_TIMEOUT_MS - (this.now() - nativeStartedAt);
        if (remaining <= 0) throw new Error('Native input-permit grant deadline exceeded');
        const response = await this.native.inputPermitControl('grant_input_permit', {
          ...binding, challenge, lease_remaining_ms: result.lease_remaining_ms,
        }, { signal, timeoutMs: remaining });
        validateNativePermit(response, binding, challenge, true);
        this.assertPermit();
        // Start at our earlier local send boundary. No clock from either
        // remote process can extend the native-created authorization window.
        this.refreshPermit(Math.min(nativeStartedAt + INPUT_PERMIT_MS,
          nativeStartedAt + result.lease_remaining_ms));
      }
      this.activityActive = true;
      this.lastSequence = result.sequence;
      this.lastChallenge = result.challenge;
    });
  }

  async ensureActivity(signal) {
    if (this.activityActive) { this.assertPermit(); return; }
    await this.activity('begin_activity', signal);
    this.helperReleased = false;
    // The broker's ownership lease covers thinking gaps between commands.
    // Renewal belongs to that owner rather than a completed call's signal.
    this.heartbeat = setInterval(() => {
      if (this.renewing || this.failed) return;
      this.renewing = true;
      this.activity('renew_activity').catch(error => this.fail(error))
        .finally(() => { this.renewing = false; });
    }, RENEW_INTERVAL_MS);
  }

  async releaseActivity(signal) {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (this.helperReleased) return;
    const receipt = await this.helperOperation(() => this.channel.request('release_activity',
      { session_id: this.sessionId }, { signal }));
    if (receipt.result.instance_id !== this.instanceId ||
        receipt.result.display_id !== this.config.displayId ||
        receipt.result.displayGeneration !== this.generation || receipt.result.ready !== false ||
        receipt.result.lease_remaining_ms !== 0) throw new Error('Host-helper release receipt mismatch');
    this.helperReleased = true;
    this.activityActive = false;
    clearTimeout(this.permitTimer);
  }

  capture(signal) {
    // Serializing renewal and capture makes the echoed sequence/challenge
    // unambiguous even while native input is running on its separate pipe.
    return this.helperOperation(async () => {
      const sequence = this.lastSequence;
      const challenge = this.lastChallenge;
      const maximumDimension = Math.max(this.native.display.width, this.native.display.height);
      const receipt = await this.channel.request('capture', { session_id: this.sessionId,
        display_id: this.config.displayId, capture_backend: 'owned_sck',
        max_dimension: maximumDimension }, { signal });
      const result = validateReady(receipt, this, sequence, challenge, false);
      await validateImage(result, maximumDimension);
      this.assertPermit();
      return result;
    });
  }

  async verifyMapping(signal, timeoutMs) {
    const mapping = this.config.mapping;
    if (!mapping) throw new Error('Host-helper input mapping is not qualified');
    const capture = await this.capture(signal);
    if (!['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight'].every(key => capture[key] === mapping[key]) ||
        capture.display_id !== mapping.displayId || !sameBounds(capture.display_bounds, mapping.displayBounds)) {
      throw new Error('Host-helper qualified mapping changed');
    }
    const [health] = await this.native.execute([{ action: 'health' }], { signal, timeoutMs });
    if (health?.error || !object(health?.result) ||
        !['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight'].every(key => health.result[key] === mapping[key]) ||
        this.native.display.width !== mapping.scaledWidth || this.native.display.height !== mapping.scaledHeight) {
      throw new Error('Host-helper and VNC geometry mismatch');
    }
    const fields = NATIVE_GEOMETRY_FIELDS;
    if (!fields.every(key => integer(health.result[key]))) {
      throw new Error('Native observation allocation binding unavailable');
    }
    const binding = Object.fromEntries(fields.map(key => [key, health.result[key]]));
    if (this.nativeBinding && !fields.every(key => this.nativeBinding[key] === binding[key])) {
      throw new Error('Native input-permit allocation binding changed');
    }
    // This private native seam adopts the independently qualified SCK
    // observation. It is never accepted from public MCP tool parameters and
    // never takes/discards a raw VNC screenshot to seed input authorization.
    const [adopted] = await this.native.execute([{ action: 'adopt_observation', ...binding }], { signal, timeoutMs });
    if (adopted?.error || !object(adopted?.result) ||
        !fields.every(key => adopted.result[key] === binding[key])) {
      throw new Error('Native external-observation adoption unconfirmed');
    }
    this.nativeBinding ??= binding;
    // Fresh ready acknowledgement after mapping work; no old permit is reused.
    await this.activity('renew_activity', signal);
  }

  execute(actions, { signal, timeoutMs = 30000, onResponse } = {}) {
    if (this.releasing || this.released) return Promise.reject(new Error('Host-helper executor is releasing'));
    if (!Array.isArray(actions) || !actions.length || actions.length > 256 ||
        actions.some(action => !object(action))) {
      return Promise.reject(new Error('Invalid host-helper action batch'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
      return Promise.reject(new Error('Invalid host-helper operation deadline'));
    }
    try { this.preflight(actions); }
    catch (error) { return Promise.reject(error); }
    const deadline = this.now() + timeoutMs;
    const controller = new AbortController();
    const responses = [];
    const responseBudget = this.responseBudgetFactory();
    const abort = () => controller.abort(new Error('Host-helper operation cancelled'));
    if (signal?.aborted) return Promise.reject(new Error('Host-helper operation cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Host-helper operation deadline exceeded')), timeoutMs);
    let rejectCancellation;
    const cancellation = new Promise((resolve, reject) => { rejectCancellation = reject; });
    const cancelled = () => {
      const error = controller.signal.reason || new Error('Host-helper operation cancelled');
      error.responses = responses.map(responseMetadata);
      rejectCancellation(error);
    };
    controller.signal.addEventListener('abort', cancelled, { once: true });
    const task = this.tail.then(async () => {
      if (this.failed) throw this.failed;
      if (controller.signal.aborted) throw controller.signal.reason;
      this.preflight(actions);
      this.activeController = controller;
      const onAbort = () => this.fail(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      try {
        // Capability discovery through health does not acquire the overlay or
        // input permit. Other admitted work retains its existing lease rules.
        if (actions.some(action => action.action !== 'health')) await this.ensureActivity(controller.signal);
        for (const action of actions) {
          if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
          this.assertPermit();
          const remaining = deadline - this.now();
          if (remaining <= 0) throw new Error('Host-helper operation deadline exceeded');
          let response;
          if (action.action === 'screenshot') {
            await this.activity('renew_activity', controller.signal);
            response = { id: randomUUID(), result: await this.capture(controller.signal) };
          } else if (action.action === 'health') {
            const [health] = await this.native.execute([action], { signal: controller.signal, timeoutMs: remaining });
            response = health.error ? health : { ...health, result: { ...health.result,
              capabilities: this.capabilities, hostHelper: {
              captureBackend: 'owned_sck', displayId: this.config.displayId,
              displayGeneration: this.generation, inputMappingQualified: Boolean(this.config.mapping) } } };
          } else if (INPUT_ACTIONS.has(action.action)) {
            await this.verifyMapping(controller.signal, remaining);
            this.assertPermit();
            if (this.failed) throw this.failed;
            [response] = await this.native.execute([action], { signal: controller.signal,
              timeoutMs: Math.max(1, deadline - this.now()) });
          } else if (action.action === 'wait' &&
              (action.ms === undefined || (integer(action.ms, 50) && action.ms <= 10000))) {
            [response] = await this.native.execute([action], { signal: controller.signal, timeoutMs: remaining });
          } else {
            throw new Error('Action unavailable with owned host-helper capture');
          }
          if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
          this.assertPermit();
          responseBudget.add(response);
          responses.push(response);
          onResponse?.(responseMetadata(response));
          if (response.error) throw new Error('Native operation failed');
        }
        return responses;
      } catch (error) {
        this.fail(error);
        error.responses = responses.map(responseMetadata);
        throw error;
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
        this.activeController = undefined;
      }
    });
    this.tail = task.catch(() => {});
    return Promise.race([task, cancellation]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', cancelled);
    });
  }

  release({ signal, timeoutMs = 30000 } = {}) {
    if (this.releasing) return this.releasing;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
      return Promise.reject(new Error('Invalid host-helper release deadline'));
    }
    const deadline = this.now() + timeoutMs;
    const controller = new AbortController();
    this.releaseController = controller;
    const abort = () => controller.abort(new Error('Host-helper release cancelled'));
    const interrupted = new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        this.fail(controller.signal.reason, { deadline, signal: controller.signal });
        reject(controller.signal.reason);
      }, { once: true });
    });
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Host-helper release deadline exceeded')), timeoutMs);
    if (signal?.aborted) abort();
    const releaseTask = (async () => {
      try {
        await this.tail;
        if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
        if (typeof this.native.release !== 'function') throw new Error('Native clean release is unavailable');
        // Keep the resident indication alive while native shutdown confirms
        // held-state release, but finish any permit control already in flight
        // before the native executor starts refusing successor requests.
        this.nativeReleasing = true;
        await this.helperTail;
        if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
        await this.native.release({ signal: controller.signal,
          timeoutMs: Math.max(1, deadline - this.now()) });
        if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
        await this.releaseActivity(controller.signal);
        const { result } = await this.helperOperation(() => this.channel.request('health', {
          display_id: this.config.displayId, capture_backend: 'owned_sck' }, { signal: controller.signal }));
        validateHealth(result, this.config);
        if (result.instance_id !== this.instanceId || result.displayGeneration !== this.generation ||
            result.ready !== false || result.overlay_ready !== false || result.capture_ready !== false ||
            result.lease_remaining_ms !== 0) throw new Error('Host-helper overlay release unconfirmed');
        await this.channel.close({ deadline, signal: controller.signal });
        if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
        this.released = true;
      } catch (error) { this.fail(error, { deadline, signal: controller.signal }); throw error; }
    })();
    this.releasing = Promise.race([releaseTask, interrupted]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.releaseController = undefined;
    });
    return this.releasing;
  }

  async close({ signal, timeoutMs, deadline } = {}) {
    const inherited = Object.fromEntries(Object.entries({ signal, timeoutMs, deadline })
      .filter(([, value]) => value !== undefined));
    const options = Object.keys(inherited).length ? inherited : undefined;
    if (this.released) { await this.channel.close(options); return; }
    if (this.failed && options) {
      // Shorten already-started owned retirement without replacing its
      // original nativeClosing/helperClosing tracking or clearing failure.
      try { this.nativeClosingUpdate = Promise.resolve(this.native.close({ graceful: false, ...options })); }
      catch (error) { this.nativeClosingUpdate = Promise.reject(error); }
      this.nativeClosingUpdate.catch(() => {});
      this.channel.close(options).catch(() => {});
    }
    this.fail(new Error('Host-helper executor closed'), options);
    await Promise.all([this.nativeClosing, this.helperClosing, this.nativeClosingUpdate]);
  }
}

export async function createHostHelperExecutor(options) {
  let executor;
  try {
    executor = new HostHelperExecutor(options);
    return await executor.ready();
  } catch (error) {
    if (executor) await executor.close();
    else await options.nativeExecutor.close({ graceful: false });
    throw error;
  }
}
