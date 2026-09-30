import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConfluenceApi, readWikiConfig } from '../../src/api.mjs';
import { loadStorageXml } from '../../src/document.mjs';
import { sha256, sourceId, saveJson } from './collect.mjs';
import { buildPlan, publishPlan, LIMITS, splitText } from './text_publish.mjs';

const artifacts = path.resolve('artifacts/laya-wiki/text-expansion/publication-fixtures');
await mkdir(artifacts, { recursive: true });
const run = await mkdtemp(path.join(artifacts, 'run-'));
const fixtureDoc = (name, text = '# Example\n\nShared body.', isPrivate = false) => {
  const source_url = 'https://github.com/fixture/repo/blob/main/' + name + '.md';
  const source_path = 'fixture/repo/' + name + '.md';
  return { id: sourceId('github', source_url, source_path), title: name, text, sha256: sha256(text), source_url, source_path, source_type: 'github', private: isPrivate };
};

async function fixture(t, name, behavior = {}) {
  const output = path.join(run, name); const requests = []; const pages = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const parts = []; for await (const chunk of req) parts.push(chunk);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : null;
    requests.push({ method: req.method, path: url.pathname, body });
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/wiki/rest/api/user/current') return send(200, { accountId: behavior.actor ?? 'actor' });
    if (url.pathname === '/wiki/api/v2/spaces') return send(200, { results: [{ id: '20', key: 'TEST' }] });
    if (url.pathname === '/wiki/rest/api/space/TEST') return send(200, { id: '20', key: 'TEST', permissions: [{ anonymousAccess: behavior.anonymous ?? false, unlicensedAccess: behavior.unlicensed ?? false }] });
    if (url.pathname === '/wiki/api/v2/pages' && req.method === 'POST') {
      if (behavior.rateLimit) return send(429, {});
      const page = { id: String(100 + pages.size), ...body, version: { number: 1 }, body: { storage: { value: body.body.value } } };
      pages.set(page.id, page);
      if (behavior.ambiguous) return req.socket.destroy();
      return send(200, page);
    }
    if (url.pathname.startsWith('/wiki/api/v2/pages/')) {
      const id = url.pathname.split('/').at(-1);
      if (id === '30') return send(200, { id, title: 'root', spaceId: behavior.rootSpace ?? '20', status: 'current', version: { number: 1 }, body: { storage: { value: '<p>Root</p>' } } });
      const page = structuredClone(pages.get(id));
      if (!page) return send(404, {});
      behavior.changeRead?.(page);
      return send(200, page);
    }
    send(500, { unexpected: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const tenant = 'http://127.0.0.1:' + server.address().port;
  const api = new ConfluenceApi(readWikiConfig({ CONFLUENCE_SITE_URL: tenant, CONFLUENCE_ALLOW_HTTP: 'true', CONFLUENCE_AUTH: 'bearer', CONFLUENCE_API_TOKEN: 'fixture' }));
  const binding = { tenant, apiUrl: api.config.apiUrl, v1Url: api.config.v1Url, spaceId: '20', spaceKey: 'TEST', rootId: '30', actorId: 'actor' };
  const approval = { schema: 1, private_space_visibility_approved: true, future_invited_users_may_read_acknowledged: true, site: tenant, api_url: binding.apiUrl, api_v1_url: binding.v1Url, space: 'TEST', space_id: '20', root_id: '30', actor_id: 'actor', roster_human_count: 1, anonymous_grants: 0, unlicensed_grants: 0, plan: 'Free', verified_at: new Date().toISOString(), approved_at: new Date().toISOString() };
  t.after(async () => {
    await saveJson(path.join(output, 'http.json'), requests);
    await saveJson(path.join(output, 'server-pages.json'), [...pages.values()]);
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return { api, binding, approval, output, requests, pages, behavior };
}

test('deduplicated text retains every private/public source identity and live matched text', async (t) => {
  // Given
  const f = await fixture(t, 'duplicates');
  const docs = [fixtureDoc('one'), fixtureDoc('two', undefined, true)];
  const plan = buildPlan(docs, f.binding);
  // When
  const result = await publishPlan(f.api, plan, f);
  // Then
  const matched = JSON.parse(await readFile(path.join(f.output, 'matched-corpus.json')));
  assert.equal(result.textUnits, 1);
  assert.equal(matched.length, 2);
  assert.deepEqual(new Set(matched.map((d) => d.id)), new Set(docs.map((d) => d.id)));
  assert.equal(matched.filter((d) => d.private).length, 1);
  assert.equal(matched[0].text, '# Example\n\nShared body.\n');
  assert.equal(matched[0].sha256, sha256('# Example\n\nShared body.\n'));
  assert.equal(matched[0].pages[0].id, matched[1].pages[0].id);
  assert.ok(f.requests.every((r) => !/attachment|image|github/.test(r.path)));
});

test('Cloud expand storage retains catalog records inside rich text body', async (t) => {
  // Given
  const readbacks = [];
  const f = await fixture(t, 'cloud-expand', { changeRead(page) {
    const $ = loadStorageXml(page.body.storage.value);
    $('ac\\:structured-macro[ac\\:name="expand"]').children('ac\\:structured-macro').remove();
    page.body.storage.value = $.xml();
    readbacks.push({ id: page.id, storage: page.body.storage.value });
  } });
  t.after(() => saveJson(path.join(f.output, 'cloud-readbacks.json'), readbacks));
  const doc = fixtureDoc('catalog');
  const plan = buildPlan([doc], f.binding);
  // When
  const result = await publishPlan(f.api, plan, f);
  // Then
  const catalog = plan.units.find((unit) => unit.key.startsWith('group/') && unit.links.length);
  const liveCatalog = readbacks.find((page) => page.storage.includes('<ul>'));
  const $ = loadStorageXml(liveCatalog.storage);
  const payload = $('ac\\:structured-macro[ac\\:name="expand"] > ac\\:rich-text-body > ac\\:structured-macro[ac\\:name="code"] > ac\\:plain-text-body').text();
  assert.equal(payload, catalog.text);
  assert.deepEqual(JSON.parse(payload).map((source) => source.id), [doc.id]);
  assert.equal(result.verified, 1);
  const [matched] = JSON.parse(await readFile(path.join(f.output, 'matched-corpus.json')));
  const $text = loadStorageXml(readbacks.find((page) => page.id === matched.pages[0].id).storage);
  assert.equal($text('ac\\:rich-text-body').length, 0);
  assert.equal($text.root().children('ac\\:structured-macro[ac\\:name="code"]').find('ac\\:plain-text-body').text(), '# Example\n\nShared body.\n');
});

test('oversized Unicode and CDATA are reconstructed byte exactly without image requests', async (t) => {
  // Given
  const f = await fixture(t, 'unicode');
  const original = '가🙂]]> & < text\u001e\u001f\n'.repeat(6000);
  const doc = fixtureDoc('unicode', '```text\n' + original + '```\n\n![asset](https://images.example/file.png?X-Amz-Signature=secret)\n\n![invalid](http://)\n\n![credential](https://user:pass@images.example/private.png)');
  const plan = buildPlan([doc], f.binding);
  const expected = '```text\n' + original + '```\n\n[Image source: asset (not read)](https://images.example/file.png)\n\n[Image source: invalid (not read)](http://)\n\n[Image source: credential (not read)](https://images.example/private.png)\n';
  // When
  await publishPlan(f.api, plan, f);
  // Then
  const [matched] = JSON.parse(await readFile(path.join(f.output, 'matched-corpus.json')));
  assert.equal(matched.text, expected);
  assert.ok(matched.chunks.length > 1);
  assert.ok(f.requests.filter((r) => r.method === 'POST').every((r) => Buffer.byteLength(r.body.body.value) <= LIMITS.bodyBytes));
  assert.ok(f.requests.every((r) => !/attachment|image/.test(r.path)));
  assert.equal(splitText(original, 23).join(''), original);
});

test('unsafe sources remain accounted for without being published or called verified', async (t) => {
  // Given
  const f = await fixture(t, 'excluded');
  const unsafe = fixtureDoc('unsafe', 'password = ' + 'x'.repeat(30), true);
  const plan = buildPlan([fixtureDoc('one'), unsafe], f.binding);
  // When
  const result = await publishPlan(f.api, plan, f);
  // Then
  await saveJson(path.join(f.output, 'plan.json'), plan);
  assert.equal(result.collected, 2); assert.equal(result.publishable, 1); assert.equal(result.excluded, 1); assert.equal(result.matched, 1);
  assert.equal(plan.excludedSources[0].id, unsafe.id);
  assert.equal(plan.excludedSources[0].source_sha256, unsafe.sha256);
  assert.equal(plan.excludedSources[0].reason, 'secret_looking_source');
  assert.equal(plan.counts.private, 1);
  const mapping = JSON.parse(await readFile(path.join(f.output, 'mapping.json')));
  assert.deepEqual(mapping.map((source) => source.status), ['verified', 'excluded']);
  assert.equal(mapping[1].id, unsafe.id);
  assert.ok(f.requests.filter((r) => r.method === 'POST').every((r) => !r.body.body.value.includes(unsafe.text)));
});

test('signed URLs in literal code are redacted and catalogs link named sources to live text', async (t) => {
  const f = await fixture(t, 'signed-code');
  const signature = 'TEST_ONLY_SIGNATURE';
  const doc = fixtureDoc('a'.repeat(109) + '🙂', '```text\ncurl https://files.example/doc?X-Amz-Signature=' + signature + '&format=text\n```');
  const plan = buildPlan([doc], f.binding);
  await publishPlan(f.api, plan, f);
  const [matched] = JSON.parse(await readFile(path.join(f.output, 'matched-corpus.json')));
  assert.ok(!matched.text.includes(signature));
  assert.ok(matched.text.includes('https://files.example/doc?format=text'));
  assert.equal(plan.counts.redactedSignedUrls, 1);
  assert.ok(plan.units.every((unit) => !/[\ud800-\udfff]/u.test(unit.title)));
  const textPage = f.pages.get(matched.pages[0].id);
  assert.ok(textPage.title.startsWith(doc.title));
  const catalog = [...f.pages.values()].find((page) => page.body.storage.value.includes('<ul>'));
  assert.ok(catalog.body.storage.value.includes(doc.title));
  assert.ok(catalog.body.storage.value.includes(f.api.pageUrl(matched.pages[0].id)));
});

for (const [name, change] of [
  ['missing', () => null], ['consent-false', (a) => ({ ...a, private_space_visibility_approved: false })],
  ['wrong-tenant', (a) => ({ ...a, site: 'https://wrong.example' })], ['wrong-root', (a) => ({ ...a, root_id: '31' })],
  ['wrong-actor', (a) => ({ ...a, actor_id: 'other' })], ['two-humans', (a) => ({ ...a, roster_human_count: 2 })],
]) test('private consent ' + name + ' refuses before HTTP writes', async (t) => {
  // Given
  const f = await fixture(t, 'approval-' + name);
  const plan = buildPlan([fixtureDoc('private', undefined, true)], f.binding);
  // When / Then
  await assert.rejects(publishPlan(f.api, plan, { ...f, approval: change(f.approval) }), { code: 'private_consent_required' });
  assert.equal(f.requests.length, 0);
});

for (const [name, behavior, code] of [
  ['actor', { actor: 'other' }, 'actor_mismatch'], ['root', { rootSpace: '21' }, 'root_mismatch'],
  ['anonymous', { anonymous: true }, 'unsafe_space_permissions'], ['unlicensed', { unlicensed: true }, 'unsafe_space_permissions'],
]) test('live access ' + name + ' mismatch refuses writes', async (t) => {
  // Given
  const f = await fixture(t, 'access-' + name, behavior);
  const plan = buildPlan([fixtureDoc('one')], f.binding);
  // When / Then
  await assert.rejects(publishPlan(f.api, plan, f), { code });
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 0);
});

test('API tenant mismatch refuses all HTTP', async (t) => {
  // Given
  const f = await fixture(t, 'tenant');
  const plan = buildPlan([fixtureDoc('one')], { ...f.binding, tenant: 'https://wrong.example' });
  // When / Then
  await assert.rejects(publishPlan(f.api, plan, f), { code: 'tenant_mismatch' });
  assert.equal(f.requests.length, 0);
});

test('confirmed restart performs fresh reads and no additional creates', async (t) => {
  // Given
  const f = await fixture(t, 'resume'); const plan = buildPlan([fixtureDoc('one')], f.binding);
  await publishPlan(f.api, plan, f);
  const before = f.requests.length; const pages = f.pages.size;
  // When
  const result = await publishPlan(f.api, plan, f);
  // Then
  assert.equal(f.pages.size, pages);
  assert.equal(result.confirmed, pages);
  assert.equal(f.requests.slice(before).filter((r) => r.method !== 'GET').length, 0);
  assert.equal(f.requests.slice(before).filter((r) => /\/pages\/(?!30$)/.test(r.path)).length, pages);
});

for (const change of ['content', 'identity']) test('changed source ' + change + ' cannot resume cache', async (t) => {
  // Given
  const f = await fixture(t, 'source-' + change);
  await publishPlan(f.api, buildPlan([fixtureDoc('one')], f.binding), f);
  const before = f.requests.length;
  const doc = change === 'content' ? fixtureDoc('one', 'Changed') : fixtureDoc('different');
  // When / Then
  await assert.rejects(publishPlan(f.api, buildPlan([doc], f.binding), f), { code: 'cache_binding_mismatch' });
  assert.equal(f.requests.length, before);
});

test('ambiguous POST persists pending journal and restart never blindly POSTs', async (t) => {
  // Given
  const f = await fixture(t, 'ambiguous', { ambiguous: true }); const plan = buildPlan([fixtureDoc('one')], f.binding);
  await assert.rejects(publishPlan(f.api, plan, f));
  const journal = JSON.parse(await readFile(path.join(f.output, 'units', sha256('index') + '.json')));
  // When / Then
  await assert.rejects(publishPlan(f.api, plan, f), { code: 'ambiguous_mutation_requires_reconciliation' });
  assert.equal(journal.status, 'pending');
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1);
});

test('rate limit has no automatic mutation retry', async (t) => {
  // Given
  const f = await fixture(t, 'rate-limit', { rateLimit: true }); const plan = buildPlan([fixtureDoc('one')], f.binding);
  // When / Then
  await assert.rejects(publishPlan(f.api, plan, f), { status: 429 });
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1);
});

for (const field of ['text', 'source-id', 'version', 'title', 'parent', 'space']) test('readback ' + field + ' mismatch preserves accepted identity and fails', async (t) => {
  // Given
  const f = await fixture(t, 'readback-' + field, { changeRead(page) {
    if (field === 'text') page.body.storage.value = page.body.storage.value.replace('Text-only', 'Altered');
    if (field === 'source-id' && page.body.storage.value.includes('source_sha256')) page.body.storage.value = page.body.storage.value.replace(/"id":"[a-f0-9]+"/, '"id":"changed"');
    if (field === 'version') page.version.number = 2;
    if (field === 'title') page.title = 'altered';
    if (field === 'parent') page.parentId = '999';
    if (field === 'space') page.spaceId = '999';
  } });
  const plan = buildPlan([fixtureDoc('one')], f.binding);
  // When / Then
  await assert.rejects(publishPlan(f.api, plan, f), { code: ['text', 'source-id'].includes(field) ? 'readback_content_mismatch' : 'readback_identity_mismatch' });
  const key = field === 'source-id' ? plan.units.find((unit) => unit.text.includes('source_sha256')).key : 'index';
  const journal = JSON.parse(await readFile(path.join(f.output, 'units', sha256(key) + '.json')));
  assert.equal(journal.status, 'accepted');
  assert.ok(/^\d+$/.test(journal.id));
});

test('accepted identity can resume exact readback after temporary read failure', async (t) => {
  // Given
  const f = await fixture(t, 'accepted-resume', { changeRead(page) { page.version.number = 2; } });
  const plan = buildPlan([fixtureDoc('one')], f.binding);
  await assert.rejects(publishPlan(f.api, plan, f));
  f.behavior.changeRead = undefined;
  // When
  const result = await publishPlan(f.api, plan, f);
  // Then
  assert.equal(result.confirmed, plan.units.length);
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, plan.units.length);
});

