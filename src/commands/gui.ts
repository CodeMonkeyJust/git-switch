import { execFile } from 'node:child_process';
import { t } from '../core/i18n.ts';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer } from '../server/http.ts';
import { loadProfiles } from '../core/profiles.ts';
import { gsPaths } from '../core/paths.ts';
import { exists } from '../util/fs-atomic.ts';
import type { Logger } from '../util/log.ts';

export interface GuiOptions {
  home?: string;
  port?: number;
  open?: boolean;
  /** minutes of inactivity before exiting; 0 disables */
  idleTimeoutMinutes?: number;
  json?: boolean;
  logger: Logger;
}

interface LockFile {
  pid: number;
  port: number;
  startedAt: string;
}

function lockPath(home: string): string {
  return path.join(gsPaths(home).configDir, 'gui.lock');
}

async function readLock(home: string): Promise<LockFile | undefined> {
  const file = lockPath(home);
  if (!(await exists(file))) return undefined;
  try {
    return JSON.parse(await readFile(file, 'utf8')) as LockFile;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(command, args, { windowsHide: true }, () => {
    /* opening a browser is best effort */
  });
}

export async function guiCommand(opts: GuiOptions): Promise<number> {
  const home = opts.home ?? homedir();
  const { logger } = opts;

  // a profile is required: the GUI edits one, it does not invent one
  try {
    await loadProfiles(home);
  } catch (err) {
    logger.error((err as Error).message);
    return 2;
  }

  // single instance: reuse a live server instead of starting a second one
  const existing = await readLock(home);
  if (existing && processAlive(existing.pid) && existing.pid !== process.pid) {
    const url = `http://127.0.0.1:${existing.port}/`;
    logger.warn(t('gui.alreadyRunning', existing.port));
    logger.dim(t('gui.alreadyRunningHint', url));
    if (opts.open !== false) openBrowser(url);
    return 0;
  }

  let lastActivity = Date.now();
  const server: RunningServer = await startServer({
    home,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    onActivity: () => {
      lastActivity = Date.now();
    },
  });

  await writeFile(
    lockPath(home),
    JSON.stringify({ pid: process.pid, port: server.port, startedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );

  const cleanup = async () => {
    await server.close();
    await unlink(lockPath(home)).catch(() => {});
  };

  // Always say which home this instance operates on. A GUI launched with --home
  // looks exactly like the real one, and mistaking a sandbox for the live
  // configuration makes "I changed it but nothing happened" very hard to explain.
  const sandbox = path.resolve(home) !== path.resolve(homedir());

  if (opts.json) {
    logger.json({
      url: server.url,
      port: server.port,
      pid: process.pid,
      home,
      sandbox,
    });
    // `--json` suppresses warnings on stdout, but a sandbox home is important
    // enough to state on stderr, where it never corrupts the JSON document.
    if (sandbox) logger.error(t('gui.sandboxWarn'));
  } else {
    logger.ok(t('gui.listening', `http://127.0.0.1:${server.port}/`));
    logger.dim(t('gui.home', home));
    if (sandbox) {
      logger.warn(t('gui.sandboxWarn'));
    } else {
      logger.dim(t('gui.realHome'));
    }
    logger.dim(t('gui.tokenHint'));
    if (opts.open !== false) {
      logger.dim(t('gui.opening'));
      logger.dim(`  ${server.url}`);
    }
  }

  if (opts.open !== false && !opts.json) openBrowser(server.url);

  const idleMinutes = opts.idleTimeoutMinutes ?? 30;
  if (idleMinutes > 0) {
    const timer = setInterval(() => {
      if (Date.now() - lastActivity > idleMinutes * 60_000) {
        logger.info(t('gui.idleExit', idleMinutes));
        void cleanup().then(() => process.exit(0));
      }
    }, 30_000);
    timer.unref?.();
  }

  const shutdown = async () => {
    await cleanup();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  // keep the process alive until a signal arrives
  await new Promise<void>(() => {});
  return 0;
}

export { openBrowser };
