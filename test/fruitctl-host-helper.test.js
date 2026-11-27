// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { deflateSync } from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHostHelperExecutor, HostHelperExecutor, hostHelperRefusalMessage, hostHelperFailureCause } from '../lib/broker/host-helper.mjs';
import { nativeFactory, createBroker, TargetLane } from '../lib/broker/server.mjs';
import { BrokerExecutor } from '../lib/broker/client.mjs';
import { McpSession } from '../lib/mcp/server.js';
import { ResponseBudget } from '../lib/mcp/protocol.js';
import { nativeCapabilities, isPreAdmissionRefusal } from '../lib/mcp/capabilities.js';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, content) {
  const type = Buffer.from(name);
  const value = Buffer.alloc(content.length + 12);
  value.writeUInt32BE(content.length, 0);
  type.copy(value, 4); content.copy(value, 8);
  value.writeUInt32BE(crc32(Buffer.concat([type, content])), content.length + 8);
  return value;
}
function image(width = 256, height = 128, rawPixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const pixels = rawPixels || Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

// A structurally complete baseline JPEG header and scan for the given size.
function jpegImage(width = 256, height = 128) {
  const segment = (marker, body) => {
    const length = Buffer.alloc(2); length.writeUInt16BE(body.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), length, body]);
  };
  const size = Buffer.alloc(4); size.writeUInt16BE(height, 0); size.writeUInt16BE(width, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]),
    segment(0xdb, Buffer.alloc(65)),
    segment(0xc0, Buffer.concat([Buffer.from([8]), size, Buffer.from([3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])])),
    segment(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0])),
    Buffer.alloc(64, 0x55), Buffer.from([0xff, 0xd9])]).toString('base64');
}

const bounds = { x: 0, y: 0, width: 256, height: 128 };
const mapping = { qualificationReceipt: 'test-fixture:explicit-geometry-proof', displayId: 42,
  nativeWidth: 512, nativeHeight: 256, scaledWidth: 256, scaledHeight: 128, displayBounds: bounds };
const configuration = () => ({ sshHost: 'configured-target',
  command: ['/Applications/FruitctlHost.app/Contents/MacOS/FruitctlHost', '--stdio'], displayId: 42 });

function native({ health = {}, run, releaseError, releaseRun, adopt, capabilities } = {}) {
  return {
    capabilities: nativeCapabilities(capabilities),
    display: { width: 256, height: 128 }, calls: [], scopes: [], closes: [], releases: [], permitControls: [],
    async inputPermitControl(method, params) {
      this.permitControls.push({ method, params });
      const { lease_remaining_ms, ...binding } = params;
      return { id: 'native-permit', result: { ...binding, challenge: params.challenge || randomUUID(),
        native_permit_protocol: 'fruitctl.native-input-permit.v1', input_permit_ms: 1000,
        maximum_round_trip_ms: 500, native_permit_remaining_ms: 1000 } };
    },
    async execute(actions, options = {}) {
      this.calls.push(...actions);
      this.scopes.push(...actions.map(() => options.holdScope));
      if (actions[0].action === 'health') return [{ id: 'native-health', result: {
        nativeWidth: 512, nativeHeight: 256, scaledWidth: 256, scaledHeight: 128,
        connectionGeneration: 3, allocation: 9, ...health } }];
      if (actions[0].action === 'adopt_observation') {
        if (adopt) return adopt(actions[0]);
        const { action, ...result } = actions[0];
        return [{ id: 'native-adoption', result }];
      }
      if (actions.some(action => action.action === 'screenshot')) throw new Error('Raw VNC capture must not run');
      if (run) return run(actions, options);
      return actions.map(() => ({ id: 'native-input', result: { detail: 'input acknowledged' } }));
    },
    async release(options) {
      this.releases.push(options);
      if (releaseError) throw releaseError;
      if (releaseRun) await releaseRun(options);
    },
    async close(options) { this.closes.push(options); },
  };
}

// latency(request) delays each reply as a real SSH-attached Host would; a
// serial Host answers one request at a time in arrival order.
// partGapsMs splits a requested capture reply into parts sent at those gaps.
function helper({ alter, ignoreTerm = false, ignoreKill = false, latency, serial = false, pipelining,
  partGapsMs, imageFormats } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null; child.kills = [];
  child.kill = signal => {
    child.kills.push(signal);
    if ((signal === 'SIGTERM' && ignoreTerm) || (signal === 'SIGKILL' && ignoreKill)) return true;
    child.signalCode = signal;
    queueMicrotask(() => { child.emit('exit', null, signal); child.emit('close', null, signal); });
    return true;
  };
  const requests = [];
  const launches = [];
  let owner;
  const state = () => ({ instance_id: 'resident-test-app', capture_backend: 'owned_sck',
    capture_enabled: true, screen_capture_permission: true, raw_vnc_exclusion: false,
    display_id: 42, displayGeneration: 7, renewal_interval_ms: 500,
    input_permit_ms: 1000, maximum_round_trip_ms: 500,
    ...(pipelining === undefined ? {} : { request_pipelining: pipelining }),
    ...(partGapsMs === undefined ? {} : { reply_parts: true }),
    ...(imageFormats === undefined ? {} : { image_formats: imageFormats }),
    capture_ready: Boolean(owner), overlay_ready: Boolean(owner), ready: Boolean(owner),
    ui_heartbeat_age_ms: owner ? 0 : null, lease_remaining_ms: owner ? 3000 : 0,
    ...(owner || {}) });
  let busyUntil = 0;
  child.stdin = new Writable({ write(bytes, encoding, callback) {
    const request = JSON.parse(bytes.toString());
    requests.push(request);
    if (latency) {
      request.sentAt = performance.now();
      const start = serial ? Math.max(request.sentAt, busyUntil) : request.sentAt;
      const done = start + latency(request);
      if (serial) busyUntil = done;
      setTimeout(() => { request.answeredAt = performance.now(); answer(request); }, done - request.sentAt);
      callback();
      return;
    }
    callback();
    answer(request, true);
  } });
  function answer(request, deferred = false) {
    if (request.action === 'begin_activity' || request.action === 'renew_activity') {
      owner = { session_id: request.params.session_id, sequence: request.params.sequence,
        challenge: request.params.challenge };
    } else if (request.action === 'release_activity') owner = undefined;
    let result = state();
    if (request.action === 'capture') result = { ...result,
      ...(request.params.format === 'jpeg' ? { image: jpegImage(), mimeType: 'image/jpeg' } :
        { image: image(), mimeType: 'image/png' }),
      nativeWidth: 512, nativeHeight: 256, scaledWidth: 256, scaledHeight: 128,
      display_bounds: bounds, pixels_per_point_x: 2, pixels_per_point_y: 2, cursor_included: true };
    let response = { id: request.id, success: true, result };
    if (alter) response = alter(request, response);
    if (response === null) return;
    if (partGapsMs && request.params.reply_part_bytes && response.result?.image) {
      const { image, ...rest } = response.result;
      const size = Math.ceil(image.length / partGapsMs.length);
      let at = 0;
      partGapsMs.forEach((gap, index) => {
        at += gap;
        setTimeout(() => child.stdout.write(JSON.stringify({ id: request.id,
          part: { index, data: image.slice(index * size, (index + 1) * size) } }) + '\n'), at);
      });
      setTimeout(() => {
        request.answeredAt = performance.now();
        child.stdout.write(JSON.stringify({ ...response, result: { ...rest, image_parts: partGapsMs.length } }) + '\n');
      }, at);
      return;
    }
    if (deferred) queueMicrotask(() => child.stdout.write(JSON.stringify(response) + '\n'));
    else child.stdout.write(JSON.stringify(response) + '\n');
  }
  return { child, requests, launches, state, spawnImpl(command, args, options) {
    launches.push({ command, args, options }); return child;
  } };
}

async function fixture({ config = configuration(), nativeOptions, helperOptions, now, responseBudgetFactory } = {}) {
  const vnc = native(nativeOptions);
  const host = helper(helperOptions);
  const executor = await createHostHelperExecutor({ nativeExecutor: vnc, hostHelper: config,
    spawnImpl: host.spawnImpl, ...(now ? { now } : {}),
    ...(responseBudgetFactory ? { responseBudgetFactory } : {}) });
  return { executor, vnc, host };
}

const captureDiagnostic = (overrides = {}) => ({ schema: 'fruitctl.host-capture-error.v1',
  phase: 'capture_image', apple_domain: 'SCStreamErrorDomain', apple_code: -1, ...overrides });
const refused = (request, message = 'capture_failed', data) => ({ id: request.id, success: false,
  error: { code: -32000, message, ...(data === undefined ? {} : { data }) } });

test('only locally sanitized refusals supply diagnostic causes, independent of mutable messages', async () => {
  const { executor } = await fixture({ helperOptions: { alter(request, response) {
    return request.action === 'capture' ? refused(request, 'capture_failed', captureDiagnostic()) : response;
  } } });
  try {
    await assert.rejects(executor.execute([{ action: 'screenshot' }]), error => {
      const validated = hostHelperRefusalMessage(error);
      assert.equal(validated, error.message);
      assert.ok(validated.includes('phase=capture_image; apple_domain=SCStreamErrorDomain; apple_code=-1'));
      const forged = Object.assign(new Error(validated), error);
      assert.equal(hostHelperRefusalMessage(forged), undefined);
      error.message = '/synthetic/private/mutated-description';
      assert.equal(hostHelperRefusalMessage(error), validated);
      return true;
    });
  } finally { await executor.close(); }
});

test('unconfirmed retirement never appends an untrusted executor message', async () => {
  const marker = '/synthetic/private/untrusted-executor-description';
  const forged = new Error('Host helper refused request: capture_failed; ' + marker);
  const executor = native({ run: async () => { throw forged; }, releaseError: new Error(marker) });
  const lane = new TargetLane({}, async () => executor);
  try {
    await assert.rejects(lane.execute([{ action: 'wait' }]), error => {
      assert.equal(error.code, 'release_unconfirmed');
      assert.equal(error.message, 'Target input release is unconfirmed; reconcile the target before restarting its broker' +
        '; firstCause=operation/unknown');
      assert.equal(error.message.includes(marker), false);
      assert.equal(error, lane.cleanupFailure);
      return true;
    });
    await assert.rejects(lane.execute([{ action: 'key_tap', key: 'tab' }]), error => error === lane.cleanupFailure);
    assert.deepEqual(executor.calls.map(action => action.action), ['wait']);
  } finally { await assert.rejects(lane.close(), error => error.code === 'release_unconfirmed'); }
});

test('diagnosed begin and capture refusals retain local correlation and prevent successor input', async t => {
  for (const action of ['begin_activity', 'capture']) {
    await t.test(action, async () => {
      const { executor, vnc, host } = await fixture({ config: { ...configuration(), mapping }, helperOptions: { alter(request, response) {
        return request.action === action ? refused(request, 'capture_failed', captureDiagnostic()) : response;
      } } });
      try {
        let failure;
        await assert.rejects(executor.execute([{ action: 'screenshot' }, { action: 'key_tap', key: 'tab' }]), error => {
          failure = error;
          const id = host.requests.find(request => request.action === action).id;
          assert.equal(error.message, `Host helper refused request: capture_failed; phase=capture_image; ` +
            `apple_domain=SCStreamErrorDomain; apple_code=-1; request=${id}`);
          assert.ok(error.message.length <= 320);
          assert.deepEqual(error.responses, []);
          return true;
        });
        await assert.rejects(executor.execute([{ action: 'key_tap', key: 'tab' }]), error => error === failure);
        await Promise.all([executor.nativeClosing, executor.helperClosing]);
        assert.deepEqual(vnc.calls, []);
        assert.equal(vnc.closes.length, 1);
        assert.deepEqual(host.child.kills, ['SIGTERM']);
        assert.equal(host.requests.filter(request => request.action === 'begin_activity').length, 1);
        assert.equal(host.requests.filter(request => request.action === 'capture').length, action === 'capture' ? 1 : 0);
      } finally { await executor.close(); }
    });
  }
});

test('recognized Apple diagnostics retain both phases, domains and signed code boundaries', async t => {
  const domains = ['SCStreamErrorDomain', 'NSCocoaErrorDomain', 'NSPOSIXErrorDomain', 'NSOSStatusErrorDomain'];
  const cases = domains.map((apple_domain, index) => captureDiagnostic({ apple_domain,
    apple_code: [-2147483648, 0, 2147483647, -1][index], phase: index % 2 ? 'shareable_content' : 'capture_image' }));
  cases.push({ schema: 'fruitctl.host-capture-error.v1', phase: 'capture_image' });
  cases.push(captureDiagnostic({ apple_code: undefined }));
  for (const [index, data] of cases.entries()) {
    await t.test(String(index), async () => {
      const { executor, host } = await fixture({ helperOptions: { alter(request, response) {
        return request.action === 'begin_activity' ? refused(request, 'capture_failed', data) : response;
      } } });
      try {
        await assert.rejects(executor.execute([{ action: 'screenshot' }]), error => {
          const id = host.requests.find(request => request.action === 'begin_activity').id;
          const parts = ['Host helper refused request: capture_failed', `phase=${data.phase}`];
          if (data.apple_domain !== undefined) parts.push(`apple_domain=${data.apple_domain}`);
          if (data.apple_code !== undefined) parts.push(`apple_code=${data.apple_code}`);
          parts.push(`request=${id}`);
          assert.equal(error.message, parts.join('; '));
          assert.ok(error.message.length <= 320);
          return true;
        });
      } finally { await executor.close(); }
    });
  }
});

test('legacy capture reasons survive without forwarding arbitrary remote error text', async t => {
  const reasons = ['capture_not_enabled', 'screen_capture_permission_required', 'configured_display_unavailable',
    'own_application_exclusion_unavailable', 'incomplete_capture', 'capture_failed', 'image_encoding_failed'];
  for (const reason of [...reasons, '/synthetic/private/remote-description', undefined]) {
    await t.test(String(reason), async () => {
      const { executor, host } = await fixture({ helperOptions: { alter(request, response) {
        if (request.action !== 'begin_activity') return response;
        return reason === undefined ? { id: request.id, success: false, error: {} } : refused(request, reason);
      } } });
      try {
        await assert.rejects(executor.execute([{ action: 'screenshot' }]), error => {
          const id = host.requests.find(request => request.action === 'begin_activity').id;
          assert.equal(error.message, reasons.includes(reason)
            ? `Host helper refused request: ${reason}; request=${id}` : 'Host helper refused request');
          return true;
        });
      } finally { await executor.close(); }
    });
  }
});

