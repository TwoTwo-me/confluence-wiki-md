import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWikiConfig, ConfluenceApi } from '../src/api.mjs';
import { parseDocument, formatDocument } from '../src/document.mjs';
import { upload, download } from '../src/wiki.mjs';

const entry = process.env.CFWIKI_TEST_ENTRY ?? fileURLToPath(new URL('../scripts/confluence.mjs', import.meta.url));
const bodyDigest = (body) => 'sha256:' + createHash('sha256').update(body.replaceAll('\r\n', '\n')).digest('hex');

async function agentCliFixture(t, deployment, mode = 'success', { rooted = false } = {}) {
  const dc = deployment === 'datacenter';
  const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-apply-cli-'));
  const token = 'private-apply-' + deployment;
  const page = { id: '42', title: 'Integration guide', status: 'current', version: { number: 1 }, body: { storage: { value: '<h1>Guide</h1><p>Base sentence.</p>' } }, spaceId: '12', space: { id: '12', key: 'TEST' }, parentId: rooted ? '5' : null, ancestors: rooted ? [{ id: '5' }] : [] };
  const requests = [];
  const pages = new Map([['42', page]]);
  if (rooted) pages.set('5', { id: '5', title: 'Operations Wiki', status: 'current', version: { number: 1 }, body: { storage: { value: '<p>Root navigation.</p>' } }, spaceId: '12', space: { id: '12', key: 'TEST' }, parentId: dc ? null : '800', ancestors: [] });
  let rootMarker;
  let serial = 70;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path: url.pathname, query: url.search, body, authorization: req.headers.authorization });
    const send = (status, result) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(result === undefined ? '' : JSON.stringify(result)); };
    const expectedAuth = dc ? 'Bearer ' + token : 'Basic ' + Buffer.from('apply@example.test:' + token).toString('base64');
    if (req.headers.authorization !== expectedAuth) return send(401, { message: token, storage: 'secret response body' });
    const spacePath = dc ? '/confluence/rest/api/space/TEST' : '/wiki/api/v2/spaces';
    if (url.pathname === spacePath) return send(200, dc ? { id: '12', key: 'TEST', name: 'Test' } : { results: [{ id: '12', key: 'TEST', name: 'Test', homepageId: '800' }] });
    const pageMatch = url.pathname.match(dc ? /^\/confluence\/rest\/api\/content\/(\d+)$/ : /^\/wiki\/api\/v2\/pages\/(\d+)$/);
    if (pageMatch) {
      const selectedPage = pages.get(pageMatch[1]);
      if (!selectedPage) return send(404, {});
      if (req.method === 'GET') {
        const selected = { ...selectedPage, status: url.searchParams.has('version') && Number(url.searchParams.get('version')) < selectedPage.version.number ? 'historical' : selectedPage.status };
        return send(200, selected);
      }
      if (req.method === 'PUT') {
        if (mode === 'conflict') return send(409, { token, body: 'must not leak' });
        if (body.version.number !== selectedPage.version.number + 1) return send(409, { token });
        const updatedBody = dc ? body.body : { storage: { value: body.body.value } };
        Object.assign(selectedPage, { ...body, body: updatedBody, version: body.version, status: 'current' });
        if (dc) selectedPage.space = { id: '12', key: 'TEST' };
        if (!dc) selectedPage.spaceId = '12';
        if (mode === 'message-omitted') delete selectedPage.version.message;
        if (mode === 'lost-response') { req.socket.destroy(); return; }
        return send(200, selectedPage);
      }
    }
    if (rooted && dc && url.pathname === '/confluence/rest/api/content/5/property/cfwiki-root' && req.method === 'GET') return send(200, rootMarker);
    if (rooted && !dc && url.pathname === '/wiki/api/v2/pages/5/properties' && url.searchParams.get('key') === 'cfwiki-root' && req.method === 'GET') return send(200, { results: [rootMarker] });
    if (dc && /^\/confluence\/rest\/api\/content\/\d+\/property\/confluence-wiki-md$/.test(url.pathname) && req.method === 'GET') return send(404, {});
    if (dc && /^\/confluence\/rest\/api\/content\/\d+\/property$/.test(url.pathname) && req.method === 'POST') {
      if (mode === 'partial') return send(500, { token, body: 'secret response body' });
      return send(200, { ...body, id: 'prop-42', version: { number: 1 } });
    }
    if (!dc && /^\/wiki\/api\/v2\/pages\/\d+\/properties$/.test(url.pathname) && req.method === 'GET') return send(200, { results: [] });
    if (!dc && /^\/wiki\/api\/v2\/pages\/\d+\/properties$/.test(url.pathname) && req.method === 'POST') {
      if (mode === 'partial') return send(500, { token, body: 'secret response body' });
      return send(200, { ...body, id: 'prop-42', version: { number: 1 } });
    }
    if (url.pathname.endsWith('/label') || url.pathname.endsWith('/labels')) return send(200, { results: [] });
    if (req.method === 'POST' && (url.pathname === (dc ? '/confluence/rest/api/content' : '/wiki/api/v2/pages'))) {
      const created = { ...body, id: String(++serial), status: 'current', version: { number: 1 }, ...(dc ? { space: { id: '12', key: 'TEST' } } : { spaceId: '12' }) };
      pages.set(created.id, created);
      return send(200, created);
    }
    return send(404, {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const site = origin + (dc ? '/confluence' : '');
  const env = { CONFLUENCE_DEPLOYMENT: deployment, CONFLUENCE_SITE_URL: site, CONFLUENCE_API_URL: site + (dc ? '/rest/api' : '/wiki/api/v2'), CONFLUENCE_SPACE_KEY: 'TEST', CONFLUENCE_ALLOW_HTTP: 'true', ...(dc ? { CONFLUENCE_PAT: token } : { CONFLUENCE_EMAIL: 'apply@example.test', CONFLUENCE_API_TOKEN: token }) };
  const profile = path.join(directory, 'profile.env');
  await writeFile(profile, Object.entries(env).map(([key, value]) => key + '=' + value).join('\n'));
  const api = new ConfluenceApi(readWikiConfig(env));
  if (rooted) rootMarker = { key: 'cfwiki-root', value: {
    schema: 1, pageId: '5', spaceId: '12', spaceKey: 'TEST', topic: 'Operations',
    tenant: { deployment, siteUrl: api.config.siteUrl, apiUrl: api.config.apiUrl },
  }, id: 'root-property-5', version: { number: 1 } };
  const baseDoc = await download(api, '42');
  const baseText = formatDocument(baseDoc);
  const draftText = formatDocument({
    ...baseDoc,
    ...(mode === 'partial' ? { metadata: { ...baseDoc.metadata, title: 'Edited integration guide' } } : {}),
    body: baseDoc.body.replace('Base sentence.', 'Edited sentence.'),
  });
  const basePath = path.join(directory, 'base.md');
  const draftPath = path.join(directory, 'draft.md');
  await writeFile(basePath, baseText);
  await writeFile(draftPath, draftText);
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CONFLUENCE_')));
  const cli = async (...args) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: directory, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  };
  const runApply = (...args) => cli('apply', draftPath, '--base', basePath, '--space', 'TEST', '--env', profile, '--json', ...args);
  return { api, baseDoc, basePath, baseText, draftPath, draftText, cli, runApply, requests, page, pages, token, directory, profile };
}

