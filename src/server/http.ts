/**
 * Local HTTP server for `gs gui`.
 *
 * Bound to 127.0.0.1 only. Every request passes Host, Origin and token checks
 * before it can touch the API; see auth.ts for the reasoning.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorize, createToken, hostIsAllowed, originIsAllowed } from './auth.ts';
import { browse } from './fs-browse.ts';
import { loadProfiles, parseProfilesText, saveProfiles } from '../core/profiles.ts';
import { plan } from '../core/plan.ts';
import { apply } from '../core/apply.ts';
import { runDoctor } from '../core/checks.ts';
import { resolveIdentity, sitesFor, type Profiles } from '../core/model.ts';
import { gsPaths, contractHome, normaliseRulePath } from '../core/paths.ts';
import { unifiedDiff } from '../util/diff.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate the static assets.
 *
 * Three layouts must work:
 *   development    src/server/         -> <root>/web
 *   built (dist)   dist/server/        -> dist/web          (here/../web)
 *   installed      dist/server/        -> dist/web          (same as above)
 * Try them in order so `gs gui` behaves the same from a checkout, a local build
 * and an npm install.
 */
const WEB_ROOT_CANDIDATES = [
  path.resolve(here, '..', 'web'), // dist/server -> dist/web, and src/server -> src/web
  path.resolve(here, '..', '..', 'web'), // src/server -> <root>/web
  path.resolve(here, '..', '..', '..', 'web'), // safety net for nested layouts
];

async function resolveWebRoot(): Promise<string | undefined> {
  for (const candidate of WEB_ROOT_CANDIDATES) {
    try {
      await stat(path.join(candidate, 'index.html'));
      return candidate;
    } catch {
      // try the next layout
    }
  }
  return undefined;
}

export interface ServerOptions {
  home: string;
  port?: number;
  /** called on every request, used for idle shutdown */
  onActivity?: () => void;
}

export interface RunningServer {
  server: Server;
  port: number;
  token: string;
  url: string;
  close: () => Promise<void>;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = createToken();
  let boundPort = opts.port ?? 0;

