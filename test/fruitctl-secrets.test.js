// SPDX-License-Identifier: MIT
// D16/D36 secret providers and type_secret. Owned temporary files and
// child processes only: no vault, keychain, SSH, VNC endpoint or desktop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveSecret, validateSecretSpec, credentialSpec, checkSecrets, lengthClass,
  SecretError } from '../lib/broker/secrets.mjs';
import { loadConfig } from '../lib/broker/paths.mjs';
import { TargetLane, createBroker, nativeFactory } from '../lib/broker/server.mjs';
import { BrokerExecutor } from '../lib/broker/client.mjs';
import { Journal, verifyJournal } from '../lib/broker/journal.mjs';
import { ActionObserver } from '../lib/broker/observe.mjs';
import { McpSession } from '../lib/mcp/server.js';
import { isPreAdmissionRefusal, requireNativeActions } from '../lib/mcp/capabilities.js';
import { validateActionParameters } from '../tools/index.js';

const run = promisify(execFile);
const SECRET = 'fixture-s3cret-value';
const node = process.execPath;

async function directory(t) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-secrets-'));
  await fs.chmod(value, 0o700);
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}

async function privateFile(dir, name, content = `${SECRET}\n`, mode = 0o600) {
  const file = path.join(dir, name);
  await fs.writeFile(file, content, { mode });
  await fs.chmod(file, mode);
  return file;
}

const reason = expected => error => {
  assert.ok(error instanceof SecretError, String(error));
  assert.equal(error.reason, expected);
  assert.ok(!error.message.includes(SECRET));
  return true;
};
const command = (script, extra = {}) => validateSecretSpec({ provider: 'command', argv: [node, '-e', script], ...extra });

test('file provider reads an owner-only file and strips one line ending', async t => {
  const dir = await directory(t);
  const file = await privateFile(dir, 'vnc', `${SECRET}\r\n`);
  assert.equal(await resolveSecret(validateSecretSpec({ provider: 'file', path: file })), SECRET);
  // Only one trailing line ending is framing; inner and leading whitespace is content.
  await fs.writeFile(file, ` ${SECRET}\n\n`);
  assert.equal(await resolveSecret(validateSecretSpec({ provider: 'file', path: file })), ` ${SECRET}\n`);
});

test('file provider refuses open modes, foreign parents, symlinks, FIFOs, empty and oversize files', async t => {
  const dir = await directory(t);
  const spec = file => validateSecretSpec({ provider: 'file', path: file });
  await assert.rejects(resolveSecret(spec(await privateFile(dir, 'open', SECRET, 0o640))), reason('mode_too_open'));
  await assert.rejects(resolveSecret(spec(path.join(dir, 'absent'))), reason('missing'));
  await assert.rejects(resolveSecret(spec(await privateFile(dir, 'empty', '\n'))), reason('empty'));
  await assert.rejects(resolveSecret(spec(await privateFile(dir, 'big', 'x'.repeat(4097)))), reason('too_large'));
  await assert.rejects(resolveSecret(spec(await privateFile(dir, 'nul', 'a\0b'))), reason('invalid_encoding'));
  // A file another account could swap is refused even if the file itself is private.
  const shared = path.join(dir, 'shared');
  await fs.mkdir(shared);
  const inShared = await privateFile(shared, 'vnc');
  await fs.chmod(shared, 0o777);
  await assert.rejects(resolveSecret(spec(inShared)), reason('unsafe_parent'));
  await fs.chmod(shared, 0o700);
  // A symlink is refused unless allowed, and the allowed target is checked too.
  const target = await privateFile(dir, 'target');
  const link = path.join(dir, 'link');
  await fs.symlink(target, link);
  await assert.rejects(resolveSecret(spec(link)), reason('symlink_refused'));
  const allowed = validateSecretSpec({ provider: 'file', path: link, allowSymlink: true });
  assert.equal(await resolveSecret(allowed), SECRET);
  await fs.chmod(target, 0o644);
  await assert.rejects(resolveSecret(allowed), reason('mode_too_open'));
  // A FIFO is refused without blocking on a writer.
  const fifo = path.join(dir, 'fifo');
  await run('mkfifo', ['-m', '600', fifo]);
  await assert.rejects(resolveSecret(spec(fifo)), reason('not_regular_file'));
});

