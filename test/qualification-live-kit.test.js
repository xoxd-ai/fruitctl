// SPDX-License-Identifier: MIT
// Offline checks that the attended live kit's verdicts cannot pass a broken
// target: each gate runs its real logic against a scripted MCP surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Verdict, recorder } from '../scripts/qualification/live_kit.mjs';
import { desktopStateGate } from '../scripts/qualification/live_desktop_state.mjs';
import { clipboardGate } from '../scripts/qualification/live_clipboard.mjs';
import { candidates } from '../scripts/qualification/live_ax.mjs';
import { secretJournalChecks } from '../scripts/qualification/live_type_secret.mjs';
import { Journal, redactParams } from '../lib/broker/journal.mjs';

const ok = structuredContent => ({ content: [{ type: 'text', text: 'OK' }], structuredContent });
const refused = (code, data) => ({ isError: true, content: [{ type: 'text', text: `Error: ${code}` }],
  structuredContent: { error: { code, message: code, ...(data ? { data } : {}) } } });
const CLEAR = { sentinel: 'ok', locked: false, display_asleep: false, consent_dialog: null };

// A target whose blocking state follows the operator's steps.
function sentinelTarget({ admitWhileLocked = false } = {}) {
  let state = 'clear';
  const desktop = () => ({ ...CLEAR,
    ...(state === 'lock' ? { locked: true } : state === 'display_sleep' ? { display_asleep: true } : {}),
    ...(state === 'consent_dialog' ? { consent_dialog: { owner: 'SecurityAgent', kind: 'authorization' } } : {}) });
  const raw = async (tool, args) => {
    if (args.action === 'health') return ok({ route: 'host', desktop_state: desktop() });
    if (args.action === 'screenshot') return ok({ scaledWidth: 1280, scaledHeight: 720 });
    if (state === 'lock' && !admitWhileLocked) return refused('target_locked', { reason: 'target_locked' });
    if (state === 'display_sleep') return refused('display_asleep', { reason: 'display_asleep' });
    if (state === 'consent_dialog') {
      return refused('human_consent_required', { reason: 'human_consent_required', owner: 'SecurityAgent', kind: 'authorization' });
    }
    return ok({});
  };
  const operator = async id => { const [name, phase] = id.split(':'); state = phase === 'block' ? name : 'clear'; return 'done'; };
  return { call: recorder(raw).call, operator };
}

test('desktop-state gate passes only when every real state is reported, refused with its code and recovered', async () => {
  const verdict = new Verdict();
  await desktopStateGate({ ...sentinelTarget(), verdict, sleep: async () => {} });
  assert.equal(verdict.status, 'passed', JSON.stringify(verdict.failures()));

  const broken = new Verdict();
  await desktopStateGate({ ...sentinelTarget({ admitWhileLocked: true }), verdict: broken, sleep: async () => {} });
  assert.deepEqual([broken.status, broken.failures()], ['failed', ['lock_refused']]);
});

test('clipboard gate fails when paste routing does not restore the borrowed clipboard', async () => {
  let clipboard = '';
  const raw = async (tool, args) => {
    if (args.action === 'paste') { clipboard = args.text; return ok({}); }
    if (args.action === 'key_type') { clipboard = args.text; return ok({ kind: 'paste' }); } // never restored
    if (args.action === 'clipboard_read') return ok({ clipboard: { text: clipboard, encoding: 'utf8', fresh: true } });
    return ok({});
  };
  const verdict = new Verdict();
  await clipboardGate({ call: recorder(raw).call, calls: {}, operator: async () => 'done', verdict, nonce: 'n0' });
  assert.equal(verdict.checks.find(check => check.id === 'utf8_round_trip').pass, true);
  assert.deepEqual(verdict.failures(), ['clipboard_restored']);
  assert.equal(verdict.status, 'failed');
});

test('AX candidates are taken only from inside the requested surface', () => {
  const snapshot = { nodes: [
    { ref: 'ax:1:0', role: 'AXWindow', frame: {} },
    { ref: 'ax:1:0.0', parent: 'ax:1:0', role: 'AXButton', label: 'Cancel', frame: {} },
    { ref: 'ax:1:0.1', parent: 'ax:1:0', role: 'AXSheet', frame: {} },
    { ref: 'ax:1:0.1.0', parent: 'ax:1:0.1', role: 'AXButton', label: 'Cancel', frame: {} },
    { ref: 'ax:1:0.1.1', parent: 'ax:1:0.1', role: 'AXButton', label: 'Save', frame: {} },
  ] };
  assert.deepEqual(candidates(snapshot, { inside: 'AXSheet', role: 'AXButton', label: /^Cancel$/ }).map(node => node.ref),
    ['ax:1:0.1.0']);
});

test('type_secret journal check passes a broker-written journal and fails one holding the canary', async () => {
  const dir = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fruitctl-live-kit-'));
  try {
    const journal = new Journal({ dir: path.join(dir, 'journal') });
    const session = '0f0e0d0c-0b0a-4908-8706-050403020100', canary = 'fruitctl-canary-7f3a9c21';
    const step = { action: 'type_secret', ref: 'qual-canary', provider: 'file', length_class: '17-32' };
    await journal.append([{ session, target: 'pzm', method: 'type_secret', params: redactParams(step),
      result: { outcome: 'ok' } }]);
    await journal.flush();
    const [file] = await readdir(path.join(dir, 'journal'));
    const text = await readFile(path.join(dir, 'journal', file), 'utf8');
    assert.equal(secretJournalChecks(text, canary).status, 'passed');
    const leaked = text.replace('qual-canary', canary);
    assert.deepEqual(secretJournalChecks(leaked, canary).failures(), ['secret_absent_from_journal']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
