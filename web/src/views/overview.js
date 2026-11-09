import { el, clear, tag } from '../dom.js';
import { api } from '../api.js';

export async function renderOverview(container, app) {
  clear(container);
  const state = await api.state();
  app.state = state;

  container.append(el('h2', { text: 'Overview' }));

  const counts = el('div', { class: 'card' }, [
    el('div', { class: 'muted', text: `${state.identities.length} identities · ${state.rules.length} rules · ${state.repositories.length} overrides` }),
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
          identity.sshKey ? tag('ok', identity.sshKey) : tag('warn', 'no key'),
        ]),
        el('div', { class: 'mono muted', text: `${identity.userName} <${identity.email}>` }),
        el('div', { class: 'mono muted', text: sites || 'no sites' }),
        el(
          'button',
          {
            class: 'primary',
            style: 'margin-top:12px',
            text: 'View diff',
            onclick: () => app.goto('preview'),
          },
        ),
      ]),
    );
  }
  container.append(grid);

  container.append(
    el('h3', { text: 'Next step' }),
    el('div', { class: 'card banner' }, [
      el('div', {}, [
        el('div', { text: 'Check the pending changes before writing anything.' }),
        el('div', { class: 'muted', text: 'gs never writes without showing you the diff first.' }),
      ]),
      el('button', { class: 'primary', text: 'Open preview', onclick: () => app.goto('preview') }),
    ]),
  );
}