test('credentialFile stays an alias that follows its symlink with the same checks', async t => {
  const dir = await directory(t);
  const target = await privateFile(dir, 'materialized');
  const link = path.join(dir, 'credential');
  await fs.symlink(target, link);
  const spec = credentialSpec({ credentialFile: link });
  assert.deepEqual(spec, { provider: 'file', path: link, allowSymlink: true });
  assert.equal(await resolveSecret(spec), SECRET);
  assert.throws(() => credentialSpec({ credentialFile: link, credential: { provider: 'file', path: link } }), /both/);
});

test('env provider reads a named variable and reports unset ones', async () => {
  const spec = validateSecretSpec({ provider: 'env', name: 'FRUITCTL_FIXTURE_SECRET' });
  assert.equal(await resolveSecret(spec, { env: { FRUITCTL_FIXTURE_SECRET: SECRET } }), SECRET);
  await assert.rejects(resolveSecret(spec, { env: {} }), reason('unset'));
});

test('command provider runs argv without a shell and returns stdout', async () => {
  // A shell would expand $(...); argv is passed literally.
  const spec = validateSecretSpec({ provider: 'command',
    argv: [node, '-e', 'process.stdout.write(process.argv[1] + "\\n")', '$(echo expanded)'] });
  assert.equal(await resolveSecret(spec), '$(echo expanded)');
});

test('command provider never reads stderr, even when a tool floods it', async () => {
  // 4 MiB of stderr would block on an undrained pipe; with stderr closed the
  // command finishes, and nothing from stderr appears in the value or errors.
  const flood = 'process.stderr.write("LEAKED-DIAGNOSTIC ".repeat(1 << 18));';
  assert.equal(await resolveSecret(command(`${flood} process.stdout.write(${JSON.stringify(SECRET)})`,
    { timeoutMs: 5000 })), SECRET);
  await assert.rejects(resolveSecret(command(`${flood} process.exit(3)`)), error => {
    reason('exit_status')(error);
    assert.ok(!error.message.includes('LEAKED'));
    return true;
  });
});

test('command provider kills a command that outlives its timeout', async t => {
  const dir = await directory(t);
  const pidFile = path.join(dir, 'pid');
  const started = performance.now();
  await assert.rejects(resolveSecret(command(
    `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`,
    { timeoutMs: 1000 })), reason('timeout'));
  assert.ok(performance.now() - started < 4000);
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await delay(20);
  }
  assert.fail('timed-out command is still running');
});

test('command provider bounds output, honours cancellation and reports a missing tool', async () => {
  await assert.rejects(resolveSecret(command('process.stdout.write("x".repeat(70000))')), reason('too_large'));
  const controller = new AbortController();
  const pending = resolveSecret(command('setTimeout(() => {}, 60000)'), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, reason('cancelled'));
  await assert.rejects(resolveSecret(validateSecretSpec({ provider: 'command', argv: ['/nonexistent/fruitctl-tool'] })),
    reason('spawn_failed'));
});

test('keychain provider is Darwin-only and maps to security find-generic-password', async t => {
  const spec = validateSecretSpec({ provider: 'keychain', service: 'fruitctl-desktop', account: 'alex' });
  await assert.rejects(resolveSecret(spec, { platform: 'linux' }), reason('unsupported_platform'));
  // An owned stand-in for /usr/bin/security that accepts only the exact query.
  const dir = await directory(t);
  const tool = path.join(dir, 'security');
  await fs.writeFile(tool, `#!${node}\nconst a = process.argv.slice(2);\n` +
    `if (JSON.stringify(a) === JSON.stringify(["find-generic-password","-s","fruitctl-desktop","-a","alex","-w"]))` +
    ` { process.stdout.write(${JSON.stringify(SECRET)} + "\\n"); } else { process.exit(44); }\n`, { mode: 0o700 });
  assert.equal(await resolveSecret(spec, { platform: 'darwin', keychainTool: tool }), SECRET);
  const other = validateSecretSpec({ provider: 'keychain', service: 'other', account: 'alex' });
  await assert.rejects(resolveSecret(other, { platform: 'darwin', keychainTool: tool }), reason('missing'));
});