test('malformed optional diagnostics never reflect descriptions, paths or arbitrary fields', async t => {
  const marker = '/synthetic/private/diagnostic-marker';
  const cases = [null, [], marker,
    captureDiagnostic({ schema: marker }), captureDiagnostic({ phase: marker }),
    captureDiagnostic({ apple_domain: marker }), captureDiagnostic({ apple_code: marker }),
    captureDiagnostic({ apple_code: 2147483648 }), captureDiagnostic({ apple_code: -2147483649 }),
    captureDiagnostic({ apple_code: 1.25 }), captureDiagnostic({ apple_code: null }),
    captureDiagnostic({ localizedDescription: marker }), captureDiagnostic({ userInfo: { private: marker } }),
    { schema: 'fruitctl.host-capture-error.v1', phase: 'capture_image', apple_code: 1 },
    captureDiagnostic({ phase: marker.repeat(2048) }),
  ];
  for (const [index, data] of cases.entries()) {
    await t.test(String(index), async () => {
      const { executor, vnc, host } = await fixture({ config: { ...configuration(), mapping }, helperOptions: { alter(request, response) {
        return request.action === 'begin_activity' ? refused(request, 'capture_failed', data) : response;
      } } });
      try {
        await assert.rejects(executor.execute([{ action: 'screenshot' }, { action: 'key_tap', key: 'tab' }]), error => {
          const id = host.requests.find(request => request.action === 'begin_activity').id;
          assert.equal(error.message, `Host helper refused request: capture_failed; request=${id}`);
          assert.ok(error.message.length <= 320);
          assert.equal(error.message.includes(marker), false);
          return true;
        });
        assert.deepEqual(vnc.calls, []);
      } finally { await executor.close(); }
    });
  }
});

test('a mismatched refusal id cannot provide correlation or authorize later input', async () => {
  const { executor, vnc } = await fixture({ helperOptions: { alter(request, response) {
    return request.action === 'begin_activity'
      ? { ...refused(request, 'capture_failed', captureDiagnostic()), id: '/synthetic/private/forged-id' } : response;
  } } });
  try {
    await assert.rejects(executor.execute([{ action: 'screenshot' }]), /Invalid host-helper protocol/);
    assert.deepEqual(vnc.calls, []);
  } finally { await executor.close(); }
});

test('diagnosed startup refusal survives the offline broker and MCP after confirmed owned close', async t => {
  for (const kind of ['command', 'queue']) {
    await t.test(kind, async t => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-host-startup-diagnostic-'));
      await fs.chmod(directory, 0o700);
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const vnc = native();
      // Inject a startup protocol refusal. This tests the existing wire and
      // startup cleanup path, not a real Host health or capture qualification.
      const host = helper({ alter(request) {
        return refused(request, 'capture_failed', captureDiagnostic());
      } });
      const socketPath = path.join(directory, 'broker.sock');
      const broker = await createBroker({ socketPath, config: { targets: { desktop: {} } },
        factory: async (_, { onExecutor }) => {
          const executor = new HostHelperExecutor({ nativeExecutor: vnc, hostHelper: configuration(),
            spawnImpl: host.spawnImpl });
          onExecutor(executor);
          try { return await executor.ready(); }
          catch (error) { await executor.close(); throw error; }
        } });
      t.after(() => broker.close());
      const client = new BrokerExecutor({ socketPath, target: 'desktop' });
      t.after(() => client.close());
      await client.opened;
      const session = new McpSession(client);
      const result = kind === 'command' ? await session.command({ action: 'screenshot' }) :
        await session.queue({ actions: [{ action: 'screenshot' }, { action: 'key_tap', key: 'tab' }] });
      const id = host.requests[0].id;
      const message = `Host helper refused request: capture_failed; phase=capture_image; ` +
        `apple_domain=SCStreamErrorDomain; apple_code=-1; request=${id}`;
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, kind === 'command' ? `Error: ${message}` :
        `[1] screenshot: ERROR — ${message}`);
      if (kind === 'queue') assert.deepEqual(result.structuredContent, { completed: 0, failedIndex: 1,
        error: { message }, route: 'raw', indicator: 'absent' });
      else assert.deepEqual(result.structuredContent, { error: { message }, route: 'raw', indicator: 'absent' });
      assert.deepEqual(vnc.calls, []);
      assert.deepEqual(host.requests.map(request => request.action), ['health']);
      assert.deepEqual(host.child.kills, ['SIGTERM']);
    });
  }
});

test('broker keeps release-unconfirmed and sanitized capture cause with partial progress and revoked input', async t => {
  for (const kind of ['command', 'queue']) {
    await t.test(kind, async t => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-host-diagnostic-'));
      await fs.chmod(directory, 0o700);
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const { executor, vnc, host } = await fixture({ config: { ...configuration(), mapping }, helperOptions: { alter(request, response) {
        return request.action === 'capture' ? refused(request, 'capture_failed', captureDiagnostic()) : response;
      } } });
      const socketPath = path.join(directory, 'broker.sock');
      const broker = await createBroker({ socketPath, config: { targets: { desktop: {} } },
        factory: async () => executor });
      t.after(() => assert.rejects(broker.close(), error => error.code === 'release_unconfirmed'));
      const client = new BrokerExecutor({ socketPath, target: 'desktop' });
      t.after(() => client.close());
      await client.opened;
      const session = new McpSession(client);
      const result = kind === 'command' ? await session.command({ action: 'screenshot' }) :
        await session.queue({ actions: [{ action: 'wait' }, { action: 'screenshot' }, { action: 'key_tap', key: 'tab' }] });
      // An acquired helper that fails cannot certify a clean activity release.
      // Its bounded cause accompanies this error; the sticky lane stays revoked.
      const safetyMessage = 'Target input release is unconfirmed; reconcile the target before restarting its broker' +
        '; firstCause=host_helper/helper_refused';
      const id = host.requests.find(request => request.action === 'capture').id;
      const message = `${safetyMessage}; cause=Host helper refused request: capture_failed; ` +
        `phase=capture_image; apple_domain=SCStreamErrorDomain; apple_code=-1; request=${id}`;
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, kind === 'command' ? `Error: ${message}` :
        `[1] wait: input acknowledged\n[2] screenshot: ERROR — ${message}`);
      // The failed Host route stays labelled host; its indicator is unattested.
      if (kind === 'queue') assert.deepEqual(result.structuredContent, { completed: 1, failedIndex: 2,
        error: { message }, route: 'host', indicator: 'unknown' });
      else assert.deepEqual(result.structuredContent, { error: { message }, route: 'host', indicator: 'unknown' });
      assert.deepEqual(vnc.calls.map(action => action.action), kind === 'command' ? [] : ['wait']);
      assert.equal(host.requests.filter(request => request.action === 'capture').length, 1);
      await assert.rejects(client.execute([{ action: 'key_tap', key: 'tab' }]), error => {
        assert.equal(error.code, 'release_unconfirmed');
        assert.equal(error.message, safetyMessage);
        return true;
      });
      assert.deepEqual(vnc.calls.map(action => action.action), kind === 'command' ? [] : ['wait']);
    });
  }
});

test('a local helper deadline is named as the cause of an unconfirmed release', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-host-deadline-'));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { executor } = await fixture({ helperOptions: { alter(request, response) {
    return request.action === 'renew_activity' ? null : response;
  } } });
  const socketPath = path.join(directory, 'broker.sock');
  const broker = await createBroker({ socketPath, config: { targets: { desktop: {} } },
    factory: async () => executor });
  t.after(() => assert.rejects(broker.close(), error => error.code === 'release_unconfirmed'));
  const client = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(() => client.close());
  await client.opened;
  const result = await new McpSession(client).command({ action: 'screenshot' });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Error: Target input release is unconfirmed; reconcile the target ' +
    'before restarting its broker; firstCause=host_helper/deadline; cause=Host-helper receipt deadline exceeded');
});

test('configured helper screenshots use owned SCK PNG and retain ownership indication, never raw VNC', async () => {
  const { executor, vnc, host } = await fixture();
  try {
    const [response] = await executor.execute([{ action: 'screenshot' }]);
    assert.equal(response.result.image, image());
    assert.equal(response.result.capture_backend, 'owned_sck');
    assert.equal(response.result.display_id, 42);
    assert.deepEqual(vnc.calls, []);
    assert.deepEqual(host.requests.map(request => request.action),
      ['health', 'begin_activity', 'renew_activity', 'capture']);
    assert.equal(host.state().overlay_ready, true);
  } finally { await executor.close(); }
});

test('helper transport only executes configured SSH stdio attachment and forwards no VNC credentials', async () => {
  const config = configuration();
  config.command[0] = "/Applications/Operator's App.app/Contents/MacOS/FruitctlHost";
  const { executor, host } = await fixture({ config });
  try {
    const launch = host.launches[0];
    assert.equal(launch.command, 'ssh');
    assert.deepEqual(launch.args.slice(0, 9),
      ['-T', '-oBatchMode=yes', '-oForwardAgent=no', '-oClearAllForwardings=yes',
        '-oControlMaster=no', '-oControlPath=none', '-oControlPersist=no', '--', 'configured-target']);
    assert.equal(launch.args[9], "'/Applications/Operator'\\''s App.app/Contents/MacOS/FruitctlHost' '--stdio'");
    assert.equal(Object.hasOwn(launch.options.env, 'VNC_PASSWORD'), false);
    assert.equal(host.launches.length, 1);
  } finally { await executor.close(); }
});

test('unqualified mapping refuses the entire batch before activity and retains healthy observations', async () => {
  const { executor, vnc, host } = await fixture();
  try {
    await assert.rejects(executor.execute([{ action: 'screenshot' },
      { action: 'mouse_click', x: 1, y: 1 }]), error => {
      assert.match(error.message, /not qualified/);
      assert.equal(isPreAdmissionRefusal(error), true);
      assert.deepEqual(error.responses, []);
      return true;
    });
    assert.deepEqual(vnc.calls, []);
    assert.deepEqual(vnc.closes, []);
    assert.deepEqual(host.child.kills, []);
    assert.deepEqual(host.requests.map(request => request.action), ['health']);
    await executor.execute([{ action: 'screenshot' }]);
    assert.equal(host.state().overlay_ready, true);
  } finally { await executor.close(); }
});

test('qualified exact geometry renews a permit before native input and never replays it', async () => {
  const config = { ...configuration(), mapping };
  const { executor, vnc, host } = await fixture({ config });
  try {
    const action = { action: 'mouse_click', x: 12, y: 20 };
    await executor.execute([action]);
    assert.deepEqual(vnc.calls, [{ action: 'health' }, { action: 'adopt_observation',
      nativeWidth: 512, nativeHeight: 256, scaledWidth: 256, scaledHeight: 128,
      connectionGeneration: 3, allocation: 9 }, action]);
    const verbs = host.requests.map(request => request.action);
    assert.deepEqual(verbs, ['health', 'begin_activity', 'capture', 'renew_activity']);
    const begin = host.requests[1].params;
    const renew = host.requests[3].params;
    assert.equal(renew.session_id, begin.session_id);
    assert.ok(renew.sequence > begin.sequence);
    assert.notEqual(renew.challenge, begin.challenge);
  } finally { await executor.close(); }
});

// D15/D16: a secret is typed only right after a fresh Host renewal; a Stop
// latched at startup is a typed refusal, and one latched mid-lease fails the
// renewal before any keystroke.
test('type_secret renews the Host lease immediately before the native secret', async () => {
  const config = { ...configuration(), mapping };
  const { executor, vnc, host } = await fixture({ config });
  try {
    const action = { action: 'type_secret', secret: 'fixture-secret' };
    await executor.execute([action]);
    assert.deepEqual(vnc.calls.map(call => call.action), ['health', 'adopt_observation', 'type_secret']);
    assert.deepEqual(host.requests.map(request => request.action),
      ['health', 'begin_activity', 'capture', 'renew_activity', 'renew_activity']);
    assert.ok(!JSON.stringify(host.requests).includes('fixture-secret'), 'the Host never sees the secret');
  } finally { await executor.close(); }
});

test('a Stop latched before or during the lease refuses type_secret before any keystroke', async () => {
  const config = { ...configuration(), mapping };
  const latched = await fixture({ config, helperOptions: { alter(request, response) {
    if (request.action === 'health') response.result.human_stop_latched = true;
    return response;
  } } });
  try {
    await assert.rejects(latched.executor.execute([{ action: 'type_secret', secret: 's' }]), error => {
      assert.equal(error.code, 'human_stop_latched');
      assert.ok(isPreAdmissionRefusal(error));
      return true;
    });
    assert.deepEqual(latched.vnc.calls, []);
  } finally { await latched.executor.close(); }
  let renewals = 0;
  const stopped = await fixture({ config, helperOptions: { alter(request, response) {
    // The renewal just before the secret reports the Stop.
    if (request.action === 'renew_activity' && ++renewals === 2) {
      Object.assign(response.result, { ready: false, activity_eligible: false, human_stop_latched: true });
    }
    return response;
  } } });
  try {
    await assert.rejects(stopped.executor.execute([{ action: 'type_secret', secret: 's' }]), /receipt mismatch/);
    assert.ok(!stopped.vnc.calls.some(call => call.action === 'type_secret'));
  } finally { await stopped.executor.close(); }
});

