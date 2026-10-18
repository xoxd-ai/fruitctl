// SPDX-License-Identifier: MIT
// Live gate (b): Accessibility element actions on the Host route. For a
// popover, a sheet and a menu-bar extra the operator sets the surface up; the
// kit takes ax_snapshot, picks one element inside that surface, sends
// click_element and requires the Host's own verification, the surface it
// names, a changed frame and a fresh snapshot afterwards.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { errorCode, imageOf, main } from './live_kit.mjs';

// `inside` is the AX role of the container the element must sit in; a
// menu-bar extra is the AXMenuBarItem itself. `accept` is the Host's surface.
export const SURFACES = Object.freeze([
  { id: 'popover', inside: 'AXPopover', role: 'AXButton', accept: ['popover'], snapshot: { depth: 10 },
    setup: 'Open a popover that contains a button and leave it open. For example, Notes: click the Aa ' +
      'toolbar button (the text-style popover).' },
  { id: 'sheet', inside: 'AXSheet', role: 'AXButton', label: /^Cancel$/, accept: ['sheet'], snapshot: { depth: 10 },
    setup: 'Open a sheet with a Cancel button and leave it open. For example, TextEdit: new document, then ' +
      'Command-S so the Save sheet is attached.' },
  { id: 'menu_extra', role: 'AXMenuBarItem', label: /Control Center|Clock|Wi.?Fi|Battery|Sound/i,
    accept: ['menu_extra', 'control_center'], snapshot: { menu_extras: true, focused_app: false, depth: 4 },
    setup: 'Make sure the menu bar is visible (no full-screen app). Nothing else to open.',
    dismiss: { action: 'key_tap', key: 'escape' } },
]);

/** Snapshot nodes inside `inside` (or anywhere) matching role and label. */
export function candidates(snapshot, { inside, role, label }) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const byRef = new Map(nodes.map(node => [node.ref, node]));
  const within = node => {
    if (!inside) return true;
    for (let parent = byRef.get(node.parent), hops = 0; parent && hops < 64; parent = byRef.get(parent.parent), hops++) {
      if (parent.role === inside || parent.subrole === inside) return true;
    }
    return false;
  };
  return nodes.filter(node => node.role === role && node.frame && within(node) &&
    (!label || label.test(node.label ?? '')));
}

const frameHash = result => {
  const image = imageOf(result);
  return image ? createHash('sha256').update(image.bytes).digest('hex') : null;
};

export async function axGate({ call, operator, ask, verdict, surfaces = SURFACES }) {
  const health = await call({ action: 'health' }, 'health');
  verdict.check('host_route', health?.structuredContent?.route === 'host', health?.structuredContent?.route ?? null, 'host');
  for (const surface of surfaces) {
    if (await operator(`${surface.id}:setup`, surface.setup) === 'skipped') {
      verdict.skip(surface.id, 'operator skipped');
      continue;
    }
    const snap = await call({ action: 'ax_snapshot', ...surface.snapshot }, `ax_snapshot-${surface.id}`);
    const snapshot = snap?.structuredContent?.ax_snapshot;
    if (!verdict.check(`${surface.id}_snapshot`, !snap.isError && snapshot, errorCode(snap), 'ax_snapshot')) continue;
    let found = candidates(snapshot, surface);
    if (found.length > 1) {
      // The operator picks the intended element; the list holds roles and labels only.
      process.stderr.write(found.slice(0, 20).map((node, index) => `  ${index + 1}. ${node.ref} ${node.role} ` +
        `${JSON.stringify(node.label ?? '')}`).join('\n') + '\n');
      const pick = Number(await ask(`Pick the ${surface.id} element to click (1-${Math.min(found.length, 20)}):`));
      found = Number.isInteger(pick) && pick >= 1 && pick <= Math.min(found.length, 20) ? [found[pick - 1]] : [];
    }
    if (!verdict.check(`${surface.id}_element_found`, found.length === 1, found.length, 1)) continue;
    const [element] = found;
    const before = frameHash(await call({ action: 'screenshot', format: 'png' }, `before-${surface.id}`));
    const clicked = await call({ action: 'click_element', ref: element.ref }, `click_element-${surface.id}`);
    const outcome = clicked?.structuredContent?.ax_action;
    verdict.check(`${surface.id}_click_ok`, !clicked.isError, errorCode(clicked), 'no error');
    verdict.check(`${surface.id}_host_verified`, outcome?.verified === true,
      outcome ? { path: outcome.path, verified: outcome.verified } : null, 'verified true');
    verdict.check(`${surface.id}_surface`, surface.accept.includes(outcome?.surface), outcome?.surface ?? null, surface.accept);
    const after = frameHash(await call({ action: 'screenshot', format: 'png' }, `after-${surface.id}`));
    verdict.check(`${surface.id}_frame_changed`, Boolean(before && after && before !== after), { before, after }, 'different');
    const post = await call({ action: 'ax_snapshot', ...surface.snapshot }, `ax_snapshot-${surface.id}-after`);
    verdict.check(`${surface.id}_post_snapshot`, !post.isError, errorCode(post), 'ax_snapshot after the action');
    if (surface.dismiss) await call(surface.dismiss, `dismiss-${surface.id}`);
    const seen = (await ask(`Did clicking ${JSON.stringify(element.label ?? element.ref)} take effect on the ` +
      `target's screen? (y/n)`)).toLowerCase();
    verdict.check(`${surface.id}_operator_confirmed`, seen === 'y', seen, 'y');
    await operator(`${surface.id}:restore`, 'Close anything the action left open on the target.');
  }
  return { scope: 'Host-route ax_snapshot and click_element on a popover, a sheet and a menu-bar extra' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main({ name: 'ax', file: 'live_ax.mjs', gate: axGate });
}
