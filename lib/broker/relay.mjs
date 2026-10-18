// SPDX-License-Identifier: MIT
import net from 'node:net';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFrames, writeFrame, MAX_REQUEST_BYTES } from './protocol.mjs';
import { prepareSocket } from './paths.mjs';
import { retirementDeadline } from '../deadlines.mjs';
import { secretRequestShape, SECRET_REQUEST_MESSAGE } from './type-secret.mjs';

export const RELAY_HEALTH_SCHEMA = 'fruitctl.relay-health.v1';
// Process exit statuses a service manager keys on. 3: the owned SSH child's
// retirement is unconfirmed, so an operator reconciles before any restart.
// 78 (EX_CONFIG): restarting cannot repair the command line.
export const RELAY_EXIT = Object.freeze({ unconfirmed: 3, config: 78 });
// stableMs: a link must stay up this long after its first remote frame
// before the backoff counter resets, so a link that greets and drops keeps
// backing off. probeMs/silenceMs: the relay probes the remote attach on the
// empty channel and retires a link that sent no byte for silenceMs.
export const DEFAULT_BACKOFF = Object.freeze({ initialMs: 1000, maxMs: 30000, stableMs: 30000,
  probeMs: 15000, silenceMs: 45000 });
// A lost link's child gets TERM, KILL after this, and must drain within the
// retirement budget before a successor may spawn.
const LINK_KILL_MS = 500;
const LINK_RETIREMENT_MS = 2000;
// attach --mux announces itself on the empty channel. Older relays ignore it:
// no client channel is empty, so it never matches a forwarded session.
const HELLO_CHANNEL = '';
// Every attach --mux answers a non-open packet on an unknown channel with
// `closed`, so this probe gets a reply from current and older attaches alike.
const PROBE_FRAME = Object.freeze({ v: 1, channel: HELLO_CHANNEL, kind: 'packet', packet: { kind: 'probe' } });
const STDERR_TAIL_BYTES = 4096;

// Stable messages per typed bridge failure. SSH and remote stderr are only
// classified locally; their text never reaches clients, logs or health.
const BRIDGE_MESSAGES = Object.freeze({
  bridge_unreachable: 'Fruitctl bridge host is unreachable; the request was not delivered',
  bridge_auth_refused: 'Fruitctl bridge host refused SSH authentication; the request was not delivered',
  bridge_host_key: 'Fruitctl bridge host key is not trusted by this seat; the request was not delivered',
  bridge_command_missing: 'Fruitctl bridge remote command was not found; the request was not delivered',
  bridge_attach_failed: 'Fruitctl bridge attach exited before it answered; the request was not delivered',
  bridge_protocol: 'Fruitctl bridge sent an invalid frame; input was not replayed',
  bridge_lost: 'Fruitctl SSH bridge lost; input was not replayed and in-flight execution is uncertain',
  bridge_broker_unavailable: 'Darwin broker did not accept the session; start the broker on the bridge host',
  bridge_unconfirmed: 'Fruitctl SSH bridge retirement is unconfirmed; reconcile the target before restarting',
});

const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const configError = message => Object.assign(new Error(message),
  { code: 'relay_config', exitCode: RELAY_EXIT.config });

export function sshArguments({ bridge, remoteSocket, remoteCommand = 'fruitctl' }) {
  if (typeof bridge !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(bridge)) {
    throw configError('Bridge must be an explicit SSH host or user@host');
  }
  const command = [remoteCommand, 'attach', '--mux'];
  if (remoteSocket) command.push('--socket', remoteSocket);
  // ConnectTimeout bounds an unreachable host; ServerAlive bounds a dead link.
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ForwardAgent=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3', bridge,
    command.map(shellQuote).join(' ')];
}

/** Typed cause of an SSH link that ended. `confirmed` means the remote attach
 * answered on this link, so its loss leaves in-flight execution uncertain. */
