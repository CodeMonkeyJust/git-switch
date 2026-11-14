import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { createLogger } from '../../src/util/log.ts';
import { doctorCommand } from '../../src/commands/doctor.ts';
import { keyCommand } from '../../src/commands/key.ts';
import { snapshotCommand } from '../../src/commands/snapshot.ts';

const posix = (p: string) => p.replace(/\\/g, '/');

interface Capture {
  stream: NodeJS.WriteStream;
  text: () => string;
}

function capture(): Capture {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  (stream as unknown as { isTTY: boolean }).isTTY = false;
  return { stream, text: () => chunks.join('') };
}

function loggerFor(captured: Capture, json = false) {
  return createLogger({ color: false, json, unifiedErrors: true, stream: captured.stream });
}

async function seedProfile(home: string, keyName = 'id_missing'): Promise<void> {
  await mkdir(path.join(home, '.config', 'gs'), { recursive: true });
  await writeFile(
    path.join(home, '.config', 'gs', 'profiles.yaml'),
    `schemaVersion: 1
identities:
  work:
    user:
      name: Alex Chen
      email: alex@example.com
    sshKey: ${keyName}
    sites:
      - host: git.example.com
        port: 9092
rules:
  - dir: ${posix(home)}/code/work
    identity: work
`,
    'utf8',
  );
  await writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = g\n\temail = g@example.com\n', 'utf8');
}

test('gs doctor reports a missing key as an error and exits 2', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seedProfile(h.home);
    const code = await doctorCommand({ home: h.home, logger: loggerFor(out), json: false });
    assert.equal(code, 2, 'an error-level finding must produce exit code 2');

    const text = out.text();
    assert.match(text, /id_missing/);
    assert.match(text, /does not exist/);
    assert.match(text, /ssh-keygen/, 'the fix command is shown');
  } finally {
    await h.cleanup();
  }
});

test('gs doctor is clean when the key exists and the block is applied', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seedProfile(h.home, 'id_ok');
    await mkdir(path.join(h.home, '.ssh'), { recursive: true });
    await writeFile(
      path.join(h.home, '.ssh', 'id_ok'),
      '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n',
      'utf8',
    );
    // apply first so the managed block exists
    const { loadProfiles } = await import('../../src/core/profiles.ts');
    const { plan } = await import('../../src/core/plan.ts');
    const { apply } = await import('../../src/core/apply.ts');
    const profiles = await loadProfiles(h.home);
    await apply(await plan({ home: h.home, profiles }), { home: h.home });

    const code = await doctorCommand({ home: h.home, logger: loggerFor(out), json: false });
    assert.equal(code, 0, out.text());
    assert.match(out.text(), /0 errors/);
  } finally {
    await h.cleanup();
  }
});

test('gs doctor --json is machine readable', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seedProfile(h.home);
    await doctorCommand({ home: h.home, logger: loggerFor(out, true), json: true });
    const data = JSON.parse(out.text()) as { errors: number; warnings: number; results: unknown[] };
    assert.ok(data.errors >= 1);
    assert.ok(Array.isArray(data.results));
  } finally {
    await h.cleanup();
  }
});

test('gs key list reports no keys when ~/.ssh is empty', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seedProfile(h.home);
    const code = await keyCommand({ home: h.home, subcommand: 'list', target: undefined, logger: loggerFor(out) });
    assert.equal(code, 0);
    assert.match(out.text(), /no SSH keys found/);
  } finally {
    await h.cleanup();
  }
});

test('gs key list shows a key with its fingerprint and owning identity', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seedProfile(h.home, 'id_listed');
    const { generateKey } = await import('../../src/core/keys.ts');
    await generateKey({ home: h.home, name: 'id_listed' });

    const code = await keyCommand({ home: h.home, subcommand: 'list', target: undefined, logger: loggerFor(out) });
    assert.equal(code, 0);
    const text = out.text();
    assert.match(text, /id_listed/);
    assert.match(text, /SHA256:/);
    assert.match(text, /work/, 'the identity using the key is named');
  } finally {
    await h.cleanup();
  }
});

test('gs key gen refuses a name without an argument', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seedProfile(h.home);
    const code = await keyCommand({ home: h.home, subcommand: 'gen', target: undefined, logger: loggerFor(out) });
    assert.equal(code, 2);
    assert.match(out.text(), /usage/);
  } finally {
    await h.cleanup();
  }
});

test('gs key reports an unknown subcommand instead of doing nothing', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seedProfile(h.home);
    const code = await keyCommand({ home: h.home, subcommand: 'frobnicate', target: undefined, logger: loggerFor(out) });
    assert.equal(code, 2);
    assert.match(out.text(), /unknown key subcommand/);
  } finally {
    await h.cleanup();
  }
});

test('gs snapshot export then import round-trips a profile', async () => {
  const source = await createTmpHome();
  const target = await createTmpHome();
  const snap = path.join(source.home, 'snap.gsnap');
  try {
    await seedProfile(source.home, 'id_ok');

    const exportOut = capture();
    const code = await snapshotCommand({
      home: source.home,
      subcommand: 'export',
      target: snap,
      force: true,
      logger: loggerFor(exportOut),
    });
    assert.equal(code, 0, exportOut.text());
    assert.match(exportOut.text(), /wrote/);

    const importOut = capture();
    const code2 = await snapshotCommand({
      home: target.home,
      subcommand: 'import',
      target: snap,
      force: true,
      logger: loggerFor(importOut),
    });
    assert.equal(code2, 0, importOut.text());

    const { loadProfiles } = await import('../../src/core/profiles.ts');
    const migrated = await loadProfiles(target.home);
    assert.equal(migrated.identities.length, 1);
    assert.equal(migrated.identities[0]?.user.email, 'alex@example.com');
  } finally {
    await source.cleanup();
    await target.cleanup();
  }
});

test('gs snapshot export refuses to overwrite without --force', async () => {
  const h = await createTmpHome();
  const snap = path.join(h.home, 'snap.gsnap');
  try {
    await seedProfile(h.home, 'id_ok');
    await writeFile(snap, 'existing', 'utf8');

    const out = capture();
    const code = await snapshotCommand({
      home: h.home,
      subcommand: 'export',
      target: snap,
      logger: loggerFor(out),
    });
    assert.equal(code, 2);
    assert.match(out.text(), /already exists/);
  } finally {
    await h.cleanup();
  }
});

test('gs snapshot reports a missing file instead of throwing', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seedProfile(h.home);
    const code = await snapshotCommand({
      home: h.home,
      subcommand: 'import',
      target: path.join(h.home, 'nope.gsnap'),
      force: true,
      logger: loggerFor(out),
    });
    assert.equal(code, 2);
    assert.match(out.text(), /cannot read/);
  } finally {
    await h.cleanup();
  }
});

test('gs snapshot rejects an unknown subcommand', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seedProfile(h.home);
    const code = await snapshotCommand({ home: h.home, subcommand: 'zip', target: undefined, logger: loggerFor(out) });
    assert.equal(code, 2);
    assert.match(out.text(), /usage: gs snapshot/);
  } finally {
    await h.cleanup();
  }
});