test('provider declarations are validated at config load, without reading anything', async t => {
  const dir = await directory(t);
  const write = async targets => {
    const file = path.join(dir, 'config.json');
    await fs.writeFile(file, JSON.stringify({ schema: 'fruitctl.config.v1', targets }));
    return file;
  };
  const absent = path.join(dir, 'not-materialized-yet');
  const ok = await loadConfig(await write({ desk: { credential: { provider: 'file', path: absent },
    secrets: { 'login.password': { provider: 'command', argv: ['/usr/bin/true'] } } } }));
  assert.equal(ok.targets.desk.credential.path, absent);
  for (const targets of [
    { desk: { credential: { provider: 'file', path: 'relative' } } },
    { desk: { credential: { provider: 'command', argv: ['vault', 'read'] } } },
    { desk: { credential: { provider: 'file', path: absent, paht: 'typo' } } },
    { desk: { credential: { provider: 'shell', command: 'cat x' } } },
    { desk: { secrets: { 'bad ref': { provider: 'env', name: 'X' } } } },
    { desk: { secrets: { login: { provider: 'command', argv: [node], timeoutMs: 60000 } } } },
  ]) await assert.rejects(loadConfig(await write(targets)), /Invalid secret|Invalid secrets|both/);
});

test('doctor check resolves each declared secret once and prints only provider and status', async t => {
  const dir = await directory(t);
  const good = await privateFile(dir, 'good');
  const open = await privateFile(dir, 'open', SECRET, 0o644);
  const config = { targets: {
    desk: { credential: { provider: 'file', path: good }, secrets: {
      login: { provider: 'file', path: open },
      pin: { provider: 'env', name: 'FRUITCTL_FIXTURE_PIN' },
      vault: { provider: 'command', argv: [node, '-e', `process.stdout.write(${JSON.stringify(SECRET)})`] },
    } },
    other: { credentialFile: good } } };
  const report = await checkSecrets(config, { env: { FRUITCTL_FIXTURE_PIN: SECRET } });
  assert.equal(report.status, 'fail');
  assert.deepEqual(report.targets.desk, { credential: { provider: 'file', status: 'ok' }, secrets: {
    login: { provider: 'file', status: 'fail', reason: 'mode_too_open' },
    pin: { provider: 'env', status: 'ok', warning: 'env_provider_discouraged' },
    vault: { provider: 'command', status: 'ok' } } });
  assert.ok(!JSON.stringify(report).includes(SECRET));
  const only = await checkSecrets(config, { target: 'other' });
  assert.deepEqual(Object.keys(only.targets), ['other']);
  assert.equal(only.status, 'pass');
  await assert.rejects(checkSecrets(config, { target: 'missing' }), /Unknown target/);
});

test('doctor --secrets exits 1 on a failing provider and never prints a value', async t => {
  const dir = await directory(t);
  const file = await privateFile(dir, 'login', SECRET, 0o644);
  const config = path.join(dir, 'config.json');
  await fs.writeFile(config, JSON.stringify({ schema: 'fruitctl.config.v1',
    targets: { desk: { secrets: { login: { provider: 'file', path: file } } } } }));
  const cli = path.resolve(import.meta.dirname, '../bin/fruitctl.mjs');
  const env = { ...process.env, HOME: dir, XDG_STATE_HOME: path.join(dir, 'state') };
  const result = await run(node, [cli, 'doctor', '--secrets', '--config', config], { env }).then(() => assert.fail('doctor passed'), error => error);
  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.secretsCheck.targets.desk.secrets.login, { provider: 'file', status: 'fail', reason: 'mode_too_open' });
  assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET));
});

// ── type_secret through the broker lane ──────────────────────────────────

function recordingExecutor({ respond } = {}) {
  const calls = [];
  return { calls, executor: { capabilities: { known: true, actions: ['type_secret', 'mouse_click', 'wait'] },
    async execute(actions, { onResponse }) {
      calls.push(...actions);
      return actions.map((action, index) => {
        const response = respond?.(action, index) ??
          // A misbehaving backend that echoes its input must still not leak it.
          { id: index, result: { detail: `typed ${action.secret ?? action.action}`, echoed: action.secret } };
        onResponse?.(response);
        return response;
      });
    }, async close() {} } };
}

