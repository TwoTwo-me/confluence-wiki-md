import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/confluence.mjs', import.meta.url));

for (const profile of ['cloud', 'company']) {
  test(profile + ' example selects the correct authentication despite conflicting ambient credentials', async (t) => {
    const env = parseEnv(await readFile(new URL('../.env.' + profile + '.example', import.meta.url), 'utf8'));
    const cloud = profile === 'cloud';
    const token = 'private-fixture-' + profile;
    const authorization = cloud ? 'Basic ' + Buffer.from('fixture@example.test:' + token).toString('base64') : 'Bearer ' + token;
    const requests = [];
    const server = createServer((req, res) => {
      requests.push({ url: req.url, authorization: req.headers.authorization });
      const expectedPath = cloud ? '/wiki/api/v2/spaces?keys=TEST' : '/confluence/rest/api/space/TEST';
      const accepted = req.url === expectedPath && req.headers.authorization === authorization;
      const space = { id: '1', key: 'TEST', name: 'Profile test' };
      res.writeHead(accepted ? 200 : 403, { 'content-type': 'application/json' });
      res.end(JSON.stringify(accepted ? cloud ? { results: [space] } : space : {}));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-profiles-'));
    t.after(async () => { server.close(); await rm(directory, { recursive: true, force: true }); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    Object.assign(env, { CONFLUENCE_SITE_URL: origin + (cloud ? '' : '/confluence'), CONFLUENCE_API_URL: origin + (cloud ? '/wiki/api/v2' : '/confluence/rest/api'), CONFLUENCE_SPACE_KEY: 'TEST', CONFLUENCE_ALLOW_HTTP: 'true' });
    if (cloud) Object.assign(env, { CONFLUENCE_EMAIL: 'fixture@example.test', CONFLUENCE_API_TOKEN: token });
    else env.CONFLUENCE_PAT = token;
    const filename = path.join(directory, '.env.' + profile);
    await writeFile(filename, Object.entries(env).map(([key, value]) => key + '=' + value).join('\n'));
    const result = await exec(process.execPath, [cli, 'doctor', '--env', filename, '--json'], {
      cwd: directory,
      env: { ...process.env, CONFLUENCE_DEPLOYMENT: cloud ? 'datacenter' : 'cloud', CONFLUENCE_AUTH: cloud ? 'bearer' : 'basic', CONFLUENCE_SITE_URL: 'https://wrong.example.test', CONFLUENCE_API_TOKEN: 'wrong-api-token', CONFLUENCE_PAT: 'wrong-pat', CONFLUENCE_CLOUD_ID: 'invalid-ambient-id' },
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.authenticated, true);
    assert.equal(report.deployment, cloud ? 'cloud' : 'datacenter');
    assert.equal(report.auth, cloud ? 'basic' : 'bearer');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, authorization);
    assert.ok(!result.stdout.includes(token));
  });
}
