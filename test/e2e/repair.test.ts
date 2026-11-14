import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { startServer } from '../../src/server/http.ts';
import { splitHostInput, isBareHost, suggestRepair, applyRepair } from '../../src/core/repair.ts';
import { parseProfilesText } from '../../src/core/profiles.ts';

/**
 * Repairing a profile from the GUI.
 *
 * A URL pasted into a site's host field stops the whole profile from loading.
 * The page must be able to fix it without the user opening an editor — but a
 * "fix" that still cannot be parsed is worse than no fix at all, so every
 * applied repair is re-validated before it is written.
 */

const BROKEN = `schemaVersion: 1
identities:
  pdegit:
    user:
      name: zhulj
      email: zhulj@example.com
    sshKey: id_key
    sites:
      - host: http://git.pdesoft.cn:9090/
rules: []
`;

const BROKEN_INDENTED = `schemaVersion: 1
identities:
  pdegit:
    user:
      name: zhulj
      email: zhulj@example.com
    sites:
      - alias: pde
        host: https://git.example.com:8443/path
rules: []
`;

/* ------------------------------ helpers ------------------------------- */

test('splitHostInput extracts host and port from the usual mistakes', () => {
  assert.deepEqual(splitHostInput('http://git.pdesoft.cn:9090/'), { host: 'git.pdesoft.cn', port: '9090' });
  assert.deepEqual(splitHostInput('https://github.com'), { host: 'github.com' });
  assert.deepEqual(splitHostInput('git@github.com:owner/repo.git'), { host: 'github.com' });
  assert.deepEqual(splitHostInput('git.pdesoft.cn:9092'), { host: 'git.pdesoft.cn', port: '9092' });
  assert.deepEqual(splitHostInput('  gitee.com  '), { host: 'gitee.com' });
  assert.deepEqual(splitHostInput('ssh://git@host.example:22/x'), { host: 'host.example', port: '22' });
});

test('isBareHost accepts only a plain hostname', () => {
  assert.equal(isBareHost('github.com'), true);
  assert.equal(isBareHost('git.pdesoft.cn'), true);
  assert.equal(isBareHost('localhost'), true);
  assert.equal(isBareHost('http://a.com'), false);
  assert.equal(isBareHost('a.com:22'), false);
  assert.equal(isBareHost(''), false);
});

test('suggestRepair proposes host and port separately', () => {
  const suggestion = suggestRepair(
    'identities.pdegit.sites[0].host: not a valid host: http://git.pdesoft.cn:9090/',
  );
  assert.ok(suggestion);
  assert.equal(suggestion.fixable, true);
  assert.equal(suggestion.fixed, 'git.pdesoft.cn');
  assert.deepEqual(suggestion.extra, { path: 'identities.pdegit.sites[0].port', value: '9090' });
});

test('suggestRepair refuses when nothing usable is left', () => {
  const suggestion = suggestRepair('identities.a.sites[0].host: not a valid host: ///');
  assert.ok(suggestion);
  assert.equal(suggestion.fixable, false);
});

/* ------------------------------ applyRepair --------------------------- */

test('applyRepair rewrites the inline host and adds the port', () => {
  const suggestion = suggestRepair(
    'identities.pdegit.sites[0].host: not a valid host: http://git.pdesoft.cn:9090/',
  );
  assert.ok(suggestion);
  const repaired = applyRepair(BROKEN, suggestion);

  assert.match(repaired, /- host: git\.pdesoft\.cn/);
  assert.match(repaired, /port: 9090/);
  assert.ok(!repaired.includes('http://'), 'the URL is gone');

  // and the result must actually load
  const profiles = parseProfilesText(repaired, 'test');
  const site = profiles.sites[0];
  assert.equal(site?.host, 'git.pdesoft.cn');
  assert.equal(site?.port, 9090);
});

test('applyRepair handles a nested host key under a list item', () => {
  const suggestion = suggestRepair(
    'identities.pdegit.sites[0].host: not a valid host: https://git.example.com:8443/path',
  );
  assert.ok(suggestion);
  const repaired = applyRepair(BROKEN_INDENTED, suggestion);

  assert.match(repaired, /host: git\.example\.com/);
  assert.match(repaired, /port: 8443/);
  assert.match(repaired, /alias: pde/, 'surrounding fields are kept');

  const profiles = parseProfilesText(repaired, 'test');
  assert.equal(profiles.sites[0]?.host, 'git.example.com');
  assert.equal(profiles.sites[0]?.port, 8443);
});

