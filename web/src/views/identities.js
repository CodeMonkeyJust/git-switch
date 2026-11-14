import { el, clear, notice, tag } from '../dom.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

/**
 * Identity management.
 *
 * The form mirrors how a user thinks about an identity: who you are → which key
 * proves it → which host it talks to. Every field carries a visible label (a
 * placeholder alone disappears as soon as you type), and the SSH key is a
 * <select> of the keys that actually exist rather than free text.
 */
export async function renderIdentities(container, app) {
  clear(container);
  container.append(el('h2', { text: t('web.identitiesTitle') }));

  const [state, keyReport] = await Promise.all([api.state(), api.keys()]);
  app.state = state;
  const keyNames = keyReport.keys.map((k) => k.name);

  // A key is a prerequisite: an identity without one produces no SSH routing at
  // all. Point the user at the Keys screen instead of letting them create a
  // half-configured identity.
  if (keyNames.length === 0) {
    container.append(
      el('div', { class: 'notice warn' }, [
        el('span', { text: t('web.noKeysYet') }),
        el('button', {
          class: 'primary',
          style: 'margin-left:12px',
          text: t('web.goToKeys'),
          onclick: () => app.goto('keys'),
        }),
      ]),
    );
  }

  const grid = el('div', { class: 'grid' });
  for (const identity of state.identities) {
    const rules = state.rules.filter((r) => r.identity === identity.name).length;
    const site = identity.sites[0];
    const sites = identity.sites
      .map((s) => (s.port ? `${s.host}:${s.port}` : s.host))
      .join(', ');

    grid.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('strong', { text: identity.name }),
          identity.sshKey ? tag('ok', identity.sshKey) : tag('warn', t('web.noKey')),
        ]),
        fieldLine(t('web.field.userName'), `${identity.userName} <${identity.email}>`),
        fieldLine(t('web.field.siteHost'), sites || t('web.noSites')),
        rules > 0 ? fieldLine(t('web.field.dir'), t('web.ruleCount', rules)) : null,
        el('div', { class: 'card-actions' }, [
          el('button', {
            text: t('web.editIdentity'),
            onclick: (event) => {
              const card = event.target.closest('.card');
              const existing = card.querySelector('.edit-panel');
              if (existing) {
                existing.remove();
                event.target.textContent = t('web.editIdentity');
                return;
              }
              event.target.textContent = t('web.cancel');
              card.append(identityEditor(container, app, identity, site, keyNames));
            },
          }),
          el('button', {
            class: 'danger',
            text: t('web.deleteIdentity'),
            onclick: () => deleteIdentity(container, app, identity.name, rules),
          }),
        ]),
      ]),
    );
  }
  if (state.identities.length === 0) {
    grid.append(el('div', { class: 'empty', text: t('web.noIdentities') }));
  }
  container.append(grid);

  container.append(el('h3', { text: t('web.addIdentity') }), identityForm(container, app, keyNames));
  if (state.rules.length > 0) {
    container.append(el('div', { class: 'muted', text: t('web.identityOrderHint') }));
  }
}

/** "label: value" row used in cards. */
function fieldLine(label, value) {
  return el('div', { class: 'kv' }, [
    el('span', { class: 'kv-label', text: label }),
    el('span', { class: 'kv-value mono', text: value }),
  ]);
}

/** A labelled field: the label is always visible above the control. */
function field(labelText, control, hint, { required = false } = {}) {
  const label = el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, [
      labelText,
      required ? el('span', { class: 'req', text: ' *' }) : null,
      hint ? el('span', { class: 'field-hint', text: ` ${hint}` }) : null,
    ]),
    control,
  ]);
  return label;
}

function textInput(value, placeholder) {
  return el('input', {
    type: 'text',
    value: value ?? '',
    placeholder: placeholder ?? '',
    class: 'input',
  });
}

/** A <select> that includes a "no key" option and the keys found in ~/.ssh. */
function keySelect(current, keyNames) {
  const options = [
    el('option', { value: '', text: t('web.keyfileNone'), selected: !current }),
    ...keyNames.map((name) =>
      el('option', { value: name, text: name, selected: name === current }),
    ),
  ];
  // a profile may reference a key that is not on disk yet: keep it selectable
  if (current && !keyNames.includes(current)) {
    options.push(el('option', { value: current, text: `${current} ${t('web.keyMissing')}`, selected: true }));
  }
  return el('select', { class: 'input' }, options);
}

function group(title, children) {
  return el('fieldset', { class: 'field-group' }, [
    el('legend', { text: title }),
    ...children.filter(Boolean),
  ]);
}