  const server = createServer((req, res) => {
    opts.onActivity?.();
    handle(req, res, { home: opts.home, token, port: boundPort }).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: (err as Error).message }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(boundPort, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') boundPort = address.port;
      resolve();
    });
  });

  return {
    server,
    port: boundPort,
    token,
    url: `http://127.0.0.1:${boundPort}/#token=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

interface Ctx {
  home: string;
  token: string;
  port: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.port}`);

  // The index page must load *before* the browser knows the token: the URL
  // fragment (#token=…) is never sent to the server, so the very first request
  // for "/" cannot carry it. Static assets are therefore public to loopback;
  // Host/Origin are still enforced, and everything under /api still requires a
  // token.
  if (url.pathname.startsWith('/api/')) {
    const auth = authorize(req, ctx.token, ctx.port);
    if (!auth.ok) {
      sendJson(res, auth.status ?? 401, { error: auth.reason });
      return;
    }
    await handleApi(req, res, ctx, url);
    return;
  }

  // static: Host/Origin checks only (no token)
  if (!hostIsAllowed(headerOf(req, 'host'), ctx.port)) {
    sendJson(res, 403, { error: 'invalid Host header' });
    return;
  }
  if (!originIsAllowed(headerOf(req, 'origin'), ctx.port)) {
    sendJson(res, 403, { error: 'cross-origin request rejected' });
    return;
  }
  await serveStatic(res, url.pathname);
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const webRoot = await resolveWebRoot();
  if (!webRoot) {
    sendJson(res, 500, {
      error:
        'GUI assets not found. If you are running from a checkout, make sure the web/ ' +
        'directory is present; for a packaged install, reinstall git-switch.',
    });
    return;
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(webRoot, relative);
  if (!target.startsWith(webRoot)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const content = await readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function profileSummary(home: string, profiles: Profiles) {
  return {
    profilePath: contractHome(gsPaths(home).profiles, home),
    identities: profiles.identities.map((i) => ({
      name: i.name,
      email: i.user.email,
      userName: i.user.name,
      sshKey: i.sshKey ?? null,
      sites: sitesFor(profiles, i.name).map((s) => ({
        host: s.host,
        port: s.port ?? null,
        alias: s.alias ?? null,
      })),
    })),
    rules: profiles.rules.map((r) => ({ dir: r.dir, identity: r.identity })),
    repositories: profiles.repositories.map((r) => ({ path: r.path, identity: r.identity })),
  };
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET';

  try {
    if (url.pathname === '/api/state' && method === 'GET') {
      const profiles = await loadProfiles(ctx.home);
      const dir = url.searchParams.get('dir');
      const resolution = dir ? resolveIdentity(profiles, normaliseRulePath(dir, ctx.home)) : undefined;
      sendJson(res, 200, {
        home: contractHome(ctx.home, ctx.home),
        ...profileSummary(ctx.home, profiles),
        ...(resolution
          ? { resolved: { identity: resolution.identity.name, reason: resolution.reason, detail: resolution.detail } }
          : {}),
      });
      return;
    }

    if (url.pathname === '/api/plan' && method === 'POST') {
      const body = (await readBody(req)) as { profilesText?: string } | undefined;
      const profiles = body?.profilesText
        ? parseProfilesText(body.profilesText, ctx.home)
        : await loadProfiles(ctx.home);
      const p = await plan({ home: ctx.home, profiles });
      sendJson(res, 200, {
        dirty: p.dirty,
        errors: p.errors,
        warnings: p.warnings,
        files: p.ops.map((op) => ({
          label: op.label,
          kind: op.kind,
          diff: op.kind === 'unchanged' ? '' : unifiedDiff(op.before ?? '', op.after ?? ''),
        })),
      });
      return;
    }

    if (url.pathname === '/api/apply' && method === 'POST') {
      const body = (await readBody(req)) as { force?: boolean } | undefined;
      const profiles = await loadProfiles(ctx.home);
      const p = await plan({ home: ctx.home, profiles });
      if (p.errors.length > 0) {
        sendJson(res, 400, { error: 'plan has errors', errors: p.errors });
        return;
      }
      const result = await apply(p, { home: ctx.home, ...(body?.force ? { force: true } : {}) });
      sendJson(res, 200, { ...result, dirty: p.dirty });
      return;
    }

    if (url.pathname === '/api/doctor' && method === 'GET') {
      const profiles = await loadProfiles(ctx.home);
      const online = url.searchParams.get('online') === '1';
      const results = await runDoctor({ home: ctx.home, profiles, online });
      sendJson(res, 200, {
        results,
        errors: results.filter((r) => r.level === 'error').length,
        warnings: results.filter((r) => r.level === 'warn').length,
      });
      return;
    }

    if (url.pathname === '/api/fs' && method === 'GET') {
      const profiles = await loadProfiles(ctx.home);
      const dir = url.searchParams.get('dir') ?? undefined;
      const result = await browse({
        home: ctx.home,
        allowRoots: profiles.settings.allowRoots,
        ...(dir !== undefined ? { dir } : {}),
      });
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === '/api/rules' && method === 'POST') {
      const body = (await readBody(req)) as { dir?: string; identity?: string; add?: boolean; remove?: string };
      const profiles = await loadProfiles(ctx.home);
      if (body?.remove) {
        profiles.rules = profiles.rules.filter((r) => r.dir !== body.remove);
      } else if (body?.add && body.dir && body.identity) {
        const dir = normaliseRulePath(body.dir, ctx.home);
        if (!profiles.identities.some((i) => i.name === body.identity)) {
          sendJson(res, 400, { error: `unknown identity ${body.identity}` });
          return;
        }
        profiles.rules = profiles.rules.filter((r) => r.dir !== dir);
        profiles.rules.push({ dir, identity: body.identity });
      } else {
        sendJson(res, 400, { error: 'expected {add,dir,identity} or {remove}' });
        return;
      }
      await saveProfiles(ctx.home, profiles);
      sendJson(res, 200, profileSummary(ctx.home, profiles));
      return;
    }

    sendJson(res, 404, { error: 'unknown endpoint' });
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
  }
}
