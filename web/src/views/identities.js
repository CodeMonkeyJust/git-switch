import { el, clear, notice, tag } from '../dom.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

/**
 * Identity management: list every identity with its sites, add one, edit one, or
 * delete one. Every write goes through the API, which persists profiles.yaml;
 * nothing reaches ~/.gitconfig until the user applies from the Preview screen.
 */
export async function renderIdentities(container, app) {
  clear(container);
  container.append(el('h2', { text: t('web.identitiesTitle') }));

  const state = await api.state();
  app.state = state;

  const grid = el('div', { class: 'grid' });
  for (const identity of state.identities) {
    const rules = state.rules.filter((r) => r.identity === identity.name).length;
    const site = identity.sites[0];
    const sites = identity.sites
      .map((s) => (s.port ? `${s.host}:${s.port}` : s.host))
      .join(', ');

    grid.append(
      el('div', { class: 'card' }, [
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' }, [
          el('strong', { text: identity.name }),
          identity.sshKey ? tag('ok', identity.sshKey) : tag('warn', t('web.noKey')),
        ]),
        el('div', { class: 'mono muted', text: `${identity.userName} <${identity.email}>` }),
        el('div', { class: 'mono muted', text: `${t('web.identitySites')}: ${sites || t('web.noSites')}` }),
        rules > 0 ? el('div', { class: 'muted', text: `${rules}` }) : null,
        el('div', { style: 'margin-top:12px;display:flex;gap:8px' }, [
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
              card.append(identityEditor(container, app, identity, site));
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

  container.append(el('h3', { text: t('web.addIdentity') }), identityForm(container, app));
}

function input(value, placeholder) {
  return el('input', {
    value: value ?? '',
    placeholder: placeholder ?? '',
    style:
      'font-family:var(--mono);padding:6px 10px;border:1px solid var(--border);' +
      'border-radius:6px;background:var(--bg);color:var(--fg);width:100%',
  });
}

function row(labelText, control) {
  return el('div', { class: 'row', style: 'display:block' }, [
    el('div', { class: 'muted', text: labelText }),
    control,
  ]);
}

/** Inline editor shown inside an identity card. */
function identityEditor(container, app, identity, site) {
  const panel = el('div', { class: 'edit-panel', style: 'margin-top:12px;border-top:1px solid var(--border);padding-top:12px' });
  const error = el('div', { class: 'muted', text: '' });

  const name = input(identity.name, t('web.identityName'));
  const userName = input(identity.userName, t('web.userName'));
  const email = input(identity.email, t('web.userEmail'));
  const sshKey = input(identity.sshKey ?? '', t('web.sshKey'));
  const host = input(site?.host ?? '', t('web.siteHost'));
  const port = input(site?.port ?? '', t('web.sitePort'));
  const alias = input(site?.alias ?? '', t('web.siteAlias'));

  const save = el('button', {
    class: 'primary',
    text: t('web.saveEdit'),
    onclick: async () => {
      error.textContent = '';
      error.className = 'muted';
      try {
        await api.updateIdentity({
          original: identity.name,
          name: name.value.trim(),
          userName: userName.value.trim(),
          email: email.value.trim(),
          sshKey: sshKey.value.trim(),
          host: host.value.trim(),
          port: port.value.trim(),
          alias: alias.value.trim(),
        });
        app.toast(t('web.identityUpdated', name.value.trim()));
        await renderIdentities(container, app);
      } catch (err) {
        error.textContent = err.message;
        error.className = 'notice error';
      }
    },
  });

  panel.append(
    row(t('web.identityName'), name),
    row(t('web.userName'), userName),
    row(t('web.userEmail'), email),
    row(t('web.sshKey'), sshKey),
    row(t('web.siteHost'), host),
    row(t('web.sitePort'), port),
    row(t('web.siteAlias'), alias),
    el('div', { class: 'muted', text: t('web.editHint') }),
    el('div', { style: 'margin-top:12px' }, [save]),
    error,
  );
  return panel;
}

function identityForm(container, app) {
  const card = el('div', { class: 'card' });
  const error = el('div', { class: 'muted', text: '' });

  const name = input('', t('web.identityNameHint'));
  const userName = input('', 'zhulj');
  const email = input('', 'you@example.com');
  const sshKey = input('', 'id_ed25519_work');
  const host = input('', 'github.com');
  const port = input('', '22');
  const alias = input('', 'gh');

  const submit = el('button', {
    class: 'primary',
    text: t('web.save'),
    onclick: async () => {
      error.textContent = '';
      error.className = 'muted';
      try {
        await api.addIdentity({
          name: name.value.trim(),
          userName: userName.value.trim(),
          email: email.value.trim(),
          sshKey: sshKey.value.trim(),
          host: host.value.trim(),
          port: port.value.trim(),
          alias: alias.value.trim(),
        });
        app.toast(t('web.identityAdded', name.value.trim()));
        await renderIdentities(container, app);
      } catch (err) {
        error.textContent = err.message;
        error.className = 'notice error';
      }
    },
  });

  card.append(
    row(t('web.identityName'), name),
    row(t('web.userName'), userName),
    row(t('web.userEmail'), email),
    row(t('web.sshKey'), sshKey),
    row(t('web.siteHost'), host),
    row(t('web.sitePort'), port),
    row(t('web.siteAlias'), alias),
    el('div', { style: 'margin-top:12px' }, [submit]),
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
    // the identity is still referenced by rules: ask once more, explicitly
    if (/still used|仍被/.test(err.message) && confirm(err.message)) {
      await api.removeIdentity(name, true);
      app.toast(t('web.identityDeleted', name));
    } else if (rulesInUse >= 0 && err.status === 409) {
      return; // user declined
    } else {
      app.toast(err.message, 'error');
      return;
    }
  }
  await renderIdentities(container, app);
}

export { notice };
