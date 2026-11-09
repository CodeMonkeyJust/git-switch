import { api, hasToken } from './api.js';
import { setMessages, applyStaticTranslations, t } from './i18n.js';
import { renderOverview } from './views/overview.js';
import { renderRules } from './views/rules.js';
import { renderIdentities } from './views/identities.js';
import { renderPreview } from './views/preview.js';
import { renderDoctor } from './views/doctor.js';

const VIEWS = {
  overview: renderOverview,
  identities: renderIdentities,
  rules: renderRules,
  preview: renderPreview,
  doctor: renderDoctor,
};

/** Re-label the tab bar in the active language. */
function translateChrome() {
  applyStaticTranslations(document);
  for (const tab of document.querySelectorAll('.tab')) {
    const view = tab.dataset.view;
    if (view) tab.textContent = t(`web.tab.${view}`);
  }
  document.title = t('web.title');
}

const app = {
  state: undefined,
  current: 'overview',

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

  // Fetch the catalogue first so the first paint is already localised.
  try {
    const state = await api.state();
    setMessages(state.messages, state.language);
    app.state = state;
    translateChrome();
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
