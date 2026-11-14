import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  t,
  setLanguage,
  getLanguage,
  parseLanguage,
  resolveLanguage,
  catalogueKeys,
  webCatalogue,
  SUPPORTED_LANGUAGES,
} from '../../src/core/i18n.ts';

/**
 * The CLI and GUI both speak English and Simplified Chinese. These tests keep the
 * two catalogues in step and pin the language-resolution order, so a missing
 * translation or a broken `--lang` shows up here rather than in the UI.
 */

test('parseLanguage understands the usual tag shapes', () => {
  assert.equal(parseLanguage('en'), 'en');
  assert.equal(parseLanguage('en-US'), 'en');
  assert.equal(parseLanguage('EN_us'), 'en');
  assert.equal(parseLanguage('zh'), 'zh-CN');
  assert.equal(parseLanguage('zh-CN'), 'zh-CN');
  assert.equal(parseLanguage('zh_CN'), 'zh-CN');
  assert.equal(parseLanguage('zh-Hans'), 'zh-CN');
  assert.equal(parseLanguage(''), undefined);
  assert.equal(parseLanguage(undefined), undefined);
});

test('languages without a catalogue fall back to English, not to the OS language', () => {
  // A user asking for Japanese must get English; silently showing the system
  // language instead would look like the flag was ignored.
  for (const tag of ['ja', 'ja-JP', 'ko', 'de-DE', 'fr', 'ru', 'ar', 'pt-BR', 'es']) {
    assert.equal(parseLanguage(tag), 'en', `${tag} should resolve to en`);
  }
});

test('traditional Chinese falls back to English rather than simplified', () => {
  // zh-TW / zh-HK users would otherwise be shown simplified text they did not ask for
  assert.equal(parseLanguage('zh-TW'), 'en');
  assert.equal(parseLanguage('zh-HK'), 'en');
  assert.equal(parseLanguage('zh-Hant'), 'en');
  // simplified variants do map to the zh-CN catalogue
  for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-MY', 'zh-Hans']) {
    assert.equal(parseLanguage(tag), 'zh-CN', `${tag} should resolve to zh-CN`);
  }
});

test('a malformed tag has no opinion and falls through', () => {
  for (const tag of ['', '   ', '123', 'x', 'zh-CN-extra-bits!!!']) {
    assert.equal(parseLanguage(tag), undefined, `${JSON.stringify(tag)} should be ignored`);
  }
});

test('translate substitutes positional placeholders', () => {
  setLanguage('en');
  assert.match(t('doctor.summary', 3, 2, 1), /3 ok · 2 warnings · 1 errors/);
  setLanguage('zh-CN');
  assert.match(t('doctor.summary', 3, 2, 1), /3 项正常 · 2 项警告 · 1 项错误/);
  setLanguage('en');
});

test('both catalogues define exactly the same keys', () => {
  const en = new Set(catalogueKeys('en'));
  const zh = new Set(catalogueKeys('zh-CN'));
  const missing = [...en].filter((k) => !zh.has(k));
  const extra = [...zh].filter((k) => !en.has(k));
  assert.deepEqual(missing, [], `keys missing from zh-CN: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `keys only in zh-CN: ${extra.join(', ')}`);
});

test('every translation is non-empty and keeps its placeholders', () => {
  const placeholders = (value: string) => (value.match(/\{\d+\}/g) ?? []).sort();
  for (const key of catalogueKeys('en')) {
    const english = t.call(null, key);
    void english;
    setLanguage('en');
    const en = t(key);
    setLanguage('zh-CN');
    const zh = t(key);
    setLanguage('en');

    assert.ok(en.trim() !== '', `en:${key} is empty`);
    assert.ok(zh.trim() !== '', `zh-CN:${key} is empty`);
    assert.deepEqual(
      placeholders(zh),
      placeholders(en),
      `placeholders differ for ${key}: en=${placeholders(en).join(',')} zh=${placeholders(zh).join(',')}`,
    );
  }
});

test('a missing key falls back to the key itself instead of throwing', () => {
  setLanguage('zh-CN');
  assert.equal(t('does.not.exist'), 'does.not.exist');
  setLanguage('en');
});

test('--lang wins over GS_LANG, which wins over the system locale', () => {
  const original = process.env.GS_LANG;
  try {
    process.env.GS_LANG = 'zh-CN';
    assert.equal(resolveLanguage('en'), 'en', 'explicit flag beats the environment');
    assert.equal(resolveLanguage(), 'zh-CN', 'the environment beats the system locale');

    // an unsupported GS_LANG resolves to English rather than leaking the OS one
    process.env.GS_LANG = 'ja-JP';
    assert.equal(resolveLanguage(), 'en');

    delete process.env.GS_LANG;
    const detected = resolveLanguage();
    assert.ok(SUPPORTED_LANGUAGES.includes(detected));
  } finally {
    if (original === undefined) delete process.env.GS_LANG;
    else process.env.GS_LANG = original;
  }
});

test('the system language is detected without any environment variable', () => {
  const saved = { GS_LANG: process.env.GS_LANG, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
  try {
    delete process.env.GS_LANG;
    delete process.env.LANG;
    delete process.env.LC_ALL;
    const detected = resolveLanguage();
    assert.ok(SUPPORTED_LANGUAGES.includes(detected), `unexpected system language ${detected}`);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('setLanguage changes what the next lookup returns', () => {
  setLanguage('en');
  assert.equal(getLanguage(), 'en');
  const english = t('list.identities');

  setLanguage('zh-CN');
  assert.equal(getLanguage(), 'zh-CN');
  const chinese = t('list.identities');

  assert.notEqual(english, chinese);
  assert.match(chinese, /[\u4e00-\u9fa5]/, 'the Chinese catalogue really is Chinese');
  setLanguage('en');
});

test('the web catalogue carries only UI strings', () => {
  const web = webCatalogue();
  const keys = Object.keys(web);
  assert.ok(keys.length > 0);
  assert.ok(
    keys.every((k) => k.startsWith('web.')),
    `non-UI keys leaked into the browser payload: ${keys.filter((k) => !k.startsWith('web.')).join(', ')}`,
  );
  // phrases that merely mention private keys must not travel to the browser
  assert.ok(
    !Object.values(web).some((v) => v.includes('PRIVATE KEY')),
    'no API payload should contain key-material phrasing',
  );
});

test('Chinese translations contain CJK text', () => {
  setLanguage('zh-CN');
  const samples = ['init.detected', 'list.identities', 'web.tab.overview', 'doctor.authenticated'];
  for (const key of samples) {
    assert.match(t(key), /[\u4e00-\u9fa5]/, `${key} is not translated`);
  }
  setLanguage('en');
});
