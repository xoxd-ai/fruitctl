// SPDX-License-Identifier: MIT
// Linux relay supervision (D20): typed bridge failures, bounded reconnect
// without replay, local health, and the D16 secret-reference boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRelay, attachMux, classifyBridgeExit, queryRelayHealth, sshArguments } from '../lib/broker/relay.mjs';
import { BrokerExecutor } from '../lib/broker/client.mjs';
import { McpSession } from '../lib/mcp/server.js';
import { readFrames, writeFrame } from '../lib/broker/protocol.mjs';

const run = promisify(execFile);
const cliPath = fileURLToPath(new URL('../bin/fruitctl.mjs', import.meta.url));

async function directory(t) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-relay-'));
  await fs.chmod(created, 0o700);
  t.after(() => fs.rm(created, { recursive: true, force: true }));
  return created;
}

async function waitUntil(predicate, message, timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail(message);
    await delay(2);
  }
}

// An SSH child double. Like a real child, `close` follows the end of its
// stdio, so stderr written before an exit is read before close.
function sshChild({ honourSignals = true } = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.packets = [];
  child.signals = [];
  readFrames(child.stdin, frame => { child.packets.push(frame); }, () => {});
  child.exit = (code, stderr = '') => {
    if (child.ended) return;
    child.ended = true;
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.exitCode = code;
    child.emit('exit', code, null);
    setImmediate(() => child.emit('close', code, null));
  };
  child.kill = signal => {
    child.signals.push(signal);
    if (honourSignals) queueMicrotask(() => child.exit(null));
    return true;
  };
  child.hello = () => writeFrame(child.stdout, { v: 1, channel: '', kind: 'hello' });
  child.reply = (channel, packet) => writeFrame(child.stdout, { v: 1, channel, kind: 'packet', packet });
  return child;
}

async function supervisedRelay(t, options = {}) {
  const socketPath = path.join(await directory(t), 'relay.sock');
  const children = [];
  const logs = [];
  const relay = await createRelay({ socketPath, bridge: 'operator@darwin-bridge', reconnect: true,
    backoff: { initialMs: 300, maxMs: 600 }, random: () => 0.5, log: line => logs.push(line),
    spawnSSH: args => { const child = sshChild(options.child); child.args = args; children.push(child); return child; },
    ...options.relay });
  t.after(async () => {
    const closing = relay.close().catch(() => {});
    for (const child of children) child.exit(null);
    await closing;
  });
  return { relay, socketPath, children, logs };
}

const openExecutor = (socketPath, connectTimeoutMs = 5000) =>
  new BrokerExecutor({ socketPath, target: 'desktop', connectTimeoutMs });

test('an unreachable bridge gives clients a typed error, keeps the socket, and reconnects with backoff', async t => {
  const { relay, socketPath, children, logs } = await supervisedRelay(t);
  assert.equal(relay.health().state, 'connecting');

  const first = openExecutor(socketPath);
  await waitUntil(() => children[0].packets.length === 1, 'open is forwarded while connecting');
  children[0].exit(255, 'operator@darwin-bridge: Permission denied (publickey).\r\n');
  await assert.rejects(first.opened, error =>
    error.code === 'bridge_auth_refused' && /not delivered/.test(error.message) && !/publickey/.test(error.message));

  const down = relay.health();
  assert.equal(down.state, 'down');
  assert.equal(down.lastError.code, 'bridge_auth_refused');
  assert.ok(down.retryInMs > 0 && down.retryInMs <= 300);
  assert.ok(logs.some(line => /bridge_auth_refused; retrying in 1s/.test(line)));
  assert.ok(!logs.join('\n').includes('publickey'), 'SSH stderr is classified, never logged');

  // While down, a client is answered at once from the relay; no child sees it.
  const refused = openExecutor(socketPath);
  await assert.rejects(refused.opened, error => error.code === 'bridge_auth_refused');
  assert.equal(children.length, 1);

  await waitUntil(() => children.length === 2, 'a successor spawns after backoff');
  assert.deepEqual(children[1].args, children[0].args);
  children[1].hello();
  await waitUntil(() => relay.health().state === 'up', 'hello marks the bridge up');
  assert.equal(relay.health().attempts, 1, 'a hello alone does not reset backoff');
  assert.equal(relay.health().lastError, null);

  const second = openExecutor(socketPath);
  await waitUntil(() => children[1].packets.length === 1, 'the next client reaches the successor');
  children[1].reply(children[1].packets[0].channel, { v: 1, kind: 'opened', clientId: 'fixture' });
  await second.opened;
  assert.equal(children[0].packets.length, 1, 'nothing reached the lost child after it failed');
  assert.deepEqual(children[1].packets.map(frame => frame.packet.kind), ['open'],
    'neither the failed nor the refused client is replayed onto the successor');
  await second.close();
});