async function secretProfile(t) {
  const dir = await directory(t);
  const login = await privateFile(dir, 'login');
  return { dir, profile: { secrets: { login: { provider: 'file', path: login },
    gone: { provider: 'file', path: path.join(dir, 'never-materialized') } } } };
}

test('type_secret resolves on the broker, reaches only the executor and returns a fixed result', async t => {
  const { dir, profile } = await secretProfile(t);
  const journal = new Journal({ dir: path.join(dir, 'journal') });
  const observer = new ActionObserver({ journal });
  const { calls, executor } = recordingExecutor();
  const lane = new TargetLane(profile, async () => executor, { name: 'desk', observer });
  t.after(() => lane.close());
  const owner = '0a0a0a0a-0b0b-4c0c-8d0d-0e0e0e0e0e0e';
  lane.acquire(owner);
  const progress = [];
  const responses = await lane.execute([{ action: 'type_secret', ref: 'login', x: 10, y: 20 }, { action: 'wait' }],
    { onResponse: response => progress.push(response) });
  assert.deepEqual(calls[0], { action: 'type_secret', secret: SECRET, x: 10, y: 20 });
  assert.deepEqual(responses[0], { id: 0, result: { detail: 'OK' } });
  assert.deepEqual(progress[0], { id: 0, result: { detail: 'OK' } });
  assert.equal(responses[1].result.detail, 'typed wait', 'other steps are untouched');
  await observer.flush();
  const file = path.join(dir, 'journal', `${owner}.jsonl`);
  const text = await fs.readFile(file, 'utf8');
  const record = JSON.parse(text.split('\n')[0]);
  assert.equal(record.method, 'type_secret');
  assert.deepEqual(record.params, { ref: 'login', x: 10, y: 20, provider: 'file', length_class: lengthClass(SECRET) });
  assert.equal(record.params.length_class, '17-32');
  assert.ok(!text.includes(SECRET));
  assert.equal((await verifyJournal(file)).ok, true);
});

test('a batch sent while a secret resolves runs after it, in arrival order', async t => {
  // A slow vault command must not let a pipelined Return submit the field
  // before the secret is typed.
  const profile = { secrets: { slow: { provider: 'command',
    argv: [node, '-e', `setTimeout(() => process.stdout.write(${JSON.stringify(SECRET)}), 300)`] } } };
  const { calls, executor } = recordingExecutor();
  const lane = new TargetLane(profile, async () => executor, { name: 'desk' });
  t.after(() => lane.close());
  lane.acquire('0a0a0a0a-0b0b-4c0c-8d0d-0e0e0e0e0e0e');
  const typed = lane.execute([{ action: 'type_secret', ref: 'slow' }]);
  const submitted = lane.execute([{ action: 'wait', ms: 50 }]);
  await Promise.all([typed, submitted]);
  assert.deepEqual(calls.map(call => call.action), ['type_secret', 'wait']);
  assert.equal(calls[0].secret, SECRET);
});

/** A command provider that records each run in `marker`. */
function countedSecret(marker, delayMs = 0) {
  return { provider: 'command', argv: [node, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x');` +
    `setTimeout(() => process.stdout.write(${JSON.stringify(SECRET)}), ${delayMs})`] };
}
const runs = marker => fs.readFile(marker, 'utf8').then(text => text.length, () => 0);

test('a provider runs only after every pre-admission refusal, and a bad deadline is refused typed', async t => {
  const dir = await directory(t);
  const marker = path.join(dir, 'runs');
  const profile = { secrets: { login: countedSecret(marker) } };
  // A native backend without type_secret refuses it at preflight.
  const executor = { capabilities: { known: true, actions: ['wait'] },
    preflight(actions) { requireNativeActions(actions, this.capabilities); },
    async execute() { assert.fail('nothing is admitted'); }, async close() {} };
  const lane = new TargetLane(profile, async () => executor);
  t.after(() => lane.close());
  lane.acquire('0a0a0a0a-0b0b-4c0c-8d0d-0e0e0e0e0e0e');
  await assert.rejects(lane.execute([{ action: 'type_secret', ref: 'login' }]),
    error => error.code === 'unsupported_action' && isPreAdmissionRefusal(error));
  for (const timeoutMs of [-1, 0, 'soon', Number.NaN, null]) {
    await assert.rejects(lane.execute([{ action: 'type_secret', ref: 'login' }], { timeoutMs }),
      error => error.code === 'invalid_deadline' && isPreAdmissionRefusal(error), String(timeoutMs));
  }
  assert.equal(await runs(marker), 0, 'the provider never ran');
  assert.ok(!lane.releasing && lane.owner, 'the lease survives every refusal');
});

