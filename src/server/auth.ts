/**
 * Authentication for the local GUI.
 *
 * The server binds to 127.0.0.1, but a browser on the same machine is still a
 * hostile place: any web page can attempt requests to localhost. So the token is
 * per-process and validated on every request, and Host/Origin are checked to
 * defeat DNS rebinding.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface AuthContext {
  token: string;
  port: number;
}

export function createToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison; length differences are treated as failure. */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Reject requests whose Host header is not our own loopback authority.
 *
 * Without this an attacker can point `evil.example` at 127.0.0.1 in their DNS
 * and have the browser treat our API as same-origin (DNS rebinding).
 */
export function hostIsAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader.trim());
  if (!match) return false;
  const hostname = (match[1] ?? '').toLowerCase();
  if (!ALLOWED_HOSTNAMES.has(hostname)) return false;
  const hostPort = match[2] ? Number.parseInt(match[2], 10) : 80;
  return hostPort === port;
}

/**
 * Accept requests with no Origin (same-document fetch in some browsers) and
 * requests whose Origin is our own authority. Everything else is cross-origin.
 */
export function originIsAllowed(originHeader: string | undefined, port: number): boolean {
  if (!originHeader) return true;
  let url: URL;
  try {
    url = new URL(originHeader);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTNAMES.has(hostname)) return false;
  const originPort = url.port ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
  return originPort === port;
}

export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export interface AuthorizeResult {
  ok: boolean;
  reason?: string;
  status?: number;
}

export function authorize(req: RequestLike, token: string, port: number): AuthorizeResult {
  if (!hostIsAllowed(headerValue(req.headers.host), port)) {
    return { ok: false, status: 403, reason: 'invalid Host header' };
  }
  if (!originIsAllowed(headerValue(req.headers.origin), port)) {
    return { ok: false, status: 403, reason: 'cross-origin request rejected' };
  }
  if (!tokenMatches(token, headerValue(req.headers['x-gs-token']))) {
    return { ok: false, status: 401, reason: 'missing or invalid token' };
  }
  return { ok: true };
}
