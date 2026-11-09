import { el, clear, notice, tag } from '../dom.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

/**
 * Identity management: list every identity with its sites, add a new one, or
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
        rules > 0
          ? el('div', { class: 'muted', text: `${rules}` })
          : null,
        el('button', {
          class: 'danger',
          style: 'margin-top:12px',
          text: t('web.deleteIdentity'),
          onclick: () => deleteIdentity(container, app, identity.name, rules),
        }),
      ]),
    );
  }
  if (state.identities.length === 0) {
    grid.append(el('div', { class: 'empty', text: t('web.noIdentities') }));
  }
  container.append(grid);

  container.append(el('h3', { text: t('web.addIdentity') }), identityForm(container, app));
}

function identityForm(container, app) {
  const card = el('div', { class: 'card' });
  const error = el('div', { class: 'muted', text: '' });

  const input = (label, placeholder, value = '') =>
    el('input', {
      placeholder,
      value,
      title: label,
      style:
        'font-family:var(--mono);padding:6px 10px;border:1px solid var(--border);border-radius:6px;' +
        'background:var(--bg);color:var(--fg);width:100%',
    });

  const name = input(t('web.identityName'), t('web.identityNameHint'));
  const userName = input(t('web.userName'), 'zhulj');
  const email = input(t('web.userEmail'), 'you@example.com');
  const sshKey = input(t('web.sshKey'), 'id_ed25519_work');
  const host = input(t('web.siteHost'), 'github.com');
  const port = input(t('web.sitePort'), '22');
  const alias = input(t('web.siteAlias'), 'gh');

  const row = (labelText, control, hint) =>
    el('div', { class: 'row', style: 'display:block' }, [
      el('div', { class: 'muted', text: labelText }),
      control,
      hint ? el('div', { class: 'muted', text: hint }) : null,
    ]);

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
    row(t('web.identityName'), name, t('web.identityNameHint')),
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
