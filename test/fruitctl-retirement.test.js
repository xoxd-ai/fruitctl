// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeExecutor } from '../lib/mcp/native.js';
import { TargetLane, createBroker } from '../lib/broker/server.mjs';
import { retirementDeadline, RETIREMENT_TIMEOUT_MS } from '../lib/deadlines.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

function nativeFixture({ now = () => performance.now(), exited = false } = {}) {
  const exit = deferred();
  const signals = [], writes = [];
  const child = {
    exitCode: exited ? 0 : null, signalCode: null,
    stdin: { writable: true, write: frame => writes.push(frame) },
    kill(name) { signals.push({ child: this, name }); return true; },
  };
  const executor = Object.create(NativeExecutor.prototype);
  Object.assign(executor, { now, child, closed: exit.promise, pending: new Map(),
    tail: Promise.resolve(), isReady: true, terminal: false, rejectReady() {},
    parser: { stop() {} } });
  return { executor, child, exit, signals, writes };
}

function traceClose(executor) {
  const calls = [], close = executor.close.bind(executor);
  executor.close = options => { calls.push(options); return close(options); };
  return calls;
}

test('retirement inherits a monotonic cutoff and refuses malformed budgets', () => {
  assert.equal(retirementDeadline({ now: 1000 }), 1000 + RETIREMENT_TIMEOUT_MS);
  assert.equal(retirementDeadline({ now: 1010, timeoutMs: 100, deadline: 1050 }), 1050);
  assert.equal(retirementDeadline({ now: 1051, deadline: 1050 }), 1050, 'expiry cannot grant new time');
  for (const timeoutMs of [0, -1, NaN, Infinity, 30001]) {
    assert.throws(() => retirementDeadline({ timeoutMs }), /Invalid retirement deadline/);
  }
  assert.throws(() => retirementDeadline({ deadline: Infinity }), /Invalid retirement deadline/);
});

test('native close bounds a child that ignores signals and retains its late actual closure', { timeout: 1500 }, async () => {
  const { executor, child, exit, signals } = nativeFixture();
  let pendingError;
  executor.pending.set('owned', { reject: error => { pendingError = error; } });
  const began = performance.now();
  const closing = executor.close({ graceful: false, timeoutMs: 40 });
  assert.equal(executor.isReady, false);
  assert.equal(executor.terminal, true);
  assert.ok(pendingError);
  assert.equal(executor.pending.size, 0);
  await assert.rejects(executor.request({ action: 'key_tap', key: 'tab' }), /Daemon not ready/);
  let failure;
  await assert.rejects(closing, error => { failure = error; return error.code === 'release_unconfirmed'; });
  assert.ok(performance.now() - began < 500, 'caller cannot await an unresponsive child indefinitely');
  assert.deepEqual(signals.map(value => value.name), ['SIGTERM', 'SIGKILL']);
  assert.ok(signals.every(value => value.child === child), 'only the recorded direct child is signalled');
  assert.notEqual(executor.closeState.closedObserved, true, 'successful kill calls are not close-event proof');
  exit.resolve();
  await executor.closed;
  await delay(0);
  assert.equal(executor.closeState.closedObserved, true);
  assert.equal(executor.closeState.failure, failure);
  assert.equal(executor.close(), closing, 'late closure does not erase the recorded failure');
  await assert.rejects(closing, error => error === failure);
});

test('native close bounds undrained pipes after exit without signalling the exited child', { timeout: 1500 }, async () => {
  const { executor, exit, signals } = nativeFixture({ exited: true });
  const closing = executor.close({ timeoutMs: 30 });
  await assert.rejects(closing, /Native owned exit unconfirmed/);
  assert.deepEqual(signals, [], 'an exited PID must never be signalled while its streams drain');
  exit.resolve();
  await executor.closed;
  await delay(0);
  assert.equal(executor.closeState.closedObserved, true);
  await assert.rejects(executor.close(), /unconfirmed/);
});

