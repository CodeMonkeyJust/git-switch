/**
 * GUI localisation.
 *
 * The server sends the active catalogue with `/api/state`, so switching the
 * language once (`gs gui --lang zh-CN`, or GS_LANG) covers the browser too.
 * Every lookup falls back to English and then to the key, so a missing entry
 * shows something instead of throwing.
 */

let messages = {};
let language = 'en';

export function setMessages(catalogue, lang) {
  if (catalogue && typeof catalogue === 'object') messages = catalogue;
  if (typeof lang === 'string') language = lang;
}

export function getLanguage() {
  return language;
}

/** Translate `key`, substituting `{0}`, `{1}`, … */
export function t(key, ...args) {
  let template = messages[key] ?? key;
  args.forEach((value, index) => {
    template = template.split(`{${index}}`).join(String(value));
  });
  return template;
}

/** Apply translations to elements marked with data-i18n / data-i18n-title. */
export function applyStaticTranslations(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n');
    if (key) node.textContent = t(key);
  }
  for (const node of root.querySelectorAll('[data-i18n-title]')) {
    const key = node.getAttribute('data-i18n-title');
    if (key) node.setAttribute('title', t(key));
  }
}
