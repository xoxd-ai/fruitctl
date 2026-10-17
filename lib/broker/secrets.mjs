// SPDX-License-Identifier: MIT
// D16/D36 secret providers on the Darwin broker. A profile names where a
// secret lives; the broker reads it only when it is needed. Four providers:
//
//   file      an exact path, e.g. a sops-nix materialized file
//   env       a named broker environment variable (discouraged)
//   command   an explicit argv, no shell, bounded, stdout is the secret
//   keychain  /usr/bin/security find-generic-password -s -a -w (Darwin)
//
// `command` is the vault-agnostic adapter: vault, op, bw, sops or any CLI
// that prints one secret. No provider output, stderr or value reaches an
// error message, log, journal or model-facing result; failures carry a fixed
// reason from SECRET_REASONS only.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const SECRET_PROVIDERS = Object.freeze(['file', 'env', 'command', 'keychain']);
export const SECRET_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
export const MAX_SECRET_BYTES = 4096;
export const COMMAND_TIMEOUT_MS = Object.freeze({ min: 100, default: 5000, max: 10000 });
export const KEYCHAIN_TOOL = '/usr/bin/security';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ARGS = 64;
const MAX_FIELD = 4096;
// security(1) exits 44 when no matching item exists.
const KEYCHAIN_NOT_FOUND = 44;

export const SECRET_REASONS = Object.freeze(['missing', 'permission_denied', 'symlink_refused',
  'not_regular_file', 'not_owner', 'mode_too_open', 'unsafe_parent', 'too_large', 'empty',
  'invalid_encoding', 'unset', 'timeout', 'exit_status', 'spawn_failed', 'unsupported_platform',
  'cancelled']);

/** A resolution failure. `reason` is one of SECRET_REASONS; the message names
 * only the provider kind and reason, never a path's content or tool output. */
export class SecretError extends Error {
  constructor(reason, provider) {
    super(`Secret provider ${provider} failed: ${reason}`);
    this.code = 'secret_unavailable';
    this.reason = reason;
    this.provider = provider;
  }
}

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = MAX_FIELD) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && !value.includes('\0');
const absolute = value => text(value) && path.isAbsolute(value) && !value.includes('\n');

const FIELDS = {
  file: ['path', 'allowSymlink'],
  env: ['name'],
  command: ['argv', 'timeoutMs'],
  keychain: ['service', 'account', 'keychain'],
};

/** Validate one provider declaration. Unknown keys are refused so a typo
 * cannot silently drop a check. The error names the location, not values. */
export function validateSecretSpec(spec, where = 'secret') {
  const fail = () => { throw new Error(`Invalid secret provider for ${where}`); };
  if (!object(spec) || !SECRET_PROVIDERS.includes(spec.provider)) fail();
  const allowed = new Set(['provider', ...FIELDS[spec.provider]]);
  if (Object.keys(spec).some(key => !allowed.has(key))) fail();
  switch (spec.provider) {
    case 'file':
      if (!absolute(spec.path) || (spec.allowSymlink !== undefined && typeof spec.allowSymlink !== 'boolean')) fail();
      return Object.freeze({ provider: 'file', path: spec.path, allowSymlink: spec.allowSymlink === true });
    case 'env':
      if (typeof spec.name !== 'string' || !ENV_NAME.test(spec.name)) fail();
      return Object.freeze({ provider: 'env', name: spec.name });
    case 'command':
      if (!Array.isArray(spec.argv) || !spec.argv.length || spec.argv.length > MAX_ARGS ||
          !absolute(spec.argv[0]) || !spec.argv.every(argument => typeof argument === 'string' &&
            argument.length <= MAX_FIELD && !argument.includes('\0'))) fail();
      if (spec.timeoutMs !== undefined && (!Number.isInteger(spec.timeoutMs) ||
          spec.timeoutMs < COMMAND_TIMEOUT_MS.min || spec.timeoutMs > COMMAND_TIMEOUT_MS.max)) fail();
      return Object.freeze({ provider: 'command', argv: Object.freeze([...spec.argv]),
        timeoutMs: spec.timeoutMs ?? COMMAND_TIMEOUT_MS.default });
    case 'keychain':
      if (!text(spec.service, 255) || !text(spec.account, 255) ||
          (spec.keychain !== undefined && !absolute(spec.keychain))) fail();
      return Object.freeze({ provider: 'keychain', service: spec.service, account: spec.account,
        ...(spec.keychain === undefined ? {} : { keychain: spec.keychain }) });
  }
  return fail();
}

/** The VNC credential provider. `credentialFile` stays a backward-compatible
 * alias for a file provider; it followed symlinks before, so it still does,
 * with the ownership and mode checks every file provider applies. */
