// SPDX-License-Identifier: MIT
// Offline checks of the attended overlay exclusion gate with synthetic frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { scene } from './qualification/scene.mjs';
import { overlaySignature, controlAnchored, runGate, OVERLAY_RGB, DETECTORS, edgeBandSignature,
  topBelowMenuBar } from '../scripts/qualification/overlay_exclusion_gate.mjs';

const runId = '0123456789abcdef0123456789abcdef';
const width = 960, height = 640;

function chunk(type, payload) {
  const bytes = Buffer.alloc(payload.length + 12);
  bytes.writeUInt32BE(payload.length); bytes.write(type, 4); payload.copy(bytes, 8);
  bytes.writeUInt32BE(scene.crc32(bytes.subarray(4, -4)), bytes.length - 4); return bytes;
}
function png({ width: w, height: h, pixels }) {
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * w * 4, w * 4).copy(rows, y * (w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const fixture = (sequence = 1) => ({ width, height, pixels: scene.renderPixels({ width, height, runId, sequence }) });

// HostRenderer.swift's feathered edges at scale 1, at a given heartbeat opacity.
function withOverlay(frame, opacity = 0.48) {
  const pixels = Uint8Array.from(frame.pixels);
  const feather = Math.min(160, Math.max(80, Math.min(frame.width, frame.height) * 0.13));
  const stops = [[0, 0.94], [0.10, 0.72], [0.42, 0.24], [0.76, 0.035], [1, 0]];
  const alphaAt = distance => {
    const t = distance / feather; if (t >= 1) return 0;
    const i = stops.findIndex(([location]) => location > t);
    const [l0, a0] = stops[i - 1], [l1, a1] = stops[i];
    return a0 + (a1 - a0) * (t - l0) / (l1 - l0);
  };
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    if (Math.min(x, y, frame.width - 1 - x, frame.height - 1 - y) >= feather) continue;
    const offset = (y * frame.width + x) * 4;
    for (const distance of [x, frame.width - 1 - x, y, frame.height - 1 - y]) {
      const alpha = alphaAt(distance) * opacity;
      for (let c = 0; c < 3; c++) pixels[offset + c] = Math.round(pixels[offset + c] + (OVERLAY_RGB[c] - pixels[offset + c]) * alpha);
    }
  }
  return { ...frame, pixels };
}
const overlaid = withOverlay(fixture()), controlPNG = png(overlaid);
function halfScale(frame) {
  const w = frame.width / 2, h = frame.height / 2, pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    const at = (dx, dy) => frame.pixels[((2 * y + dy) * frame.width + 2 * x + dx) * 4 + c];
    pixels[(y * w + x) * 4 + c] = Math.round((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4);
  }
  return { width: w, height: h, pixels };
}

test('detector: clean and rescaled fixture frames carry no overlay signature', () => {
  assert.equal(overlaySignature(fixture()).tinted, 0);
  // Scaling mixes cyan markers with neutrals; that must never read as purple.
  assert.equal(overlaySignature(halfScale(fixture())).tinted, 0);
});

test('detector: the Host overlay is found on every side, even at the dimmest heartbeat', () => {
  for (const frame of [overlaid, halfScale(overlaid)]) {
    const signature = overlaySignature(frame);
    assert.ok(controlAnchored(signature), JSON.stringify(signature.sides));
    assert.ok(signature.tinted > 0);
  }
});

test('detector: a faint interior leak is located, not only the edge ring', () => {
  const frame = fixture();
  for (let y = 100; y < 120; y++) for (let x = 600; x < 640; x++) {
    const offset = (y * width + x) * 4, alpha = 0.2;
    for (let c = 0; c < 3; c++) frame.pixels[offset + c] = Math.round(frame.pixels[offset + c] * (1 - alpha) + OVERLAY_RGB[c] * alpha);
  }
  const signature = overlaySignature(frame);
  assert.equal(signature.tinted, 800);
  assert.deepEqual(signature.bounds, { x: 600, y: 100, width: 40, height: 20 });
  assert.ok(!controlAnchored(signature));
});

// A real desktop: menu-bar greys, a dark Dock, white windows and a saturated
// blue (which hides the tint) at the edges; purple only as interior content.
function desktop() {
  const pixels = new Uint8Array(width * height * 4);
  const edges = [[128, 128, 128], [240, 240, 240], [30, 30, 30], [30, 90, 200]];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inner = x > 40 && y > 40 && x < width - 40 && y < height - 40;
    const colour = inner && (x >> 5) % 3 === 0 ? [150, 40, 200] : edges[((x >> 5) + (y >> 5)) % 4];
    pixels.set([...colour, 255], (y * width + x) * 4);
  }
  return { width, height, pixels };
}