test('native input settle is waited out before adoption and the native permit, never during it', async () => {
  const config = { ...configuration(), mapping };
  const { executor, vnc, host } = await fixture({ config,
    nativeOptions: { health: { input_ready: false, input_settle_remaining_ms: 60, input_settle_ms: 3000 } } });
  try {
    const marks = [];
    const execute = vnc.execute.bind(vnc);
    vnc.execute = async (actions, options) => { marks.push([actions[0].action, performance.now()]); return execute(actions, options); };
    const action = { action: 'key_tap', key: 'tab' };
    await executor.execute([action]);
    assert.deepEqual(marks.map(([name]) => name), ['health', 'adopt_observation', 'key_tap']);
    assert.ok(marks[1][1] - marks[0][1] >= 55, 'adoption waits for the reported settle time');
    // The permit is requested only after the wait, so its lease is not spent waiting.
    const begin = vnc.permitControls.findIndex(control => control.method === 'begin_input_permit');
    assert.ok(begin >= 0);
    assert.ok(host.requests.some(request => request.action === 'renew_activity'));
  } finally { await executor.close(); }
});

test('a settle time beyond the operation deadline fails as typed input_not_ready before any input', async () => {
  const config = { ...configuration(), mapping };
  const { executor, vnc } = await fixture({ config,
    nativeOptions: { health: { input_ready: false, input_settle_remaining_ms: 2500, input_settle_ms: 3000 } } });
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'tab' }], { timeoutMs: 1000 }), error => {
    assert.equal(error.code, -32013);
    assert.deepEqual(error.data, { reason: 'input_not_ready', remaining_ms: 2500 });
    return true;
  });
  assert.deepEqual(vnc.calls.map(action => action.action), ['health']);
  assert.deepEqual(vnc.permitControls, []);
});

test('a mouse hold batch carries one native scope through every call and ends with release_holds', async () => {
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping } });
  try {
    const actions = [{ action: 'mouse_down', x: 2, y: 3, button: 'right' }, { action: 'mouse_move', x: 9, y: 9 },
      { action: 'wait', ms: 50 }, { action: 'mouse_up', button: 'right' }];
    const responses = await executor.execute(actions);
    assert.equal(responses.length, 4);
    const verbs = vnc.calls.map(action => action.action);
    assert.deepEqual(verbs.filter(verb => !['health', 'adopt_observation'].includes(verb)),
      ['mouse_down', 'mouse_move', 'wait', 'mouse_up', 'release_holds']);
    assert.equal(verbs.at(-1), 'release_holds');
    const [scope] = vnc.scopes;
    assert.match(scope, /^[0-9a-f-]{36}$/);
    // Re-verification (health, adopt_observation) inside the batch keeps the hold.
    assert.ok(vnc.scopes.every(value => value === scope));
    vnc.calls.length = 0; vnc.scopes.length = 0;
    await executor.execute([{ action: 'mouse_click', x: 1, y: 1, modifiers: ['shift'] }, { action: 'cursor_position' }]);
    assert.ok(vnc.scopes.every(value => value === undefined));
    assert.equal(vnc.calls.some(action => action.action === 'release_holds'), false);
    assert.deepEqual(vnc.calls.at(-1), { action: 'cursor_position' });
  } finally { await executor.close(); }
});

test('cursor_position and new input actions require the qualified mapping; holds require native release_holds', async () => {
  const unmapped = await fixture();
  try {
    for (const action of ['cursor_position', 'triple_click', 'hold_key', 'mouse_down']) {
      await assert.rejects(unmapped.executor.execute([{ action, x: 1, y: 1, key: 'a', duration_ms: 10 }]),
        /input mapping is not qualified/);
    }
    assert.deepEqual(unmapped.vnc.calls, []);
    assert.equal(unmapped.executor.capabilities.actions.includes('cursor_position'), false);
  } finally { await unmapped.executor.close(); }
  const legacy = await fixture({ config: { ...configuration(), mapping }, nativeOptions: {
    capabilities: ['health', 'wait', 'adopt_observation', 'begin_input_permit', 'grant_input_permit',
      'mouse_down', 'mouse_up', 'cursor_position'] } });
  try {
    assert.equal(legacy.executor.capabilities.actions.includes('cursor_position'), true);
    const refused = await legacy.executor.execute([{ action: 'mouse_down', x: 1, y: 1 }]).catch(error => error);
    assert.equal(isPreAdmissionRefusal(refused), true);
    assert.deepEqual(legacy.vnc.calls, []);
  } finally { await legacy.executor.close(); }
});

test('VNC/native geometry mismatch prevents input even with a configured receipt', async () => {
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping },
    nativeOptions: { health: { nativeWidth: 513 } } });
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /geometry mismatch/);
  assert.deepEqual(vnc.calls, [{ action: 'health' }]);
  assert.equal(vnc.closes.length, 1);
});

test('unavailable native allocation binding prevents external adoption and input', async () => {
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping },
    nativeOptions: { health: { allocation: undefined } } });
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /allocation binding unavailable/);
  assert.deepEqual(vnc.calls, [{ action: 'health' }]);
  assert.equal(vnc.closes.length, 1);
});

test('missing private adoption seam refuses input without seeding a raw VNC capture', async () => {
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, nativeOptions: {
    adopt() { return [{ id: 'native-adoption', error: { code: -32601, message: 'unsupported' } }]; } } });
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /adoption unconfirmed/);
  assert.deepEqual(vnc.calls.map(action => action.action), ['health', 'adopt_observation']);
  assert.equal(vnc.closes.length, 1);
});

test('changed native allocation in adoption acknowledgement prevents input', async () => {
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, nativeOptions: {
    adopt({ action, ...binding }) { return [{ id: 'native-adoption', result: { ...binding, allocation: binding.allocation + 1 } }]; } } });
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /adoption unconfirmed/);
  assert.deepEqual(vnc.calls.map(action => action.action), ['health', 'adopt_observation']);
  assert.equal(vnc.closes.length, 1);
});

for (const field of ['challenge', 'session_id', 'sequence', 'displayGeneration', 'display_id', 'instance_id']) {
  test(`mismatched helper ${field} acknowledgement closes native before input`, async () => {
    const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, helperOptions: {
      alter(request, response) {
        if (request.action === 'begin_activity') response.result[field] =
          typeof response.result[field] === 'number' ? response.result[field] + 1 : 'wrong-binding';
        return response;
      } } });
    await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /receipt mismatch/);
    assert.deepEqual(vnc.calls, []);
    assert.equal(vnc.closes.length, 1);
  });
}

test('D38: Host-route screenshots are JPEG by default, PNG on request, and the codec is bound', async () => {
  const { executor, host } = await fixture({ helperOptions: { imageFormats: ['png', 'jpeg'] } });
  try {
    const [jpeg] = await executor.execute([{ action: 'screenshot' }]);
    assert.equal(jpeg.result.mimeType, 'image/jpeg');
    const [png] = await executor.execute([{ action: 'screenshot', format: 'png' }]);
    assert.equal(png.result.mimeType, 'image/png');
    assert.deepEqual(host.requests.filter(request => request.action === 'capture').map(request => request.params.format),
      ['jpeg', 'png']);
    const result = await new McpSession(executor).command({ action: 'screenshot' });
    assert.deepEqual(result.content.filter(item => item.type === 'image').map(item => item.mimeType), ['image/jpeg']);
  } finally { await executor.close(); }
  // A Host without image_formats is asked for nothing new and must send PNG.
  const legacy = await fixture();
  try {
    const [frame] = await legacy.executor.execute([{ action: 'screenshot' }]);
    assert.equal(frame.result.mimeType, 'image/png');
    assert.equal(legacy.host.requests.find(request => request.action === 'capture').params.format, undefined);
  } finally { await legacy.executor.close(); }
  for (const alter of [
    (request, response) => request.action === 'capture' ? { ...response, result: { ...response.result,
      image: image(), mimeType: 'image/png' } } : response,
    (request, response) => request.action === 'capture' ? { ...response, result: { ...response.result,
      image: Buffer.from(jpegImage(), 'base64').subarray(0, 60).toString('base64') } } : response,
  ]) {
    const wrong = await fixture({ helperOptions: { imageFormats: ['png', 'jpeg'], alter } });
    try { await assert.rejects(wrong.executor.execute([{ action: 'screenshot' }])); }
    finally { await wrong.executor.close(); }
  }
});

test('a partial or corrupt helper PNG is rejected without raw capture fallback', async () => {
  const { executor, vnc } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'capture') response.result.image =
      Buffer.from(response.result.image, 'base64').subarray(0, -4).toString('base64');
    return response;
  } } });
  await assert.rejects(executor.execute([{ action: 'screenshot' }]), /corrupt host-helper PNG/);
  assert.deepEqual(vnc.calls, []);
  assert.equal(vnc.closes.length, 1);
});

test('valid PNG chunk CRCs cannot conceal incomplete decoded pixel coverage', async () => {
  const { executor, vnc } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'capture') response.result.image = image(256, 128, Buffer.alloc(1));
    return response;
  } } });
  await assert.rejects(executor.execute([{ action: 'screenshot' }]), /Incomplete host-helper PNG pixels/);
  assert.deepEqual(vnc.calls, []);
  assert.equal(vnc.closes.length, 1);
});

test('PNG inflate output is bounded by the admitted dimensions', async () => {
  const { executor, vnc } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'capture') response.result.image = image(256, 128,
      Buffer.alloc((256 * 4 + 1) * 129));
    return response;
  } } });
  await assert.rejects(executor.execute([{ action: 'screenshot' }]), /corrupt host-helper PNG pixels/);
  assert.deepEqual(vnc.calls, []);
});

test('unknown critical PNG chunks are rejected even when CRC and pixel coverage pass', async () => {
  const { executor } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'capture') {
      const png = Buffer.from(response.result.image, 'base64');
      response.result.image = Buffer.concat([png.subarray(0, -12),
        chunk('EVIL', Buffer.alloc(0)), png.subarray(-12)]).toString('base64');
    }
    return response;
  } } });
  await assert.rejects(executor.execute([{ action: 'screenshot' }]), /corrupt host-helper PNG/);
});

test('PNG dimensions must use the requested rounded scaling before reaching the agent', async () => {
  const { executor } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'capture') {
      response.result.scaledHeight = 127;
      response.result.image = image(256, 127);
    }
    return response;
  } } });
  await assert.rejects(executor.execute([{ action: 'screenshot' }]), /capture scaling mismatch/);
});

test('aggregate capture budget refuses excess bytes before progress or successor input', async () => {
  const progress = [];
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping },
    responseBudgetFactory: () => new ResponseBudget({ maxBytes: 2000 }) });
  await assert.rejects(executor.execute([{ action: 'screenshot' }, { action: 'screenshot' },
    { action: 'key_tap', key: 'enter' }], { onResponse: response => progress.push(response) }), error => {
    assert.match(error.message, /response exceeds byte limit/);
    assert.equal(error.responses.length, 1);
    assert.equal(Object.hasOwn(error.responses[0].result, 'image'), false);
    return true;
  });
  assert.equal(progress.length, 1);
  assert.equal(Object.hasOwn(progress[0].result, 'image'), false);
  assert.deepEqual(vnc.calls, []);
  assert.equal(vnc.closes.length, 1);
});

test('several complete screenshots remain available when the shared batch budget admits them', async () => {
  const { executor } = await fixture({ responseBudgetFactory: () => new ResponseBudget({ maxBytes: 10000 }) });
  try {
    const results = await executor.execute([{ action: 'screenshot' }, { action: 'screenshot' }]);
    assert.equal(results.length, 2);
    assert.equal(results[0].result.image, image());
    assert.equal(results[1].result.image, image());
  } finally { await executor.close(); }
});

test('oversized action count is rejected without acquiring activity or issuing input', async () => {
  const { executor, vnc, host } = await fixture();
  try {
    await assert.rejects(executor.execute(Array.from({ length: 257 }, () => ({ action: 'wait' }))), /Invalid.*batch/);
    assert.deepEqual(vnc.calls, []);
    assert.deepEqual(host.requests.map(request => request.action), ['health']);
  } finally { await executor.close(); }
});

test('raw VNC-derived OCR/diff/crop actions fail explicitly with helper capture configured', async () => {
  const { executor, vnc, host } = await fixture();
  try {
    // Raw-pixel observations, old and new, are typed unsupported_on_route.
    for (const action of ['detect_elements', 'cursor_crop', 'diff_check', 'set_baseline',
      'zoom', 'wait_for_stable', 'expect_baseline', 'expect_change']) {
      await assert.rejects(executor.execute([{ action }]), error => {
        assert.match(error.message, /Action unavailable on the Host route/);
        assert.equal(error.code, 'unsupported_on_route');
        assert.equal(isPreAdmissionRefusal(error), true);
        return true;
      });
    }
    for (const action of ['configure', 'get_timing', 'shutdown']) {
      await assert.rejects(executor.execute([{ action }]), error => {
        assert.match(error.message, /Action unavailable/);
        assert.equal(error.code, 'unsupported_action');
        return true;
      });
    }
    // An expectation in a batch refuses the whole batch before any input.
    await assert.rejects(executor.execute([{ action: 'wait' }, { action: 'expect_baseline' },
      { action: 'mouse_click', x: 1, y: 1 }]), /Action unavailable/);
    await assert.rejects(executor.execute([{ action: 'wait' }, { action: 'detect_elements' }]),
      /Action unavailable/);
    assert.deepEqual(vnc.calls, []);
    assert.equal(vnc.closes.length, 0);
    assert.deepEqual(host.child.kills, []);
    assert.deepEqual(host.requests.map(request => request.action), ['health']);
    await executor.execute([{ action: 'screenshot' }]);
    assert.equal(host.state().overlay_ready, true);
  } finally { await executor.close(); }
});

test('helper health discovers bounded routes without acquiring activity and preserves unknown legacy native metadata', async () => {
  const { executor, vnc, host } = await fixture();
  try {
    const [response] = await executor.execute([{ action: 'health' }]);
    assert.deepEqual(response.result.capabilities, { backend: 'owned_sck', known: false,
      actions: ['screenshot', 'health', 'wait'], native: { known: false, actions: [] },
      inputMappingQualified: false });
    assert.deepEqual(vnc.calls, [{ action: 'health' }]);
    assert.deepEqual(host.requests.map(request => request.action), ['health']);
    assert.equal(host.state().overlay_ready, false);
    assert.equal(vnc.closes.length, 0);
    await executor.execute([{ action: 'wait' }]);
    assert.equal(host.state().overlay_ready, true);
  } finally { await executor.close(); }
});

