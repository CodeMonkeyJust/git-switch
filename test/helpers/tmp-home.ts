import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TmpHome {
  home: string;
  write(relPath: string, content: string): Promise<void>;
  read(relPath: string): Promise<string>;
  exists(relPath: string): Promise<boolean>;
  path(relPath: string): string;
  cleanup(): Promise<void>;
}

/**
 * Every test gets its own throw-away home directory. Nothing in this suite is
 * ever allowed to read or write the developer's real ~/.gitconfig or ~/.ssh.
 */
export async function createTmpHome(prefix = 'gs-test-'): Promise<TmpHome> {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const abs = (rel: string) => path.join(home, rel);
  return {
    home,
    path: abs,
    async write(rel, content) {
      const target = abs(rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    },
    read(rel) {
      return readFile(abs(rel), 'utf8');
    },
    async exists(rel) {
      try {
        await stat(abs(rel));
        return true;
      } catch {
        return false;
      }
    },
    cleanup() {
      return rm(home, { recursive: true, force: true });
    },
  };
}

export const PROFILE_GITHUB_GITEE = `schemaVersion: 1
identities:
  personal:
    user:
      name: alexchen
      email: alex@personal.example
    sshKey: id_ed25519_github
    sites:
      - host: github.com
        alias: gh
  work:
    user:
      name: Alex Chen
      email: alex@company.example
    sshKey: id_ed25519
    sites:
      - host: git.company.example
        port: 9092
        alias: work
rules:
  - dir: __HOME__/code/personal
    identity: personal
  - dir: __HOME__/code/work
    identity: work
settings:
  backupKeep: 5
`;
