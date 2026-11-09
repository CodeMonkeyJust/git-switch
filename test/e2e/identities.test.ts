import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { startServer, type RunningServer } from '../../src/server/http.ts';
import { loadProfiles } from '../../src/core/profiles.ts';

/**
 * Identity management through the GUI.
 *
 * Adding an identity is the one UI operation that edits the schema rather than
 * just a rule, so it must reject bad input the same way the loader does — the GUI
 * must never be able to write a profile that `gs apply` would later refuse.
 */

async function withServer(
  seed: (home: string) => Promise<void>,
  fn: (ctx: { home: string; server: RunningServer; base: string; auth: Record<string, string> }) => Promise<void>,
) {
  const h = await createTmpHome();
  try {
    await seed(h.home);
    const server = await startServer({ home: h.home });
    try {
      await fn({
        home: h.home,
        server,
        base: `http://127.0.0.1:${server.port}`,
        auth: { 'x-gs-token': server.token },
      });
    } finally {
      await server.close();
    }
  } finally {
    await h.cleanup();
  }
}

const BASE_PROFILE = `schemaVersion: 1
identities:
  personal:
    user:
      name: zlj20
      email: zlj20@163.com
    sshKey: id_ed25519_github
    sites:
      - host: github.com
        alias: gh
rules:
  - dir: /code/github
    identity: personal
`;

async function seedProfile(home: string, text = BASE_PROFILE): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.join(home, '.config', 'gs'), { recursive: true });
  await writeFile(path.join(home, '.config', 'gs', 'profiles.yaml'), text, 'utf8');
  await writeFile(path.join(home, '.gitconfig'), '', 'utf8');
}

interface Summary {
  identities: { name: string; email: string; userName: string; sshKey: string | null; sites: { host: string }[] }[];
  rules: { dir: string; identity: string }[];
}

test('an identity can be added with a site', async () => {
  await withServer(seedProfile, async ({ home, base, auth }) => {
    const json = { ...auth, 'content-type': 'application/json' };
    const res = await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        add: true,
        name: 'work',
        userName: 'zhulj',
        email: 'zhulj@pde.com.cn',
        sshKey: 'id_ed25519',
        host: 'git.pdesoft.cn',
        port: '9092',
        alias: 'pde',
      }),
    });
    const raw = await res.text();
    assert.equal(res.status, 200, raw);
    const body = JSON.parse(raw) as Summary;

    const added = body.identities.find((i) => i.name === 'work');
    assert.ok(added, 'the new identity is in the summary');
    assert.equal(added.email, 'zhulj@pde.com.cn');
    assert.equal(added.sshKey, 'id_ed25519');
    assert.equal(added.sites.length, 1);

    // persisted, and parseable by the real loader
    const profiles = await loadProfiles(home);
    assert.ok(profiles.identities.some((i) => i.name === 'work'));
    const site = profiles.sites.find((s) => s.identity === 'work');
    assert.equal(site?.host, 'git.pdesoft.cn');
    assert.equal(site?.port, 9092);
  });
});

test('an identity can be added without a key or site', async () => {
  await withServer(seedProfile, async ({ home, base, auth }) => {
    const res = await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ add: true, name: 'bare', userName: 'b', email: 'b@example.com', sshKey: '', host: '' }),
    });
    assert.equal(res.status, 200, await res.text());

    const profiles = await loadProfiles(home);
    const bare = profiles.identities.find((i) => i.name === 'bare');
    assert.ok(bare);
    assert.equal(bare.sshKey, undefined, 'an empty key field stores nothing');
    assert.equal(profiles.sites.filter((s) => s.identity === 'bare').length, 0);
  });
});

test('a duplicate identity name is rejected', async () => {
  await withServer(seedProfile, async ({ base, auth }) => {
    const res = await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ add: true, name: 'personal', userName: 'x', email: 'x@example.com' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /already exists|已存在/);
  });
});

