import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, parseEnv } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'cfwiki-package-'));
const [outputDirectory, ...extra] = process.argv.slice(2);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this check with npm run test:package.');
assert.equal(extra.length, 0, 'Expected at most one output directory.');

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(CONFLUENCE_|CFWIKI_|NPM_CONFIG_|npm_config_|NODE_AUTH_TOKEN$|NPM_TOKEN$|ACTIONS_ID_TOKEN_)/.test(key)));
env.PUPPETEER_SKIP_DOWNLOAD = 'true';
env.NPM_CONFIG_USERCONFIG = path.join(temporary, 'npmrc');
env.NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/';
const run = (command, args, cwd = temporary) => exec(command, args, { cwd, env, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd);

try {
  await writeFile(env.NPM_CONFIG_USERCONFIG, '');
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.private, undefined, 'The package must be publishable.');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const packed = JSON.parse((await npm(['pack', '--json', '--pack-destination', temporary], root)).stdout)[0];
  const allowed = /^(?:package\.json|README\.md|\.env(?:\.cloud|\.company)?\.example|scripts\/confluence\.mjs|src\/[a-z-]+\.mjs|examples\/[a-z-]+\.md|examples\/sample\.svg|skills\/confluence-wiki\/(?:SKILL\.md|agents\/openai\.yaml))$/;
  for (const file of packed.files) assert.match(file.path, allowed, 'Unexpected published file: ' + file.path);
  for (const required of ['src/diagram-worker.mjs', '.env.cloud.example', '.env.company.example', 'skills/confluence-wiki/SKILL.md', 'examples/getting-started.md']) {
    assert.ok(packed.files.some((file) => file.path === required), 'Missing published file: ' + required);
  }
  const tarball = path.join(temporary, packed.filename);
  const prefix = path.join(temporary, 'global');
  await npm(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball]);
  const packageRoot = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', manifest.name);
  const installed = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(installed.version, manifest.version);
  const executable = process.platform === 'win32' ? process.execPath : path.join(prefix, 'bin', 'cfwiki');
  const cli = (args) => run(executable, process.platform === 'win32' ? [path.join(packageRoot, manifest.bin.cfwiki), ...args] : args);
  assert.match((await cli(['--help'])).stdout, /Usage: cfwiki/);
  const example = path.join(temporary, 'guide.md');
  await copyFile(path.join(packageRoot, 'examples/getting-started.md'), example);
  assert.equal(JSON.parse((await cli(['validate', example, '--json'])).stdout).valid, true);
  const storage = path.join(temporary, 'page.xml');
  await cli(['convert', example, '--to', 'storage', '-o', storage]);
  assert.match(await readFile(storage, 'utf8'), /<h1>Markdown wiki quickstart<\/h1>/);
  const markdown = path.join(temporary, 'roundtrip.md');
  await cli(['convert', storage, '--to', 'markdown', '-o', markdown]);
  assert.match(await readFile(markdown, 'utf8'), /# Markdown wiki quickstart/);
  for (const profile of ['cloud', 'company']) {
    const config = parseEnv(await readFile(path.join(packageRoot, '.env.' + profile + '.example'), 'utf8'));
    assert.equal(config.CONFLUENCE_DEPLOYMENT, profile === 'cloud' ? 'cloud' : 'datacenter');
    assert.equal(config[profile === 'cloud' ? 'CONFLUENCE_API_TOKEN' : 'CONFLUENCE_PAT'], '');
  }
  await access(path.join(packageRoot, 'src/diagram-worker.mjs'));
  assert.match(await readFile(path.join(packageRoot, 'skills/confluence-wiki/SKILL.md'), 'utf8'), /name: confluence-wiki/);
  const bytes = await readFile(tarball);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (outputDirectory) {
    const destination = path.resolve(outputDirectory);
    await mkdir(destination, { recursive: true });
    await copyFile(tarball, path.join(destination, 'confluence-wiki-md.tgz'));
    await writeFile(path.join(destination, 'SHA256SUMS'), sha256 + '  confluence-wiki-md.tgz\n');
  }
  process.stdout.write(JSON.stringify({ name: manifest.name, version: manifest.version, files: packed.files.map((file) => file.path), bytes: bytes.length, sha256, checks: ['global CLI installation outside checkout', 'Markdown validation and conversion round trip', 'Cloud/PAT templates without credentials', 'agent skill and diagram worker included'] }, null, 2) + '\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
