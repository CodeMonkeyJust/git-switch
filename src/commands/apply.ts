import { homedir } from 'node:os';
import { loadProfiles } from '../core/profiles.ts';
import { plan } from '../core/plan.ts';
import { apply, HandEditError } from '../core/apply.ts';
import { contractHome } from '../core/paths.ts';
import type { Logger } from '../util/log.ts';

export interface ApplyOptions {
  home?: string;
  cwd?: string;
  json?: boolean;
  dryRun?: boolean;
  force?: boolean;
  logger: Logger;
}

export async function applyCommand(opts: ApplyOptions): Promise<number> {
  const home = opts.home ?? homedir();
  const { logger } = opts;
  const profiles = await loadProfiles(home, opts.cwd ?? process.cwd());
  const p = await plan({ home, profiles });

  if (p.errors.length > 0) {
    for (const error of p.errors) logger.error(error);
    return 2;
  }
  for (const warning of p.warnings) logger.warn(warning);

  try {
    const result = await apply(p, {
      home,
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...(opts.force ? { force: true } : {}),
    });

    if (opts.dryRun) {
      const changed = p.ops.filter((op) => op.kind !== 'unchanged');
      if (logger.isJson) logger.json({ dryRun: true, wouldChange: changed.map((op) => op.label) });
      else if (changed.length === 0) logger.ok('no changes (already up to date)');
      else for (const op of changed) logger.info(`would ${op.kind}: ${op.label}`);
      return 0;
    }

    if (logger.isJson) {
      logger.json(result);
    } else {
      if (result.written.length === 0) {
        logger.ok('no changes (already up to date)');
      } else {
        for (const b of result.backups) logger.dim(`backup ${contractHome(b, home)}`);
        for (const w of result.written) logger.ok(`wrote ${w}`);
      }
      for (const e of result.errors) logger.error(`${e.file}: ${e.message}`);
    }
    return result.errors.length > 0 ? 2 : 0;
  } catch (err) {
    if (err instanceof HandEditError) {
      logger.error(err.message);
      return 2;
    }
    throw err;
  }
}
