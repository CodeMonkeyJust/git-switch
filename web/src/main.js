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

/**
 * Show a broken profile as a banner above every screen.
 *
 * One invalid field (say a site host pasted as a URL) used to make /api/state
 * fail, which left every tab blank with no explanation. The API now degrades to
 * empty data plus `profileError`, and this banner is what the user sees.
 */
function renderProfileError(state) {
  const slot = document.getElementById('profile-error');
  if (!slot) return;
  slot.replaceChildren();
  if (!state?.profileError) return;

  slot.append(
    Object.assign(document.createElement('div'), {
      className: 'notice error',
      textContent: t('web.profileError', state.profileError),
    }),
  );

  const hint = Object.assign(document.createElement('div'), {
    className: 'notice warn',
    textContent: t('web.profileErrorHint', state.profilePath ?? '~/.config/gs/profiles.yaml'),
  });
  slot.append(hint);

  const actions = Object.assign(document.createElement('div'), { className: 'form-actions' });

  // The common failure is a URL pasted into a host field; offer to fix it
  // rather than telling the user to edit YAML they came here to avoid.
  const fix = Object.assign(document.createElement('button'), {
    textContent: t('web.tryFix'),
    className: 'primary',
  });
  fix.addEventListener('click', async () => {
    fix.disabled = true;
    try {
      const preview = await api.repair(false);
      if (preview.ok) {
        window.location.reload();
        return;
      }
      if (!preview.suggestion || preview.suggestion.fixable !== true) {
        slot.append(
          Object.assign(document.createElement('div'), {
            className: 'notice warn',
            textContent: t('web.cannotFix'),
          }),
        );
        return;
      }

      const before = preview.suggestion.problem;
      const after = preview.suggestion.fixed;
      if (!confirm(t('web.confirmFix', before, after))) {
        fix.disabled = false;
        return;
      }

      const done = await api.repair(true);
      if (done.ok) {
        window.location.reload();
      } else {
        slot.append(
          Object.assign(document.createElement('div'), {
            className: 'notice error',
            textContent: done.error ?? t('web.cannotFix'),
          }),
        );
      }
    } catch (err) {
      slot.append(
        Object.assign(document.createElement('div'), {
          className: 'notice error',
          textContent: err.message,
        }),
      );
    }
  });
  actions.append(fix);

  const reload = Object.assign(document.createElement('button'), {
    textContent: t('web.reload'),
  });
  reload.addEventListener('click', () => window.location.reload());
  actions.append(reload);

  // a copyable path is faster than describing where the file lives
  const reveal = Object.assign(document.createElement('button'), {
    textContent: t('web.showFile'),
  });
  reveal.addEventListener('click', () => {
    slot.append(
      Object.assign(document.createElement('div'), {
        className: 'notice ok',
        textContent: state.profilePath ?? '~/.config/gs/profiles.yaml',
      }),
    );
  });
  actions.append(reveal);

  slot.append(actions);
}

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
  renderHomeBanner(app.state);
  renderProfileError(app.state);
}

/**
 * State which home this instance operates on.
 *
 * A GUI started with --home looks identical to the real one. Without this banner
 * a user can spend an hour configuring an identity in a sandbox and wonder why
 * their real ~/.ssh never changed.
 */
function renderHomeBanner(state) {
  const slot = document.getElementById('home-banner');
  if (!slot) return;
  slot.replaceChildren();
  if (!state) return;

  const sandbox = state.isSandbox === true;
  const banner = Object.assign(document.createElement('div'), {
    className: `notice ${sandbox ? 'error' : 'ok'}`,
    textContent: sandbox
      ? t('web.sandboxBanner', state.homePath ?? state.home)
      : t('web.realHomeBanner', state.homePath ?? state.home),
  });
  const dismiss = Object.assign(document.createElement('button'), {
    textContent: t('web.dismiss'),
    className: 'dismiss',
  });
  dismiss.addEventListener('click', () => slot.replaceChildren());
  banner.append(dismiss);
  slot.append(banner);
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
    // the banner lives outside the view container so switching tabs keeps it
    const banner = document.getElementById('home-banner');
    const errorSlot = document.getElementById('profile-error');
    main.replaceChildren();
    if (banner) main.append(banner);
    if (errorSlot) main.append(errorSlot);
    const host = Object.assign(document.createElement('div'), { className: 'view' });
    main.append(host);
    try {
      await VIEWS[view](host, this);
    } catch (err) {
      host.replaceChildren(
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
