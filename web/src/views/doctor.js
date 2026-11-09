import { el, clear, tag } from '../dom.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

export async function renderDoctor(container, app, online = false) {
  clear(container);

  const header = el('div', { class: 'banner' }, [
    el('h2', { text: t('web.tab.doctor'), style: 'margin:0' }),
    el('div', { style: 'display:flex;gap:8px' }, [
      el('button', { text: t('web.runAgain'), onclick: () => renderDoctor(container, app) }),
      el('button', {
        class: 'primary',
        text: t('web.runOnline'),
        onclick: () => renderDoctor(container, app, true),
      }),
    ]),
  ]);
  container.append(header);

  container.append(el('div', { class: 'muted', text: t('web.checking') }));
  let report;
  try {
    report = await api.doctor(online === true);
  } catch (err) {
    container.append(el('div', { class: 'notice error', text: err.message }));
    return;
  }
  clear(container);
  container.append(header);

  const ordered = [
    ...report.results.filter((r) => r.level === 'error'),
    ...report.results.filter((r) => r.level === 'warn'),
    ...report.results.filter((r) => r.level === 'ok'),
  ];

  const passing = report.results.length - report.errors - report.warnings;
  container.append(
    el('div', { class: 'card' }, [
      el('div', { style: 'display:flex;gap:12px;align-items:center' }, [
        tag('error', t('web.errorsTag', report.errors)),
        tag('warn', t('web.warningsTag', report.warnings)),
        tag('ok', t('web.okTag', passing)),
      ]),
    ]),
  );

  for (const result of ordered) {
    const lines = [
      el('div', { style: 'display:flex;gap:10px;align-items:center' }, [
        tag(result.level === 'ok' ? 'ok' : result.level === 'warn' ? 'warn' : 'error', result.level),
        el('span', { text: result.title }),
      ]),
    ];
    if (result.detail) lines.push(el('div', { class: 'muted mono', text: result.detail }));
    if (result.fix) lines.push(el('div', { class: 'mono', text: result.fix }));
    container.append(el('div', { class: 'card' }, lines));
  }
}