/** Inline editor shown inside an identity card. */
function identityEditor(container, app, identity, site, keyNames) {
  const panel = el('div', { class: 'edit-panel' });
  const error = el('div', { class: 'form-error', text: '' });

  const name = textInput(identity.name, t('web.identityNameHint'));
  const userName = textInput(identity.userName, 'Alex Chen');
  const email = textInput(identity.email, 'you@example.com');
  const sshKey = keySelect(identity.sshKey, keyNames);
  const host = textInput(site?.host ?? '', t('web.hostHint'));
  const port = textInput(site?.port ?? '', t('web.portHint'));
  const alias = textInput(site?.alias ?? '', t('web.aliasHint'));
  // The SSH endpoint is often not the Git host. github.com reaches SSH through
  // ssh.github.com:443, and omitting this silently broke pushes.
  const sshHostName = textInput(site?.sshHostName ?? '', 'ssh.github.com');
  const siteUser = textInput(site?.user ?? '', 'git');

  const save = el('button', {
    class: 'primary',
    text: t('web.saveEdit'),
    onclick: async () => {
      error.textContent = '';
      try {
        await api.updateIdentity({
          original: identity.name,
          name: name.value.trim(),
          userName: userName.value.trim(),
          email: email.value.trim(),
          sshKey: sshKey.value.trim(),
          host: host.value.trim(),
          port: port.value.trim(),
          sshHostName: sshHostName.value.trim(),
          user: siteUser.value.trim(),
          alias: alias.value.trim(),
        });
        app.toast(t('web.identityUpdated', name.value.trim()));
        await renderIdentities(container, app);
      } catch (err) {
        error.textContent = err.message;
      }
    },
  });

  panel.append(
    group(t('web.section.identity'), [
      field(t('web.field.name'), name, t('web.identityNameHint'), { required: true }),
      field(t('web.field.userName'), userName, null, { required: true }),
      field(t('web.field.email'), email, null, { required: true }),
    ]),
    group(t('web.section.key'), [
      field(t('web.field.sshKey'), sshKey, t('web.keyfileHint'), { required: true }),
    ]),
    group(t('web.section.site'), [
      field(t('web.field.siteHost'), host, t('web.hostHint')),
      field(t('web.field.sitePort'), port, t('web.portHint')),
      field(t('web.field.sshHostName'), sshHostName, t('web.sshHostNameHint')),
      field(t('web.field.siteUser'), siteUser, t('web.siteUserHint')),
      field(t('web.field.siteAlias'), alias, t('web.aliasHint')),
    ]),
    el('div', { class: 'muted', text: t('web.editHint') }),
    el('div', { class: 'form-actions' }, [save]),
    error,
  );
  return panel;
}

function identityForm(container, app, keyNames) {
  const card = el('div', { class: 'card' });
  const error = el('div', { class: 'form-error', text: '' });

  const name = textInput('', 'gitee');
  const userName = textInput('', 'Alex Chen');
  const email = textInput('', 'you@example.com');
  const sshKey = keySelect('', keyNames);
  const host = textInput('', t('web.hostHint'));
  const port = textInput('', t('web.portHint'));
  const alias = textInput('', t('web.aliasHint'));
  const sshHostName = textInput('', 'ssh.github.com');
  const siteUser = textInput('', 'git');

  const submit = el('button', {
    class: 'primary',
    text: t('web.save'),
    onclick: async () => {
      error.textContent = '';
      try {
        await api.addIdentity({
          name: name.value.trim(),
          userName: userName.value.trim(),
          email: email.value.trim(),
          sshKey: sshKey.value.trim(),
          host: host.value.trim(),
          port: port.value.trim(),
          sshHostName: sshHostName.value.trim(),
          user: siteUser.value.trim(),
          alias: alias.value.trim(),
        });
        app.toast(t('web.identityAdded', name.value.trim()));
        await renderIdentities(container, app);
      } catch (err) {
        error.textContent = err.message;
      }
    },
  });

  card.append(
    group(t('web.section.identity'), [
      field(t('web.field.name'), name, t('web.identityNameHint'), { required: true }),
      field(t('web.field.userName'), userName, null, { required: true }),
      field(t('web.field.email'), email, null, { required: true }),
    ]),
    group(t('web.section.key'), [
      field(t('web.field.sshKey'), sshKey, t('web.keyfileHint'), { required: true }),
    ]),
    group(t('web.section.site'), [
      field(t('web.field.siteHost'), host, t('web.hostHint')),
      field(t('web.field.sitePort'), port, t('web.portHint')),
      field(t('web.field.sshHostName'), sshHostName, t('web.sshHostNameHint')),
      field(t('web.field.siteUser'), siteUser, t('web.siteUserHint')),
      field(t('web.field.siteAlias'), alias, t('web.aliasHint')),
    ]),
    el('div', { class: 'form-actions' }, [submit]),
    error,
  );
  return card;
}

async function deleteIdentity(container, app, name, rulesInUse) {
  if (!confirm(t('web.deleteIdentityConfirm', name))) return;
  try {
    await api.removeIdentity(name, false);
    app.toast(t('web.identityDeleted', name));
  } catch (err) {
    if (/still used|仍被/.test(err.message) && confirm(err.message)) {
      await api.removeIdentity(name, true);
      app.toast(t('web.identityDeleted', name));
    } else if (rulesInUse >= 0 && err.status === 409) {
      return;
    } else {
      app.toast(err.message, 'error');
      return;
    }
  }
  await renderIdentities(container, app);
}

export { notice };
