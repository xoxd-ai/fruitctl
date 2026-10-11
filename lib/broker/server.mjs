// SPDX-License-Identifier: MIT
import net from 'node:net';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readFrames, writeFrame, errorRecord, MAX_REQUEST_BYTES } from './protocol.mjs';
import { prepareSocket } from './paths.mjs';
import { hostHelperRefusalMessage } from './host-helper.mjs';
import { ResponseBudget, responseMetadata } from '../mcp/protocol.js';
import { executionBudget, retirementDeadline, RETIREMENT_TIMEOUT_MS } from '../deadlines.mjs';
import { isPreAdmissionRefusal } from '../mcp/capabilities.js';

const MAX_ACTIONS = 256;
const MAX_WAITING = 64;
const TOOL_TIMEOUT_MS = 30000;
const STARTUP_CLEANUP_MS = 2000;

async function nativeFactory(profile, { signal, deadline, onExecutor } = {}) {
  const { createNativeExecutor } = await import('../mcp/native.js');
  if (!profile.vnc || !profile.credentialFile) throw new Error('Target lacks a VNC credential provider');
  const { host, port, username = '' } = profile.vnc;
  if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof username !== 'string') throw new Error('Invalid VNC profile');
  const secretStat = await fs.stat(profile.credentialFile);
  if (!secretStat.isFile() || secretStat.size > 4097 || (secretStat.mode & 0o077)) {
    throw new Error('Credential provider must be a private file of at most 4097 bytes');
  }
  const credential = (await fs.readFile(profile.credentialFile, 'utf8')).replace(/\r?\n$/, '');
  const env = { ...process.env, VNC_HOST: host, VNC_PORT: String(port),
    VNC_USERNAME: username, VNC_PASSWORD: credential };
  delete env.CLAUDE_KVM_DAEMON_PARAMETERS;
  const native = await createNativeExecutor({ env, daemonPath: profile.daemonPath, signal, deadline, onExecutor,
    log: () => {}, emitDiagnostics: false });
  if (!profile.hostHelper) return native;
  const { HostHelperExecutor } = await import('./host-helper.mjs');
  let helper;
  try {
    if (signal?.aborted || performance.now() >= deadline) throw signal?.reason || new Error('Operation deadline exceeded');
    helper = new HostHelperExecutor({ nativeExecutor: native, hostHelper: profile.hostHelper });
    onExecutor?.(helper);
    return await helper.ready();
  } catch (error) {
    await (helper || native).close({ graceful: false });
    throw error;
  }
}

function boundedErrorResponses(responses, count) {
  const admitted = [];
  const budget = new ResponseBudget({ maxResponses: Math.max(1, Math.min(MAX_ACTIONS, count || 1)) });
  if (!Array.isArray(responses)) return admitted;
  for (const response of responses) {
    try { admitted.push(budget.add(responseMetadata(response))); } catch { break; }
  }
  return admitted;
}

