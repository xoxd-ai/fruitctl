// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createNativeExecutor } from '../index.js';
import { nativeCapabilities, isPreAdmissionRefusal, preAdmissionRefusal } from '../lib/mcp/capabilities.js';

const source = `
const fs = require('node:fs');
const readline = require('node:readline');
const received=[];
const emit=(value)=>new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(value)+'\\n',error=>error?reject(error):resolve()));
async function main() {
  let credential=Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(null,{fd:3,autoClose:true})) credential=Buffer.concat([credential,chunk]);
  if(credential.readUInt32BE(0)!==credential.length-4 || Object.hasOwn(process.env,'VNC_PASSWORD')) process.exit(70);
  credential.fill(0);
  if(process.env.FRUITCTL_FIXTURE_MODE==='diagnostics') process.stderr.write('owned-fixture-raw-diagnostic\\n');
  const capabilityModes = {
    capabilities: ['health','wait','shutdown'],
    'empty-capabilities': [],
    'duplicate-capabilities': ['health','health'],
    'oversized-capabilities': Array.from({length:65}, (_,i)=>'action_'+i),
    'invalid-capabilities': ['health','private description\\n'],
  };
  const capabilities=capabilityModes[process.env.FRUITCTL_FIXTURE_MODE];
  emit({method:'ready',params:{scaledWidth:1280,scaledHeight:640,
    ...(capabilities===undefined?{}:{capabilities})}});
  for await (const line of readline.createInterface({input:process.stdin})) {
    const request=JSON.parse(line); received.push(request.method);
    if(request.method==='shutdown') {
      if(process.env.FRUITCTL_FIXTURE_MODE==='release-error') {
        await emit({id:request.id,error:{code:-32000,message:'held input release failed'}}); continue;
      }
      if(process.env.FRUITCTL_FIXTURE_MODE==='exit-without-ack') process.exit(0);
      if(process.env.FRUITCTL_FIXTURE_MODE==='ack-malformed-tail') {
        process.stdout.write(JSON.stringify({id:request.id,result:{detail:'OK'}})+'\\nmalformed private tail\\n');
        process.exit(0);
      }
      await emit({id:request.id,result:{detail:'OK'}});
      if(process.env.FRUITCTL_FIXTURE_MODE==='ack-stall') await new Promise(()=>{});
      process.exit(process.env.FRUITCTL_FIXTURE_MODE==='bad-release-exit'?1:0);
    }
    if(['eof','partial-eof'].includes(process.env.FRUITCTL_FIXTURE_MODE)) {
      process.stdout.end(process.env.FRUITCTL_FIXTURE_MODE==='partial-eof'?'{':'');
      await new Promise(()=>{});
    }
    if(process.env.FRUITCTL_FIXTURE_MODE==='wrong-id') {
      await emit({id:'unrequested-fixture-id',result:{detail:'never-log-unrequested-fixture'}}); continue;
    }
    if(process.env.FRUITCTL_FIXTURE_MODE==='image') {
      await emit({id:request.id,result:{image:'A'.repeat(80)}}); continue;
    }
    if(process.env.FRUITCTL_FIXTURE_MODE==='stall' && request.method==='wait') await new Promise(()=>{});
    if(process.env.FRUITCTL_FIXTURE_MODE==='malformed') {
      emit({id:request.id,result:{detail:{secret:'never-log-malformed-fixture'}}}); continue;
    }
    if(request.method==='wait') await new Promise(resolve=>setTimeout(resolve,25));
    if(request.method==='key_tap' && request.params.key==='bad') {
      emit({id:request.id,error:{code:-32000,message:'fixture key refused'}}); continue;
    }
    const detail=request.method==='health' ? JSON.stringify(received) : 'π 🍇';
    const response=Buffer.from(JSON.stringify({id:request.id,result:{detail}})+'\\n');
    const split=response.indexOf(Buffer.from('π'))+1;
    if(split>0) {
      process.stdout.write(response.subarray(0,split));
      await new Promise(resolve=>setTimeout(resolve,2));
      process.stdout.write(response.subarray(split));
    } else process.stdout.write(response);
  }
}
main().catch(()=>{process.stderr.write('fixed native fixture failure\\n');process.exit(70);});
`;

