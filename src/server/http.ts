/**
 * Local HTTP server for `gs gui`.
 *
 * Bound to 127.0.0.1 only. Every request passes Host, Origin and token checks
 * before it can touch the API; see auth.ts for the reasoning.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorize, createToken, hostIsAllowed, originIsAllowed } from './auth.ts';
import { browse } from './fs-browse.ts';
import { t, setLanguage, getLanguage, resolveLanguage, webCatalogue } from '../core/i18n.ts';
import { loadProfiles, parseProfilesText, saveProfiles, profilesExist } from '../core/profiles.ts';
import { plan } from '../core/plan.ts';
import { apply } from '../core/apply.ts';
import { runDoctor } from '../core/checks.ts';
import { resolveIdentity, sitesFor, type Profiles } from '../core/model.ts';
import { gsPaths, contractHome, normaliseRulePath, toPosix } from '../core/paths.ts';
import { unifiedDiff } from '../util/diff.ts';
import { writeFileAtomic } from '../util/fs-atomic.ts';
import { listKeys, generateKey, publicKeyFor, copyToClipboard } from '../core/keys.ts';
import { keysFromSnapshot, restoreKeys, readSnapshotFile } from '../core/key-restore.ts';
import {
  buildSnapshot,
  encryptSnapshot,
  decryptSnapshot,
  verifySnapshot,
  parseRemap,
  remapProfiles,
  assertNoPlaintextKeys,
} from '../core/snapshot.ts';
import { discover } from '../core/discover.ts';
import { buildProfiles } from '../commands/init.ts';

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
        t('gui.assetsMissing'),
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

      // The UI reads its strings from the catalogue so a single language switch
      // covers both CLI and browser.
      const requested = url.searchParams.get('lang');
      if (requested) setLanguage(resolveLanguage(requested));

      sendJson(res, 200, {
        home: contractHome(ctx.home, ctx.home),
        // A GUI started with --home looks identical to the real one. Tell the page
        // which home it is operating on so a user never mistakes a sandbox for
        // their live configuration.
        realHome: os.homedir(),
        isSandbox: path.resolve(ctx.home) !== path.resolve(os.homedir()),
        homePath: toPosix(ctx.home),
        language: getLanguage(),
        messages: webCatalogue(),
        profileExists: await profilesExist(ctx.home),
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

    if (url.pathname === '/api/identities' && method === 'POST') {
      const body = (await readBody(req)) as
        | {
            add?: boolean;
            name?: string;
            userName?: string;
            email?: string;
            sshKey?: string | null;
            host?: string;
            port?: number | string | null;
            alias?: string | null;
          }
        | undefined;
      const remove = url.searchParams.get('remove');

      const profiles = await loadProfiles(ctx.home);

      if (remove) {
        const inUse = profiles.rules.filter((r) => r.identity === remove).length;
        const isLast = profiles.identities.length <= 1;

        // A profile with no identity is invalid, so the last one is protected:
        // deleting it would leave every `gs` command unable to load the file.
        if (isLast) {
          sendJson(res, 409, {
            error: t('web.lastIdentity'),
            lastIdentity: true,
          });
          return;
        }

        if (inUse > 0) {
          // deleting would leave dangling rules; make the user acknowledge it
          const force = url.searchParams.get('force') === '1';
          if (!force) {
            sendJson(res, 409, {
              error: t('web.identityInUse', remove, inUse),
              rules: inUse,
            });
            return;
          }
          profiles.rules = profiles.rules.filter((r) => r.identity !== remove);
        }
        profiles.repositories = profiles.repositories.filter((r) => r.identity !== remove);
        profiles.identities = profiles.identities.filter((i) => i.name !== remove);
        profiles.sites = profiles.sites.filter((s) => s.identity !== remove);
        await saveProfiles(ctx.home, profiles);
        sendJson(res, 200, profileSummary(ctx.home, profiles));
        return;
      }

      if (body?.add) {
        const name = (body.name ?? '').trim();
        const userName = (body.userName ?? '').trim();
        const email = (body.email ?? '').trim();

        const problems: string[] = [];
        if (name === '') problems.push(`${t('web.identityName')}: ${t('web.required')}`);
        if (userName === '') problems.push(`${t('web.userName')}: ${t('web.required')}`);
        if (email === '') problems.push(`${t('web.userEmail')}: ${t('web.required')}`);
        if (name !== '' && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
          problems.push(`${t('web.identityName')}: ${t('web.invalidName')}`);
        }
        if (email !== '' && !/^[^\s@]+@[^\s@]+$/.test(email)) {
          problems.push(`${t('web.userEmail')}: ${t('web.invalidEmail')}`);
        }
        if (profiles.identities.some((i) => i.name === name)) {
          problems.push(t('web.duplicateIdentity', name));
        }
        if (problems.length > 0) {
          sendJson(res, 400, { error: t('web.invalidIdentity', problems.join('; ')), problems });
          return;
        }

        const keyRaw = (body.sshKey ?? '').trim();
        const identity: (typeof profiles.identities)[number] = {
          name,
          user: { name: userName, email },
        };
        if (keyRaw !== '') identity.sshKey = keyRaw;
        profiles.identities.push(identity);

        const host = (body.host ?? '').trim();
        if (host !== '') {
          const portRaw = body.port;
          const port =
            portRaw === null || portRaw === undefined || String(portRaw).trim() === ''
              ? undefined
              : Number.parseInt(String(portRaw), 10);
          if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
            profiles.identities = profiles.identities.filter((i) => i.name !== name);
            sendJson(res, 400, { error: t('web.invalidIdentity', `${t('web.sitePort')}: 1-65535`) });
            return;
          }
          const site: (typeof profiles.sites)[number] = { host, identity: name };
          if (port !== undefined) site.port = port;
          const alias = (body.alias ?? '').trim();
          if (alias !== '') site.alias = alias;
          profiles.sites.push(site);
        }

        // validate through the real schema before persisting: the GUI must not be
        // able to write a profile that `gs apply` would later reject
        try {
          await saveProfiles(ctx.home, profiles);
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
          return;
        }
        sendJson(res, 200, profileSummary(ctx.home, profiles));
        return;
      }

      sendJson(res, 400, { error: 'expected {add:…} or ?remove=<name>' });
      return;
    }

    /* ---------------- keys ---------------- */

    if (url.pathname === '/api/keys' && method === 'GET') {
      const profiles = await loadProfiles(ctx.home);
      const keys = await listKeys({ home: ctx.home, profiles });
      // never return key material: fingerprints and paths only
      sendJson(res, 200, {
        keys: keys.map((k) => ({
          name: k.name,
          type: k.type ?? null,
          fingerprint: k.fingerprint ?? null,
          comment: k.comment ?? null,
          hasPublic: k.hasPublic,
          usedBy: k.usedBy,
        })),
      });
      return;
    }

    if (url.pathname === '/api/keys' && method === 'POST') {
      const body = (await readBody(req)) as { action?: string; name?: string; comment?: string; snapshot?: string; force?: boolean } | undefined;
      const action = body?.action;

      if (action === 'copy') {
        const name = (body?.name ?? '').trim();
        if (name === '') {
          sendJson(res, 400, { error: 'name is required' });
          return;
        }
        const pub = await publicKeyFor(ctx.home, name);
        const copied = await copyToClipboard(pub);
        sendJson(res, 200, { copied, publicKey: copied ? undefined : pub });
        return;
      }

      if (action === 'generate') {
        const name = (body?.name ?? '').trim();
        if (name === '') {
          sendJson(res, 400, { error: 'name is required' });
          return;
        }
        const comment = (body?.comment ?? '').trim();
        const result = await generateKey({
          home: ctx.home,
          name,
          ...(comment !== '' ? { comment } : {}),
        });
        // the public key goes to the clipboard, the private one never leaves ~/.ssh
        const copied = await copyToClipboard(result.publicKey);
        sendJson(res, 200, {
          path: result.path,
          fingerprint: result.fingerprint ?? null,
          copied,
          publicKey: copied ? undefined : result.publicKey,
        });
        return;
      }

      if (action === 'restore') {
        const snapshotPath = (body?.snapshot ?? '').trim();
        if (snapshotPath === '') {
          sendJson(res, 400, { error: 'snapshot is required' });
          return;
        }
        const text = await readSnapshotFile(snapshotPath);
        if (text === undefined) {
          sendJson(res, 400, { error: t('snapshot.cannotRead', snapshotPath) });
          return;
        }
        let snapshot;
        try {
          if (text.trimStart().startsWith('{') && text.includes('"magic"')) {
            const passphrase = (body as { passphrase?: string }).passphrase ?? '';
            if (passphrase === '') {
              sendJson(res, 400, { error: 'passphrase is required for an encrypted snapshot' });
              return;
            }
            snapshot = await decryptSnapshot(text, passphrase);
          } else {
            snapshot = JSON.parse(text);
          }
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
          return;
        }
        const keys = keysFromSnapshot(snapshot as { files: { path: string; content: string }[] });
        if (keys.length === 0) {
          sendJson(res, 400, { error: t('key.noKeysInSnapshot') });
          return;
        }
        const result = await restoreKeys({ home: ctx.home, keys, ...(body?.force ? { force: true } : {}) });
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 400, { error: 'expected {action: copy|generate|restore}' });
      return;
    }

    /* ---------------- snapshots ---------------- */

    if (url.pathname === '/api/snapshot/export' && method === 'POST') {
      const body = (await readBody(req)) as
        | { path?: string; withKeys?: boolean; passphrase?: string; force?: boolean }
        | undefined;
      const profiles = await loadProfiles(ctx.home);
      const target = (body?.path ?? '').trim();

      const snapshot = await buildSnapshot({
        home: ctx.home,
        profiles,
        includeKeys: body?.withKeys === true,
      });

      let output: string;
      if (snapshot.manifest.containsKeys || (body?.passphrase ?? '') !== '') {
        const passphrase = body?.passphrase ?? '';
        if (passphrase === '') {
          sendJson(res, 400, { error: t('web.passphraseHint') });
          return;
        }
        output = await encryptSnapshot(snapshot, passphrase);
      } else {
        assertNoPlaintextKeys(snapshot);
        output = JSON.stringify(snapshot, null, 2);
      }

      const destination =
        target !== ''
          ? path.resolve(ctx.home, target)
          : path.join(gsPaths(ctx.home).snapshotsDir, `gs-snapshot-${Date.now()}.gsnap`);

      if (!body?.force) {
        const existing = await readFile(destination, 'utf8').catch(() => undefined);
        if (existing !== undefined) {
          sendJson(res, 409, { error: t('snapshot.exists', destination) });
          return;
        }
      }

      await mkdir(path.dirname(destination), { recursive: true });
      await writeFileAtomic(destination, output);
      sendJson(res, 200, {
        path: destination,
        files: snapshot.files.length,
        identities: profiles.identities.length,
        rules: profiles.rules.length,
        containsKeys: snapshot.manifest.containsKeys,
      });
      return;
    }

    if (url.pathname === '/api/snapshot/import' && method === 'POST') {
      const body = (await readBody(req)) as
        | { path?: string; passphrase?: string; remaps?: string; force?: boolean }
        | undefined;
      const source = (body?.path ?? '').trim();
      if (source === '') {
        sendJson(res, 400, { error: t('web.importPath') });
        return;
      }
      const text = await readSnapshotFile(path.resolve(ctx.home, source));
      if (text === undefined) {
        sendJson(res, 400, { error: t('snapshot.cannotRead', source) });
        return;
      }

      let snapshot;
      try {
        if (text.trimStart().startsWith('{') && text.includes('"magic"')) {
          snapshot = await decryptSnapshot(text, body?.passphrase ?? '');
        } else {
          snapshot = JSON.parse(text);
        }
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
        return;
      }

      const verdict = verifySnapshot(snapshot, ctx.home);
      if (!verdict.ok || !verdict.profiles) {
        sendJson(res, 400, { error: verdict.problems.join('; ') || 'invalid snapshot' });
        return;
      }

      const spec = (body?.remaps ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
      let mapped;
      try {
        mapped = remapProfiles(verdict.profiles, parseRemap(spec));
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
        return;
      }

      // importing replaces the profile; the caller has already confirmed
      await saveProfiles(ctx.home, mapped);
      sendJson(res, 200, {
        hasKeys: snapshot.manifest.containsKeys,
        ...profileSummary(ctx.home, mapped),
      });
      return;
    }

    /* ---------------- init ---------------- */

    if (url.pathname === '/api/init/scan' && method === 'POST') {
      const body = (await readBody(req)) as { root?: string; offline?: boolean } | undefined;
      const root = (body?.root ?? '').trim();
      const found = await discover({
        home: ctx.home,
        ...(root !== '' ? { scanRoots: [path.resolve(ctx.home, root)] } : {}),
        cwd: root !== '' ? path.resolve(ctx.home, root) : ctx.home,
      });
      const profiles = buildProfiles(found, {
        home: ctx.home,
        roots: root !== '' ? [path.resolve(ctx.home, root)] : [],
        groups: ['gitee', 'github', 'gitlab', 'bitbucket', 'company', 'work'],
      });
      sendJson(res, 200, {
        warnings: found.warnings,
        identities: profiles.identities.map((i) => ({
          name: i.name,
          email: i.user.email,
          sshKey: i.sshKey ?? null,
          sites: profiles.sites.filter((s) => s.identity === i.name).map((s) => s.host),
        })),
        rules: profiles.rules.map((r) => ({ dir: r.dir, identity: r.identity })),
      });
      return;
    }

    if (url.pathname === '/api/init/apply' && method === 'POST') {
      const body = (await readBody(req)) as { root?: string; offline?: boolean; force?: boolean } | undefined;
      if ((await profilesExist(ctx.home)) && !body?.force) {
        sendJson(res, 409, { error: t('web.initAlreadyExists') });
        return;
      }
      const root = (body?.root ?? '').trim();
      const found = await discover({
        home: ctx.home,
        ...(root !== '' ? { scanRoots: [path.resolve(ctx.home, root)] } : {}),
        cwd: root !== '' ? path.resolve(ctx.home, root) : ctx.home,
      });
      const profiles = buildProfiles(found, {
        home: ctx.home,
        roots: root !== '' ? [path.resolve(ctx.home, root)] : [],
        groups: ['gitee', 'github', 'gitlab', 'bitbucket', 'company', 'work'],
      });
      await saveProfiles(ctx.home, profiles);
      sendJson(res, 200, profileSummary(ctx.home, profiles));
      return;
    }

    sendJson(res, 404, { error: 'unknown endpoint' });
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
  }
}
