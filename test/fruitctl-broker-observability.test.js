// SPDX-License-Identifier: MIT
// D11 journal, D28 wake hold and D30 latency telemetry. Owned fakes only: no
// SSH, no VNC endpoint and no desktop is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker, TargetLane } from '../lib/broker/server.mjs';
import { BrokerExecutor } from '../lib/broker/client.mjs';
import { Journal, verifyJournal, redactParams, recordHash, GENESIS_HASH } from '../lib/broker/journal.mjs';
import { LatencyTelemetry, telemetryOptions, LATENCY_BUCKETS_SECONDS } from '../lib/broker/telemetry.mjs';
import { ActionObserver, brokerObservability } from '../lib/broker/observe.mjs';
import { WakeHold, wakeOptions, wakeArguments, typedFailure, DISPLAY_ASLEEP } from '../lib/broker/wake.mjs';
import { preAdmissionRefusal } from '../lib/mcp/capabilities.js';

const run = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '../bin/fruitctl.mjs');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function directory(t) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-obs-'));
  await fs.chmod(value, 0o700);
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}

async function lines(file) {
  return (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

function fakeExecutor({ fail, delayMs = 2 } = {}) {
  return { async execute(actions, { onResponse }) {
    const responses = [];
    for (const action of actions) {
      await delay(delayMs);
      if (fail && action.action === fail) {
        throw Object.assign(new Error('native transport lost'), { responses: [...responses] });
      }
      const result = action.action === 'screenshot'
        ? { image: PNG, scaledWidth: 2, scaledHeight: 1, provenance: { stream: 'owned', frame: 7 } }
        : action.action === 'health' ? { detail: 'connected' } : { detail: `${action.action} done` };
      const response = { id: responses.length, result };
      responses.push(response);
      onResponse?.(response);
    }
    return responses;
  }, async close() {} };
}

test('journal chains records, verifies and pinpoints tampering', async t => {
  const dir = path.join(await directory(t), 'journal');
  const session = '11111111-2222-4333-8444-555555555555';
  const journal = new Journal({ dir, now: () => new Date('2026-10-16T00:00:00Z') });
  await journal.append([1, 2, 3].map(index => ({ session, target: 'desktop', method: 'wait',
    params: { ms: index }, result: { outcome: 'ok' }, frame: null })));
  const file = path.join(dir, `${session}.jsonl`);
  const records = await lines(file);
  assert.deepEqual(records.map(record => record.seq), [1, 2, 3]);
  assert.equal(records[0].prev_hash, GENESIS_HASH);
  assert.equal(records[1].prev_hash, records[0].hash);
  assert.equal(recordHash(records[2]), records[2].hash);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(await verifyJournal(file), { ok: true, records: 3, head: records[2].hash, session });

  const original = await fs.readFile(file, 'utf8');
  const rows = original.trim().split('\n');
  const cases = {
    'record hash mismatch': rows.map((row, index) => index === 1 ? row.replace('"ms":2', '"ms":9') : row),
    'sequence gap or reorder': [rows[0], rows[2]],
    'previous hash mismatch': [rows[0], JSON.stringify({ ...records[2], seq: 2 })],
  };
  for (const [reason, tampered] of Object.entries(cases)) {
    await fs.writeFile(file, tampered.join('\n') + '\n');
    const result = await verifyJournal(file);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(result.line, 2);
  }
  await fs.writeFile(file, original.slice(0, -5));
  assert.equal((await verifyJournal(file)).reason, 'truncated final record');

  // A broken chain is never extended; the failure is recorded, not thrown.
  const resumed = new Journal({ dir });
  await resumed.append([{ session, target: 'desktop', method: 'wait', params: {}, result: { outcome: 'ok' } }]);
  assert.equal(resumed.failures, 1);
  assert.match(resumed.status().last_error, /fails verification/);
  // A verified chain continues from its head.
  await fs.writeFile(file, original);
  await resumed.append([{ session, target: 'desktop', method: 'wait', params: {}, result: { outcome: 'ok' } }]);
  const continued = await verifyJournal(file);
  assert.equal(continued.ok, true);
  assert.equal(continued.records, 4);
});

test('a failed append forgets its cached head and never extends a partial record', { skip: process.getuid?.() === 0 }, async t => {
  const dir = path.join(await directory(t), 'journal');
  const session = '22222222-3333-4444-8555-666666666666';
  const journal = new Journal({ dir });
  const entry = { session, target: 'desktop', method: 'wait', params: {}, result: { outcome: 'ok' } };
  await journal.append([entry]);
  const file = path.join(dir, `${session}.jsonl`);
  await fs.chmod(file, 0o400);
  await journal.append([entry]);
  assert.equal(journal.failures, 1);
  // Simulate the partial record a failed write can leave behind.
  await fs.chmod(file, 0o600);
  await fs.appendFile(file, '{"schema":"fruitctl.jour');
  await journal.append([entry]);
  assert.equal(journal.failures, 2);
  assert.match(journal.status().last_error, /fails verification/);
  assert.equal((await verifyJournal(file)).reason, 'truncated final record');
});

test('journal params never store type_secret text or credential-like fields', () => {
  assert.deepEqual(redactParams({ action: 'type_secret', ref: 'login', text: 'hunter2', value: 'x' }),
    { ref: 'login', text: '[redacted]', value: '[redacted]' });
  // A refused request may carry the value in a kept field; only the expected shape survives.
  assert.deepEqual(redactParams({ action: 'type_secret', ref: 'login', x: 'hunter2', y: 4, provider: 'hunter2',
    length_class: 'hunter2' }), { ref: 'login', x: '[redacted]', y: 4, provider: '[redacted]', length_class: '[redacted]' });
  assert.deepEqual(redactParams({ action: 'type_secret', ref: 'hunter 2!', x: 1, y: 2, provider: 'file', length_class: '9-16' }),
    { ref: '[redacted]', x: 1, y: 2, provider: 'file', length_class: '9-16' });
  assert.deepEqual(redactParams({ action: 'configure', password: 'p', apiKey: 'k', nested: { authToken: 't', ok: 1 } }),
    { password: '[redacted]', apiKey: '[redacted]', nested: { authToken: '[redacted]', ok: 1 } });
  // A keyboard key is not a credential.
  assert.deepEqual(redactParams({ action: 'key_tap', key: 'enter' }), { key: 'enter' });
  assert.equal(redactParams({ action: 'key_type', text: 'x'.repeat(400) }).text.length, 256);
});

test('lane journal records each action with frame hash, provenance and redaction', async t => {
  const dir = path.join(await directory(t), 'journal');
  const journal = new Journal({ dir });
  const observer = new ActionObserver({ journal });
  const lane = new TargetLane({}, async () => fakeExecutor(), { name: 'desktop', observer });
  t.after(() => lane.close());
  const owner = '0a0a0a0a-0b0b-4c0c-8d0d-0e0e0e0e0e0e';
  lane.acquire(owner);
  const responses = await lane.execute([{ action: 'screenshot' },
    { action: 'configure', api_key: 'do-not-store' }, { action: 'mouse_click', x: 1, y: 2 }]);
  assert.equal(responses[0].result.image, PNG, 'the returned frame is unchanged');
  await observer.flush();
  const file = path.join(dir, `${owner}.jsonl`);
  const records = await lines(file);
  assert.deepEqual(records.map(record => [record.method, record.result.outcome]),
    [['screenshot', 'ok'], ['configure', 'ok'], ['mouse_click', 'ok']]);
  assert.equal(records[0].frame_sha256, sha256(Buffer.from(PNG, 'base64')));
  assert.deepEqual(records[0].provenance, { stream: 'owned', frame: 7 });
  assert.equal(records[0].target, 'desktop');
  assert.equal(records[0].session, owner);
  assert.deepEqual(records[1].params, { api_key: '[redacted]' });
  assert.deepEqual(records[2].params, { x: 1, y: 2 });
  assert.ok(!(await fs.readFile(file, 'utf8')).includes('do-not-store'));
  assert.ok(!(await fs.readFile(file, 'utf8')).includes(PNG));
  assert.equal((await verifyJournal(file)).ok, true);
});

test('failed and refused batches are journalled without claiming unrun input', async t => {
  const dir = path.join(await directory(t), 'journal');
  const observer = new ActionObserver({ journal: new Journal({ dir }) });
  const failing = new TargetLane({}, async () => fakeExecutor({ fail: 'mouse_click' }),
    { name: 'desktop', observer });
  t.after(() => failing.close());
  await assert.rejects(failing.execute([{ action: 'wait' }, { action: 'mouse_click', x: 0, y: 0 },
    { action: 'key_tap', key: 'enter' }]), /native transport lost/);
  const refusing = new TargetLane({}, async () => ({ ...fakeExecutor(),
    preflight() { throw preAdmissionRefusal('Action unavailable on native backend'); } }),
  { name: 'other', observer });
  t.after(() => refusing.close());
  await assert.rejects(refusing.execute([{ action: 'mouse_click', x: 0, y: 0 }]), /unavailable/);
  await observer.flush();
  const files = (await fs.readdir(dir)).sort();
  assert.equal(files.length, 2);
  const outcomes = [];
  for (const file of files) {
    const records = await lines(path.join(dir, file));
    outcomes.push(...records.map(record => `${record.target}:${record.method}:${record.result.outcome}`));
    assert.equal((await verifyJournal(path.join(dir, file))).ok, true);
  }
  assert.deepEqual(outcomes.sort(), ['desktop:key_tap:not_run', 'desktop:mouse_click:failed',
    'desktop:wait:ok', 'other:mouse_click:refused']);
});

test('telemetry writes per-action JSONL, rotates by size and renders a Prometheus summary atomically', async t => {
  const dir = path.join(await directory(t), 'metrics');
  assert.equal(telemetryOptions(undefined), null);
  assert.equal(telemetryOptions({ enabled: false, dir: '/x' }), null);
  assert.throws(() => telemetryOptions({ dir: 'relative' }), /absolute/);
  const telemetry = new LatencyTelemetry({ dir, maxBytes: 4096, keep: 2 });
  const observer = new ActionObserver({ telemetry });
  const lane = new TargetLane({}, async () => fakeExecutor(), { name: 'pzm-desk', observer });
  t.after(() => lane.close());
  await lane.execute([{ action: 'screenshot' }, { action: 'mouse_click', x: 1, y: 1 },
    { action: 'Not A Label!' }]);
  await observer.flush();
  const samples = await lines(path.join(dir, 'latency.jsonl'));
  assert.deepEqual(samples.map(sample => [sample.method, sample.route, sample.outcome]),
    [['screenshot', 'raw', 'ok'], ['mouse_click', 'raw', 'ok'], ['Not A Label!', 'raw', 'ok']]);
  assert.ok(samples.every(sample => sample.latency_ms >= 0 && !sample.estimated));
  assert.ok(samples[0].queue_ms >= 0);
  const prom = await fs.readFile(path.join(dir, 'fruitctl.prom'), 'utf8');
  assert.match(prom, /^fruitctl_actions_total\{target="pzm-desk",method="screenshot",route="raw",outcome="ok"\} 1$/m);
  assert.match(prom, /fruitctl_actions_total\{target="pzm-desk",method="other",route="raw",outcome="ok"\} 1/);
  assert.match(prom, /fruitctl_action_latency_seconds_bucket\{target="pzm-desk",method="screenshot",route="raw",outcome="ok",le="\+Inf"\} 1/);
  assert.equal(prom.match(/method="mouse_click".*le="/g).length, LATENCY_BUCKETS_SECONDS.length + 1);
  assert.match(prom, /# TYPE fruitctl_action_latency_seconds histogram/);

  for (let index = 0; index < 60; index++) {
    telemetry.record([{ session: 's', target: 'pzm-desk', method: 'wait', route: 'raw',
      outcome: 'ok', latencyMs: index }]);
  }
  await telemetry.flush();
  const names = (await fs.readdir(dir)).sort();
  assert.deepEqual(names, ['fruitctl.prom', 'latency.jsonl', 'latency.jsonl.1', 'latency.jsonl.2']);
  for (const name of names.filter(name => name.startsWith('latency'))) {
    assert.ok((await fs.stat(path.join(dir, name))).size <= 4096);
  }
  assert.match(await fs.readFile(path.join(dir, 'fruitctl.prom'), 'utf8'),
    /fruitctl_action_latency_seconds_count\{target="pzm-desk",method="wait",route="raw",outcome="ok"\} 60/);
  assert.equal(telemetry.failures, 0);
});

test('telemetry caps distinct method labels', async t => {
  const telemetry = new LatencyTelemetry({ dir: path.join(await directory(t), 'metrics') });
  for (let index = 0; index < 100; index++) {
    telemetry.observe({ target: 'desk', method: `m${index}`, route: 'raw', outcome: 'refused', latencyMs: 1 });
  }
  const methods = new Set([...telemetry.series.values()].map(series => series.labels.method));
  assert.equal(methods.size, 65);
  assert.ok(methods.has('other'));
  assert.ok(methods.has('m63') && !methods.has('m64'));
});

test('broker observability defaults the journal on and telemetry off', async t => {
  const stateDir = await directory(t);
  const defaults = brokerObservability({ targets: {} }, { stateDir });
  assert.equal(defaults.journal.dir, path.join(stateDir, 'journal'));
  assert.equal(defaults.telemetry, null);
  const off = brokerObservability({ targets: {}, journal: { enabled: false },
    telemetry: { dir: path.join(stateDir, 'metrics') } }, { stateDir });
  assert.equal(off.journal, null);
  assert.equal(off.telemetry.dir, path.join(stateDir, 'metrics'));
  assert.throws(() => brokerObservability({ journal: { dir: 'relative' } }, { stateDir }), /journal/);
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.signals = [];
    this.stdin = new EventEmitter();
  }
  kill(signal) {
    this.signals.push(signal);
    setImmediate(() => this.emit('exit', null, signal));
    return true;
  }
}

test('wake profile validation and fixed SSH argv', () => {
  assert.equal(wakeOptions(undefined), null);
  assert.equal(wakeOptions({ ssh: 'op@mac', enabled: false }), null);
  assert.deepEqual(wakeOptions({ ssh: 'op@mac' }), { ssh: 'op@mac' });
  for (const bad of [{ ssh: '-oProxyCommand=x' }, { ssh: 'op@mac; rm' }, { enabled: true }, { ssh: 'a', enabled: 'yes' }, []]) {
    assert.throws(() => wakeOptions(bad), /wake/i);
  }
  const args = wakeArguments('op@mac');
  assert.deepEqual(args.slice(-5), ['--', 'op@mac', 'caffeinate', '-d', '-u']);
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('-tt'));
});

test('lease holds one caffeinate child and hangs it up on lease end and shutdown', async t => {
  const children = [];
  const spawned = [];
  const wakeSpawn = args => { spawned.push(args); const child = new FakeChild(); children.push(child); return child; };
  const lane = new TargetLane({ wake: { ssh: 'op@mac' } }, async () => fakeExecutor(), { wakeSpawn, name: 'mac' });
  const owner = 'owner-a';
  lane.acquire(owner);
  lane.acquire(owner);
  assert.equal(children.length, 1, 'renewal keeps the same hold');
  assert.equal(spawned[0].at(-4), 'op@mac');
  const [health] = await lane.execute([{ action: 'health' }]);
  assert.deepEqual(health.result.wake, { configured: true, state: 'holding', failures: 0 });
  await lane.release(owner);
  await delay(5);
  assert.deepEqual(children[0].signals, ['SIGTERM']);
  assert.equal(lane.wake.status().state, 'idle');
  assert.equal(lane.wake.status().last_stop, 'lease_end');
  lane.acquire('owner-b');
  assert.equal(children.length, 2);
  await lane.close();
  await delay(5);
  assert.deepEqual(children[1].signals, ['SIGTERM']);
  assert.equal(lane.wake.status().last_stop, 'shutdown');
  t.after(() => lane.close());
});

test('wake failures are logged and reported in health, never fatal', async t => {
  const logs = [];
  let attempts = 0;
  const lane = new TargetLane({ wake: { ssh: 'op@mac' } }, async () => fakeExecutor(), {
    log: message => logs.push(message),
    wakeSpawn: () => {
      attempts++;
      const child = new FakeChild();
      setImmediate(() => child.emit('exit', 255, null));
      return child;
    } });
  t.after(() => lane.close());
  lane.acquire('owner');
  await delay(5);
  const [health] = await lane.execute([{ action: 'health' }]);
  assert.equal(health.result.detail, 'connected');
  assert.equal(health.result.wake.state, 'failed');
  assert.equal(health.result.wake.failures, 1);
  assert.match(health.result.wake.last_error, /code 255/);
  assert.match(logs[0], /wake hold for op@mac failed/);
  lane.acquire('owner');
  assert.equal(attempts, 1, 'a failed hold backs off instead of respawning per request');
  const thrown = new WakeHold({ ssh: 'op@mac', spawnImpl: () => { throw new Error('ENOENT'); } });
  thrown.ensure();
  assert.equal(thrown.status().state, 'failed');
});

test('display_asleep is a typed code that never overwrites cleanup failures', () => {
  const signalled = typedFailure(Object.assign(new Error('capture failed'), { code: -32010, data: { reason: DISPLAY_ASLEEP } }));
  assert.equal(signalled.code, DISPLAY_ASLEEP);
  const cleanup = typedFailure(Object.assign(new Error('x'), { code: 'release_unconfirmed', data: { reason: DISPLAY_ASLEEP } }));
  assert.equal(cleanup.code, 'release_unconfirmed');
  assert.equal(typedFailure(Object.assign(new Error('y'), { code: -32010, data: { reason: 'server_silent' } })).code, -32010);
});

test('display_asleep is typed with the journal and telemetry off', async t => {
  const lane = new TargetLane({}, async () => ({ async execute() {
    throw Object.assign(new Error('Display asleep'), { code: -32010, data: { reason: DISPLAY_ASLEEP }, responses: [] });
  }, async close() {} }), { name: 'desktop' });
  t.after(() => lane.close());
  assert.equal(lane.observer, null);
  await assert.rejects(lane.execute([{ action: 'screenshot' }]), error => error.code === DISPLAY_ASLEEP);
});

test('broker journals each client session and returns typed display_asleep', async t => {
  const dir = await directory(t);
  const socketPath = path.join(dir, 'broker.sock');
  const journal = new Journal({ dir: path.join(dir, 'journal') });
  const broker = await createBroker({ socketPath, journal, config: { targets: { desktop: {} } },
    factory: async () => ({ async execute(actions, { onResponse }) {
      if (actions[0].action === 'screenshot') {
        throw Object.assign(new Error('Display asleep'), { code: -32010, data: { reason: DISPLAY_ASLEEP }, responses: [] });
      }
      const response = { result: { detail: 'ok' } };
      onResponse?.(response);
      return [response];
    }, async close() {} }) });
  t.after(() => broker.close());
  const client = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(() => client.close());
  await client.opened;
  await client.execute([{ action: 'wait', ms: 1 }]);
  await assert.rejects(client.execute([{ action: 'screenshot' }]), error => error.code === DISPLAY_ASLEEP);
  await journal.flush();
  const [file] = await fs.readdir(path.join(dir, 'journal'));
  assert.match(file, /^[0-9a-f-]{36}\.jsonl$/);
  const records = await lines(path.join(dir, 'journal', file));
  assert.deepEqual(records.map(record => record.result.outcome), ['ok', 'failed']);
  assert.equal(records[1].result.error.code, DISPLAY_ASLEEP);
  assert.deepEqual(broker.status().journal, { dir: path.join(dir, 'journal'), failures: 0 });
});

test('broker rejects an invalid wake profile before opening its socket', async t => {
  const dir = await directory(t);
  const socketPath = path.join(dir, 'broker.sock');
  await assert.rejects(createBroker({ socketPath, config: { targets: { desktop: { wake: { ssh: '-oX' } } } } }), /wake/i);
  await assert.rejects(fs.lstat(socketPath), { code: 'ENOENT' });
});

test('fruitctl journal verify reports chain status and exit code', async t => {
  const dir = await directory(t);
  const session = '99999999-8888-4777-8666-555555555555';
  const journal = new Journal({ dir });
  await journal.append([{ session, target: 'desktop', method: 'wait', params: {}, result: { outcome: 'ok' } }]);
  const file = path.join(dir, `${session}.jsonl`);
  const { stdout } = await run(process.execPath, [cli, 'journal', 'verify', file], { timeout: 10000 });
  assert.equal(JSON.parse(stdout).ok, true);
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('"wait"', '"click"'));
  await assert.rejects(run(process.execPath, [cli, 'journal', 'verify', file], { timeout: 10000 }),
    error => error.code === 1 && JSON.parse(error.stdout).reason === 'record hash mismatch');
  await assert.rejects(run(process.execPath, [cli, 'journal', 'check', file], { timeout: 10000 }),
    error => /Usage: fruitctl journal verify FILE/.test(error.stderr));
});