test('edge-band detector: anchors on the overlay over a real desktop and passes the clean desktop', () => {
  const edge = DETECTORS['edge-band'];
  assert.ok(!edge.leaked(edgeBandSignature(desktop())));
  for (const frame of [withOverlay(desktop()), halfScale(withOverlay(desktop())), overlaid]) {
    const signature = edgeBandSignature(frame);
    assert.ok(controlAnchored(signature), JSON.stringify(signature.sides));
    assert.ok(edge.leaked(signature));
  }
});

// D46: macOS draws the menu bar above the overlay, so the control's top ring
// is menu bar (PZM 2026-10-18: top 45/5120, bottom 5120/5120, sides 2767/2880).
test('control: a menu bar over the top edge still anchors on bottom, left and right; missing sides do not', () => {
  const edge = DETECTORS['edge-band'];
  const menuBar = frame => {
    const pixels = Uint8Array.from(frame.pixels), bar = Math.round(frame.height * 0.022);
    for (let y = 0; y < bar; y++) for (let x = 0; x < frame.width; x++) pixels.set([236, 236, 236, 255], (y * frame.width + x) * 4);
    return { ...frame, pixels };
  };
  const covered = menuBar(withOverlay(desktop()));
  const signature = edgeBandSignature(covered);
  assert.ok(signature.sides.top.tinted / signature.sides.top.pixels < 0.5, JSON.stringify(signature.sides.top));
  assert.ok(controlAnchored(signature), JSON.stringify(signature.sides));
  const top = topBelowMenuBar(covered, edge.hit, signature.ring);
  // Diagnostic only: the band under the bar is fainter (feather alpha falls off), so it is reported, never required.
  assert.ok(top.pixels > 0 && top.insetPx <= Math.ceil(height * 0.04), JSON.stringify(top));
  // Fail closed: no overlay, or a required side missing, never anchors.
  assert.ok(!controlAnchored(edgeBandSignature(menuBar(desktop()))));
  const noBottom = withOverlay(desktop());
  for (let y = height - 8; y < height; y++) for (let x = 0; x < width; x++) noBottom.pixels.set([30, 30, 30, 255], (y * width + x) * 4);
  assert.ok(!controlAnchored(edgeBandSignature(noBottom)));
});

const hostLabels = { route: 'host', indicator: 'present', capture_backend: 'owned_sck',
  raw_vnc_exclusion: false, overlay_ready: true, capture_enabled: true };
const shot = (frame, labels = hostLabels) => ({ content: [{ type: 'image', mimeType: 'image/png', data: png(frame).toString('base64') }],
  structuredContent: labels });

// Wall-clock time the series starts at; a control saved during it is newer.
const startedAtMs = 1_800_000_000_000;
function harness(frames, { latencies = [], control = controlPNG, controlModifiedAtMs = startedAtMs + 30_000 } = {}) {
  let clock = 0, index = 0;
  const saved = [];
  const actions = [];
  const call = async action => {
    actions.push(action);
    if (action === 'health') return { structuredContent: { route: 'host', indicator: 'unknown' } };
    clock += latencies[index] ?? 50;
    return frames[index++];
  };
  return { actions, saved, options: { call, frames: frames.length, intervalMs: 100,
    readControl: async () => control && { bytes: control, modifiedAtMs: controlModifiedAtMs },
    now: () => clock, wallNow: () => startedAtMs, sleep: async ms => { clock += ms; },
    onFrame: async (png, record) => { saved.push(record.number); } } };
}

