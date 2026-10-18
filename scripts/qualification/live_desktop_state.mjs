// SPDX-License-Identifier: MIT
// Live gate (a): desktop-state sentinel on a real lock, a real display sleep
// and a real modal dialog. For each state the broker must report it in
// `health` and refuse an input batch with its typed code before anything is
// sent; after the operator clears it, the same input must be admitted again.
// The input probe is one mouse_move to the display centre: harmless if the
// sentinel ever let it through.
import { pathToFileURL } from 'node:url';
import { SENTINEL_SETTLE_MS, errorCode, main } from './live_kit.mjs';

export const STATES = Object.freeze([
  { id: 'lock', code: 'target_locked', field: 'locked',
    block: 'On the target, lock the screen (Control-Command-Q). Do not unlock yet.',
    clear: 'Unlock the target at its own keyboard or through your attended viewer.' },
  { id: 'display_sleep', code: 'display_asleep', field: 'display_asleep',
    block: 'On the target, in your own Terminal, run: pmset displaysleepnow\n' +
      'The kit never runs it. If the target locks on display sleep, this step reports target_locked.',
    clear: 'Wake the display with a key press at the target (unlock if it locked).' },
  { id: 'consent_dialog', code: 'human_consent_required', field: 'consent_dialog',
    block: 'On the target, raise a real system dialog and leave it open. For example, in Terminal:\n' +
      '  osascript -e \'do shell script "true" with administrator privileges\'\n' +
      '(SecurityAgent), or a first-use TCC consent prompt (UserNotificationCenter).',
    clear: 'Answer the dialog yourself (Cancel or Don\'t Allow) so it closes.' },
]);

function stateOf(result) { return result?.structuredContent?.desktop_state ?? null; }

function blocked(state, field) {
  if (field === 'consent_dialog') return Boolean(state?.consent_dialog && typeof state.consent_dialog === 'object');
  return state?.[field] === true;
}

function clear(state) {
  return state?.sentinel === 'ok' && state.locked === false && state.display_asleep === false &&
    state.consent_dialog === null;
}

export async function desktopStateGate({ call, operator, verdict, sleep, settleMs = SENTINEL_SETTLE_MS }) {
  const health = await call({ action: 'health' }, 'health-baseline');
  const baseline = stateOf(health);
  verdict.check('sentinel_configured', baseline?.sentinel === 'ok', baseline?.sentinel ?? null, 'ok');
  verdict.check('baseline_clear', clear(baseline), baseline, 'locked/display_asleep false, consent_dialog null');
  const shot = await call({ action: 'screenshot' }, 'screenshot-baseline');
  const width = shot?.structuredContent?.scaledWidth, height = shot?.structuredContent?.scaledHeight;
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error('Baseline screenshot reported no geometry');
  const probe = { action: 'mouse_move', x: Math.floor(width / 2), y: Math.floor(height / 2) };
  const admitted = await call(probe, 'probe-baseline');
  verdict.check('baseline_input_admitted', !admitted.isError, errorCode(admitted), 'no error');
  for (const state of STATES) {
    if (await operator(`${state.id}:block`, state.block) === 'skipped') continue;
    await sleep(settleMs);
    const during = stateOf(await call({ action: 'health' }, `health-${state.id}`));
    verdict.check(`${state.id}_reported`, blocked(during, state.field), during, `${state.field} reported`);
    await call({ action: 'screenshot' }, `screenshot-${state.id}`); // Observation is never refused.
    const refused = await call(probe, `probe-${state.id}`);
    verdict.check(`${state.id}_refused`, errorCode(refused) === state.code, errorCode(refused), state.code);
    if (state.field === 'consent_dialog') {
      const data = refused?.structuredContent?.error?.data;
      verdict.check('consent_dialog_owner_named', typeof data?.owner === 'string' && typeof data?.kind === 'string',
        data ?? null, '{owner, kind}');
    }
    // An uncleared state would block every later probe; stop measuring.
    if (await operator(`${state.id}:clear`, state.clear) === 'skipped') break;
    await sleep(settleMs);
    const after = stateOf(await call({ action: 'health' }, `health-${state.id}-cleared`));
    verdict.check(`${state.id}_cleared`, clear(after), after, 'clear');
    const recovered = await call(probe, `probe-${state.id}-cleared`);
    verdict.check(`${state.id}_input_recovered`, !recovered.isError, errorCode(recovered), 'no error');
  }
  await call({ action: 'screenshot' }, 'screenshot-final');
  return { scope: 'Broker desktop-state sentinel refusals and recovery on a real target; no Host, AX or overlay claim' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main({ name: 'desktop-state', file: 'live_desktop_state.mjs', gate: desktopStateGate });
}
