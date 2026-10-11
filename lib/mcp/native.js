// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { takeCredential, spawnCredentialDaemon } from '../../tools/credential-transport.js';
import { NdjsonParser, ResponseBudget, MAX_BATCH_RESPONSE_BYTES, MAX_BATCH_RESPONSES,
  encodeRequest, validateResponse, responseMetadata } from './protocol.js';
import { retirementDeadline } from '../deadlines.mjs';
import { nativeCapabilities, requireNativeActions } from './capabilities.js';

// Published Darwin runtimes carry the signed controller beside the launcher.
// Explicit operator paths retain priority; Linux continues to use the bridge.
export function resolveNativeDaemonPath({ daemonPath, env = process.env,
  platform = process.platform,
  bundledPath = fileURLToPath(new URL('../../bin/claude-kvm-daemon', import.meta.url)) } = {}) {
  if (daemonPath || env.CLAUDE_KVM_DAEMON_PATH) return daemonPath || env.CLAUDE_KVM_DAEMON_PATH;
  if (platform === 'darwin') {
    let stat;
    try { stat = lstatSync(bundledPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      if (!stat.isFile() || !(stat.mode & 0o111)) throw new Error('Bundled native controller must be a regular executable file');
      try { accessSync(bundledPath, constants.X_OK); }
      catch { throw new Error('Bundled native controller must be a regular executable file accessible to this user'); }
      return bundledPath;
    }
  }
  return 'claude-kvm-daemon';
}

export class NativeExecutor {
  constructor({ env = process.env, daemonPath, log = () => {},
    emitDiagnostics = true, suppressDiagnostics = false,
    maxBatchResponseBytes = MAX_BATCH_RESPONSE_BYTES,
    monotonicNow = () => performance.now() } = {}) {
    this.log = log;
    this.now = monotonicNow;
    // Validate the budget before consuming credentials or spawning a process.
    new ResponseBudget({ maxBytes: maxBatchResponseBytes });
    const executable = resolveNativeDaemonPath({ daemonPath, env });
    this.maxBatchResponseBytes = maxBatchResponseBytes;
    this.pending = new Map();
    this.tail = Promise.resolve();
    this.isReady = false;
    this.terminal = false;
    this.shutdownAcknowledged = false;
    this.display = { width: null, height: null };
    this.capabilities = nativeCapabilities();
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Startup may fail before a caller attaches ready().
    this.readyPromise.catch(() => {});
    const credential = takeCredential(env);
    const args = ['--host', env.VNC_HOST || '127.0.0.1', '--port', env.VNC_PORT || '5900'];
    if (env.VNC_USERNAME) args.push('--username', env.VNC_USERNAME);
    const extra = env.CLAUDE_KVM_DAEMON_PARAMETERS || '';
    args.push(...(extra.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])
      .map((argument) => argument.replace(/^['"]|['"]$/g, '')));
    this.log('Spawning native VNC daemon');
    this.child = spawnCredentialDaemon(executable,
      args, credential, env, () => this.fail(new Error('Native credential channel failed')));
    this.closed = new Promise((resolve) => this.child.once('close', resolve));
    const parser = this.parser = new NdjsonParser((message) => this.receive(message));
    this.child.stdout.on('data', (chunk) => {
      try { parser.push(chunk); }
      catch (error) { this.fail(error); }
    });
    this.child.stdout.once('end', () => {
      try { parser.end(); }
      catch (error) { this.fail(error); }
      if (!this.closing && (!this.shutdownAcknowledged || this.pending.size)) {
        this.fail(new Error('Daemon protocol output ended before acknowledged shutdown'));
      }
    });
    // Shared brokers suppress raw native diagnostics independently of their
    // structured logger. Legacy direct execution retains its stderr behavior.
    this.child.stderr.on('data', (chunk) => {
      if (emitDiagnostics && !suppressDiagnostics) process.stderr.write(chunk);
    });
    this.child.stdin.on('error', () => this.fail(new Error('Daemon protocol input failed')));
    this.child.once('error', () => this.fail(new Error('Daemon spawn failed')));
    this.child.once('exit', (code) => {
      this.log(`Daemon exited with code ${code}`);
      this.isReady = false;
      this.terminal = true;
    });
    // `exit` can precede the final stdout bytes. Drain them before rejecting
    // pending requests so a flushed shutdown acknowledgement is not lost.
    this.child.once('close', () => this.invalidate(new Error('Daemon exited')));
  }

  receive(message) {
    if (this.failureError || this.closing) return false;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('Invalid daemon response shape');
    }
    if (typeof message.method === 'string' && message.id === undefined) {
      if (message.method === 'ready') {
        const { scaledWidth: width, scaledHeight: height } = message.params || {};
        if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
            width > 0x7fffffff || height > 0x7fffffff) throw new Error('Invalid daemon ready dimensions');
        if (this.terminal) return false;
        if (this.isReady) throw new Error('Unexpected duplicate daemon ready event');
        this.capabilities = nativeCapabilities(message.params?.capabilities);
        this.display = { width, height };
        this.isReady = true;
        this.resolveReady();
        this.log(`Daemon ready — display ${width}×${height}`);
      } else if (message.method === 'vnc_state') {
        // State payloads are informational; never log arbitrary server text.
        this.log('VNC state changed');
      }
      return;
    }
    const response = validateResponse(message);
    const pending = this.pending.get(response.id);
    if (!pending) throw new Error('Unexpected daemon response identifier');
    this.pending.delete(response.id);
    if (pending.method === 'health' && response.result) {
      // The ready event binds this executor's advertisement. Legacy health
      // results retain their fields and explicitly report unknown metadata.
      response.result = { ...response.result, capabilities: this.capabilities };
    }
    if (pending.method === 'shutdown' && response.result?.detail === 'OK') {
      this.shutdownAcknowledged = true;
      this.isReady = false;
      this.terminal = true;
    }
    if (response.result?.scaledWidth !== undefined) {
      this.display = { width: response.result.scaledWidth, height: response.result.scaledHeight };
    }
    pending.resolve(response);
  }

  async ready(timeoutMs = 30000, { signal, deadline = this.now() + Math.min(30000, timeoutMs) } = {}) {
    let timer;
    let abort;
    try {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(deadline)) {
        throw new Error('Invalid native startup deadline');
      }
      if (signal?.aborted) throw signal.reason || new Error('Native startup cancelled');
      const remaining = Math.min(30000, timeoutMs, deadline - this.now());
      if (remaining <= 0) throw new Error('Daemon did not become ready within timeout');
      await Promise.race([this.readyPromise, new Promise((_, reject) => {
        abort = () => reject(signal.reason || new Error('Native startup cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error('Daemon did not become ready within timeout')), remaining);
      })]);
      if (signal?.aborted) throw signal.reason || new Error('Native startup cancelled');
      if (this.now() >= deadline) throw new Error('Daemon did not become ready within timeout');
    } catch (error) {
      // Invalidate before returning the cancellation: a late ready frame must
      // not revive this owned child while its termination is still pending.
      void this.close({ graceful: false }).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    return this;
  }

  invalidate(error) {
    this.isReady = false;
    this.terminal = true;
    this.rejectReady(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  fail(error) {
    if (this.failureError) return;
    this.failureError = error;
    this.parser?.stop();
    this.log(error.message);
    this.invalidate(error);
    void this.close({ graceful: false });
  }

  request(action) {
    if (!this.isReady || this.terminal) {
      return Promise.reject(new Error('Daemon not ready. Check CLAUDE_KVM_DAEMON_PATH and VNC credentials.'));
    }
    const { action: method, ...params } = action;
    const id = randomUUID();
    let frame;
    try { frame = encodeRequest({ method, id, ...(Object.keys(params).length ? { params } : {}) }); }
    catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.child.stdin.write(frame, (error) => {
        if (error) this.fail(new Error('Daemon protocol input failed'));
      });
    });
  }

  // Only the owned host-helper wrapper uses these controls. They bypass the
  // action queue so a long input cannot defer its independent native renewal.
  inputPermitControl(method, params, { signal, timeoutMs = 500 } = {}) {
    if (!['begin_input_permit', 'grant_input_permit'].includes(method) ||
        !params || typeof params !== 'object' || Array.isArray(params)) {
      return Promise.reject(new Error('Invalid native input-permit control'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 500) {
      return Promise.reject(new Error('Invalid native input-permit deadline'));
    }
    if (this.releasing) return Promise.reject(new Error('Native executor is releasing control'));
    try { this.preflight([{ action: method }]); }
    catch (error) { return Promise.reject(error); }
    if (signal?.aborted) return Promise.reject(new Error('Native input-permit control cancelled'));
    const deadline = this.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(response);
      };
      const interrupt = message => {
        if (settled) return;
        finish(new Error(message));
        // Losing an authorization acknowledgement is uncertain. Never allow
        // a late frame or successor command to reuse this owned controller.
        void this.close({ graceful: false });
      };
      const abort = () => interrupt('Native input-permit control cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => interrupt('Native input-permit control deadline exceeded'), timeoutMs);
      this.request({ ...params, action: method }).then(response => {
        if (settled) return;
        if (this.now() >= deadline) {
          interrupt('Native input-permit control deadline exceeded');
          return;
        }
        try { new ResponseBudget({ maxBytes: 16384, maxResponses: 1 }).add(response); }
        catch (error) { this.fail(error); finish(error); return; }
        finish(null, response);
      }, error => finish(error));
    });
  }

  execute(actions, { signal, timeoutMs = 30000, onResponse } = {}) {
    if (this.releasing) return Promise.reject(new Error('Native executor is releasing control'));
    if (!Array.isArray(actions) || !actions.length || actions.length > MAX_BATCH_RESPONSES) {
      return Promise.reject(new Error('Invalid native action batch'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
      return Promise.reject(new Error('Invalid native tool deadline'));
    }
    try { this.preflight(actions); }
    catch (error) { return Promise.reject(error); }
    const budget = new ResponseBudget({ maxBytes: this.maxBatchResponseBytes,
      maxResponses: actions.length });
    const deadline = this.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const job = { settled: false, started: false, responses: [] };
      let timer;
      const finish = (error) => {
        if (job.settled) return;
        job.settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) {
          error.responses = job.responses.map(responseMetadata);
          reject(error);
        } else resolve(job.responses);
      };
      const interrupt = (message) => {
        if (job.settled) return;
        const started = job.started;
        finish(new Error(message));
        // An in-flight native command has uncertain side effects. Terminate
        // exactly our direct executor child, and admit no successor on it.
        if (started) void this.close({ graceful: false });
      };
      const abort = () => interrupt('Tool request cancelled');
      if (signal?.aborted) { finish(new Error('Tool request cancelled')); return; }
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => interrupt(`Tool request timed out after ${timeoutMs}ms`), timeoutMs);
      this.tail = this.tail.then(async () => {
        if (job.settled) return;
        if (this.now() >= deadline) {
          interrupt(`Tool request timed out after ${timeoutMs}ms`);
          return;
        }
        // Recheck at serial admission, before the first write. A refusal of
        // queued work must not retire another client's admitted command.
        try { this.preflight(actions); }
        catch (error) { finish(error); return; }
        job.started = true;
        try {
          for (const action of actions) {
            if (job.settled) return;
            if (this.now() >= deadline) {
              interrupt(`Tool request timed out after ${timeoutMs}ms`);
              return;
            }
            const response = await this.request(action);
            if (job.settled) return;
            try { budget.add(response); }
            catch (error) {
              this.fail(error);
              throw error;
            }
            job.responses.push(response);
            onResponse?.(responseMetadata(response));
            if (this.now() >= deadline) {
              interrupt(`Tool request timed out after ${timeoutMs}ms`);
              return;
            }
            if (response.error) break;
          }
          finish();
        } catch (error) {
          finish(error);
          // A callback or transport failure must not leave the target reusable
          // when its caller cannot account for the last command.
          if (job.started) void this.close({ graceful: false });
        }
      });
    });
  }

  preflight(actions) {
    if (!this.isReady || this.terminal) {
      throw new Error('Daemon not ready. Check CLAUDE_KVM_DAEMON_PATH and VNC credentials.');
    }
    if (this.failureError) throw this.failureError;
    requireNativeActions(actions, this.capabilities);
  }

  release({ signal, timeoutMs = 30000 } = {}) {
    if (this.releasing) return this.releasing;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
      return Promise.reject(new Error('Invalid native tool deadline'));
    }
    this.releasing = (async () => {
      if (signal?.aborted) throw new Error('Tool request cancelled');
      const deadline = this.now() + timeoutMs;
      if (!this.shutdownAcknowledged) {
        if (!this.isReady || this.terminal) throw new Error('Native shutdown acknowledgement unavailable');
        const [response] = await this.execute([{ action: 'shutdown' }], { signal, timeoutMs });
        if (response.error) throw new Error(`Native shutdown failed: ${response.error.message}`);
        if (!this.shutdownAcknowledged) throw new Error('Native shutdown acknowledgement invalid');
      }
      let timer;
      let onAbort;
      try {
        await Promise.race([this.closed, new Promise((_, reject) => {
          onAbort = () => reject(new Error('Tool request cancelled'));
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
          timer = setTimeout(() => reject(new Error('Native shutdown exit unconfirmed')),
            Math.max(0, deadline - this.now()));
        })]);
      } catch (error) {
        void this.close({ graceful: false });
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      if (this.failureError) throw this.failureError;
      if (signal?.aborted) throw new Error('Tool request cancelled');
      if (this.now() >= deadline) throw new Error('Native shutdown exit unconfirmed');
      if (this.child.exitCode !== 0 || this.child.signalCode !== null) {
        throw new Error('Native executor did not exit cleanly after acknowledged shutdown');
      }
    })().catch((error) => {
      void this.close({ graceful: false });
      throw error;
    });
    return this.releasing;
  }

  close({ graceful = true, signal, timeoutMs, deadline } = {}) {
    let cutoff;
    try { cutoff = retirementDeadline({ timeoutMs, deadline, now: this.now() }); }
    catch (error) { return Promise.reject(error); }
    const child = this.child;
    if (!this.closing) {
      const state = this.closeState = { deadline: cutoff, signals: new Set(), listeners: [] };
      let resolveClose, rejectClose;
      this.closing = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
      // Internal failure paths initiate retirement without awaiting it. Keep the
      // rejection observed while preserving the same promise for every caller.
      this.closing.catch(() => {});
      const unconfirmed = () => {
        state.failure ||= Object.assign(new Error('Native owned exit unconfirmed'), { code: 'release_unconfirmed' });
        return state.failure;
      };
      const clearTimers = () => {
        clearTimeout(state.terminateTimer);
        clearTimeout(state.forceTimer);
        clearTimeout(state.deadlineTimer);
      };
      state.finish = error => {
        if (state.finished) return;
        state.finished = true;
        clearTimers();
        for (const [observed, abort] of state.listeners) observed.removeEventListener('abort', abort);
        state.listeners = [];
        if (error) rejectClose(error);
        else resolveClose();
      };
      state.kill = name => {
        // Only this exact direct child is owned. Exit status is not a drained
        // `close` event, but it prevents signalling an exited/reused PID.
        if (state.closedObserved || child.exitCode !== null || child.signalCode !== null || state.signals.has(name)) return;
        state.signals.add(name);
        try { child.kill(name); } catch { /* An attempted signal is not exit proof. */ }
      };
      state.interrupt = () => {
        state.kill('SIGTERM');
        state.kill('SIGKILL');
        state.finish(unconfirmed());
      };
      state.arm = () => {
        if (state.finished) return;
        clearTimers();
        const remaining = state.deadline - this.now();
        if (remaining <= 0) { state.interrupt(); return; }
        // Preserve the existing 500/1500ms escalation for the default 2s
        // grace, scaling both stages down inside shorter inherited budgets.
        state.terminateTimer = setTimeout(() => state.kill('SIGTERM'), Math.min(500, remaining / 4));
        state.forceTimer = setTimeout(() => state.kill('SIGKILL'), Math.min(1500, remaining * 3 / 4));
        state.deadlineTimer = setTimeout(state.interrupt, remaining);
      };
      // Keep the actual late closure recorded after a deadline rejection. It
      // cannot change the sticky result or revive this executor.
      this.closed.then(() => {
        state.closedObserved = true;
        state.finish(this.now() >= state.deadline ? unconfirmed() : undefined);
      }, () => state.finish(unconfirmed()));
      this.parser?.stop();
      this.invalidate(new Error('Daemon not ready. Check CLAUDE_KVM_DAEMON_PATH and VNC credentials.'));
      if (graceful && !signal?.aborted && this.now() < state.deadline &&
          child.exitCode === null && child.signalCode === null && child.stdin.writable) {
        try { child.stdin.write(encodeRequest({ method: 'shutdown' })); }
        catch { state.kill('SIGTERM'); }
      } else state.kill('SIGTERM');
    }
    const state = this.closeState;
    if (state.finished) return this.closing;
    state.deadline = Math.min(state.deadline, cutoff);
    if (!graceful) state.kill('SIGTERM');
    if (signal) {
      const abort = state.interrupt;
      state.listeners.push([signal, abort]);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    state.arm();
    return this.closing;
  }
}

export async function createNativeExecutor(options = {}) {
  const now = options.monotonicNow || (() => performance.now());
  const timeoutMs = options.startupTimeoutMs ?? 30000;
  const deadline = options.deadline ?? now() + Math.min(30000, timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(deadline)) {
    throw new Error('Invalid native startup deadline');
  }
  if (options.signal?.aborted) throw options.signal.reason || new Error('Native startup cancelled');
  if (now() >= deadline) throw new Error('Daemon did not become ready within timeout');
  const executor = new NativeExecutor(options);
  let timer;
  try {
    options.onExecutor?.(executor);
    await executor.ready(timeoutMs, { signal: options.signal, deadline });
    return executor;
  } catch (error) {
    try {
      await Promise.race([executor.close({ graceful: false }), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native startup owned exit unconfirmed')), 2000);
      })]);
    } catch {
      const failure = new Error('Native startup owned exit unconfirmed', { cause: error });
      failure.startupCleanupUnconfirmed = true;
      throw failure;
    } finally { clearTimeout(timer); }
    throw error;
  }
}