test('native close shares one cutoff and refuses a late event before a delayed timer callback', async () => {
  let now = 1000;
  const { executor, exit, writes } = nativeFixture({ now: () => now });
  const first = executor.close({ timeoutMs: 100 });
  now = 1005;
  assert.equal(executor.close({ timeoutMs: 200 }), first);
  assert.equal(executor.closeState.deadline, 1100, 'another caller cannot restart the grace');
  assert.equal(executor.close({ timeoutMs: 20 }), first);
  assert.equal(executor.closeState.deadline, 1025);
  assert.equal(writes.length, 1, 'shutdown is sent only once');
  now = 1026;
  exit.resolve();
  await assert.rejects(first, /unconfirmed/);
});

test('native close cancellation force-retires once without another shutdown or admission', async () => {
  const { executor, exit, signals, writes } = nativeFixture();
  const controller = new AbortController();
  const closing = executor.close({ signal: controller.signal });
  controller.abort();
  await assert.rejects(closing, /unconfirmed/);
  assert.equal(executor.close({ graceful: false }), closing);
  assert.equal(writes.length, 1);
  assert.deepEqual(signals.map(value => value.name), ['SIGTERM', 'SIGKILL']);
  exit.resolve();
  await executor.closed;
});

test('an expired or already-cancelled native close sends no fresh graceful shutdown', async () => {
  for (const cancelled of [false, true]) {
    const { executor, exit, writes, signals } = nativeFixture({ now: () => 1000 });
    const controller = new AbortController();
    if (cancelled) controller.abort();
    const closing = executor.close({ signal: controller.signal, ...(cancelled ? {} : { deadline: 999 }) });
    await assert.rejects(closing, /unconfirmed/);
    assert.deepEqual(writes, []);
    assert.deepEqual(signals.map(value => value.name), ['SIGTERM', 'SIGKILL']);
    exit.resolve();
    await executor.closed;
  }
});

test('confirmed native close remains reusable as a receipt without repeating termination', async () => {
  const { executor, child, exit, signals, writes } = nativeFixture();
  const closing = executor.close();
  child.exitCode = 0;
  exit.resolve();
  await closing;
  assert.equal(executor.close(), closing);
  await executor.close();
  assert.equal(writes.length, 1);
  assert.deepEqual(signals, []);
  assert.equal(executor.closeState.failure, undefined);
});

test('idle retirement blocks new work immediately and keeps timeout sticky after late cleanup', { timeout: 1500 }, async t => {
  const retiring = deferred(), finishRelease = deferred(), finishClose = deferred();
  let executions = 0, closes = 0;
  const executor = {
    async execute() { executions++; return [{ result: { detail: 'owned fixture' } }]; },
    async release() { retiring.resolve(); await finishRelease.promise; },
    async close({ graceful } = {}) { closes++; assert.equal(graceful, false); await finishClose.promise; },
  };
  const lane = new TargetLane({}, async () => executor, { idleMs: 1, retirementMs: 40 });
  lane.acquire('owner');
  t.after(async () => {
    finishRelease.resolve(); finishClose.resolve();
    await lane.forcedClose;
    await assert.rejects(lane.close(), /unconfirmed/);
  });
  await lane.execute([{ action: 'health' }]);
  await retiring.promise;
  // Typed and pre-admission: the idle close keeps the owner's lease.
  assert.throws(() => lane.acquire('owner'), { code: 'target_idle_retiring' });
  await assert.rejects(lane.execute([{ action: 'key_tap', key: 'tab' }]), { code: 'target_idle_retiring' });
  await lane.tail;
  const sticky = lane.cleanupFailure;
  assert.equal(sticky.code, 'release_unconfirmed');
  assert.equal(lane.executor, executor, 'an unconfirmed executor remains recorded');
  assert.equal(lane.owner, 'owner');
  assert.equal(executions, 1);
  assert.equal(closes, 1);
  finishRelease.resolve(); finishClose.resolve();
  await lane.forcedClose;
  await delay(0);
  assert.equal(lane.cleanupFailure, sticky);
  assert.throws(() => lane.acquire('successor'), error => error === sticky);
  assert.equal(closes, 1, 'late release cannot send another close or clear uncertainty');
});

