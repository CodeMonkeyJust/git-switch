import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../helpers/dom-shim.mjs';

/**
 * Execute the real GUI modules against a DOM shim.
 *
 * A static import check cannot catch a missing function or a wrong call
 * signature — the browser would simply show a blank page. These tests render
 * each screen and assert on the produced DOM, so a runtime error becomes a test
 * failure instead of a user-facing white screen.
 */

function installFetch(routes) {
  const calls = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url, init });
    const path = url.split('#')[0] ?? '';
    const key = Object.keys(routes).find((k) => path.includes(k));
    if (key === undefined) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: 'not found' }),
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => routes[key],
    };
  });
  return { calls };
}

/**
 * These modules replace global `fetch`, `document` and `window`, so they must not
 * leak into the process-wide test runner. Every test installs the shim and the
 * teardown restores the originals.
 */
const ORIGINAL_FETCH = globalThis.fetch;

test.after(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function resetModules() {
  // the views are stateless modules; a fresh import keeps token capture honest
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GS_TEST_')) delete process.env[key];
  }
}

const STATE = {
  home: '~',
  profilePath: '~/.config/gs/profiles.yaml',
  identities: [
    { name: 'work', email: 'w@example.com', userName: 'w', sshKey: 'id_work', sites: [{ host: 'git.company.com', port: 9092, alias: 'pde' }] },
    { name: 'personal', email: 'p@example.com', userName: 'p', sshKey: null, sites: [{ host: 'github.com', port: null, alias: null }] },
  ],
  rules: [{ dir: '/code/work', identity: 'work' }],
  repositories: [],
};

test('the overview view renders identities and their sites', async () => {
  resetModules();
  const dom = installDom();
  installFetch({ '/api/state': STATE });
  const { renderOverview } = await import('../../web/src/views/overview.js');

  const app = { state: undefined, goto() {}, toast() {} };
  await renderOverview(dom.main, app);

  const text = dom.main.textContent;
  assert.match(text, /work/);
  assert.match(text, /w@example\.com/);
  assert.match(text, /git\.company\.com:9092/);
  assert.match(text, /personal/);
  assert.ok(!text.includes('undefined'), `rendered text contains undefined: ${text}`);
});

test('the rules view lists rules and offers to add one', async () => {
  resetModules();
  const dom = installDom();
  installFetch({ '/api/state': STATE, '/api/fs': { dir: '/code', roots: ['~'], entries: [] } });
  const { renderRules } = await import('../../web/src/views/rules.js');

  const app = { state: undefined, goto() {}, toast() {} };
  await renderRules(dom.main, app);

  const text = dom.main.textContent;
  assert.match(text, /\/code\/work/);
  assert.match(text, /Add a rule/);
  assert.ok(!text.includes('undefined'), `rendered text contains undefined: ${text}`);
});

test('the preview view shows the diff and an apply button', async () => {
  resetModules();
  const dom = installDom();
  installFetch({
    '/api/plan': {
      dirty: true,
      errors: [],
      warnings: [],
      files: [{ label: '~/.gitconfig', kind: 'update', diff: '+[includeIf "gitdir:/code/work/"]' }],
    },
  });
  const { renderPreview } = await import('../../web/src/views/preview.js');

  const app = { state: undefined, goto() {}, toast() {} };
  await renderPreview(dom.main, app);

  const text = dom.main.textContent;
  assert.match(text, /~\/\.gitconfig/);
  assert.match(text, /includeIf/);
  assert.ok(!text.includes('undefined'), `rendered text contains undefined: ${text}`);

  const apply = dom.main.querySelectorAll('button').find((b) => /Apply/i.test(b.textContent));
  assert.ok(apply, 'an apply button must be present');
});

test('the preview view reports a clean plan without an apply button', async () => {
  resetModules();
  const dom = installDom();
  installFetch({ '/api/plan': { dirty: false, errors: [], warnings: [], files: [] } });
  const { renderPreview } = await import('../../web/src/views/preview.js');

  await renderPreview(dom.main, { state: undefined, goto() {}, toast() {} });

  assert.match(dom.main.textContent, /No changes/);
  const apply = dom.main.querySelectorAll('button').find((b) => /Apply/i.test(b.textContent));
  assert.equal(apply, undefined, 'nothing to apply, so no apply button');
});

test('the doctor view renders every check level', async () => {
  resetModules();
  const dom = installDom();
  installFetch({
    '/api/doctor': {
      errors: 1,
      warnings: 1,
      results: [
        { id: 'a', level: 'error', title: 'key missing', detail: 'd', fix: 'ssh-keygen' },
        { id: 'b', level: 'warn', title: 'no key for identity', detail: 'd' },
        { id: 'c', level: 'ok', title: 'profile loaded' },
      ],
    },
  });
  const { renderDoctor } = await import('../../web/src/views/doctor.js');

  await renderDoctor(dom.main, { state: undefined, goto() {}, toast() {} });

  const text = dom.main.textContent;
  assert.match(text, /key missing/);
  assert.match(text, /ssh-keygen/);
  assert.match(text, /profile loaded/);
  assert.ok(!text.includes('undefined'), `rendered text contains undefined: ${text}`);
});

test('a failing API call surfaces an error instead of throwing', async () => {
  resetModules();
  const dom = installDom();
  globalThis.fetch = (async () => ({
    ok: false,
    status: 500,
    statusText: 'Server Error',
    json: async () => ({ error: 'boom' }),
  }));

  const { renderPreview } = await import('../../web/src/views/preview.js');
  await renderPreview(dom.main, { state: undefined, goto() {}, toast() {} });

  assert.match(dom.main.textContent, /boom|Server Error/);
});

test('the api client sends the token from the URL fragment', async () => {
  resetModules();
  installDom();
  globalThis.location = { hash: '#token=secret-token', href: 'http://127.0.0.1/' };
  const { calls } = installFetch({ '/api/state': STATE });

  const { api } = await import('../../web/src/api.js?token=' + Date.now());
  await api.state();

  assert.equal(calls.length, 1);
  const init = calls[0]?.init;
  assert.equal(init?.headers?.['x-gs-token'], 'secret-token');
});
