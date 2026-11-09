import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProfilesText } from '../../src/core/profiles.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.resolve(here, '..', '..', 'examples');
const HOME = path.resolve(here, '..', '..');

test('every file in examples/ validates against the schema', async () => {
  const files = (await readdir(examplesDir)).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length > 0, 'examples directory must not be empty');

  for (const file of files) {
    const text = await readFile(path.join(examplesDir, file), 'utf8');
    const profiles = parseProfilesText(text, HOME);
    assert.ok(profiles.identities.length > 0, `${file}: needs at least one identity`);
    // every rule must point at a declared identity
    for (const rule of profiles.rules) {
      assert.ok(
        profiles.identities.some((i) => i.name === rule.identity),
        `${file}: rule ${rule.dir} references unknown identity ${rule.identity}`,
      );
    }
  }
});