export function credentialSpec(profile, where = 'target') {
  if (!object(profile)) return null;
  if (profile.credential !== undefined && profile.credentialFile !== undefined) {
    throw new Error(`Target ${where} declares both credential and credentialFile; keep one`);
  }
  if (profile.credential !== undefined) return validateSecretSpec(profile.credential, `${where}.credential`);
  if (profile.credentialFile !== undefined) {
    if (!absolute(profile.credentialFile)) throw new Error(`Invalid secret provider for ${where}.credentialFile`);
    return Object.freeze({ provider: 'file', path: profile.credentialFile, allowSymlink: true });
  }
  return null;
}

/** D16 per-target allowlist: ref name -> provider. Absent means none. */
export function secretRefs(profile, where = 'target') {
  const declared = profile?.secrets;
  if (declared === undefined) return new Map();
  if (!object(declared) || Object.keys(declared).length > 64) throw new Error(`Invalid secrets for ${where}`);
  return new Map(Object.entries(declared).map(([ref, spec]) => {
    if (!SECRET_REF.test(ref)) throw new Error(`Invalid secret ref name in ${where}.secrets`);
    return [ref, validateSecretSpec(spec, `${where}.secrets.${ref}`)];
  }));
}

/** Environment variable names the config uses as env providers. They are
 * removed from every child process the broker starts. */
export function envProviderNames(config) {
  const names = new Set();
  for (const [name, profile] of Object.entries(config?.targets ?? {})) {
    const specs = [credentialSpec(profile, name), ...secretRefs(profile, name).values()];
    for (const spec of specs) if (spec?.provider === 'env') names.add(spec.name);
  }
  return names;
}

/** A copy of `env` without the named secret variables or VNC_PASSWORD. */
export function scrubbedEnvironment(env, names) {
  const copy = { ...env };
  for (const name of names) delete copy[name];
  delete copy.VNC_PASSWORD;
  return copy;
}

export const LENGTH_CLASSES = Object.freeze(['1-8', '9-16', '17-32', '33-64', '65+']);

/** Coarse size bucket for the journal (#97): never the value or exact length. */
export function lengthClass(value) {
  const length = [...value].length;
  return length <= 8 ? '1-8' : length <= 16 ? '9-16' : length <= 32 ? '17-32' : length <= 64 ? '33-64' : '65+';
}

// One trailing line ending is file/tool framing, not secret content.
function decode(bytes, provider) {
  try {
    let end = bytes.length;
    if (end && bytes[end - 1] === 0x0a) end--;
    if (end && bytes[end - 1] === 0x0d) end--;
    if (end === 0) throw new SecretError('empty', provider);
    if (end > MAX_SECRET_BYTES) throw new SecretError('too_large', provider);
    const view = bytes.subarray(0, end);
    if (view.includes(0)) throw new SecretError('invalid_encoding', provider);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(view); }
    catch { throw new SecretError('invalid_encoding', provider); }
  } finally { bytes.fill(0); }
}

function fileReason(error) {
  if (error instanceof SecretError) return error;
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return new SecretError('missing', 'file');
  if (error?.code === 'ELOOP' || error?.code === 'EMLINK') return new SecretError('symlink_refused', 'file');
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return new SecretError('permission_denied', 'file');
  return new SecretError('missing', 'file');
}

async function readFileSecret(spec, uid) {
  try {
    const link = await fs.lstat(spec.path);
    let real = spec.path;
    if (link.isSymbolicLink()) {
      if (!spec.allowSymlink) throw new SecretError('symlink_refused', 'file');
      real = await fs.realpath(spec.path);
    }
    // A writable parent would let another account swap the file between checks.
    const parent = await fs.stat(path.dirname(real));
    if ((parent.uid !== uid && parent.uid !== 0) || (parent.mode & 0o022)) {
      throw new SecretError('unsafe_parent', 'file');
    }
    // O_NOFOLLOW: the checked path cannot become a link before open. Checks
    // below use the opened handle, so they describe the bytes that are read.
    const handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new SecretError('not_regular_file', 'file');
      if (stat.uid !== uid) throw new SecretError('not_owner', 'file');
      if (stat.mode & 0o077) throw new SecretError('mode_too_open', 'file');
      if (stat.size > MAX_SECRET_BYTES + 2) throw new SecretError('too_large', 'file');
      const bytes = Buffer.alloc(MAX_SECRET_BYTES + 3);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_SECRET_BYTES + 2) { bytes.fill(0); throw new SecretError('too_large', 'file'); }
      const content = Buffer.from(bytes.subarray(0, bytesRead));
      bytes.fill(0);
      return decode(content, 'file');
    } finally { await handle.close(); }
  } catch (error) { throw fileReason(error); }
}

function readEnvSecret(spec, env) {
  const value = env[spec.name];
  if (typeof value !== 'string' || value === '') throw new SecretError('unset', 'env');
  return decode(Buffer.from(value, 'utf8'), 'env');
}