test('known missing native adoption support refuses mapped input before helper begin or native writes', async () => {
  const { executor, vnc, host } = await fixture({ config: { ...configuration(), mapping },
    nativeOptions: { capabilities: ['health', 'wait', 'mouse_click'] } });
  try {
    assert.equal(executor.capabilities.known, true);
    assert.equal(executor.capabilities.actions.includes('mouse_click'), false);
    await assert.rejects(executor.execute([{ action: 'mouse_click', x: 1, y: 1 }]),
      /Action unavailable on native backend/);
    assert.deepEqual(vnc.calls, []);
    assert.deepEqual(vnc.permitControls, []);
    assert.deepEqual(host.requests.map(request => request.action), ['health']);
    assert.equal(vnc.closes.length, 0);
    await executor.execute([{ action: 'screenshot' }]);
    assert.equal(host.state().overlay_ready, true);
  } finally { await executor.close(); }
});

test('unsupported batch preserves an existing admitted helper lease until explicit release', async () => {
  const { executor, vnc, host } = await fixture();
  try {
    await executor.execute([{ action: 'screenshot' }]);
    const owner = host.state().session_id;
    const before = host.requests.length;
    await assert.rejects(executor.execute([{ action: 'detect_elements' }]), /Action unavailable/);
    assert.equal(host.requests.length, before);
    assert.equal(host.state().session_id, owner);
    assert.equal(host.state().overlay_ready, true);
    assert.equal(vnc.closes.length, 0);
    await executor.release();
    assert.equal(host.state().overlay_ready, false);
  } finally { await executor.close(); }
});

test('default wait remains compatible without introducing a raw pixel path', async () => {
  const { executor, vnc } = await fixture();
  try {
    await executor.execute([{ action: 'wait' }]);
    assert.deepEqual(vnc.calls, [{ action: 'wait' }]);
  } finally { await executor.close(); }
});

test('release receipt mismatch rejects clean release after the observed command has completed', async () => {
  const { executor, vnc } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'release_activity') response.result.instance_id = 'different-app';
    return response;
  } } });
  const [observation] = await executor.execute([{ action: 'screenshot' }]);
  assert.equal(observation.result.image, image());
  await assert.rejects(executor.release(), /release receipt mismatch/);
  assert.equal(vnc.closes.length, 1);
});

test('one activity lease and heartbeat persist between calls until explicit ownership release', async () => {
  const { executor, vnc, host } = await fixture();
  try {
    await executor.execute([{ action: 'screenshot' }]);
    const firstOwner = host.state().session_id;
    const renewals = host.requests.filter(request => request.action === 'renew_activity').length;
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(host.state().overlay_ready, true);
    assert.equal(host.state().session_id, firstOwner);
    assert.ok(host.requests.filter(request => request.action === 'renew_activity').length > renewals);
    await executor.execute([{ action: 'screenshot' }]);
    assert.equal(host.requests.filter(request => request.action === 'begin_activity').length, 1);
    assert.equal(host.requests.filter(request => request.action === 'release_activity').length, 0);
    await executor.release();
    assert.equal(host.requests.filter(request => request.action === 'release_activity').length, 1);
    assert.equal(host.state().overlay_ready, false);
    assert.equal(vnc.closes.length, 0);
  } finally { await executor.close(); }
});

test('idle heartbeat loss closes the owner and refuses future calls without reacquisition', async () => {
  const { executor, vnc, host } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'renew_activity' && request.params.sequence >= 3) return null;
    return response;
  } } });
  await executor.execute([{ action: 'screenshot' }]);
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.ok(executor.failed);
  assert.equal(vnc.closes.length, 1);
  await assert.rejects(executor.execute([{ action: 'screenshot' }]), /deadline|permit expired/);
  assert.equal(host.requests.filter(request => request.action === 'begin_activity').length, 1);
  assert.equal(host.requests.filter(request => request.action === 'capture').length, 1);
});

test('permit expiry between timer samples retires the owned executor without reacquisition',
  { timeout: 2000 }, async t => {
    const initialClock = 1000;
    const until = initialClock + 1;
    let crossExpiry = false;
    const samples = [];
    const { executor, vnc, host } = await fixture({ now() {
      if (!crossExpiry) return initialClock;
      const value = samples.length === 0 ? until - 0.1 : until;
      samples.push(value);
      return value;
    } });
    t.after(() => executor.close());
    await executor.execute([{ action: 'screenshot' }]);
    const ownedClosure = Promise.withResolvers();
    const close = vnc.close.bind(vnc);
    vnc.close = async options => {
      await close(options);
      ownedClosure.resolve();
    };
    executor.refreshPermit(until);
    crossExpiry = true;
    // The watchdog's first sample precedes expiry; refresh's next sample
    // reaches that same cutoff. Wait for owned closure, not a timing margin.
    await ownedClosure.promise;
    assert.deepEqual(samples.slice(0, 2), [until - 0.1, until]);
    const failure = executor.failed;
    assert.match(failure.message, /Host-helper input permit expired/);
    assert.equal(executor.permitUntil, until);
    assert.deepEqual(vnc.closes, [{ graceful: false }]);
    await assert.rejects(executor.execute([{ action: 'screenshot' }]), error => error === failure);
    await executor.close();
    assert.equal(executor.failed, failure);
    assert.equal(vnc.closes.length, 1);
    assert.deepEqual(vnc.calls, []);
    assert.deepEqual(vnc.permitControls, []);
    assert.equal(host.requests.filter(request => request.action === 'begin_activity').length, 1);
    assert.equal(host.requests.filter(request => request.action === 'capture').length, 1);
    assert.deepEqual(host.child.kills, ['SIGTERM']);
  });

test('human stop during a thinking gap revokes the owner before another input', async () => {
  let stopped = false;
  const { executor, vnc, host } = await fixture({ config: { ...configuration(), mapping },
    helperOptions: { alter(request, response) {
      if (request.action === 'renew_activity' && stopped) {
        response.result.ready = false;
        response.result.activity_eligible = false;
        response.result.human_stop_latched = true;
      }
      return response;
    } } });
  await executor.execute([{ action: 'screenshot' }]);
  stopped = true;
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.match(executor.failed.message, /receipt mismatch/);
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /receipt mismatch/);
  assert.deepEqual(vnc.calls, []);
  assert.equal(vnc.closes.length, 1);
  assert.equal(host.launches.length, 1);
});

test('native error acknowledgements terminate ownership and never authorize a successor action', async () => {
  const { executor, vnc, host } = await fixture({ nativeOptions: { run() {
    return [{ id: 'failed-native', error: { code: -32000, message: 'fixture refusal' } }];
  } } });
  await assert.rejects(executor.execute([{ action: 'wait' }, { action: 'wait' }]), error => {
    assert.match(error.message, /Native operation failed/);
    assert.equal(error.responses.length, 1);
    assert.equal(error.responses[0].error.code, -32000);
    return true;
  });
  await assert.rejects(executor.execute([{ action: 'wait' }]), /Native operation failed/);
  assert.equal(vnc.calls.length, 1);
  assert.equal(vnc.closes.length, 1);
  assert.equal(host.requests.filter(request => request.action === 'begin_activity').length, 1);
});

test('lost helper transport invalidates all future input without reconnect or replay', async () => {
  const { executor, vnc, host } = await fixture({ config: { ...configuration(), mapping } });
  host.child.emit('error', new Error('fixture transport disappeared'));
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /transport failed/);
  assert.deepEqual(vnc.calls, []);
  assert.equal(vnc.closes.length, 1);
  assert.equal(host.launches.length, 1);
});

test('measured SSH latency: a slow connect and 1.6 s captures complete with input still lease-bound', async t => {
  // Live PZM over SSH: first reply 0.5-0.9 s, warm replies ~5 ms, a 1080p
  // capture 1-2 s (PNG encode and transfer, not ScreenCaptureKit).
  let first = true;
  const latency = request => {
    if (first) { first = false; return 900; }
    return request.action === 'capture' ? 1600 : 5;
  };
  for (const pipelining of [false, true]) {
    await t.test(pipelining ? 'pipelining Host renews beside the capture' : 'serial Host lapses, then re-arms', async () => {
      first = true;
      const { executor, vnc, host } = await fixture({ config: { ...configuration(), mapping },
        helperOptions: { latency, serial: !pipelining, pipelining } });
      assert.ok(host.requests[0].answeredAt - host.requests[0].sentAt >= 850);
      try {
        const responses = await executor.execute([{ action: 'screenshot' }, { action: 'mouse_click', x: 4, y: 4 }]);
        assert.equal(responses.length, 2);
        assert.ok(responses[0].result.image);
        assert.deepEqual(vnc.calls.filter(action => action.action === 'mouse_click').length, 1);
        const captures = host.requests.filter(request => request.action === 'capture');
        assert.equal(captures.length, 2);
        const renewals = host.requests.filter(request => request.action === 'renew_activity');
        const during = renewals.filter(renewal => captures.some(capture =>
          renewal.sentAt > capture.sentAt && renewal.sentAt < capture.answeredAt));
        if (pipelining) assert.ok(during.length >= 4, `renewals during captures: ${during.length}`);
        else assert.equal(during.length, 0);
        // Input follows a renewal answered after the last capture finished.
        const last = captures.at(-1).answeredAt;
        assert.ok(renewals.some(renewal => renewal.sentAt >= last && renewal.answeredAt));
        assert.equal(executor.permitLapsedAt, undefined);
        assert.equal(executor.presentation.indicator, 'present');
      } finally { await executor.close(); }
    });
  }
});

test('slow link: a split capture keeps arriving past 3 s while renewals pass between its parts', async t => {
  // 147 ms ping and ~2 MB/s SSH: begin ~0.5 s at the Host, a 1.6 MB capture
  // reply arriving over several seconds. Progress, not a flat deadline, bounds it.
  const latency = request => request.action === 'begin_activity' ? 650 : request.action === 'capture' ? 900 : 150;
  await t.test('progressing reply completes', async () => {
    const { executor, host } = await fixture({ helperOptions: { latency, pipelining: true,
      partGapsMs: [100, 900, 900, 900, 900, 900] } });
    try {
      const [response] = await executor.execute([{ action: 'screenshot' }]);
      assert.ok(response.result.image);
      const capture = host.requests.find(request => request.action === 'capture');
      assert.equal(capture.params.reply_part_bytes, 65536);
      assert.ok(capture.answeredAt - capture.sentAt > 4500);
      assert.ok(host.requests.filter(request => request.action === 'renew_activity' &&
        request.sentAt > capture.sentAt && request.sentAt < capture.answeredAt).length >= 6);
    } finally { await executor.close(); }
  });
  await t.test('a stalled reply fails closed', async () => {
    const { executor } = await fixture({ helperOptions: { latency, pipelining: true, partGapsMs: [100, 3400] } });
    try {
      await assert.rejects(executor.execute([{ action: 'screenshot' }]), /receipt deadline exceeded/);
      await assert.rejects(executor.execute([{ action: 'screenshot' }]));
    } finally { await executor.close(); }
  });
});

test('a slow cold begin renews before the first heartbeat; a spent window arms only from that renewal', async t => {
  // Live PZM: begin_activity takes ~0.5 s at the Host, ~0.65 s over a 147 ms
  // link, leaving too little of its 1 s permit for the first heartbeat.
  const slow = begin => request => request.action === 'begin_activity' ? begin : 150;
  for (const [pipelining, begin] of [[false, 650], [true, 650], [true, 1200]]) {
    await t.test(`${pipelining ? 'pipelining' : 'serial'} Host, ${begin} ms begin`, async () => {
      const { executor, vnc, host } = await fixture({ config: { ...configuration(), mapping },
        helperOptions: { latency: slow(begin), serial: !pipelining, pipelining } });
      try {
        await executor.execute([{ action: 'mouse_click', x: 4, y: 4 }]);
        await new Promise(resolve => setTimeout(resolve, 700));
        assert.equal(executor.failed, undefined);
        assert.deepEqual(host.requests.slice(1, 3).map(request => request.action),
          ['begin_activity', 'renew_activity']);
        assert.equal(vnc.calls.filter(action => action.action === 'mouse_click').length, 1);
      } finally { await executor.close(); }
    });
  }
  await t.test('a spent begin whose renewal never answers sends no input and retires', async () => {
    const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, helperOptions: {
      latency: slow(1200), pipelining: true,
      alter: (request, response) => request.action === 'renew_activity' ? null : response } });
    try {
      await assert.rejects(executor.execute([{ action: 'mouse_click', x: 4, y: 4 }]),
        /receipt deadline|permit expired/);
      assert.ok(executor.failed);
      assert.equal(vnc.calls.filter(action => action.action === 'mouse_click').length, 0);
    } finally { await executor.close(); }
  });
});

test('a serial Host capture after mouse_down retires the owner rather than lapse with the button held', async () => {
  const latency = request => request.action === 'capture' ? 1600 : 5;
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping },
    helperOptions: { latency, serial: true, pipelining: false } });
  try {
    await assert.rejects(executor.execute([{ action: 'mouse_down', x: 2, y: 3 }, { action: 'screenshot' },
      { action: 'mouse_up' }]), /permit expired/);
    assert.deepEqual(vnc.calls.filter(action => action.action.startsWith('mouse_')).map(action => action.action),
      ['mouse_down']);
    assert.deepEqual(vnc.closes, [{ graceful: false }]);
  } finally { await executor.close(); }
});

test('500ms renewal deadline cancels an in-flight native command on helper stall', async () => {
  const config = { ...configuration(), mapping };
  const { executor, vnc, host } = await fixture({ config, helperOptions: {
    alter(request, response) {
      // The pre-input renewal succeeds; the periodic renewal stalls.
      if (request.action === 'renew_activity' && request.params.sequence >= 3) return null;
      return response;
    } }, nativeOptions: { run(actions, { signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('native cancelled')), { once: true });
      });
    } } });
  const started = performance.now();
  await assert.rejects(executor.execute([{ action: 'mouse_click', x: 2, y: 2 }]), /native cancelled|receipt deadline|permit expired/);
  assert.ok(performance.now() - started < 1800);
  assert.equal(vnc.calls.filter(action => action.action === 'mouse_click').length, 1);
  assert.deepEqual(vnc.closes, [{ graceful: false }]);
  assert.deepEqual(host.child.kills, ['SIGTERM']);
});

