import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { readGlobalIdentity, formatIdentity } from '../../src/core/paths.ts';
import { listCommand } from '../../src/commands/list.ts';
import { createLogger } from '../../src/util/log.ts';
import { Writable } from 'node:stream';

/**
 * "No rule matched, this falls back to the global identity" is not actionable
 * without naming that identity. A personal repository silently committing with a
 * work address is the exact failure this tool exists to prevent, so the fallback
 * must be stated — both on the console and in the API.
 */

const PROFILE = `schemaVersion: 1
identities:
  personal:
    user:
      name: alexchen
      email: alex@personal.example
    sshKey: id_gh
    sites:
      - host: github.com
rules:
  - dir: /code/github
    identity: personal
`;

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

async function seed(home: string, gitconfig: string): Promise<void> {
  await mkdir(path.join(home, '.config', 'gs'), { recursive: true });
  await writeFile(path.join(home, '.config', 'gs', 'profiles.yaml'), PROFILE, 'utf8');
  await writeFile(path.join(home, '.gitconfig'), gitconfig, 'utf8');
}

test('readGlobalIdentity reads user.name and user.email', async () => {
  const h = await createTmpHome();
  try {
    await seed(h.home, '[user]\n\tname = Alex Chen\n\temail = alex@company.example\n');
    const identity = await readGlobalIdentity(h.home);
    assert.equal(identity?.name, 'Alex Chen');
    assert.equal(identity?.email, 'alex@company.example');
    assert.equal(formatIdentity(identity), 'Alex Chen <alex@company.example>');
  } finally {
    await h.cleanup();
  }
});

test('readGlobalIdentity returns undefined when nothing is set', async () => {
  const h = await createTmpHome();
  try {
    await seed(h.home, '');
    assert.equal(await readGlobalIdentity(h.home), undefined);
  } finally {
    await h.cleanup();
  }
});

test('formatIdentity handles a half-configured identity', () => {
  assert.equal(formatIdentity({ name: 'only-name' }), 'only-name');
  assert.equal(formatIdentity({ email: 'only@example.com' }), 'only@example.com');
  assert.equal(formatIdentity(undefined), undefined);
});

test('gs list names the global identity when no rule matches', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seed(h.home, '[user]\n\tname = Alex Chen\n\temail = alex@company.example\n');
    const elsewhere = path.join(h.home, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });

    await listCommand({
      home: h.home,
      cwd: elsewhere,
      logger: createLogger({ color: false, json: false, unifiedErrors: true, stream: out.stream }),
      json: false,
    });

    const text = out.text();
    assert.match(text, /no matching rule|没有匹配的规则/);
    assert.match(text, /Alex Chen <alex@company\.example>/, `the fallback identity is not named: ${text}`);
  } finally {
    await h.cleanup();
  }
});

test('gs list still prints the global identity when a rule does match', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seed(h.home, '[user]\n\tname = Alex Chen\n\temail = alex@company.example\n');
    const dir = path.join(h.home, 'code', 'github');
    await mkdir(dir, { recursive: true });

    await listCommand({
      home: h.home,
      cwd: dir,
      logger: createLogger({ color: false, json: false, unifiedErrors: true, stream: out.stream }),
      json: false,
    });

    const text = out.text();
    assert.match(text, /directory rule/);
    assert.match(text, /global identity|全局身份/, 'the global identity section is always shown');
    assert.match(text, /Alex Chen <alex@company\.example>/);
  } finally {
    await h.cleanup();
  }
});

test('gs list reports an unset global identity instead of staying silent', async () => {
  const h = await createTmpHome();
  const out = capture();
  try {
    await seed(h.home, '');
    const elsewhere = path.join(h.home, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });

    await listCommand({
      home: h.home,
      cwd: elsewhere,
      logger: createLogger({ color: false, json: false, unifiedErrors: true, stream: out.stream }),
      json: false,
    });

    assert.match(out.text(), /nothing is set|未设置/, out.text());
  } finally {
    await h.cleanup();
  }
});
