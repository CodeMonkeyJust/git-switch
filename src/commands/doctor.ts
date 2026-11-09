import { homedir } from 'node:os';
import { loadProfiles } from '../core/profiles.ts';
import { runDoctor, type CheckResult } from '../core/checks.ts';
import type { Logger } from '../util/log.ts';

export interface DoctorOptions {
  home?: string;
  json?: boolean;
  online?: boolean;
  logger: Logger;
}

const ICON: Record<CheckResult['level'], string> = { ok: 'ok', warn: 'warn', error: 'error' };

export async function doctorCommand(opts: DoctorOptions): Promise<number> {
  const home = opts.home ?? homedir();
  const { logger } = opts;
  const profiles = await loadProfiles(home);
  const results = await runDoctor({ home, profiles, online: opts.online === true });

  const errors = results.filter((r) => r.level === 'error');
  const warnings = results.filter((r) => r.level === 'warn');

  if (logger.isJson) {
    logger.json({ results, errors: errors.length, warnings: warnings.length });
    return errors.length > 0 ? 2 : 0;
  }

  // report order is meaningful: group errors first so they are not lost in noise
  const ordered = [
    ...results.filter((r) => r.level === 'error'),
    ...results.filter((r) => r.level === 'warn'),
    ...results.filter((r) => r.level === 'ok'),
  ];

  for (const result of ordered) {
    const emit = result.level === 'ok' ? logger.ok : result.level === 'warn' ? logger.warn : logger.error;
    emit(result.title);
    if (result.detail) logger.dim(`   ${result.detail}`);
    if (result.fix) logger.dim(`   fix: ${result.fix}`);
  }

  const passing = results.length - errors.length - warnings.length;
  logger.info(`${passing} ok · ${warnings.length} warnings · ${errors.length} errors`);

  return errors.length > 0 ? 2 : 0;
}