export class TargetLane {
  constructor(profile, factory = nativeFactory, { idleMs = 300000, leaseMs = 60000,
    retirementMs = RETIREMENT_TIMEOUT_MS } = {}) {
    retirementDeadline({ timeoutMs: retirementMs });
    this.profile = profile;
    this.factory = factory;
    this.idleMs = idleMs;
    this.tail = Promise.resolve();
    this.waiting = 0;
    this.executor = null;
    this.closed = false;
    this.leaseMs = leaseMs;
    this.retirementMs = retirementMs;
    this.owner = null;
    this.controllers = new Set();
  }
  acquire(owner) {
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.closed || this.releasing || this.idleRetirement || (this.owner && this.owner !== owner)) {
      throw new Error('Target is controlled by another session or is releasing');
    }
    this.owner = owner;
    clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => { void this.release(owner).catch(() => {}); }, this.leaseMs);
    this.leaseTimer.unref();
  }
  release(owner, { signal, timeoutMs = TOOL_TIMEOUT_MS } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TOOL_TIMEOUT_MS) {
      return Promise.reject(new Error('Invalid operation deadline'));
    }
    if (this.owner !== owner) return Promise.resolve();
    if (this.cleanupFailure) return Promise.reject(this.cleanupFailure);
    const deadline = performance.now() + timeoutMs;
    this.releaseDeadline = Math.min(this.releaseDeadline ?? Infinity, deadline);
    if (!this.releasePromise) {
      this.releasing = true;
      clearTimeout(this.idleTimer);
      clearTimeout(this.leaseTimer);
      for (const controller of this.controllers) controller.abort(new Error('Target control released'));
      const controller = new AbortController();
      this.releaseController = controller;
      let abort;
      const interrupted = new Promise((_, reject) => {
        abort = () => reject(this.recordCleanupFailure());
        controller.signal.addEventListener('abort', abort, { once: true });
      });
      const cleanup = this.tail.then(async () => {
        if (controller.signal.aborted) throw this.recordCleanupFailure();
        await this.dropExecutor({ signal: controller.signal, deadline: this.releaseDeadline });
        if (this.cleanupFailure || controller.signal.aborted || performance.now() >= this.releaseDeadline) {
          throw this.recordCleanupFailure();
        }
        this.owner = null;
        this.releasing = false;
        this.releasePromise = null;
        this.releaseController = null;
        this.releaseDeadline = undefined;
      });
      this.releasePromise = Promise.race([cleanup, interrupted])
        .catch(() => {
          const failure = this.recordCleanupFailure();
          controller.abort(failure);
          throw failure;
        })
        .finally(() => controller.signal.removeEventListener('abort', abort));
      // Failed cleanup keeps the target blocked, even if the owned child exits later.
      this.tail = this.releasePromise.catch(() => {});
    }
    // Each RPC retains its own budget even when retirement has already started.
    let timer;
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => {
        const failure = this.recordCleanupFailure();
        this.releaseController?.abort(signal?.reason || new Error('Target release deadline exceeded'));
        reject(failure);
      };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, Math.max(0, deadline - performance.now()));
      if (signal?.aborted) abort();
    });
    return Promise.race([this.releasePromise, interrupted]).then(() => {
      if (signal?.aborted || performance.now() >= deadline) {
        const failure = this.recordCleanupFailure();
        this.releaseController?.abort(failure);
        throw failure;
      }
    }).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  }
  recordCleanupFailure(deadline = Math.min(this.closeDeadline ?? Infinity,
    this.releaseDeadline ?? Infinity, this.executorRetirementDeadline ?? Infinity),
    signal = this.closeController?.signal || this.releaseController?.signal) {
    this.cleanupFailure ||= new Error('Target input release is unconfirmed; reconcile the target before restarting its broker');
    this.cleanupFailure.code = 'release_unconfirmed';
    const executor = this.executor;
    const first = executor && this.forcedExecutor !== executor;
    if (executor && (first || deadline < this.forcedDeadline ||
        (signal && signal !== this.forcedSignal && !this.forcedSignal?.aborted))) {
      this.forcedExecutor = executor;
      this.forcedDeadline = first ? deadline : Math.min(this.forcedDeadline, deadline);
      if (first || (signal && !this.forcedSignal?.aborted)) this.forcedSignal = signal;
      // This is our recorded executor. Start its termination without allowing
      // an unconfirmed close to delay the caller or reopen target admission.
      const options = { graceful: false,
        ...(Number.isFinite(this.forcedDeadline) ? { deadline: this.forcedDeadline } : {}),
        ...(this.forcedSignal ? { signal: this.forcedSignal } : {}) };
      const closing = Promise.resolve().then(() => executor.close(options));
      closing.catch(() => {});
      // Narrow the executor's existing retirement without replacing the
      // original owned closure tracking or treating a timeout as an exit.
      if (first) this.forcedClose = closing;
      else this.forcedCloseUpdate = closing;
    }
    return this.cleanupFailure;
  }
  async dropExecutor({ signal, deadline = performance.now() + this.retirementMs, operationDeadline } = {}) {
    if (this.cleanupFailure) throw this.cleanupFailure;
    const executor = this.executor;
    if (!executor) return;
    this.executorRetirementDeadline = Math.min(deadline, this.closeDeadline ?? Infinity,
      this.releaseDeadline ?? Infinity);
    const controller = new AbortController();
    let timer;
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => {
        const failure = this.recordCleanupFailure(this.executorRetirementDeadline, controller.signal);
        controller.abort(failure);
        reject(failure);
      };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, Math.max(0, this.executorRetirementDeadline - performance.now()));
      if (signal?.aborted) abort();
    });
    const check = () => {
      if (this.cleanupFailure || controller.signal.aborted ||
          performance.now() >= this.executorRetirementDeadline ||
          (this.releaseDeadline !== undefined && performance.now() >= this.releaseDeadline)) {
        throw new Error('Target release interrupted');
      }
    };
    try {
      await Promise.race([(async () => {
        check();
        const now = performance.now();
        // Preserve an operation's remaining release budget while it is valid.
        // After cancellation/expiry, safety cleanup still has its finite grace.
        const remaining = Math.min(this.executorRetirementDeadline - now,
          this.releaseDeadline === undefined ? Infinity : this.releaseDeadline - now,
          operationDeadline > now ? operationDeadline - now : Infinity);
        if (remaining <= 0) throw new Error('Target release interrupted');
        await executor.release?.({ signal: controller.signal,
          ...(Number.isFinite(remaining) ? { timeoutMs: remaining } : {}) });
        check();
        this.executorClosing = Promise.resolve().then(() => executor.close({ signal: controller.signal,
          deadline: this.executorRetirementDeadline }));
        this.executorClosing.catch(() => {});
        await this.executorClosing;
        check();
        this.executor = null;
        this.executorRetirementDeadline = undefined;
      })(), interrupted]);
    } catch {
      const failure = this.recordCleanupFailure(this.executorRetirementDeadline, controller.signal);
      controller.abort(failure);
      throw failure;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  async startExecutor(signal, deadline, cleanup) {
    const startup = { handles: new Set(), closes: [], retiring: false };
    this.startup = startup;
    const close = executor => {
      const closing = Promise.resolve().then(() => executor.close({ graceful: false,
        ...(Number.isFinite(startup.retirementDeadline) ? { deadline: startup.retirementDeadline } : {}),
        ...(this.closeController ? { signal: this.closeController.signal } : {}) }));
      closing.catch(() => {});
      startup.closes.push(closing);
    };
    const onExecutor = executor => {
      if (!executor || startup.handles.has(executor)) return;
      startup.handles.add(executor);
      if (startup.retiring) close(executor);
    };
    const factory = Promise.resolve().then(() => this.factory(this.profile, { signal, deadline, onExecutor }));
    // Track even a factory that ignores cancellation. Its late result is owned
    // cleanup, never permission to send the expired request.
    const settled = factory.then(executor => { onExecutor(executor); }, error => {
      if (error?.startupCleanupUnconfirmed) startup.failure = error;
    });
    let abort;
    try {
      const executor = await Promise.race([factory, new Promise((_, reject) => {
        abort = () => reject(signal.reason || new Error('Operation cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]);
      if (signal.aborted || performance.now() >= deadline) throw signal.reason || new Error('Operation deadline exceeded');
      this.executor = executor;
      this.startup = null;
    } catch (error) {
      startup.retiring = true;
      const retirementDeadline = cleanup
        ? Math.min(cleanup.deadline, performance.now() + cleanup.timeoutMs,
          this.releaseDeadline ?? Infinity, this.closeDeadline ?? Infinity)
        : Math.min(performance.now() + STARTUP_CLEANUP_MS, this.closeDeadline ?? Infinity);
      startup.retirementDeadline = retirementDeadline;
      for (const executor of startup.handles) close(executor);
      let timer;
      try {
        await Promise.race([(async () => {
          await settled;
          await Promise.all(startup.closes);
          if (startup.failure) throw startup.failure;
        })(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Startup owned exit unconfirmed')),
            Math.max(0, retirementDeadline - performance.now()));
        })]);
        if (this.cleanupFailure || performance.now() >= retirementDeadline ||
            (this.releaseDeadline !== undefined && performance.now() >= this.releaseDeadline)) {
          throw new Error('Startup owned exit unconfirmed');
        }
        this.startup = null;
      } catch {
        this.cleanupFailure = new Error('Target startup cleanup is unconfirmed; reconcile the target before restarting its broker');
        this.cleanupFailure.code = 'release_unconfirmed';
        throw this.cleanupFailure;
      } finally { clearTimeout(timer); }
      throw error;
    } finally { signal.removeEventListener('abort', abort); }
  }
  execute(actions, { signal, timeoutMs = TOOL_TIMEOUT_MS, onResponse } = {}) {
    if (this.cleanupFailure) return Promise.reject(this.cleanupFailure);
    if (this.closed) return Promise.reject(new Error('Target lane closed'));
    if (this.releasing || this.idleRetirement) return Promise.reject(new Error('Target is releasing control'));
    if (this.waiting >= MAX_WAITING) return Promise.reject(new Error('Target queue full'));
    if (!Array.isArray(actions) || !actions.length || actions.length > MAX_ACTIONS ||
        actions.some(action => !action || typeof action !== 'object' || Array.isArray(action) ||
          typeof action.action !== 'string')) return Promise.reject(new Error('Invalid action batch'));
    const budget = Math.min(TOOL_TIMEOUT_MS, timeoutMs);
    if (!Number.isFinite(budget) || budget <= 0) return Promise.reject(new Error('Invalid operation deadline'));
    const { workMs, cleanupMs } = executionBudget(budget);
    const requestedAt = performance.now();
    const deadline = requestedAt + workMs;
    const totalDeadline = requestedAt + budget;
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort(signal.reason || new Error('Operation cancelled'));
    if (signal?.aborted) { this.controllers.delete(controller); return Promise.reject(signal.reason || new Error('Operation cancelled')); }
    signal?.addEventListener('abort', abort, { once: true });
    let started = false;
    let abortQueued;
    const queuedInterruption = new Promise((_, reject) => {
      abortQueued = () => { if (!started) reject(controller.signal.reason); };
      controller.signal.addEventListener('abort', abortQueued, { once: true });
    });
    const timer = setTimeout(() => controller.abort(new Error('Operation deadline exceeded')), workMs);
    clearTimeout(this.idleTimer);
    this.waiting++;
    const progressBudget = new ResponseBudget({ maxResponses: actions.length });
    let preAdmissionError;
    const task = this.tail.then(async () => {
      started = true;
      const retire = () => {
        this.releasing = true;
        return this.dropExecutor({ signal: this.releaseController?.signal,
          deadline: Math.min(totalDeadline, performance.now() + cleanupMs, this.releaseDeadline ?? Infinity),
          operationDeadline: deadline });
      };
      if (performance.now() >= deadline) controller.abort(new Error('Operation deadline exceeded'));
      if (controller.signal.aborted || this.closed) throw controller.signal.reason || new Error('Target lane closed');
      if (!this.executor) await this.startExecutor(controller.signal, deadline,
        { deadline: totalDeadline, timeoutMs: cleanupMs });
      if (controller.signal.aborted) {
        await retire();
        throw controller.signal.reason;
      }
      let acceptingProgress = true;
      let abortExecution;
      const interrupted = new Promise((_, reject) => {
        abortExecution = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abortExecution, { once: true });
        if (controller.signal.aborted) abortExecution();
      });
      try {
        try { this.executor.preflight?.(actions); }
        catch (error) {
          if (isPreAdmissionRefusal(error)) preAdmissionError = error;
          throw error;
        }
        const responses = await Promise.race([Promise.resolve().then(() => {
          if (controller.signal.aborted || performance.now() >= deadline) {
            throw controller.signal.reason || new Error('Operation deadline exceeded');
          }
          return this.executor.execute(actions, { signal: controller.signal,
            onResponse: response => {
              if (!acceptingProgress || controller.signal.aborted || performance.now() >= deadline) return;
              progressBudget.add(response); onResponse?.(response);
            },
            timeoutMs: deadline - performance.now() });
        }), interrupted]);
        if (controller.signal.aborted || performance.now() >= deadline) {
          throw controller.signal.reason || new Error('Operation deadline exceeded');
        }
        if (!Array.isArray(responses)) throw new Error('Invalid executor response batch');
        const finalBudget = new ResponseBudget({ maxResponses: actions.length });
        for (const response of responses) finalBudget.add(response);
        return responses;
      } catch (error) {
        acceptingProgress = false;
        if (preAdmissionError && error === preAdmissionError) throw error;
        // Uncertain native execution is never replayed or handed to another owner.
        try { await retire(); }
        catch (retirementError) {
          const diagnostic = hostHelperRefusalMessage(error);
          if (diagnostic && retirementError?.code === 'release_unconfirmed') {
            // Retain the sticky cleanup failure and revoked lane. Only this
            // request gains the already sanitized cause, never raw executor text.
            const failure = new Error(`${retirementError.message}; cause=${diagnostic}`);
            failure.code = 'release_unconfirmed';
            throw failure;
          }
          throw retirementError;
        }
        throw error;
      } finally {
        acceptingProgress = false;
        controller.signal.removeEventListener('abort', abortExecution);
      }
    }).catch(error => {
      // Only this task's local preflight can prove zero admitted work. Errors
      // raised by execute, including forged codes, retain safety retirement.
      if (preAdmissionError && error === preAdmissionError) throw error;
      // Revoke before resolving the queue tail: already queued input cannot
      // race the caller's later error handling and enter an uncertain session.
      this.releasing = true;
      for (const queued of this.controllers) queued.abort(new Error('Target control revoked after operation failure'));
      throw error;
    });
    this.tail = task.catch(() => {});
    const settled = task.finally(() => {
      this.controllers.delete(controller);
      this.waiting--;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (!this.waiting && !this.closed && !this.cleanupFailure && !this.releasing) {
        this.idleTimer = setTimeout(() => {
          if (this.waiting || this.closed || this.releasing || this.cleanupFailure) return;
          const deadline = performance.now() + this.retirementMs;
          this.idleDeadline = deadline;
          // Block acquisition and direct execution before the asynchronous
          // release starts. A successful idle close retains the current owner.
          const retirement = this.tail.then(() => this.dropExecutor({ deadline }));
          this.idleRetirement = retirement;
          this.tail = retirement.catch(() => {}).finally(() => {
            if (this.idleRetirement === retirement) {
              this.idleRetirement = null;
              this.idleDeadline = undefined;
            }
          });
        }, this.idleMs);
        this.idleTimer.unref();
      }
    });
    // A queued caller can expire before the prior task retires. Keep that task
    // in the serial tail and capacity count, but return its cancellation now;
    // it will see the aborted signal before starting any factory or input.
    return Promise.race([settled, queuedInterruption]).finally(() => {
      controller.signal.removeEventListener('abort', abortQueued);
    });
  }
  close({ signal, timeoutMs = this.retirementMs, deadline } = {}) {
    let cutoff;
    try { cutoff = retirementDeadline({ timeoutMs, deadline }); }
    catch (error) { return Promise.reject(error); }
    this.closeDeadline = Math.min(this.closeDeadline ?? Infinity, cutoff,
      this.idleDeadline ?? Infinity, this.executorRetirementDeadline ?? Infinity,
      this.releaseDeadline ?? Infinity);
    if (!this.closePromise) {
      this.closed = true;
      clearTimeout(this.idleTimer);
      clearTimeout(this.leaseTimer);
      for (const active of this.controllers) active.abort(new Error('Target lane closed'));
      const controller = this.closeController = new AbortController();
      const listeners = [];
      let timer;
      const interrupted = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(this.recordCleanupFailure()), { once: true });
      });
      this.armClose = () => {
        clearTimeout(timer);
        if (controller.signal.aborted) return;
        const remaining = this.closeDeadline - performance.now();
        if (remaining <= 0) controller.abort(this.recordCleanupFailure());
        else timer = setTimeout(() => controller.abort(this.recordCleanupFailure()), remaining);
      };
      this.observeCloseSignal = observed => {
        if (!observed) return;
        const abort = () => controller.abort(this.recordCleanupFailure());
        listeners.push([observed, abort]);
        observed.addEventListener('abort', abort, { once: true });
        if (observed.aborted) abort();
      };
      const check = () => {
        if (this.cleanupFailure || controller.signal.aborted || performance.now() >= this.closeDeadline) {
          throw this.recordCleanupFailure();
        }
      };
      const cleanup = this.tail.then(async () => {
        check();
        await this.dropExecutor({ signal: controller.signal, deadline: this.closeDeadline });
        check();
      });
      this.closePromise = Promise.race([cleanup, interrupted]).catch(() => {
        const failure = this.recordCleanupFailure();
        controller.abort(failure);
        throw failure;
      }).finally(() => {
        clearTimeout(timer);
        for (const [observed, abort] of listeners) observed.removeEventListener('abort', abort);
        this.armClose = null;
        this.observeCloseSignal = null;
      });
      this.closePromise.catch(() => {});
    }
    this.observeCloseSignal?.(signal);
    this.armClose?.();
    if (this.cleanupFailure) this.recordCleanupFailure();
    return this.closePromise;
  }
}

