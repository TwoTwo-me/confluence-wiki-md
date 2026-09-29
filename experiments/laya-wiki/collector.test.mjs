import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { collect, parseNotion, sourceId, sha256, validateCorpus, readJson, saveJson, MAX_BYTES } from './collect.mjs';
import { importCorpus, reconcile, readback, query, RecordedApi, preparedBody } from './confluence.mjs';

const evidence = path.resolve(process.env.LAYA_PIPELINE_EVIDENCE ?? '.omo/evidence/wiki-pipeline-' + Date.now());
await mkdir(evidence, { recursive: true });
const fixtureDoc = (overrides = {}) => {
  const d = { title: 'guide.md', text: '# Guide\n\nAlpha evidence.\n\n[Sibling](next.md)\n\n```js\nconsole.log("fixture");\n```', source_url: 'https://github.com/fixture/repo/blob/main/guide.md', source_path: 'fixture/repo/guide.md', source_type: 'github', private: false, ...overrides };
  return { ...d, id: sourceId(d.source_type, d.source_url, d.source_path), sha256: sha256(d.text) };
};
const blobSha = (text) => createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\0' + text).digest('hex');
async function scenario(name, fn) { const output = path.join(evidence, name); await mkdir(output, { recursive: true }); await fn(output); await saveJson(path.join(output, 'PASS.json'), { scenario: name, passed: true, at: new Date().toISOString() }); }