test('gate: clean Host frames with an anchored control pass and report latency', async () => {
  const { options, actions } = harness(Array.from({ length: 5 }, (_, i) => shot(fixture(i + 1))),
    { latencies: [40, 60, 80, 100, 300] });
  const result = await runGate(options);
  assert.equal(result.status, 'passed');
  assert.equal(result.framesCaptured, 5);
  assert.deepEqual([result.latency.p50, result.latency.p95, result.latency.max], [80, 300, 300]);
  assert.deepEqual(actions, ['health', 'screenshot', 'screenshot', 'screenshot', 'screenshot', 'screenshot']);
});

test('gate: the first frame showing the overlay fails and stops the series', async () => {
  const frames = [shot(fixture(1)), shot(fixture(2)), shot(overlaid), shot(fixture(4))];
  const { options, actions } = harness(frames);
  const result = await runGate(options);
  assert.equal(result.status, 'failed');
  assert.deepEqual([result.failure.number, result.failure.reason], [3, 'overlay_pixels_present']);
  assert.equal(actions.filter(action => action === 'screenshot').length, 3);
});

test('gate: a frame not attested as owned Host capture with the indicator present fails', async () => {
  for (const [key, value] of [['indicator', 'unknown'], ['route', 'raw'], ['raw_vnc_exclusion', true], ['overlay_ready', false]]) {
    const { options } = harness([shot(fixture(), { ...hostLabels, [key]: value })]);
    const result = await runGate(options);
    assert.deepEqual([result.status, result.failure.reason, result.failure.detail], ['failed', 'labels', [key]]);
  }
});

test('gate: clean frames without a control showing the overlay are unanchored, not passed', async () => {
  for (const control of [null, png(fixture())]) {
    const { options } = harness([shot(fixture())], { control });
    assert.equal((await runGate(options)).status, 'unanchored');
  }
});

test('gate: a control saved before the series started cannot anchor it', async () => {
  const { options } = harness([shot(fixture())], { controlModifiedAtMs: startedAtMs - 1 });
  const result = await runGate(options);
  assert.equal(result.status, 'unanchored');
  assert.deepEqual([result.control.capturedDuringRun, controlAnchored(overlaySignature(overlaid))], [false, true]);
});

test('gate: an undecodable frame fails the series and is still handed over for saving', async () => {
  const broken = { ...shot(fixture()), content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('not a png').toString('base64') }] };
  const { options, saved } = harness([shot(fixture(1)), broken, shot(fixture(3))]);
  const result = await runGate(options);
  assert.deepEqual([result.status, result.failure.number, result.failure.reason, result.framesCaptured], ['failed', 2, 'undecodable_frame', 2]);
  assert.deepEqual(saved, [1, 2]);
});

test('gate: fewer than 95% of captures within the SLO limit fails on latency', async () => {
  const frames = Array.from({ length: 10 }, (_, i) => shot(fixture(i + 1)));
  const { options } = harness(frames, { latencies: [50, 50, 50, 50, 50, 50, 50, 50, 50, 5001] });
  const result = await runGate(options);
  assert.deepEqual([result.status, result.failure.reason, result.latency.withinLimit], ['failed', 'latency', 9]);
});

test('gate: a refused capture fails without decoding an image', async () => {
  const { options } = harness([{ isError: true, content: [{ type: 'text', text: 'Error' }],
    structuredContent: { error: { message: 'screen_capture_permission_required' }, route: 'host', indicator: 'unknown' } }]);
  const result = await runGate(options);
  assert.deepEqual([result.status, result.failure.reason], ['failed', 'capture_failed']);
});
