/**
 * Portable snapshots.
 *
 * A snapshot carries everything needed to reproduce a `gs` setup on another
 * machine, and nothing that would be dangerous if it leaked:
 *
 *   manifest.json            schema version, counts, sha256 of every file
 *   profiles.yaml            the single source of truth
 *   ssh/config.managed       only the gs block, never the user's own entries
 *   identities/*.gitconfig   generated configs (regenerated on import anyway)
 *   keys/*                   OPTIONAL, only with --with-keys, always encrypted
 *
 * Encryption is scrypt (N=16384) + AES-256-GCM over the whole archive. The
 * passphrase is never written to disk and never echoed to the terminal.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ScryptOptions } from 'node:crypto';
import type { Profiles } from './model.ts';
import { toYaml } from './model.ts';
import { parseProfilesText } from './profiles.ts';
import { stringify } from './yaml.ts';
import { findBlock } from './managed-block.ts';
import { gsPaths, toPosix } from './paths.ts';
import { exists } from '../util/fs-atomic.ts';
import { listPrivateKeys } from './keys.ts';

/**
 * Promise wrapper for `crypto.scrypt` that keeps the options argument typed.
 * `promisify` loses the 4-argument overload, which matters for the KDF cost
 * parameters used below.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export const SNAPSHOT_FORMAT = 'gs-snapshot';
export const SNAPSHOT_VERSION = 1;
const MAGIC = 'GSNAP1';

export interface SnapshotFile {
  path: string;
  content: string;
  sha256: string;
  /** private keys are only included when explicitly requested */
  secret?: boolean;
}

export interface Manifest {
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  createdAt: string;
  sourceHome: string;
  containsKeys: boolean;
  files: { path: string; sha256: string; secret?: boolean }[];
}

export interface Snapshot {
  manifest: Manifest;
  files: SnapshotFile[];
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ */
/* building a snapshot                                                 */
/* ------------------------------------------------------------------ */

export interface BuildOptions {
  home: string;
  profiles: Profiles;
  includeKeys?: boolean;
  /** directories to strip of machine-specific prefixes are handled on import */
  now?: Date;
}

export async function buildSnapshot(opts: BuildOptions): Promise<Snapshot> {
  const { home, profiles } = opts;
  const paths = gsPaths(home);
  const files: SnapshotFile[] = [];

  const pushFile = (relPath: string, content: string, secret = false) => {
    files.push({ path: relPath, content, sha256: sha256(content), ...(secret ? { secret: true } : {}) });
  };

  // the profile is re-serialised from the parsed model so the snapshot is
  // canonical and cannot carry over accidental formatting surprises
  pushFile('profiles.yaml', stringify(toYaml(profiles)));

  // only the managed block of the ssh config: the rest is the user's business
  const sshConfigPath = paths.sshConfig;
  if (await exists(sshConfigPath)) {
    const text = await readFile(sshConfigPath, 'utf8').catch(() => '');
    try {
      const block = findBlock(text);
      if (block.present) pushFile('ssh/config.managed', block.content);
    } catch {
      // an unreadable block is skipped rather than aborting the export
    }
  }

  // generated identity configs live under ~/.config/gs/identities
  if (await exists(paths.identitiesDir)) {
    const entries = await readdir(paths.identitiesDir).catch(() => []);
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.gitconfig')) continue;
      const content = await readFile(path.join(paths.identitiesDir, entry), 'utf8').catch(() => '');
      if (content) pushFile(`identities/${entry}`, content);
    }
  }

  let containsKeys = false;
  if (opts.includeKeys) {
    for (const keyName of await listPrivateKeys(home)) {
      const file = path.join(home, '.ssh', keyName);
      const content = await readFile(file, 'utf8').catch(() => '');
      if (content) {
        pushFile(`keys/${keyName}`, content, true);
        containsKeys = true;
      }
      const pub = await readFile(`${file}.pub`, 'utf8').catch(() => '');
      if (pub) pushFile(`keys/${keyName}.pub`, pub);
    }
  }

  const manifest: Manifest = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt: (opts.now ?? new Date()).toISOString(),
    sourceHome: toPosix(home),
    containsKeys,
    files: files.map((f) => ({
      path: f.path,
      sha256: f.sha256,
      ...(f.secret ? { secret: true } : {}),
    })),
  };

  return { manifest, files };
}

/* ------------------------------------------------------------------ */
/* encryption                                                          */
/* ------------------------------------------------------------------ */

/** Refuse to export anything that looks like a plain-text private key. */
export function assertNoPlaintextKeys(snapshot: Snapshot): void {
  for (const file of snapshot.files) {
    if (file.secret) continue;
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(file.content)) {
      throw new Error(
        `${file.path} contains private key material; snapshots never include keys unless ` +
          `--with-keys is used, and those are always encrypted`,
      );
    }
  }
}

interface EncryptedEnvelope {
  magic: string;
  kdf: { name: string; N: number; r: number; p: number; salt: string };
  cipher: { name: string; iv: string; tag: string };
  payload: string;
}

