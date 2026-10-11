// SPDX-License-Identifier: MIT
import net from 'node:net';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFrames, writeFrame, MAX_REQUEST_BYTES } from './protocol.mjs';
import { prepareSocket } from './paths.mjs';
import { retirementDeadline } from '../deadlines.mjs';

const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

export function sshArguments({ bridge, remoteSocket, remoteCommand = 'fruitctl' }) {
  if (typeof bridge !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(bridge)) {
    throw new Error('Bridge must be an explicit SSH host or user@host');
  }
  const command = [remoteCommand, 'attach', '--mux'];
  if (remoteSocket) command.push('--socket', remoteSocket);
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ForwardAgent=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3', bridge,
    command.map(shellQuote).join(' ')];
}

export async function attachMux({ input = process.stdin, output = process.stdout, socketPath }) {
  const channels = new Map();
  const send = frame => writeFrame(output, frame);
  const close = () => { for (const socket of channels.values()) socket.destroy(); channels.clear(); };
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

export async function createRelay({ socketPath, bridge, remoteSocket, remoteCommand,
  spawnSSH = args => spawn('/usr/bin/ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] }) }) {
  await prepareSocket(socketPath);
  const ssh = spawnSSH(sshArguments({ bridge, remoteSocket, remoteCommand }));
  let childClosed = false;
  const childClose = new Promise(resolve => {
    ssh.once('close', () => { childClosed = true; resolve(); });
  });
  const clients = new Map();
  let closed = false;
  let failedReject;
  const failure = new Promise((_, reject) => { failedReject = reject; });
  failure.catch(() => {});
  const send = frame => writeFrame(ssh.stdin, frame);
  const server = net.createServer(socket => {
    if (closed || clients.size >= 128) return socket.destroy();
    const channel = randomUUID();
    clients.set(channel, socket);
    readFrames(socket, packet => {
      if (closed) return false;
      try { send({ v: 1, channel, kind: 'packet', packet }); }
      catch { socket.destroy(); }
    }, () => socket.destroy(), MAX_REQUEST_BYTES);
    socket.once('error', () => socket.destroy());
    socket.once('close', () => {
      clients.delete(channel);
      if (!closed) { try { send({ v: 1, channel, kind: 'close' }); } catch {} }
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
        if (childClosed || ssh.exitCode != null || ssh.signalCode != null || state.signals.has(name)) return;
        state.signals.add(name);
        try { ssh.kill(name); } catch { /* A refused signal is not closure proof. */ }
      };
      state.interrupt = () => {
        state.kill('SIGTERM');
        state.kill('SIGKILL');
        state.finish(unconfirmed());
      };
      state.check = () => {
        if (childClosed && state.listenerClosed) {
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
      childClose.then(state.check, state.interrupt);
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
      for (const socket of clients.values()) socket.destroy();
      try { ssh.stdin.end(); } catch { /* Continue owned retirement after pipe failure. */ }
      ssh.stdin.destroy();
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
  const fail = () => {
    if (closed) return;
    failedReject(new Error('Fruitctl SSH bridge lost; input was not replayed'));
    void close().catch(() => {});
  };
  readFrames(ssh.stdout, frame => {
    if (closed) return false;
    if (frame.v !== 1 || typeof frame.channel !== 'string') { fail(); return false; }
    const socket = clients.get(frame.channel);
    if (!socket) return;
    if (frame.kind === 'closed') return socket.destroy();
    if (frame.kind !== 'packet') { fail(); return false; }
    try { writeFrame(socket, frame.packet); } catch { socket.destroy(); }
  }, fail);
  // Never forward remote stderr: SSH startup environments may contain private diagnostics.
  ssh.stderr?.on('data', () => {});
  ssh.stdin.once('error', fail);
  ssh.stdout.once('error', fail);
  ssh.once('error', fail);
  ssh.once('exit', fail);
  ssh.stdout.once('end', fail);
  try {
    const listening = new Promise((resolve, reject) => {
      let bound = false;
      const failed = error => {
        if (bound) {
          if (closeState && !closeState.finished) closeState.interrupt();
          else fail();
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
      { code: 'release_unconfirmed' });
    }
    throw error;
  }
  return { server, failure, close };
}