/** Run one argv without a shell. stdin is closed and stderr is never opened,
 * so tool diagnostics cannot be logged. stdout is bounded; on timeout,
 * overflow or cancellation the child is killed and nothing is returned. */
function runSecretCommand(argv, { provider, timeoutMs, signal, env, spawnImpl, exitReasons = {} }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new SecretError('cancelled', provider)); return; }
    let child;
    try {
      child = spawnImpl(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'], env, shell: false,
        windowsHide: true });
    } catch { reject(new SecretError('spawn_failed', provider)); return; }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch {} }
        child.stdout?.destroy();
        for (const chunk of chunks) chunk.fill(0);
        reject(error);
      } else resolve(value);
    };
    const abort = () => finish(new SecretError('cancelled', provider));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => finish(new SecretError('timeout', provider)), timeoutMs);
    child.stdout.on('data', chunk => {
      if (settled) { chunk.fill(0); return; }
      bytes += chunk.length;
      chunks.push(chunk);
      if (bytes > MAX_SECRET_BYTES + 2) finish(new SecretError('too_large', provider));
    });
    child.once('error', () => finish(new SecretError('spawn_failed', provider)));
    child.once('close', (code, killedBy) => {
      if (settled) return;
      if (code !== 0 || killedBy) {
        finish(new SecretError(exitReasons[code] ?? 'exit_status', provider));
        return;
      }
      try { finish(null, decode(Buffer.concat(chunks), provider)); }
      catch (error) { finish(error); }
      finally { for (const chunk of chunks) chunk.fill(0); }
    });
  });
}

/** Resolve one validated provider to its value. Callers keep the value out
 * of logs, journals and results; this function never reports it. */
// `env` is where env providers look; `childEnv` is what command providers
// inherit (default: `env` without VNC_PASSWORD; the broker also removes every
// env-provider name, see scrubbedEnvironment).
export async function resolveSecret(spec, { signal, timeoutMs = Infinity, env = process.env,
  childEnv = scrubbedEnvironment(env, []), platform = process.platform, spawnImpl = spawn,
  uid = process.getuid(), keychainTool = KEYCHAIN_TOOL } = {}) {
  if (signal?.aborted) throw new SecretError('cancelled', spec.provider);
  switch (spec.provider) {
    case 'file': return readFileSecret(spec, uid);
    case 'env': return readEnvSecret(spec, env);
    case 'command':
      return runSecretCommand(spec.argv, { provider: 'command', signal, env: childEnv, spawnImpl,
        timeoutMs: Math.max(1, Math.min(spec.timeoutMs, timeoutMs)) });
    case 'keychain':
      if (platform !== 'darwin') throw new SecretError('unsupported_platform', 'keychain');
      return runSecretCommand([keychainTool, 'find-generic-password', '-s', spec.service, '-a', spec.account,
        '-w', ...(spec.keychain ? [spec.keychain] : [])], { provider: 'keychain', signal, env: childEnv, spawnImpl,
        timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS.default, timeoutMs)),
        exitReasons: { [KEYCHAIN_NOT_FOUND]: 'missing' } });
  }
  throw new SecretError('spawn_failed', String(spec.provider));
}

/** `fruitctl doctor --secrets`: resolve every declared credential and secret
 * ref once, keeping only provider kind and status. Values are discarded. */
export async function checkSecrets(config, { target, ...options } = {}) {
  const names = Object.keys(config?.targets ?? {});
  if (target !== undefined && !names.includes(target)) throw new Error(`Unknown target profile: ${target}`);
  const env = options.env ?? process.env;
  const childEnv = scrubbedEnvironment(env, envProviderNames(config));
  const report = {};
  let failed = false;
  let warned = false;
  const check = async spec => {
    const row = { provider: spec.provider };
    if (spec.provider === 'env') {
      row.warning = 'env_provider_discouraged';
      warned = true;
    }
    try {
      await resolveSecret(spec, { ...options, env, childEnv });
      row.status = 'ok';
    } catch (error) {
      row.status = 'fail';
      row.reason = error instanceof SecretError ? error.reason : 'spawn_failed';
      failed = true;
    }
    return row;
  };
  for (const name of target === undefined ? names : [target]) {
    const profile = config.targets[name];
    const credential = credentialSpec(profile, name);
    const refs = secretRefs(profile, name);
    const entry = { credential: credential ? await check(credential) : { status: 'absent' }, secrets: {} };
    for (const [ref, spec] of refs) entry.secrets[ref] = await check(spec);
    report[name] = entry;
  }
  return { schema: 'fruitctl.secrets-check.v1', status: failed ? 'fail' : warned ? 'warn' : 'pass',
    targets: report, qualification: 'Each provider was resolved once on this host; values were discarded unprinted' };
}