async function serverFixture(output, { denyProtection = false, unknownPost = false, htmlEntities = false } = {}) {
  const pages = new Map(); const properties = new Map(); const requests = []; let counter = 10;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); let bodyText = ''; for await (const chunk of req) bodyText += chunk;
    const body = bodyText ? JSON.parse(bodyText) : null;
    requests.push({ method: req.method, path: url.pathname, search: url.search, body });
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/rest/api/space/AGENTTEST') return send(200, { id: '1', key: 'AGENTTEST' });
    if (url.pathname === '/rest/api/user/current') return send(200, { username: 'fixture-actor' });
    if (url.pathname === '/rest/api/search') return send(200, { results: [...pages.values()].filter((p) => p.body.storage.value.includes('Source ID:')).map((content) => ({ content })) });
    const property = url.pathname.match(/^\/rest\/api\/content\/(\d+)\/property(?:\/([^/]+))?$/);
    if (property) {
      const key = property[1] + '/' + (property[2] ?? body?.key);
      if (req.method === 'GET') return properties.has(key) ? send(200, properties.get(key)) : send(404, {});
      const value = { ...body, id: String(properties.size + 1), version: { number: 1 } }; properties.set(key, value); return send(200, value);
    }
    if (url.pathname.endsWith('/restriction') && req.method === 'PUT') return send(denyProtection ? 403 : 200, {});
    if (url.pathname.includes('/restriction/byOperation/')) {
      const operation = url.pathname.split('/').at(-1);
      return send(200, { operation, restrictions: { user: { results: [{ username: 'fixture-actor' }] }, group: { results: [] } } });
    }
    if (url.pathname === '/rest/api/content' && req.method === 'POST') {
      const id = String(++counter);
      const page = { ...body, id, status: 'current', space: { id: '1', key: 'AGENTTEST' }, version: { number: 1 }, history: { createdBy: { username: 'fixture-actor' } } };
      if (htmlEntities) page.body.storage.value = page.body.storage.value.replaceAll('&#xb7;', '&middot;').replaceAll('·', '&middot;').replaceAll('&#x2192;', '&rarr;').replaceAll('→', '&rarr;');
      pages.set(id, page);
      if (unknownPost && body.title.startsWith('GitHub')) { req.socket.destroy(); return; }
      return send(200, page);
    }
    const match = url.pathname.match(/^\/rest\/api\/content\/(\d+)$/);
    if (match) {
      if (!pages.has(match[1])) return send(404, {});
      if (req.method === 'PUT') pages.set(match[1], { ...pages.get(match[1]), ...body, space: { id: '1', key: 'AGENTTEST' } });
      return send(200, pages.get(match[1]));
    }
    send(404, { error: 'unknown_fixture_route' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = new RecordedApi({ deployment: 'datacenter', apiUrl: base + '/rest/api', v1Url: base + '/rest/api', siteUrl: base, webBase: base, auth: 'bearer', token: 'fixture-only', spaceKey: 'AGENTTEST' }, { output: path.join(output, 'http.json') });
  return { api, pages, requests, close: async () => { await saveJson(path.join(output, 'requests.json'), requests); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

test('collector resumes verified blobs, refreshes stale/corrupt cache, records limits and forks', async () => scenario('collector-cache', async (output) => {
  let text = '# Fixture\n\nVersion one'; let blobCalls = 0;
  const github = async (args) => {
    if (args[0] === 'repo') return [{ nameWithOwner: 'fixture/repo', url: 'https://github.com/fixture/repo', isPrivate: false, isFork: true, defaultBranchRef: { name: 'main' } }];
    if (args[1].includes('/trees/')) return { sha: 'tree', truncated: true, tree: [{ type: 'blob', path: 'README.md', sha: blobSha(text), size: Buffer.byteLength(text) }, { type: 'blob', path: 'node_modules/pkg/a.md', sha: 'excluded', size: 1 }, { type: 'blob', path: 'big.txt', sha: 'big', size: MAX_BYTES + 1 }] };
    blobCalls++; return { sha: blobSha(text), encoding: 'base64', content: Buffer.from(text).toString('base64') };
  };
  const opts = { owner: 'fixture', output, github };
  await collect(opts); const first = await readJson(path.join(output, 'corpus.json'));
  await collect(opts); assert.equal(blobCalls, 1); assert.deepEqual(await readJson(path.join(output, 'corpus.json')), first);
  await writeFile(path.join(output, 'raw', first[0].id + '.txt'), 'tampered'); await collect(opts); assert.equal(blobCalls, 2);
  text = '# Fixture\n\nVersion two'; await collect(opts); assert.equal(blobCalls, 3);
  const newer = await readJson(path.join(output, 'corpus.json')); assert.equal(newer[0].id, first[0].id); assert.notEqual(newer[0].sha256, first[0].sha256);
  const manifest = await readJson(path.join(output, 'source-manifest.json')); assert.equal(manifest.complete, false); assert.equal(manifest.repositories[0].isFork, true);
  assert.ok(manifest.gaps.some((g) => g.reason === 'tree_truncated')); assert.ok(manifest.documents.some((d) => d.reason === 'oversize')); assert.ok(manifest.documents.some((d) => d.status === 'excluded'));
}));

test('Notion capture unwraps native body and preserves parent/truncation metadata', async () => scenario('notion-wrapper', async (output) => {
  const raw = { title: 'Fixture', url: 'https://app.notion.com/p/01234567-89ab-cdef-0123-456789abcdef', text: 'Wrapper\n<content>Native body\n<page url="https://www.notion.so/child">Child</page></content>\ntruncated', metadata: { type: 'page' }, unknown_block_count: 2, capture_parent_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  const doc = parseNotion(raw, 'fixture.json.capture'); assert.equal(doc.source_path, '0123456789abcdef0123456789abcdef'); assert.equal(doc.parent_id, 'aaaaaaaabbbbccccddddeeeeeeeeeeee'); assert.equal(doc.notion.truncated, true); assert.ok(!doc.text.includes('Wrapper')); assert.equal(doc.private, true); assert.equal(doc.notion.unknown_block_count, 2); validateCorpus([doc]);
  assert.throws(() => parseNotion({ ...raw, text: 'broken' }, 'fixture'), /complete/);
  assert.throws(() => validateCorpus([{ ...doc, text: 'tampered' }]), /hash mismatch/);
  assert.throws(() => validateCorpus([doc, doc]), /Duplicate/);
  const notionDir = path.join(output, 'notion'); await saveJson(path.join(notionDir, 'fixture.json.capture'), raw);
  const result = await collect({ owner: 'fixture', output, notionDir, github: async () => [] }); assert.equal(result.collected, 1); assert.equal(result.complete, false);
}));

test('malformed corpus fails before any API write', async () => scenario('malformed', async (output) => {
  const fixture = await serverFixture(output);
  try { await assert.rejects(importCorpus(fixture.api, [{ title: 'broken' }], { output }), /Malformed/); assert.equal(fixture.requests.length, 0); }
  finally { await fixture.close(); }
}));

test('real HTTP import/readback/query is idempotent and source-linked; stale remote/source never overwritten', async () => scenario('http-roundtrip', async (output) => {
  const fixture = await serverFixture(output); const doc = fixtureDoc();
  try {
    const imported = await importCorpus(fixture.api, [doc], { output }); assert.equal(imported.confirmed, 1);
    const postCount = fixture.requests.filter((r) => r.method === 'POST').length;
    const again = await importCorpus(fixture.api, [doc], { output }); assert.equal(again.confirmed, 1); assert.equal(fixture.requests.filter((r) => r.method === 'POST').length, postCount);
    const read = await readback(fixture.api, [doc], { output }); assert.equal(read.complete, true);
    const rt = await readJson(path.join(output, 'confluence-corpus.json')); assert.ok(rt[0].text.includes('Alpha evidence.')); assert.ok(!rt[0].text.includes('Source ID:')); assert.equal(rt[0].id, doc.id);
    const found = await query(fixture.api, 'Alpha', { output }); assert.equal(found.fetched, 1); assert.equal(found.http_requests, 2);
    const manifest = await readJson(path.join(output, 'confluence-manifest.json')); const remote = fixture.pages.get(manifest.documents[doc.id].id); remote.body.storage.value += '<p>Edited remotely</p>';
    const stale = await importCorpus(fixture.api, [doc], { output }); assert.equal(stale.blocked, 1); assert.equal(fixture.requests.filter((r) => r.method === 'POST').length, postCount);
    const changed = await importCorpus(fixture.api, [fixtureDoc({ text: 'Changed source' })], { output }); assert.equal(changed.blocked, 1);
    assert.equal((await readJson(path.join(output, 'confluence-manifest.json'))).documents[doc.id].reason, 'source_hash_changed');
  } finally { await fixture.close(); }
}));

test('protection failure never publishes private body/title and continues public docs', async () => scenario('private-failure', async (output) => {
  const fixture = await serverFixture(output, { denyProtection: true });
  const privateDoc = fixtureDoc({ title: 'Sensitive title', text: 'SENSITIVE FIXTURE BODY', source_type: 'notion', source_url: 'https://www.notion.so/0123456789abcdef0123456789abcdef', source_path: '0123456789abcdef0123456789abcdef', private: true });
  try {
    const result = await importCorpus(fixture.api, [privateDoc, fixtureDoc()], { output }); assert.equal(result.private_blocker, true); assert.equal(result.confirmed, 1); assert.equal(result.blocked, 1);
    const writes = fixture.requests.filter((r) => ['POST', 'PUT'].includes(r.method)); assert.ok(writes.some((r) => r.path.endsWith('/restriction')));
    assert.ok(!JSON.stringify(writes).includes('SENSITIVE FIXTURE BODY')); assert.ok(!JSON.stringify(writes).includes('Sensitive title'));
    const manifest = await readJson(path.join(output, 'confluence-manifest.json')); assert.ok(manifest.private_blocker.id); assert.ok(manifest.private_blocker.pending_create);
    const beforeReconcile = fixture.requests.length; const reconciled = await reconcile(fixture.api, [privateDoc, fixtureDoc()], { output }); assert.equal(reconciled.confirmed, 0); assert.equal(reconciled.refused, 1); assert.ok(fixture.requests.slice(beforeReconcile).every((r) => r.method === 'GET'));
    assert.ok((await readJson(path.join(output, 'confluence-manifest.json'))).private_blocker);
    const postCount = writes.filter((r) => r.method === 'POST').length; await importCorpus(fixture.api, [privateDoc, fixtureDoc()], { output }); assert.equal(fixture.requests.filter((r) => r.method === 'POST').length, postCount);
  } finally { await fixture.close(); }
}));

test('accepted POST with lost response is journaled and never blindly duplicated', async () => scenario('unknown-mutation', async (output) => {
  const fixture = await serverFixture(output, { unknownPost: true });
  try {
    const first = await importCorpus(fixture.api, [fixtureDoc()], { output }); assert.equal(first.blocked, 1);
    const posts = fixture.requests.filter((r) => r.method === 'POST').length;
    const second = await importCorpus(fixture.api, [fixtureDoc()], { output }); assert.equal(second.blocked, 1); assert.equal(fixture.requests.filter((r) => r.method === 'POST').length, posts);
    const manifest = await readJson(path.join(output, 'confluence-manifest.json')); assert.equal(manifest.pages['section/github'].status, 'unresolved');
  } finally { await fixture.close(); }
}));

test('secret-looking and malformed GitHub blobs are unavailable, never corpus text', async () => scenario('rejected-blobs', async (output) => {
  const sensitive = '# Example\napi_key = ' + 'x'.repeat(30);
  const github = async (args) => {
    if (args[0] === 'repo') return [{ nameWithOwner: 'fixture/repo', url: 'https://github.com/fixture/repo', isPrivate: true, isFork: false, defaultBranchRef: { name: 'main' } }];
    if (args[1].includes('/trees/')) return { sha: 'tree', truncated: false, tree: [{ type: 'blob', path: 'secret.md', sha: blobSha(sensitive), size: sensitive.length }, { type: 'blob', path: 'broken.md', sha: '0'.repeat(40), size: 7 }] };
    return args[1].endsWith(blobSha(sensitive)) ? { sha: blobSha(sensitive), encoding: 'base64', content: Buffer.from(sensitive).toString('base64') } : { sha: '0'.repeat(40), encoding: 'base64', content: Buffer.from('wrong').toString('base64') };
  };
  const result = await collect({ owner: 'fixture', output, github }); assert.equal(result.collected, 0); assert.equal(result.unavailable, 2);
  assert.deepEqual(await readJson(path.join(output, 'corpus.json')), []);
  const manifest = await readJson(path.join(output, 'source-manifest.json')); assert.deepEqual(manifest.documents.map((d) => d.reason), ['secret_looking_content', 'blob_fetch_or_validation_failed']);
}));


test('live Confluence named HTML entities preserve text without changing CDATA', async () => scenario('live-entity-regression', async (output) => {
  const fixture = await serverFixture(output, { htmlEntities: true });
  const doc = fixtureDoc({ text: '# Entities\n\nAlpha · Beta → Gamma\n\n```text\nLiteral &middot; remains literal.\n```' });
  try {
    const result = await importCorpus(fixture.api, [doc], { output }); assert.equal(result.confirmed, 1);
    assert.equal((await readback(fixture.api, [doc], { output })).complete, true);
    const corpus = await readJson(path.join(output, 'confluence-corpus.json'));
    assert.ok(corpus[0].text.includes('Alpha · Beta → Gamma'));
    assert.ok(corpus[0].text.includes('Literal &middot; remains literal.'));
  } finally { await fixture.close(); }
}));


test('reconciliation confirms only unchanged known pages and performs no remote mutations', async () => scenario('safe-reconciliation', async (output) => {
  const fixture = await serverFixture(output, { htmlEntities: true });
  const docs = ['unchanged', 'version', 'content', 'unknown', 'parent'].map((name) => fixtureDoc({ title: name + '.md', text: 'Alpha · Beta → ' + name, source_path: 'fixture/repo/' + name + '.md', source_url: 'https://github.com/fixture/repo/blob/main/' + name + '.md' }));
  try {
    assert.equal((await importCorpus(fixture.api, docs, { output })).confirmed, 5);
    const filename = path.join(output, 'confluence-manifest.json'); const manifest = await readJson(filename);
    for (const doc of docs) { manifest.pages['doc/' + doc.id].status = 'unresolved'; manifest.documents[doc.id].status = 'blocked'; }
    fixture.pages.get(manifest.pages['doc/' + docs[1].id].id).version.number++;
    fixture.pages.get(manifest.pages['doc/' + docs[2].id].id).body.storage.value += '<p>Remote edit.</p>';
    delete manifest.pages['doc/' + docs[3].id].id;
    fixture.pages.get(manifest.pages['doc/' + docs[4].id].id).ancestors = [{ id: '999999' }];
    await saveJson(filename, manifest);
    const before = fixture.requests.length; const result = await reconcile(fixture.api, docs, { output });
    assert.equal(result.confirmed, 1); assert.equal(result.refused, 4); assert.equal(result.remote_writes, 0);
    assert.ok(fixture.requests.slice(before).every((r) => r.method === 'GET'));
    const after = await readJson(filename); assert.equal(after.documents[docs[0].id].status, 'confirmed');
    for (const doc of docs.slice(1)) assert.equal(after.pages['doc/' + doc.id].status, 'unresolved');
    const report = await readJson(path.join(output, 'reconciliation.json'));
    assert.ok(report.results.some((r) => r.reason === 'missing_created_identity_or_version'));
    assert.ok(report.results.some((r) => r.reason === 'page_content_changed'));
    assert.equal(report.results.filter((r) => r.reason === 'page_identity_or_version_changed').length, 2);
  } finally { await fixture.close(); }
}));

test('repository allowlist bounds tree requests while retaining full owned inventory', async () => scenario('repository-selection', async (output) => {
  const requests = [];
  const github = async (args) => {
    requests.push(args);
    if (args[0] === 'repo') return ['selected', 'other'].map((name) => ({ nameWithOwner: 'fixture/' + name, url: 'https://github.com/fixture/' + name, isPrivate: false, isFork: false, defaultBranchRef: { name: 'main' } }));
    return { sha: 'tree', truncated: false, tree: [] };
  };
  const result = await collect({ owner: 'fixture', output, github, onlyRepo: ['selected'] });
  assert.equal(result.repositories, 1); assert.equal(result.inventory_repositories, 2);
  assert.equal(requests.filter((args) => args[0] === 'api').length, 1);
  assert.ok(requests.at(-1)[1].includes('/selected/'));
  assert.equal((await readJson(path.join(output, 'github-inventory.json'))).length, 2);
  assert.deepEqual((await readJson(path.join(output, 'source-manifest.json'))).selected_repositories, ['fixture/selected']);
}));


test('prepared publication links strip temporary credentials and preserve ordinary queries and image labels', async () => scenario('signed-link-cleanup', async (output) => {
  const signed = 'https://assets.example.test/diagram.png?X-Amz-Security-Token=fixtureSessionSecret&X-Amz-Credential=fixtureCredentialSecret&X-Amz-Signature=fixtureSignatureSecret&X-Amz-Date=20260930&format=png&download=1';
  const doc = fixtureDoc({ text: '[Download](' + signed + ')\n\n![System diagram](' + signed + ')\n\n<' + signed + '>\n\n[Google](https://assets.example.test/file?X-Goog-Credential=fixtureGoogleSecret&x-goog-signature=fixtureGoogleSig&token=fixtureTokenSecret&access_token=fixtureAccessSecret&SIGNATURE=fixtureGenericSig&format=pdf)\n\n[Relative](../next.md?token=fixtureRelativeSecret&view=compact&signature_version=2#part)' });
  const body = preparedBody(doc);
  await writeFile(path.join(output, 'prepared.txt'), body);
  for (const secret of ['fixtureSessionSecret', 'fixtureCredentialSecret', 'fixtureSignatureSecret', 'fixtureGoogleSecret', 'fixtureGoogleSig', 'fixtureTokenSecret', 'fixtureAccessSecret', 'fixtureGenericSig', 'fixtureRelativeSecret']) assert.ok(!body.includes(secret), 'credential leaked: ' + secret);
  assert.doesNotMatch(body, /X-Amz-|X-Goog-|access_token=|[?&]token=|[?&]signature=/i);
  assert.ok(body.includes('format=png&download=1')); assert.ok(body.includes('format=pdf'));
  assert.ok(body.includes('https://github.com/fixture/repo/blob/next.md?view=compact&signature_version=2#part'));
  assert.ok(body.includes('Image source: System diagram (not read)')); assert.ok(!body.includes('![System diagram]'));
  assert.throws(() => preparedBody(fixtureDoc({ text: '[Unsafe](https://user:fixturePassword@example.test/page)' })), /URL credentials/);
}));
