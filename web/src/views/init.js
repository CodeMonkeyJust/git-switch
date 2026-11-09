import { el, clear, notice, tag } from '../dom.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

/**
 * First-run setup, mirroring `gs init`.
 *
 * Two steps so nothing is written by accident: "scan" only reports what would be
 * proposed, "save" persists the profile. An existing profile blocks saving unless
 * the user explicitly confirms the overwrite.
 */
export async function renderInit(container, app) {
  clear(container);
  container.append(el('h2', { text: t('web.initTitle') }));

  const exists = Boolean(app.state?.profileExists);
  if (exists) {
    container.append(notice('warn', t('web.initAlreadyExists')));
    return;
  }

  const card = el('div', { class: 'card' });
  const root = el('input', {
    placeholder: 'D:/CODE',
    style:
      'font-family:var(--mono);padding:6px 10px;border:1px solid var(--border);' +
      'border-radius:6px;background:var(--bg);color:var(--fg)',
  });
  const offline = el('input', { type: 'checkbox' });
  const output = el('div', {});

  card.append(
    el('div', { class: 'row' }, [
      root,
      el('label', { style: 'display:flex;gap:6px;align-items:center' }, [offline, t('web.initOffline')]),
      el('button', {
        class: 'primary',
        text: t('web.initStart'),
        onclick: async () => {
          clear(output);
          output.append(el('div', { class: 'muted', text: t('web.initScanning') }));
          try {
            const scan = await api.scanInit(root.value.trim(), offline.checked);
            clear(output);
            output.append(el('h3', { text: t('web.initDetected') }));

            for (const warning of scan.warnings ?? []) output.append(notice('warn', warning));

            const identityRows = (scan.identities ?? []).map((i) =>
              el('div', { class: 'row' }, [
                el('strong', { text: i.name }),
                el('span', { class: 'mono muted', text: i.email }),
                i.sshKey ? tag('ok', i.sshKey) : tag('warn', t('web.noKey')),
                el('span', { class: 'mono muted', text: (i.sites ?? []).join(', ') || t('web.noSites') }),
              ]),
            );
            output.append(el('div', { class: 'card' }, identityRows));

            const ruleRows = (scan.rules ?? []).map((r) =>
              el('div', { class: 'row' }, [
                el('span', { class: 'path', text: r.dir }),
                el('span', { class: 'muted', text: '→' }),
                el('span', { text: r.identity }),
              ]),
            );
            output.append(el('div', { class: 'card' }, ruleRows));

            output.append(
              el('button', {
                class: 'primary',
                style: 'margin-top:12px',
                text: t('web.save'),
                onclick: async () => {
                  try {
                    await api.applyInit(root.value.trim(), offline.checked, false);
                    app.toast(t('web.initSaved'));
                    app.state = { ...(app.state ?? {}), profileExists: true };
                    await app.goto('identities');
                  } catch (err) {
                    output.append(notice('error', err.message));
                  }
                },
              }),
            );
          } catch (err) {
            clear(output);
            output.append(notice('error', err.message));
          }
        },
      }),
    ]),
    el('div', { class: 'muted', text: t('web.initStartHint') }),
    output,
  );

  container.append(card);
}
