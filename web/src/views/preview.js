import { el, clear, notice, diffBlock } from '../dom.js';
import { api } from '../api.js';

/** The only view that can write to disk. Always four steps: plan, show, confirm, apply. */
export async function renderPreview(container, app) {
  clear(container);
  container.append(el('h2', { text: 'Pending changes' }));

  const loading = notice('ok', 'computing the plan…');
  container.append(loading);

  let plan;
  try {
    plan = await api.plan();
  } catch (err) {
    clear(container);
    container.append(el('h2', { text: 'Pending changes' }), notice('error', err.message));
    return;
  }

  clear(container);
  container.append(el('h2', { text: 'Pending changes' }));

  for (const error of plan.errors ?? []) container.append(notice('error', error));
  for (const warning of plan.warnings ?? []) container.append(notice('warn', warning));

  const changes = (plan.files ?? []).filter((f) => f.kind !== 'unchanged');

  if (plan.errors?.length > 0) {
    container.append(notice('error', 'Fix the errors above before applying.'));
  }

  if (changes.length === 0) {
    container.append(notice('ok', 'No changes — the generated files already match your profile.'));
    container.append(
      el('button', { text: 'Back to overview', onclick: () => app.goto('overview') }),
    );
    return;
  }

  const summary = el('div', { class: 'card banner' }, [
    el('div', {}, [
      el('div', { text: `${changes.length} file(s) will change` }),
      el('div', { class: 'muted', text: 'Each file is backed up before it is written.' }),
    ]),
    el('button', {
      class: 'primary',
      text: 'Apply changes',
      disabled: plan.errors?.length > 0,
      onclick: async (event) => {
        const button = event.target;
        button.disabled = true;
        button.textContent = 'Applying…';
        try {
          const result = await api.apply(false);
          if (result.errors?.length) {
            app.toast(`Applied with ${result.errors.length} error(s)`, 'error');
          } else {
            app.toast(`Applied — ${result.written?.length ?? 0} file(s) written`);
          }
          await renderPreview(container, app);
        } catch (err) {
          button.disabled = false;
          button.textContent = 'Apply changes';
          app.toast(err.message, 'error');
        }
      },
    }),
  ]);
  container.append(summary);

  for (const file of changes) {
    container.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'mono', text: `${file.label}  (${file.kind})` }),
        file.diff ? diffBlock(file.diff) : el('div', { class: 'muted', text: 'binary or empty diff' }),
      ]),
    );
  }
}
