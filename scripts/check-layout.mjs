/**
 * Layout regression checks.
 *
 * The rules screen once rendered a path one character per line: `.path` was a
 * flex child (so `min-width:auto` kept it at content width) with
 * `overflow-wrap:anywhere` (so every character was a break opportunity). The DOM
 * shim cannot compute layout, so this asserts the CSS rules that prevent it.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

const css = await readFile(path.resolve('web/src/styles/main.css'), 'utf8');

/** Extract a rule body by selector. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g');
  const bodies = [...css.matchAll(re)].map((m) => m[1]);
  return bodies.join('\n');
}

const pathRule = rule('.path');
check('.path allows shrinking (min-width: 0)', /min-width:\s*0\b/.test(pathRule), pathRule.trim());
check('.path does not wrap per character', !/overflow-wrap:\s*anywhere/.test(pathRule), pathRule.trim());
check('.path truncates with an ellipsis', /text-overflow:\s*ellipsis/.test(pathRule), pathRule.trim());
check('.path stays on one line', /white-space:\s*nowrap/.test(pathRule), pathRule.trim());

const selectInRow = rule('.row > select.input');
check(
  'a select inside a row does not claim the full width',
  /width:\s*auto/.test(selectInRow),
  selectInRow.trim(),
);

const selectInField = rule('.field > .input');
check(
  'a control inside a labelled field still fills it',
  /width:\s*100%/.test(selectInField),
  selectInField.trim(),
);

const kvValue = rule('.kv-value');
check('.kv-value allows shrinking', /min-width:\s*0\b/.test(kvValue), kvValue.trim());

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('layout rules verified');
}