test('healthy idle retirement shares release and close budget then permits the same owner again', { timeout: 1500 }, async t => {
  const retiring = deferred(), finishRelease = deferred();
  let deadline, releaseBudget, executions = 0, closes = 0;
  const lane = new TargetLane({}, async () => ({
    async execute() { executions++; return []; },
    async release({ timeoutMs }) { releaseBudget = timeoutMs; retiring.resolve(); await finishRelease.promise; },
    async close(options) { closes++; deadline = options.deadline; },
  }), { idleMs: 1, retirementMs: 200 });
  lane.acquire('owner');
  t.after(async () => { finishRelease.resolve(); await lane.close(); });
  await lane.execute([{ action: 'health' }]);
  await retiring.promise;
  const originalDeadline = lane.idleDeadline;
  assert.throws(() => lane.acquire('owner'), { code: 'target_idle_retiring' });
  finishRelease.resolve();
  await lane.tail;
  assert.ok(releaseBudget > 0 && releaseBudget <= 200);
  assert.equal(deadline, originalDeadline);
  assert.equal(closes, 1);
  assert.equal(lane.executor, null);
  assert.equal(lane.cleanupFailure, undefined);
  lane.acquire('owner');
  await lane.execute([{ action: 'health' }]);
  assert.equal(executions, 2);
});

test('lane close bounds the existing tail and retains forced closure after timeout', { timeout: 1500 }, async () => {
  const finishTail = deferred(), finishClose = deferred();
  const calls = [];
  const lane = new TargetLane({});
  const executor = { async close(options) { calls.push(options); await finishClose.promise; } };
  lane.executor = executor;
  lane.tail = finishTail.promise;
  lane.acquire('owner');
  const closing = lane.close({ timeoutMs: 40 });
  assert.equal(lane.closed, true);
  assert.throws(() => lane.acquire('owner'), /releasing/);
  await assert.rejects(lane.execute([{ action: 'key_tap', key: 'tab' }]), /lane closed/);
  let failure;
  await assert.rejects(closing, error => { failure = error; return error.code === 'release_unconfirmed'; });
  assert.equal(lane.executor, executor);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].graceful, false);
  assert.equal(calls[0].deadline, lane.closeDeadline, 'forced retirement gets no fresh deadline');
  assert.equal(lane.close(), closing);
  finishTail.resolve(); finishClose.resolve();
  await lane.forcedClose;
  await delay(0);
  assert.equal(lane.cleanupFailure, failure);
  assert.equal(calls.length, 1);
  await assert.rejects(lane.close(), error => error === failure);
});

test('lane close shares one budget across release and close and rejects late success', async t => {
  let now = 1000, nativeDeadline;
  t.mock.method(performance, 'now', () => now);
  const lane = new TargetLane({});
  lane.executor = {
    async release({ timeoutMs }) { assert.equal(timeoutMs, 50); now += 30; },
    async close({ graceful, deadline }) {
      if (graceful === false) return;
      nativeDeadline = deadline;
      now += 21;
    },
  };
  await assert.rejects(lane.close({ timeoutMs: 50 }), /unconfirmed/);
  assert.equal(nativeDeadline, 1050, 'native cleanup inherits the original cutoff');
  assert.equal(lane.executorRetirementDeadline, 1050);
  assert.ok(lane.executorClosing, 'late owned close remains recorded');
  assert.ok(lane.forcedClose);
});

test('a shorter lane close does not restart cleanup or accept delayed confirmation', async t => {
  let now = 1000, closes = 0;
  t.mock.method(performance, 'now', () => now);
  const finishTail = deferred();
  const lane = new TargetLane({});
  lane.tail = finishTail.promise;
  lane.executor = { async close() { closes++; } };
  const first = lane.close({ timeoutMs: 100 });
  now += 5;
  assert.equal(lane.close({ timeoutMs: 20 }), first);
  assert.equal(lane.closeDeadline, 1025);
  now = 1026;
  finishTail.resolve();
  await assert.rejects(first, /unconfirmed/);
  await lane.forcedClose;
  assert.equal(closes, 1);
});