async function fixture(t, mode = 'normal', options = {}) {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch && path.isAbsolute(scratch), 'owned TMPDIR is required');
  const parent = fs.lstatSync(scratch);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid());
  const directory = fs.mkdtempSync(path.join(scratch, 'fruitctl-native-'));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'native.cjs');
  fs.writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o700, flag: 'wx' });
  const log = [];
  const env = { VNC_PASSWORD: 'owned-offline-fixture', FRUITCTL_FIXTURE_MODE: mode };
  let executor;
  t.after(async () => {
    if (executor) await executor.close();
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  executor = await createNativeExecutor({ ...options, env, daemonPath: file, log: (message) => log.push(message) });
  assert.equal(Object.hasOwn(env, 'VNC_PASSWORD'), false);
  return { executor, log };
}

test('native executor preserves split Unicode and serializes an entire batch before another client', async (t) => {
  const { executor } = await fixture(t);
  const batch = executor.execute([{ action: 'wait' }, { action: 'key_tap', key: 'tab' }]);
  const other = executor.execute([{ action: 'health' }]);
  assert.equal((await batch)[0].result.detail, 'π 🍇');
  assert.deepEqual(JSON.parse((await other)[0].result.detail), ['wait', 'key_tap', 'health']);
});

test('native executor stops on the first error without sending the remainder', async (t) => {
  const { executor } = await fixture(t);
  const results = await executor.execute([{ action: 'wait' }, { action: 'key_tap', key: 'bad' }, { action: 'wait' }]);
  assert.equal(results.length, 2);
  assert.equal(results[1].error.message, 'fixture key refused');
  assert.deepEqual(JSON.parse((await executor.execute([{ action: 'health' }]))[0].result.detail),
    ['wait', 'key_tap', 'health']);
});

test('malformed native result fails closed and never logs its payload', async (t) => {
  const { executor, log } = await fixture(t, 'malformed');
  await assert.rejects(executor.execute([{ action: 'health' }]), /Invalid daemon response shape/);
  await executor.closed;
  assert.equal(log.some((message) => message.includes('never-log-malformed-fixture')), false);
  await assert.rejects(executor.execute([{ action: 'health' }]), /Daemon not ready/);
});

test('in-flight cancellation terminates the owned native child and refuses uncertain successors', async (t) => {
  const { executor } = await fixture(t, 'stall');
  const controller = new AbortController();
  const pending = executor.execute([{ action: 'wait' }], { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve,15));
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await executor.closed;
  await assert.rejects(executor.execute([{ action: 'health' }]), /Daemon not ready/);
});

test('deadline while queued does not terminate another client\'s active native operation', async (t) => {
  const { executor } = await fixture(t);
  const active = executor.execute([{ action: 'wait' }]);
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'tab' }], { timeoutMs: 5 }), /timed out/);
  await active;
  assert.deepEqual(JSON.parse((await executor.execute([{ action: 'health' }]))[0].result.detail), ['wait', 'health']);
});

test('elapsed batch deadline records acknowledged actions and closes the uncertain child', async (t) => {
  let now = 0;
  const { executor } = await fixture(t, 'stall', { monotonicNow: () => now });
  let progress = 0;
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'tab' }, { action: 'wait' }],
    { onResponse: () => { progress++; now = 30000; } }), (error) => {
    assert.match(error.message, /timed out/);
    assert.equal(error.responses.length, 1);
    assert.equal(error.responses[0].result.detail, 'π 🍇');
    return true;
  });
  assert.equal(progress, 1);
  await executor.closed;
});

