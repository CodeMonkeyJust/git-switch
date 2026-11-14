import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { startServer } from '../../src/server/http.ts';
import { loadProfiles } from '../../src/core/profiles.ts';

/**
 * Editing an identity must not silently drop fields the form does not show.
 *
 * This is a real regression that broke pushes: the GitHub site had
 * `sshHostName: ssh.github.com`, the identity editor rebuilt the site from its
 * own fields, and the field vanished — leaving `HostName github.com` + `Port 443`,
 * which authenticates but drops the connection as soon as git asks for a pack.
 */

const PROFILE = `schemaVersion: 1
identities:
  github:
    user:
      name: alexchen
      email: alex@personal.example
    sshKey: id_gh
    sites:
      - host: github.com
        port: 443
        sshHostName: ssh.github.com
        alias: github
rules:
  - dir: /code/github
    identity: github
`;

async function withServer(
  fn: (ctx: { home: string; base: string; auth: Record<string, string> }) => Promise<void>,
  profile = PROFILE,
) {
  const h = await createTmpHome();
  try {
    await mkdir(path.join(h.home, '.config', 'gs'), { recursive: true });
    await writeFile(path.join(h.home, '.config', 'gs', 'profiles.yaml'), profile, 'utf8');
    await writeFile(path.join(h.home, '.gitconfig'), '', 'utf8');
    const server = await startServer({ home: h.home });
    try {
      await fn({
        home: h.home,
        base: `http://127.0.0.1:${server.port}`,
        auth: { 'x-gs-token': server.token, 'content-type': 'application/json' },
      });
    } finally {
      await server.close();
    }
  } finally {
    await h.cleanup();
  }
}

function post(base: string, auth: Record<string, string>) {
  return async (p: string, body: unknown) => {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as Record<string, unknown> };
  };
}

test('editing an identity keeps sshHostName when the form omits it', async () => {
  await withServer(async ({ home, base, auth }) => {
    const send = post(base, auth);
    // exactly what the old form sent: no sshHostName at all
    const res = await send('/api/identities', {
      update: true,
      original: 'github',
      name: 'github',
      userName: 'alexchen',
      email: 'new@example.com',
      sshKey: 'id_gh',
      host: 'github.com',
      port: '443',
      alias: 'github',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const profiles = await loadProfiles(home);
    const site = profiles.sites.find((s) => s.identity === 'github');
    assert.equal(site?.sshHostName, 'ssh.github.com', 'the SSH endpoint must survive an edit');
  });
});

test('sshHostName can be set explicitly through the form', async () => {
  await withServer(async ({ home, base, auth }) => {
    const send = post(base, auth);
    const res = await send('/api/identities', {
      update: true,
      original: 'github',
      name: 'github',
      userName: 'alexchen',
      email: 'alex@personal.example',
      sshKey: 'id_gh',
      host: 'github.com',
      port: '443',
      sshHostName: 'ssh2.example.com',
      alias: 'github',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const profiles = await loadProfiles(home);
    assert.equal(profiles.sites[0]?.sshHostName, 'ssh2.example.com');
  });
});

test('a URL in sshHostName is rejected, not stored', async () => {
  await withServer(async ({ home, base, auth }) => {
    const before = await readFile(path.join(home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    const send = post(base, auth);
    const res = await send('/api/identities', {
      update: true,
      original: 'github',
      name: 'github',
      userName: 'alexchen',
      email: 'alex@personal.example',
      sshKey: 'id_gh',
      host: 'github.com',
      sshHostName: 'https://ssh.github.com/',
    });
    assert.equal(res.status, 400);

    const after = await readFile(path.join(home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    assert.equal(after, before, 'a rejected edit writes nothing');
  });
});

test('adding an identity can carry an SSH endpoint', async () => {
  await withServer(async ({ home, base, auth }) => {
    const send = post(base, auth);
    const res = await send('/api/identities', {
      add: true,
      name: 'work',
      userName: 'w',
      email: 'w@example.com',
      sshKey: 'id_gh',
      host: 'git.company.com',
      port: '443',
      sshHostName: 'ssh.company.com',
      user: 'git',
      alias: 'work',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const profiles = await loadProfiles(home);
    const site = profiles.sites.find((s) => s.identity === 'work');
    assert.equal(site?.sshHostName, 'ssh.company.com');
    assert.equal(site?.user, 'git');
  });
});

test('other unexposed site fields survive an edit too', async () => {
  const withExtras = `schemaVersion: 1
identities:
  a:
    user:
      name: u
      email: u@example.com
      sshKey: id_gh
    sites:
      - host: a.example.com
        user: deploy
        sshHostName: ssh.a.example.com
      - host: b.example.com
rules: []
`;
  await withServer(
    async ({ home, base, auth }) => {
      const send = post(base, auth);
      const res = await send('/api/identities', {
        update: true,
        original: 'a',
        name: 'a',
        userName: 'u',
        email: 'u@example.com',
        sshKey: 'id_gh',
        host: 'a.example.com',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const profiles = await loadProfiles(home);
      const site = profiles.sites.find((s) => s.identity === 'a');
      assert.equal(site?.user, 'deploy', 'the ssh user is kept');
      assert.equal(site?.sshHostName, 'ssh.a.example.com', 'the ssh endpoint is kept');
    },
    withExtras,
  );
});