test('a malformed email or name is rejected', async () => {
  await withServer(seedProfile, async ({ base, auth }) => {
    const json = { ...auth, 'content-type': 'application/json' };

    const badEmail = await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ add: true, name: 'x', userName: 'X', email: 'not-an-email' }),
    });
    assert.equal(badEmail.status, 400);

    const badName = await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ add: true, name: 'has space', userName: 'X', email: 'x@example.com' }),
    });
    assert.equal(badName.status, 400);

    const missing = await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ add: true, name: 'y', userName: '', email: '' }),
    });
    assert.equal(missing.status, 400);
  });
});

test('an out-of-range port is rejected and nothing is persisted', async () => {
  await withServer(seedProfile, async ({ home, base, auth }) => {
    const before = await readFile(path.join(home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    const res = await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        add: true,
        name: 'bad',
        userName: 'B',
        email: 'b@example.com',
        host: 'example.com',
        port: '99999',
      }),
    });
    assert.equal(res.status, 400);
    const after = await readFile(path.join(home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    assert.equal(after, before, 'a rejected request must not touch the file');
  });
});

test('an identity in use cannot be deleted without forcing', async () => {
  const twoIdentities = `schemaVersion: 1
identities:
  personal:
    user:
      name: zlj20
      email: zlj20@163.com
    sshKey: id_ed25519_github
    sites:
      - host: github.com
        alias: gh
  gitlab:
    user:
      name: zlj20
      email: zlj20@163.com
rules:
  - dir: /code/github
    identity: personal
`;

  await withServer(
    (home) => seedProfile(home, twoIdentities),
    async ({ home, base, auth }) => {
      const before = await loadProfiles(home);
      assert.equal(before.identities.length, 2, 'the fixture must load with two identities');

      const blocked = await fetch(`${base}/api/identities?remove=personal`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({}),
      });
      assert.equal(blocked.status, 409, 'a referenced identity is protected');
      const body = (await blocked.json()) as { error: string };
      assert.match(body.error, /still used|仍被/);
      assert.ok((await loadProfiles(home)).identities.some((i) => i.name === 'personal'));

      const forced = await fetch(`${base}/api/identities?remove=personal&force=1`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({}),
      });
      const forcedText = await forced.text();
      assert.equal(forced.status, 200, forcedText);

      const profiles = await loadProfiles(home);
      assert.equal(profiles.identities.some((i) => i.name === 'personal'), false);
      assert.equal(profiles.rules.length, 0, 'dependent rules are removed with it');
    },
  );
});

test('an identity can be edited in place', async () => {
  await withServer(seedProfile, async ({ home, base, auth }) => {
    const res = await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        update: true,
        original: 'personal',
        name: 'personal',
        userName: 'zlj20',
        email: 'new@example.com',
        sshKey: 'id_other',
        host: 'github.com',
        alias: 'gh2',
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);

    const profiles = await loadProfiles(home);
    const edited = profiles.identities.find((i) => i.name === 'personal');
    assert.equal(edited?.user.email, 'new@example.com');
    assert.equal(edited?.sshKey, 'id_other');
    assert.equal(profiles.sites.find((s) => s.identity === 'personal')?.alias, 'gh2');
  });
});

test('renaming an identity updates the rules that reference it', async () => {
  await withServer(seedProfile, async ({ home, base, auth }) => {
    const res = await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        update: true,
        original: 'personal',
        name: 'home',
        userName: 'zlj20',
        email: 'zlj20@163.com',
        sshKey: 'id_ed25519_github',
        host: 'github.com',
      }),
    });
    assert.equal(res.status, 200, await res.text());

    // a rename that left the rule pointing at the old name would break loading
    const profiles = await loadProfiles(home);
    assert.ok(profiles.identities.some((i) => i.name === 'home'));
    assert.equal(profiles.identities.some((i) => i.name === 'personal'), false);
    assert.ok(profiles.rules.every((r) => r.identity === 'home'), JSON.stringify(profiles.rules));
  });
});