test('shared native execution can suppress raw stderr independently of its logger', async (t) => {
  const original = process.stderr.write;
  const forwarded = [];
  process.stderr.write = function (chunk, ...arguments_) {
    if (String(chunk).includes('owned-fixture-raw-diagnostic')) {
      forwarded.push(String(chunk));
      arguments_.find((argument) => typeof argument === 'function')?.();
      return true;
    }
    return original.call(this, chunk, ...arguments_);
  };
  t.after(() => { process.stderr.write = original; });
  const { executor, log } = await fixture(t, 'diagnostics', { emitDiagnostics: false });
  await executor.execute([{ action: 'wait' }]);
  assert.deepEqual(forwarded, []);
  assert.ok(log.some((message) => message.includes('Daemon ready')));
});

test('native release requires correlated shutdown acknowledgement and clean owned child exit', async (t) => {
  const { executor } = await fixture(t);
  await executor.execute([{ action: 'key_tap', key: 'tab' }]);
  const releasing = executor.release();
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'tab' }]), /releasing control/);
  await releasing;
  assert.equal(executor.child.exitCode, 0);
  assert.equal(executor.child.signalCode, null);
  await executor.release(); // The already acknowledged terminal child is not relaunched.
  await assert.rejects(executor.execute([{ action: 'health' }]), /releasing control/);
});

for (const [mode, message] of [
  ['release-error', /Native shutdown failed: held input release failed/],
  ['exit-without-ack', /output ended before acknowledged shutdown|Daemon exited/],
  ['bad-release-exit', /did not exit cleanly/],
  ['ack-malformed-tail', /Invalid daemon protocol frame/],
]) {
  test(`native release refuses ${mode} instead of claiming ownership cleared`, async (t) => {
    const { executor } = await fixture(t, mode);
    await assert.rejects(executor.release(), message);
  });
}

for (const [mode, expected] of [
  ['eof', /output ended before acknowledged shutdown/],
  ['partial-eof', /Incomplete daemon protocol frame/],
  ['wrong-id', /Unexpected daemon response identifier/],
]) {
  test(`native executor retires owned transport on ${mode} without waiting for a tool deadline`, async (t) => {
    const { executor, log } = await fixture(t, mode);
    await assert.rejects(executor.execute([{ action: 'wait' }]), expected);
    await executor.closed;
    assert.equal(executor.parser.buffer.length, 0);
    assert.equal(log.some((message) => message.includes('never-log-unrequested-fixture')), false);
    await assert.rejects(executor.execute([{ action: 'health' }]), /Daemon not ready/);
  });
}

test('native aggregate image budget retains only admitted metadata and never sends a successor input', async (t) => {
  const { executor } = await fixture(t, 'image', { maxBatchResponseBytes: 180 });
  const requested = [];
  const original = executor.request.bind(executor);
  executor.request = (action) => { requested.push(action.action); return original(action); };
  const progress = [];
  await assert.rejects(executor.execute([{ action: 'screenshot' }, { action: 'screenshot' },
    { action: 'key_tap', key: 'tab' }], { onResponse: (response) => progress.push(response) }), (error) => {
    assert.match(error.message, /Batch response exceeds byte limit/);
    assert.equal(error.responses.length, 1);
    assert.equal(Object.hasOwn(error.responses[0].result, 'image'), false);
    return true;
  });
  assert.deepEqual(requested, ['screenshot', 'screenshot']);
  assert.deepEqual(progress.map((response) => response.result), [{}]);
  await executor.closed;
});

test('native release cancellation after acknowledgement retires child and refuses a clean release', async (t) => {
  const { executor } = await fixture(t, 'ack-stall');
  const controller = new AbortController();
  const pending = executor.release({ signal: controller.signal });
  await new Promise((resolve) => executor.child.stdout.once('data', resolve));
  assert.equal(executor.shutdownAcknowledged, true);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await executor.closed;
  assert.notEqual(executor.child.signalCode, null);
});

test('native release exit deadline retires a child that acknowledged but remained alive', async (t) => {
  const { executor } = await fixture(t, 'ack-stall');
  await assert.rejects(executor.release({ timeoutMs: 50 }), /exit unconfirmed/);
  await executor.closed;
  assert.equal(executor.shutdownAcknowledged, true);
  assert.notEqual(executor.child.signalCode, null);
});

