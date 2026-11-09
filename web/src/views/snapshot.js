import { el, clear, notice } from '../dom.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

/**
 * Snapshot export / import, mirroring `gs snapshot export|import`.
 *
 * Importing only replaces profiles.yaml; the user still has to confirm the
 * generated files from the Preview tab, so a mistaken import cannot touch
 * ~/.gitconfig on its own.
 */
export async function renderSnapshot(container, app) {
  clear(container);
  container.append(el('h2', { text: t('web.snapshotTitle') }));

  container.append(el('h3', { text: t('web.exportTitle') }), exportForm(container, app));
  container.append(el('h3', { text: t('web.importTitle') }), importForm(container, app));
}

function field(placeholder, type = 'text') {
  return el('input', {
    type,
    placeholder,
    style:
      'font-family:var(--mono);padding:6px 10px;border:1px solid var(--border);' +
      'border-radius:6px;background:var(--bg);color:var(--fg)',
  });
}

function exportForm(container, app) {
  const card = el('div', { class: 'card' });
  const path = field(t('web.exportPathHint'));
  const withKeys = el('input', { type: 'checkbox' });
  const passphrase = el('input', {
    type: 'password',
    placeholder: t('web.passphrase'),
    style:
      'font-family:var(--mono);padding:6px 10px;border:1px solid var(--border);' +
      'border-radius:6px;background:var(--bg);color:var(--fg)',
  });
  const error = el('div', { class: 'muted', text: '' });

  const syncPassphrase = () => {
    passphrase.disabled = !withKeys.checked;
    if (!withKeys.checked) passphrase.value = '';
  };
  withKeys.addEventListener('change', syncPassphrase);
  syncPassphrase();

  card.append(
    el('div', { class: 'row' }, [
      path,
      el('label', { style: 'display:flex;gap:6px;align-items:center' }, [withKeys, t('web.withKeys')]),
      passphrase,
      el('button', {
        class: 'primary',
        text: t('web.exportSnapshot'),
        onclick: async () => {
          error.textContent = '';
          try {
            const result = await api.exportSnapshot({
              path: path.value.trim(),
              withKeys: withKeys.checked,
              passphrase: passphrase.value,
            });
            app.toast(t('web.exported', result.path));
            container.append(
              notice('ok', `${t('web.exportSummary', result.files, result.identities, result.rules)} — ${result.path}`),
            );
          } catch (err) {
            error.textContent = err.message;
            error.className = 'notice error';
          }
        },
      }),
    ]),
    el('div', { class: 'muted', text: t('web.passphraseHint') }),
    error,
  );
  return card;
}

function importForm(container, app) {
  const card = el('div', { class: 'card' });
  const path = field(t('web.importPath'));
  const remaps = field(t('web.remap'));

  card.append(
    el('div', { class: 'row' }, [
      path,
      remaps,
      el('button', {
        text: t('web.importSnapshot'),
        onclick: async () => {
          const source = path.value.trim();
          if (source === '') {
            app.toast(t('web.importPath'), 'warn');
            return;
          }
          // replacing the profile is destructive; the button is the confirmation
          if (!confirm(t('web.importConfirm'))) return;
          try {
            const result = await api.importSnapshot({ path: source, remaps: remaps.value.trim() });
            app.toast(t('web.imported', result.identities.length, result.rules.length));
            if (result.hasKeys) {
              container.append(notice('warn', t('web.importHasKeys')));
            }
            await renderSnapshot(container, app);
          } catch (err) {
            container.append(notice('error', err.message));
          }
        },
      }),
    ]),
    el('div', { class: 'muted', text: t('web.remapHint') }),
  );
  return card;
}
