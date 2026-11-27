// SPDX-License-Identifier: MIT
// TIN-5385: key names are resolved or refused before anything is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKeyNames, validateActionParameters, INPUT_REFUSED_CODE } from '../tools/index.js';

test('punctuation key names become their characters', () => {
  assert.equal(normalizeKeyNames({ action: 'key_combo', key: 'cmd+comma' }).key, 'cmd+,');
  assert.equal(normalizeKeyNames({ action: 'key_combo', key: 'cmd+shift+Period' }).key, 'cmd+shift+.');
  assert.deepEqual(normalizeKeyNames({ action: 'key_combo', keys: ['cmd', 'slash'] }).keys, ['cmd', '/']);
  assert.equal(normalizeKeyNames({ action: 'key_tap', key: 'semicolon' }).key, ';');
  assert.equal(normalizeKeyNames({ action: 'key_tap', key: 'escape' }).key, 'escape');
  const typed = { action: 'key_type', text: 'comma' };
  assert.equal(normalizeKeyNames(typed), typed);
});

test('known names and single characters pass; an unknown name is a typed refusal', () => {
  for (const action of [
    { action: 'key_combo', key: 'cmd+,' }, { action: 'key_combo', key: 'cmd+alt+n' },
    { action: 'key_combo', keys: ['cmd', 'shift', '3'] }, { action: 'key_tap', key: 'escape' },
    { action: 'key_tap', key: '+' }, { action: 'hold_key', key: 'shift', duration_ms: 100 },
    normalizeKeyNames({ action: 'key_combo', key: 'cmd+comma' }),
  ]) assert.doesNotThrow(() => validateActionParameters(action), JSON.stringify(action));
  for (const action of [
    { action: 'key_combo', key: 'cmd+comma' }, { action: 'key_combo', key: 'cmd++' },
    { action: 'key_combo', keys: ['cmd', 'nosuchkey'] }, { action: 'key_tap', key: 'enterr' },
  ]) {
    assert.throws(() => validateActionParameters(action), error =>
      error.code === INPUT_REFUSED_CODE && error.data.reason === 'unknown_key', JSON.stringify(action));
  }
});
