// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker } from '../lib/broker/server.mjs';
import { BrokerExecutor } from '../lib/broker/client.mjs';
import { createRelay } from '../lib/broker/relay.mjs';
import { readFrames, writeFrame, errorRecord } from '../lib/broker/protocol.mjs';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-review-'));
  await fs.chmod(directory, 0o700);
  return { directory, socketPath: path.join(directory, 'broker.sock') };
}

test('a protocol refusal stops later coalesced broker commands before dispatch', async () => {
  const { directory, socketPath } = await fixture();
  let executions = 0;
  const broker = await createBroker({
    socketPath, config: { targets: { desktop: {} } },
    factory: async () => ({
      async execute() { executions++; return []; },
      async close() {},
    }),
  });
  const socket = net.connect(socketPath);
  try {
    await new Promise((resolve, reject) => {
      readFrames(socket, frame => { if (frame.kind === 'opened') resolve(); }, reject);
      socket.once('error', reject);
      socket.once('connect', () => writeFrame(socket, { v: 1, kind: 'open', profile: 'desktop' }));
    });
    socket.write(
      JSON.stringify({ v: 2, kind: 'execute', id: 'refused', actions: [{ action: 'screenshot' }] }) + '\n' +
      JSON.stringify({ v: 1, kind: 'execute', id: 'later', actions: [{ action: 'screenshot' }] }) + '\n',
    );
    await delay(40);
    assert.equal(executions, 0, 'no action may dispatch after this transport is refused');
  } finally {
    socket.destroy();
    await broker.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a client close frame stops later coalesced input before dispatch', async () => {
  const { directory, socketPath } = await fixture();
  let executions = 0;
  const broker = await createBroker({
    socketPath, config: { targets: { desktop: {} } },
    factory: async () => ({
      async execute() { executions++; return []; },
      async close() {},
    }),
  });
  const socket = net.connect(socketPath);
  try {
    await new Promise((resolve, reject) => {
      readFrames(socket, frame => { if (frame.kind === 'opened') resolve(); }, reject);
      socket.once('error', reject);
      socket.once('connect', () => writeFrame(socket, { v: 1, kind: 'open', profile: 'desktop' }));
    });
    socket.write(
      JSON.stringify({ v: 1, kind: 'close' }) + '\n' +
      JSON.stringify({ v: 1, kind: 'execute', id: 'after-close', actions: [{ action: 'queued-input' }] }) + '\n',
    );
    await delay(40);
    assert.equal(executions, 0, 'closing a client transport revokes subsequent input in the same chunk');
  } finally {
    socket.destroy();
    await broker.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('broker shutdown stops admission before waiting for its owned executor cleanup', async () => {
  const { directory, socketPath } = await fixture();
  let cleanupStarted;
  const cleanupReady = new Promise(resolve => { cleanupStarted = resolve; });
  let finishCleanup;
  const gate = new Promise(resolve => { finishCleanup = resolve; });
  let cleanupCalls = 0;
  const broker = await createBroker({
    socketPath, config: { targets: { desktop: {} } },
    factory: async () => ({
      async execute() { return [{ result: { detail: 'fixture ready' } }]; },
      async close() { cleanupCalls++; cleanupStarted(); await gate; },
    }),
  });
  const first = new BrokerExecutor({ socketPath, target: 'desktop' });
  let late;
  let closing;
  try {
    await first.opened;
    await first.execute([{ action: 'health' }]);
    closing = broker.close();
    await cleanupReady;
    late = net.connect(socketPath);
    await new Promise(resolve => {
      late.once('connect', resolve);
      late.once('error', resolve);
    });
    finishCleanup();
    let deadlineTimer;
    try {
      await Promise.race([
        closing,
        new Promise((_, reject) => {
          deadlineTimer = setTimeout(() => reject(new Error('late clients must not prevent owned shutdown')), 100);
        }),
      ]);
    } finally { clearTimeout(deadlineTimer); }
    await Promise.all([broker.close(), broker.close()]);
    assert.equal(cleanupCalls, 1, 'repeated shutdown does not repeat target cleanup');
  } finally {
    finishCleanup();
    late?.destroy();
    await first.close();
    await closing;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function waitUntil(predicate, message, timeoutMs = 1000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail(message);
    await delay(2);
  }
}

test('unconfirmed executor cleanup keeps every successor session blocked', async () => {
  const { directory, socketPath } = await fixture();
  let unconfirmed = true;
  let starts = 0;
  const broker = await createBroker({
    socketPath, config: { targets: { desktop: {} } },
    factory: async () => ({
      async execute(actions, { signal }) {
        starts++;
        if (actions[0].action === 'hold') await delay(1000, undefined, { signal });
        return [{ result: { detail: 'done' } }];
      },
      async close() {
        if (unconfirmed) throw new Error('Synthetic unconfirmed held-input cleanup');
      },
    }),
  });
  const a = new BrokerExecutor({ socketPath, target: 'desktop' });
  const b = new BrokerExecutor({ socketPath, target: 'desktop' });
  try {
    await Promise.all([a.opened, b.opened]);
    await assert.rejects(a.execute([{ action: 'hold' }], { timeoutMs: 10 }));
    await delay(30);
    await assert.rejects(b.execute([{ action: 'screenshot' }]), /controlled|releasing|unconfirmed/i);
    assert.equal(starts, 1, 'a new native action cannot start after unconfirmed cleanup');
    unconfirmed = false;
    await assert.rejects(b.execute([{ action: 'screenshot' }]), /unconfirmed/i);
    assert.equal(starts, 1, 'a later successful close cannot erase uncertainty about earlier held input');
  } finally {
    unconfirmed = false;
    await a.close();
    await b.close();
    await assert.rejects(broker.close(), /unconfirmed/i);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('100 broker fixture cycles preserve exclusive ownership and require confirmed cleanup or explicit synthetic reconciliation', async t => {
  const { directory, socketPath } = await fixture();
  let nextExecutor = 0;
  let live = 0;
  let maximumLive = 0;
  let starts = 0;
  let closes = 0;
  let reconciliations = 0;
  let refuseCloseAcknowledgement = false;
  let confirmLateClose;
  let held = false;
  const trace = [];
  const makeBroker = () => createBroker({
    socketPath, config: { targets: { desktop: {} } }, leaseMs: 1000,
    factory: async () => {
      const executorId = ++nextExecutor;
      let closed = false;
      let refuse = refuseCloseAcknowledgement;
      refuseCloseAcknowledgement = false;
      const closeAcknowledged = refuse ? new Promise(resolve => { confirmLateClose = resolve; }) : Promise.resolve();
      live++;
      maximumLive = Math.max(maximumLive, live);
      return {
        async execute(actions, { signal, onResponse }) {
          assert.equal(closed, false, 'never dispatch through a closed executor');
          starts++;
          trace.push({ kind: 'start', executorId });
          if (actions[0].action === 'hold') {
            held = true;
            onResponse?.({ id: 'held', result: { detail: 'acknowledged fixture input' } });
            await delay(1000, undefined, { signal });
          }
          return [{ result: { detail: String(actions[0].marker) } }];
        },
        async close() {
          if (refuse) {
            refuse = false;
            throw new Error('Synthetic owned fixture close acknowledgement unavailable');
          }
          await closeAcknowledged;
          // Exercise an asynchronous close acknowledgement without coupling
          // this ownership-order fixture to wall-clock scheduling latency.
          await new Promise(resolve => queueMicrotask(resolve));
          if (closed) return;
          closed = true;
          held = false;
          live--;
          closes++;
          trace.push({ kind: 'closed', executorId });
        },
      };
    },
  });
  let broker = await makeBroker();
  let lane = broker.lanes.get('desktop');
  const clients = new Set();
  try {
    for (let cycle = 0; cycle < 100; cycle++) {
      const mode = cycle % 5;
      lane.leaseMs = mode === 2 ? 100 : 1000;
      const a = new BrokerExecutor({ socketPath, target: 'desktop' });
      let b = new BrokerExecutor({ socketPath, target: 'desktop' });
      clients.add(a); clients.add(b);
      await Promise.all([a.opened, b.opened]);
      // One controlled refusal proves reconciliation every run, independently
      // of whether the host scheduler exhausts the small deadline budget.
      refuseCloseAcknowledgement = cycle === 4;
      await a.execute([{ action: 'marker', marker: cycle }]);
      const ownerExecutorId = nextExecutor;
      await assert.rejects(b.execute([{ action: 'marker', marker: 'blocked' }]), /controlled/);

      if (mode === 0) await a.release();
      if (mode === 1) await a.close();
      // mode 2 lets the owning session's actual inactivity timer expire.
      if (mode === 3) {
        const controller = new AbortController();
        await assert.rejects(a.execute([{ action: 'hold' }], {
          signal: controller.signal,
          onResponse: () => controller.abort(new Error('fixture owner cancellation')),
        }), /cancel/i);
      }
      if (mode === 4) {
        await assert.rejects(a.execute([{ action: 'hold' }], { timeoutMs: 40 }), error =>
          error.code === 'release_unconfirmed' || /deadline|timeout/i.test(error.message));
        await waitUntil(() => lane.cleanupFailure || (lane.owner === null && live === 0),
          'deadline retirement must either confirm closure or record its uncertainty');
        if (lane.cleanupFailure) {
          // This is only a local synthetic executor fixture, never a target
          // or automatic product restart. A short deadline can expire before
          // its asynchronous close acknowledgement gets CPU.
          const failure = lane.cleanupFailure, before = starts;
          assert.equal(failure.code, 'release_unconfirmed');
          await assert.rejects(b.execute([{ action: 'marker', marker: 'blocked-after-deadline' }]), /unconfirmed/);
          confirmLateClose?.();
          confirmLateClose = undefined;
          await waitUntil(() => live === 0 && trace.some(event =>
            event.kind === 'closed' && event.executorId === ownerExecutorId),
            'exact owned fixture close acknowledgement was not observed');
          assert.equal(held, false);
          await assert.rejects(b.execute([{ action: 'marker', marker: 'blocked-after-close' }]), /unconfirmed/);
          assert.equal(lane.cleanupFailure, failure, 'actual later close cannot clear uncertainty');
          assert.equal(starts, before, 'blocked input is neither dispatched nor replayed');
          await a.close(); await b.close();
          clients.delete(a); clients.delete(b);
          const listenerClosed = new Promise(resolve => broker.server.once('close', resolve));
          await assert.rejects(broker.close(), /unconfirmed/);
          await listenerClosed;
          assert.equal(lane.cleanupFailure, failure, 'the old lane remains blocked after shutdown');
          // Explicit fixture reconciliation creates a different owned broker
          // only after observed executor/listener closure, then sends a new
          // successor marker rather than retrying the previous hold action.
          broker = await makeBroker();
          lane = broker.lanes.get('desktop');
          b = new BrokerExecutor({ socketPath, target: 'desktop' });
          clients.add(b);
          await b.opened;
          reconciliations++;
          t.diagnostic(JSON.stringify({ fixture: 'synthetic-broker-reconciliation', cycle,
            ownerExecutorId, closeAcknowledged: true, previousLaneStillBlocked: true, replayed: false }));
        }
      }

      await waitUntil(() => lane.owner === null && live === 0,
        `owner cleanup did not finish in cycle ${cycle}, mode ${mode}: ` +
        JSON.stringify({ owner: lane.owner, releasing: lane.releasing, live, starts, closes }));
      assert.equal(held, false, 'successor admission requires balanced fixture input');
      await b.execute([{ action: 'marker', marker: 'successor-' + cycle }]);
      await b.release();
      await a.close(); await b.close();
      clients.delete(a); clients.delete(b);
      await waitUntil(() => live === 0, 'successor executor did not close');
    }
    assert.equal(maximumLive, 1, 'there is at most one target native fixture at any instant');
    assert.equal(nextExecutor, 200);
    assert.equal(closes, 200);
    assert.equal(starts, 240, 'blocked requests and uncertain input are never replayed');
    assert.ok(100 - reconciliations >= 80, 'all non-deadline modes require confirmed cleanup on the same broker');
    t.diagnostic(JSON.stringify({ fixture: 'synthetic-ownership-cycle-summary', cycles: 100,
      confirmedCycles: 100 - reconciliations, reconciliations, ownedExecutors: nextExecutor,
      closedExecutors: closes, dispatched: starts, maximumLive }));
    for (let i = 1; i < trace.length; i++) {
      if (trace[i].kind === 'start' && trace[i].executorId !== trace[i - 1].executorId) {
        assert.equal(trace[i - 1].kind, 'closed', 'previous executor closes before successor input');
      }
    }
  } finally {
    confirmLateClose?.();
    for (const client of clients) await client.close();
    await broker.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('cancelling an active request revokes already queued input before another dispatch', async () => {
  const { directory, socketPath } = await fixture();
  const dispatched = [];
  const broker = await createBroker({
    socketPath, config: { targets: { desktop: {} } },
    factory: async () => ({
      async execute(actions, { signal, onResponse }) {
        dispatched.push(actions[0].action);
        if (actions[0].action === 'hold') {
          onResponse?.({ result: { detail: 'fixture input acknowledged' } });
          await delay(1000, undefined, { signal });
        }
        return [];
      },
      async close() { await delay(2); },
    }),
  });
  const client = new BrokerExecutor({ socketPath, target: 'desktop' });
  try {
    await client.opened;
    const controller = new AbortController();
    const outcomes = await Promise.allSettled([
      client.execute([{ action: 'hold' }], {
        signal: controller.signal,
        onResponse: () => controller.abort(new Error('fixture queue cancellation')),
      }),
      client.execute([{ action: 'queued-input' }]),
    ]);
    assert.equal(outcomes[0].status, 'rejected');
    assert.equal(outcomes[1].status, 'rejected', 'input queued behind cancellation must be revoked');
    assert.deepEqual(dispatched, ['hold'], 'no queued input can start between cleanup and owner revocation');
  } finally {
    await client.close();
    await broker.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('expiry of a queued request cannot admit later input in the same turn', async () => {
  const { directory, socketPath } = await fixture();
  const dispatched = [];
  const broker = await createBroker({
    socketPath, config: { targets: { desktop: {} } },
    factory: async () => ({
      async execute(actions, { signal }) {
        dispatched.push(actions[0].action);
        if (actions[0].action === 'slow') await delay(40, undefined, { signal });
        return [];
      },
      async close() {},
    }),
  });
  const client = new BrokerExecutor({ socketPath, target: 'desktop' });
  try {
    await client.opened;
    const outcomes = await Promise.allSettled([
      client.execute([{ action: 'slow' }]),
      client.execute([{ action: 'expired-input' }], { timeoutMs: 5 }),
      client.execute([{ action: 'later-input' }]),
    ]);
    assert.equal(outcomes[1].status, 'rejected');
    assert.equal(outcomes[2].status, 'rejected', 'expiry must revoke later queued input before the tail advances');
    assert.deepEqual(dispatched, ['slow']);
  } finally {
    await client.close();
    await broker.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('two profile names cannot grant independent ownership of one configured VNC endpoint', async () => {
  const { directory, socketPath } = await fixture();
  const endpoint = { vnc: { host: 'fixture-darwin', port: 5900 }, credentialFile: '/fixture/private-credential' };
  let broker;
  let spawns = 0;
  const clients = [];
  try {
    try {
      broker = await createBroker({
        socketPath, config: { targets: { desktop: endpoint, alias: { ...endpoint } } },
        factory: async () => {
          spawns++;
          return { async execute() { return []; }, async close() {} };
        },
      });
    } catch (error) {
      assert.match(error.message, /duplicate|same|endpoint|already/i,
        'rejecting duplicate endpoint configuration is also valid containment');
      return;
    }
    const a = new BrokerExecutor({ socketPath, target: 'desktop' });
    const b = new BrokerExecutor({ socketPath, target: 'alias' });
    clients.push(a, b);
    await Promise.all([a.opened, b.opened]);
    await a.execute([{ action: 'marker' }]);
    await assert.rejects(b.execute([{ action: 'competing-input' }]), /controlled|releasing/i);
    assert.equal(spawns, 1, 'one configured endpoint has one shared owner and native executor');
  } finally {
    for (const client of clients) await client.close();
    await broker?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

for (const [name, profiles] of [
  ['one explicit host-helper SSH target', {
    desktop: { vnc: { host: 'fixture-vnc-a', port: 5900 }, hostHelper: { sshHost: 'fixture-darwin' } },
    alias: { vnc: { host: 'fixture-vnc-b', port: 5901 }, hostHelper: { sshHost: 'fixture-darwin' } },
  }],
  ['one explicit physical targetId', {
    desktop: { vnc: { host: 'fixture-vnc-a', port: 5900 }, targetId: 'fixture-physical-darwin' },
    alias: { vnc: { host: 'fixture-vnc-b', port: 5901 }, targetId: 'fixture-physical-darwin' },
  }],
]) {
  test(`two profiles cannot independently control ${name}`, async () => {
    const { directory, socketPath } = await fixture();
    let broker;
    let spawns = 0;
    const clients = [];
    try {
      try {
        broker = await createBroker({
          socketPath, config: { targets: profiles },
          factory: async () => {
            spawns++;
            return { async execute() { return []; }, async close() {} };
          },
        });
      } catch (error) {
        assert.match(error.message, /duplicate|same|endpoint|target|already/i);
        return;
      }
      const a = new BrokerExecutor({ socketPath, target: 'desktop' });
      const b = new BrokerExecutor({ socketPath, target: 'alias' });
      clients.push(a, b);
      await Promise.all([a.opened, b.opened]);
      await a.execute([{ action: 'marker' }]);
      await assert.rejects(b.execute([{ action: 'competing-input' }]), /controlled|releasing/i);
      assert.equal(spawns, 1);
    } finally {
      for (const client of clients) await client.close();
      await broker?.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}

test('malformed UTF-8 cannot silently rewrite a protocol text action', () => {
  const input = new PassThrough();
  const frames = [];
  let failure;
  readFrames(input, frame => frames.push(frame), error => { failure = error; });
  input.end(Buffer.concat([
    Buffer.from('{"v":1,"kind":"execute","id":"bad-text","actions":[{"action":"type_text","text":"'),
    Buffer.from([0xff]),
    Buffer.from('"}]}\n'),
  ]));
  assert.equal(frames.length, 0, 'replacement characters must not reach the target');
  assert.ok(failure, 'invalid UTF-8 must fail the protocol');
});

test('cancellation during broker opening rejects promptly without dispatch', async () => {
  const { directory, socketPath } = await fixture();
  const connections = new Set();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    // Deliberately never acknowledge open: this exercises cancellation while opening.
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const client = new BrokerExecutor({ socketPath, target: 'desktop', connectTimeoutMs: 500 });
  const controller = new AbortController();
  const execution = client.execute([{ action: 'screenshot' }], { signal: controller.signal });
  const outcome = execution.then(
    () => ({ kind: 'resolved' }),
    error => ({ kind: 'rejected', message: error.message }),
  );
  try {
    controller.abort(new Error('cancel before open'));
    const result = await Promise.race([outcome, delay(80).then(() => ({ kind: 'waiting' }))]);
    assert.equal(result.kind, 'rejected', 'opening cannot postpone request cancellation');
    assert.match(result.message, /cancel/i);
  } finally {
    await client.close();
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('SSH stdin pipe failure follows relay failure cleanup instead of escaping', async () => {
  const { directory } = await fixture();
  let child;
  const relay = await createRelay({
    socketPath: path.join(directory, 'relay.sock'), bridge: 'fixture@darwin',
    spawnSSH: () => {
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        queueMicrotask(() => {
          child.stdout.end();
          child.emit('exit', null, 'SIGTERM');
          child.emit('close', null, 'SIGTERM');
        });
        return true;
      };
      return child;
    },
  });
  try {
    const pipeError = Object.assign(new Error('synthetic private pipe diagnostic'), { code: 'EPIPE' });
    assert.doesNotThrow(() => child.stdin.emit('error', pipeError));
    await assert.rejects(relay.failure, /SSH bridge lost/);
  } finally {
    await relay.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('relay shutdown waits for its owned SSH child and escalates a refused termination', async () => {
  const { directory } = await fixture();
  const signals = [];
  let child;
  let exited = false;
  const finishChild = signal => {
    if (exited) return;
    exited = true;
    child.exitCode = null;
    child.signalCode = signal;
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', null, signal);
    child.emit('close', null, signal);
  };
  const relay = await createRelay({
    socketPath: path.join(directory, 'relay.sock'), bridge: 'fixture@darwin',
    spawnSSH: () => {
      child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = signal => {
        signals.push(signal);
        // This owned fixture ignores SIGTERM; only bounded escalation can close it.
        if (signal === 'SIGKILL') queueMicrotask(() => finishChild(signal));
        return true;
      };
      return child;
    },
  });
  let closing;
  try {
    let settled = false;
    closing = relay.close().then(() => { settled = true; });
    await delay(25);
    assert.equal(settled, false, 'closing the listener alone is not confirmed child cleanup');
    let deadlineTimer;
    try {
      await Promise.race([
        closing,
        new Promise((_, reject) => {
          deadlineTimer = setTimeout(() => reject(new Error('owned SSH termination must have a bounded escalation deadline')), 2500);
        }),
      ]);
    } finally { clearTimeout(deadlineTimer); }
    assert.equal(exited, true, 'shutdown must observe the owned SSH child close event');
    assert.equal(signals[0], 'SIGTERM');
    assert.equal(signals.at(-1), 'SIGKILL');
  } finally {
    finishChild('SIGKILL');
    await closing;
    await relay.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('relay bind failure tears down the SSH child created during startup', async () => {
  const { directory } = await fixture();
  const socketPath = path.join(directory, 'startup.sock');
  let terminations = 0;
  let child;
  try {
    await assert.rejects(createRelay({
      socketPath, bridge: 'fixture@darwin',
      spawnSSH: () => {
        // Simulate an owned path appearing between preparation and bind.
        writeFileSync(socketPath, 'intervening fixture', { mode: 0o600 });
        child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {
          terminations++;
          queueMicrotask(() => {
            child.stdout.end();
            child.emit('exit', null, 'SIGTERM');
            child.emit('close', null, 'SIGTERM');
          });
          return true;
        };
        return child;
      },
    }), /EADDRINUSE/);
    assert.ok(terminations > 0, 'a rejected startup must not leave its owned SSH child alive');
  } finally {
    if (!terminations) child?.kill();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function boundedRelayResult(promise, timeoutMs = 500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('relay retirement exceeded the fixture bound')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function ownedRelayFixture(t, onKill = () => false) {
  const { directory } = await fixture();
  const socketPath = path.join(directory, 'relay.sock');
  const signals = [], packets = [], sockets = new Set();
  let child, childClosed = false;
  const finishChild = (signal = 'SIGKILL') => {
    if (childClosed) return;
    childClosed = true;
    child.signalCode = signal;
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', null, signal);
    child.emit('close', null, signal);
  };
  const relay = await createRelay({
    socketPath, bridge: 'fixture@darwin',
    spawnSSH: () => {
      child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      readFrames(child.stdin, packet => packets.push(packet), () => {});
      child.kill = signal => {
        signals.push(signal);
        return onKill(signal, finishChild);
      };
      return child;
    },
  });
  const originalClose = relay.server.close.bind(relay.server);
  let heldListener;
  const holdListener = () => {
    const state = heldListener = { calls: 0 };
    relay.server.close = callback => {
      state.calls++;
      state.callback = callback;
      return relay.server;
    };
    state.release = () => {
      if (state.releasing) return state.releasing;
      relay.server.close = originalClose;
      state.releasing = new Promise((resolve, reject) => originalClose(error => {
        state.callback?.(error);
        if (error) reject(error);
        else resolve();
      }));
      return state.releasing;
    };
    return state;
  };
  const connect = async () => {
    const socket = net.connect(socketPath);
    sockets.add(socket);
    socket.on('error', () => {});
    socket.resume();
    await boundedRelayResult(new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    }));
    return socket;
  };
  t.after(async () => {
    // Reconcile only these synthetic resources after assertions. Closing an
    // old child's fixture does not clear the same relay's sticky failure.
    const closing = relay.close();
    finishChild();
    for (const socket of sockets) socket.destroy();
    try {
      if (heldListener) {
        await waitUntil(() => heldListener.calls > 0);
        await boundedRelayResult(heldListener.release());
      }
      const failure = await boundedRelayResult(closing.then(() => null, error => error));
      if (failure) assert.equal(failure.code, 'release_unconfirmed');
      assert.equal(childClosed, true);
      assert.equal(relay.server.listening, false);
    } finally {
      relay.server.close = originalClose;
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  return { relay, child, signals, packets, connect, finishChild, holdListener,
    get childClosed() { return childClosed; } };
}

test('relay later timeout callers tighten one retirement and cannot extend it', async t => {
  const owned = await ownedRelayFixture(t);
  const closing = owned.relay.close({ timeoutMs: 2000 });
  assert.strictEqual(owned.relay.close({ timeoutMs: 40 }), closing);
  assert.strictEqual(owned.relay.close({ timeoutMs: 2000 }), closing);
  const failure = await boundedRelayResult(closing.then(() => null, error => error));
  assert.equal(failure.code, 'release_unconfirmed');
  assert.equal(owned.childClosed, false, 'an attempted TERM/KILL does not prove child close');
  assert.deepEqual(owned.signals, ['SIGTERM', 'SIGKILL']);
  owned.finishChild();
  assert.strictEqual(await owned.relay.close().catch(error => error), failure,
    'late owned close cannot replace the earlier unconfirmed result');
});

test('relay expired inherited deadline tightens pending retirement immediately', async t => {
  const owned = await ownedRelayFixture(t);
  const closing = owned.relay.close({ timeoutMs: 2000 });
  assert.strictEqual(owned.relay.close({ timeoutMs: 30000, deadline: performance.now() - 1 }), closing);
  const failure = await boundedRelayResult(closing.catch(error => error));
  assert.equal(failure.code, 'release_unconfirmed');
  assert.deepEqual(owned.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(owned.childClosed, false);
  owned.finishChild();
  assert.strictEqual(await owned.relay.close().catch(error => error), failure);
});

test('relay initially expired deadline stays unconfirmed when owned resources close next turn', async t => {
  const owned = await ownedRelayFixture(t, (signal, finish) => {
    if (signal === 'SIGTERM') queueMicrotask(() => finish(signal));
    return true;
  });
  const closing = owned.relay.close({ deadline: performance.now() - 1 });
  const failure = await boundedRelayResult(closing.catch(error => error));
  assert.equal(failure.code, 'release_unconfirmed');
  await waitUntil(() => owned.childClosed && !owned.relay.server.listening);
  assert.strictEqual(await owned.relay.close().catch(error => error), failure,
    'prompt late close does not undo an already-expired caller cutoff');
});

test('relay pre-aborted close rejects without exposing the caller reason or waiting for exit', async t => {
  const owned = await ownedRelayFixture(t);
  const controller = new AbortController();
  controller.abort(new Error('synthetic private cancellation diagnostic'));
  const closing = owned.relay.close({ signal: controller.signal, timeoutMs: 2000 });
  const failure = await boundedRelayResult(closing.catch(error => error));
  assert.equal(failure.code, 'release_unconfirmed');
  assert.equal(failure.message, 'Relay owned shutdown is unconfirmed');
  assert.equal(owned.childClosed, false);
  assert.deepEqual(owned.signals, ['SIGTERM', 'SIGKILL']);
  owned.finishChild();
  assert.strictEqual(owned.relay.close(), closing);
  assert.strictEqual(await closing.catch(error => error), failure);
});

test('relay listener callback stall has the same cutoff and refuses new input before late closure', async t => {
  const owned = await ownedRelayFixture(t, (signal, finish) => {
    if (signal === 'SIGTERM') queueMicrotask(() => finish(signal));
    return true;
  });
  const originalClient = await owned.connect();
  writeFrame(originalClient, { v: 1, kind: 'open', id: 'before-close', target: 'desktop' });
  await waitUntil(() => owned.packets.length === 1);
  const held = owned.holdListener();
  const closing = owned.relay.close({ timeoutMs: 40 });
  await waitUntil(() => held.calls === 1 && owned.childClosed);
  const successor = await owned.connect();
  const refused = successor.destroyed ? Promise.resolve() : new Promise(resolve => successor.once('close', resolve));
  // The intentionally stalled local listener still accepts at the OS level;
  // the relay must destroy that connection without forwarding its input.
  successor.write(JSON.stringify({ v: 1, kind: 'execute', id: 'successor',
    actions: [{ action: 'click', x: 1, y: 1 }] }) + '\n');
  await boundedRelayResult(refused);
  assert.equal(owned.packets.length, 1);
  const failure = await boundedRelayResult(closing.catch(error => error));
  assert.equal(failure.code, 'release_unconfirmed');
  assert.equal(held.calls, 1, 'one listener close remains owned across later callers');
  assert.deepEqual(owned.signals, ['SIGTERM'], 'a drained child is never signalled again');
  await boundedRelayResult(held.release());
  assert.strictEqual(owned.relay.close(), closing);
  assert.strictEqual(await closing.catch(error => error), failure);
  assert.equal(owned.packets.length, 1, 'late cleanup cannot replay the rejected successor');
});

test('relay later caller cancellation interrupts an already pending listener retirement', async t => {
  const owned = await ownedRelayFixture(t, (signal, finish) => {
    if (signal === 'SIGTERM') queueMicrotask(() => finish(signal));
    return true;
  });
  const held = owned.holdListener();
  const closing = owned.relay.close({ timeoutMs: 2000 });
  await waitUntil(() => held.calls === 1 && owned.childClosed);
  const controller = new AbortController();
  assert.strictEqual(owned.relay.close({ signal: controller.signal, timeoutMs: 2000 }), closing);
  controller.abort(new Error('synthetic private abort detail'));
  const failure = await boundedRelayResult(closing.catch(error => error));
  assert.equal(failure.code, 'release_unconfirmed');
  assert.equal(failure.message, 'Relay owned shutdown is unconfirmed');
  assert.deepEqual(owned.signals, ['SIGTERM']);
  await boundedRelayResult(held.release());
  assert.strictEqual(await owned.relay.close().catch(error => error), failure);
});

test('relay refused and throwing child termination remains unconfirmed after late drained close', async t => {
  const owned = await ownedRelayFixture(t, signal => {
    if (signal === 'SIGKILL') throw new Error('synthetic private signal diagnostic');
    return false;
  });
  const closing = owned.relay.close({ timeoutMs: 40 });
  const failure = await boundedRelayResult(closing.catch(error => error));
  assert.equal(failure.code, 'release_unconfirmed');
  assert.equal(failure.message, 'Relay owned shutdown is unconfirmed');
  assert.equal(owned.childClosed, false);
  assert.equal(owned.child.listenerCount('close'), 1, 'late owned closure stays observed');
  assert.deepEqual(owned.signals, ['SIGTERM', 'SIGKILL']);
  owned.finishChild();
  assert.equal(owned.child.listenerCount('close'), 0, 'the actual late close is recorded');
  assert.strictEqual(await owned.relay.close().catch(error => error), failure);
  assert.deepEqual(owned.signals, ['SIGTERM', 'SIGKILL']);
});

test('relay child exit without drained close cannot confirm retirement or invite further signals', async t => {
  const owned = await ownedRelayFixture(t);
  const closing = owned.relay.close({ timeoutMs: 40 });
  owned.child.signalCode = 'SIGTERM';
  owned.child.emit('exit', null, 'SIGTERM');
  const failure = await boundedRelayResult(closing.catch(error => error));
  assert.equal(failure.code, 'release_unconfirmed');
  assert.equal(owned.childClosed, false);
  assert.deepEqual(owned.signals, ['SIGTERM'], 'known exit prevents signalling a possibly reused PID');
  owned.finishChild('SIGTERM');
  assert.strictEqual(await owned.relay.close().catch(error => error), failure);
});

test('relay bridge failure shares retirement with later caller cutoffs and preserves sanitized error', async t => {
  const owned = await ownedRelayFixture(t);
  owned.child.stdin.emit('error', Object.assign(new Error('synthetic private SSH pipe diagnostic'), { code: 'EPIPE' }));
  await assert.rejects(owned.relay.failure, error =>
    error.message === 'Fruitctl SSH bridge lost; input was not replayed');
  const closing = owned.relay.close({ timeoutMs: 40 });
  assert.strictEqual(owned.relay.close({ timeoutMs: 2000 }), closing);
  const failure = await boundedRelayResult(closing.catch(error => error));
  assert.equal(failure.code, 'release_unconfirmed');
  assert.deepEqual(owned.signals, ['SIGTERM', 'SIGKILL']);
  owned.finishChild();
  assert.strictEqual(await owned.relay.close().catch(error => error), failure);
});

test('relay server errors after startup fail safely and interrupt pending owned retirement', async t => {
  const owned = await ownedRelayFixture(t);
  assert.doesNotThrow(() => owned.relay.server.emit('error', new Error('synthetic private listener diagnostic')));
  await assert.rejects(owned.relay.failure, error =>
    error.message === 'Fruitctl SSH bridge lost; input was not replayed');
  const closing = owned.relay.close({ timeoutMs: 2000 });
  assert.doesNotThrow(() => owned.relay.server.emit('error', new Error('synthetic in-flight listener diagnostic')));
  const failure = await boundedRelayResult(closing.catch(error => error));
  assert.equal(failure.code, 'release_unconfirmed');
  assert.deepEqual(owned.signals, ['SIGTERM', 'SIGKILL']);
  assert.doesNotThrow(() => owned.relay.server.emit('error', new Error('synthetic later listener diagnostic')));
  owned.finishChild();
  assert.strictEqual(await owned.relay.close().catch(error => error), failure);
});

test('relay unknown listener close error is sanitized and cannot be revised by child closure', async t => {
  const owned = await ownedRelayFixture(t);
  const originalClose = owned.relay.server.close.bind(owned.relay.server);
  owned.relay.server.close = callback => originalClose(() =>
    callback(new Error('synthetic private listener diagnostic')));
  const closing = owned.relay.close({ timeoutMs: 2000 });
  const failure = await boundedRelayResult(closing.catch(error => error));
  assert.equal(failure.code, 'release_unconfirmed');
  assert.equal(failure.message, 'Relay owned shutdown is unconfirmed');
  assert.deepEqual(owned.signals, ['SIGTERM', 'SIGKILL']);
  owned.finishChild();
  assert.strictEqual(await owned.relay.close().catch(error => error), failure);
});

test('relay bind failure preserves its primary cause when owned child cleanup is unconfirmed', async t => {
  const { directory } = await fixture();
  const socketPath = path.join(directory, 'startup.sock');
  const signals = [];
  let child;
  t.after(async () => {
    if (child) {
      child.signalCode = 'SIGKILL';
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', null, 'SIGKILL');
      child.emit('close', null, 'SIGKILL');
      assert.equal(child.listenerCount('close'), 0, 'late startup child close stays observed');
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const startup = createRelay({
    socketPath, bridge: 'fixture@darwin',
    spawnSSH: () => {
      writeFileSync(socketPath, 'intervening fixture', { mode: 0o600 });
      child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = signal => { signals.push(signal); return false; };
      return child;
    },
  });
  const failure = await boundedRelayResult(startup.catch(error => error), 2500);
  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.code, 'release_unconfirmed');
  assert.equal(failure.message, 'Fruitctl SSH bridge startup cleanup is unconfirmed');
  assert.equal(failure.cause.code, 'EADDRINUSE');
  assert.strictEqual(failure.errors[0], failure.cause);
  assert.equal(failure.errors[1].code, 'release_unconfirmed');
  assert.deepEqual(errorRecord(failure), {
    message: 'Fruitctl SSH bridge startup cleanup is unconfirmed', code: 'release_unconfirmed',
  }, 'public error output does not expose the bind path or local nested errors');
  assert.equal(child.listenerCount('close'), 1, 'a deadline is not owned child close');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});
