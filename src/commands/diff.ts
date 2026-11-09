import { homedir } from 'node:os';
import { loadProfiles } from '../core/profiles.ts';
import { plan } from '../core/plan.ts';
import { unifiedDiff } from '../util/diff.ts';
import type { Logger } from '../util/log.ts';
import { t } from '../core/i18n.ts';

export interface DiffOptions {
  home?: string;
  cwd?: string;
  json?: boolean;
  logger: Logger;
}

export async function diffCommand(opts: DiffOptions): Promise<number> {
  const home = opts.home ?? homedir();
  const profiles = await loadProfiles(home, opts.cwd ?? process.cwd());
  const p = await plan({ home, profiles });
  const { logger } = opts;

  if (logger.isJson) {
    logger.json({
      dirty: p.dirty,
      errors: p.errors,
      warnings: p.warnings,
      files: p.ops.map((op) => ({
        file: op.label,
        kind: op.kind,
        diff: op.kind === 'unchanged' ? '' : unifiedDiff(op.before ?? '', op.after ?? ''),
      })),
    });
    return p.errors.length > 0 ? 2 : 0;
  }

  for (const error of p.errors) logger.error(error);
  for (const warning of p.warnings) logger.warn(warning);

  const changed = p.ops.filter((op) => op.kind !== 'unchanged');
  if (changed.length === 0) {
    logger.ok(t('diff.noChanges'));
    return 0;
  }

  for (const op of changed) {
    const title = `${op.label}  (${op.kind})`;
    logger.info(title);
    const d = unifiedDiff(op.before ?? '', op.after ?? '');
    if (d) logger.write(`${d}\n`);
    logger.write('\n');
  }

  logger.dim(t('diff.wouldChange', changed.length));
  return p.errors.length > 0 ? 2 : 0;
}
