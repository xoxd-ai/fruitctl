// SPDX-License-Identifier: MIT
// Live gate (c): UTF-8 clipboard. `paste` of emoji/CJK text must round-trip
// through clipboard_read byte for byte; a profile with clipboard.read off must
// refuse clipboard_read before admission; and D29 paste routing (key_type of
// text the US keymap cannot type) must restore the clipboard it borrowed.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { errorCode, main } from './live_kit.mjs';

export const SAMPLE_PREFIX = 'fruitctl-utf8 ✓ 🍎👩🏽‍💻 日本語 中文 한국어 Ünïcödé';

function clipboardText(result) {
  const clipboard = result?.structuredContent?.clipboard;
  return clipboard && typeof clipboard.text === 'string' ? clipboard.text : null;
}

export async function clipboardGate({ call, calls, operator, verdict, values = {}, nonce = randomBytes(4).toString('hex') }) {
  const sample = `${SAMPLE_PREFIX} ${nonce}`;
  await call({ action: 'health' }, 'health');
  await operator('editor', 'On the target, open TextEdit with a new plain-text document (Format > Make Plain ' +
    'Text) and leave its text area focused. Its content will be replaced.');
  const pasted = await call({ action: 'paste', text: sample }, 'paste-sample');
  verdict.check('paste_ok', !pasted.isError, errorCode(pasted), 'no error');
  const read = await call({ action: 'clipboard_read' }, 'clipboard_read-sample');
  verdict.check('clipboard_read_ok', !read.isError, errorCode(read), 'no error (profile clipboard.read: true)');
  verdict.check('utf8_round_trip', clipboardText(read) === sample, clipboardText(read), sample);
  verdict.check('utf8_encoding', read?.structuredContent?.clipboard?.encoding === 'utf8',
    read?.structuredContent?.clipboard?.encoding ?? null, 'utf8 (ExtendedClipboard)');
  // fresh: the server answered the read; otherwise it is this connection's cache.
  verdict.check('read_from_target', read?.structuredContent?.clipboard?.fresh === true,
    read?.structuredContent?.clipboard?.fresh ?? null, true);
  await call({ action: 'screenshot', format: 'png' }, 'screenshot-sample');

  // D29: key_type borrows the clipboard for unmappable text and puts it back.
  const saved = `fruitctl-saved ${nonce}`;
  await call({ action: 'paste', text: saved }, 'paste-saved');
  const routed = await call({ action: 'key_type', text: ` é→🍎 ${nonce}` }, 'key_type-routed');
  verdict.check('routed_key_type_ok', !routed.isError, errorCode(routed), 'no error (profile input.pasteUnmappable: true)');
  verdict.check('routed_via_paste', routed?.structuredContent?.kind === 'paste', routed?.structuredContent?.kind ?? null, 'paste');
  const restored = await call({ action: 'clipboard_read' }, 'clipboard_read-restored');
  verdict.check('clipboard_restored', clipboardText(restored) === saved, clipboardText(restored), saved);
  verdict.check('restored_read_from_target', restored?.structuredContent?.clipboard?.fresh === true,
    restored?.structuredContent?.clipboard?.fresh ?? null, true);
  await call({ action: 'screenshot', format: 'png' }, 'screenshot-routed');

  const denied = calls.denied?.call;
  if (denied) {
    const refused = await denied({ action: 'clipboard_read' }, 'clipboard_read-disabled-profile');
    verdict.check('read_disabled_refused', errorCode(refused) === 'clipboard_read_disabled', errorCode(refused),
      'clipboard_read_disabled');
    verdict.check('read_disabled_no_text', clipboardText(refused) === null, clipboardText(refused), null);
  } else {
    verdict.skip('read_disabled_refused', 'no --read-disabled-target profile given');
  }
  await operator('cleanup', 'Close the TextEdit document without saving.');
  return { sample, scope: 'ExtendedClipboard UTF-8 paste/read, clipboard.read policy and D29 restore' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main({ name: 'clipboard', file: 'live_clipboard.mjs', gate: clipboardGate,
    options: { 'read-disabled-target': { type: 'string' } },
    sessions: [{ option: 'read-disabled-target', role: 'denied' }] });
}
