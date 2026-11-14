/**
 * Render the reworked identity and rules screens against the DOM shim and check
 * that every control carries a visible label and that the add-form order is
 * directory → identity (for rules) and identity → key → site (for identities).
 */
import { installDom } from '../test/helpers/dom-shim.mjs';
import { webCatalogue, setLanguage } from '../src/core/i18n.ts';

setLanguage('zh-CN');
const ZH = webCatalogue();

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

function fakeFetch(routes) {
  globalThis.fetch = async (url, init) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? routes[key] : { error: 'not found' };
    return { ok: key !== undefined, status: key ? 200 : 404, statusText: 'x', json: async () => body };
  };
}

const STATE = {
  home: '~',
  homePath: '/home/u',
  isSandbox: true,
  language: 'zh-CN',
  messages: ZH,
  profileExists: true,
  profilePath: '~/.config/gs/profiles.yaml',
  identities: [
    { name: 'github', email: 'me@x.com', userName: 'me', sshKey: 'id_gh', sites: [{ host: 'github.com', port: 443, alias: 'github' }] },
    { name: 'gitee', email: 'me@x.com', userName: 'me', sshKey: null, sites: [] },
  ],
  rules: [{ dir: '/code/github', identity: 'github' }],
  repositories: [],
};

const KEYS = { keys: [{ name: 'id_gh', type: 'ED25519', fingerprint: 'SHA256:abc', comment: null, hasPublic: true, usedBy: ['github'] }] };

const { setMessages } = await import('../web/src/i18n.js');
setMessages(ZH, 'zh-CN');

/* ---------------- identities ---------------- */
{
  const dom = installDom();
  fakeFetch({ '/api/state': STATE, '/api/keys': KEYS });
  const { renderIdentities } = await import('../web/src/views/identities.js');
  await renderIdentities(dom.main, { state: undefined, goto() {}, toast() {} });

  const text = dom.main.textContent;
  check('identities screen renders', text.includes('身份'));
  check('card shows labelled fields', text.includes('提交者名称') && text.includes('主机'));

  const labels = dom.main.querySelectorAll('.field-label').map((n) => n.textContent);
  check('add form has a label for name', labels.some((l) => l.startsWith('名称')), labels.join('|'));
  check('add form has a label for email', labels.some((l) => l.startsWith('提交邮箱')), labels.join('|'));
  check('add form has a label for ssh key', labels.some((l) => l.startsWith('SSH 密钥')), labels.join('|'));
  check('add form has a label for host', labels.some((l) => l.startsWith('主机')), labels.join('|'));

  const selects = dom.main.querySelectorAll('select');
  check('SSH key is a select, not free text', selects.length >= 1, `${selects.length} selects`);
  const keyOptions = selects[0]?.children.map((o) => o.textContent) ?? [];
  check('the key select lists existing keys', keyOptions.includes('id_gh'), keyOptions.join('|'));
  check('the key select offers a "no key" option', keyOptions.some((o) => o.includes('不指定密钥')), keyOptions.join('|'));

  check('required fields are marked', dom.main.querySelectorAll('.req').length >= 3);
}

/* ---------------- rules ---------------- */
{
  const dom = installDom();
  fakeFetch({ '/api/state': STATE, '/api/fs': { dir: '/code', roots: ['/home/u'], entries: [] } });
  const { renderRules } = await import('../web/src/views/rules.js');
  await renderRules(dom.main, { state: undefined, goto() {}, toast() {} });

  const labels = dom.main.querySelectorAll('.field-label').map((n) => n.textContent);
  check('rules form labels the directory', labels.some((l) => l.startsWith('目录')), labels.join('|'));
  check('rules form labels the identity', labels.some((l) => l.startsWith('身份')), labels.join('|'));

  const legends = dom.main.querySelectorAll('.field-group').map((f) => f.children[0]?.textContent);
  check(
    'directory group comes before the identity assignment',
    legends.length === 2 && legends[0] === '目标目录' && legends[1] === '指定身份',
    legends.join('|'),
  );

  // the existing-rule select is disabled; the add form's is the enabled one
  const addSelect = dom.main
    .querySelectorAll('select')
    .find((s) => s.attributes.disabled === undefined);
  const options = addSelect?.children.map((o) => o.textContent) ?? [];
  check('identity is chosen from a dropdown', options.length >= 2, options.join('|'));
  check('dropdown starts on a placeholder', options[0]?.includes('请选择'), options.join('|'));
}

/* ---------------- tab order ---------------- */
{
  const { readFile } = await import('node:fs/promises');
  const html = await readFile('web/index.html', 'utf8');
  const order = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);

  // A key is a prerequisite for an identity, which is a prerequisite for a rule.
  check(
    'Keys comes before Identities in the tab bar',
    order.indexOf('keys') < order.indexOf('identities'),
    order.join(' > '),
  );
  check(
    'Identities comes before Rules',
    order.indexOf('identities') < order.indexOf('rules'),
    order.join(' > '),
  );
  check(
    'Rules comes before Preview (apply needs something to apply)',
    order.indexOf('rules') < order.indexOf('preview'),
    order.join(' > '),
  );
  check('every screen has a tab', ['overview', 'keys', 'identities', 'rules', 'preview', 'doctor', 'snapshot', 'init'].every((v) => order.includes(v)), order.join(' > '));
}

/* ---------------- missing-key guidance ---------------- */
{
  const dom = installDom();
  fakeFetch({ '/api/state': { ...STATE, identities: [], rules: [] }, '/api/keys': { keys: [] } });
  const { renderIdentities } = await import('../web/src/views/identities.js');
  let went = null;
  await renderIdentities(dom.main, {
    state: undefined,
    goto: (v) => {
      went = v;
    },
    toast() {},
  });

  check(
    'identities screen warns when no key exists',
    dom.main.textContent.includes('还没有任何 SSH 密钥') || dom.main.textContent.includes('No SSH keys exist'),
    dom.main.textContent.slice(0, 160),
  );
  const goButton = dom.main.querySelectorAll('button').find((b) => /前往密钥页|Go to Keys/.test(b.textContent));
  check('it offers a shortcut to the Keys screen', Boolean(goButton));
  goButton?.dispatchEvent({ type: 'click', target: goButton });
  check('the shortcut navigates to keys', went === 'keys', String(went));
}

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('UI labels and ordering verified');
}
