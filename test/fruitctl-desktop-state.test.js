// SPDX-License-Identifier: MIT
// TIN-5509 desktop-state sentinel. The base fixture was captured read-only
// from PZM; variants replace single sections with the shapes the same script
// prints for a dialog, a lock, the login window or a sleeping display. Owned
// fakes only: no SSH, no VNC endpoint and no desktop is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { evaluateDesktopState, desktopRefusal, desktopStateOptions, DesktopSentinel,
  DESKTOP_STATE_SCRIPT, DESKTOP_STATE_SECTIONS } from '../lib/broker/desktop-state.mjs';
import { parseProbeOutput } from '../lib/install/macos-preflight.mjs';
import { createBroker, TargetLane } from '../lib/broker/server.mjs';
import { BrokerExecutor } from '../lib/broker/client.mjs';
import { McpSession } from '../lib/mcp/server.js';
import { isPreAdmissionRefusal, HUMAN_CONSENT_REQUIRED_CODE, TARGET_LOCKED_CODE, CLIPBOARD_UNAVAILABLE_CODE,
  desktopRefusalData } from '../lib/mcp/capabilities.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const base = await fs.readFile(new URL('./fixtures/desktop-state/pzm-26.7.1-crd-session.txt', import.meta.url), 'utf8');

/** The PZM capture with whole sections replaced, as probe stdout. */
function variant(replacements = {}) {
  let text = base;
  for (const [name, body] of Object.entries(replacements)) {
    const pattern = new RegExp(`@@fruitctl-probe ${name}@@\\n[\\s\\S]*?\\n@@fruitctl-status ${name} ([0-9]+)@@`);
    assert.match(text, pattern, name);
    text = text.replace(pattern, `@@fruitctl-probe ${name}@@\n${body}\n@@fruitctl-status ${name} 0@@`);
  }
  return text;
}
const state = replacements => evaluateDesktopState(parseProbeOutput(variant(replacements), DESKTOP_STATE_SECTIONS));
const windows = (...lines) => ['scope=console_user', 'displays=ok', 'display|2|0|1', 'windows=ok', ...lines].join('\n');
const UNC_ALERT = 'window|1925|8|420|184|1';
const LOCKED = '      "IOConsoleLocked" = Yes\n      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSessionLoginDoneKey"=Yes,"CGSSessionScreenIsLocked"=Yes,"kCGSSessionUserIDKey"=501})';

test('PZM capture: running dialog owners without windows are not a dialog; CRD is the other input owner', () => {
  const result = state();
  assert.deepEqual(result, {
    sentinel: 'ok', console: 'user', locked: false, display_asleep: false, consent_dialog: null,
    screen_saver: false, secure_input_holder: null,
    other_input_owner: { owner: 'Chrome Remote Desktop', evidence: ['process', 'assertion', 'input'] },
  });
  assert.equal(desktopRefusal(result), null, 'another input owner is reported, never refused');
});

test('an on-screen consent window is human_consent_required naming its owner', () => {
  const alert = state({ desktop_windows: windows(UNC_ALERT) });
  assert.deepEqual(alert.consent_dialog, { owner: 'UserNotificationCenter', kind: 'system_alert' });
  const refusal = desktopRefusal(alert);
  assert.equal(refusal.code, HUMAN_CONSENT_REQUIRED_CODE);
  assert.deepEqual(refusal.data, { reason: 'human_consent_required', owner: 'UserNotificationCenter', kind: 'system_alert' });
  assert.ok(isPreAdmissionRefusal(refusal), 'nothing was admitted, so the lease survives');
  // The native controller's -32014 is clipboard_unavailable, never a dialog.
  assert.equal(desktopRefusalData({ code: CLIPBOARD_UNAVAILABLE_CODE, data: { reason: 'clipboard_unavailable' } }), undefined);
  assert.deepEqual(refusal.responses, []);
  assert.deepEqual(state({ desktop_windows: windows('window|824|8|500|300|1') }).consent_dialog,
    { owner: 'CoreServicesUIAgent', kind: 'gatekeeper' });
  // Status-item sized or transparent windows are not dialogs.
  for (const line of ['window|1925|8|20|20|1', 'window|1925|8|420|184|0']) {
    assert.equal(state({ desktop_windows: windows(line) }).consent_dialog, null, line);
  }
  // A window owned by a PID outside the watched list never counts.
  assert.equal(state({ desktop_windows: windows('window|861|8|580|385|1') }).consent_dialog, null);
});