test('an otherwise timely renewal cannot revive a permit that expired during a long input action', async () => {
  let clock = 0;
  let markStarted;
  const inputStarted = new Promise(resolve => { markStarted = resolve; });
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, now: () => clock,
    helperOptions: { alter(request, response) {
      // Renewal send at950ms, ack at1050ms: RTT100ms is valid, but the
      // previous challenge's absolute1000ms input permit has expired.
      if (request.action === 'renew_activity' && request.params.sequence >= 3) clock += 100;
      return response;
    } }, nativeOptions: { run(actions, { signal }) {
      markStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('native cancelled')), { once: true });
      });
    } } });
  const result = executor.execute([{ action: 'mouse_click', x: 2, y: 2 }]);
  await inputStarted;
  clock = 950;
  await assert.rejects(result, /permit expired|native cancelled/);
  assert.match(executor.failed.message, /permit expired/);
  assert.equal(vnc.calls.filter(action => action.action === 'mouse_click').length, 1);
  assert.deepEqual(vnc.closes, [{ graceful: false }]);
});

test('a native reply after broker suspension does not authorize the next input', async () => {
  let clock = 0;
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, now: () => clock,
    nativeOptions: { run() {
      clock = 1001;
      return [{ id: 'native-input', result: { detail: 'input result after suspension' } }];
    } } });
  await assert.rejects(executor.execute([{ action: 'mouse_click', x: 2, y: 2 },
    { action: 'key_tap', key: 'enter' }]), /permit expired/);
  assert.equal(vnc.calls.filter(action => action.action === 'mouse_click').length, 1);
  assert.equal(vnc.calls.filter(action => action.action === 'key_tap').length, 0);
  assert.equal(vnc.closes.length, 1);
});

test('caller cancellation terminates owned input and does not replay an uncertain click', async () => {
  let markStarted;
  const inputStarted = new Promise(resolve => { markStarted = resolve; });
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, nativeOptions: {
    run(actions, { signal }) {
      markStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('native cancelled')), { once: true });
      });
    } } });
  const controller = new AbortController();
  const action = { action: 'mouse_click', x: 2, y: 2 };
  const result = executor.execute([action], { signal: controller.signal });
  await inputStarted;
  controller.abort();
  await assert.rejects(result, /native cancelled|cancelled/);
  await assert.rejects(executor.execute([action]), /cancelled/);
  assert.equal(vnc.calls.filter(input => input.action === 'mouse_click').length, 1);
  assert.equal(vnc.closes.length, 1);
});

test('queued deadline returns promptly without killing the current owner or sending cancelled input', async () => {
  let markStarted, release;
  const inputStarted = new Promise(resolve => { markStarted = resolve; });
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, nativeOptions: {
    run() {
      markStarted();
      return new Promise(resolve => { release = () => resolve([{ id: 'native-input', result: { detail: 'done' } }]); });
    } } });
  try {
    const first = executor.execute([{ action: 'mouse_click', x: 2, y: 2 }]);
    await inputStarted;
    const started = performance.now();
    await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }], { timeoutMs: 10 }), /deadline exceeded/);
    assert.ok(performance.now() - started < 200);
    assert.equal(vnc.closes.length, 0);
    release();
    await first;
    await executor.tail;
    assert.equal(vnc.calls.filter(action => action.action === 'key_tap').length, 0);
  } finally { await executor.close(); }
});

test('invalid bootstrap command is refused before any SSH or GUI process starts', async () => {
  const vnc = native(); const host = helper();
  await assert.rejects(createHostHelperExecutor({ nativeExecutor: vnc,
    hostHelper: { ...configuration(), command: ['/usr/bin/open', '/Applications/FruitctlHost.app'] },
    spawnImpl: host.spawnImpl }), /configuration/);
  assert.equal(host.launches.length, 0);
  assert.deepEqual(vnc.closes, [{ graceful: false }]);
});

test('an arbitrary executable cannot be disguised as a host attachment with --stdio', async () => {
  const vnc = native(); const host = helper();
  await assert.rejects(createHostHelperExecutor({ nativeExecutor: vnc,
    hostHelper: { ...configuration(), command: ['/usr/bin/open', '--stdio'] },
    spawnImpl: host.spawnImpl }), /configuration/);
  assert.equal(host.launches.length, 0);
  assert.equal(vnc.closes.length, 1);
});

test('clean release requires native acknowledgement and confirms the resident overlay is clear', async () => {
  const { executor, vnc, host } = await fixture();
  await executor.execute([{ action: 'screenshot' }]);
  await executor.release();
  assert.equal(vnc.releases.length, 1);
  assert.equal(vnc.closes.length, 0);
  assert.equal(host.requests.at(-1).action, 'health');
  assert.deepEqual(host.child.kills, ['SIGTERM']);
  await assert.rejects(executor.execute([{ action: 'screenshot' }]), /releasing/);
  await executor.release();
  assert.equal(vnc.releases.length, 1);
});

test('ownership indication renews while native clean shutdown is pending and clears only afterwards', async () => {
  let finishShutdown;
  const shutdown = new Promise(resolve => { finishShutdown = resolve; });
  const { executor, vnc, host } = await fixture({ nativeOptions: { releaseRun: () => shutdown } });
  await executor.execute([{ action: 'screenshot' }]);
  const renewals = host.requests.filter(request => request.action === 'renew_activity').length;
  const released = executor.release();
  try {
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(vnc.releases.length, 1);
    assert.equal(host.state().overlay_ready, true);
    assert.ok(host.requests.filter(request => request.action === 'renew_activity').length > renewals);
    assert.equal(host.requests.filter(request => request.action === 'release_activity').length, 0);
    finishShutdown();
    await released;
    assert.equal(host.state().overlay_ready, false);
    assert.equal(executor.released, true);
  } finally { finishShutdown(); await executor.close(); }
});

for (const event of ['concurrent close', 'lost readiness']) {
  test(`${event} during native shutdown cannot become a clean ownership-release claim`, async () => {
    let revoke = false;
    const { executor, vnc } = await fixture({ helperOptions: { alter(request, response) {
      if (revoke && request.action === 'renew_activity') response.result.ready = false;
      return response;
    } }, nativeOptions: { releaseRun({ signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    } } });
    await executor.execute([{ action: 'screenshot' }]);
    const released = assert.rejects(executor.release(), /closed|receipt mismatch/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(vnc.releases.length, 1);
    if (event === 'concurrent close') await executor.close();
    else revoke = true;
    await released;
    assert.equal(executor.released, undefined);
    assert.equal(vnc.closes.length, 1);
    await assert.rejects(executor.execute([{ action: 'screenshot' }]), /releasing/);
  });
}

test('native clean-release failure is propagated rather than relabeled as clean ownership release', async () => {
  const { executor, vnc } = await fixture({ nativeOptions: {
    releaseError: new Error('Native shutdown acknowledgement unavailable') } });
  const startedAt = performance.now();
  await assert.rejects(executor.release({ timeoutMs: 1000 }), /shutdown acknowledgement unavailable/);
  assert.equal(vnc.releases.length, 1);
  assert.equal(vnc.closes.length, 1);
  assert.equal(vnc.closes[0].graceful, false);
  assert.ok(Number.isFinite(vnc.closes[0].deadline));
  assert.ok(vnc.closes[0].deadline >= startedAt + 1000);
  assert.ok(vnc.closes[0].deadline <= performance.now() + 1000);
  assert.ok(vnc.releases[0].timeoutMs <= 1000);
  assert.equal(vnc.closes[0].signal, vnc.releases[0].signal);
  assert.equal(vnc.closes[0].signal.aborted, true);
  assert.equal(executor.released, undefined);
});

test('an uncleared or changed resident overlay prevents a clean-release claim', async () => {
  let healthCount = 0;
  const { executor, vnc } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'health' && ++healthCount > 1) response.result.overlay_ready = true;
    return response;
  } } });
  await assert.rejects(executor.release(), /overlay release unconfirmed/);
  assert.equal(vnc.releases.length, 1);
  assert.equal(vnc.closes.length, 1);
  assert.equal(executor.released, undefined);
});

test('clean release awaits confirmed close of its owned SSH child and escalates a refused TERM', async () => {
  const { executor, vnc, host } = await fixture({ helperOptions: { ignoreTerm: true } });
  const result = executor.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executor.released, undefined);
  await result;
  assert.equal(vnc.releases.length, 1);
  assert.deepEqual(host.child.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(executor.released, true);
});

test('unconfirmed owned SSH close fails clean release and remains failed', async () => {
  const { executor, vnc, host } = await fixture({ helperOptions: { ignoreTerm: true, ignoreKill: true } });
  await assert.rejects(executor.release(), /owned SSH exit unconfirmed/);
  assert.equal(executor.released, undefined);
  assert.equal(vnc.releases.length, 1);
  assert.equal(vnc.closes.length, 1);
  assert.deepEqual(host.child.kills, ['SIGTERM', 'SIGKILL']);
  await assert.rejects(executor.close(), /owned SSH exit unconfirmed/);
});

test('helper close forwards one deadline and signal while retaining late owned native closure', async () => {
  const { executor, vnc, host } = await fixture({ helperOptions: { ignoreTerm: true, ignoreKill: true } });
  let finishNative;
  const nativeGate = new Promise(resolve => { finishNative = resolve; });
  vnc.close = async options => { vnc.closes.push(options); await nativeGate; };
  const controller = new AbortController();
  const deadline = performance.now() + 40;
  const closing = executor.close({ deadline, signal: controller.signal });
  const tracked = executor.nativeClosing;
  assert.equal(vnc.closes.length, 1);
  assert.equal(vnc.closes[0].deadline, deadline);
  assert.equal(vnc.closes[0].signal, controller.signal);
  assert.equal(vnc.closes[0].graceful, false);
  await assert.rejects(closing, error => error.code === 'release_unconfirmed');
  assert.deepEqual(host.child.kills, ['SIGTERM', 'SIGKILL']);
  const sticky = executor.failed;
  finishNative();
  host.child.emit('close', null, 'SIGKILL');
  await tracked;
  assert.equal(executor.nativeClosing, tracked);
  assert.equal(executor.failed, sticky);
  await assert.rejects(executor.execute([{ action: 'mouse_click', x: 1, y: 1 }]), /executor closed/);
  assert.deepEqual(vnc.calls, []);
  await assert.rejects(executor.close(), /owned SSH exit unconfirmed/);
});

test('helper close shortens existing owned cleanup without replacing its original promises', async () => {
  const { executor, vnc, host } = await fixture({ helperOptions: { ignoreTerm: true, ignoreKill: true } });
  let finishNative;
  const nativeGate = new Promise(resolve => { finishNative = resolve; });
  vnc.close = async options => { vnc.closes.push(options); await nativeGate; };
  const originalFailure = new Error('owned prior input failure');
  executor.fail(originalFailure);
  const nativeClosing = executor.nativeClosing, helperClosing = executor.helperClosing;
  const controller = new AbortController();
  const deadline = performance.now() + 40;
  const closing = executor.close({ deadline, signal: controller.signal });
  assert.equal(executor.nativeClosing, nativeClosing);
  assert.equal(executor.helperClosing, helperClosing);
  assert.deepEqual(vnc.closes[0], { graceful: false });
  assert.equal(vnc.closes[1].deadline, deadline);
  assert.equal(vnc.closes[1].signal, controller.signal);
  await assert.rejects(closing, /owned SSH exit unconfirmed/);
  finishNative();
  host.child.emit('close', null, 'SIGKILL');
  await Promise.all([nativeClosing, executor.nativeClosingUpdate]);
  assert.equal(executor.failed, originalFailure);
  await assert.rejects(executor.close(), /owned SSH exit unconfirmed/);
});

test('helper SSH shutdown uses the remaining clean-release budget after native release', async () => {
  let now = 1000;
  const { executor, vnc, host } = await fixture({ now: () => now,
    nativeOptions: { releaseRun: async () => { now += 30; } },
    helperOptions: { ignoreTerm: true, ignoreKill: true } });
  await assert.rejects(executor.release({ timeoutMs: 40 }), /owned SSH exit unconfirmed/);
  assert.equal(executor.channel.closeDeadline, 1040);
  assert.equal(vnc.closes[0].deadline, 1040);
  assert.equal(executor.released, undefined);
  assert.deepEqual(host.child.kills, ['SIGTERM', 'SIGKILL']);
  host.child.emit('close', null, 'SIGKILL');
  await assert.rejects(executor.close(), /owned SSH exit unconfirmed/);
});

// TIN-6603: display UUID binding, HiDPI scale and the Host-only AX snapshot.
const DISPLAY_UUID = '37D8832A-2D66-02CA-B9F7-8F30A301B230';
const axSnapshot = (overrides = {}) => ({ schema: 'fruitctl.ax-snapshot.v1', coordinate_space: 'framebuffer_pixels',
  framebuffer: { pixel_width: 512, pixel_height: 256, point_width: 256, point_height: 128, scale: 2 },
  depth: 6, focused_app: true, truncated: false, node_count: 2,
  applications: [{ pid: 77, ref: 'ax:77:0', bundle_id: 'com.example.app', name: 'Example' }],
  nodes: [{ ref: 'ax:77:0', parent: null, depth: 0, role: 'AXApplication', frame: null },
    { ref: 'ax:77:0.0', parent: 'ax:77:0', depth: 1, role: 'AXButton', label: 'OK',
      frame: { x: 20, y: 40, width: 60, height: 80 } }], ...overrides });
const axHost = ({ trusted = true, snapshot = axSnapshot(), uuid } = {}) => ({ alter(request, response) {
  if (!response.success) return response;
  const result = { ...response.result, accessibility_trusted: trusted,
    ...(uuid === undefined ? {} : { display_uuid: uuid }) };
  if (request.action === 'health') result.capabilities = ['capture', 'begin_activity', 'renew_activity',
    'release_activity', 'export_idle_reference', 'ax_snapshot'];
  if (request.action === 'ax_snapshot') result.ax_snapshot = snapshot;
  return { ...response, result };
} });

