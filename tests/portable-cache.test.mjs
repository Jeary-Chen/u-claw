import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePortableCache } from '../portable/lib/portable-cache.mjs';

function makeState(config) {
  const root = mkdtempSync(join(tmpdir(), 'uclaw-portable-cache-'));
  const stateDir = join(root, 'usb', 'data', '.openclaw');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'openclaw.json'), `${JSON.stringify(config)}\n`);
  return { root, stateDir };
}

test('managed OpenClaw runtime state and browser user data are on the local disk', () => {
  const { root, stateDir } = makeState({ gateway: { mode: 'local' } });
  const localAppData = join(root, 'LocalAppData');
  const result = resolvePortableCache({
    stateDir,
    usbRoot: join(root, 'usb'),
    platform: 'win32',
    env: { LOCALAPPDATA: localAppData },
  });
  const config = JSON.parse(readFileSync(join(stateDir, 'openclaw.json'), 'utf8'));

  assert.equal(result.localCacheAvailable, true);
  assert.ok(result.runtimeStateDir.startsWith(localAppData));
  assert.ok(result.browserUserDataDir.startsWith(localAppData));
  assert.deepEqual(config, { gateway: { mode: 'local' } }, 'portable config must stay untouched on USB');
});

test('portable config with an existing-session browser remains untouched', () => {
  const original = {
    browser: {
      defaultProfile: 'customer-chrome',
      profiles: {
        'customer-chrome': {
          driver: 'existing-session',
          userDataDir: 'C:/Users/customer/AppData/Local/Google/Chrome/User Data',
        },
      },
    },
  };
  const { root, stateDir } = makeState(original);
  const result = resolvePortableCache({
    stateDir,
    usbRoot: join(root, 'usb'),
    platform: 'win32',
    env: { LOCALAPPDATA: join(root, 'LocalAppData') },
  });
  const config = JSON.parse(readFileSync(join(stateDir, 'openclaw.json'), 'utf8'));

  assert.equal(result.localCacheAvailable, true);
  assert.deepEqual(config, original);
});

test('portable config with a user supplied managed browser directory remains untouched', () => {
  const original = {
    browser: {
      profiles: {
        openclaw: { userDataDir: 'D:/Customer-selected-browser-data' },
      },
    },
  };
  const { root, stateDir } = makeState(original);
  const result = resolvePortableCache({
    stateDir,
    usbRoot: join(root, 'usb'),
    platform: 'win32',
    env: { LOCALAPPDATA: join(root, 'LocalAppData') },
  });
  const config = JSON.parse(readFileSync(join(stateDir, 'openclaw.json'), 'utf8'));

  assert.equal(result.localCacheAvailable, true);
  assert.deepEqual(config, original);
});
