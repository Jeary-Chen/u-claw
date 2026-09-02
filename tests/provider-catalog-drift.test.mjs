import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_PROVIDER_ENV_VARS } from '../portable/lib/strip-provider-env.mjs';
import { OFFICIAL_PROVIDER_SNAPSHOT } from '../portable/lib/official-provider-guard.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/official-external-provider-catalog-2026.8.1.json'), 'utf8'));
const sorted = (values) => [...new Set(values)].sort();
const fixtureEnvVars = () => fixture.entries.flatMap((entry) => entry.providers.flatMap((provider) => provider.envVars));
const fixtureIds = () => fixture.entries.flatMap((entry) => entry.providers.map((provider) => provider.id));

test('provider env stripping list exactly matches the 2026.8.1 official catalog fixture', () => {
  assert.deepEqual(sorted(OFFICIAL_PROVIDER_ENV_VARS), sorted(fixtureEnvVars()));
});

test('provider guard snapshot ids exactly match the 2026.8.1 official catalog fixture', () => {
  assert.deepEqual(sorted(OFFICIAL_PROVIDER_SNAPSHOT.map(([id]) => id)), sorted(fixtureIds()));
});
