import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { createLogger } from '../../src/util/log.ts';
import { listCommand } from '../../src/commands/list.ts';
import { diffCommand } from '../../src/commands/diff.ts';
import { applyCommand } from '../../src/commands/apply.ts';

const posix = (p: string) => p.replace(/\\/g, '/');

/** Collect everything a command writes. */
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

const PROFILE = (home: string) => `schemaVersion: 1
identities:
  work:
    user:
      name: zhulj
      email: work@example.com
    sshKey: id_work
    sites:
      - host: git.company.com
        port: 9092
  personal:
    user:
      name: zlj20
      email: personal@example.com
    sshKey: id_gh
    sites:
      - host: github.com
rules:
  - dir: ${posix(home)}/code/work
    identity: work
  - dir: ${posix(home)}/code/personal
    identity: personal
`;

async function seed(home: string): Promise<void> {
  await mkdir(path.join(home, 'code', 'work'), { recursive: true });
  await mkdir(path.join(home, 'code', 'personal'), { recursive: true });
  await mkdir(path.join(home, '.ssh'), { recursive: true });
  await writeFile(path.join(home, '.config', 'gs', 'profiles.yaml'), '', { flag: 'w' }).catch(async () => {
    await mkdir(path.join(home, '.config', 'gs'), { recursive: true });
  });
  await mkdir(path.join(home, '.config', 'gs'), { recursive: true });
  await writeFile(path.join(home, '.config', 'gs', 'profiles.yaml'), PROFILE(home), 'utf8');
  await writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = g\n\temail = g@example.com\n', 'utf8');
  for (const key of ['id_work', 'id_gh']) {
    await writeFile(
      path.join(home, '.ssh', key),
      '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n',
      'utf8',
    );
  }
}

test('gs list shows identities, rules and the cwd resolution', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seed(h.home);
    const code = await listCommand({
      home: h.home,
      cwd: path.join(h.home, 'code', 'work'),
      logger: loggerFor(out),
      json: false,
    });
    assert.equal(code, 0);

    const text = out.text();
    assert.match(text, /work/);
    assert.match(text, /personal/);
    assert.match(text, /work@example\.com/);
    assert.match(text, /code\/work/);
    assert.match(text, /directory rule/, 'the cwd is attributed to a rule');
  } finally {
    await h.cleanup();
  }
});

test('gs list warns when the cwd matches no rule', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seed(h.home);
    const elsewhere = path.join(h.home, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await listCommand({ home: h.home, cwd: elsewhere, logger: loggerFor(out), json: false });
    assert.match(out.text(), /no matching rule/);
  } finally {
    await h.cleanup();
  }
});

test('gs list --json emits parseable data', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seed(h.home);
    await listCommand({
      home: h.home,
      cwd: path.join(h.home, 'code', 'personal'),
      logger: loggerFor(out, true),
      json: true,
    });
    const data = JSON.parse(out.text()) as {
      identities: { name: string }[];
      rules: { dir: string }[];
      resolved?: { identity: string };
    };
    assert.equal(data.identities.length, 2);
    assert.equal(data.rules.length, 2);
    assert.equal(data.resolved?.identity, 'personal');
  } finally {
    await h.cleanup();
  }
});

test('gs diff previews a pending change without writing', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seed(h.home);
    const code = await diffCommand({ home: h.home, logger: loggerFor(out), json: false });
    assert.equal(code, 0);

    const text = out.text();
    assert.match(text, /gs:managed/, 'the managed block is shown');
    assert.match(text, /includeIf/);
    assert.match(text, /file\(s\) would change/);

    // nothing was written
    const gitconfig = await h.read('.gitconfig');
    assert.ok(!gitconfig.includes('gs:managed'), 'diff must not write');
  } finally {
    await h.cleanup();
  }
});

test('gs diff reports no changes after apply', async () => {
  const h = await createTmpHome();
  try {
    await seed(h.home);
    const applyOut = capture();
    await applyCommand({ home: h.home, logger: loggerFor(applyOut), json: false });

    const diffOut = capture();
    const code = await diffCommand({ home: h.home, logger: loggerFor(diffOut), json: false });
    assert.equal(code, 0);
    assert.match(diffOut.text(), /no changes/);
  } finally {
    await h.cleanup();
  }
});

test('gs diff --json is machine readable and reports the dirty flag', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seed(h.home);
    await diffCommand({ home: h.home, logger: loggerFor(out, true), json: true });
    const data = JSON.parse(out.text()) as { dirty: boolean; files: { file: string; kind: string }[] };
    assert.equal(data.dirty, true);
    assert.ok(data.files.some((f) => f.kind !== 'unchanged'));
  } finally {
    await h.cleanup();
  }
});

test('gs apply then list agree about the resulting identity', async () => {
  const h = await createTmpHome();
  try {
    await seed(h.home);
    await mkdir(path.join(h.home, 'code', 'work', 'repo'), { recursive: true });
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('git', ['init', '-q'], { cwd: path.join(h.home, 'code', 'work', 'repo') });

    const applyOut = capture();
    const code = await applyCommand({ home: h.home, logger: loggerFor(applyOut), json: false });
    assert.equal(code, 0);

    const listOut = capture();
    await listCommand({
      home: h.home,
      cwd: path.join(h.home, 'code', 'work'),
      logger: loggerFor(listOut, true),
      json: true,
    });
    const data = JSON.parse(listOut.text()) as { resolved?: { identity: string } };
    assert.equal(data.resolved?.identity, 'work');
  } finally {
    await h.cleanup();
  }
});
