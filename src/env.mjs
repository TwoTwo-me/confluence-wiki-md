import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

export function defaultEnvPath(env = process.env) {
  const directory = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(homedir(), '.config');
  return path.join(directory, 'cfwiki', '.env');
}

export async function loadProfile(filename, env = process.env) {
  const explicit = filename !== undefined;
  let fileEnv = {};
  try { fileEnv = parseEnv(await readFile(explicit ? filename : defaultEnvPath(env), 'utf8')); }
  catch (error) { if (explicit || error.code !== 'ENOENT') throw error; }
  if (!explicit) return { ...fileEnv, ...env };
  const inherited = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('CONFLUENCE_')));
  return { ...inherited, ...fileEnv };
}