test('backoff resets only after a link stays up stableMs, not on hello', async t => {
  let clock = 0;
  const { relay, children, logs } = await supervisedRelay(t, { relay: { now: () => clock,
    backoff: { initialMs: 10, maxMs: 1000, stableMs: 1000 } } });
  const flap = async (index, upMs) => {
    children[index].hello();
    await waitUntil(() => relay.health().state === 'up', `link ${index} up`);
    clock += upMs;
    children[index].exit(255, 'Connection to darwin-bridge closed by remote host.\r\n');
    await waitUntil(() => relay.health().state === 'down' && relay.health().lastError, `link ${index} down`);
  };
  await flap(0, 500);
  assert.equal(relay.health().attempts, 1);
  await waitUntil(() => children.length === 2, 'first successor');
  await flap(1, 500);
  assert.equal(relay.health().attempts, 2, 'a link that greets and drops inside stableMs keeps backing off');
  assert.equal(relay.health().retryInMs, 20);
  assert.ok(logs.some(line => /bridge_lost; retrying in 1s \(attempt 2, link was up 1s\)/.test(line)));

  await waitUntil(() => children.length === 3, 'second successor');
  children[2].hello();
  await waitUntil(() => relay.health().state === 'up', 'link 2 up');
  assert.equal(relay.health().attempts, 2, 'still unproven');
  clock += 1000;
  assert.equal(relay.health().attempts, 0, 'stable after stableMs');
  children[2].exit(255, 'Connection to darwin-bridge closed by remote host.\r\n');
  await waitUntil(() => relay.health().state === 'down' && relay.health().lastError, 'link 2 down');
  assert.equal(relay.health().attempts, 1, 'a stable link restarts backoff from the first step');
});

test('a link whose attach stops answering the probe is retired as unresponsive', async t => {
  // Every attach, with or without hello, answers the probe on the empty channel.
  const input = new PassThrough();
  const output = new PassThrough();
  const answers = [];
  readFrames(output, frame => { answers.push(frame); }, () => {});
  const mux = await attachMux({ input, output, socketPath: '/nonexistent' });
  writeFrame(input, { v: 1, channel: '', kind: 'packet', packet: { kind: 'probe' } });
  await waitUntil(() => answers.length === 2, 'attach answers the probe');
  assert.deepEqual(answers[1], { v: 1, channel: '', kind: 'closed' });
  mux.close();

  // Silence is measured on the injected clock, so a loaded runner that
  // delays a probe tick cannot retire a link before it was probed.
  let clock = 0;
  const { relay, socketPath, children } = await supervisedRelay(t, { relay: { now: () => clock,
    backoff: { initialMs: 10, maxMs: 20, probeMs: 10, silenceMs: 60 } } });
  const executor = openExecutor(socketPath);
  await waitUntil(() => children[0].packets.some(frame => frame.channel === '' && frame.packet.kind === 'probe'),
    'the relay probes the remote attach');
  clock += 60;
  await assert.rejects(executor.opened, error => error.code === 'bridge_unreachable' && /not delivered/.test(error.message));
  assert.equal(relay.health().lastError.reason, 'unresponsive');
  assert.deepEqual(children[0].signals.slice(0, 1), ['SIGTERM']);
  await waitUntil(() => children.length === 2, 'a successor replaces the silent link');
  writeFrame(children[1].stdout, { v: 1, channel: '', kind: 'closed' });
  await waitUntil(() => relay.health().state === 'up', 'a probe answer confirms an attach without hello');
});

test('losing an answered link fails in-flight work as uncertain and never replays it', async t => {
  const { relay, socketPath, children } = await supervisedRelay(t);
  const executor = openExecutor(socketPath);
  await waitUntil(() => children[0].packets.length === 1, 'open forwarded');
  children[0].reply(children[0].packets[0].channel, { v: 1, kind: 'opened', clientId: 'fixture' });
  await executor.opened;
  assert.equal(relay.health().state, 'up');

  const running = executor.execute([{ action: 'left_click', x: 10, y: 20 }], { timeoutMs: 5000 });
  await waitUntil(() => children[0].packets.length === 2, 'execute forwarded');
  children[0].exit(255, 'Connection to darwin-bridge closed by remote host.\r\n');
  await assert.rejects(running, error => error.code === 'bridge_lost' && /uncertain/.test(error.message));
  assert.equal(relay.health().lastError.code, 'bridge_lost');
  const late = openExecutor(socketPath);
  await assert.rejects(late.opened, error => error.code === 'bridge_unreachable' && /not delivered/.test(error.message),
    'a client arriving after the loss is told its request was not delivered');

  await waitUntil(() => children.length === 2, 'successor spawned');
  children[1].hello();
  await waitUntil(() => relay.health().state === 'up', 'successor up');
  await delay(20);
  assert.deepEqual(children[1].packets, [], 'the uncertain click is not replayed');
});

