import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultEnvPath } from '../src/env.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/confluence.mjs', import.meta.url));

test('default path uses the home config directory unless XDG_CONFIG_HOME is absolute', () => {
  assert.equal(defaultEnvPath({}), path.join(homedir(), '.config', 'cfwiki', '.env'));
  assert.equal(defaultEnvPath({ XDG_CONFIG_HOME: 'relative-config' }), path.join(homedir(), '.config', 'cfwiki', '.env'));
  assert.equal(defaultEnvPath({ XDG_CONFIG_HOME: tmpdir() }), path.join(tmpdir(), 'cfwiki', '.env'));
});

async function fixture(t, deployment = 'datacenter') {
  const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-default-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configHome = path.join(directory, 'config');
  const filename = path.join(configHome, 'cfwiki', '.env');
  await mkdir(path.dirname(filename), { recursive: true });
  const requests = [];
  const cloud = deployment === 'cloud';
  const authorization = cloud ? 'Basic ' + Buffer.from('fixture@example.test:fixture-token').toString('base64') : 'Bearer fixture-token';
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    const valid = req.headers.authorization === authorization;
    res.writeHead(valid ? 200 : 403, { 'content-type': 'application/json' });
    const space = { id: '7', key: 'TEST', name: 'Default profile' };
    res.end(JSON.stringify(valid ? cloud ? { results: [space] } : space : {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const profile = {
    CONFLUENCE_DEPLOYMENT: deployment,
    CONFLUENCE_AUTH: cloud ? 'basic' : 'bearer',
    CONFLUENCE_SITE_URL: 'http://127.0.0.1:' + server.address().port,
    CONFLUENCE_ALLOW_HTTP: 'true',
    CONFLUENCE_SPACE_KEY: 'TEST',
    ...(cloud ? { CONFLUENCE_EMAIL: 'fixture@example.test', CONFLUENCE_API_TOKEN: 'fixture-token' } : { CONFLUENCE_PAT: 'fixture-token' }),
  };
  const content = Object.entries(profile).map(([key, value]) => key + '=' + value).join('\n');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CONFLUENCE_'))), XDG_CONFIG_HOME: configHome };
  const run = (args, cwd = directory, overrides = {}) => exec(process.execPath, [cli, ...args], { cwd, env: { ...env, ...overrides }, timeout: 10000 });
  return { directory, filename, content, profile, requests, run };
}

for (const deployment of ['cloud', 'datacenter']) {
  test(deployment + ' default profile works across working directories and ignores their .env files', async (t) => {
    const f = await fixture(t, deployment);
    await writeFile(f.filename, f.content);
    for (const name of ['first', 'second']) {
      const directory = path.join(f.directory, name);
      await mkdir(directory);
      await writeFile(path.join(directory, '.env'), 'CONFLUENCE_SITE_URL=invalid-working-directory-profile\n');
      const result = await f.run(['doctor', '--json'], directory);
      assert.equal(JSON.parse(result.stdout).deployment, deployment);
      assert.doesNotMatch(result.stdout + result.stderr, /fixture-token/);
    }
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every((request) => request.url === (deployment === 'cloud' ? '/wiki/api/v2/spaces?keys=TEST' : '/rest/api/space/TEST')));
  });
}

test('explicit profiles override the default without merging it or ambient credentials', async (t) => {
  const f = await fixture(t);
  await writeFile(f.filename, 'CONFLUENCE_API_TOKEN=wrong-default-token\n');
  const explicit = path.join(f.directory, '.env.company');
  await writeFile(explicit, f.content);
  const result = await f.run(['doctor', '--env', explicit, '--json'], f.directory, { CONFLUENCE_API_TOKEN: 'wrong-ambient-token', CONFLUENCE_AUTH: 'basic' });
  assert.equal(JSON.parse(result.stdout).auth, 'bearer');
  await assert.rejects(f.run(['doctor', '--env', path.join(f.directory, 'missing.env')]), /ENOENT/);
  assert.equal(f.requests.length, 1);
});

test('a missing default never falls back to the working directory but allows environment-only and local commands', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, '.env'), f.content);
  await assert.rejects(f.run(['doctor']), /Missing CONFLUENCE_SITE_URL/);
  assert.equal(f.requests.length, 0);
  assert.equal(JSON.parse((await f.run(['doctor', '--json'], f.directory, f.profile)).stdout).authenticated, true);
  const markdown = path.join(f.directory, 'guide.md');
  await writeFile(markdown, '# Local document\n');
  assert.equal(JSON.parse((await f.run(['validate', markdown, '--json'])).stdout).valid, true);
  assert.equal(f.requests.length, 1);
});

test('process environment overrides default values, and unreadable default paths fail rather than falling back', async (t) => {
  const f = await fixture(t);
  await writeFile(f.filename, f.content.replace('fixture-token', 'wrong-file-token'));
  assert.equal(JSON.parse((await f.run(['doctor', '--json'], f.directory, { CONFLUENCE_PAT: 'fixture-token' })).stdout).authenticated, true);
  await rm(f.filename);
  await mkdir(f.filename);
  await assert.rejects(f.run(['doctor'], f.directory, f.profile), /EISDIR/);
  assert.equal(f.requests.length, 1);
});

test('default template follows its env profile across directories and explicit template selection wins', async (t) => {
  const f = await fixture(t);
  await writeFile(f.filename, f.content + '\nCONFLUENCE_TEMPLATE=wiki.yaml\n');
  await writeFile(path.join(path.dirname(f.filename), 'wiki.yaml'), 'version: 1\ntoc:\n  position: bottom\n');
  const elsewhere = path.join(f.directory, 'work');
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, 'page.md'), '# Page\n');
  await writeFile(path.join(elsewhere, 'wiki.yaml'), 'version: 1\ntoc:\n  enabled: false\n');
  const normal = await f.run(['convert', 'page.md', '--to', 'storage'], elsewhere);
  assert.match(normal.stdout, /^<h1>Page<\/h1>\s*<ac:structured-macro ac:name="toc"/);
  const override = await f.run(['convert', 'page.md', '--to', 'storage', '--template', 'wiki.yaml'], elsewhere);
  assert.doesNotMatch(override.stdout, /ac:name="toc"/);
  const disabled = await f.run(['convert', 'page.md', '--to', 'storage', '--template', 'none'], elsewhere, { CONFLUENCE_TEMPLATE: 'missing.yaml' });
  assert.doesNotMatch(disabled.stdout, /ac:name="toc"/);
  const emptyProfile = path.join(f.directory, 'empty.env');
  await writeFile(emptyProfile, '');
  const isolated = await f.run(['convert', 'page.md', '--to', 'storage', '--env', emptyProfile], elsewhere, { CONFLUENCE_TEMPLATE: 'missing.yaml' });
  assert.doesNotMatch(isolated.stdout, /ac:name="toc"/);
  assert.equal(f.requests.length, 0);
});

test('smoke uses the same default and explicit profile selection before any API call', async (t) => {
  const f = await fixture(t, 'cloud');
  await writeFile(f.filename, f.content);
  await assert.rejects(f.run(['smoke']), /Missing CONFLUENCE_CLOUD_ID/);
  const explicit = path.join(f.directory, 'empty.env');
  await writeFile(explicit, '');
  await assert.rejects(f.run(['smoke', '--env', explicit]), /Missing CONFLUENCE_SITE_URL/);
  await assert.rejects(f.run(['smoke', '--env', path.join(f.directory, 'missing.env')]), /ENOENT/);
  assert.equal(f.requests.length, 0);
});