test('lane close cancellation returns without awaiting an uncooperative owned close', async () => {
  const finishTail = deferred(), finishClose = deferred();
  const lane = new TargetLane({});
  lane.tail = finishTail.promise;
  lane.executor = { async close() { await finishClose.promise; } };
  const controller = new AbortController();
  const closing = lane.close({ signal: controller.signal });
  controller.abort();
  await assert.rejects(closing, /unconfirmed/);
  assert.ok(lane.forcedClose);
  finishTail.resolve(); finishClose.resolve();
  await lane.forcedClose;
});

test('early lane cancellation immediately force-retires its exact owned native child', async t => {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const owned = nativeFixture({ now: () => now }), calls = traceClose(owned.executor);
  const finishTail = deferred(), lane = new TargetLane({});
  lane.executor = owned.executor;
  lane.tail = finishTail.promise;
  lane.acquire('owner');
  t.after(async () => {
    finishTail.resolve(); owned.exit.resolve();
    await owned.executor.closed;
    await delay(0);
    assert.equal(owned.executor.closeState.closedObserved, true);
    assert.equal(lane.cleanupFailure.code, 'release_unconfirmed');
    assert.throws(() => lane.acquire('successor'), /unconfirmed/);
  });
  const controller = new AbortController();
  const closing = lane.close({ signal: controller.signal, timeoutMs: 2000 });
  controller.abort();
  await assert.rejects(closing, /unconfirmed/);
  await assert.rejects(lane.forcedClose, /Native owned exit unconfirmed/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].deadline, 3000);
  assert.equal(calls[0].signal.aborted, true, 'early abort must reach native retirement, not grant the remaining 2s');
  assert.deepEqual(owned.signals.map(value => value.name), ['SIGTERM', 'SIGKILL']);
  assert.ok(owned.signals.every(value => value.child === owned.child));
  assert.notEqual(owned.executor.closeState.closedObserved, true, 'signals are not a drained close event');
});

test('a shorter lane close updates pending forced retirement without replacing owned tracking', async t => {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const owned = nativeFixture({ now: () => now }), calls = traceClose(owned.executor);
  const finishTail = deferred(), lane = new TargetLane({});
  lane.executor = owned.executor;
  lane.tail = finishTail.promise;
  lane.acquire('owner');
  const failure = lane.recordCleanupFailure(3000), original = lane.forcedClose;
  await Promise.resolve();
  const nativeClosing = owned.executor.closing;
  t.after(async () => {
    finishTail.resolve(); owned.exit.resolve();
    await owned.executor.closed;
    await delay(0);
    assert.equal(lane.forcedClose, original);
    assert.equal(lane.cleanupFailure, failure);
    assert.equal(owned.executor.closeState.closedObserved, true);
    assert.throws(() => lane.acquire('successor'), error => error === failure);
  });
  now = 1005;
  const controller = new AbortController();
  const closing = lane.close({ signal: controller.signal, timeoutMs: 40 });
  await Promise.resolve();
  assert.equal(lane.forcedClose, original);
  assert.equal(owned.executor.closing, nativeClosing);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].deadline, 1045);
  assert.equal(owned.executor.closeState.deadline, 1045);
  controller.abort();
  await assert.rejects(closing, error => error === failure);
  await assert.rejects(original, /Native owned exit unconfirmed/);
  await assert.rejects(lane.forcedCloseUpdate, /Native owned exit unconfirmed/);
  now = 1006;
  assert.equal(lane.close({ timeoutMs: 10 }), closing, 'a settled sticky result retains its original promise');
  await assert.rejects(lane.forcedCloseUpdate, /Native owned exit unconfirmed/);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].deadline, 1016, 'shortening still reaches owned retirement after lane failure');
  assert.equal(calls[2].signal.aborted, true);
  assert.equal(lane.forcedClose, original);
  assert.deepEqual(owned.signals.map(value => value.name), ['SIGTERM', 'SIGKILL']);
  assert.notEqual(owned.executor.closeState.closedObserved, true);
});