for (const deployment of ['cloud', 'datacenter']) {
  test('CLI apply publishes one versioned AI edit (' + deployment + ')', async (t) => {
    const f = await agentCliFixture(t, deployment);
    const result = await f.runApply();
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(report).sort(), ['id', 'status', 'url', 'version', 'warnings', 'writeMessage']);
    assert.equal(report.status, 'success');
    assert.equal(report.id, '42');
    assert.equal(report.version, 2);
    assert.deepEqual(report.writeMessage, { requested: 'AI edit via cfwiki', confirmed: 'AI edit via cfwiki', outcome: 'accepted-response' });
    assert.match(report.url, /pageId=42$/);
    assert.ok(!result.stdout.includes('Edited sentence'));
    assert.equal(f.page.version.message, 'AI edit via cfwiki');
    assert.equal(f.requests.filter((request) => request.method === 'PUT').length, 1);
    assert.equal(f.requests.find((request) => request.method === 'PUT').body.version.number, 2);
    assert.equal(await readFile(f.basePath, 'utf8'), f.baseText);
    assert.equal(await readFile(f.draftPath, 'utf8'), f.draftText);
    const reread = await f.cli('read', '42', '--env', f.profile);
    assert.equal(reread.code, 0, reread.stderr);
    const saved = parseDocument(reread.stdout);
    assert.equal(saved.metadata.confluence.id, '42');
    assert.equal(saved.metadata.confluence.version, 2);
    assert.match(saved.metadata.confluence.url, /pageId=42$/);
    assert.match(saved.body, /Edited sentence/);
    assert.ok(!result.stdout.includes(f.token));
    const legacyFile = path.join(f.directory, 'legacy-upload.md');
    await writeFile(legacyFile, '---\ntitle: Legacy upload\n---\nLegacy body\n');
    const legacy = await f.cli('upload', legacyFile, '--restrictions', 'none', '--env', f.profile);
    assert.equal(legacy.code, 0, legacy.stderr);
    assert.equal(f.page.version.number, 2);
  });

  test('CLI apply reports accepted and reconciled write messages (' + deployment + ')', async (t) => {
    for (const rooted of [false, true]) {
      for (const lost of [false, true]) {
        const f = await agentCliFixture(t, deployment, lost ? 'lost-response' : 'success', { rooted });
        const result = await f.runApply(...(rooted ? ['--wiki-root', '5'] : []));
        assert.equal(result.code, 0, result.stderr + result.stdout);
        const report = JSON.parse(result.stdout);
        assert.equal(report.status, 'success');
        assert.equal(report.version, 2);
        assert.deepEqual(report.writeMessage, {
          requested: 'AI edit via cfwiki', confirmed: 'AI edit via cfwiki',
          outcome: lost ? 'reconciled-state' : 'accepted-response',
          ...(lost ? { authorship: 'unknown' } : {}),
        });
        assert.equal(f.page.version.message, 'AI edit via cfwiki');
        assert.equal(f.requests.filter((request) => request.method === 'PUT').length, 1);
        if (rooted) assert.equal(report.resources.page.status, lost ? 'reconciled' : 'saved');
        else assert.equal(report.resources, undefined);
        if (lost) assert.ok(report.warnings.some((warning) => warning.includes('authorship is unknown')));
        assert.doesNotMatch(result.stdout + result.stderr, new RegExp(f.token + '|secret response body'));
      }
    }

    const unconfirmed = await agentCliFixture(t, deployment, 'message-omitted');
    const unconfirmedResult = await unconfirmed.runApply();
    assert.equal(unconfirmedResult.code, 0, unconfirmedResult.stderr + unconfirmedResult.stdout);
    assert.deepEqual(JSON.parse(unconfirmedResult.stdout).writeMessage, {
      requested: 'AI edit via cfwiki', confirmed: null, outcome: 'accepted-response',
    });
    assert.equal(unconfirmed.requests.filter((request) => request.method === 'PUT').length, 1);

    const human = await agentCliFixture(t, deployment, 'success', { rooted: true });
    const textResult = await human.cli('apply', human.draftPath, '--base', human.basePath,
      '--space', 'TEST', '--wiki-root', '5', '--env', human.profile);
    assert.equal(textResult.code, 0, textResult.stderr + textResult.stdout);
    assert.match(textResult.stdout, /Write message requested: AI edit via cfwiki/);
    assert.match(textResult.stdout, /Write message confirmed: AI edit via cfwiki/);
    assert.match(textResult.stdout, /Write outcome: accepted-response/);
    assert.doesNotMatch(textResult.stdout + textResult.stderr, new RegExp(human.token + '|secret response body'));

    const humanLost = await agentCliFixture(t, deployment, 'lost-response', { rooted: true });
    const lostText = await humanLost.cli('apply', humanLost.draftPath, '--base', humanLost.basePath,
      '--space', 'TEST', '--wiki-root', '5', '--env', humanLost.profile);
    assert.equal(lostText.code, 0, lostText.stderr + lostText.stdout);
    assert.match(lostText.stdout, /Write message requested: AI edit via cfwiki/);
    assert.match(lostText.stdout, /Write message confirmed: AI edit via cfwiki/);
    assert.match(lostText.stdout, /Write outcome: reconciled-state/);
    assert.match(lostText.stdout, /Authorship: unknown/);
    assert.doesNotMatch(lostText.stdout + lostText.stderr, new RegExp(humanLost.token + '|secret response body'));
  });

  test('CLI apply refuses foreign version and profile override (' + deployment + ')', async (t) => {
    const f = await agentCliFixture(t, deployment, 'conflict');
    const before = f.requests.filter((request) => request.method === 'PUT').length;
    const flags = [['--id', '42'], ['--version', '1'], ['--parent', '7'], ['--cql', 'type = page'], ['--local', f.directory], ['--overwrite']];
    for (const flag of flags) {
      const rejected = await f.runApply(...flag);
      assert.notEqual(rejected.code, 0);
      assert.match(rejected.stderr, /does not accept/);
    }
    assert.equal(f.requests.filter((request) => request.method === 'PUT').length, before);
    const foreign = formatDocument({ ...f.baseDoc, metadata: { ...f.baseDoc.metadata, confluence: { ...f.baseDoc.metadata.confluence, space: 'OTHER' } } });
    await writeFile(f.basePath, foreign);
    const refused = await f.runApply();
    assert.equal(refused.code, 1);
    assert.equal(JSON.parse(refused.stdout).status, 'conflict');
    assert.equal(f.requests.filter((request) => request.method === 'PUT').length, before);
    assert.ok(!refused.stdout.includes(f.token));
    await writeFile(f.basePath, f.baseText);
    const profileMismatch = formatDocument({ ...f.baseDoc, metadata: { ...f.baseDoc.metadata, confluence: { ...f.baseDoc.metadata.confluence, api_url: 'https://other.example.test/rest/api' } } });
    await writeFile(f.basePath, profileMismatch);
    const mismatch = await f.runApply();
    assert.equal(mismatch.code, 1);
    assert.equal(JSON.parse(mismatch.stdout).status, 'conflict');
    assert.equal(f.requests.filter((request) => request.method === 'PUT').length, before);
    assert.ok(!mismatch.stderr.includes(f.token));
    assert.equal(await readFile(f.draftPath, 'utf8'), f.draftText);
    assert.ok(f.requests.every((request) => request.method !== 'POST'));
    const unbound = formatDocument({ ...f.baseDoc, metadata: { ...f.baseDoc.metadata, confluence: { ...f.baseDoc.metadata.confluence, id: undefined } } });
    await writeFile(f.basePath, unbound);
    const noCreate = await f.runApply();
    assert.equal(noCreate.code, 1);
    assert.equal(JSON.parse(noCreate.stdout).status, 'conflict');
    assert.equal(f.requests.filter((request) => request.method === 'POST').length, 0);
  });
}

