import { el, clear, notice } from '../dom.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

export async function renderRules(container, app) {
  clear(container);
  container.append(el('h2', { text: t('web.tab.rules') }));

  const state = await api.state();
  app.state = state;

  if (state.identities.length === 0) {
    container.append(notice('warn', t('web.noIdentities')));
    return;
  }

  const list = el('div', { class: 'card' });
  if (state.rules.length === 0) {
    list.append(el('div', { class: 'empty', text: t('web.noRules') }));
  }

  for (const rule of state.rules) {
    const select = el(
      'select',
      {},
      state.identities.map((i) =>
        el('option', { value: i.name, text: i.name, selected: i.name === rule.identity }),
      ),
    );
    select.disabled = true;

    list.append(
      el('div', { class: 'row' }, [
        el('span', { class: 'path', text: rule.dir }),
        select,
        el('button', {
          class: 'danger',
          text: t('web.remove'),
          onclick: async () => {
            if (!confirm(t('web.removeConfirm', rule.dir))) return;
            await api.removeRule(rule.dir);
            app.toast(t('web.ruleRemoved'));
            await renderRules(container, app);
          },
        }),
      ]),
    );
  }
  container.append(list);

  container.append(el('h3', { text: t('web.addRuleTitle') }));

  const picker = el('div', { class: 'card' });
  const pathInput = el('input', {
    class: 'path',
    placeholder: t('web.pathPlaceholder'),
    style:
      'font-family:var(--mono);padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg)',
  });
  const identitySelect = el(
    'select',
    {},
    state.identities.map((i) => el('option', { value: i.name, text: i.name })),
  );

  picker.append(
    el('div', { class: 'row' }, [
      pathInput,
      el('button', {
        text: t('web.browse'),
        onclick: async () => {
          await showBrowser(picker, app, pathInput);
        },
      }),
      identitySelect,
      el('button', {
        class: 'primary',
        text: t('web.addRule'),
        onclick: async () => {
          const dir = pathInput.value.trim();
          if (!dir) {
            app.toast(t('web.enterDir'), 'warn');
            return;
          }
          try {
            await api.addRule(dir, identitySelect.value);
            app.toast(t('web.ruleAdded'));
            await renderRules(container, app);
          } catch (err) {
            app.toast(err.message, 'error');
          }
        },
      }),
    ]),
  );
  container.append(picker);
}

async function showBrowser(picker, app, pathInput) {
  let browser = picker.querySelector('.browser');
  if (browser) browser.remove();
  browser = el('div', { class: 'browser card', style: 'margin-top:12px' });

  const render = async (dir) => {
    clear(browser);
    const result = await api.browse(dir);
    pathInput.value = result.dir;
    browser.append(el('div', { class: 'mono muted', text: result.dir }), result.error ? notice('error', result.error) : null);
    if (result.parent) {
      browser.append(
        el('div', { class: 'row' }, [
          el('span', { class: 'path', text: '..' }),
          el('button', { text: t('web.up'), onclick: () => render(result.parent) }),
        ]),
      );
    }
    for (const entry of result.entries) {
      browser.append(
        el('div', { class: 'row' }, [
          el('span', { class: 'path', text: entry.name + (entry.isRepo ? '  (repo)' : '') }),
          el('button', { text: t('web.open'), onclick: () => render(entry.path) }),
        ]),
      );
    }
  };

  await render(pathInput.value.trim() || undefined);
  picker.append(browser);
}