test('repeated shorter broker close reaches a stalled lane and its exact owned native child', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shorter-'));
  await fs.chmod(directory, 0o700);
  const broker = await createBroker({ socketPath: path.join(directory, 's'), config: { targets: { desktop: {} } } });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const owned = nativeFixture({ now: () => now }), calls = traceClose(owned.executor);
  const finishTail = deferred(), lane = broker.lanes.get('desktop');
  lane.executor = owned.executor;
  lane.tail = finishTail.promise;
  lane.acquire('owner');
  let closing;
  t.after(async () => {
    finishTail.resolve(); owned.exit.resolve();
    await owned.executor.closed;
    await delay(0);
    assert.equal(owned.executor.closeState.closedObserved, true);
    assert.equal(lane.cleanupFailure.code, 'release_unconfirmed');
    assert.throws(() => lane.acquire('successor'), /unconfirmed/);
    await assert.rejects(closing, /unconfirmed/);
    await fs.rm(directory, { recursive: true });
  });
  closing = broker.close({ timeoutMs: 2000 });
  assert.equal(lane.closeDeadline, 3000);
  now = 1005;
  assert.equal(broker.close({ timeoutMs: 40 }), closing);
  assert.equal(lane.closeDeadline, 1045, 'broker shortening reaches the lane before its stalled tail can drain');
  now = 1046;
  assert.equal(broker.close({ timeoutMs: 40, deadline: 1045 }), closing);
  await assert.rejects(closing, /unconfirmed/);
  await assert.rejects(lane.forcedClose, /Native owned exit unconfirmed/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].deadline, 1045);
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(owned.signals.map(value => value.name), ['SIGTERM', 'SIGKILL']);
  assert.ok(owned.signals.every(value => value.child === owned.child));
  assert.notEqual(owned.executor.closeState.closedObserved, true);
  assert.equal(broker.server.listening, false);
});

test('broker teardown bounds all lanes together and never awaits late owned close after failure', { timeout: 1500 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'retire-'));
  await fs.chmod(directory, 0o700);
  const finishRelease = deferred(), finishClose = deferred();
  const broker = await createBroker({ socketPath: path.join(directory, 's'),
    config: { targets: { stalled: {}, healthy: {} } } });
  const stalled = broker.lanes.get('stalled'), healthy = broker.lanes.get('healthy');
  const events = [];
  stalled.executor = {
    async release() { await finishRelease.promise; },
    async close(options) { events.push(options); await finishClose.promise; },
  };
  healthy.executor = { async release() {}, async close() {} };
  t.after(async () => {
    finishRelease.resolve(); finishClose.resolve();
    await stalled.forcedClose;
    await fs.rm(directory, { recursive: true });
  });
  const began = performance.now();
  const closing = broker.close({ timeoutMs: 40 });
  assert.equal(broker.server.listening, false, 'listener admission stops synchronously');
  assert.equal(stalled.closed, true);
  assert.equal(healthy.closed, true);
  await assert.rejects(closing, error => error.code === 'release_unconfirmed');
  assert.ok(performance.now() - began < 500);
  assert.equal(healthy.executor, null);
  assert.equal(stalled.cleanupFailure.code, 'release_unconfirmed');
  assert.equal(events.length, 1);
  assert.equal(events[0].graceful, false);
  assert.equal(broker.close(), closing);
});

test('broker close also bounds an unconfirmed listener callback', { timeout: 1500 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'listener-'));
  await fs.chmod(directory, 0o700);
  const broker = await createBroker({ socketPath: path.join(directory, 's'), config: { targets: {} } });
  const close = broker.server.close.bind(broker.server);
  broker.server.close = () => close(); // Owned fixture deliberately loses the acknowledgement.
  t.after(() => fs.rm(directory, { recursive: true }));
  const closing = broker.close({ timeoutMs: 30 });
  await assert.rejects(closing, /Broker owned shutdown is unconfirmed/);
  assert.equal(broker.server.listening, false);
  assert.equal(broker.close(), closing);
});
