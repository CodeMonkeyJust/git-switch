import { api, hasToken } from './api.js';
import { setMessages, applyStaticTranslations, t, getLanguage } from './i18n.js';
import { renderOverview } from './views/overview.js';
import { renderIdentities } from './views/identities.js';
import { renderRules } from './views/rules.js';
import { renderPreview } from './views/preview.js';
import { renderDoctor } from './views/doctor.js';
import { renderKeys } from './views/keys.js';
import { renderSnapshot } from './views/snapshot.js';
import { renderInit } from './views/init.js';

const VIEWS = {
  overview: renderOverview,
  identities: renderIdentities,
  rules: renderRules,
  keys: renderKeys,
  snapshot: renderSnapshot,
  preview: renderPreview,
  doctor: renderDoctor,
  init: renderInit,
};

const LANGUAGES = ['en', 'zh-CN'];

/** Re-label the tab bar and the language picker in the active language. */
function translateChrome() {
  applyStaticTranslations(document);
  for (const tab of document.querySelectorAll('.tab')) {
    const view = tab.dataset.view;
    if (view) tab.textContent = t(`web.tab.${view}`);
  }
  document.title = t('web.title');
  const select = document.getElementById('language');
  if (select) {
    select.value = getLanguage();
    select.setAttribute('aria-label', t('web.language'));
  }
}

const app = {
  state: undefined,
  current: 'overview',

  /** Pull state (and with it the catalogue) for the active language. */
  async refreshState(lang) {
    const state = await api.state(undefined, lang ?? getLanguage());
    setMessages(state.messages, state.language);
    this.state = state;
    translateChrome();
    return state;
  },

  async goto(view) {
    this.current = view;
    for (const tab of document.querySelectorAll('.tab')) {
      tab.setAttribute('aria-selected', String(tab.dataset.view === view));
    }
    const main = document.getElementById('main');
    main.replaceChildren();
    try {
      await VIEWS[view](main, this);
    } catch (err) {
      main.replaceChildren(
        Object.assign(document.createElement('div'), {
          className: 'notice error',
          textContent: err.message,
        }),
      );
    }
  },

  toast(message, level = 'ok') {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = `status ${level}`;
    clearTimeout(app._toastTimer);
    app._toastTimer = setTimeout(() => {
      status.textContent = '';
      status.className = 'status';
    }, 6000);
  },
};

async function boot() {
  if (!hasToken()) {
    document.getElementById('main').replaceChildren(
      Object.assign(document.createElement('div'), {
        className: 'notice error',
        textContent: t('web.missingToken'),
      }),
    );
    return;
  }

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => app.goto(tab.dataset.view));
  }

  // language picker: switching re-fetches the catalogue and re-renders in place
  const language = document.getElementById('language');
  if (language) {
    for (const code of LANGUAGES) {
      language.append(
        Object.assign(document.createElement('option'), { value: code, textContent: code }),
      );
    }
    language.addEventListener('change', async () => {
      try {
        await app.refreshState(language.value);
        await app.goto(app.current);
      } catch (err) {
        app.toast(err.message, 'error');
      }
    });
  }

  try {
    const state = await app.refreshState();
    document.getElementById('status').textContent = t(
      'web.counts',
      state.identities.length,
      state.rules.length,
      state.repositories.length,
    );
  } catch (err) {
    document.getElementById('status').textContent = err.message;
    document.getElementById('status').className = 'status error';
  }

  await app.goto('overview');
}

boot();