test('display UUID configuration is canonicalized, needs one identity and binds the qualified mapping', async () => {
  const base = configuration();
  delete base.displayId;
  assert.throws(() => new HostHelperExecutor({ nativeExecutor: native(), hostHelper: base,
    spawnImpl: helper().spawnImpl }), /Invalid host-helper configuration/);
  for (const displayUuid of ['not-a-uuid', 7, '37D8832A2D6602CAB9F78F30A301B230']) {
    assert.throws(() => new HostHelperExecutor({ nativeExecutor: native(), hostHelper: { ...base, displayUuid },
      spawnImpl: helper().spawnImpl }), /Invalid host-helper configuration/);
  }
  const uuidMapping = { ...mapping, displayId: undefined, displayUuid: DISPLAY_UUID.toLowerCase() };
  for (const invalid of [{ ...uuidMapping, displayUuid: undefined }, { ...uuidMapping, displayId: 42 },
    { ...uuidMapping, scale: 0.5 }, { ...uuidMapping, scale: Number.NaN }]) {
    assert.throws(() => new HostHelperExecutor({ nativeExecutor: native(),
      hostHelper: { ...base, displayUuid: DISPLAY_UUID, mapping: invalid }, spawnImpl: helper().spawnImpl }),
    /Invalid qualified host-helper mapping/);
  }
  const executor = new HostHelperExecutor({ nativeExecutor: native(), spawnImpl: helper().spawnImpl,
    hostHelper: { ...base, displayUuid: DISPLAY_UUID.toLowerCase(), mapping: { ...uuidMapping, scale: 2 } } });
  try {
    assert.equal(executor.config.displayUuid, DISPLAY_UUID);
    assert.equal(executor.config.mapping.displayUuid, DISPLAY_UUID);
    assert.equal(executor.displayId, undefined);
  } finally { await executor.close(); }
});

test('a UUID-only profile learns the display ID from health and sends the UUID on every request', async () => {
  const config = configuration();
  delete config.displayId;
  config.displayUuid = DISPLAY_UUID;
  const { executor, host } = await fixture({ config, helperOptions: axHost({ uuid: DISPLAY_UUID }) });
  try {
    assert.equal(executor.displayId, 42);
    const [response] = await executor.execute([{ action: 'screenshot' }]);
    assert.equal(response.result.display_id, 42);
    assert.ok(host.requests.every(request => request.action === 'release_activity' ||
      request.params.display_uuid === DISPLAY_UUID));
    assert.ok(host.requests.filter(request => request.action !== 'release_activity')
      .every(request => request.action === 'health' ? request.params.display_id === undefined
        : request.params.display_id === 42));
  } finally { await executor.close(); }
  await assert.rejects(fixture({ config, helperOptions: axHost({ uuid: '00000000-0000-4000-8000-000000000000' }) }),
    /Host-helper health binding failed/);
  await assert.rejects(fixture({ config }), /Host-helper health binding failed/);
});

test('capture scale must match pixels per point and a qualified mapping scale', async () => {
  const scaled = (scale, extra = {}) => ({ alter(request, response) {
    if (request.action !== 'capture') return response;
    return { ...response, result: { ...response.result, scale, pixel_width: 512, pixel_height: 256, ...extra } };
  } });
  {
    const { executor } = await fixture({ helperOptions: scaled(2) });
    try {
      const [response] = await executor.execute([{ action: 'screenshot' }]);
      assert.equal(response.result.scale, 2);
    } finally { await executor.close(); }
  }
  for (const options of [scaled(3), scaled(2, { pixel_width: 256 }), scaled(9)]) {
    const { executor } = await fixture({ helperOptions: options });
    try {
      await assert.rejects(executor.execute([{ action: 'screenshot' }]), /Invalid host-helper capture geometry/);
    } finally { await executor.close(); }
  }
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping: { ...mapping, scale: 1 } },
    helperOptions: scaled(2) });
  try {
    await assert.rejects(executor.execute([{ action: 'key_tap', key: 'tab' }]),
      /Host-helper qualified mapping changed/);
    assert.equal(vnc.calls.some(action => action.action === 'key_tap'), false);
  } finally { await executor.close(); }
});

test('ax_snapshot routes to the Host under the activity lease with pixel and display frames', async () => {
  const { executor, vnc, host } = await fixture({ helperOptions: axHost() });
  try {
    assert.ok(executor.capabilities.actions.includes('ax_snapshot'));
    const [response] = await executor.execute([{ action: 'ax_snapshot', depth: 3, focused_app: false }]);
    const request = host.requests.find(entry => entry.action === 'ax_snapshot');
    assert.equal(request.params.depth, 3);
    assert.equal(request.params.focused_app, false);
    assert.equal(request.params.session_id, host.state().session_id);
    assert.deepEqual(host.requests.map(entry => entry.action), ['health', 'begin_activity', 'renew_activity',
      'ax_snapshot']);
    assert.equal(response.result.detail, 'ax_snapshot: 2 nodes');
    assert.equal(response.result.session_id, undefined);
    assert.equal(response.result.challenge, undefined);
    const button = response.result.ax_snapshot.nodes[1];
    assert.deepEqual(button.frame, { x: 20, y: 40, width: 60, height: 80 });
    assert.deepEqual(button.display_frame, { x: 10, y: 20, width: 30, height: 40 });
    assert.deepEqual(response.result.ax_snapshot.display, { width: 256, height: 128 });
    assert.equal(response.result.ax_snapshot.nodes[0].display_frame, undefined);
    assert.deepEqual(vnc.calls, []);
    // A VNC display with another aspect still yields the Host screenshot's
    // uniform scaling, never independent per-axis factors.
    vnc.display = { width: 300, height: 100 };
    const [wide] = await executor.execute([{ action: 'ax_snapshot' }]);
    assert.deepEqual(wide.result.ax_snapshot.display, { width: 300, height: 150 });
    assert.deepEqual(wide.result.ax_snapshot.nodes[1].display_frame, { x: 11, y: 23, width: 35, height: 47 });
  } finally { await executor.close(); }
});

test('malformed AX snapshots fail closed', async t => {
  const node = axSnapshot().nodes[1];
  const cases = {
    schema: axSnapshot({ schema: 'other' }),
    'frame outside framebuffer': axSnapshot({ nodes: [axSnapshot().nodes[0], { ...node, frame: { x: 500, y: 0, width: 60, height: 1 } }] }),
    'orphan parent': axSnapshot({ nodes: [axSnapshot().nodes[0], { ...node, parent: 'ax:77:0.9' }] }),
    'redacted with value': axSnapshot({ nodes: [axSnapshot().nodes[0], { ...node, value_redacted: true, value: 'x' }] }),
    'count mismatch': axSnapshot({ node_count: 5 }),
    'unbounded label': axSnapshot({ nodes: [axSnapshot().nodes[0], { ...node, label: 'x'.repeat(257) }] }),
    'unbounded application name': axSnapshot({ applications: [{ ...axSnapshot().applications[0], name: 'x'.repeat(257) }] }),
    'non-string bundle id': axSnapshot({ applications: [{ ...axSnapshot().applications[0], bundle_id: 7 }] }),
  };
  for (const [name, snapshot] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { executor } = await fixture({ helperOptions: axHost({ snapshot }) });
      try {
        await assert.rejects(executor.execute([{ action: 'ax_snapshot' }]), /Invalid host-helper AX snapshot/);
      } finally { await executor.close(); }
    });
  }
});

test('ax_snapshot refuses before admission on an older Host, invalid parameters or a missing grant', async () => {
  {
    const { executor, host } = await fixture();
    try {
      assert.equal(executor.capabilities.actions.includes('ax_snapshot'), false);
      await assert.rejects(executor.execute([{ action: 'ax_snapshot' }]), error =>
        isPreAdmissionRefusal(error) && /predates it/.test(error.message));
      assert.deepEqual(host.requests.map(entry => entry.action), ['health']);
    } finally { await executor.close(); }
  }
  {
    const { executor } = await fixture({ helperOptions: axHost() });
    try {
      for (const action of [{ action: 'ax_snapshot', depth: 0 }, { action: 'ax_snapshot', depth: 13 },
        { action: 'ax_snapshot', focused_app: 'yes' }]) {
        await assert.rejects(executor.execute([action]), error => isPreAdmissionRefusal(error));
      }
    } finally { await executor.close(); }
  }
  const { executor, host } = await fixture({ helperOptions: axHost({ trusted: false }) });
  try {
    await assert.rejects(executor.execute([{ action: 'ax_snapshot' }]), error =>
      isPreAdmissionRefusal(error) && error.code === 'accessibility_permission_required');
    assert.deepEqual(host.requests.map(entry => entry.action), ['health']);
  } finally { await executor.close(); }
});

test('a Host accessibility refusal keeps its sanitized typed reason', async () => {
  const { executor, host } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'ax_snapshot') return refused(request, 'accessibility_permission_required');
    return axHost().alter(request, response);
  } } });
  try {
    await assert.rejects(executor.execute([{ action: 'ax_snapshot' }]), error => {
      const id = host.requests.find(entry => entry.action === 'ax_snapshot').id;
      assert.equal(error.message, `Host helper refused request: accessibility_permission_required; request=${id}`);
      return true;
    });
  } finally { await executor.close(); }
});

// TIN-6603 M2b part 2: ref-addressed click_element / focus_element.
const pressed = params => ({ ref: params.ref, action: params.action, generation: params.generation,
  path: params.action === 'press' ? 'ax_press' : 'ax_focus', surface: 'sheet', role: 'AXButton',
  ax_result: 'performed', verified: true });
const axActionHost = ({ outcome = pressed, verified = true, snapshot = axSnapshot({ generation: 4 }),
  events = [], refuse } = {}) => ({ alter(request, response) {
  events.push(request.action);
  if (refuse?.[request.action]) return refused(request, refuse[request.action]);
  const altered = axHost({ snapshot }).alter(request, response);
  if (!altered.success) return altered;
  if (request.action === 'health') altered.result.capabilities.push('ax_action');
  if (request.action === 'ax_action') altered.result.ax_action = outcome(request.params);
  if (request.action === 'ax_verify') altered.result.ax_verify = { ref: request.params.ref,
    action: request.params.action, generation: request.params.generation, verified };
  return altered;
} });

test('click_element and focus_element act through the Host on a ref from the latest snapshot', async () => {
  const { executor, vnc, host } = await fixture({ helperOptions: axActionHost() });
  try {
    assert.ok(['click_element', 'focus_element'].every(action => executor.capabilities.actions.includes(action)));
    await executor.execute([{ action: 'ax_snapshot' }]);
    const [clicked] = await executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]);
    const request = host.requests.find(entry => entry.action === 'ax_action');
    assert.deepEqual({ ref: request.params.ref, action: request.params.action, generation: request.params.generation,
      vnc_fallback: request.params.vnc_fallback, session: request.params.session_id },
    { ref: 'ax:77:0.0', action: 'press', generation: 4, vnc_fallback: false, session: host.state().session_id });
    assert.deepEqual(clicked.result.ax_action, { ref: 'ax:77:0.0', action: 'click_element', surface: 'sheet',
      role: 'AXButton', path: 'ax_press', verified: true, ax_result: 'performed' });
    assert.equal(clicked.result.detail, 'click_element ax:77:0.0: ax_press, verified true');
    const [focused] = await executor.execute([{ action: 'focus_element', ref: 'ax:77:0' }]);
    assert.equal(focused.result.ax_action.path, 'ax_focus');
    assert.equal(host.requests.filter(entry => entry.action === 'ax_action').at(-1).params.action, 'focus');
    // The AX path never touches VNC input.
    assert.deepEqual(vnc.calls, []);
  } finally { await executor.close(); }
});

test('element actions refuse before admission without a current ref, a capable Host or the grant', async () => {
  const refusedWith = (code, pattern) => error => isPreAdmissionRefusal(error) &&
    (code === undefined || error.code === code) && pattern.test(error.message);
  {
    const { executor, host } = await fixture({ helperOptions: axActionHost() });
    try {
      await assert.rejects(executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]),
        refusedWith('stale_ref', /latest ax_snapshot/));
      assert.deepEqual(host.requests.map(entry => entry.action), ['health']);
      await executor.execute([{ action: 'ax_snapshot' }]);
      for (const ref of ['ax:77:0.5', undefined]) {
        await assert.rejects(executor.execute([{ action: 'focus_element', ref }]), error => isPreAdmissionRefusal(error));
      }
      await assert.rejects(executor.execute([{ action: 'click_element', ref: 'ax:77:0.0;x' }]),
        refusedWith(undefined, /Invalid click_element ref/));
      assert.equal(host.requests.some(entry => entry.action === 'ax_action'), false);
    } finally { await executor.close(); }
  }
  {
    // A snapshot from a Host without element actions yields no refs.
    const { executor, host } = await fixture({ helperOptions: axHost() });
    try {
      assert.equal(executor.capabilities.actions.includes('click_element'), false);
      await executor.execute([{ action: 'ax_snapshot' }]);
      await assert.rejects(executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]),
        refusedWith(undefined, /predates it/));
      assert.equal(host.requests.some(entry => entry.action === 'ax_action'), false);
    } finally { await executor.close(); }
  }
  const { executor } = await fixture({ helperOptions: axActionHost({ snapshot: axSnapshot({ generation: 2 }) }) });
  try {
    await executor.execute([{ action: 'ax_snapshot' }]);
    // D15: a Host that last reported the human Stop latch gets no element action.
    executor.humanStopLatched = true;
    await assert.rejects(executor.execute([{ action: 'focus_element', ref: 'ax:77:0.0' }]),
      refusedWith('human_stop_latched', /Stop is latched/));
    executor.humanStopLatched = false;
    executor.accessibilityTrusted = false;
    await assert.rejects(executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]),
      refusedWith('accessibility_permission_required', /Accessibility grant/));
  } finally { await executor.close(); }
});