test('CLI apply refuses foreign version and profile override with redacted conflict and partial outcomes', async (t) => {
  for (const mode of ['conflict', 'partial']) {
    for (const deployment of ['cloud', 'datacenter']) {
      const f = await agentCliFixture(t, deployment, mode);
      const result = await f.runApply();
      assert.equal(result.code, 1, mode + ' ' + deployment + ': ' + result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, mode === 'conflict' ? 'conflict' : 'partial');
      assert.equal(report.writeMessage, undefined);
      assert.ok(!result.stdout.includes(f.token));
      assert.ok(!result.stdout.includes('secret response body'));
      assert.ok(!result.stderr.includes(f.token));
      assert.ok(!result.stderr.includes('secret response body'));
      assert.equal(await readFile(f.basePath, 'utf8'), f.baseText);
      assert.equal(await readFile(f.draftPath, 'utf8'), f.draftText);
    }
  }
});

test('preservation modes reduce cached legacy TOCs and honor CLI overrides', async (t) => {
  const f = await serverFixture(t);
  const fullApi = new ConfluenceApi(readWikiConfig({ ...f.env, CONFLUENCE_PRESERVE: 'all' }));
  const doc = await upload(fullApi, '---\ntitle: Preservation\n---\n## Content\n\n```js\nconst x = 1;\n```', { template: { kind: 'confluence', id: '42' } });
  assert.ok(f.properties.get(doc.metadata.confluence.id).value.source);
  const full = parseDocument((await f.cli('read', doc.metadata.confluence.id, '--preserve', 'all')).stdout);
  assert.equal(full.metadata.confluence.preserved.length, 1);
  for (const mode of ['minimal', 'none']) {
    const result = await f.cli('read', doc.metadata.confluence.id, '--preserve', mode);
    assert.equal(result.code, 0, result.stderr);
    const reduced = parseDocument(result.stdout);
    assert.equal(reduced.metadata.confluence.preserved, undefined);
    assert.match(reduced.body, /```confluence-toc/);
    assert.equal(reduced.metadata.confluence.base_body_hash, bodyDigest(reduced.body));
  }
  f.env.CONFLUENCE_PRESERVE = 'all';
  const overridden = await f.cli('read', doc.metadata.confluence.id, '--preserve', 'minimal');
  assert.equal(parseDocument(overridden.stdout).metadata.confluence.preserved, undefined);
  const invalid = await f.cli('read', doc.metadata.confluence.id, '--preserve', 'typo');
  assert.notEqual(invalid.code, 0);
});

test('a downloaded attachment URL updates its native attachment without preserved XML or local assets', async (t) => {
  const f = await serverFixture(t);
  const page = await f.api.writePage({ title: 'Attachment reference', storage: '<p><ac:image ac:alt="sample"><ri:attachment ri:filename="sample.svg"/></ac:image></p>', space: await f.api.getSpace('TEST') });
  const doc = await download(f.api, page.id);
  assert.equal(doc.metadata.confluence.preserved, undefined);
  assert.match(doc.body, /download\/attachments/);
  const preview = await upload(f.api, formatDocument(doc), { dryRun: true });
  assert.match(preview.storage, /ri:attachment ri:filename="sample.svg"/);
  assert.doesNotMatch(preview.storage, /ri:url/);
  assert.deepEqual(preview.attachments, []);
});

test('a portable TOC receives a server preview without an active template', async (t) => {
  const f = await serverFixture(t);
  await upload(f.api, '---\ntitle: Portable TOC\n---\n```confluence-toc\nmaxLevel: 3\n```\n\n## Body');
  assert.ok(f.requests.some((r) => r.path.endsWith('/contentbody/convert/view')));
});

async function serverFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-test-'));
  const pages = new Map();
  const properties = new Map();
  const labels = new Map();
  const restrictions = new Map();
  const templates = new Map([['42', { templateId: '42', name: 'Team template', templateType: 'page', space: { key: 'TEST' }, body: { storage: { value: '<h2>Team header</h2><ac:structured-macro ac:name="toc"/><p>{{cfwiki.body}}</p><p>Team footer</p>' } }, labels: [] }]]);
  const requests = [];
  let serial = 100;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.replace(/^\/confluence\/rest\/(?:api|experimental)/, '');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path: url.pathname, query: url.search, body, authorization: req.headers.authorization });
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    if (req.headers.authorization !== 'Bearer fixture-pat') return send(401, { token: 'must-not-leak' });
    if (route === '/user/current') return send(200, { type: 'known', username: 'fixture-user' });
    if (route === '/template/page' || route === '/template/blueprint') return send(200, { results: [...templates.values()] });
    if (route.startsWith('/template/')) return templates.has(route.slice(10)) ? send(200, templates.get(route.slice(10))) : send(404, {});
    if (route === '/contentbody/convert/view' && req.method === 'POST') return send(200, { value: '<p>Fixture preview accepted</p>' });
    if (route === '/space/TEST') return send(200, { id: '1', key: 'TEST', name: 'Test space' });
    if (route === '/search') return send(200, { results: [...pages.values()].map((page) => ({ content: { id: page.id, title: page.title }, excerpt: 'search match' })) });
    if (route === '/content' && req.method === 'POST') {
      const id = String(++serial);
      const page = { ...body, id, status: 'current', history: { createdBy: { type: 'known', username: 'fixture-user' } }, space: { id: '1', key: 'TEST' }, version: { number: 1 }, ancestors: body.ancestors ?? [] };
      pages.set(id, page);
      return send(200, page);
    }
    if (route === '/content' && req.method === 'GET') {
      const all = [...pages.values()];
      const start = Number(url.searchParams.get('start') ?? 0);
      return send(200, { results: all.slice(start, start + 1), _links: start + 1 < all.length ? { next: '/confluence/rest/api/content?start=' + (start + 1) } : {} });
    }
    const match = route.match(/^\/content\/(\d+)(.*)$/);
    if (!match) return send(404, {});
    const [, id, suffix] = match;
    const page = pages.get(id);
    if (!page) return send(404, {});
    if (suffix === '/restriction') {
      restrictions.set(id, req.method === 'DELETE' ? [] : body);
      return send(200, { results: restrictions.get(id) });
    }
    if (suffix.startsWith('/restriction/byOperation/')) {
      const operation = suffix.split('/').at(-1);
      const selected = restrictions.get(id)?.find((entry) => entry.operation === operation)?.restrictions ?? {};
      const collection = (results) => ({ results: results ?? [], start: 0, size: results?.length ?? 0, limit: 100 });
      return send(200, { operation, restrictions: { user: collection(selected.user), group: collection(selected.group) } });
    }
    if (suffix === '') {
      if (req.method === 'GET') return send(200, page);
      if (req.method === 'DELETE') { pages.delete(id); return send(204); }
      if (req.method === 'PUT') {
        if (body.version.number !== page.version.number + 1) return send(409, {});
        const updated = { ...page, ...body, space: page.space };
        pages.set(id, updated);
        return send(200, updated);
      }
    }
    if (suffix.startsWith('/property')) {
      if (req.method === 'GET') {
        const property = properties.get(id);
        return property && suffix === '/property/' + encodeURIComponent(property.key) ? send(200, property) : send(404, {});
      }
      const property = { ...body, id: 'prop-' + id, version: body.version ?? { number: 1 } };
      properties.set(id, property);
      return send(200, property);
    }
    if (suffix === '/label') {
      if (req.method === 'POST') labels.set(id, [...(labels.get(id) ?? []), ...body]);
      if (req.method === 'DELETE') { labels.set(id, (labels.get(id) ?? []).filter((label) => label.name !== url.searchParams.get('name'))); return send(204); }
      return send(200, { results: labels.get(id) ?? [] });
    }
    if (suffix === '/child/attachment') return send(200, { results: [] });
    return send(404, {});
  });
  t.after(async () => {
    try {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      assert.equal(server.listening, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const base = 'http://127.0.0.1:' + server.address().port + '/confluence';
  const env = { CONFLUENCE_SITE_URL: base, CONFLUENCE_API_URL: base + '/rest/api', CONFLUENCE_DEPLOYMENT: 'datacenter', CONFLUENCE_PAT: 'fixture-pat', CONFLUENCE_SPACE_KEY: 'TEST', CONFLUENCE_ALLOW_HTTP: 'true' };
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CONFLUENCE_')));
  const cli = async (...args) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: directory, env: { ...cleanEnv, XDG_CONFIG_HOME: path.join(directory, 'config'), ...env }, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  };
  return { directory, env, cli, pages, requests, properties, templates, api: new ConfluenceApi(readWikiConfig(env)) };
}

test('native template ID drives CLI creation, portable drafts, conversion and bundle publication', async (t) => {
  const f = await serverFixture(t);
  const file = path.join(f.directory, 'native.md');
  await writeFile(file, '---\ntitle: Native example\n---\n## Edited body\n');
  const list = await f.cli('templates', 'list', '--space', 'TEST', '--json');
  assert.equal(list.code, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout)[0].id, '42');
  const local = await f.cli('convert', file, '--to', 'storage', '--template', '42');
  assert.notEqual(local.code, 0);
  assert.match(local.stderr, /--server/);
  const preview = await f.cli('convert', file, '--to', 'storage', '--template', '42', '--server');
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /Team header/);
  assert.match(preview.stdout, /Edited body/);
  const create = await f.cli('upload', file, '--template', '42');
  assert.equal(create.code, 0, create.stderr);
  const doc = parseDocument(create.stdout);
  assert.equal(doc.metadata.confluence.template_id, '42');
  assert.match(doc.body, /Team footer/);
  assert.equal((doc.body.match(/Team header/g) ?? []).length, 1);
  await writeFile(file, formatDocument({ ...doc, body: doc.body.replace('Edited body', 'Updated body') }));
  f.templates.get('42').body.storage.value = '<p>Changed template for future pages</p>';
  const update = await f.cli('upload', file, '--template', '42');
  assert.equal(update.code, 0, update.stderr);
  const updated = f.pages.get(doc.metadata.confluence.id).body.storage.value;
  assert.match(updated, /Updated body/);
  assert.doesNotMatch(updated, /Changed template for future pages/);
  const downloaded = await f.cli('read', doc.metadata.confluence.id);
  assert.equal(parseDocument(downloaded.stdout).metadata.confluence.template_id, '42');
  const draft = path.join(f.directory, 'draft.md');
  const read = await f.cli('templates', 'read', '42', '-o', draft);
  assert.equal(read.code, 0, read.stderr);
  const conflictingDraft = await f.cli('convert', draft, '--to', 'storage', '--template', '43');
  assert.notEqual(conflictingDraft.code, 0);
  assert.match(conflictingDraft.stderr, /different Confluence template/);
  const fromDraft = await f.cli('upload', draft, '--template', '42');
  assert.equal(fromDraft.code, 0, fromDraft.stderr);
  assert.equal((parseDocument(fromDraft.stdout).body.match(/Changed template for future pages/g) ?? []).length, 1);
  const bundle = path.join(f.directory, 'native-bundle');
  await mkdir(bundle);
  await writeFile(path.join(bundle, 'first.md'), '---\ntitle: Bundle\n---\n## Bundle body\n');
  const pushed = await f.cli('push', bundle, '--template', '42');
  assert.equal(pushed.code, 0, pushed.stderr);
  const bundled = parseDocument(await readFile(path.join(bundle, 'first.md'), 'utf8'));
  assert.equal(bundled.metadata.confluence.template_id, '42');
  assert.match(f.pages.get(bundled.metadata.confluence.id).body.storage.value, /Changed template for future pages/);
  assert.ok(f.requests.filter((request) => request.path.includes('/template/')).every((request) => request.path.startsWith('/confluence/rest/experimental/template/')));
});

test('corporate PAT configuration retains context paths and does not require a Cloud ID', () => {
  const config = readWikiConfig({ CONFLUENCE_SITE_URL: 'https://wiki.company.test/confluence', CONFLUENCE_PAT: 'fake-pat', CONFLUENCE_DEPLOYMENT: 'datacenter' });
  assert.equal(config.apiUrl, 'https://wiki.company.test/confluence/rest/api');
  assert.equal(config.auth, 'bearer');
});

test('insecure endpoints require an explicit opt-in', () => {
  assert.throws(() => readWikiConfig({ CONFLUENCE_SITE_URL: 'http://wiki.company.test', CONFLUENCE_PAT: 'fake', CONFLUENCE_DEPLOYMENT: 'datacenter' }), /HTTPS/);
});

test('CLI supports create, Markdown download, edit, versioned update, search and recoverable delete', async (t) => {
  const fixture = await serverFixture(t);
  const file = path.join(fixture.directory, 'guide.md');
  await writeFile(file, '---\ntype: Playbook\ntitle: Integration guide\ncustom:\n  owner: platform\n---\n# Guide\n\nInitial body\n');
  const created = await fixture.cli('upload', file);
  assert.equal(created.code, 0, created.stderr);
  const first = parseDocument(created.stdout);
  assert.equal(first.metadata.confluence.version, 2);
  assert.equal(first.metadata.confluence.base_body_hash, bodyDigest(first.body));
  assert.equal(first.metadata.confluence.api_url, fixture.env.CONFLUENCE_API_URL);
  const id = first.metadata.confluence.id;
  const downloaded = await fixture.cli('download', id, '--output', 'copy.md');
  assert.equal(downloaded.code, 0, downloaded.stderr);
  assert.equal(downloaded.stdout, '');
  const copy = parseDocument(await readFile(path.join(fixture.directory, 'copy.md'), 'utf8'));
  assert.equal(copy.metadata.custom.owner, 'platform');
  assert.match(copy.body, /Initial body/);
  assert.equal(copy.metadata.confluence.base_body_hash, bodyDigest(copy.body));
  await writeFile(file, formatDocument({ ...first, body: '# Guide\n\nChanged body\n' }));
  const updated = await fixture.cli('upload', file);
  assert.equal(updated.code, 0, updated.stderr);
  const saved = parseDocument(await readFile(file, 'utf8'));
  assert.equal(saved.metadata.confluence.base_body_hash, bodyDigest(saved.body));
  assert.notEqual(saved.metadata.confluence.base_body_hash, first.metadata.confluence.base_body_hash);
  assert.equal(parseDocument(updated.stdout).metadata.confluence.version, 3);
  const read = await fixture.cli('read', id);
  assert.equal(read.code, 0, read.stderr);
  assert.match(parseDocument(read.stdout).body, /Changed body/);
  const stale = path.join(fixture.directory, 'stale.md');
  await writeFile(stale, formatDocument(first));
  const conflict = await fixture.cli('upload', stale);
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.stderr, /Version conflict/);
  assert.equal(fixture.pages.get(id).version.number, 3);
  const search = await fixture.cli('search', 'Guide');
  assert.equal(search.code, 0, search.stderr);
  assert.match(search.stdout, /\[Integration guide\]/);
  const unconfirmed = await fixture.cli('delete', id, '--version', '3');
  assert.notEqual(unconfirmed.code, 0);
  assert.ok(fixture.pages.has(id));
  const deleted = await fixture.cli('delete', id, '--version', '3', '--yes');
  assert.equal(deleted.code, 0, deleted.stderr);
  assert.equal(fixture.pages.has(id), false);
  assert.ok(fixture.requests.every((request) => request.authorization === 'Bearer fixture-pat'));
  assert.ok(fixture.requests.filter((request) => request.method === 'DELETE').every((request) => !request.query.includes('purge')));
});

test('CLI applies profile templates, manual overrides and no-template conversion through upload and push', async (t) => {
  const f = await serverFixture(t);
  const profileDir = path.join(f.directory, 'profiles');
  await mkdir(profileDir);
  const profile = path.join(profileDir, '.env');
  await writeFile(profile, Object.entries({ ...f.env, CONFLUENCE_TEMPLATE: 'team.yaml' }).map(([key, value]) => key + '=' + value).join('\n'));
  await writeFile(path.join(profileDir, 'team.yaml'), 'version: 1\ntoc:\n  position: bottom\n  parameters:\n    minLevel: 2\n    maxLevel: 4');
  const input = '---\ntitle: Template integration\n---\n## Heading\n\nBody\n';
  await writeFile(path.join(f.directory, 'page.md'), input);
  const convert = await f.cli('convert', 'page.md', '--to', 'storage', '--env', profile, '--json');
  assert.equal(convert.code, 0, convert.stderr);
  const converted = JSON.parse(convert.stdout);
  assert.match(converted.storage, /<\/p>\s*<ac:structured-macro ac:name="toc"/);
  assert.match(converted.storage, /ac:name="maxLevel">4/);
  assert.equal(converted.template, path.join(profileDir, 'team.yaml'));
  const manual = await f.cli('convert', 'page.md', '--to', 'storage', '--env', profile, '--template', 'default');
  assert.equal(manual.code, 0, manual.stderr);
  assert.match(manual.stdout, /^<ac:structured-macro ac:name="toc"/);
  const disabled = await f.cli('convert', 'page.md', '--to', 'storage', '--env', profile, '--template', 'none');
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.doesNotMatch(disabled.stdout, /ac:name="toc"/);
  const validation = await f.cli('validate', 'page.md', '--env', profile, '--server', '--json');
  assert.equal(validation.code, 0, validation.stderr);
  assert.equal(JSON.parse(validation.stdout).serverPreview.verified, true);
  const preview = await f.cli('upload', 'page.md', '--env', profile, '--dry-run', '--json');
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).storage, converted.storage);
  assert.equal(f.pages.size, 0);
  const posted = await f.cli('upload', 'page.md', '--env', profile);
  assert.equal(posted.code, 0, posted.stderr);
  const doc = parseDocument(posted.stdout);
  assert.equal(f.pages.get(doc.metadata.confluence.id).body.storage.value, converted.storage);
  const downloaded = await f.cli('read', doc.metadata.confluence.id, '--env', profile);
  assert.equal(downloaded.code, 0, downloaded.stderr);
  const uploadedAgain = await f.cli('upload', 'page.md', '--env', profile);
  assert.equal(uploadedAgain.code, 0, uploadedAgain.stderr);
  assert.equal((f.pages.get(doc.metadata.confluence.id).body.storage.value.match(/ac:name="toc"/g) ?? []).length, 1);
  const bundle = path.join(f.directory, 'bundle');
  await mkdir(bundle);
  await writeFile(path.join(bundle, 'first.md'), input);
  await writeFile(path.join(bundle, 'second.md'), input.replace('Template integration', 'Second'));
  const pushed = await f.cli('push', bundle, '--env', profile);
  assert.equal(pushed.code, 0, pushed.stderr);
  assert.equal(f.pages.size, 3);
  assert.ok([...f.pages.values()].every((page) => /ac:name="maxLevel">4/.test(page.body.storage.value)));
});

test('a downloaded document cannot redirect authenticated writes to another API URL', async (t) => {
  const fixture = await serverFixture(t);
  const text = '---\ntype: Reference\ntitle: Wrong site\nconfluence:\n  api_url: https://other.example.test/rest/api\n---\nBody';
  await assert.rejects(upload(fixture.api, text), /API URL differs/);
  assert.equal(fixture.requests.length, 0);
});

test('bundle push resolves cyclic Markdown links and export paginates into a portable OKF index', async (t) => {
  const fixture = await serverFixture(t);
  const directory = path.join(fixture.directory, 'bundle');
  await mkdir(directory);
  await writeFile(path.join(directory, 'a.md'), '---\ntype: Reference\ntitle: A\n---\n# A\n\n[Related B](./b.md)');
  await writeFile(path.join(directory, 'b.md'), '---\ntype: Reference\ntitle: B\n---\n# B\n\n[Related A](/a.md)');
  const pushed = await fixture.cli('push', directory);
  assert.equal(pushed.code, 0, pushed.stderr);
  const a = parseDocument(await readFile(path.join(directory, 'a.md'), 'utf8'));
  const b = parseDocument(await readFile(path.join(directory, 'b.md'), 'utf8'));
  assert.ok(fixture.pages.get(a.metadata.confluence.id).body.storage.value.includes('pageId=' + b.metadata.confluence.id));
  const exported = await fixture.cli('export', 'exported');
  assert.equal(exported.code, 0, exported.stderr);
  const index = await readFile(path.join(fixture.directory, 'exported/index.md'), 'utf8');
  assert.match(index, /okf_version: "0.2"/);
  assert.ok(index.includes('pages/' + a.metadata.confluence.id + '.md'));
  const local = await fixture.cli('search', 'Related', '--local', 'exported');
  assert.equal(local.code, 0, local.stderr);
  assert.match(local.stdout, /Local wiki search/);
});

test('download refuses to overwrite a local document without an explicit flag', async (t) => {
  const fixture = await serverFixture(t);
  const created = await upload(fixture.api, '---\ntype: Reference\ntitle: A\n---\nBody');
  await writeFile(path.join(fixture.directory, 'existing.md'), 'keep me');
  const result = await fixture.cli('download', created.metadata.confluence.id, '-o', 'existing.md');
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(path.join(fixture.directory, 'existing.md'), 'utf8'), 'keep me');
});

test('external page edits retain OKF metadata but invalidate cached Markdown', async (t) => {
  const fixture = await serverFixture(t);
  const created = await upload(fixture.api, '---\ntype: Playbook\ntitle: External edit\ncustom: retain-me\n---\nOriginal');
  const id = created.metadata.confluence.id;
  const page = fixture.pages.get(id);
  page.body.storage.value = '<p>Edited in the browser</p>';
  page.version.number++;
  const updated = await download(fixture.api, id);
  assert.equal(updated.metadata.custom, 'retain-me');
  assert.match(updated.body, /Edited in the browser/);
  assert.doesNotMatch(updated.body, /Original/);
  assert.equal(updated.metadata.confluence.base_body_hash, bodyDigest(updated.body));
  assert.notEqual(updated.metadata.confluence.base_body_hash, created.metadata.confluence.base_body_hash);
});

test('local status detects body edits without an API, configuration or baseline changes', async (t) => {
  const fixture = await serverFixture(t);
  const file = path.join(fixture.directory, 'status.md');
  const body = '\n# Body\n\n```text\n  indentation  \n```\n';
  const metadata = { type: 'Reference', title: 'Before', confluence: { id: '42', version: 3, base_body_hash: bodyDigest(body) } };
  const unchanged = '\uFEFF' + formatDocument({ metadata, body }).replaceAll('\n', '\r\n');
  await writeFile(file, unchanged);
  const before = fixture.requests.length;
  let result = await fixture.cli('status', file, '--json', '--env', 'does-not-exist.env');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).bodyStatus, 'unchanged');
  assert.equal(JSON.parse(result.stdout).bodyModified, false);
  assert.equal(await readFile(file, 'utf8'), unchanged);
  const edited = formatDocument({ metadata: { ...metadata, title: 'YAML edit only' }, body });
  await writeFile(file, edited);
  result = await fixture.cli('status', file, '--json');
  assert.equal(JSON.parse(result.stdout).bodyStatus, 'unchanged');
  const changed = edited.replace('  indentation  ', '    indentation  ');
  await writeFile(file, changed);
  for (let i = 0; i < 2; i++) {
    result = await fixture.cli('status', file, '--json');
    assert.equal(result.code, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.bodyStatus, 'modified');
    assert.equal(state.bodyModified, true);
    assert.equal(state.baseBodyHash, metadata.confluence.base_body_hash);
    assert.equal(state.currentBodyHash, bodyDigest(parseDocument(changed).body));
  }
  assert.equal(await readFile(file, 'utf8'), changed);
  result = await fixture.cli('status', file, '-o', file, '--overwrite');
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(file, 'utf8'), changed);
  await writeFile(file, '# Older file without a baseline\n');
  result = await fixture.cli('status', file, '--json');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).bodyStatus, 'unknown');
  assert.equal(JSON.parse(result.stdout).bodyModified, null);
  assert.equal(JSON.parse(result.stdout).baseBodyHash, null);
  assert.equal(fixture.requests.length, before);
});

test('downloads hash the returned Markdown after link rewriting, including empty pages', async (t) => {
  const fixture = await serverFixture(t);
  const created = await upload(fixture.api, '# Links');
  const id = created.metadata.confluence.id;
  const page = fixture.pages.get(id);
  for (const storage of ['<p><a href="' + fixture.api.pageUrl(id) + '">Self</a></p>', '']) {
    page.body.storage.value = storage;
    page.version.number++;
    const downloaded = await download(fixture.api, id, { pageLinks: { [id]: './self.md' } });
    if (storage) assert.match(downloaded.body, /\.\/self\.md/);
    const reopened = parseDocument(formatDocument(downloaded));
    assert.equal(reopened.metadata.confluence.base_body_hash, bodyDigest(reopened.body));
  }
});

test('dry runs and partial updates retain the body baseline until synchronization succeeds', async (t) => {
  const fixture = await serverFixture(t);
  const created = await upload(fixture.api, '# Baseline\n\nOriginal\n');
  const baseline = created.metadata.confluence.base_body_hash;
  assert.equal(baseline, bodyDigest(created.body));
  const edited = formatDocument({ ...created, body: '# Baseline\n\nEdited\n' });
  let saved;
  const onWrite = async (doc) => { saved = doc; };
  await upload(fixture.api, edited, { dryRun: true, onWrite });
  assert.equal(saved, undefined);
  const realSetProperty = fixture.api.setProperty.bind(fixture.api);
  fixture.api.setProperty = async () => { throw new Error('simulated metadata failure'); };
  await assert.rejects(upload(fixture.api, edited, { onWrite }), /was saved at version 3/);
  assert.equal(saved.metadata.confluence.base_body_hash, baseline);
  fixture.api.setProperty = realSetProperty;
  const complete = await upload(fixture.api, formatDocument(saved), { onWrite });
  assert.equal(complete.metadata.confluence.base_body_hash, bodyDigest(complete.body));
  assert.equal(saved.metadata.confluence.base_body_hash, complete.metadata.confluence.base_body_hash);
  assert.equal(fixture.properties.get(complete.metadata.confluence.id).value.metadata.confluence, undefined);
});

test('an explicit profile does not inherit credentials from a different active profile', async (t) => {
  const fixture = await serverFixture(t);
  const profile = path.join(fixture.directory, '.env.corporate');
  await writeFile(profile, Object.entries(fixture.env).map(([key, value]) => key + '=' + value).join('\n'));
  fixture.env.CONFLUENCE_API_TOKEN = 'wrong-profile-token';
  const result = await fixture.cli('doctor', '--env', profile);
  assert.equal(result.code, 0, result.stderr);
});

test('local images cannot escape the chosen bundle root', async (t) => {
  const fixture = await serverFixture(t);
  const directory = path.join(fixture.directory, 'bundle');
  await mkdir(directory);
  await writeFile(path.join(fixture.directory, 'outside.svg'), '<svg/>');
  await assert.rejects(upload(fixture.api, '# Image\n\n![outside](../outside.svg)', { filename: path.join(directory, 'page.md') }), /escapes/);
  assert.equal(fixture.pages.size, 0);
});

test('missing bundle link targets fail before placeholder pages are created', async (t) => {
  const fixture = await serverFixture(t);
  await writeFile(path.join(fixture.directory, 'page.md'), '# Page\n\n[Missing](missing.md)');
  const result = await fixture.cli('push', fixture.directory);
  assert.notEqual(result.code, 0);
  assert.equal(fixture.pages.size, 0);
});

test('a partial metadata failure records identity and can resume without duplicate pages', async (t) => {
  const fixture = await serverFixture(t);
  let saved;
  const realSetProperty = fixture.api.setProperty.bind(fixture.api);
  fixture.api.setProperty = async () => { throw new Error('simulated property failure'); };
  await assert.rejects(upload(fixture.api, '# Partial page', { onWrite: async (doc) => { saved = doc; } }), /was saved at version 2/);
  assert.ok(saved.metadata.confluence.id);
  assert.equal(saved.metadata.confluence.version, 2);
  assert.equal(saved.metadata.confluence.base_body_hash, undefined);
  fixture.api.setProperty = realSetProperty;
  await upload(fixture.api, formatDocument(saved));
  assert.equal(fixture.pages.size, 1);
});

test('trashed pages cannot be updated or deleted again', async (t) => {
  const fixture = await serverFixture(t);
  const doc = await upload(fixture.api, '# Trash guard');
  fixture.pages.get(doc.metadata.confluence.id).status = 'trashed';
  await assert.rejects(upload(fixture.api, formatDocument(doc)), /Only current/);
  const before = fixture.requests.length;
  const result = await fixture.cli('delete', doc.metadata.confluence.id, '--version', '1', '--yes');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Only current/);
  assert.ok(fixture.requests.slice(before).every((request) => request.method !== 'DELETE'));
});
