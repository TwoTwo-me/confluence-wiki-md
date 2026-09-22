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

const entry = fileURLToPath(new URL('../scripts/confluence.mjs', import.meta.url));
const bodyDigest = (body) => 'sha256:' + createHash('sha256').update(body.replaceAll('\r\n', '\n')).digest('hex');

async function serverFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-test-'));
  const pages = new Map();
  const properties = new Map();
  const labels = new Map();
  const requests = [];
  let serial = 100;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.replace('/confluence/rest/api', '');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path: url.pathname, query: url.search, body, authorization: req.headers.authorization });
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    if (req.headers.authorization !== 'Bearer fixture-pat') return send(401, { token: 'must-not-leak' });
    if (route === '/space/TEST') return send(200, { id: '1', key: 'TEST', name: 'Test space' });
    if (route === '/search') return send(200, { results: [...pages.values()].map((page) => ({ content: { id: page.id, title: page.title }, excerpt: 'search match' })) });
    if (route === '/content' && req.method === 'POST') {
      const id = String(++serial);
      const page = { ...body, id, status: 'current', space: { id: '1', key: 'TEST' }, version: { number: 1 }, ancestors: body.ancestors ?? [] };
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
      if (req.method === 'GET') return properties.has(id) ? send(200, properties.get(id)) : send(404, {});
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
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await rm(directory, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port + '/confluence';
  const env = { CONFLUENCE_SITE_URL: base, CONFLUENCE_API_URL: base + '/rest/api', CONFLUENCE_DEPLOYMENT: 'datacenter', CONFLUENCE_PAT: 'fixture-pat', CONFLUENCE_SPACE_KEY: 'TEST', CONFLUENCE_ALLOW_HTTP: 'true' };
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CONFLUENCE_')));
  const cli = async (...args) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: directory, env: { ...cleanEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  };
  return { directory, env, cli, pages, requests, properties, api: new ConfluenceApi(readWikiConfig(env)) };
}

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
  assert.equal(first.metadata.confluence.version, 1);
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
  assert.equal(parseDocument(updated.stdout).metadata.confluence.version, 2);
  const read = await fixture.cli('read', id);
  assert.equal(read.code, 0, read.stderr);
  assert.match(parseDocument(read.stdout).body, /Changed body/);
  const stale = path.join(fixture.directory, 'stale.md');
  await writeFile(stale, formatDocument(first));
  const conflict = await fixture.cli('upload', stale);
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.stderr, /Version conflict/);
  assert.equal(fixture.pages.get(id).version.number, 2);
  const search = await fixture.cli('search', 'Guide');
  assert.equal(search.code, 0, search.stderr);
  assert.match(search.stdout, /\[Integration guide\]/);
  const unconfirmed = await fixture.cli('delete', id, '--version', '2');
  assert.notEqual(unconfirmed.code, 0);
  assert.ok(fixture.pages.has(id));
  const deleted = await fixture.cli('delete', id, '--version', '2', '--yes');
  assert.equal(deleted.code, 0, deleted.stderr);
  assert.equal(fixture.pages.has(id), false);
  assert.ok(fixture.requests.every((request) => request.authorization === 'Bearer fixture-pat'));
  assert.ok(fixture.requests.filter((request) => request.method === 'DELETE').every((request) => !request.query.includes('purge')));
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
  await assert.rejects(upload(fixture.api, edited, { onWrite }), /was saved at version 2/);
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
  await assert.rejects(upload(fixture.api, '# Partial page', { onWrite: async (doc) => { saved = doc; } }), /was saved at version 1/);
  assert.ok(saved.metadata.confluence.id);
  assert.equal(saved.metadata.confluence.version, 1);
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
