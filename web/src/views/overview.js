import { el, clear, tag } from '../dom.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

export async function renderOverview(container, app) {
  clear(container);
  const state = await api.state();
  app.state = state;

  container.append(el('h2', { text: t('web.tab.overview') }));

  const counts = el('div', { class: 'card' }, [
    el('div', {
      class: 'muted',
      text: t('web.counts', state.identities.length, state.rules.length, state.repositories.length),
    }),
    el('div', { class: 'mono muted', text: state.profilePath }),
  ]);
  container.append(counts);

  const grid = el('div', { class: 'grid' });
  for (const identity of state.identities) {
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
        el('div', { class: 'mono muted', text: sites || t('web.noSites') }),
        el('button', {
          class: 'primary',
          style: 'margin-top:12px',
          text: t('web.viewDiff'),
          onclick: () => app.goto('preview'),
        }),
      ]),
    );
  }
  container.append(grid);

  container.append(
    el('h3', { text: t('web.nextStep') }),
    el('div', { class: 'card banner' }, [
      el('div', {}, [
        el('div', { text: t('web.nextStepBody') }),
        el('div', { class: 'muted', text: t('web.nextStepHint') }),
      ]),
      el('button', { class: 'primary', text: t('web.openPreview'), onclick: () => app.goto('preview') }),
    ]),
  );
}
