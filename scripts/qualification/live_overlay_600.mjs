// SPDX-License-Identifier: MIT
// Live gate (e): the 600-frame Host exclusion gate (D41/D42). Runs the
// existing overlay gate (overlay_exclusion_gate.mjs, #114/#123) on the Host
// profile with the edge-band detector, and takes its positive control itself:
// a raw VNC screenshot through a second, raw-route profile of the same Mac,
// captured mid-series while the Host lease (and so its overlay) is up. Raw
// VNC does not exclude the overlay, so that frame must show it on every edge
// while every Host frame must not. Observation only on both sessions.
import { writeFile, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runGate } from './overlay_exclusion_gate.mjs';
import { imageOf, main } from './live_kit.mjs';

export async function overlay600Gate({ clients, calls, output, verdict, values, operator }) {
  const control = calls.control;
  if (!control) throw new Error('--control-target names a raw-route profile of the same Mac');
  const frames = Number(values.frames ?? 600), controlAt = Number(values['control-at'] ?? 300);
  if (!Number.isSafeInteger(controlAt) || controlAt < 1 || controlAt > frames) throw new Error('--control-at must be 1..frames');
  const rawHealth = await control.call({ action: 'health' }, 'health');
  verdict.check('control_route_raw', rawHealth?.structuredContent?.route === 'raw',
    rawHealth?.structuredContent?.route ?? null, 'raw');
  await operator('scene', 'Show the scene fixture (test/qualification/generate.mjs output) full screen on the ' +
    'target, or a neutral desktop with no purple at the screen edges. Keep it up for about a minute.');
  const controlFile = path.join(output, 'control-raw-vnc.png');
  let pending = null, controlWindow = null;
  const startCapture = number => {
    pending = (async () => {
      const shot = await control.call({ action: 'screenshot' }, `raw-control-at-${number}`);
      const image = imageOf(shot);
      if (!image || image.mimeType !== 'image/png') return;
      await writeFile(controlFile, image.bytes, { flag: 'wx', mode: 0o600 });
    })();
  };
  const host = clients.primary;
  const receipt = await runGate({ frames, intervalMs: 100, detector: 'edge-band',
    call: action => host.callTool({ name: 'vnc_command',
      arguments: action === 'screenshot' ? { action, format: 'png' } : { action } }),
    onFrame: async (png, record) => {
      if (record.number === controlAt) { controlWindow = { afterHostFrame: controlAt }; startCapture(controlAt); }
      if (!record.ok || values['save-frames']) { // Failing frames always; every frame with --save-frames.
        await writeFile(path.join(output, `host-frame-${String(record.number).padStart(4, '0')}.png`), png,
          { flag: 'wx', mode: 0o600 });
      }
    },
    readControl: async () => {
      if (pending) await pending.catch(() => {});
      const info = await stat(controlFile).catch(() => null);
      return info && { bytes: await readFile(controlFile), modifiedAtMs: info.mtimeMs };
    } });
  await writeFile(path.join(output, 'overlay-exclusion-receipt.json'), JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  verdict.check('host_frames_captured', receipt.framesCaptured === frames, receipt.framesCaptured, frames);
  verdict.check('host_frames_exclude_overlay', receipt.status !== 'failed', receipt.failure, 'no failure');
  verdict.check('raw_control_during_lease', Boolean(receipt.control?.capturedDuringRun), controlWindow, 'captured mid-series');
  verdict.check('raw_control_shows_overlay', Boolean(receipt.control?.anchored), receipt.control?.sides ?? null,
    'overlay on >= 50% of every 4 px edge band');
  verdict.check('gate_passed', receipt.status === 'passed', receipt.status, 'passed');
  const { records: _records, ...summary } = receipt;
  return { receipt: summary, scope: receipt.scope };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main({ name: 'overlay-600', file: 'live_overlay_600.mjs', gate: overlay600Gate,
    options: { 'control-target': { type: 'string' }, frames: { type: 'string' }, 'control-at': { type: 'string' },
      'save-frames': { type: 'boolean' } },
    sessions: [{ option: 'control-target', role: 'control' }] });
}