test('Host element refusals keep a typed code as a per-call error with no VNC click or retirement', async () => {
  // #159: each reason is raised before any AX call that may have acted.
  for (const reason of ['stale_ref', 'ax_unreachable', 'ax_action_unsupported', 'human_consent_required']) {
    const { executor, vnc } = await fixture({ config: { ...configuration(), mapping },
      helperOptions: axActionHost({ refuse: { ax_action: reason } }) });
    try {
      await executor.execute([{ action: 'ax_snapshot' }]);
      const responses = await executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' },
        { action: 'mouse_click', x: 1, y: 1 }]);
      assert.equal(responses.length, 1);
      const { error } = responses[0];
      // On the wire: -32020 with the typed code in data.code (old clients).
      assert.ok(error.code === -32020 && error.data.code === reason && error.message.includes(reason) &&
        // A consent refusal carries the sentinel's data shape to MCP.
        (reason !== 'human_consent_required' || error.data?.reason === reason));
      assert.equal(executor.failed, undefined);
      assert.equal(vnc.calls.some(action => action.action === 'mouse_click'), false);
    } finally { await executor.close(); }
  }
});

test('an unsupported AX action falls back to one VNC click through the qualified input path, then verifies', async () => {
  const events = [];
  const fallback = params => ({ ref: params.ref, action: params.action, generation: params.generation,
    path: 'vnc_click_required', surface: 'menu_extra', role: 'AXMenuBarItem', subrole: 'AXMenuExtra',
    fallback_point: { x: 101, y: 61 } });
  const { executor, vnc, host } = await fixture({ config: { ...configuration(), mapping },
    nativeOptions: { run(actions) { events.push(...actions.map(action => `native:${action.action}`));
      return actions.map(() => ({ id: 'native-input', result: { detail: 'input acknowledged' } })); } },
    helperOptions: axActionHost({ outcome: fallback, verified: false, events }) });
  try {
    await executor.execute([{ action: 'ax_snapshot' }]);
    events.length = 0;
    const [response] = await executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]);
    assert.equal(host.requests.find(entry => entry.action === 'ax_action').params.vnc_fallback, true);
    // Framebuffer (101, 61) of 512x256 lands at (50, 30) in the 256x128 mapped display.
    assert.deepEqual(vnc.calls.filter(action => action.action === 'mouse_click'), [{ action: 'mouse_click', x: 50, y: 30 }]);
    // The click follows the mapping check and the native observation handshake.
    assert.deepEqual(vnc.calls.map(action => action.action), ['health', 'adopt_observation', 'mouse_click']);
    assert.deepEqual(events.filter(name => ['ax_action', 'capture', 'native:mouse_click', 'ax_verify'].includes(name)),
      ['ax_action', 'capture', 'native:mouse_click', 'ax_verify']);
    const verify = host.requests.find(entry => entry.action === 'ax_verify').params;
    assert.deepEqual([verify.ref, verify.action, verify.generation], ['ax:77:0.0', 'press', 4]);
    assert.deepEqual(response.result.ax_action, { ref: 'ax:77:0.0', action: 'click_element', surface: 'menu_extra',
      role: 'AXMenuBarItem', subrole: 'AXMenuExtra', path: 'vnc_click', verified: false, point: { x: 50, y: 30 } });
  } finally { await executor.close(); }
});

test('AX action receipts that do not answer the request fail closed', async t => {
  const cases = {
    'other ref': params => ({ ...pressed(params), ref: 'ax:77:0' }),
    'press reported as focus': params => ({ ...pressed(params), path: 'ax_focus' }),
    'missing verdict': params => { const { verified, ...rest } = pressed(params); return rest; },
    'unknown surface': params => ({ ...pressed(params), surface: 'dock' }),
    'unoffered fallback': params => ({ ref: params.ref, action: params.action, generation: params.generation,
      path: 'vnc_click_required', surface: 'window', role: 'AXImage', fallback_point: { x: 1, y: 1 } }),
    'fallback outside framebuffer': params => ({ ref: params.ref, action: params.action, generation: params.generation,
      path: 'vnc_click_required', surface: 'window', role: 'AXImage', fallback_point: { x: 512, y: 1 } }),
  };
  for (const [name, outcome] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { executor, vnc } = await fixture({ helperOptions: axActionHost({ outcome }) });
      try {
        await executor.execute([{ action: 'ax_snapshot' }]);
        await assert.rejects(executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]),
          /Invalid host-helper AX action receipt|outside the qualified mapping/);
        assert.equal(vnc.calls.some(action => action.action === 'mouse_click'), false);
      } finally { await executor.close(); }
    });
  }
});

// TIN-5509: a maximum-budget renewal needs dispatch headroom within the same permit.
test('deadline renewal survives a bounded dispatch stall without extending its permit', async () => {
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, helperOptions: {
    pipelining: true, imageFormats: ['jpeg', 'png'],
    latency: request => request.action === 'renew_activity' ? 450 : 0 } });
  let stall;
  try {
    await executor.execute([{ action: 'screenshot' }]);
    const acceptedSend = executor.permitUntil - 1000;
    // No Host reply is due during this 120 ms event-loop dispatch stall.
    stall = setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120),
      Math.max(0, acceptedSend + 480 - performance.now()));
    await new Promise(resolve => setTimeout(resolve, 850));
    assert.equal(executor.failed, undefined);
    await executor.execute([{ action: 'mouse_click', x: 4, y: 4 }, { action: 'wait', ms: 50 }]);
    assert.equal(vnc.calls.filter(action => action.action === 'mouse_click').length, 1);
    assert.equal(vnc.calls.some(action => action.action === 'mouse_down'), false);
  } finally { clearTimeout(stall); await executor.close(); }
});

test('a queued renewal callback cannot restart activity after acknowledged release', async () => {
  const { executor, vnc, host } = await fixture();
  let queued;
  const originalTimeout = globalThis.setTimeout;
  try {
    await executor.execute([{ action: 'screenshot' }]);
    // Capture a callback already dispatched by the timer, while release runs.
    globalThis.setTimeout = callback => {
      queued = callback;
      return originalTimeout(() => {}, 60000);
    };
    try { executor.scheduleRenewal(); }
    finally { globalThis.setTimeout = originalTimeout; }
    assert.equal(typeof queued, 'function');
    await executor.release();
    const requests = host.requests.length, controls = vnc.permitControls.length;
    queued();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executor.failed, undefined);
    assert.equal(executor.activityActive, false);
    assert.equal(host.requests.length, requests);
    assert.equal(vnc.permitControls.length, controls);
  } finally { globalThis.setTimeout = originalTimeout; await executor.close(); }
});

test('a long progressing observation retains its original challenge only until completion', async () => {
  const { executor, host } = await fixture({ helperOptions: {
    latency: request => request.action === 'begin_activity' ? 650 : request.action === 'capture' ? 900 : 150,
    pipelining: true, partGapsMs: [100, 1900, 1900, 1900, 1900, 1900, 1900] } });
  try {
    const [response] = await executor.execute([{ action: 'screenshot' }]);
    assert.ok(response.result.image);
    const capture = host.requests.find(request => request.action === 'capture');
    assert.ok(capture.answeredAt - capture.sentAt > 11000);
    assert.ok(host.requests.filter(request => request.action === 'renew_activity' &&
      request.sentAt > capture.sentAt && request.sentAt < capture.answeredAt).length > 16);
    assert.ok(executor.issued.size <= 16);
    assert.equal(executor.observationSequenceFloor, undefined);
  } finally { await executor.close(); }
});

test('a late native permit acknowledgement never revives an expired grant', async () => {
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping } });
  const control = vnc.inputPermitControl.bind(vnc);
  vnc.inputPermitControl = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 550));
    return control(...args);
  };
  try {
    await assert.rejects(executor.execute([{ action: 'mouse_click', x: 4, y: 4 }]),
      /grant deadline|permit expired/);
    assert.ok(executor.failed);
    await new Promise(resolve => setTimeout(resolve, 600));
    await assert.rejects(executor.execute([{ action: 'mouse_click', x: 4, y: 4 }]));
    assert.equal(vnc.calls.some(action => action.action === 'mouse_click'), false);
  } finally { await executor.close(); }
});


test('a renewal burst cannot grow an in-flight observation challenge range without a bound', async () => {
  let active, peak = 0, captureStarted;
  const started = new Promise(resolve => { captureStarted = resolve; });
  const { executor, vnc } = await fixture({ helperOptions: {
    pipelining: true, partGapsMs: [100, 1800],
    alter(request, response) {
      if (active) peak = Math.max(peak, active.issued.size);
      if (request.action === 'capture') captureStarted();
      return response;
    } } });
  active = executor;
  try {
    const rejected = assert.rejects(executor.execute([{ action: 'screenshot' }]));
    await started;
    for (let i = 0; i < 130 && !executor.failed; i++) {
      await executor.activity('renew_activity').catch(error => executor.fail(error));
    }
    await rejected;
    assert.match(executor.failed?.message || '', /challenge budget exceeded/);
    assert.ok(peak <= 128);
    assert.equal(vnc.calls.some(action => action.action === 'mouse_click'), false);
  } finally { await executor.close(); }
});

test('first native causes survive cleanup, stay immutable and never dispatch queued input', async t => {
  for (const phase of ['mapping_health', 'observation_adopt', 'native_permit_begin', 'native_permit_grant']) {
    await t.test(phase, async () => {
      const marker = 'SYNTHETIC_SECRET_NOT_FOR_DIAGNOSTICS';
      const { executor, vnc } = await fixture({ config: { ...configuration(), mapping } });
      const execute = vnc.execute.bind(vnc), control = vnc.inputPermitControl.bind(vnc);
      vnc.execute = async (actions, options) => {
        const result = await execute(actions, options);
        if ((phase === 'mapping_health' && actions[0].action === 'health') ||
            (phase === 'observation_adopt' && actions[0].action === 'adopt_observation')) {
          return [{ id: 'synthetic-negative-ack', error: { code: -32000, message: marker,
            data: { token: marker, reason: marker } } }];
        }
        return result;
      };
      vnc.inputPermitControl = async (method, ...args) => {
        if (method === (phase === 'native_permit_begin' ? 'begin_input_permit' :
          phase === 'native_permit_grant' ? 'grant_input_permit' : 'not-a-control')) {
          return { id: 'synthetic-negative-ack', error: { code: -32000, message: marker, data: marker } };
        }
        return control(method, ...args);
      };
      const lane = new TargetLane({}, async () => executor);
      const progress = [];
      const first = lane.execute([{ action: 'wait' }, { action: 'mouse_click', x: 4, y: 5 },
        { action: 'key_tap', key: 'tab' }], { onResponse: response => progress.push(response) });
      const queued = lane.execute([{ action: 'key_tap', key: 'enter' }]).catch(error => error);
      try {
        await assert.rejects(first, error => {
          assert.equal(error.code, 'release_unconfirmed');
          assert.match(error.message, new RegExp(`firstCause=${phase}/native_refused; native_code=-32000`));
          assert.equal(error.message.includes(marker), false);
          return true;
        });
        assert.deepEqual(lane.firstCause, { phase, reason: 'native_refused', native_code: -32000 });
        assert.equal(Object.isFrozen(lane.firstCause), true);
        assert.throws(() => { lane.firstCause.reason = marker; }, TypeError);
        assert.throws(() => { lane.firstCause = { phase: marker }; }, TypeError);
        const cause = lane.firstCause;
        executor.failed.message = marker;
        executor.failed.code = marker;
        executor.failed.cause = { phase: marker, reason: marker };
        lane.rememberFirstCause(new Error(marker));
        assert.equal(lane.firstCause, cause);
        assert.equal((await queued) instanceof Error, true);
        await assert.rejects(lane.execute([{ action: 'key_tap', key: 'space' }]), error =>
          error === lane.cleanupFailure && !error.message.includes(marker));
        assert.equal(progress.length, 1, 'the acknowledged wait remains visible');
        assert.equal(vnc.calls.some(action => ['mouse_click', 'key_tap'].includes(action.action)), false);
      } finally { await assert.rejects(lane.close(), error => error.code === 'release_unconfirmed'); }
    });
  }
});

test('first cause reaches MCP and journal without a native payload or replay', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-first-cause-'));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const marker = 'SYNTHETIC_PRIVATE_NATIVE_PAYLOAD';
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, nativeOptions: {
    adopt: async () => [{ id: 'native-adoption', error: { code: marker, message: marker,
      data: { private: marker } } }],
  } });
  const entries = [];
  const journal = { append(batch) { entries.push(...batch); return Promise.resolve(); },
    flush: async () => {}, status: () => ({}) };
  const socketPath = path.join(directory, 'broker.sock');
  const broker = await createBroker({ socketPath, config: { targets: { desktop: {} } },
    factory: async () => executor, journal });
  t.after(() => assert.rejects(broker.close(), error => error.code === 'release_unconfirmed'));
  const client = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(() => client.close());
  await client.opened;
  const session = new McpSession(client);
  const result = await session.queue({ actions: [{ action: 'wait' },
    { action: 'mouse_click', x: 2, y: 3 }, { action: 'key_tap', key: 'tab' }] });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.completed, 1);
  assert.equal(result.structuredContent.failedIndex, 2);
  assert.match(result.structuredContent.error.message,
    /firstCause=observation_adopt\/native_refused/);
  assert.equal(result.structuredContent.error.message.includes('native_code='), false);
  const sticky = await session.command({ action: 'screenshot' });
  assert.equal(sticky.structuredContent.error.message, result.structuredContent.error.message);
  assert.equal(JSON.stringify({ result, sticky, entries }).includes(marker), false);
  assert.ok(entries.some(entry => entry.result.error?.message.includes('firstCause=observation_adopt/native_refused')));
  assert.equal(vnc.calls.some(action => ['mouse_click', 'key_tap'].includes(action.action)), false);
});