test('applyRepair leaves unrelated identities alone', () => {
  const two = `schemaVersion: 1
identities:
  good:
    user:
      name: a
      email: a@example.com
    sites:
      - host: github.com
  bad:
    user:
      name: b
      email: b@example.com
    sites:
      - host: http://bad.example:1234/
rules: []
`;
  const suggestion = suggestRepair('identities.bad.sites[0].host: not a valid host: http://bad.example:1234/');
  assert.ok(suggestion);
  const repaired = applyRepair(two, suggestion);
  assert.match(repaired, /- host: github\.com/, 'the valid identity is untouched');
  assert.match(repaired, /- host: bad\.example/);
});

/* ------------------------------ endpoint ------------------------------ */

async function withServer(profile: string, fn: (base: string, token: string, home: string) => Promise<void>) {
  const h = await createTmpHome();
  try {
    await mkdir(path.join(h.home, '.config', 'gs'), { recursive: true });
    await writeFile(path.join(h.home, '.config', 'gs', 'profiles.yaml'), profile, 'utf8');
    await writeFile(path.join(h.home, '.gitconfig'), '[user]\n\tname = g\n\temail = g@example.com\n', 'utf8');
    const server = await startServer({ home: h.home });
    try {
      await fn(`http://127.0.0.1:${server.port}`, server.token, h.home);
    } finally {
      await server.close();
    }
  } finally {
    await h.cleanup();
  }
}

test('the repair endpoint previews before writing', async () => {
  await withServer(BROKEN, async (base, token, home) => {
    const before = await readFile(path.join(home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    const res = await fetch(`${base}/api/repair`, {
      method: 'POST',
      headers: { 'x-gs-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ apply: false }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { dryRun?: boolean; ok: boolean; suggestion?: { fixed?: string } };

    assert.equal(body.ok, false, 'a preview does not claim success');
    assert.equal(body.suggestion?.fixed, 'git.pdesoft.cn');

    const after = await readFile(path.join(home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    assert.equal(after, before, 'a preview writes nothing');
  });
});

test('applying the repair fixes the profile and keeps a backup', async () => {
  await withServer(BROKEN, async (base, token, home) => {
    const res = await fetch(`${base}/api/repair`, {
      method: 'POST',
      headers: { 'x-gs-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ apply: true }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; backup?: string };
    assert.equal(body.ok, true, JSON.stringify(body));

    const fixed = await readFile(path.join(home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    const profiles = parseProfilesText(fixed, 'test');
    assert.equal(profiles.sites[0]?.host, 'git.pdesoft.cn');
    assert.equal(profiles.sites[0]?.port, 9090);

    const backup = await readFile(`${body.backup ?? ''}`, 'utf8').catch(() => '');
    assert.match(backup, /http:\/\/git\.pdesoft\.cn:9090\//, 'the original is recoverable');
  });
});

test('a valid profile reports nothing to repair', async () => {
  const valid = BROKEN.replace('http://git.pdesoft.cn:9090/', 'git.pdesoft.cn');
  await withServer(valid, async (base, token) => {
    const res = await fetch(`${base}/api/repair`, {
      method: 'POST',
      headers: { 'x-gs-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ apply: true }),
    });
    const body = (await res.json()) as { alreadyValid?: boolean };
    assert.equal(body.alreadyValid, true);
  });
});

test('state becomes usable again after the repair', async () => {
  await withServer(BROKEN, async (base, token) => {
    const broken = (await (
      await fetch(`${base}/api/state`, { headers: { 'x-gs-token': token } })
    ).json()) as { profileError?: string };
    assert.ok(broken.profileError);

    await fetch(`${base}/api/repair`, {
      method: 'POST',
      headers: { 'x-gs-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ apply: true }),
    });

    const fixed = (await (
      await fetch(`${base}/api/state`, { headers: { 'x-gs-token': token } })
    ).json()) as { profileError?: string; identities: { name: string }[] };
    assert.equal(fixed.profileError, undefined);
    assert.equal(fixed.identities[0]?.name, 'pdegit');
  });
});
