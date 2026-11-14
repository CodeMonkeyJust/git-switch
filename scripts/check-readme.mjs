/**
 * Keep README.md and README.zh-CN.md in step.
 *
 * The Chinese README drifted once already: it was missing the Commands table,
 * the `gs gui` section and the technical-choices section while the English one
 * had them. Comparing the section skeleton catches that drift without demanding
 * a literal translation.
 */
import { readFile } from 'node:fs/promises';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

const en = await readFile('README.md', 'utf8');
const zh = await readFile('README.zh-CN.md', 'utf8');

const headings = (text) => [...text.matchAll(/^(#{1,3})\s+(.+)$/gm)].map((m) => (m[1] ?? '').length);
const enLevels = headings(en);
const zhLevels = headings(zh);

check(
  'both READMEs have the same number of sections',
  enLevels.length === zhLevels.length,
  `en=${enLevels.length} zh=${zhLevels.length}`,
);

check(
  'both READMEs have the same heading levels',
  enLevels.join(',') === zhLevels.join(','),
  `en=${enLevels.join(',')} zh=${zhLevels.join(',')}`,
);

// every code fence must be balanced, or the page renders broken
for (const [name, text] of [
  ['README.md', en],
  ['README.zh-CN.md', zh],
]) {
  const fences = (text.match(/^```/gm) ?? []).length;
  check(`${name} has balanced code fences`, fences % 2 === 0, `${fences} fences`);
}

check('README.md links to the Chinese version', /README\.zh-CN\.md/.test(en));
check('README.zh-CN.md links back to the English version', /\(README\.md\)/.test(zh));

// both must document the same command surface
const commands = ['gs init', 'gs list', 'gs diff', 'gs apply', 'gs doctor', 'gs gui', 'gs key', 'gs snapshot'];
for (const command of commands) {
  check(`README.md documents \`${command}\``, en.includes(command));
  check(`README.zh-CN.md documents \`${command}\``, zh.includes(command));
}

// the field that broke pushes must be explained in both
check('README.md explains sshHostName', en.includes('sshHostName'));
check('README.zh-CN.md explains sshHostName', zh.includes('sshHostName'));

/*
 * Every user-facing document must exist in both languages, and each pair must
 * link to its counterpart — otherwise a reader lands in the wrong language with
 * no way back.
 */
const DOC_PAIRS = [
  ['README.md', 'README.zh-CN.md'],
  ['CONTRIBUTING.md', 'CONTRIBUTING.zh-CN.md'],
  ['SECURITY.md', 'SECURITY.zh-CN.md'],
  ['docs/architecture.md', 'docs/architecture.zh-CN.md'],
  ['docs/profiles-schema.md', 'docs/profiles-schema.zh-CN.md'],
];

for (const [englishPath, chinesePath] of DOC_PAIRS) {
  let english;
  let chinese;
  try {
    english = await readFile(englishPath, 'utf8');
    chinese = await readFile(chinesePath, 'utf8');
  } catch {
    check(`${chinesePath} exists`, false, 'missing');
    continue;
  }

  const chineseName = chinesePath.split('/').pop();
  const englishName = englishPath.split('/').pop();
  check(`${englishPath} links to ${chineseName}`, english.includes(chineseName));
  check(`${chinesePath} links back to ${englishName}`, chinese.includes(`(${englishName})`));

  // a Chinese document must actually be Chinese, not an English stub
  const cjk = (chinese.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  check(`${chinesePath} is translated`, cjk > 100, `${cjk} CJK characters`);

  const enFences = (english.match(/^```/gm) ?? []).length;
  const zhFences = (chinese.match(/^```/gm) ?? []).length;
  check(`${chinesePath} has balanced code fences`, zhFences % 2 === 0, `${zhFences} fences`);
  check(
    `${englishPath} and ${chinesePath} have the same number of code blocks`,
    enFences === zhFences,
    `en=${enFences} zh=${zhFences}`,
  );
}

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('bilingual READMEs are in step');
}