test('a bridge loss reaches the agent as a typed MCP code, in flight and on every later call', async t => {
  const { socketPath, children } = await supervisedRelay(t);
  const executor = openExecutor(socketPath);
  await waitUntil(() => children[0].packets.length === 1, 'open forwarded');
  children[0].reply(children[0].packets[0].channel, { v: 1, kind: 'opened', clientId: 'fixture' });
  await executor.opened;
  const session = new McpSession(executor);

  const queued = session.queue({ actions: [{ action: 'wait', duration: 1 }] });
  await waitUntil(() => children[0].packets.length === 2, 'execute forwarded');
  children[0].exit(255, 'Connection to darwin-bridge closed by remote host.\r\n');
  const inFlight = await queued;
  assert.equal(inFlight.isError, true);
  assert.equal(inFlight.structuredContent.error.code, 'bridge_lost');

  // The session does not reopen; its next call names the same cause instead
  // of an untyped "closed", and nothing reaches any link.
  const later = await session.command({ action: 'screenshot' });
  assert.equal(later.structuredContent.error.code, 'bridge_lost');
  assert.match(later.structuredContent.error.message, /uncertain/);
  assert.equal(children[0].packets.length, 2);
});

test('broker_unavailable is reserved for a socket that never connected', async t => {
  const root = await directory(t);
  const absent = new BrokerExecutor({ socketPath: path.join(root, 'absent.sock'), target: 'desktop' });
  await assert.rejects(absent.opened, error => error.code === 'broker_unavailable');

  const brokerSocket = path.join(root, 'broker.sock');
  const connections = new Set();
  const broker = net.createServer(socket => connections.add(socket) && readFrames(socket, frame => {
    if (frame.kind === 'open') writeFrame(socket, { v: 1, kind: 'opened', clientId: 'fixture' });
  }, () => socket.destroy()));
  await new Promise(resolve => broker.listen(brokerSocket, resolve));
  t.after(() => new Promise(resolve => { for (const socket of connections) socket.destroy(); broker.close(resolve); }));
  const executor = new BrokerExecutor({ socketPath: brokerSocket, target: 'desktop' });
  await executor.opened;
  const running = executor.execute([{ action: 'wait', duration: 1 }], { timeoutMs: 5000 });
  await waitUntil(() => connections.size === 1, 'broker accepted');
  await delay(10);
  executor.socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
  await assert.rejects(running, error => error.code === undefined && /uncertain/.test(error.message),
    'a connected socket error is not reported as undelivered');
});

test('a lost child that does not drain blocks any successor and exits unconfirmed', async t => {
  const { relay, socketPath, children } = await supervisedRelay(t, { child: { honourSignals: false } });
  const executor = openExecutor(socketPath);
  await waitUntil(() => children[0].packets.length === 1, 'open forwarded');
  children[0].stdout.end();
  await assert.rejects(relay.failure, error => error.code === 'release_unconfirmed' && error.exitCode === 3);
  assert.deepEqual(children[0].signals.slice(0, 2), ['SIGTERM', 'SIGKILL']);
  await assert.rejects(executor.opened, error => error.code === 'bridge_unconfirmed');
  await delay(200);
  assert.equal(children.length, 1, 'no second SSH child while the first may still be alive');
});

test('the Darwin broker refusing a session is reported as broker unavailable', async t => {
  const { socketPath, children } = await supervisedRelay(t);
  children[0].hello();
  const executor = openExecutor(socketPath);
  await waitUntil(() => children[0].packets.length === 1, 'open forwarded');
  writeFrame(children[0].stdout, { v: 1, channel: children[0].packets[0].channel, kind: 'closed' });
  await assert.rejects(executor.opened, error => error.code === 'bridge_broker_unavailable');
});

