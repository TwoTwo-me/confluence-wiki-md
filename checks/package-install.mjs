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
env.XDG_CONFIG_HOME = path.join(temporary, 'config');
env.NPM_CONFIG_USERCONFIG = path.join(temporary, 'npmrc');
env.NPM_CONFIG_GLOBALCONFIG = path.join(temporary, 'global-npmrc');
env.NPM_CONFIG_CACHE = path.join(temporary, 'npm-cache');
env.NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/';
const run = (command, args, cwd = temporary, overrides = {}) => exec(command, args, { cwd, env: { ...env, ...overrides }, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd);

try {
  await writeFile(env.NPM_CONFIG_USERCONFIG, '');
  await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.private, undefined, 'The package must be publishable.');
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/');
  assert.equal(manifest.publishConfig.access, 'public');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const packed = JSON.parse((await npm(['pack', '--json', '--pack-destination', temporary], root)).stdout)[0];
  const allowed = /^(?:package\.json|README\.md|\.env(?:\.cloud|\.company)?\.example|scripts\/(?:confluence|skill)\.mjs|src\/[a-z-]+\.mjs|docs\/(?:installation|token-benchmark)\.md|docs\/benchmarks\/[a-z0-9.-]+\.json|examples\/[a-z-]+\.md|examples\/wiki-template\.yaml|examples\/sample\.svg|skills\/confluence-wiki\/(?:SKILL\.md|references\/[a-z0-9-]+\.md|agents\/openai\.yaml))$/;
  for (const file of packed.files) assert.match(file.path, allowed, 'Unexpected published file: ' + file.path);
  for (const required of ['scripts/skill.mjs', 'src/skill-install.mjs', 'docs/installation.md', 'docs/token-benchmark.md', 'src/agent-edit.mjs', 'src/comments.mjs', 'src/evidence.mjs', 'src/explore.mjs', 'src/merge.mjs', 'src/restrictions.mjs', 'src/storage-links.mjs', 'src/wiki-init.mjs', 'src/wiki-term.mjs', 'src/diagram-worker.mjs', 'src/env.mjs', 'src/templates.mjs', 'src/native-templates.mjs', '.env.cloud.example', '.env.company.example', 'skills/confluence-wiki/SKILL.md', 'examples/getting-started.md', 'examples/wiki-template.yaml']) {
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
  const help = (await cli(['--help'])).stdout;
  assert.match(help, /Usage: cfwiki/);
  for (const command of ['comments', 'restrictions', 'init', 'create', 'lookup', 'read', 'apply', 'explore', 'upload', 'push', 'export']) {
    assert.match(help, new RegExp('^  ' + command + '\\s', 'm'));
  }
  await assert.rejects(cli(['comments', 'delete', '42', '--version', '1']), (error) => /requires --yes/.test(error.stderr));
  await assert.rejects(cli(['restrictions', 'set', '42', '--restrictions', 'invalid']), (error) => /Restrictions must be/.test(error.stderr));
  for (const file of ['README.md', 'skills/confluence-wiki/SKILL.md']) {
    assert.deepEqual(await readFile(path.join(packageRoot, file)), await readFile(path.join(root, file)));
  }
  const skillProject = path.join(temporary, 'agent-project');
  const skills = JSON.parse((await cli(['skill', 'install', '--agent', 'all', '--project', skillProject, '--json'])).stdout);
  for (const skill of skills.skills) {
    assert.equal(skill.action, 'install');
    assert.deepEqual(await readFile(path.join(skill.destination, 'SKILL.md')), await readFile(path.join(packageRoot, 'skills/confluence-wiki/SKILL.md')));
  }
  const repeated = JSON.parse((await cli(['skill', 'install', '--agent', 'all', '--project', skillProject, '--json'])).stdout);
  assert.ok(repeated.skills.every((skill) => skill.action === 'unchanged'));
  const skillExecutable = path.join(prefix, process.platform === 'win32' ? 'node_modules/' + manifest.name + '/' + manifest.bin['cfwiki-skill'] : 'bin/cfwiki-skill');
  const skillPaths = await run(process.platform === 'win32' ? process.execPath : skillExecutable, [...(process.platform === 'win32' ? [skillExecutable] : []), 'paths', '--agent', 'all', '--project', skillProject, '--json']);
  assert.equal(JSON.parse(skillPaths.stdout).skills.length, 4);
  const oneShot = await npm(['exec', '--yes', '--package=' + tarball, '--', 'cfwiki', '--help']);
  assert.match(oneShot.stdout, /Usage: cfwiki/);
  const oneShotSkill = await npm(['exec', '--yes', '--package=' + tarball, '--', 'cfwiki-skill', 'paths', '--agent', 'codex', '--project', skillProject, '--json']);
  assert.equal(JSON.parse(oneShotSkill.stdout).skills[0].agent, 'codex');
  const workflows = await run(process.execPath, [
    '--test', '--test-reporter=tap',
    '--test-name-pattern=CLI init create explore and term lifecycle|CLI reports unknown root create|CLI explore keeps host assessment|CLI rejects root deletion and foreign evidence|CLI scoped read|CLI lookup|CLI supports create, Markdown download|bundle push resolves cyclic',
    path.join(root, 'test/confluence.test.mjs'), path.join(root, 'test/wiki.test.mjs'),
  ], temporary, { CFWIKI_TEST_ENTRY: path.join(packageRoot, manifest.bin.cfwiki) });
  process.stdout.write(workflows.stdout);
  assert.equal(workflows.stderr, '');
  const example = path.join(temporary, 'guide.md');
  await copyFile(path.join(packageRoot, 'examples/getting-started.md'), example);
  assert.equal(JSON.parse((await cli(['validate', example, '--json'])).stdout).valid, true);
  assert.equal(JSON.parse((await cli(['status', example, '--json'])).stdout).bodyStatus, 'unknown');
  const storage = path.join(temporary, 'page.xml');
  await cli(['convert', example, '--to', 'storage', '-o', storage]);
  assert.match(await readFile(storage, 'utf8'), /<h1>Markdown wiki quickstart<\/h1>/);
  const templateOutput = await cli(['convert', example, '--to', 'storage', '--template', path.join(packageRoot, 'examples/wiki-template.yaml')]);
  assert.match(templateOutput.stdout, /^<ac:structured-macro ac:name="toc"/);
  assert.match(templateOutput.stdout, /ac:name="maxLevel">3/);
  const markdown = path.join(temporary, 'roundtrip.md');
  await cli(['convert', storage, '--to', 'markdown', '-o', markdown]);
  assert.match(await readFile(markdown, 'utf8'), /# Markdown wiki quickstart/);
  const body = '# Installed body status\n';
  const baseline = 'sha256:' + createHash('sha256').update(body).digest('hex');
  const tracked = '---\nconfluence:\n  base_body_hash: ' + baseline + '\n---\n' + body;
  await writeFile(markdown, tracked);
  assert.equal(JSON.parse((await cli(['status', markdown, '--json'])).stdout).bodyStatus, 'unchanged');
  await writeFile(markdown, tracked + '\nA local edit.\n');
  assert.equal(JSON.parse((await cli(['status', markdown, '--json'])).stdout).bodyStatus, 'modified');
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
  process.stdout.write(JSON.stringify({ name: manifest.name, version: manifest.version, files: packed.files.map((file) => file.path), bytes: bytes.length, sha256, checks: ['global CLI installation outside checkout without registry authentication', 'one-shot npm exec CLI and skill bins', 'copied skills for Codex, Claude, OpenCode and Cursor with idempotent reinstall', 'Cloud/DC installed root, term, evidence and refusal workflows', 'installed legacy upload and cyclic bundle workflows', 'installed README and skill equal shipped source bytes', 'Markdown validation and conversion round trip', 'Cloud/PAT templates without credentials', 'agent skill and diagram worker included'] }, null, 2) + '\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
  await assert.rejects(access(temporary), { code: 'ENOENT' });
}