export async function createBroker({ socketPath, config, factory, idleMs, leaseMs, retirementMs }) {
  // Names are discovery aliases, not independent permission to control the
  // same desktop. Reject known overlaps before opening a public socket.
  const identities = new Map();
  for (const [name, profile] of Object.entries(config.targets)) {
    const keys = [];
    if (profile.vnc) {
      let host = String(profile.vnc.host).toLowerCase().replace(/^\[|\]$/g, '');
      if (['localhost', '127.0.0.1', '::1'].includes(host)) host = 'loopback';
      keys.push(`vnc:${host}:${profile.vnc.port}`);
    }
    if (profile.hostHelper) keys.push(`helper:${String(profile.hostHelper.sshHost).toLowerCase()}`);
    if (profile.targetId !== undefined) {
      if (typeof profile.targetId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(profile.targetId)) {
        throw new Error('Invalid physical target identity');
      }
      keys.push(`target:${profile.targetId}`);
    }
    for (const key of keys) {
      if (identities.has(key)) throw new Error('Duplicate target endpoint or physical identity; use one profile per desktop');
      identities.set(key, name);
    }
  }
  await prepareSocket(socketPath);
  const lanes = new Map(Object.entries(config.targets).map(([name, profile]) =>
    [name, new TargetLane(profile, factory, { idleMs, leaseMs, retirementMs })]));
  const sockets = new Set();
  const active = new Set();
  let closing = false;
  let closePromise;
  let closeDeadline, closeTimer, closeController, observeCloseSignal;
  const server = net.createServer(socket => {
    if (closing || sockets.size >= 128) return socket.destroy();
    sockets.add(socket);
    const clientId = randomUUID();
    const pending = new Map();
    let lane;
    const reply = frame => {
      try { writeFrame(socket, { v: 1, ...frame }); } catch { socket.destroy(); }
    };
    readFrames(socket, frame => {
      if (frame.v !== 1) return socket.destroy();
      if (frame.kind === 'open') {
        if (lane || !lanes.has(frame.profile)) return reply({ kind: 'error', error: { message: 'Unknown or already opened profile' } });
        lane = lanes.get(frame.profile);
        return reply({ kind: 'opened', clientId });
      }
      if (frame.kind === 'cancel') { pending.get(frame.id)?.abort(new Error('Operation cancelled')); return; }
      if (frame.kind === 'close') {
        for (const controller of pending.values()) controller.abort(new Error('Client closed'));
        void lane?.release(clientId).catch(() => {});
        socket.end();
        return false;
      }
      if (frame.kind === 'release' && lane && typeof frame.id === 'string' && frame.id.length <= 128) {
        if (pending.has(frame.id)) return reply({ kind: 'error', id: frame.id, error: { message: 'Invalid broker request' } });
        if (pending.size >= MAX_WAITING) return reply({ kind: 'error', id: frame.id, error: { message: 'Client queue full' } });
        const controller = new AbortController();
        pending.set(frame.id, controller);
        active.add(controller);
        lane.release(clientId, { signal: controller.signal, timeoutMs: frame.timeoutMs })
          .then(() => reply({ kind: 'result', id: frame.id, responses: [] }))
          .catch(error => reply({ kind: 'error', id: frame.id, error: errorRecord(error) }))
          .finally(() => { pending.delete(frame.id); active.delete(controller); });
        return;
      }
      if (frame.kind !== 'execute' || !lane || typeof frame.id !== 'string' || frame.id.length > 128 || pending.has(frame.id)) {
        return reply({ kind: 'error', id: frame.id, error: { message: 'Invalid broker request' } });
      }
      if (pending.size >= MAX_WAITING) return reply({ kind: 'error', id: frame.id, error: { message: 'Client queue full' } });
      try { lane.acquire(clientId); }
      catch (error) { return reply({ kind: 'error', id: frame.id, error: errorRecord(error) }); }
      const controller = new AbortController();
      pending.set(frame.id, controller);
      active.add(controller);
      lane.execute(frame.actions, { signal: controller.signal, timeoutMs: frame.timeoutMs,
        onResponse: response => {
          const progress = responseMetadata(response);
          reply({ kind: 'progress', id: frame.id, response: progress });
        } })
        .then(responses => reply({ kind: 'result', id: frame.id, responses }))
        .catch(error => {
          reply({ kind: 'error', id: frame.id, error: errorRecord(error), responses: boundedErrorResponses(error.responses, frame.actions?.length) });
          // A proven local refusal retains this owner's healthy lease. An
          // admitted failure has already marked releasing, even if its Error
          // copied or reused a locally branded refusal.
          if (isPreAdmissionRefusal(error) && !lane.releasing && !lane.cleanupFailure) return;
          // A queued RPC can expire while earlier input is still active. Its
          // canceled task stays serialized; do not release that earlier input
          // merely to deliver the queued caller's finite error response.
          void lane.tail.then(() => lane.release(clientId)).catch(() => {});
        })
        .finally(() => { pending.delete(frame.id); active.delete(controller); });
    }, () => socket.destroy(), MAX_REQUEST_BYTES);
    socket.once('error', () => socket.destroy());
    socket.once('close', () => {
      for (const controller of pending.values()) controller.abort(new Error('Client disconnected'));
      sockets.delete(socket);
      void lane?.release(clientId).catch(() => {});
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);
  return { server, lanes, close({ signal, timeoutMs = retirementMs ?? RETIREMENT_TIMEOUT_MS, deadline } = {}) {
    let cutoff;
    try { cutoff = retirementDeadline({ timeoutMs, deadline }); }
    catch (error) { return Promise.reject(error); }
    closeDeadline = Math.min(closeDeadline ?? Infinity, cutoff);
    if (!closePromise) {
      closing = true;
      closeController = new AbortController();
      const listeners = [];
      const failure = Object.assign(new Error('Broker owned shutdown is unconfirmed'), { code: 'release_unconfirmed' });
      const interrupted = new Promise((_, reject) => {
        closeController.signal.addEventListener('abort', () => reject(failure), { once: true });
      });
      observeCloseSignal = observed => {
        if (!observed) return;
        const abort = () => closeController.abort(failure);
        listeners.push([observed, abort]);
        observed.addEventListener('abort', abort, { once: true });
        if (observed.aborted) abort();
      };
      // Stop admission before awaiting owned executor cleanup. A connection
      // already queued for acceptance is refused by the closing flag above.
      const listenerClosed = new Promise(resolve => server.close(resolve));
      for (const controller of active) controller.abort(new Error('Broker shutting down'));
      for (const socket of sockets) socket.destroy();
      const cleanup = (async () => {
        const results = await Promise.allSettled([...lanes.values()].map(lane =>
          lane.close({ signal: closeController.signal, timeoutMs, deadline: closeDeadline })));
        await listenerClosed;
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        if (closeController.signal.aborted || performance.now() >= closeDeadline) throw failure;
      })();
      closePromise = Promise.race([cleanup, interrupted]).finally(() => {
        clearTimeout(closeTimer);
        for (const [observed, abort] of listeners) observed.removeEventListener('abort', abort);
        observeCloseSignal = null;
      });
      closePromise.catch(() => {});
    } else {
      // Every shorter caller cutoff reaches the already-retiring lanes, even
      // when their serial tails are stalled and dropExecutor has not begun.
      for (const lane of lanes.values()) {
        lane.close({ signal: closeController.signal, timeoutMs, deadline: closeDeadline }).catch(() => {});
      }
    }
    observeCloseSignal?.(signal);
    if (observeCloseSignal) {
      clearTimeout(closeTimer);
      const remaining = closeDeadline - performance.now();
      if (remaining <= 0) closeController.abort(new Error('Broker shutdown deadline exceeded'));
      else closeTimer = setTimeout(() => closeController.abort(new Error('Broker shutdown deadline exceeded')), remaining);
    }
    return closePromise;
  } };
}
