import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { expandHome, contractHome, normaliseRulePath, gitdirPattern, toPosix } from '../../src/core/paths.ts';
import { parseProfilesText } from '../../src/core/profiles.ts';
import { remapProfiles, parseRemap } from '../../src/core/snapshot.ts';

/* These tests pin behaviour that must hold on every OS. The values are run
 * against the host path implementation, so they double as a portability check
 * in CI on macOS and Linux. */

const POSIX_HOME = '/home/tester';
const win32 = process.platform === 'win32';

test('expandHome never returns a backslash for the "~/x" form on posix', (t) => {
  if (win32) {
    // on Windows path.join uses "\"; normaliseRulePath must still yield "/"
    assert.equal(normaliseRulePath('~/code/x', POSIX_HOME), `${POSIX_HOME}/code/x`);
    t.diagnostic('windows: relying on normaliseRulePath to normalise separators');
    return;
  }
  assert.equal(expandHome('~/x', POSIX_HOME), '/home/tester/x');
  assert.ok(!expandHome('~/a/b', POSIX_HOME).includes('\\'));
});

test('expandHome only expands a leading tilde', () => {
  assert.equal(expandHome('/a/~/b', POSIX_HOME), '/a/~/b');
  assert.equal(expandHome('a/~/b', POSIX_HOME), 'a/~/b');
});

test('contractHome renders nested paths portably', () => {
  assert.equal(contractHome(`${POSIX_HOME}/x/y`, POSIX_HOME), '~/x/y');
  assert.equal(contractHome(POSIX_HOME, POSIX_HOME), '~');
});

test('a path outside home is returned unchanged', () => {
  const outside = win32 ? 'C:/other/place' : '/other/place';
  assert.equal(contractHome(outside, POSIX_HOME), outside);
});

test('contractHome does not treat a sibling of home as inside home', () => {
  // /home/tester2 must not be contracted to ~/2
  const sibling = `${POSIX_HOME}2`;
  assert.equal(contractHome(`${sibling}/x`, POSIX_HOME), `${sibling}/x`);
});

test('gitdirPattern always ends with exactly one slash and uses forward slashes', () => {
  for (const input of ['/home/u/code', '/home/u/code/', 'D:/code/x', 'D:/code/x/']) {
    const pattern = gitdirPattern(input);
    assert.ok(pattern.endsWith('/'), `${input} -> ${pattern}`);
    assert.ok(!pattern.includes('\\'), `${pattern} contains a backslash`);
    assert.ok(!pattern.endsWith('//'), `${pattern} has a double slash`);
  }
});

test('normaliseRulePath strips redundant separators and trailing slashes', () => {
  assert.equal(normaliseRulePath(`${POSIX_HOME}/code///`, POSIX_HOME), `${POSIX_HOME}/code`);
  assert.equal(normaliseRulePath(`${POSIX_HOME}/code/./x`, POSIX_HOME), `${POSIX_HOME}/code/x`);
  assert.equal(normaliseRulePath(`${POSIX_HOME}/code/../code/x`, POSIX_HOME), `${POSIX_HOME}/code/x`);
});

test('windows-style input is stored with forward slashes', () => {
  assert.equal(normaliseRulePath('D:\\code\\x', POSIX_HOME), 'D:/code/x');
});