test('an idle timer cannot retire the lane under a slow provider', async t => {
  const dir = await directory(t);
  const { calls, executor } = recordingExecutor();
  // A slow idle close would still be running when the provider returns.
  executor.close = () => delay(400);
  const lane = new TargetLane({ secrets: { slow: countedSecret(path.join(dir, 'runs'), 150) } },
    async () => executor, { idleMs: 40 });
  t.after(() => lane.close());
  lane.acquire('0a0a0a0a-0b0b-4c0c-8d0d-0e0e0e0e0e0e');
  await lane.execute([{ action: 'wait' }]);
  // The idle timer is armed; the provider outlasts it.
  const [typed] = await lane.execute([{ action: 'type_secret', ref: 'slow' }]);
  assert.deepEqual(typed, { id: 0, result: { detail: 'OK' } });
  assert.equal(calls.at(-1).secret, SECRET);
});

test('type_secret refusals are typed, pre-admission and start nothing', async t => {
  const { profile } = await secretProfile(t);
  let started = 0;
  const recorder = recordingExecutor();
  const lane = new TargetLane(profile, async () => { started++; return recorder.executor; }, { name: 'desk' });
  t.after(() => lane.close());
  const refused = (actions, code, pattern) => assert.rejects(lane.execute(actions), error => {
    assert.equal(error.code, code);
    assert.ok(isPreAdmissionRefusal(error));
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
  await refused([{ action: 'type_secret', ref: 'payroll' }], 'secret_ref_not_allowed', /payroll is not allowlisted/);
  await refused([{ action: 'type_secret', ref: 'login', text: SECRET }], 'invalid_secret_request', /never travels/);
  await refused([{ action: 'type_secret', ref: 'login', secret: SECRET }], 'invalid_secret_request', /never travels/);
  await refused([{ action: 'type_secret', ref: 'login', x: 1 }], 'invalid_secret_request', /x\?, y\?/);
  assert.equal(started, 0, 'a request refused by shape or allowlist starts nothing');
  // A provider runs only after every pre-admission gate, so its failure can
  // follow startup; it still sends nothing and keeps the lease.
  lane.acquire('0a0a0a0a-0b0b-4c0c-8d0d-0e0e0e0e0e0e');
  await refused([{ action: 'wait' }, { action: 'type_secret', ref: 'gone' }], 'secret_unavailable', /gone is unavailable: file provider missing/);
  assert.deepEqual(recorder.calls, []);
  assert.ok(!lane.releasing && lane.owner);
  // A target without an allowlist has no refs at all.
  let bareStarted = 0;
  const bare = new TargetLane({}, async () => { bareStarted++; return recordingExecutor().executor; });
  t.after(() => bare.close());
  await assert.rejects(bare.execute([{ action: 'type_secret', ref: 'login' }]), { code: 'secret_ref_not_allowed' });
  assert.equal(bareStarted, 0);
});

test('a failed native type_secret never echoes its text; pre-input refusals say so', async t => {
  const { profile } = await secretProfile(t);
  const leak = { code: -32000, message: `Unsupported typing control in ${SECRET}`, data: { reason: 'x', text: SECRET } };
  const { executor } = recordingExecutor({ respond: () => ({ id: 0, error: leak }) });
  const lane = new TargetLane(profile, async () => executor);
  t.after(() => lane.close());
  const [response] = await lane.execute([{ action: 'type_secret', ref: 'login' }]);
  assert.deepEqual(response.error, { code: -32000,
    message: 'type_secret did not complete; the field may hold part of the secret', data: { reason: 'x' } });
  const settle = recordingExecutor({ respond: () => ({ id: 0, error: { code: -32013, message: 'Input not ready',
    data: { reason: 'input_not_ready', remaining_ms: 1200 } } }) });
  const waiting = new TargetLane(profile, async () => settle.executor);
  t.after(() => waiting.close());
  const [refused] = await waiting.execute([{ action: 'type_secret', ref: 'login' }]);
  assert.deepEqual(refused.error, { code: -32013, message: 'type_secret was refused before any key was sent',
    data: { reason: 'input_not_ready', remaining_ms: 1200 } });
});

test('MCP clients name only the ref; results and refusals carry no value', async t => {
  assert.throws(() => validateActionParameters({ action: 'type_secret', ref: 'login', text: 'x' }), /never text/);
  assert.throws(() => validateActionParameters({ action: 'type_secret' }), /Missing ref/);
  const { dir, profile } = await secretProfile(t);
  const { calls, executor } = recordingExecutor();
  const socketPath = path.join(dir, 'run', 'broker.sock');
  const broker = await createBroker({ socketPath, config: { targets: { desk: profile } }, factory: async () => executor });
  t.after(() => broker.close());
  const client = new BrokerExecutor({ socketPath, target: 'desk' });
  t.after(() => client.close());
  await client.opened;
  const session = new McpSession(client);
  const typed = await session.command({ action: 'type_secret', ref: 'login' });
  assert.equal(typed.isError, undefined);
  assert.deepEqual(typed.content, [{ type: 'text', text: 'OK' }]);
  assert.ok(!JSON.stringify(typed).includes(SECRET));
  assert.equal(calls[0].secret, SECRET);
  const refused = await session.command({ action: 'type_secret', ref: 'payroll' });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, 'secret_ref_not_allowed');
});

test('the VNC credential comes from the provider and env-provider variables never reach the daemon', async t => {
  const dir = await directory(t);
  // Owned fake daemon: reports the credential frame length and whether the
  // env-provider variable reached it, then answers health.
  const daemonPath = path.join(dir, 'native.cjs');
  await fs.writeFile(daemonPath, `#!${node}
const fs = require('fs');
const length = fs.readFileSync(3).readUInt32BE(0);
const leaked = Object.hasOwn(process.env, 'FRUITCTL_FIXTURE_PIN') || Object.hasOwn(process.env, 'VNC_PASSWORD');
process.stdout.write(JSON.stringify({ method: 'ready', params: { scaledWidth: 2, scaledHeight: 1 } }) + '\\n');
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const detail = JSON.stringify({ length, leaked });
  process.stdout.write(JSON.stringify({ id: request.id, result: { detail } }) + '\\n');
  if (request.method === 'shutdown') process.exit(0);
});
`, { mode: 0o700 });
  const previous = process.env.FRUITCTL_FIXTURE_PIN;
  process.env.FRUITCTL_FIXTURE_PIN = 'env-provider-value';
  t.after(() => { if (previous === undefined) delete process.env.FRUITCTL_FIXTURE_PIN; else process.env.FRUITCTL_FIXTURE_PIN = previous; });
  const executor = await nativeFactory({ vnc: { host: '127.0.0.1', port: 5900 }, daemonPath,
    credential: { provider: 'command', argv: [node, '-e', `process.stdout.write(${JSON.stringify(SECRET)})`] } },
  { deadline: performance.now() + 10000, secretEnv: ['FRUITCTL_FIXTURE_PIN'] });
  try {
    const [health] = await executor.execute([{ action: 'health' }]);
    assert.deepEqual(JSON.parse(health.result.detail), { length: Buffer.byteLength(SECRET), leaked: false });
    // Without a broker nothing resolves a ref; the bare request never reaches the daemon.
    await assert.rejects(executor.execute([{ action: 'type_secret', ref: 'login' }]), error => {
      assert.ok(isPreAdmissionRefusal(error));
      assert.match(error.message, /needs the Fruitctl broker/);
      return true;
    });
  } finally { await executor.close(); }
  await assert.rejects(nativeFactory({ vnc: { host: '127.0.0.1', port: 5900 }, daemonPath,
    credential: { provider: 'file', path: path.join(dir, 'absent') } }, { deadline: performance.now() + 5000 }),
  { code: 'credential_unavailable', message: 'VNC credential provider file failed: missing' });
});
