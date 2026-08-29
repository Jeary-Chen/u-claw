// Adds a narrowly-scoped Windows retry for OpenClaw device-pairing JSON files.
// Antivirus/indexer handles can make an otherwise atomic rename return EPERM.
// The patch is fail-closed and deliberately refuses the non-atomic copy fallback
// for paired.json/pending.json: preserving the last good pairing state is safer.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXPECTED_VERSION = '2026.7.1-2';
const EXPECTED_SHA256 = '9f4d780a173664ad12da1ffb4cbd110c68497bfd3c23b8a5ae28602ed24c9db8';
const BUNDLE = 'node_modules/openclaw/dist/replace-file-DfwQ8_Mi.js';
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
const OLD_ASYNC = `\t\tconst result = await renameWithRetry({
\t\t\tfsModule,
\t\t\tsrc: tempPath,
\t\t\tdest: filePath,
\t\t\tmaxRetries: options.renameMaxRetries ?? 0,
\t\t\tbaseDelayMs: options.renameRetryBaseDelayMs ?? 50,
\t\t\tcopyFallbackOnPermissionError: options.copyFallbackOnPermissionError === true
\t\t});`;
const NEW_ASYNC = `\t\tconst pairingStateFile = /[\\\\/]devices[\\\\/](?:paired|pending)\\.json$/i.test(filePath);
\t\tconst result = await renameWithRetry({
\t\t\tfsModule,
\t\t\tsrc: tempPath,
\t\t\tdest: filePath,
\t\t\tmaxRetries: pairingStateFile ? Math.max(options.renameMaxRetries ?? 0, 4) : options.renameMaxRetries ?? 0,
\t\t\tbaseDelayMs: pairingStateFile ? 25 : options.renameRetryBaseDelayMs ?? 50,
\t\t\tcopyFallbackOnPermissionError: pairingStateFile ? false : options.copyFallbackOnPermissionError === true
\t\t});`;
const OLD_SYNC = `\t\tconst result = renameWithRetrySync({
\t\t\tfsModule,
\t\t\tsrc: tempPath,
\t\t\tdest: filePath,
\t\t\tmaxRetries: options.renameMaxRetries ?? 0,
\t\t\tbaseDelayMs: options.renameRetryBaseDelayMs ?? 50,
\t\t\tcopyFallbackOnPermissionError: options.copyFallbackOnPermissionError === true
\t\t});`;
const NEW_SYNC = `\t\tconst pairingStateFile = /[\\\\/]devices[\\\\/](?:paired|pending)\\.json$/i.test(filePath);
\t\tconst result = renameWithRetrySync({
\t\t\tfsModule,
\t\t\tsrc: tempPath,
\t\t\tdest: filePath,
\t\t\tmaxRetries: pairingStateFile ? Math.max(options.renameMaxRetries ?? 0, 4) : options.renameMaxRetries ?? 0,
\t\t\tbaseDelayMs: pairingStateFile ? 25 : options.renameRetryBaseDelayMs ?? 50,
\t\t\tcopyFallbackOnPermissionError: pairingStateFile ? false : options.copyFallbackOnPermissionError === true
\t\t});`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function replaceExactlyOnce(source, oldText, newText, label) {
  if (source.split(oldText).length - 1 !== 1) {
    throw new Error(`Refuse pairing retry patch: expected exactly one ${label} call site`);
  }
  return source.replace(oldText, newText);
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
patched = replaceExactlyOnce(patched, OLD_ASYNC, NEW_ASYNC, 'async');
patched = replaceExactlyOnce(patched, OLD_SYNC, NEW_SYNC, 'sync');
if (patched.includes(OLD_RETRYABLE) || patched.includes(OLD_RETRY_CALL) || patched.includes(OLD_ASYNC) || patched.includes(OLD_SYNC) || patched.split('const pairingStateFile').length - 1 !== 2) {
  throw new Error('Refuse pairing retry patch: post-condition failed');
}
writeFileSync(bundlePath, patched, 'utf8');
process.stdout.write(`patched device pairing rename retry: ${bundlePath}\nsha256=${sha256(patched)}\n`);