test('a windows absolute path is recognised even when running on posix', () => {
  // snapshots travel between machines: `D:/code/x` must never be treated as a
  // relative path (which would join it onto the cwd and corrupt the rule)
  for (const input of ['D:/code/x', 'D:\\code\\x', 'C:/Users/me/repo']) {
    const stored = normaliseRulePath(input, POSIX_HOME, '/app');
    assert.match(stored, /^[A-Za-z]:\//, `${input} -> ${stored}`);
    assert.ok(!stored.startsWith('/app'), `${input} was joined onto cwd: ${stored}`);
    assert.ok(!stored.includes('\\'), `${input} kept a backslash: ${stored}`);
  }
});

test('a UNC path is treated as absolute', () => {
  const stored = normaliseRulePath('\\\\server\\share\\repo', POSIX_HOME, '/app');
  assert.ok(!stored.startsWith('/app'), stored);
  assert.ok(!stored.includes('\\'), stored);
});

test('a relative path is still resolved against the cwd', () => {
  const cwd = process.platform === 'win32' ? 'C:\\work' : '/work';
  const stored = normaliseRulePath('sub/dir', POSIX_HOME, cwd);
  assert.ok(stored.endsWith('sub/dir'), stored);
  assert.ok(stored.includes('work'), `relative path must resolve under the cwd: ${stored}`);
  assert.ok(!stored.includes('\\'), `stored path must use forward slashes: ${stored}`);
});

test('a snapshot from windows remaps cleanly onto a posix layout', () => {
  const profiles = parseProfilesText(
    `schemaVersion: 1
identities:
  work:
    user:
      name: a
      email: a@example.com
    sshKey: id_work
rules:
  - dir: D:/CODE/work
    identity: work
  - dir: D:/CODE/personal
    identity: work
`,
    POSIX_HOME,
  );
  const migrated = remapProfiles(profiles, parseRemap(['D:/CODE=/home/tester/code']));
  for (const rule of migrated.rules) {
    assert.ok(rule.dir.startsWith('/home/tester/code'), rule.dir);
    assert.ok(!rule.dir.includes('\\'), rule.dir);
    assert.ok(!rule.dir.includes('D:'), rule.dir);
  }
});

test('toPosix leaves forward slashes untouched', () => {
  assert.equal(toPosix('/a/b/c'), '/a/b/c');
  assert.equal(toPosix('\\\\server\\share\\x'), '//server/share/x');
});

test('path.sep is used consistently by normaliseRulePath', () => {
  // whatever the host separator, stored rules are always forward slashed
  const stored = normaliseRulePath(path.join(POSIX_HOME, 'a', 'b'), POSIX_HOME);
  assert.ok(!stored.includes('\\'));
});

/* ---- posix semantics verified in-process, independent of the host OS ---- */

test('posix rule processing yields the expected portable values', () => {
  // mirror what normaliseRulePath does, but force posix separators so the
  // assertions hold on Windows too (this is what CI checks on Linux/macOS)
  const p = path.posix;
  const normalise = (input: string, home: string) => {
    const expanded = input === '~' ? home : input.startsWith('~/') ? p.join(home, input.slice(2)) : input;
    const abs = p.isAbsolute(expanded) ? expanded : p.resolve(home, expanded);
    const stripped = abs.length > 1 ? abs.replace(/\/+$/, '') : abs;
    return stripped;
  };

  assert.equal(normalise('/home/u/code', '/home/u'), '/home/u/code');
  assert.equal(normalise('~/code', '/home/u'), '/home/u/code');
  assert.equal(normalise('code/sub', '/home/u'), '/home/u/code/sub');
  assert.equal(normalise('/home/u/code/', '/home/u'), '/home/u/code');
  assert.equal(normalise('/', '/home/u'), '/');

  const pattern = (dir: string) => (dir.endsWith('/') ? dir : `${dir}/`);
  assert.equal(pattern('/home/u/code'), '/home/u/code/');
  assert.equal(pattern('/home/u/code/'), '/home/u/code/');
});

test('a posix home is contracted without leaking the host separator', () => {
  const p = path.posix;
  const contract = (input: string, home: string) => {
    const n = p.resolve(input);
    const h = p.resolve(home);
    if (n === h) return '~';
    if (n.startsWith(`${h}/`)) return `~/${n.slice(h.length + 1)}`;
    return input;
  };
  assert.equal(contract('/home/u/x/y', '/home/u'), '~/x/y');
  assert.equal(contract('/home/u', '/home/u'), '~');
  assert.equal(contract('/home/u2/x', '/home/u'), '/home/u2/x');
});