test('editing rejects an invalid email and leaves the file unchanged', async () => {
  await withServer(seedProfile, async ({ home, base, auth }) => {
    const before = await readFile(path.join(home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    const res = await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        update: true,
        original: 'personal',
        name: 'personal',
        userName: 'x',
        email: 'bad-email',
      }),
    });
    assert.equal(res.status, 400);
    const after = await readFile(path.join(home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    assert.equal(after, before);
  });
});

test('renaming onto an existing name is rejected', async () => {
  // two identities declared together, before the rules section
  const two = `schemaVersion: 1
identities:
  personal:
    user:
      name: zlj20
      email: zlj20@163.com
    sshKey: id_ed25519_github
    sites:
      - host: github.com
        alias: gh
  other:
    user:
      name: o
      email: o@example.com
rules:
  - dir: /code/github
    identity: personal
`;
  await withServer(
    (home) => seedProfile(home, two),
    async ({ home, base, auth }) => {
      const res = await fetch(`${base}/api/identities`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          update: true,
          original: 'personal',
          name: 'other',
          userName: 'x',
          email: 'x@example.com',
        }),
      });
      assert.equal(res.status, 400);
      const profiles = await loadProfiles(home);
      assert.equal(profiles.identities.filter((i) => i.name === 'other').length, 1);
    },
  );
});

test('editing a missing identity returns 404', async () => {
  await withServer(seedProfile, async ({ base, auth }) => {
    const res = await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        update: true,
        original: 'ghost',
        name: 'ghost',
        userName: 'g',
        email: 'g@example.com',
      }),
    });
    assert.equal(res.status, 404);
  });
});

test('clearing the SSH key removes it', async () => {
  await withServer(seedProfile, async ({ home, base, auth }) => {
    await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        update: true,
        original: 'personal',
        name: 'personal',
        userName: 'zlj20',
        email: 'zlj20@163.com',
        sshKey: '',
        host: 'github.com',
      }),
    });
    const profiles = await loadProfiles(home);
    assert.equal(profiles.identities.find((i) => i.name === 'personal')?.sshKey, undefined);
  });
});

test('the last identity cannot be deleted, keeping the profile loadable', async () => {
  await withServer(seedProfile, async ({ home, base, auth }) => {
    const res = await fetch(`${base}/api/identities?remove=personal&force=1`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409, 'the last identity is protected even with force');

    // the file must still parse — an empty identities map would break every command
    const profiles = await loadProfiles(home);
    assert.equal(profiles.identities.length, 1);
  });
});

test('an unused identity is deleted directly', async () => {
  await withServer(seedProfile, async ({ home, base, auth }) => {
    await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ add: true, name: 'spare', userName: 'S', email: 's@example.com' }),
    });

    const res = await fetch(`${base}/api/identities?remove=spare`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.equal((await loadProfiles(home)).identities.some((i) => i.name === 'spare'), false);
  });
});

test('the endpoint requires a token like every other API call', async () => {
  await withServer(seedProfile, async ({ base }) => {
    const res = await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ add: true, name: 'x', userName: 'X', email: 'x@example.com' }),
    });
    assert.equal(res.status, 401);
  });
});

test('a new identity does not take effect until apply', async () => {
  await withServer(seedProfile, async ({ home, base, auth }) => {
    await fetch(`${base}/api/identities`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ add: true, name: 'later', userName: 'L', email: 'l@example.com' }),
    });

    // profiles.yaml changed, but the managed block in ~/.gitconfig has not
    const gitconfig = await readFile(path.join(home, '.gitconfig'), 'utf8');
    assert.ok(!gitconfig.includes('gs:managed'), 'nothing is written to git config yet');

    const plan = (await (await fetch(`${base}/api/plan`, { method: 'POST', headers: auth })).json()) as {
      dirty: boolean;
    };
    assert.equal(plan.dirty, true, 'the change shows up as pending');
  });
});