test('relay, attach and broker carry a secret reference unchanged and refuse a secret value on the seat', async t => {
  const root = await directory(t);
  const brokerSocket = path.join(root, 'broker.sock');
  const received = [];
  const connections = new Set();
  const broker = net.createServer(socket => connections.add(socket) && readFrames(socket, frame => {
    if (frame.kind === 'open') writeFrame(socket, { v: 1, kind: 'opened', clientId: 'fixture' });
    if (frame.kind === 'execute') {
      received.push(frame.actions);
      writeFrame(socket, { v: 1, kind: 'result', id: frame.id, responses: frame.actions.map(() => ({ result: { detail: 'OK' } })) });
    }
  }, () => socket.destroy()));
  await new Promise(resolve => broker.listen(brokerSocket, resolve));
  t.after(() => new Promise(resolve => {
    for (const socket of connections) socket.destroy();
    broker.close(resolve);
  }));

  const { relay, socketPath } = await supervisedRelay(t, { relay: {
    spawnSSH: () => {
      // The SSH transport is two pipes; the remote end is the real attach.
      const child = sshChild();
      void attachMux({ input: child.stdin, output: child.stdout, socketPath: brokerSocket });
      return child;
    },
  } });
  await waitUntil(() => relay.health().state === 'up', 'attach --mux announces itself before any client');

  const executor = openExecutor(socketPath);
  t.after(() => executor.close());
  await executor.opened;
  const ref = 'desktop-login';
  assert.deepEqual(await executor.execute([{ action: 'type_secret', ref }], { timeoutMs: 5000 }),
    [{ result: { detail: 'OK' } }]);
  assert.deepEqual(received, [[{ action: 'type_secret', ref }]]);

  assert.deepEqual(await executor.execute([{ action: 'type_secret', ref, x: 4, y: 8 }], { timeoutMs: 5000 }),
    [{ result: { detail: 'OK' } }]);
  for (const action of [{ action: 'type_secret', text: 'hunter2' }, { action: 'type_secret', ref, secret: 'hunter2' },
    { action: 'type_secret', ref, value: 'hunter2' }, { action: 'type_secret', ref: 'op://vault/hunter2' }]) {
    await assert.rejects(executor.execute([{ action: 'wait', duration: 1 }, action], { timeoutMs: 5000 }),
      error => error.code === 'invalid_secret_request');
  }
  assert.equal(received.length, 2, 'a value-bearing type_secret never leaves the seat');
});

test('SSH exits map to typed bridge causes without reading private text into the result', () => {
  const cases = [
    [{ exitCode: 255, stderr: 'Host key verification failed.' }, 'bridge_host_key'],
    [{ exitCode: 255, stderr: 'Permission denied (publickey,keyboard-interactive).' }, 'bridge_auth_refused'],
    [{ exitCode: 255, stderr: 'ssh: Could not resolve hostname neo: Name or service not known' }, 'bridge_unreachable', 'dns'],
    [{ exitCode: 255, stderr: 'ssh: connect to host neo port 22: Connection refused' }, 'bridge_unreachable', 'refused'],
    [{ exitCode: 255, stderr: 'ssh: connect to host neo port 22: Connection timed out' }, 'bridge_unreachable', 'network'],
    [{ exitCode: 127, stderr: 'zsh:1: command not found: fruitctl' }, 'bridge_command_missing'],
    [{ exitCode: 255, stderr: '' }, 'bridge_unreachable', 'ssh'],
    [{ exitCode: 1, stderr: '' }, 'bridge_attach_failed'],
    [{ exitCode: 255, stderr: 'Connection refused', confirmed: true }, 'bridge_lost'],
    [{ spawnError: true }, 'bridge_unreachable', 'ssh_unavailable'],
  ];
  for (const [input, code, reason] of cases) {
    assert.deepEqual(classifyBridgeExit(input), reason ? { code, reason } : { code }, JSON.stringify(input));
  }
});

test('SSH arguments bound connection setup and keep the bridge a single argv entry', () => {
  const args = sshArguments({ bridge: 'operator@darwin-bridge', remoteCommand: '/nix/store/x/bin/fruitctl' });
  assert.ok(args.includes('ConnectTimeout=10') && args.includes('BatchMode=yes'));
  assert.equal(args.at(-2), 'operator@darwin-bridge');
  assert.equal(args.at(-1), "'/nix/store/x/bin/fruitctl' 'attach' '--mux'");
  assert.throws(() => sshArguments({ bridge: '-oProxyCommand=sh' }), error => error.code === 'relay_config' && error.exitCode === 78);
});

test('relay --health reports a live relay without touching the bridge, and an absent one as down', async t => {
  const { socketPath, children } = await supervisedRelay(t);
  children[0].hello();
  const before = children[0].packets.length;
  const health = await queryRelayHealth({ socketPath });
  assert.equal(health.schema, 'fruitctl.relay-health.v1');
  assert.equal(health.state, 'up');
  assert.equal(health.bridge, 'operator@darwin-bridge');
  assert.equal(children[0].packets.length, before);

  const absent = path.join(path.dirname(socketPath), 'absent.sock');
  await assert.rejects(run(process.execPath, [cliPath, 'relay', '--health', '--socket', absent], { timeout: 5000 }),
    error => error.code === 1 && JSON.parse(error.stdout).lastError.code === 'relay_unavailable');
  await assert.rejects(run(process.execPath, [cliPath, 'relay', '--bridge=-oProxyCommand=sh', '--socket', absent],
    { timeout: 5000 }), error => error.code === 78 && /explicit SSH host/.test(error.stderr));
  await assert.rejects(fs.lstat(absent), { code: 'ENOENT' });
});
