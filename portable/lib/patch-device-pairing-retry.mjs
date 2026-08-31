// Adds a narrowly-scoped Windows retry for OpenClaw device-pairing JSON files.
// Antivirus/indexer handles can make an otherwise atomic rename return EPERM.
// The patch is fail-closed and deliberately refuses the non-atomic copy fallback
// for paired.json/pending.json: preserving the last good pairing state is safer.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXPECTED_VERSION = '2026.8.1';
const EXPECTED_SHA256 = '08818a161252713e1225013788d7960cd3f87ee8f6423e23d2885aceee9c4b8f';
const BUNDLE = 'node_modules/openclaw/dist/replace-file-f6TD5O4c.js';
const OLD_RETRYABLE = `function isRetryableRenameError(error) {
\treturn error.code === "EBUSY";
}`;
const NEW_RETRYABLE = `function isDevicePairingStatePath(filePath) {
\treturn /[\\\\/]devices[\\\\/](?:paired|pending)\\.json$/i.test(filePath);
}
function isRetryableRenameError(error, dest) {
\tconst code = error?.code;
\treturn code === "EBUSY" || isDevicePairingStatePath(dest) && (code === "EPERM" || code === "ENOTEMPTY");
}`;
const OLD_RETRY_CALL = 'isRetryableRenameError(error) && attempt < params.maxRetries';
const NEW_RETRY_CALL = 'isRetryableRenameError(error, params.dest) && attempt < params.maxRetries';
const ASYNC_PREFIX = `\t\tconst result = await renameWithRetry({
\t\t\tfsModule,
\t\t\tsrc: tempPath,
\t\t\tdest: filePath,`;
const SYNC_PREFIX = `\t\tconst result = renameWithRetrySync({
\t\t\tfsModule,
\t\t\tsrc: tempPath,
\t\t\tdest: filePath,`;
const PAIRING_STATE_FILE = '\t\tconst pairingStateFile = /[\\\\/]devices[\\\\/](?:paired|pending)\\.json$/i.test(filePath);\n';
const OLD_MAX_RETRIES = 'maxRetries: options.renameMaxRetries ?? 0,';
const NEW_MAX_RETRIES = 'maxRetries: pairingStateFile ? Math.max(options.renameMaxRetries ?? 0, 4) : options.renameMaxRetries ?? 0,';
const OLD_BASE_DELAY = 'baseDelayMs: options.renameRetryBaseDelayMs ?? 50,';
const NEW_BASE_DELAY = 'baseDelayMs: pairingStateFile ? 25 : options.renameRetryBaseDelayMs ?? 50,';
const OLD_COPY_FALLBACK = 'copyFallbackOnPermissionError: options.copyFallbackOnPermissionError === true,';
const NEW_COPY_FALLBACK = 'copyFallbackOnPermissionError: pairingStateFile ? false : options.copyFallbackOnPermissionError === true,';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function replaceExactlyOnce(source, oldText, newText, label) {
  if (source.split(oldText).length - 1 !== 1) {
    throw new Error(`Refuse pairing retry patch: expected exactly one ${label} call site`);
  }
  return source.replace(oldText, newText);
}

function prependPairingStateFile(source, prefix, label) {
  return replaceExactlyOnce(source, prefix, PAIRING_STATE_FILE + prefix, label);
}

function replaceInCallBlock(source, prefix, oldText, newText, label) {
  const start = source.indexOf(prefix);
  if (start === -1 || source.indexOf(prefix, start + prefix.length) !== -1) {
    throw new Error(`Refuse pairing retry patch: expected exactly one ${label} call block`);
  }
  const end = source.indexOf('\n\t\t});', start);
  if (end === -1) {
    throw new Error(`Refuse pairing retry patch: cannot find end of ${label} call block`);
  }
  const block = source.slice(start, end);
  if (block.split(oldText).length - 1 !== 1) {
    throw new Error(`Refuse pairing retry patch: expected exactly one ${label} option`);
  }
  return source.slice(0, start) + block.replace(oldText, newText) + source.slice(end);
}

const coreDir = resolve(process.argv[2] || process.cwd());
const packageJson = JSON.parse(readFileSync(resolve(coreDir, 'node_modules/openclaw/package.json'), 'utf8'));
if (packageJson.version !== EXPECTED_VERSION) {
  throw new Error(`Refuse pairing retry patch: expected OpenClaw ${EXPECTED_VERSION}, got ${packageJson.version}`);
}
const bundlePath = resolve(coreDir, BUNDLE);
const source = readFileSync(bundlePath, 'utf8');
if (sha256(source) !== EXPECTED_SHA256) {
  throw new Error(`Refuse pairing retry patch: unexpected input SHA-256 for ${bundlePath}`);
}
let patched = replaceExactlyOnce(source, OLD_RETRYABLE, NEW_RETRYABLE, 'retry predicate');
if (patched.split(OLD_RETRY_CALL).length - 1 !== 2) {
  throw new Error('Refuse pairing retry patch: expected exactly two retry call sites');
}
patched = patched.replaceAll(OLD_RETRY_CALL, NEW_RETRY_CALL);
patched = prependPairingStateFile(patched, ASYNC_PREFIX, 'async pairing-state prefix');
patched = prependPairingStateFile(patched, SYNC_PREFIX, 'sync pairing-state prefix');
for (const [prefix, label] of [[ASYNC_PREFIX, 'async'], [SYNC_PREFIX, 'sync']]) {
  patched = replaceInCallBlock(patched, prefix, OLD_MAX_RETRIES, NEW_MAX_RETRIES, `${label} maxRetries`);
  patched = replaceInCallBlock(patched, prefix, OLD_BASE_DELAY, NEW_BASE_DELAY, `${label} baseDelayMs`);
  patched = replaceInCallBlock(patched, prefix, OLD_COPY_FALLBACK, NEW_COPY_FALLBACK, `${label} copy fallback`);
}
if (
  patched.includes(OLD_RETRYABLE) ||
  patched.includes(OLD_RETRY_CALL) ||
  patched.split('const pairingStateFile').length - 1 !== 2 ||
  patched.split(NEW_MAX_RETRIES).length - 1 !== 2 ||
  patched.split(NEW_BASE_DELAY).length - 1 !== 2 ||
  patched.split(NEW_COPY_FALLBACK).length - 1 !== 2
) {
  throw new Error('Refuse pairing retry patch: post-condition failed');
}
writeFileSync(bundlePath, patched, 'utf8');
process.stdout.write(`patched device pairing rename retry: ${bundlePath}\nsha256=${sha256(patched)}\n`);