export function classifyBridgeExit({ exitCode = null, stderr = '', confirmed = false,
  spawnError = false, protocol = false, silent = false } = {}) {
  if (protocol) return { code: 'bridge_protocol' };
  if (confirmed) return silent ? { code: 'bridge_lost', reason: 'unresponsive' } : { code: 'bridge_lost' };
  if (silent) return { code: 'bridge_unreachable', reason: 'unresponsive' };
  if (spawnError) return { code: 'bridge_unreachable', reason: 'ssh_unavailable' };
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return { code: 'bridge_host_key' };
  if (/Permission denied \(|Too many authentication failures/i.test(stderr)) return { code: 'bridge_auth_refused' };
  if (/Could not resolve hostname|Name or service not known|Temporary failure in name resolution/i.test(stderr)) {
    return { code: 'bridge_unreachable', reason: 'dns' };
  }
  if (/Connection refused/i.test(stderr)) return { code: 'bridge_unreachable', reason: 'refused' };
  if (/timed out|No route to host|Network is unreachable/i.test(stderr)) return { code: 'bridge_unreachable', reason: 'network' };
  if (exitCode === 127 || /command not found/i.test(stderr)) return { code: 'bridge_command_missing' };
  if (exitCode === 255) return { code: 'bridge_unreachable', reason: 'ssh' };
  return { code: 'bridge_attach_failed' };
}

export function bridgeError({ code, reason }) {
  return { code, message: BRIDGE_MESSAGES[code] || BRIDGE_MESSAGES.bridge_lost,
    ...(reason ? { data: { reason } } : {}) };
}

/** D16: type_secret names a ref that only the Darwin broker resolves. A
 * request in any other shape could carry a value, so the relay refuses it
 * before it leaves the Linux seat, with the broker's own check and code.
 * Returns the refusal record, or null for a frame that may pass. */
export function secretValueRefusal(packet) {
  if (packet?.kind !== 'execute' || !Array.isArray(packet.actions)) return null;
  const invalid = packet.actions.some(action =>
    action?.action === 'type_secret' && !secretRequestShape(action));
  return invalid ? { code: 'invalid_secret_request', message: SECRET_REQUEST_MESSAGE } : null;
}

export async function attachMux({ input = process.stdin, output = process.stdout, socketPath }) {
  const channels = new Map();
  const send = frame => writeFrame(output, frame);
  const close = () => { for (const socket of channels.values()) socket.destroy(); channels.clear(); };
  try { send({ v: 1, channel: HELLO_CHANNEL, kind: 'hello' }); } catch { /* A closed output ends below. */ }
  readFrames(input, frame => {
    if (frame.v !== 1 || typeof frame.channel !== 'string' || frame.channel.length > 128) return (close(), false);
    if (frame.kind === 'close') { channels.get(frame.channel)?.destroy(); return; }
    if (frame.kind !== 'packet' || !frame.packet || typeof frame.packet !== 'object') return (close(), false);
    let socket = channels.get(frame.channel);
    if (!socket) {
      if (frame.packet.kind !== 'open' || channels.size >= 128) {
        return send({ v: 1, channel: frame.channel, kind: 'closed' });
      }
      socket = net.connect(socketPath);
      channels.set(frame.channel, socket);
      readFrames(socket, packet => {
        try { send({ v: 1, channel: frame.channel, kind: 'packet', packet }); }
        catch { close(); }
      }, () => socket.destroy());
      socket.once('error', () => socket.destroy());
      socket.once('close', () => {
        channels.delete(frame.channel);
        try { send({ v: 1, channel: frame.channel, kind: 'closed' }); } catch {}
      });
    }
    try { writeFrame(socket, frame.packet); } catch { socket.destroy(); }
  }, close, MAX_REQUEST_BYTES + 1024);
  input.once('end', close);
  input.once('error', close);
  output.once('error', close);
  return { close, channels };
}

/**
 * Local relay socket to one Darwin broker over SSH stdio.
 *
 * Without `reconnect`, the first bridge loss rejects `failure` and retires the
 * relay. With `reconnect`, the listener stays up: a lost link's clients get a
 * typed error (never a replay), and a successor SSH child spawns with capped,
 * jittered exponential backoff only after its predecessor drained `close`.
 * `failure` then rejects only when that retirement is unconfirmed.
 */
export async function createRelay({ socketPath, bridge, remoteSocket, remoteCommand,
  reconnect = false, backoff = {}, random = Math.random, now = Date.now, log = () => {},
  spawnSSH = args => spawn('/usr/bin/ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] }) }) {
  const args = sshArguments({ bridge, remoteSocket, remoteCommand });
  const policy = { ...DEFAULT_BACKOFF, ...backoff };
  await prepareSocket(socketPath);
  const clients = new Map();
  let closed = false;
  let failedReject;
  const failure = new Promise((_, reject) => { failedReject = reject; });
  failure.catch(() => {});
  const health = { state: 'connecting', since: now(), attempts: 0, lastError: null, retryAt: null };
  const setState = state => {
    if (health.state !== state) { health.state = state; health.since = now(); }
  };
  // The one owned SSH child. A successor exists only after it drained close.
  let link;
  let retryTimer;

  const send = (owner, frame) => writeFrame(owner.child.stdin, frame);
  // Answer locally and half-close, so the frame is read before the socket
  // closes; a peer that never finishes is destroyed shortly after.
  const endWith = (socket, frame) => {
    try { writeFrame(socket, frame); socket.end(); }
    catch { socket.destroy(); return; }
    setTimeout(() => socket.destroy(), 1000).unref();
  };
  const refuse = (socket, error) => endWith(socket, { v: 1, kind: 'error', error });
  // A link resets backoff only after it stayed up stableMs; a hello alone
  // does not, or a link that greets and drops would retry every second.
  const stable = owner => Boolean(owner?.confirmed && !owner.lost && now() - owner.confirmedAt >= policy.stableMs);
  const confirm = owner => {
    if (owner.confirmed || owner.lost) return;
    owner.confirmed = true;
    owner.confirmedAt = now();
    health.lastError = null;
    setState('up');
    log('Fruitctl relay: bridge up');
  };

  const scheduleRetry = () => {
    if (closed) return;
    health.attempts++;
    const base = Math.min(policy.maxMs, policy.initialMs * 2 ** Math.min(30, health.attempts - 1));
    const delayMs = Math.round(base * (0.8 + 0.4 * random()));
    health.retryAt = now() + delayMs;
    const { code, reason, upMs } = health.lastError;
    log(`Fruitctl relay: ${code}${reason ? ` (${reason})` : ''}; retrying in ${Math.ceil(delayMs / 1000)}s` +
      ` (attempt ${health.attempts}${upMs != null ? `, link was up ${Math.round(upMs / 1000)}s` : ''})`);
    retryTimer = setTimeout(() => { retryTimer = undefined; if (!closed) spawnLink(); }, delayMs);
  };

  const fail = () => {
    if (closed) return;
    failedReject(Object.assign(new Error('Fruitctl SSH bridge lost; input was not replayed'), { code: 'bridge_lost' }));
    void close().catch(() => {});
  };

  const loseLink = (owner, cause = {}) => {
    if (!reconnect) { fail(); return; }
    if (closed || owner.lost) return;
    if (stable(owner)) health.attempts = 0;
    owner.lostAt = now();
    owner.lost = true;
    owner.cause = cause;
    clearInterval(owner.probeTimer);
    setState('down');
    // Clients stay bound to this link until it is classified, so they cannot
    // reach a successor. Nothing they sent is replayed.
    const kill = signal => {
      if (owner.closed || owner.child.exitCode != null || owner.child.signalCode != null) return;
      try { owner.child.kill(signal); } catch { /* A refused signal is not closure proof. */ }
    };
    try { owner.child.stdin.end(); } catch {}
    owner.child.stdin.destroy?.();
    kill('SIGTERM');
    const killTimer = setTimeout(() => kill('SIGKILL'), LINK_KILL_MS);
    const deadline = setTimeout(() => {
      if (closed || owner.closed) return;
      for (const [channel, client] of clients) {
        if (client.link !== owner) continue;
        clients.delete(channel);
        refuse(client.socket, bridgeError({ code: 'bridge_unconfirmed' }));
      }
      failedReject(Object.assign(new Error(BRIDGE_MESSAGES.bridge_unconfirmed),
        { code: 'release_unconfirmed', exitCode: RELAY_EXIT.unconfirmed }));
      void close().catch(() => {});
    }, LINK_RETIREMENT_MS);
    owner.closedPromise.then(() => {
      clearTimeout(killTimer);
      clearTimeout(deadline);
      if (closed) return;
      const classified = classifyBridgeExit({ exitCode: owner.exit?.code ?? null, stderr: owner.stderr,
        confirmed: owner.confirmed, spawnError: owner.cause.spawnError, protocol: owner.cause.protocol,
        silent: owner.cause.silent });
      health.lastError = { ...classified, at: new Date(now()).toISOString(),
        ...(owner.confirmed ? { upMs: owner.lostAt - owner.confirmedAt } : {}) };
      for (const [channel, client] of clients) {
        if (client.link !== owner) continue;
        clients.delete(channel);
        // A channel that never received a remote frame never saw `opened`,
        // so its client sent no input: the request was not delivered.
        const code = classified.code === 'bridge_lost' && !client.answered ? 'bridge_unreachable' : classified.code;
        refuse(client.socket, bridgeError({ ...classified, code }));
      }
      scheduleRetry();
    });
  };

  const spawnLink = () => {
    const owner = { closed: false, lost: false, confirmed: false, stderr: '', heardAt: now() };
    owner.closedPromise = new Promise(resolve => { owner.resolveClosed = resolve; });
    link = owner;
    health.retryAt = null;
    setState('connecting');
    const child = owner.child = spawnSSH(args);
    child.once('close', code => { owner.closed = true; owner.exit = { code }; owner.resolveClosed(); });
    const lose = cause => loseLink(owner, cause);
    readFrames(child.stdout, frame => {
      if (closed || owner.lost) return false;
      if (frame.v !== 1 || typeof frame.channel !== 'string') { lose({ protocol: true }); return false; }
      if (frame.channel === HELLO_CHANNEL) {
        // A hello, or any attach's `closed` answer to the probe.
        if (frame.kind === 'hello' || frame.kind === 'closed') confirm(owner);
        return;
      }
      const client = clients.get(frame.channel);
      if (!client || client.link !== owner) return;
      confirm(owner);
      if (frame.kind === 'closed') {
        clients.delete(frame.channel);
        if (client.answered) client.socket.destroy();
        else refuse(client.socket, bridgeError({ code: 'bridge_broker_unavailable' }));
        return;
      }
      if (frame.kind !== 'packet') { lose({ protocol: true }); return false; }
      client.answered = true;
      try { writeFrame(client.socket, frame.packet); } catch { client.socket.destroy(); }
    }, () => lose());
    // Never forward remote stderr: SSH startup environments may contain
    // private diagnostics. A bounded tail is kept only to classify the exit.
    child.stderr?.on('data', chunk => {
      owner.stderr = (owner.stderr + String(chunk)).slice(-STDERR_TAIL_BYTES);
    });
    // Liveness counts bytes, not whole frames, so a large frame on a slow
    // link is not mistaken for silence. SSH keepalives bound a dead network;
    // this bounds a live SSH session whose remote attach stopped answering.
    child.stdout.on('data', () => { owner.heardAt = now(); });
    owner.probeTimer = setInterval(() => {
      if (closed || owner.lost) return clearInterval(owner.probeTimer);
      if (now() - owner.heardAt >= policy.silenceMs) return lose({ silent: true });
      try { writeFrame(child.stdin, PROBE_FRAME); } catch { lose(); }
    }, policy.probeMs);
    owner.probeTimer.unref?.();
    child.stdin.once('error', () => lose());
    child.stdout.once('error', () => lose());
    child.once('error', () => lose({ spawnError: true }));
    child.once('exit', () => lose());
    child.stdout.once('end', () => lose());
    return owner;
  };

  const snapshot = () => ({
    schema: RELAY_HEALTH_SCHEMA, state: closed ? 'closing' : health.state, reconnect, bridge,
    since: new Date(health.since).toISOString(), attempts: stable(link) ? 0 : health.attempts,
    ...(health.state === 'down' && health.retryAt != null ? { retryInMs: Math.max(0, health.retryAt - now()) } : {}),
    lastError: health.lastError, clients: [...clients.values()].filter(client => client.link).length,
  });

  const server = net.createServer(socket => {
    if (closed || clients.size >= 128) return socket.destroy();
    const channel = randomUUID();
    const client = { socket, link: null, answered: false };
    clients.set(channel, client);
    readFrames(socket, packet => {
      if (closed) return false;
      if (!client.link) {
        if (packet.kind === 'relay_health') {
          clients.delete(channel);
          endWith(socket, { v: 1, kind: 'relay_health', health: snapshot() });
          return false;
        }
        if (link.lost) {
          // This client sent nothing over the lost link. An in-flight cause
          // (lost, protocol) describes other sessions, not this request.
          const cause = health.lastError;
          clients.delete(channel);
          refuse(socket, bridgeError(cause && !['bridge_lost', 'bridge_protocol'].includes(cause.code)
            ? cause : { code: 'bridge_unreachable', reason: 'reconnecting' }));
          return false;
        }
        client.link = link;
      }
      const refusal = secretValueRefusal(packet);
      if (refusal) {
        try { writeFrame(socket, { v: 1, kind: 'error', id: packet.id, error: refusal }); }
        catch { socket.destroy(); }
        return;
      }
      if (client.link.lost) return false;
      try { send(client.link, { v: 1, channel, kind: 'packet', packet }); }
      catch { socket.destroy(); }
    }, () => socket.destroy(), MAX_REQUEST_BYTES);
    socket.once('error', () => socket.destroy());
    socket.once('close', () => {
      if (clients.get(channel) !== client) return;
      clients.delete(channel);
      if (!closed && client.link && !client.link.lost) {
        try { send(client.link, { v: 1, channel, kind: 'close' }); } catch {}
      }
    });
  });

  let settleListener;
  const listenerStartup = new Promise(resolve => { settleListener = resolve; });
  let closeState;
  let closePromise;
  const close = ({ signal, timeoutMs, deadline } = {}) => {
    let cutoff;
    try { cutoff = retirementDeadline({ timeoutMs, deadline }); }
    catch (error) { return Promise.reject(error); }
    if (!closeState) {
      closed = true;
      clearTimeout(retryTimer);
      clearInterval(link.probeTimer);
      // Only the current link can still own a child: a predecessor drained
      // close before its successor spawned.
      const owner = link;
      const state = closeState = { deadline: cutoff, signals: new Set(), listeners: new Map() };
      let resolveClose, rejectClose;
      closePromise = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
      // Bridge failures retire in the background. Observe rejection without
      // replacing the sticky result returned to every later close caller.
      closePromise.catch(() => {});
      const unconfirmed = () => {
        state.failure ||= Object.assign(new Error('Relay owned shutdown is unconfirmed'), { code: 'release_unconfirmed' });
        return state.failure;
      };
      const clearTimers = () => {
        clearTimeout(state.forceTimer);
        clearTimeout(state.deadlineTimer);
      };
      state.finish = error => {
        if (state.finished) return;
        state.finished = true;
        clearTimers();
        for (const [observed, abort] of state.listeners) observed.removeEventListener('abort', abort);
        state.listeners.clear();
        if (error) rejectClose(error);
        else resolveClose();
      };
      state.kill = name => {
        // Only this exact spawned child is owned. An exit status prevents
        // signalling an exited/reused PID, but is not a drained close event.
        const ssh = owner.child;
        if (owner.closed || ssh.exitCode != null || ssh.signalCode != null || state.signals.has(name)) return;
        state.signals.add(name);
        try { ssh.kill(name); } catch { /* A refused signal is not closure proof. */ }
      };
      state.interrupt = () => {
        state.kill('SIGTERM');
        state.kill('SIGKILL');
        state.finish(unconfirmed());
      };
      state.check = () => {
        if (owner.closed && state.listenerClosed) {
          state.finish(performance.now() >= state.deadline ? unconfirmed() : undefined);
        }
      };
      state.arm = () => {
        if (state.finished) return;
        clearTimers();
        const remaining = state.deadline - performance.now();
        if (remaining <= 0) { state.interrupt(); return; }
        // Preserve the relay's immediate TERM / 500ms KILL escalation for
        // its default 2s budget, scaling KILL inside shorter caller cutoffs.
        state.forceDeadline = Math.min(state.forceDeadline ?? Infinity,
          performance.now() + Math.min(500, remaining / 4));
        state.forceTimer = setTimeout(() => state.kill('SIGKILL'),
          Math.max(0, state.forceDeadline - performance.now()));
        state.deadlineTimer = setTimeout(state.interrupt, remaining);
      };
      // Keep late child and listener closure observed after rejection. Neither
      // can revise that result, reopen admission, or replay a former request.
      owner.closedPromise.then(state.check, state.interrupt);
      listenerStartup.then(listening => {
        if (!listening) {
          // A settled bind failure never acquired an owned listener.
          state.listenerClosed = true;
          state.check();
          return;
        }
        try {
          server.close(error => {
            if (error) { state.interrupt(); return; }
            state.listenerClosed = true;
            state.check();
          });
        } catch { state.interrupt(); }
      });
      for (const { socket } of clients.values()) socket.destroy();
      try { owner.child.stdin.end(); } catch { /* Continue owned retirement after pipe failure. */ }
      owner.child.stdin.destroy();
      state.kill('SIGTERM');
    }
    const state = closeState;
    if (state.finished) return closePromise;
    state.deadline = Math.min(state.deadline, cutoff);
    if (signal && !state.listeners.has(signal)) {
      const abort = state.interrupt;
      state.listeners.set(signal, abort);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    state.arm();
    state.check();
    return closePromise;
  };

  spawnLink();
  try {
    const listening = new Promise((resolve, reject) => {
      let bound = false;
      const failed = error => {
        if (bound) {
          if (closeState && !closeState.finished) closeState.interrupt();
          else if (reconnect && !closed) {
            failedReject(Object.assign(new Error('Fruitctl relay listener failed'), { code: 'relay_listener_failed' }));
            void close().catch(() => {});
          } else fail();
          return;
        }
        settleListener(false);
        reject(error);
      };
      // After bind succeeds, errors must retire the relay rather than reject
      // only an already-resolved startup promise. Keep later errors observed.
      server.on('error', failed);
      try {
        server.listen(socketPath, () => { bound = true; settleListener(true); resolve(); });
      } catch (error) { failed(error); }
    });
    // A bridge loss must reach bounded retirement even if bind has not yet
    // settled. Its eventual listener result remains tracked for late cleanup.
    await Promise.race([listening, failure]);
    await Promise.race([fs.chmod(socketPath, 0o600), failure]);
    if (closed) throw new Error('Fruitctl SSH bridge failed during startup');
  } catch (error) {
    try { await close(); }
    catch (cleanup) {
      // Retain the startup cause and sticky cleanup failure for local callers;
      // protocol/CLI output receives only the stable message and code.
      throw Object.assign(new AggregateError([error, cleanup],
        'Fruitctl SSH bridge startup cleanup is unconfirmed', { cause: error }),
      { code: 'release_unconfirmed', exitCode: RELAY_EXIT.unconfirmed });
    }
    throw error;
  }
  return { server, failure, close, health: snapshot };
}

/** Ask a running relay for its health without touching the bridge. */
export function queryRelayHealth({ socketPath, timeoutMs = 3000, connect = path => net.connect(path) }) {
  const absent = (code, message) => ({ schema: RELAY_HEALTH_SCHEMA, state: 'absent', lastError: { code, message } });
  return new Promise(resolve => {
    const socket = connect(socketPath);
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(absent('relay_unresponsive', 'Relay socket did not answer a health request')), timeoutMs);
    socket.once('connect', () => {
      try { writeFrame(socket, { v: 1, kind: 'relay_health' }); }
      catch { finish(absent('relay_unavailable', 'Relay socket closed before the health request')); }
    });
    socket.once('error', () => finish(absent('relay_unavailable', 'No relay is listening on this socket; start the fruitctl-relay user service')));
    socket.once('close', () => finish(absent('relay_unresponsive', 'Socket closed without a relay health answer')));
    readFrames(socket, frame => {
      if (frame.v === 1 && frame.kind === 'relay_health' && frame.health?.schema === RELAY_HEALTH_SCHEMA) finish(frame.health);
      else finish(absent('not_a_relay', 'This socket is not a Fruitctl relay'));
      return false;
    }, () => finish(absent('not_a_relay', 'This socket is not a Fruitctl relay')));
  });
}