test('lock and login window refuse first, then an asleep display, then a dialog', () => {
  const locked = state({ ioreg_console: LOCKED, desktop_windows: windows(UNC_ALERT) });
  assert.equal(locked.locked, true);
  assert.deepEqual([desktopRefusal(locked).code, desktopRefusal(locked).data],
    [TARGET_LOCKED_CODE, { reason: 'target_locked', console: 'locked' }]);
  const login = state({ console: 'root', desktop_windows: 'scope=no_console_user' });
  assert.deepEqual([login.console, login.locked, login.display_asleep, login.consent_dialog],
    ['loginwindow', true, 'unknown', 'unknown']);
  assert.deepEqual(desktopRefusal(login).data, { reason: 'target_locked', console: 'loginwindow' });
  const asleep = state({ desktop_windows: ['scope=console_user', 'displays=ok', 'display|2|1|1', 'windows=ok', UNC_ALERT].join('\n') });
  assert.equal(asleep.display_asleep, true);
  assert.deepEqual([desktopRefusal(asleep).code, desktopRefusal(asleep).data],
    ['display_asleep', { reason: 'display_asleep' }]);
});

test('unreadable parts are unknown and never refuse', () => {
  const other = state({ desktop_windows: 'scope=other_user' });
  assert.deepEqual([other.display_asleep, other.consent_dialog, other.screen_saver], ['unknown', 'unknown', 'unknown']);
  assert.equal(other.locked, false, 'the lock comes from IOConsoleUsers, readable by any account');
  assert.equal(desktopRefusal(other), null);
  assert.equal(state({ dialog_owners: 'read=failed', desktop_windows: windows(UNC_ALERT) }).consent_dialog, 'unknown');
  assert.equal(state({ desktop_windows: ['scope=console_user', 'displays=failed', 'windows=failed'].join('\n') }).display_asleep, 'unknown');
  const blank = evaluateDesktopState(parseProbeOutput('', DESKTOP_STATE_SECTIONS));
  assert.deepEqual([blank.locked, blank.display_asleep, blank.consent_dialog, blank.secure_input_holder, blank.other_input_owner],
    ['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
  assert.equal(desktopRefusal(blank), null);
});

test('Secure Input and the screen saver are reported, not refused', () => {
  const secure = state({
    ioreg_console: '      "IOConsoleLocked" = No\n      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionSecureInputPID"=912,"kCGSSessionUserIDKey"=501})',
    secure_input_process: 'pid=912|/Applications/1Password.app/Contents/MacOS/1Password',
    dialog_owners: ['read=ok', ' 4410 /System/Library/CoreServices/ScreenSaverEngine.app/Contents/MacOS/ScreenSaverEngine'].join('\n'),
    desktop_windows: windows('window|4410|1000|1920|1080|1'),
  });
  assert.equal(secure.secure_input_holder, '1Password');
  assert.equal(secure.screen_saver, true);
  assert.equal(secure.consent_dialog, null);
  assert.equal(desktopRefusal(secure), null);
});

test('the fixed script is valid sh, reads no stdin past itself and never sends input', () => {
  const checked = spawnSync('/bin/sh', ['-n'], { input: DESKTOP_STATE_SCRIPT });
  assert.equal(checked.status, 0, checked.stderr.toString());
  // osascript would otherwise read the rest of the script from sh's stdin.
  assert.match(DESKTOP_STATE_SCRIPT, /2>\/dev\/null <\/dev\/null\n/);
  assert.doesNotMatch(DESKTOP_STATE_SCRIPT, /System Events|CGEventPost|keystroke|click|CGWindowListCreateImage|kCGWindowName/);
});

test('profile destination: explicit, then wake, then the Host helper; off when disabled or absent', () => {
  assert.deepEqual(desktopStateOptions({ desktopState: { ssh: 'op@mac' }, wake: { ssh: 'w@mac' } }), { ssh: 'op@mac' });
  assert.deepEqual(desktopStateOptions({ wake: { ssh: 'w@mac', enabled: false } }), { ssh: 'w@mac' });
  assert.deepEqual(desktopStateOptions({ hostHelper: { sshHost: 'mac-host' } }), { ssh: 'mac-host' });
  assert.equal(desktopStateOptions({ desktopState: { enabled: false }, wake: { ssh: 'w@mac' } }), null);
  assert.equal(desktopStateOptions({}), null);
  assert.equal(desktopStateOptions({ hostHelper: { sshHost: '-oProxyCommand=x' } }), null);
  assert.throws(() => desktopStateOptions({ desktopState: { ssh: '-oProxyCommand=x' } }), /desktopState/);
  assert.throws(() => desktopStateOptions({ desktopState: { enabled: 'yes' } }), /desktopState/);
});

function sentinelProbe(outputs) {
  const calls = [];
  const probe = async (destination, options) => {
    calls.push({ destination, options });
    const next = outputs.length > 1 ? outputs.shift() : outputs[0];
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next;
  };
  return { probe, calls };
}

function recordingFactory() {
  const sent = [];
  const factory = async () => ({
    async execute(actions, { onResponse }) {
      const responses = actions.map(action => {
        sent.push(action.action);
        return { result: action.action === 'screenshot' ? { image: PNG, scaledWidth: 2, scaledHeight: 1 }
          : action.action === 'health' ? { detail: 'connected' } : { detail: `${action.action} done` } };
      });
      for (const response of responses) onResponse?.(response);
      return responses;
    },
    async close() {},
  });
  return { factory, sent };
}

test('lane refuses input under a consent dialog before connecting, keeps the lease, and still observes', async t => {
  const { probe, calls } = sentinelProbe([variant({ desktop_windows: windows(UNC_ALERT) })]);
  const { factory, sent } = recordingFactory();
  let started = 0;
  const lane = new TargetLane({ wake: { ssh: 'op@mac', enabled: false } },
    (...args) => { started++; return factory(...args); }, { desktopProbe: probe, name: 'mac' });
  t.after(() => lane.close());
  lane.acquire('owner');
  await assert.rejects(lane.execute([{ action: 'screenshot' }, { action: 'mouse_click', x: 1, y: 1 }]), error =>
    error.code === HUMAN_CONSENT_REQUIRED_CODE && error.data.owner === 'UserNotificationCenter' &&
    isPreAdmissionRefusal(error));
  assert.equal(started, 0, 'no VNC session was opened for a refused batch');
  assert.deepEqual(sent, []);
  assert.equal(lane.owner, 'owner');
  assert.ok(!lane.releasing);
  assert.equal(calls[0].destination, 'op@mac');
  assert.equal(calls[0].options.script, DESKTOP_STATE_SCRIPT);
  const [shot] = await lane.execute([{ action: 'screenshot' }]);
  assert.equal(shot.result.image, PNG);
  assert.deepEqual(shot.result.desktop_state.consent_dialog, { owner: 'UserNotificationCenter', kind: 'system_alert' });
  assert.deepEqual(sent, ['screenshot']);
  assert.equal(calls.length, 1, 'the ~2 s cache answered the screenshot');
});

test('D16: type_secret is never typed into a consent dialog', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-desk-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const secret = 'correct horse battery staple';
  // The provider records each run: a refused batch never resolves its ref.
  const marker = path.join(dir, 'runs');
  const login = { provider: 'command', argv: [process.execPath, '-e',
    `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write(${JSON.stringify(secret)})`] };
  const { probe } = sentinelProbe([variant({ desktop_windows: windows('window|824|8|500|300|1') })]);
  const { factory, sent } = recordingFactory();
  let started = 0;
  const lane = new TargetLane({ desktopState: { ssh: 'op@mac' },
    secrets: { login } },
  (...args) => { started++; return factory(...args); }, { desktopProbe: probe });
  t.after(() => lane.close());
  await assert.rejects(lane.execute([{ action: 'type_secret', ref: 'login' }]), error => {
    assert.equal(error.code, HUMAN_CONSENT_REQUIRED_CODE);
    assert.deepEqual(error.data, { reason: 'human_consent_required', owner: 'CoreServicesUIAgent', kind: 'gatekeeper' });
    assert.ok(!JSON.stringify({ message: error.message, data: error.data, responses: error.responses }).includes(secret));
    return true;
  });
  assert.equal(started, 0);
  assert.deepEqual(sent, []);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'the secret was never resolved');

  // A dialog that appears while the provider runs is refused before any key.
  const later = sentinelProbe([variant(), variant({ desktop_windows: windows('window|824|8|500|300|1') })]);
  const typed = recordingFactory();
  const slow = new TargetLane({ desktopState: { ssh: 'op@mac' }, secrets: { login } }, typed.factory,
    { desktopProbe: later.probe });
  t.after(() => slow.close());
  slow.desktop.ttlMs = 0;
  slow.acquire('0a0a0a0a-0b0b-4c0c-8d0d-0e0e0e0e0e0e');
  await assert.rejects(slow.execute([{ action: 'type_secret', ref: 'login' }]),
    error => error.code === HUMAN_CONSENT_REQUIRED_CODE && isPreAdmissionRefusal(error));
  assert.deepEqual(typed.sent, []);
  assert.equal(later.calls.length, 2, 'the sentinel was read again after the provider');
  assert.ok(!slow.releasing && slow.owner, 'the lease survives');
});

