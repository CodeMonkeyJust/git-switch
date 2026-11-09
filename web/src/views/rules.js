import { el, clear, notice } from '../dom.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

/**
 * Directory → identity rules.
 *
 * The add form follows the natural decision order: pick the directory (with a
 * browser, because typing paths by hand is error-prone), then pick the identity.
 * Every control has a persistent label.
 */
export async function renderRules(container, app) {
  clear(container);
  container.append(el('h2', { text: t('web.tab.rules') }));

  const state = await api.state();
  app.state = state;

  if (state.identities.length === 0) {
    container.append(notice('warn', t('web.noIdentities')));
    return;
  }

  /* ---- existing rules ---- */
  const list = el('div', { class: 'card' });
  if (state.rules.length === 0) {
    list.append(el('div', { class: 'empty', text: t('web.noRules') }));
  }

  for (const rule of state.rules) {
    const select = el(
      'select',
      { class: 'input', disabled: true },
      state.identities.map((i) =>
        el('option', { value: i.name, text: i.name, selected: i.name === rule.identity }),
      ),
    );

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
  if (state.rules.length > 0) {
    container.append(el('div', { class: 'muted', text: t('web.identityOrderHint') }));
  }

  /* ---- add form ---- */
  container.append(el('h3', { text: t('web.addRuleTitle') }), addForm(container, app, state));
}

function field(labelText, control, hint, { required = false } = {}) {
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, [
      labelText,
      required ? el('span', { class: 'req', text: ' *' }) : null,
      hint ? el('span', { class: 'field-hint', text: ` ${hint}` }) : null,
    ]),
    control,
  ]);
}

function addForm(container, app, state) {
  const card = el('div', { class: 'card' });
  const error = el('div', { class: 'form-error', text: '' });

  // directory comes first: it is what the user is actually thinking about
  const dirInput = el('input', {
    type: 'text',
    class: 'input',
    placeholder: t('web.dirHint'),
  });

  const identitySelect = el(
    'select',
    { class: 'input' },
    [
      el('option', { value: '', text: t('web.selectPlaceholder'), selected: true }),
      ...state.identities.map((i) => el('option', { value: i.name, text: i.name })),
    ],
  );

  const browseBox = el('div', { class: 'browse-box' });

  const browseButton = el('button', {
    text: t('web.browse'),
    onclick: async () => {
      if (browseBox.children.length > 0) {
        browseBox.replaceChildren();
        return;
      }
      await showBrowser(browseBox, dirInput);
    },
  });

  const submit = el('button', {
    class: 'primary',
    text: t('web.addRule'),
    onclick: async () => {
      error.textContent = '';
      const dir = dirInput.value.trim();
      if (dir === '') {
        error.textContent = t('web.enterDir');
        return;
      }
      if (identitySelect.value === '') {
        error.textContent = t('web.field.identity') + ': ' + t('web.required');
        return;
      }
      try {
        await api.addRule(dir, identitySelect.value);
        app.toast(t('web.ruleAdded'));
        await renderRules(container, app);
      } catch (err) {
        error.textContent = err.message;
      }
    },
  });

  card.append(
    el('fieldset', { class: 'field-group' }, [
      el('legend', { text: t('web.section.target') }),
      field(t('web.field.dir'), dirInput, t('web.dirHint'), { required: true }),
      el('div', { class: 'form-actions' }, [browseButton]),
      browseBox,
    ]),
    el('fieldset', { class: 'field-group' }, [
      el('legend', { text: t('web.section.assign') }),
      field(t('web.field.identity'), identitySelect, null, { required: true }),
    ]),
    el('div', { class: 'form-actions' }, [submit]),
    error,
  );
  return card;
}

/** Server-side directory browser: fills the input and picks a folder. */
async function showBrowser(box, dirInput) {
  const render = async (dir) => {
    clear(box);
    const result = await api.browse(dir);
    dirInput.value = result.dir;

    if (result.error) box.append(notice('error', result.error));
    if (result.parent) {
      box.append(
        el('div', { class: 'row' }, [
          el('span', { class: 'path muted', text: '..' }),
          el('button', { text: t('web.up'), onclick: () => render(result.parent) }),
        ]),
      );
    }
    for (const entry of result.entries) {
      box.append(
        el('div', { class: 'row' }, [
          el('span', { class: 'path', text: entry.name + (entry.isRepo ? '  (repo)' : '') }),
          el('button', { text: t('web.open'), onclick: () => render(entry.path) }),
        ]),
      );
    }
    box.append(
      el('div', { class: 'form-actions' }, [
        el('button', {
          class: 'primary',
          text: t('web.useThisDir'),
          onclick: () => {
            dirInput.value = result.dir;
            box.replaceChildren();
          },
        }),
      ]),
    );
  };

  await render(dirInput.value.trim() || undefined);
}