test('native batch/deadline bounds refuse malformed work before sending commands', async (t) => {
  const { executor } = await fixture(t);
  for (const actions of [[], null, Array.from({ length: 257 }, () => ({ action: 'wait' }))]) {
    await assert.rejects(executor.execute(actions), /Invalid native action batch/);
  }
  for (const timeoutMs of [0, -1, NaN, Infinity, 30001]) {
    await assert.rejects(executor.execute([{ action: 'wait' }], { timeoutMs }), /Invalid native tool deadline/);
  }
  assert.deepEqual(JSON.parse((await executor.execute([{ action: 'health' }]))[0].result.detail), ['health']);
});

test('native capability discovery is additive and leaves missing legacy metadata explicitly unknown', async (t) => {
  const { executor } = await fixture(t);
  assert.deepEqual(executor.capabilities, { known: false, actions: [] });
  const [response] = await executor.execute([{ action: 'health' }]);
  assert.deepEqual(response.result.capabilities, { known: false, actions: [] });
  await executor.execute([{ action: 'key_tap', key: 'tab' }]);
  assert.deepEqual(JSON.parse((await executor.execute([{ action: 'health' }]))[0].result.detail),
    ['health', 'key_tap', 'health']);
});

test('known unsupported and mixed native batches refuse before any write without retiring compatible work', async (t) => {
  const { executor } = await fixture(t, 'capabilities');
  assert.deepEqual(executor.capabilities, { known: true, actions: ['health', 'wait', 'shutdown'] });
  assert.equal(Object.isFrozen(executor.capabilities), true);
  assert.equal(Object.isFrozen(executor.capabilities.actions), true);
  for (const actions of [[{ action: 'key_tap', key: 'tab' }],
    [{ action: 'wait' }, { action: 'key_tap', key: 'tab' }]]) {
    await assert.rejects(executor.execute(actions), error => {
      assert.equal(isPreAdmissionRefusal(error), true);
      assert.equal(error.code, 'unsupported_action');
      assert.deepEqual(error.responses, []);
      return true;
    });
  }
  await assert.rejects(executor.inputPermitControl('begin_input_permit', {}), /Action unavailable/);
  assert.deepEqual(JSON.parse((await executor.execute([{ action: 'health' }]))[0].result.detail), ['health']);
  assert.equal(executor.isReady, true);
  assert.equal(executor.child.signalCode, null);
  const [response] = await executor.execute([{ action: 'health' }]);
  assert.deepEqual(response.result.capabilities, executor.capabilities);
});

test('an explicitly empty native capability set is known unavailable rather than legacy unknown', async (t) => {
  const { executor } = await fixture(t, 'empty-capabilities');
  assert.deepEqual(executor.capabilities, { known: true, actions: [] });
  await assert.rejects(executor.execute([{ action: 'health' }]), /Action unavailable/);
  await executor.close({ graceful: false });
});

test('malformed native capability advertisements fail startup without exposing remote values', async (t) => {
  for (const mode of ['duplicate-capabilities', 'oversized-capabilities', 'invalid-capabilities']) {
    await t.test(mode, async t => {
      await assert.rejects(fixture(t, mode), /Invalid native capability metadata/);
    });
  }
});

test('capability bounds reject non-array data and a forged refusal never carries the local brand', () => {
  for (const value of [null, 'health', {}, [1], ['Health'], [''], ['a'.repeat(65)]]) {
    assert.throws(() => nativeCapabilities(value), /Invalid native capability metadata/);
  }
  const refusal = preAdmissionRefusal('bounded refusal');
  assert.equal(isPreAdmissionRefusal(refusal), true);
  assert.equal(isPreAdmissionRefusal(Object.assign(new Error(refusal.message), refusal)), false);
  assert.equal(isPreAdmissionRefusal(JSON.parse(JSON.stringify(refusal))), false);
});
