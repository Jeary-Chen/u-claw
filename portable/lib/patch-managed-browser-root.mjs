// Applies the narrowly-scoped U-Claw vendor patch for OpenClaw 2026.9.1.
// This must fail closed: an upstream bundle change is never silently patched.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXPECTED_VERSION = '2026.9.1';
const EXPECTED_SHA256 = '18326ff44b7a524db1ca68a6b5973b049b67d46e8a91b666cba2a3294cb3c527';
const OLD = 'return path.join(CONFIG_DIR, "browser", profileName, "user-data");';
const NEXT = 'return path.join(process.env.OPENCLAW_MANAGED_BROWSER_DIR?.trim() || path.join(CONFIG_DIR, "browser"), profileName, "user-data");';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const coreDir = resolve(process.argv[2] || process.cwd());
const packagePath = resolve(coreDir, 'node_modules/openclaw/package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
if (packageJson.version !== EXPECTED_VERSION) {
  throw new Error(`Refuse browser patch: expected OpenClaw ${EXPECTED_VERSION}, got ${packageJson.version}`);
}

const bundlePath = resolve(coreDir, 'node_modules/openclaw/dist/chrome-lc3LoS6t.js');
const source = readFileSync(bundlePath, 'utf8');
if (sha256(source) !== EXPECTED_SHA256) {
  throw new Error(`Refuse browser patch: unexpected input SHA-256 for ${bundlePath}`);
}
if (source.split(OLD).length - 1 !== 1) {
  throw new Error('Refuse browser patch: expected exactly one original resolver');
}

const patched = source.replace(OLD, NEXT);
if (patched.split(OLD).length - 1 !== 0 || patched.split(NEXT).length - 1 !== 1) {
  throw new Error('Refuse browser patch: post-condition failed');
}
writeFileSync(bundlePath, patched, 'utf8');
process.stdout.write(`patched managed browser root: ${bundlePath}\nsha256=${sha256(patched)}\n`);
