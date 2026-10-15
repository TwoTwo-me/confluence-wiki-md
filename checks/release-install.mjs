import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const [archive, ...extra] = process.argv.slice(2);
assert.ok(archive && extra.length === 0, 'Pass the verified release archive.');
assert.ok(process.env.npm_execpath, 'Run this check with npm run test:release.');
const temporary = await mkdtemp(path.join(tmpdir(), 'cfwiki-release-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CONFLUENCE_|CFWIKI_|NPM_CONFIG_|npm_config_|NODE_AUTH_TOKEN$|NPM_TOKEN$|GH_TOKEN$|GITHUB_TOKEN$|ACTIONS_ID_TOKEN_)/.test(key)));
env.NPM_CONFIG_USERCONFIG = path.join(temporary, 'npmrc');
env.NPM_CONFIG_GLOBALCONFIG = path.join(temporary, 'global-npmrc');
env.NPM_CONFIG_CACHE = path.join(temporary, 'npm-cache');
env.NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/';
env.PUPPETEER_SKIP_DOWNLOAD = 'true';
env.XDG_CONFIG_HOME = path.join(temporary, 'config');
const run = (command, args) => exec(command, args, { cwd: temporary, env, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
const npm = (args) => run(process.execPath, [process.env.npm_execpath, ...args]);

try {
  await writeFile(env.NPM_CONFIG_USERCONFIG, '');
  await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
  const url = `https://github.com/TwoTwo-me/confluence-wiki-md/releases/download/v${manifest.version}/confluence-wiki-md.tgz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200, 'Public GitHub release archive must be downloadable without credentials.');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, await readFile(path.resolve(archive)), 'Public release archive differs from the verified package.');
  const prefix = path.join(temporary, 'global');
  await npm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', url]);
  const packageRoot = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', manifest.name);
  const installed = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(installed.version, manifest.version);
  const executable = process.platform === 'win32' ? process.execPath : path.join(prefix, 'bin/cfwiki');
  const cli = (args) => run(executable, [...(process.platform === 'win32' ? [path.join(packageRoot, manifest.bin.cfwiki)] : []), ...args]);
  assert.match((await cli(['--help'])).stdout, /Usage: cfwiki/);
  const result = JSON.parse((await cli(['skill', 'install', '--agent', 'all', '--project', path.join(temporary, 'project'), '--json'])).stdout);
  assert.equal(result.skills.length, 4);
  for (const skill of result.skills) assert.deepEqual(await readFile(path.join(skill.destination, 'SKILL.md')), await readFile(path.join(packageRoot, 'skills/confluence-wiki/SKILL.md')));
  assert.match((await npm(['exec', '--yes', '--package=' + url, '--', 'cfwiki', '--help'])).stdout, /Usage: cfwiki/);
  process.stdout.write(JSON.stringify({ url, authentication: 'none', archiveBytes: bytes.length, install: 'passed', multiAgentSkillInstall: 'passed', oneShotExecution: 'passed' }, null, 2) + '\n');
} finally { await rm(temporary, { recursive: true, force: true }); }
