import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const [archive, ...extra] = process.argv.slice(2);
assert.ok(archive && extra.length === 0, 'Pass the verified release archive.');
assert.ok(process.env.npm_execpath, 'Run this check with npm run test:registry.');
assert.ok(process.env.NODE_AUTH_TOKEN, 'A GitHub token with read:packages is required.');
assert.equal(manifest.name, '@twotwo-me/confluence-wiki-md');
const expectedIntegrity = 'sha512-' + createHash('sha512').update(await readFile(path.resolve(archive))).digest('base64');
const temporary = await mkdtemp(path.join(tmpdir(), 'cfwiki-registry-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CONFLUENCE_|CFWIKI_|NPM_CONFIG_|npm_config_)/.test(key)));
env.NPM_CONFIG_USERCONFIG = path.join(temporary, 'npmrc');
env.PUPPETEER_SKIP_DOWNLOAD = 'true';
env.XDG_CONFIG_HOME = path.join(temporary, 'config');
const npm = (args) => exec(process.execPath, [process.env.npm_execpath, ...args], { cwd: temporary, env, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });

try {
  await writeFile(env.NPM_CONFIG_USERCONFIG, 'registry=https://registry.npmjs.org/\n@twotwo-me:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n', { mode: 0o600 });
  const spec = manifest.name + '@' + manifest.version;
  const publishedIntegrity = JSON.parse((await npm(['view', spec, 'dist.integrity', '--json'])).stdout);
  assert.equal(publishedIntegrity, expectedIntegrity, 'Registry package differs from the verified release archive.');
  const prefix = path.join(temporary, 'global');
  await npm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', spec]);
  const packageRoot = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', manifest.name);
  const installed = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(installed.name, manifest.name);
  assert.equal(installed.version, manifest.version);
  const executable = process.platform === 'win32' ? process.execPath : path.join(prefix, 'bin', 'cfwiki');
  const cli = (args) => exec(executable, process.platform === 'win32' ? [path.join(packageRoot, manifest.bin.cfwiki), ...args] : args, { cwd: temporary, env, timeout: 30000 });
  assert.match((await cli(['--help'])).stdout, /Usage: cfwiki/);
  const example = path.join(packageRoot, 'examples/getting-started.md');
  assert.equal(JSON.parse((await cli(['validate', example, '--json'])).stdout).valid, true);
  assert.equal(JSON.parse((await cli(['status', example, '--json'])).stdout).bodyStatus, 'unknown');
  process.stdout.write(JSON.stringify({ package: spec, registry: 'https://npm.pkg.github.com/', integrity: publishedIntegrity, install: 'passed', help: 'passed', markdownValidation: 'passed', localStatus: 'passed' }, null, 2) + '\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
