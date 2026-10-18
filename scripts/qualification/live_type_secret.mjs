// SPDX-License-Identifier: MIT
// Live gate (d): type_secret end to end with a `file` provider, then the
// journal redaction check. The secret is a throwaway canary the operator
// writes on the broker host; the kit never learns it during the live run.
// Proof that the right value was typed comes from the broker itself: after
// the typed text is copied, clipboard_read must be withheld (`redacted`),
// which happens only when the clipboard contains a declared secret.
//
// Journal mode runs afterwards on the broker host, as the broker user:
//   --check-journal FILE --secret-file PATH
// It verifies the hash chain, that the value appears nowhere in the file and
// that every type_secret record keeps only {ref, x, y, provider, length_class}.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { verifyJournal } from '../../lib/broker/journal.mjs';
import { Verdict, errorCode, main } from './live_kit.mjs';

const SECRET_FIELDS = new Set(['ref', 'x', 'y', 'provider', 'length_class']);

export async function typeSecretGate({ call, operator, verdict, values }) {
  const ref = values.ref;
  if (!ref) throw new Error('--ref names the allowlisted canary secret');
  await call({ action: 'health' }, 'health');
  await operator('editor', 'On the target, open TextEdit with a new plain-text document and leave its text ' +
    'area focused (empty). The canary will be typed there.');
  const unknown = await call({ action: 'type_secret', ref: 'fruitctl-not-allowlisted' }, 'type_secret-unlisted');
  verdict.check('unlisted_ref_refused', errorCode(unknown) === 'secret_ref_not_allowed', errorCode(unknown),
    'secret_ref_not_allowed');
  const typed = await call({ action: 'type_secret', ref }, 'type_secret-canary');
  verdict.check('type_secret_ok', !typed.isError, errorCode(typed), 'no error');
  verdict.check('result_echoes_nothing', !/text|value|secret/i.test(Object.keys(typed?.structuredContent ?? {}).join(' ')),
    Object.keys(typed?.structuredContent ?? {}), 'no text/value/secret fields');
  await call({ action: 'key_combo', keys: ['cmd', 'a'] }, 'select-all');
  await call({ action: 'key_combo', keys: ['cmd', 'c'] }, 'copy');
  const read = await call({ action: 'clipboard_read' }, 'clipboard_read-canary');
  verdict.check('typed_value_is_declared_secret', read?.structuredContent?.clipboard?.redacted === true,
    read?.structuredContent?.clipboard ? { redacted: read.structuredContent.clipboard.redacted ?? false } : errorCode(read),
    'clipboard withheld as redacted (needs clipboard.read: true)');
  // Leave neither the field nor the target clipboard holding the canary.
  await call({ action: 'key_tap', key: 'backspace' }, 'clear-field');
  await call({ action: 'paste', text: 'fruitctl-cleared' }, 'overwrite-clipboard');
  await call({ action: 'key_combo', keys: ['cmd', 'a'] }, 'select-all-cleanup');
  await call({ action: 'key_tap', key: 'backspace' }, 'clear-field-cleanup');
  await call({ action: 'screenshot', format: 'png' }, 'screenshot-cleared');
  await operator('cleanup', 'Close the TextEdit document without saving. Then run journal mode on the broker ' +
    'host against the newest journal/<session>.jsonl (ls -t).');
  return { ref, scope: 'type_secret file provider, refusal of an unlisted ref and broker clipboard redaction' };
}

/** Pure check of one journal's text against the canary value. */
export function secretJournalChecks(text, secret, verdict = new Verdict()) {
  verdict.check('secret_absent_from_journal', !text.includes(secret), text.includes(secret) ? 'present' : 'absent', 'absent');
  const records = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const typed = records.filter(record => record.method === 'type_secret');
  verdict.check('type_secret_recorded', typed.length > 0, typed.length, '>= 1');
  for (const record of typed) {
    const extra = Object.keys(record.params ?? {}).filter(key => !SECRET_FIELDS.has(key));
    verdict.check(`seq_${record.seq}_params_bounded`, extra.length === 0, extra, 'only ref, x, y, provider, length_class');
  }
  return verdict;
}

async function journalMode() {
  const { values } = parseArgs({ options: { 'check-journal': { type: 'string' }, 'secret-file': { type: 'string' } } });
  const file = values['check-journal'], secretFile = values['secret-file'];
  if (!file || !secretFile) throw new Error('Usage: live_type_secret.mjs --check-journal FILE --secret-file PATH');
  const verdict = new Verdict();
  const chain = await verifyJournal(file);
  verdict.check('journal_chain_verifies', chain.ok, chain.ok ? { records: chain.records } : chain, 'ok');
  // The provider strips one trailing newline; so does this check.
  const secret = (await readFile(secretFile, 'utf8')).replace(/\r?\n$/, '');
  // A short canary could occur in the journal by chance and prove nothing.
  if (secret.length < 16) throw new Error('Use a canary of at least 16 characters');
  secretJournalChecks(await readFile(file, 'utf8'), secret, verdict);
  process.stdout.write(JSON.stringify({ gate: 'type-secret-journal', status: verdict.status, file,
    checks: verdict.checks, failures: verdict.failures() }, null, 2) + '\n');
  return verdict.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check-journal')) {
    journalMode().then(code => { process.exitCode = code; },
      error => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
  } else {
    main({ name: 'type-secret', file: 'live_type_secret.mjs', gate: typeSecretGate,
      options: { ref: { type: 'string' } } });
  }
}
