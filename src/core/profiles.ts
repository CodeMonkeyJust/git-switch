import { ModelError, fromYaml, toYaml, type Profiles } from './model.ts';
import { parse, stringify, YamlError, type YamlValue } from './yaml.ts';
import { gsPaths } from './paths.ts';
import { exists, readFileIfExists, writeFileAtomic } from '../util/fs-atomic.ts';

export class ProfilesMissingError extends Error {
  readonly file: string;

  constructor(file: string) {
    super(`no profile found at ${file}.\nRun \`gs init\` to create one from your current configuration.`);
    this.name = 'ProfilesMissingError';
    this.file = file;
  }
}

export async function loadProfiles(home: string, cwd = process.cwd()): Promise<Profiles> {
  const paths = gsPaths(home);
  const text = await readFileIfExists(paths.profiles);
  if (text === undefined) throw new ProfilesMissingError(paths.profiles);
  return parseProfilesText(text, home, cwd);
}

export function parseProfilesText(text: string, home: string, cwd = process.cwd()): Profiles {
  let raw: { [key: string]: YamlValue };
  try {
    raw = parse(text);
  } catch (err) {
    if (err instanceof YamlError) throw new ModelError(err.message, 'profiles.yaml');
    throw err;
  }
  return fromYaml(raw, { home, cwd });
}

export async function saveProfiles(home: string, profiles: Profiles): Promise<void> {
  const paths = gsPaths(home);
  await writeFileAtomic(paths.profiles, stringify(toYaml(profiles)));
}

export async function profilesExist(home: string): Promise<boolean> {
  return exists(gsPaths(home).profiles);
}

export async function readProfilesRaw(home: string): Promise<string | undefined> {
  return readFileIfExists(gsPaths(home).profiles);
}
