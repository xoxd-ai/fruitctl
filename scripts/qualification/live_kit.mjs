// SPDX-License-Identifier: MIT
// Shared runner for the attended PZM live qualification kit (TIN-5509). Each
// gate drives `fruitctl mcp --target PROFILE --socket ABS` over stdio JSON-RPC
// exactly like a frontend, saves every returned frame, records each call and
// writes one JSON result with explicit checks. Gates are pure functions of an
// injected `call` and `operator`, so offline tests exercise the same verdicts.
// Nothing here launches an app, changes a setting or answers a dialog; the
// operator does those on the target when a step asks.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const RESULT_SCHEMA = 'fruitctl.live-qualification.v1';
// The broker caches a desktop-state probe for about 2 s; wait past it.
export const SENTINEL_SETTLE_MS = 2500;

/** The typed code of a failed tool result, wherever the server put it. */
export function errorCode(result) {
  if (!result?.isError) return null;
  const structured = result.structuredContent;
  return structured?.error?.code ?? structured?.code ?? null;
}

export function imageOf(result) {
  const block = result?.content?.find(entry => entry.type === 'image');
  return block ? { bytes: Buffer.from(block.data, 'base64'), mimeType: block.mimeType } : null;
}

export function textOf(result) {
  return (result?.content ?? []).filter(entry => entry.type === 'text').map(entry => entry.text).join('\n');
}

/** Collects checks; a gate passes only when every check ran and passed. */
export class Verdict {
  constructor() { this.checks = []; this.skipped = []; }
  check(id, pass, observed, expected) {
    const entry = { id, pass: Boolean(pass), expected, observed };
    this.checks.push(entry);
    return entry.pass;
  }
  skip(id, why) { this.skipped.push({ id, why }); }
  get status() {
    if (this.checks.some(entry => !entry.pass)) return 'failed';
    return this.skipped.length || !this.checks.length ? 'incomplete' : 'passed';
  }
  failures() { return this.checks.filter(entry => !entry.pass).map(entry => entry.id); }
}

/** Wrap a raw MCP call so each one is numbered, timed and its frame saved. */
export function recorder(rawCall, { saveFrame = async () => null, now = () => performance.now() } = {}) {
  const calls = [];
  const call = async (args, label = args.action, tool = 'vnc_command') => {
    const number = calls.length + 1, started = now();
    const result = await rawCall(tool, args);
    const entry = { number, label, tool, args, latencyMs: Math.round(now() - started),
      isError: Boolean(result?.isError), code: errorCode(result) };
    const image = imageOf(result);
    if (image) {
      entry.frame = { sha256: createHash('sha256').update(image.bytes).digest('hex'), mimeType: image.mimeType,
        file: await saveFrame(number, label, image) };
    }
    calls.push(entry);
    return result;
  };
  return { call, calls };
}

const usage = name => `Usage: node scripts/qualification/${name} --attended --target PROFILE --socket /abs/broker.sock
  --output-dir /abs/new-dir [--fruitctl /abs/fruitctl(.mjs)] [gate options]`;

/**
 * Parse common options, open the MCP session, run `gate(context)` and write
 * `<gate>-result.json`. Exit 0 passed, 1 failed or incomplete, 2 usage or
 * transport error.
 */
export async function runCli({ name, file, options = {}, gate, sessions = [] }) {
  const { values } = parseArgs({ options: { attended: { type: 'boolean' }, target: { type: 'string' },
    socket: { type: 'string' }, 'output-dir': { type: 'string' }, fruitctl: { type: 'string' },
    help: { type: 'boolean' }, ...options } });
  if (values.help) { process.stdout.write(usage(file) + '\n'); return 0; }
  const output = values['output-dir'];
  if (!values.attended || !values.target || !values.socket || !output ||
      !path.isAbsolute(values.socket) || !path.isAbsolute(output)) throw new Error(usage(file));
  if (!process.stdin.isTTY) throw new Error('The attended kit needs an interactive terminal for operator steps');
  await mkdir(output, { mode: 0o700 }); // Refuses an existing directory.
  const fruitctl = values.fruitctl ?? fileURLToPath(new URL('../../bin/fruitctl.mjs', import.meta.url));
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const open = async (target, role) => {
    const script = /\.(m?js)$/.test(fruitctl);
    const transport = new StdioClientTransport({ command: script ? process.execPath : fruitctl,
      args: [...(script ? [fruitctl] : []), 'mcp', '--target', target, '--socket', values.socket] });
    const client = new Client({ name: `fruitctl-live-${name}-${role}`, version: '1' });
    await client.connect(transport);
    return client;
  };
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const steps = [];
  const operator = async (id, instruction) => {
    process.stderr.write(`\n[${name}] OPERATOR STEP ${id}\n${instruction}\n`);
    const answer = (await readline.question('Enter = done, s = skip, a = abort: ')).trim().toLowerCase();
    const outcome = answer === 'a' ? 'aborted' : answer === 's' ? 'skipped' : 'done';
    steps.push({ id, outcome, at: new Date().toISOString() });
    if (outcome === 'aborted') throw Object.assign(new Error(`Operator aborted at ${id}`), { aborted: true });
    return outcome;
  };
  const ask = async question => (await readline.question(`[${name}] ${question} `)).trim();
  const saveFrame = async (number, label, image) => {
    const extension = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const base = `${String(number).padStart(3, '0')}-${label.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40)}.${extension}`;
    await writeFile(path.join(output, base), image.bytes, { flag: 'wx', mode: 0o600 });
    return base;
  };
  const clients = {};
  const startedAt = new Date().toISOString();
  let verdict = new Verdict(), calls = [], error = null, extra = {};
  try {
    clients.primary = await open(values.target, 'primary');
    for (const { option, role } of sessions) {
      if (values[option]) clients[role] = await open(values[option], role);
    }
    const recorders = Object.fromEntries(Object.entries(clients).map(([role, client]) => [role,
      recorder((tool, args) => client.callTool({ name: tool, arguments: args }),
        { saveFrame: (number, label, image) => saveFrame(number, `${role}-${label}`, image) })]));
    calls = Object.fromEntries(Object.entries(recorders).map(([role, entry]) => [role, entry.calls]));
    extra = (await gate({ call: recorders.primary.call, calls: recorders, clients, output, operator, ask, verdict,
      values, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) })) ?? {};
  } catch (caught) {
    error = { message: caught.message, aborted: Boolean(caught.aborted) };
  } finally {
    readline.close();
    // Closing each session releases its lease.
    await Promise.allSettled(Object.values(clients).map(client => client.close()));
  }
  const status = error ? 'failed' : verdict.status;
  const result = { schema: RESULT_SCHEMA, gate: name, status, startedAt, finishedAt: new Date().toISOString(),
    target: values.target, socket: values.socket, fruitctl, failures: verdict.failures(),
    checks: verdict.checks, skipped: verdict.skipped, operatorSteps: steps, ...(error ? { error } : {}),
    ...extra, calls };
  await writeFile(path.join(output, `${name}-result.json`), JSON.stringify(result, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  const { calls: _calls, checks: _checks, ...summary } = result;
  process.stdout.write(JSON.stringify(summary) + '\n');
  return status === 'passed' ? 0 : 1;
}

export function main(entry) {
  runCli(entry).then(code => { process.exitCode = code; },
    error => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
}