const KDF_N = 16384;
const KDF_R = 8;
const KDF_P = 1;

export async function encryptSnapshot(snapshot: Snapshot, passphrase: string): Promise<string> {
  if (passphrase.length < 8) {
    throw new Error('passphrase must be at least 8 characters');
  }
  assertNoPlaintextKeys(snapshot);

  const salt = randomBytes(16);
  const key = (await scryptAsync(passphrase, salt, 32, { N: KDF_N, r: KDF_R, p: KDF_P }));
  const iv = randomBytes(12);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify({ manifest: snapshot.manifest, files: snapshot.files });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: EncryptedEnvelope = {
    magic: MAGIC,
    kdf: { name: 'scrypt', N: KDF_N, r: KDF_R, p: KDF_P, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64') },
    payload: encrypted.toString('base64'),
  };
  return JSON.stringify(envelope, null, 2);
}

export async function decryptSnapshot(text: string, passphrase: string): Promise<Snapshot> {
  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(text) as EncryptedEnvelope;
  } catch {
    throw new Error('not a gs snapshot file');
  }
  if (envelope.magic !== MAGIC) throw new Error('not a gs snapshot file');
  if (envelope.kdf?.name !== 'scrypt' || envelope.cipher?.name !== 'aes-256-gcm') {
    throw new Error('unsupported snapshot encryption');
  }

  const salt = Buffer.from(envelope.kdf.salt, 'base64');
  const key = (await scryptAsync(passphrase, salt, 32, {
    N: envelope.kdf.N,
    r: envelope.kdf.r,
    p: envelope.kdf.p,
  })) as Buffer;

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.cipher.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.cipher.tag, 'base64'));

  let plaintext: string;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.payload, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('wrong passphrase or corrupted snapshot');
  }

  return JSON.parse(plaintext) as Snapshot;
}

/* ------------------------------------------------------------------ */
/* validating an imported snapshot                                     */
/* ------------------------------------------------------------------ */

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  profiles?: Profiles;
}

export function verifySnapshot(snapshot: Snapshot, home: string): VerifyResult {
  const problems: string[] = [];
  const { manifest } = snapshot;

  if (manifest.format !== SNAPSHOT_FORMAT) problems.push('wrong manifest format');
  if (manifest.version !== SNAPSHOT_VERSION) {
    problems.push(`unsupported snapshot version ${manifest.version}`);
  }

  const byPath = new Map(snapshot.files.map((f) => [f.path, f]));
  for (const entry of manifest.files) {
    const file = byPath.get(entry.path);
    if (!file) {
      problems.push(`${entry.path} is listed in the manifest but missing`);
      continue;
    }
    if (sha256(file.content) !== entry.sha256) problems.push(`${entry.path} does not match its checksum`);
  }

  const profile = byPath.get('profiles.yaml');
  if (!profile) {
    problems.push('snapshot has no profiles.yaml');
    return { ok: false, problems };
  }

  let profiles: Profiles | undefined;
  try {
    profiles = parseProfilesText(profile.content, home);
  } catch (err) {
    problems.push(`profiles.yaml is invalid: ${(err as Error).message}`);
  }

  return { ok: problems.length === 0, problems, ...(profiles ? { profiles } : {}) };
}

/* ------------------------------------------------------------------ */
/* path remapping                                                      */
/* ------------------------------------------------------------------ */

/** `D:/CODE=/home/me/code` -> [['D:/CODE', '/home/me/code']] */
export function parseRemap(specs: string[]): [string, string][] {
  return specs.map((spec) => {
    const index = spec.indexOf('=');
    if (index <= 0) throw new Error(`invalid --remap "${spec}": expected OLD=NEW`);
    const from = spec.slice(0, index).trim();
    const to = spec.slice(index + 1).trim();
    if (!from || !to) throw new Error(`invalid --remap "${spec}": expected OLD=NEW`);
    return [from.replace(/\\/g, '/').replace(/\/+$/, ''), to.replace(/\\/g, '/').replace(/\/+$/, '')];
  });
}

export function remapPath(p: string, remaps: [string, string][]): string {
  const normalised = p.replace(/\\/g, '/');
  for (const [from, to] of remaps) {
    if (normalised === from) return to;
    if (normalised.startsWith(`${from}/`)) return to + normalised.slice(from.length);
  }
  return normalised;
}

/** Apply remaps to every directory-bearing field of a profile. */
export function remapProfiles(profiles: Profiles, remaps: [string, string][]): Profiles {
  if (remaps.length === 0) return profiles;
  return {
    ...profiles,
    rules: profiles.rules.map((r) => ({ ...r, dir: remapPath(r.dir, remaps) })),
    repositories: profiles.repositories.map((r) => ({ ...r, path: remapPath(r.path, remaps) })),
    settings: {
      ...profiles.settings,
      allowRoots: profiles.settings.allowRoots.map((r) => remapPath(r, remaps)),
    },
  };
}
