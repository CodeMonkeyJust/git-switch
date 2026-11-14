import { el, clear, notice, tag } from '../dom.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

/**
 * SSH key management, mirroring `gs key list|gen|copy|restore`.
 *
 * Private key material never reaches the browser: the server returns names,
 * fingerprints and owning identities only. Copying a public key uses the
 * server-side clipboard, which is more reliable than the async clipboard API in
 * a local page.
 */
export async function renderKeys(container, app) {
  clear(container);
  container.append(el('h2', { text: t('web.keysTitle') }));

  const report = await api.keys();
  app.keys = report.keys;

  const list = el('div', { class: 'card' });
  if (report.keys.length === 0) {
    list.append(el('div', { class: 'empty', text: t('web.keysEmpty') }));
  } else {
    for (const key of report.keys) {
      const usedBy = key.usedBy.length > 0 ? key.usedBy.join(', ') : t('web.keyUnused');
      list.append(
        el('div', { class: 'row' }, [
          el('span', { class: 'path', text: key.name }),
          el('span', { class: 'mono muted', text: key.fingerprint ?? '?' }),
          usedBy === t('web.keyUnused') ? tag('warn', usedBy) : tag('ok', usedBy),
          key.hasPublic
            ? el('button', {
                text: t('web.copyPublicKey'),
                onclick: async () => {
                  try {
                    const result = await api.copyKey(key.name);
                    if (result.copied) app.toast(t('web.publicKeyCopied'));
                    else app.toast(t('web.publicKeyCopyFailed'), 'warn');
                    if (!result.copied && result.publicKey) {
                      container.append(notice('ok', result.publicKey));
                    }
                  } catch (err) {
                    app.toast(err.message, 'error');
                  }
                },
              })
            : el('span', { class: 'muted', text: t('web.keyNoPublic') }),
        ]),
      );
    }
  }
  container.append(list);

  container.append(el('h3', { text: t('web.generateKeyTitle') }), generateForm(container, app));
  container.append(el('h3', { text: t('web.restoreTitle') }), restoreForm(container, app));
}

function input(placeholder, style = '') {
  return el('input', {
    placeholder,
    style:
      style +
      'font-family:var(--mono);padding:6px 10px;border:1px solid var(--border);' +
      'border-radius:6px;background:var(--bg);color:var(--fg)',
  });
}

function generateForm(container, app) {
  const card = el('div', { class: 'card' });
  const name = input('id_ed25519_work');
  const comment = input('you@example.com');
  const error = el('div', { class: 'muted', text: '' });

  card.append(
    el('div', { class: 'row' }, [
      name,
      comment,
      el('button', {
        class: 'primary',
        text: t('web.generateKey'),
        onclick: async () => {
          const keyName = name.value.trim();
          if (keyName === '') {
            app.toast(t('web.required'), 'warn');
            return;
          }
          // creating a file in ~/.ssh is not undoable from the UI: confirm first
          if (!confirm(t('web.generateKeyConfirm', keyName))) return;
          error.textContent = '';
          try {
            const result = await api.generateKey(keyName, comment.value.trim());
            app.toast(t('web.keyGenerated', keyName));
            if (result.publicKey) container.append(notice('ok', result.publicKey));
            await renderKeys(container, app);
            // the natural next step is to use the key for an identity
            container.prepend(
              el('div', { class: 'notice ok' }, [
                el('span', { text: t('web.keyNextStep') }),
                el('button', {
                  class: 'primary',
                  style: 'margin-left:12px',
                  text: t('web.goToIdentities'),
                  onclick: () => app.goto('identities'),
                }),
              ]),
            );
          } catch (err) {
            error.textContent = err.message;
            error.className = 'notice error';
          }
        },
      }),
    ]),
    error,
  );
  return card;
}

function restoreForm(container, app) {
  const card = el('div', { class: 'card' });
  const snapshot = input(t('web.importPath'));
  const passphrase = el('input', {
    type: 'password',
    placeholder: t('web.passphrase'),
    style:
      'font-family:var(--mono);padding:6px 10px;border:1px solid var(--border);' +
      'border-radius:6px;background:var(--bg);color:var(--fg)',
  });
  const error = el('div', { class: 'muted', text: '' });

  card.append(
    el('div', { class: 'row' }, [
      snapshot,
      passphrase,
      el('button', {
        text: t('web.restoreKeys'),
        onclick: async () => {
          if (snapshot.value.trim() === '') {
            app.toast(t('web.importPath'), 'warn');
            return;
          }
          if (!confirm(t('web.restoreConfirm'))) return;
          error.textContent = '';
          try {
            const result = await api.restoreKeys(snapshot.value.trim(), passphrase.value);
            app.toast(t('web.keysRestored', result.written.length));
            if (result.skipped.length > 0) {
              container.append(notice('warn', t('web.keysSkipped', result.skipped.length)));
            }
            await renderKeys(container, app);
          } catch (err) {
            error.textContent = err.message;
            error.className = 'notice error';
          }
        },
      }),
    ]),
    error,
  );
  return card;
}
