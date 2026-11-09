import { api, hasToken } from './api.js';
import { renderOverview } from './views/overview.js';
import { renderRules } from './views/rules.js';
import { renderPreview } from './views/preview.js';
import { renderDoctor } from './views/doctor.js';

const VIEWS = {
  overview: renderOverview,
  rules: renderRules,
  preview: renderPreview,
  doctor: renderDoctor,
};

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

function boot() {
  if (!hasToken()) {
    // The token lives in the fragment; without it nothing can be authenticated.
    document.getElementById('main').replaceChildren(
      Object.assign(document.createElement('div'), {
        className: 'notice error',
        textContent:
          'Missing token. Open the URL that `gs gui` printed, which includes #token=…',
      }),
    );
    return;
  }

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => app.goto(tab.dataset.view));
  }

  api
    .state()
    .then((state) => {
      document.getElementById('status').textContent =
        `${state.identities.length} identities · ${state.rules.length} rules`;
      app.state = state;
    })
    .catch((err) => {
      document.getElementById('status').textContent = err.message;
      document.getElementById('status').className = 'status error';
    });

  void app.goto('overview');
}

boot();