test('CLI help and malformed arguments return deterministic exit status', async () => {
  // Given
  const cases = [['--help'], ['--unknown'], ['--corpus', ''], ['--binding', 'missing']];
  // When
  const results = cases.map((args) => {
    const result = spawnSync(process.execPath, ['experiments/laya-wiki/text_publish.mjs', ...args], { encoding: 'utf8' });
    return { args, status: result.status, stdout: result.stdout, stderr: result.stderr };
  });
  // Then
  await saveJson(path.join(run, 'cli.json'), results);
  assert.deepEqual(results.map((r) => r.status), [0, 1, 1, 1]);
  assert.ok(results[0].stdout.length > 0);
});

test('CLI defaults to offline plan and outputs only aggregate counts', async () => {
  // Given
  const output = path.join(run, 'offline');
  await saveJson(path.join(output, 'corpus.json'), [fixtureDoc('one')]);
  await saveJson(path.join(output, 'binding-input.json'), { tenant: 'https://offline.invalid', apiUrl: 'https://offline.invalid/wiki/api/v2', v1Url: 'https://offline.invalid/wiki/rest/api', spaceId: '20', spaceKey: 'TEST', rootId: '30', actorId: 'actor' });
  // When
  const result = spawnSync(process.execPath, ['experiments/laya-wiki/text_publish.mjs', '--corpus', path.join(output, 'corpus.json'), '--binding', path.join(output, 'binding-input.json'), '--output', output], { encoding: 'utf8' });
  // Then
  await saveJson(path.join(output, 'cli.json'), { status: result.status, stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.status, 0);
  assert.ok(Object.values(JSON.parse(result.stdout)).every((v) => typeof v === 'number'));
  assert.equal(JSON.parse(await readFile(path.join(output, 'plan.json'))).counts.sources, 1);
});