test('Host element actions never press or focus under a consent dialog', async t => {
  const { probe } = sentinelProbe([variant({ desktop_windows: windows('window|824|8|500|300|1') })]);
  const { factory, sent } = recordingFactory();
  let started = 0;
  const lane = new TargetLane({ desktopState: { ssh: 'op@mac' }, hostHelper: { sshHost: 'op@mac' } },
    (...args) => { started++; return factory(...args); }, { desktopProbe: probe });
  t.after(() => lane.close());
  for (const action of ['click_element', 'focus_element']) {
    await assert.rejects(lane.execute([{ action, ref: 'ax:824:0.0.1' }]),
      error => error.code === HUMAN_CONSENT_REQUIRED_CODE && error.data.owner === 'CoreServicesUIAgent');
  }
  assert.equal(started, 0);
  assert.deepEqual(sent, []);
});

test('lane caches a clear state, re-probes after the TTL, and lets input through', async t => {
  let now = 0;
  const { probe, calls } = sentinelProbe([variant()]);
  const { factory, sent } = recordingFactory();
  const lane = new TargetLane({ desktopState: { ssh: 'op@mac' } }, factory, { desktopProbe: probe });
  lane.desktop.now = () => now;
  t.after(() => lane.close());
  await lane.execute([{ action: 'key_tap', key: 'a' }]);
  await lane.execute([{ action: 'key_tap', key: 'b' }]);
  assert.equal(calls.length, 1);
  now = 2500;
  const [, health] = await lane.execute([{ action: 'key_tap', key: 'c' }, { action: 'health' }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(sent, ['key_tap', 'key_tap', 'key_tap', 'health']);
  assert.equal(health.result.desktop_state.sentinel, 'ok');
  assert.equal(health.result.desktop_state.other_input_owner.owner, 'Chrome Remote Desktop');
});

test('an unreachable or slow sentinel is unknown: input proceeds, failures back off', async t => {
  const unreachable = sentinelProbe([Object.assign(new Error('ssh failed'), { code: 'preflight_unreachable' })]);
  const logs = [];
  const { factory, sent } = recordingFactory();
  const lane = new TargetLane({ desktopState: { ssh: 'op@mac' } }, factory, { desktopProbe: unreachable.probe,
    log: message => logs.push(message) });
  t.after(() => lane.close());
  await lane.execute([{ action: 'mouse_click', x: 1, y: 1 }]);
  const [health] = await lane.execute([{ action: 'mouse_move', x: 2, y: 2 }, { action: 'health' }])
    .then(responses => responses.slice(1));
  assert.deepEqual(sent, ['mouse_click', 'mouse_move', 'health']);
  assert.equal(unreachable.calls.length, 1, 'a failed probe is not retried per action');
  assert.deepEqual([health.result.desktop_state.sentinel, health.result.desktop_state.reason], ['unknown', 'probe_failed']);
  assert.equal(logs.length, 1);

  const slow = new DesktopSentinel({ ssh: 'op@mac', timeoutMs: 20,
    probe: () => delay(200).then(() => variant({ ioreg_console: LOCKED })) });
  assert.deepEqual([(await slow.read()).sentinel, (await slow.read()).reason], ['unknown', 'probe_timeout']);
});

test('without a destination nothing is probed or refused and observations say not_configured', async t => {
  const { factory, sent } = recordingFactory();
  const lane = new TargetLane({}, factory);
  t.after(() => lane.close());
  assert.equal(lane.desktop, null);
  const [, shot] = await lane.execute([{ action: 'mouse_click', x: 1, y: 1 }, { action: 'screenshot' }]);
  assert.deepEqual(sent, ['mouse_click', 'screenshot']);
  assert.deepEqual([shot.result.desktop_state.sentinel, shot.result.desktop_state.reason], ['unknown', 'not_configured']);
});

test('a lock reaches the MCP result as target_locked with its data, through the broker socket', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-desk-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 'broker.sock');
  const { probe } = sentinelProbe([variant({ ioreg_console: LOCKED })]);
  const { factory, sent } = recordingFactory();
  const broker = await createBroker({ socketPath, factory, desktopProbe: probe,
    config: { targets: { desktop: { desktopState: { ssh: 'op@mac' } } } } });
  t.after(() => broker.close());
  const client = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(() => client.close());
  await client.opened;
  const session = new McpSession(client);
  const result = await session.command({ action: 'key_type', text: 'hello' });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.error, { code: TARGET_LOCKED_CODE, message: 'Target screen is locked',
    data: { reason: 'target_locked', console: 'locked' } });
  const queued = await session.queue({ actions: [{ action: 'mouse_click', x: 1, y: 1 }] });
  assert.equal(queued.structuredContent.error.code, TARGET_LOCKED_CODE);
  assert.equal(queued.structuredContent.completed, 0);
  // The refusal kept the lease; observation still works and says why.
  const health = await session.command({ action: 'health' });
  assert.match(health.content.map(item => item.text).join('\n'), /desktop state: screen locked/);
  assert.deepEqual(sent, ['health']);
  assert.equal(broker.status().targets.desktop.desktop_state.sentinel, 'ok');
  await assert.rejects(createBroker({ socketPath: path.join(dir, 'bad.sock'),
    config: { targets: { desktop: { desktopState: { ssh: '-oX' } } } } }), /desktopState/);
});