test('native context refusal is distinct from permit expiry and malformed mapping', async t => {
  for (const [message, reason, code, data] of [
    ['Failed to send VNC event: Observed display changed; take a new screenshot before input', 'context_changed', -32000],
    ['Failed to send VNC event: Native input permit expired', 'permit_expired', -32000],
    ['Failed to send VNC event: Native input permit grant binding or challenge deadline failed', 'grant_rejected', -32000],
    ['not reflected', 'input_not_ready', -32013, { reason: 'input_not_ready', remaining_ms: 3 }],
  ]) {
    await t.test(reason, async () => {
      const { executor } = await fixture({ config: { ...configuration(), mapping }, nativeOptions: {
        run: async () => [{ id: 'native-input', error: { code, message, data } }],
      } });
      try {
        await assert.rejects(executor.execute([{ action: 'mouse_click', x: 1, y: 1 }]), error => {
          assert.deepEqual(hostHelperFailureCause(error), { phase: 'native_input', reason, native_code: code });
          return true;
        });
      } finally { await executor.close(); }
    });
  }
  const { executor } = await fixture({ config: { ...configuration(), mapping }, nativeOptions: { health: { nativeWidth: 1 } } });
  try {
    await assert.rejects(executor.execute([{ action: 'mouse_click', x: 1, y: 1 }]), error => {
      assert.deepEqual(hostHelperFailureCause(error), { phase: 'mapping_health', reason: 'geometry_mismatch' });
      return true;
    });
  } finally { await executor.close(); }
});

test('cause branding ignores forged fields and accepts frozen errors without reflecting values', async () => {
  const { executor } = await fixture();
  try {
    const marker = 'SYNTHETIC_SECRET_CAUSE';
    const forged = Object.assign(new Error(marker), { cause: { phase: 'native_input', reason: marker },
      firstCause: { phase: marker }, code: marker, data: { reason: marker } });
    assert.equal(hostHelperFailureCause(forged), undefined);
    const frozen = Object.freeze(new Error('Native input-permit control deadline exceeded'));
    await assert.rejects(executor.nativeOperation('native_permit_begin', async () => { throw frozen; }), error => {
      assert.equal(error, frozen);
      assert.deepEqual(hostHelperFailureCause(error), { phase: 'native_permit_begin', reason: 'deadline' });
      return true;
    });
    await assert.rejects(executor.nativeOperation('observation_adopt', async () => { throw frozen; }), error => {
      assert.deepEqual(hostHelperFailureCause(error), { phase: 'native_permit_begin', reason: 'deadline' });
      return true;
    });
    await assert.rejects(executor.nativeOperation(marker, async () => { throw forged; }), error => {
      assert.deepEqual(hostHelperFailureCause(error), { phase: 'operation', reason: 'unknown' });
      assert.equal(JSON.stringify(hostHelperFailureCause(error)).includes(marker), false);
      return true;
    });
    assert.equal(hostHelperFailureCause(Object.assign(new Error(frozen.message), frozen)), undefined);
  } finally { await executor.close(); }
});

test('a native input negative ACK keeps its typed progress and sticky first cause after cleanup', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-input-cause-'));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const nativeMessage = 'Failed to send VNC event: Observed display changed; take a new screenshot before input';
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, nativeOptions: {
    run: async actions => actions.map(action => action.action === 'wait'
      ? { id: 'native-wait', result: { detail: 'input acknowledged' } }
      : { id: 'native-input-refusal', error: { code: -32000, message: nativeMessage } }),
  } });
  const socketPath = path.join(directory, 'broker.sock');
  const broker = await createBroker({ socketPath, config: { targets: { desktop: {} } }, factory: async () => executor });
  t.after(() => assert.rejects(broker.close(), error => error.code === 'release_unconfirmed'));
  const client = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(() => client.close());
  await client.opened;
  const session = new McpSession(client);
  const result = await session.queue({ actions: [{ action: 'wait' },
    { action: 'mouse_click', x: 2, y: 3 }, { action: 'key_tap', key: 'tab' }] });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.completed, 1);
  assert.equal(result.structuredContent.failedIndex, 2);
  // Existing native input replies keep their typed progress. The separate
  // quarantine still names the first classified cause on subsequent calls.
  assert.deepEqual(result.structuredContent.error, { code: -32000, message: nativeMessage });
  const sticky = await session.command({ action: 'screenshot' });
  assert.match(sticky.structuredContent.error.message,
    /release is unconfirmed.*firstCause=native_input\/context_changed; native_code=-32000/);
  assert.deepEqual(hostHelperFailureCause(executor.failed), {
    phase: 'native_input', reason: 'context_changed', native_code: -32000 });
  assert.equal(vnc.calls.filter(action => action.action === 'mouse_click').length, 1);
  assert.equal(vnc.calls.some(action => action.action === 'key_tap'), false);
});


test('an unbranded initiating failure stays unknown when cleanup has a different branded cause', async () => {
  const { executor: tagger } = await fixture();
  const marker = 'SYNTHETIC_UNTRUSTED_INITIATOR';
  let cleanupError;
  await assert.rejects(tagger.nativeOperation('native_permit_grant', async () => {
    throw new Error('Native input-permit control deadline exceeded');
  }), error => { cleanupError = error; return true; });
  let executor;
  executor = native({ run: async () => { throw new Error(marker); }, releaseRun: async () => {
    executor.failed = cleanupError;
    throw cleanupError;
  } });
  const lane = new TargetLane({}, async () => executor);
  try {
    await assert.rejects(lane.execute([{ action: 'wait' }]), error => {
      assert.equal(error.code, 'release_unconfirmed');
      assert.match(error.message, /firstCause=operation\/unknown$/);
      assert.equal(error.message.includes(marker), false);
      return true;
    });
    assert.deepEqual(lane.firstCause, { phase: 'operation', reason: 'unknown' });
    assert.equal(Object.isFrozen(lane.firstCause), true);
    assert.deepEqual(hostHelperFailureCause(cleanupError), { phase: 'native_permit_grant', reason: 'deadline' });
    lane.rememberFirstCause(cleanupError);
    assert.deepEqual(lane.firstCause, { phase: 'operation', reason: 'unknown' });
    await assert.rejects(lane.execute([{ action: 'key_tap', key: 'tab' }]), error =>
      error === lane.cleanupFailure && error.message.endsWith('firstCause=operation/unknown'));
    assert.deepEqual(executor.calls.map(action => action.action), ['wait']);
  } finally {
    await assert.rejects(lane.close(), error => error.code === 'release_unconfirmed');
    await tagger.close();
  }
});


// An explicit Host-only target owns no VNC backend or credential provider.
const hostOnlyProfile = () => ({ transport: 'host-only', targetId: 'configured-native-target',
  hostHelper: configuration() });
function hostOnlyFixture(options = {}) {
  const ax = axActionHost(options);
  const host = helper({ alter(request, response) {
    const altered = ax.alter(request, response);
    if (altered.success) {
      altered.result.display_geometry = { pixel_width: 512, pixel_height: 256,
        point_width: 256, point_height: 128, scale: 2 };
      if (request.action === 'capture') Object.assign(altered.result,
        { scaledWidth: 512, scaledHeight: 256, image: image(512, 256) });
    }
    return options.alter ? options.alter(request, altered) : altered;
  } });
  return host;
}

test('Host-only factory captures and acts through native AX with no VNC or provider fields', async () => {
  const host = hostOnlyFixture();
  const executor = await nativeFactory(hostOnlyProfile(), { hostSpawn: host.spawnImpl });
  try {
    assert.deepEqual(executor.display, { width: 512, height: 256 });
    assert.deepEqual(executor.capabilities.native.actions, ['health', 'wait']);
    assert.equal(executor.capabilities.actions.includes('mouse_click'), false);
    const [health] = await executor.execute([{ action: 'health' }]);
    assert.equal(health.result.transport, 'host-only');
    assert.equal(health.result.vnc, false);
    const [capture] = await executor.execute([{ action: 'screenshot' }]);
    assert.equal(capture.result.scaledWidth, 512);
    await executor.execute([{ action: 'ax_snapshot' }]);
    const [pressed] = await executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]);
    assert.equal(pressed.result.ax_action.path, 'ax_press');
    assert.equal(host.requests.find(request => request.action === 'ax_action').params.vnc_fallback, false);
    assert.equal(host.launches.length, 1);
    assert.equal(host.launches[0].command, 'ssh');
    await executor.release();
    assert.equal(executor.released, true);
    assert.equal(host.state().lease_remaining_ms, 0);
  } finally { await executor.close(); }
});

test('Host-only factory refuses all VNC events and clipboard before acquiring activity', async () => {
  const host = hostOnlyFixture();
  const executor = await nativeFactory(hostOnlyProfile(), { hostSpawn: host.spawnImpl });
  try {
    for (const action of ['mouse_click', 'key_tap', 'key_type', 'paste', 'type_secret',
      'mouse_down', 'mouse_up', 'cursor_position', 'clipboard_read']) {
      await assert.rejects(executor.execute([{ action }]), error =>
        isPreAdmissionRefusal(error) && error.code === 'unsupported_on_route');
    }
    assert.deepEqual(host.requests.map(request => request.action), ['health']);
  } finally { await executor.close(); }
});

test('Host-only rejects an unrequested VNC fallback and retires without a click', async () => {
  const host = hostOnlyFixture({ outcome: params => ({ ref: params.ref, action: params.action,
    generation: params.generation, path: 'vnc_click_required', surface: 'menu_extra',
    role: 'AXMenuBarItem', fallback_point: { x: 100, y: 60 } }) });
  const executor = await nativeFactory(hostOnlyProfile(), { hostSpawn: host.spawnImpl });
  try {
    await executor.execute([{ action: 'ax_snapshot' }]);
    await assert.rejects(executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]),
      /Host-only transport refused a VNC fallback/);
    assert.equal(executor.axVncFallback, false);
    assert.equal(host.requests.some(request => request.action === 'ax_verify'), false);
    assert.ok(executor.failed);
    assert.equal(host.launches.length, 1);
  } finally { await executor.close(); }
});

test('Host-only fails closed on a missing capture grant or missing Host', async () => {
  const noGrant = hostOnlyFixture({ alter(request, response) {
    if (request.action === 'health') response.result.screen_capture_permission = false;
    return response;
  } });
  await assert.rejects(nativeFactory(hostOnlyProfile(), { hostSpawn: noGrant.spawnImpl }), /health binding/);
  assert.equal(noGrant.launches.length, 1);
  await assert.rejects(nativeFactory(hostOnlyProfile(), { hostSpawn() {
    throw new Error('synthetic Host unavailable');
  } }), /synthetic Host unavailable/);
});

test('Host-only preserves missing Accessibility and human Stop refusals', async () => {
  const host = hostOnlyFixture();
  const executor = await nativeFactory(hostOnlyProfile(), { hostSpawn: host.spawnImpl });
  try {
    executor.accessibilityTrusted = false;
    await assert.rejects(executor.execute([{ action: 'ax_snapshot' }]), error => isPreAdmissionRefusal(error) && error.code === 'accessibility_permission_required');
    executor.accessibilityTrusted = true;
    await executor.execute([{ action: 'ax_snapshot' }]);
    executor.humanStopLatched = true;
    await assert.rejects(executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]),
      error => isPreAdmissionRefusal(error) && error.code === 'human_stop_latched');
    assert.equal(host.requests.some(request => request.action === 'ax_action'), false);
  } finally { await executor.close(); }
});


test('Host-only observations bind pixels and AX frames to the Host health geometry', async () => {
  for (const kind of ['health', 'capture', 'ax_snapshot']) {
    let changed = false;
    const host = hostOnlyFixture({ alter(request, response) {
      if (changed && request.action === kind) {
        if (kind === 'health') response.result.display_geometry = { pixel_width: 512, pixel_height: 256,
          point_width: 512, point_height: 256, scale: 1 };
        if (kind === 'capture') Object.assign(response.result, { pixels_per_point_x: 1,
          pixels_per_point_y: 1, display_bounds: { x: 0, y: 0, width: 512, height: 256 } });
        if (kind === 'ax_snapshot') response.result.ax_snapshot.framebuffer.scale = 1;
      }
      return response;
    } });
    const executor = await nativeFactory(hostOnlyProfile(), { hostSpawn: host.spawnImpl });
    try {
      changed = true;
      await assert.rejects(executor.execute([{ action: kind === 'capture' ? 'screenshot' : kind }]),
        /Host-only (display|observation) geometry changed/);
    } finally { await executor.close(); }
  }
});

// TIN-5385: a Host AX press over a slow link. Live PZM over neo's Wi-Fi
// answered ax_action in over 500 ms and latched the target; the Host itself
// answers within its 2.5 s request bound.
test('a slow ax_action answer within the Host bound acts and keeps the owner', async t => {
  for (const pipelining of [false, true]) {
    await t.test(`${pipelining ? 'pipelining' : 'serial'} Host`, async () => {
      const { executor, vnc, host } = await fixture({ helperOptions: { ...axActionHost(),
        serial: !pipelining, pipelining,
        latency: request => request.action === 'ax_action' ? 1500 : 5 } });
      try {
        await executor.execute([{ action: 'ax_snapshot' }]);
        const [clicked] = await executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]);
        assert.equal(clicked.result.ax_action.path, 'ax_press');
        const action = host.requests.find(request => request.action === 'ax_action');
        // The permit lapsed under the AX call and a later renewal re-armed it.
        assert.ok(host.requests.some(request => request.action === 'renew_activity' &&
          request.sentAt >= action.answeredAt));
        await new Promise(resolve => setTimeout(resolve, 700));
        assert.equal(executor.failed, undefined);
        await executor.execute([{ action: 'ax_snapshot' }]);
        assert.deepEqual(vnc.calls, []);
      } finally { await executor.close(); }
    });
  }
});

test('an ax_action the Host never answers still retires the owner at the Host bound', async () => {
  const { executor } = await fixture({ helperOptions: { ...axActionHost(),
    alter: (request, response) => request.action === 'ax_action' ? null : axActionHost().alter(request, response) } });
  try {
    await executor.execute([{ action: 'ax_snapshot' }]);
    const started = performance.now();
    await assert.rejects(executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]), /receipt deadline exceeded/);
    assert.ok(performance.now() - started >= 2000);
    assert.ok(executor.failed);
  } finally { await executor.close(); }
});
