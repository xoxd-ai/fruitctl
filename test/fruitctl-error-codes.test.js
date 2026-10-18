// SPDX-License-Identifier: MIT
// One error-code register for the daemon, FruitctlHost, broker, relay and
// MCP server: every code raised in source is listed in docs/architecture.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TYPED_REFUSAL_CODES, DESKTOP_REFUSAL_CODES, BRIDGE_ERROR_CODES } from '../lib/mcp/capabilities.js';

const root = path.resolve(import.meta.dirname, '..');
const sources = (dir, pattern) => fs.readdirSync(path.join(root, dir), { recursive: true })
  .filter(name => pattern.test(name)).map(name => path.join(dir, name));

function raisedCodes() {
  const codes = new Map();
  const add = (code, file) => codes.set(code, codes.get(code) ?? file);
  for (const file of [...sources('lib/broker', /\.m?js$/), ...sources('lib/mcp', /\.m?js$/),
    ...sources('ClaudeKVM-Daemon', /\.swift$/), ...sources('FruitctlHost', /\.swift$/)]) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [code] of text.matchAll(/-32\d{3}\b/g)) add(code, file);
    if (file.endsWith('.swift')) continue;
    for (const pattern of [/\bcode\s*[:=]\s*(?:[^,;}\n]*\|\|\s*)?'([a-z][a-z0-9_]*)'/g,
      /_CODE\s*=\s*'([a-z][a-z0-9_]*)'/g,
      /\b(?:preAdmissionRefusal|refusal|typedError)\((?:[^()]|\([^()]*\))*?,\s*'([a-z][a-z0-9_]*)'\s*(?:,[^)]*)?\)/g]) {
      for (const [, code] of text.matchAll(pattern)) add(code, file);
    }
  }
  for (const code of [...TYPED_REFUSAL_CODES, ...DESKTOP_REFUSAL_CODES, ...BRIDGE_ERROR_CODES]) add(code, 'capabilities.js');
  return codes;
}

test('every error code raised in source is in the architecture register', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/architecture.md'), 'utf8');
  const section = doc.split('\n## Error codes\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'docs/architecture.md has an Error codes section');
  const registered = new Set();
  for (const row of section.split('\n').filter(line => line.startsWith('| `'))) {
    for (const [, code] of row.split('|')[1].matchAll(/`([^`]+)`/g)) {
      assert.ok(!registered.has(code), `${code} is registered once`);
      registered.add(code);
    }
  }
  const codes = raisedCodes();
  assert.ok(codes.size > 30, 'the scan found the known codes');
  const missing = [...codes].filter(([code]) => !registered.has(code)).map(([code, file]) => `${code} (${file})`);
  assert.deepEqual(missing, []);
});