test('a hanging probe never runs a short batch into its deadline or past it', async t => {
  const { factory, sent } = recordingFactory();
  const lane = new TargetLane({ desktopState: { ssh: 'op@mac' } }, factory,
    { desktopProbe: () => new Promise(() => {}) });
  t.after(() => lane.close());
  lane.acquire('owner');
  // A 3 s budget leaves 1.5 s of work; the probe may take only half of it.
  const [click] = await lane.execute([{ action: 'mouse_click', x: 1, y: 1 }], { timeoutMs: 3000 });
  assert.equal(click.result.detail, 'mouse_click done');
  assert.equal(lane.owner, 'owner');
  assert.ok(!lane.releasing, 'an unknown state did not retire the lane');
  // Health waits for the probe only within its own deadline.
  const started = performance.now();
  const [health] = await lane.execute([{ action: 'health' }], { timeoutMs: 400 });
  assert.ok(performance.now() - started < 400, 'health answered inside its deadline');
  assert.equal(health.result.desktop_state.reason, 'probe_timeout');
  assert.deepEqual(sent, ['mouse_click', 'health']);
});

test('a screenshot never reports an expired sample as the current desktop state', async t => {
  let now = 0;
  const { probe, calls } = sentinelProbe([variant({ desktop_windows: windows(UNC_ALERT) }),
    () => delay(50).then(() => variant())]);
  const { factory } = recordingFactory();
  const lane = new TargetLane({ desktopState: { ssh: 'op@mac' } }, factory, { desktopProbe: probe });
  lane.desktop.now = () => now;
  t.after(() => lane.close());
  await assert.rejects(lane.execute([{ action: 'mouse_click', x: 1, y: 1 }]),
    error => error.code === HUMAN_CONSENT_REQUIRED_CODE);
  // A human answers the dialog; a minute later the agent looks again. The
  // probe this screenshot starts has not answered when the capture returns.
  now = 60000;
  const [shot] = await lane.execute([{ action: 'screenshot' }]);
  assert.deepEqual([shot.result.desktop_state.sentinel, shot.result.desktop_state.reason], ['unknown', 'stale']);
  assert.equal(shot.result.desktop_state.consent_dialog, 'unknown');
  await lane.desktop.inflight;
  assert.equal(calls.length, 2);
  const [next] = await lane.execute([{ action: 'screenshot' }]);
  assert.equal(next.result.desktop_state.consent_dialog, null);
});
