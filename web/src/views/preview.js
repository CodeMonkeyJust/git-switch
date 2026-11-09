import { el, clear, notice, diffBlock } from '../dom.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

/** The only view that can write to disk. Always four steps: plan, show, confirm, apply. */
export async function renderPreview(container, app) {
  clear(container);
  container.append(el('h2', { text: t('web.pendingTitle') }));

  container.append(notice('ok', t('web.computing')));

  let plan;
  try {
    plan = await api.plan();
  } catch (err) {
    clear(container);
    container.append(el('h2', { text: t('web.pendingTitle') }), notice('error', err.message));
    return;
  }

  clear(container);
  container.append(el('h2', { text: t('web.pendingTitle') }));

  for (const error of plan.errors ?? []) container.append(notice('error', error));
  for (const warning of plan.warnings ?? []) container.append(notice('warn', warning));

  const changes = (plan.files ?? []).filter((f) => f.kind !== 'unchanged');

  if (plan.errors?.length > 0) {
    container.append(notice('error', t('web.fixErrorsFirst')));
  }

  if (changes.length === 0) {
    container.append(notice('ok', t('web.noChanges')));
    container.append(el('button', { text: t('web.backToOverview'), onclick: () => app.goto('overview') }));
    return;
  }

  const summary = el('div', { class: 'card banner' }, [
    el('div', {}, [
      el('div', { text: t('web.willChange', changes.length) }),
      el('div', { class: 'muted', text: t('web.backupHint') }),
    ]),
    el('button', {
      class: 'primary',
      text: t('web.apply'),
      disabled: plan.errors?.length > 0,
      onclick: async (event) => {
        const button = event.target;
        button.disabled = true;
        button.textContent = t('web.applying');
        try {
          const result = await api.apply(false);
          if (result.errors?.length) {
            app.toast(t('web.appliedWithErrors', result.errors.length), 'error');
          } else {
            app.toast(t('web.applied', result.written?.length ?? 0));
          }
          await renderPreview(container, app);
        } catch (err) {
          button.disabled = false;
          button.textContent = t('web.apply');
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
        file.diff ? diffBlock(file.diff) : el('div', { class: 'muted', text: t('web.binaryDiff') }),
      ]),
    );
  }
}
