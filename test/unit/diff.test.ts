import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff } from '../../src/util/diff.ts';

/**
 * `unifiedDiff` renders every change the user approves before writing, so a bug
 * here means approving something different from what lands on disk.
 */

test('identical input produces no diff', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n'), '');
  assert.equal(unifiedDiff('', ''), '');
});

test('an addition is marked with +', () => {
  const diff = unifiedDiff('a\n', 'a\nb\n');
  assert.match(diff, /^\+b$/m);
});

test('a removal is marked with -', () => {
  const diff = unifiedDiff('a\nb\n', 'a\n');
  assert.match(diff, /^-b$/m);
});

test('unchanged context lines are marked with a space', () => {
  const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');
  const after = before.replace('5', 'five');
  const diff = unifiedDiff(before, after, { context: 2 });
  assert.match(diff, /^-5$/m);
  assert.match(diff, /^\+five$/m);
  assert.match(diff, /^ 4$/m, 'context line before the change');
  assert.match(diff, /^ 6$/m, 'context line after the change');
});

test('CRLF input is normalised so the diff does not show phantom changes', () => {
  // a file whose only difference is line endings must not appear changed
  assert.equal(unifiedDiff('a\r\nb\r\n', 'a\nb\n'), '');
});

test('a trailing newline difference is not reported as a content change', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb'), '');
});

test('large inputs fall back to a whole-file replacement without throwing', () => {
  const before = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n');
  const after = Array.from({ length: 2500 }, (_, i) => `other ${i}`).join('\n');
  const diff = unifiedDiff(before, after);
  assert.ok(diff.length > 0);
  assert.match(diff, /^-line 0$/m);
  assert.match(diff, /^\+other 0$/m);
});

test('the output is capped for very large diffs', () => {
  const before = Array.from({ length: 1000 }, (_, i) => `a${i}`).join('\n');
  const after = Array.from({ length: 1000 }, (_, i) => `b${i}`).join('\n');
  const diff = unifiedDiff(before, after, { maxLines: 20 });
  assert.match(diff, /omitted/);
  assert.ok(diff.split('\n').length <= 40, 'the output stays near the cap');
});

test('truncating a whole-file rewrite keeps BOTH removals and additions', () => {
  // A naive head-slice shows only the deletions: the user would approve changes
  // they never saw. Both kinds of change must survive the cap.
  const before = Array.from({ length: 1000 }, (_, i) => `old${i}`).join('\n');
  const after = Array.from({ length: 1000 }, (_, i) => `new${i}`).join('\n');
  const diff = unifiedDiff(before, after, { maxLines: 20 });

  assert.match(diff, /^-old0$/m, 'removals are shown');
  assert.match(diff, /^\+new0$/m, 'additions are shown');
  const removed = diff.split('\n').filter((l) => l.startsWith('-')).length;
  const added = diff.split('\n').filter((l) => l.startsWith('+')).length;
  assert.ok(removed > 0 && added > 0, `both sides present (removed=${removed}, added=${added})`);
});

test('a moderately large diff drops context before dropping changes', () => {
  const before = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n');
  const after = before.replace('line10', 'CHANGED').replace('line50', 'ALSO_CHANGED');
  const diff = unifiedDiff(before, after, { context: 5, maxLines: 10 });
  assert.match(diff, /^-line10$/m);
  assert.match(diff, /^-line50$/m, 'both changes survive');
  assert.match(diff, /context lines omitted|lines omitted/);
});

test('inserting a block shows only the new lines and nearby context', () => {
  const before = ['header', 'a', 'b', 'c', 'd', 'e', 'footer'].join('\n');
  const after = ['header', 'a', 'b', 'NEW1', 'NEW2', 'c', 'd', 'e', 'footer'].join('\n');
  const diff = unifiedDiff(before, after, { context: 3 });
  assert.match(diff, /^\+NEW1$/m);
  assert.match(diff, /^\+NEW2$/m);
  assert.ok(!/^-/.test(diff), 'a pure insertion has no removed lines');
});

test('a change far from other changes is split into separate hunks', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n');
  const after = before.replace('line1', 'CHANGED_TOP').replace('line38', 'CHANGED_BOTTOM');
  const diff = unifiedDiff(before, after, { context: 2 });
  assert.match(diff, /^-line1$/m);
  assert.match(diff, /^-line38$/m);
  // the untouched middle must not be printed
  assert.ok(!/line20/.test(diff), 'distant context is elided');
});

test('empty to non-empty marks every line as added', () => {
  const diff = unifiedDiff('', 'x\ny\n');
  assert.match(diff, /^\+x$/m);
  assert.match(diff, /^\+y$/m);
});

test('non-empty to empty marks every line as removed', () => {
  const diff = unifiedDiff('x\ny\n', '');
  assert.match(diff, /^-x$/m);
  assert.match(diff, /^-y$/m);
});
