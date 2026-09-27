import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { access, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createClient, readConfig, verifyPageUpdate } from '../scripts/confluence.mjs';
import { ConfluenceApi, readWikiConfig } from '../src/api.mjs';
import { readStorageSnapshot } from '../src/evidence.mjs';
import { bodyHash, formatDocument } from '../src/document.mjs';

const entry = process.env.CFWIKI_TEST_ENTRY ?? fileURLToPath(new URL('../scripts/confluence.mjs', import.meta.url));

async function wikiCliFixture(t, deployment, { search, loseCreate = false, failMetadata = false, failRootMarker = false } = {}) {
  const dc = deployment === 'datacenter';
  const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-cli-wave-f-'));
  const token = 'cli-wave-f-secret';
  const pages = new Map();
  const history = new Map();
  const properties = new Map();
  const rootProperties = new Map();
  const rootPropertyReadFailures = new Map();
  const requests = [];
  let serial = 500;
  let candidateChanges = 0;
  let rootReadTransition;
  const makePage = ({ id, title, spaceId = '12', spaceKey = 'TEST', parentId = null, storage, version = 1, status = 'current' }) => {
    const page = { id: String(id), title, spaceId: String(spaceId), spaceKey, parentId: parentId == null ? null : String(parentId), storage, version, status };
    pages.set(page.id, page);
    history.set(page.id, new Map([[version, structuredClone(page)]]));
    return page;
  };
  makePage({ id: '900', title: 'Release rollout evidence', storage: '<p>Stale search candidate body.</p>', version: 1 });
  makePage({ id: '999', title: 'Foreign secret page', spaceId: '99', spaceKey: 'OTHER', storage: '<p>FOREIGN SECRET BODY MUST NOT LEAK</p>' });
  const respondPage = (page) => dc
    ? { id: page.id, type: 'page', title: page.title, status: page.status, version: { number: page.version }, body: { storage: { value: page.storage } }, space: { id: page.spaceId, key: page.spaceKey }, ancestors: page.parentId ? [{ id: page.parentId }] : [] }
    : { id: page.id, title: page.title, status: page.status, version: { number: page.version }, body: { storage: { value: page.storage } }, spaceId: page.spaceId, ...(page.parentId ? { parentId: page.parentId } : {}) };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path: url.pathname, query: url.search, body, authorization: req.headers.authorization });
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
    if (req.headers.authorization !== 'Bearer ' + token) return send(401, { token, body: 'secret response body' });
    if (url.pathname === (dc ? '/confluence/rest/api/space/TEST' : '/wiki/api/v2/spaces')) {
      return send(200, dc ? { id: '12', key: 'TEST', name: 'Fixture' } : { results: [{ id: '12', key: 'TEST', name: 'Fixture', homepageId: '800' }] });
    }
    if (dc && url.pathname === '/confluence/rest/api/space/OTHER') return send(200, { id: '99', key: 'OTHER', name: 'Other' });
    const createPath = dc ? '/confluence/rest/api/content' : '/wiki/api/v2/pages';
    if (req.method === 'POST' && url.pathname === createPath) {
      const id = String(++serial);
      const parentId = dc ? body.ancestors?.at(-1)?.id ?? null : body.parentId ?? '800';
      const storage = dc ? body.body.storage.value : body.body.value;
      const page = makePage({ id, title: body.title, parentId, storage });
      if (loseCreate) { req.socket.destroy(); return; }
      return send(200, respondPage(page));
    }
    const childPath = dc ? /^\/confluence\/rest\/api\/content\/(\d+)\/child\/page$/ : /^\/wiki\/api\/v2\/pages\/(\d+)\/children$/;
    const childMatch = url.pathname.match(childPath);
    if (req.method === 'GET' && childMatch) {
      return send(200, { results: [...pages.values()].filter((page) => page.parentId === childMatch[1]).map(respondPage) });
    }
    const pageMatch = url.pathname.match(dc ? /^\/confluence\/rest\/api\/content\/(\d+)$/ : /^\/wiki\/api\/v2\/pages\/(\d+)$/);
    if (pageMatch) {
      const page = pages.get(pageMatch[1]);
      if (!page) return send(404, {});
      if (req.method === 'GET') {
        if (page.httpStatus) return send(page.httpStatus, { body: 'RESTRICTED RESPONSE BODY MUST NOT LEAK' });
        const requested = url.searchParams.get('version');
        const selected = requested ? history.get(page.id)?.get(Number(requested)) : page;
        if (!selected) return send(404, {});
        if (!requested && rootReadTransition?.rootId === page.id) {
          const transition = rootReadTransition;
          rootReadTransition = undefined;
          res.once('finish', () => {
            const target = pages.get(transition.targetId);
            history.get(target.id).set(target.version, structuredClone(target));
            Object.assign(target, transition.change, { version: target.version + 1 });
            transition.resolve();
          });
        }
        return send(200, respondPage({ ...selected, status: requested && Number(requested) < page.version ? 'historical' : selected.status }));
      }
      if (req.method === 'PUT') {
        if (body.version.number !== page.version + 1) return send(409, { token, body: 'secret response body' });
        history.get(page.id).set(page.version, structuredClone(page));
        page.title = body.title;
        page.storage = dc ? body.body.storage.value : body.body.value;
        page.parentId = dc ? body.ancestors?.at(-1)?.id ?? null : body.parentId ?? null;
        page.version = body.version.number;
        page.status = 'current';
        return send(200, respondPage(page));
      }
      if (req.method === 'DELETE') {
        page.status = 'trashed';
        return send(204);
      }
    }
    const propertyId = url.pathname.match(dc
      ? /^\/confluence\/rest\/api\/content\/(\d+)\/property(?:\/([^/]+))?$/
      : /^\/wiki\/api\/v2\/pages\/(\d+)\/properties$/);
    if (propertyId) {
      const id = propertyId[1];
      const key = req.method === 'GET'
        ? dc ? propertyId[2] : url.searchParams.get('key')
        : body?.key;
      const rootProperty = key === 'cfwiki-root';
      const selected = rootProperty ? rootProperties : properties;
      const exists = selected.get(id);
      if (req.method === 'GET') {
        if (rootProperty && rootPropertyReadFailures.has(id)) return send(rootPropertyReadFailures.get(id), { body: 'FOREIGN PROPERTY BODY MUST NOT LEAK' });
        if (dc) return exists ? send(200, exists) : send(404, {});
        return send(200, { results: exists ? [exists] : [] });
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        if ((rootProperty && failRootMarker) || (!rootProperty && failMetadata)) return send(500, { token, body: 'secret response body' });
        const property = { ...body, id: 'property-' + id, version: body.version ?? { number: 1 } };
        selected.set(id, property);
        return send(200, property);
      }
    }
    if (url.pathname.endsWith('/label') || url.pathname.endsWith('/labels')) return send(200, { results: [] });
    if (url.pathname === (dc ? '/confluence/rest/api/search' : '/wiki/rest/api/search')) {
      if (search) return send(200, search(url));
      const stale = { content: { id: '900', title: 'Release rollout evidence', space: { key: 'TEST' }, version: { number: 1 } }, excerpt: 'STALE CANDIDATE EXCERPT' };
      if (candidateChanges++ === 0) {
        const page = pages.get('900');
        history.get('900').set(page.version, structuredClone(page));
        page.version = 2;
        page.storage = '<ac:structured-macro ac:name="panel"><ac:rich-text-body><p>Current rollout evidence: RELEASE-42 is deployed.</p><ac:link><ri:page ri:content-id="' + [...pages.values()].find((item) => item.title === 'Release code')?.id + '"/></ac:link><ac:link><ri:page ri:content-id="9998"/></ac:link></ac:rich-text-body></ac:structured-macro>';
      }
      return send(200, { results: [stale, { content: { id: '999', title: 'Foreign secret page', space: { key: 'OTHER' } }, excerpt: 'FOREIGN SECRET SNIPPET' }] });
    }
    return send(404, {});
  });
  t.after(async () => {
    try {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      assert.equal(server.listening, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await assert.rejects(access(directory), { code: 'ENOENT' });
    }
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const origin = 'http://127.0.0.1:' + server.address().port;
  const site = origin + (dc ? '/confluence' : '');
  const profile = path.join(directory, 'profile.env');
  await writeFile(profile, Object.entries({
    CONFLUENCE_DEPLOYMENT: deployment, CONFLUENCE_AUTH: 'bearer', CONFLUENCE_PAT: token,
    CONFLUENCE_SITE_URL: site, CONFLUENCE_API_URL: site + (dc ? '/rest/api' : '/wiki/api/v2'),
    ...(dc ? {} : { CONFLUENCE_API_V1_URL: origin + '/wiki/rest/api' }),
    CONFLUENCE_SPACE_KEY: 'TEST', CONFLUENCE_ALLOW_HTTP: 'true',
  }).map(([key, value]) => key + '=' + value).join('\n'));
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CONFLUENCE_')));
  const cli = async (...args) => {
    const child = spawn(process.execPath, [entry, ...args, '--env', profile], { cwd: directory, env: cleanEnv, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  };
  const armRootReadTransition = (rootId, targetId, change) => {
    let resolve;
    const completed = new Promise((done) => { resolve = done; });
    rootReadTransition = { rootId: String(rootId), targetId: String(targetId), change, resolve };
    return completed;
  };
  const config = readWikiConfig({
    CONFLUENCE_DEPLOYMENT: deployment, CONFLUENCE_AUTH: 'bearer', CONFLUENCE_PAT: token,
    CONFLUENCE_SITE_URL: site, CONFLUENCE_API_URL: site + (dc ? '/rest/api' : '/wiki/api/v2'),
    ...(dc ? {} : { CONFLUENCE_API_V1_URL: origin + '/wiki/rest/api' }),
    CONFLUENCE_SPACE_KEY: 'TEST', CONFLUENCE_ALLOW_HTTP: 'true',
  });
  return { cli, directory, profile, pages, properties, rootProperties, rootPropertyReadFailures, requests, token, seedPage: makePage, armRootReadTransition, api: new ConfluenceApi(config) };
}

function requestCount(fixture, method, pathPattern) {
  return fixture.requests.filter((request) => request.method === method && pathPattern.test(request.path)).length;
}

for (const deployment of ['cloud', 'datacenter']) {
  test('CLI preserves CDATA negation in scoped read and explore (' + deployment + ')', { timeout: 15000 }, async (t) => {
    const f = await wikiCliFixture(t, deployment, { search: () => ({ results: [
      { content: { id: '900', title: 'Release decision', space: { key: 'TEST' }, version: { number: 1 } }, excerpt: 'The release is approved.' },
    ] }) });
    f.pages.get('900').title = 'Release decision';
    f.pages.get('900').storage = '<p>The release is <![CDATA[not ]]>approved.</p>';

    const read = await f.cli('read', '900', '--space', 'TEST', '--json');
    const initialized = await f.cli('init', '--space', 'TEST', '--topic', 'Release operations', '--json');
    assert.equal(initialized.code, 0, initialized.stderr);
    const root = JSON.parse(initialized.stdout);
    const beforeExplore = f.requests.length;
    const explored = await f.cli('explore', 'Is the release approved?', '--wiki-root', root.id, '--space', 'TEST', '--json');

    assert.equal(read.code, 0, read.stderr);
    const readReport = JSON.parse(read.stdout);
    assert.deepEqual(readReport.passages, [{ text: 'The release is not approved.', qualifier: null }]);
    assert.ok(!read.stdout.includes('The release is approved.'));
    assert.ok(!read.stdout.includes(f.token));
    assert.equal(explored.code, 0, explored.stderr);
    const report = JSON.parse(explored.stdout);
    assert.equal(report.status, 'unassessed');
    const evidence = report.evidence.find((item) => item.id === '900');
    assert.ok(evidence);
    assert.equal(evidence.version, 1);
    assert.match(evidence.url, /pageId=900$/);
    assert.ok(Number.isFinite(Date.parse(evidence.readAt)));
    assert.deepEqual(evidence.passages, [{ text: 'The release is not approved.', qualifier: null }]);
    assert.ok(!explored.stdout.includes('The release is approved.'));
    assert.ok(!explored.stdout.includes(f.token));
    const exploreRequests = f.requests.slice(beforeExplore);
    assert.ok(exploreRequests.every((request) => request.method === 'GET'));
    assert.equal(requestCount({ requests: exploreRequests }, 'PUT', /\/pages\/\d+$|\/content\/\d+$/), 0);
    assert.equal(requestCount({ requests: exploreRequests }, 'POST', /\/pages$|\/content$/), 0);
  });

  test('CLI reports unknown root create and partial term metadata (' + deployment + ')', { timeout: 30000 }, async (t) => {
    const lost = await wikiCliFixture(t, deployment, { loseCreate: true });
    const unknown = await lost.cli('init', '--space', 'TEST', '--topic', 'Unknown root', '--json');
    assert.equal(unknown.code, 1, unknown.stderr);
    assert.equal(JSON.parse(unknown.stdout).status, 'unresolved');
    assert.equal(JSON.parse(unknown.stdout).id, null);
    assert.equal(requestCount(lost, 'POST', /\/pages$|\/content$/), 1);
    assert.equal(lost.pages.size, 3);
    assert.equal(lost.requests.some((request) => request.path.endsWith('/search')), false);

    const markerFailure = await wikiCliFixture(t, deployment, { failRootMarker: true });
    const incompleteRoot = await markerFailure.cli('init', '--space', 'TEST', '--topic', 'Unmarked root', '--json');
    assert.equal(incompleteRoot.code, 1, incompleteRoot.stderr);
    const incompleteReport = JSON.parse(incompleteRoot.stdout);
    assert.equal(incompleteReport.status, 'unresolved');
    assert.match(incompleteReport.id, /^\d+$/);
    assert.equal(requestCount(markerFailure, 'POST', /\/pages$|\/content$/), 1);
    assert.equal(markerFailure.rootProperties.has(incompleteReport.id), false);
    const rejectedReuse = await markerFailure.cli('init', '--space', 'TEST', '--topic', 'Unmarked root', '--existing-root', incompleteReport.id, '--json');
    assert.notEqual(rejectedReuse.code, 0);
    assert.equal(requestCount(markerFailure, 'POST', /\/pages$|\/content$/), 1);

    const partial = await wikiCliFixture(t, deployment, { failMetadata: true });
    const initialized = await partial.cli('init', '--space', 'TEST', '--topic', 'Partial metadata', '--json');
    assert.equal(initialized.code, 0, initialized.stderr);
    const root = JSON.parse(initialized.stdout);
    const content = path.join(partial.directory, 'term.md');
    await writeFile(content, 'Explicit term definition.');
    const created = await partial.cli('create', 'Partial term', '--wiki-root', root.id, '--space', 'TEST', '--content', content, '--json');
    assert.equal(created.code, 1, created.stderr);
    const report = JSON.parse(created.stdout);
    assert.equal(report.status, 'partial');
    assert.equal(report.parentId, root.id);
    assert.equal(report.version, 1);
    assert.equal(partial.pages.get(report.id).parentId, root.id);
    assert.match(report.url, new RegExp('pageId=' + report.id + '$'));
    assert.deepEqual(report.resources.page, { status: 'saved', version: 1 });
    assert.deepEqual(report.resources.metadata, { status: 'failed', outcome: 'unresolved' });
    assert.equal(requestCount(partial, 'POST', /\/pages$|\/content$/), 2);
    assert.doesNotMatch(created.stdout + created.stderr + unknown.stdout + unknown.stderr, /cli-wave-f-secret|secret response body/);
  });

  test('CLI explore keeps host assessment separate from two-hop evidence (' + deployment + ')', { timeout: 30000 }, async (t) => {
    const f = await wikiCliFixture(t, deployment, { search: () => ({ results: [
      { content: { id: '703', title: 'Candidate', space: { key: 'TEST' } }, excerpt: 'UNSUPPORTED SEARCH CLAIM' },
    ] }) });
    f.seedPage({ id: '700', title: 'Approval Wiki', parentId: deployment === 'cloud' ? '800' : null, storage: '<ac:structured-macro ac:name="panel"><ac:rich-text-body><ac:link><ri:page ri:content-id="701"/></ac:link></ac:rich-text-body></ac:structured-macro>' });
    f.rootProperties.set('700', { key: 'cfwiki-root', value: {
      schema: 1, pageId: '700', spaceId: '12', spaceKey: 'TEST', topic: 'Approval',
      tenant: { deployment, siteUrl: f.api.config.siteUrl, apiUrl: f.api.config.apiUrl },
    }, id: 'property-700', version: { number: 1 } });
    f.seedPage({ id: '701', title: 'Procedure', storage: '<p>Approval depends on the correction.</p><ac:link><ri:page ri:content-id="702"/><ac:link-body>Correction</ac:link-body></ac:link>' });
    f.seedPage({ id: '702', title: 'Correction', version: 8, storage: '<h2>Decision</h2><p>The release is not approved.</p>' });
    f.seedPage({ id: '703', title: 'Supporting evidence', storage: '<p>Unrelated supporting fact.</p>' });
    const rootMarkerReads = (requests) => requests.filter((request) => request.method === 'GET' &&
      (deployment === 'datacenter'
        ? request.path.endsWith('/content/700/property/cfwiki-root')
        : request.path.endsWith('/pages/700/properties') && new URLSearchParams(request.query).get('key') === 'cfwiki-root')).length;
    const beforeFirst = f.requests.length;
    const result = await f.cli('explore', 'Is the release approved and what is its unknown cost?', '--wiki-root', '700', '--space', 'TEST', '--json');
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'unassessed');
    assert.equal(report.coverage.sufficient, null);
    assert.equal(report.coverage.atomicSnapshot, false);
    assert.equal(report.coverage.crossInvocationBudget, false);
    assert.equal(report.stopReason, 'exhausted');
    assert.ok(report.coverage.limitations.includes('incomplete-extraction'));
    assert.deepEqual(report.selections.map(({ frontier, id }) => [frontier, id]), [
      ['root', '700'], ['search', '703'], ['forward', '701'], ['forward', '702'],
    ]);
    const correction = report.evidence.find((item) => item.id === '702');
    assert.equal(correction.version, 8);
    assert.equal(correction.sourceType, 'confluence-storage');
    assert.equal(correction.url, f.api.pageUrl('702'));
    assert.ok(Number.isFinite(Date.parse(correction.readAt)));
    assert.deepEqual(correction.routes[0].path, ['700', '701', '702']);
    assert.deepEqual(correction.passages, [{ text: 'The release is not approved.', qualifier: 'Decision' }]);
    assert.equal(report.usage.pageReads, 4);
    assert.equal(report.usage.httpAttempts, 7);
    assert.equal(rootMarkerReads(f.requests.slice(beforeFirst)), 1);
    assert.doesNotMatch(result.stdout, /UNSUPPORTED SEARCH CLAIM/);

    f.pages.get('702').httpStatus = 403;
    const beforeDenied = f.requests.length;
    const denied = await f.cli('explore', 'Is the release approved?', '--wiki-root', '700', '--space', 'TEST', '--json');
    assert.equal(denied.code, 0, denied.stderr);
    const restricted = JSON.parse(denied.stdout);
    assert.equal(restricted.status, 'partial');
    assert.equal(restricted.stopReason, 'denied');
    assert.equal(restricted.coverage.sufficient, null);
    assert.equal(restricted.evidence.some((item) => item.id === '702'), false);
    assert.equal(restricted.evidence.find((item) => item.id === '701').claimsStatus, 'unresolved-dependencies');
    assert.equal(restricted.materialCorrectionLinks[0].reason, 'denied');
    assert.ok(restricted.coverage.limitations.includes('unresolved-targets'));
    assert.equal(restricted.usage.pageReads, 4);
    assert.equal(restricted.usage.httpAttempts, 7);
    assert.equal(rootMarkerReads(f.requests.slice(beforeDenied)), 1);
    assert.doesNotMatch(denied.stdout + denied.stderr, /RESTRICTED RESPONSE BODY|cli-wave-f-secret/);

    delete f.pages.get('702').httpStatus;
    f.pages.get('702').storage += '<ac:link><ri:page ri:content-id="704"/></ac:link>';
    f.seedPage({ id: '704', title: 'Beyond depth', storage: '<p>UNREAD BUDGET CLAIM</p>' });
    const beforeBounded = f.requests.length;
    const bounded = await f.cli('explore', 'What does the last page establish?', '--wiki-root', '700', '--space', 'TEST', '--json');
    assert.equal(bounded.code, 0, bounded.stderr);
    const limited = JSON.parse(bounded.stdout);
    assert.equal(limited.status, 'partial');
    assert.equal(limited.stopReason, 'budget');
    assert.deepEqual(limited.budgetLimits, ['depth']);
    assert.equal(limited.coverage.sufficient, null);
    assert.ok(limited.coverage.limitations.includes('budget'));
    assert.equal(limited.unresolvedLinks[0].targetId, '704');
    assert.equal(limited.unresolvedLinks[0].reason, 'budget:depth');
    assert.equal(limited.usage.pageReads, 4);
    assert.equal(limited.usage.httpAttempts, 7);
    assert.equal(rootMarkerReads(f.requests.slice(beforeBounded)), 1);
    assert.equal(requestCount(f, 'GET', /\/(?:pages|content)\/704$/), 0);
    assert.doesNotMatch(bounded.stdout, /UNREAD BUDGET CLAIM/);
    assert.ok(f.requests.every((request) => request.method === 'GET'));
  });

  test('CLI rejects root deletion and foreign evidence with bounded abstention (' + deployment + ')', { timeout: 15000 }, async (t) => {
    let cursor = 0;
    const f = await wikiCliFixture(t, deployment, { search: () => {
      const start = cursor++ * 5;
      return {
        results: Array.from({ length: 5 }, (_, i) => ({
          content: { id: String(800 + start + i), title: 'Denied candidate', space: { key: 'TEST' } },
          excerpt: 'FOREIGN SECRET SNIPPET',
        })),
        _links: { next: '/search?cursor=' + cursor + '&cql=space=OTHER&limit=9000' },
      };
    } });
    const result = await f.cli('explore', 'Unsupported claim', '--wiki-root', '999', '--space', 'TEST', '--json');
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'abstained');
    assert.deepEqual(report.evidence, []);
    assert.equal(report.coverage.sufficient, null);
    assert.ok(report.coverage.limitations.includes('truncated-search'));
    assert.ok(report.coverage.limitations.includes('denied'));
    assert.equal(report.stopReason, 'denied');
    assert.equal(report.usage.searches, 1);
    assert.equal(report.usage.pageReads, 11);
    assert.equal(report.usage.httpAttempts, 14);
    assert.equal(f.requests.length, 14);
    assert.equal(cursor, 2);
    for (const request of f.requests.filter((request) => request.path.endsWith('/search'))) {
      const query = new URLSearchParams(request.query);
      assert.match(query.get('cql'), /space = "TEST"/);
      assert.doesNotMatch(query.get('cql'), /OTHER/);
      assert.equal(query.get('limit'), '10');
    }
    assert.equal(new Set(f.requests.filter((request) => /\/(?:pages|content)\/\d+$/.test(request.path)).map((request) => request.path)).size, 11);
    assert.ok(f.requests.every((request) => request.method === 'GET'));
    assert.doesNotMatch(result.stdout + result.stderr, /FOREIGN SECRET|cli-wave-f-secret/);
  });

  test('CLI create verifies explicit related IDs and labels unfetched sources (' + deployment + ')', async (t) => {
    const f = await wikiCliFixture(t, deployment);
    const rootResult = await f.cli('init', '--space', 'TEST', '--topic', 'Linked terms', '--json');
    assert.equal(rootResult.code, 0, rootResult.stderr);
    const root = JSON.parse(rootResult.stdout);
    f.seedPage({ id: '901', title: 'Related protocol', storage: '<p>Current protocol.</p>', version: 3 });
    f.seedPage({ id: '902', title: 'Related decision', storage: '<p>Current decision.</p>', version: 5 });
    const contentPath = path.join(f.directory, 'linked-content.md');
    await writeFile(contentPath, 'Definition with a host-authored [unverified link](https://example.test/pageId=999).');
    const createPath = deployment === 'datacenter' ? /\/confluence\/rest\/api\/content$/ : /\/wiki\/api\/v2\/pages$/;
    const before = f.requests.length;
    const created = await f.cli('create', 'Linked term', '--wiki-root', root.id, '--space', 'TEST', '--content', contentPath,
      '--related', '901', '--related', '902', '--source-url', 'https://docs.example.test/one',
      '--source-url', 'https://docs.example.test/two', '--json');
    assert.equal(created.code, 0, created.stderr);
    const report = JSON.parse(created.stdout);
    assert.equal(report.status, 'created');
    assert.equal(report.parentId, root.id);
    assert.deepEqual(report.related.map(({ id, title, version }) => ({ id, title, version })), [
      { id: '901', title: 'Related protocol', version: 3 },
      { id: '902', title: 'Related decision', version: 5 },
    ]);
    assert.ok(report.related.every(({ url, id }) => url.endsWith('pageId=' + id)));
    assert.deepEqual(report.sources, [
      { url: 'https://docs.example.test/one', fetched: false },
      { url: 'https://docs.example.test/two', fetched: false },
    ]);
    const createRequests = f.requests.slice(before);
    assert.equal(requestCount({ requests: createRequests }, 'GET', /\/(?:pages|content)\/901$/), 1);
    assert.equal(requestCount({ requests: createRequests }, 'GET', /\/(?:pages|content)\/902$/), 1);
    assert.equal(requestCount({ requests: createRequests }, 'GET', /\/(?:pages|content)\/999$/), 0);
    assert.equal(requestCount({ requests: createRequests }, 'POST', createPath), 1);
    assert.ok(createRequests.every(({ path: requestPath }) => !requestPath.includes('docs.example.test')));
    const storage = f.pages.get(report.id).storage;
    assert.match(storage, /Related pages/);
    assert.match(storage, /Sources \(not fetched\)/);
    assert.match(storage, /pageId=901/);
    assert.match(storage, /pageId=902/);
    assert.match(storage, /docs\.example\.test\/one/);
    assert.match(storage, /docs\.example\.test\/two/);
    assert.match(storage, /not fetched/);
    assert.match(storage, /pageId=999/);
    assert.doesNotMatch(created.stdout + created.stderr, /FOREIGN SECRET BODY MUST NOT LEAK|cli-wave-f-secret/);

    const postsBeforeFailure = requestCount(f, 'POST', createPath);
    const cases = [
      ['foreign', ['--related', '999'], /outside the trusted space/i],
      ['non-numeric', ['--related', 'not-an-id'], /related IDs must be numeric/i],
      ['protocol', ['--source-url', 'file:\/\/\/tmp\/secret'], /HTTP or HTTPS URL/i],
      ['credentials', ['--source-url', 'https:\/\/user:password@docs.example.test/private'], /without credentials/i],
    ];
    for (const [name, options, error] of cases) {
      const requestOffset = f.requests.length;
      const rejected = await f.cli('create', 'Rejected ' + name, '--wiki-root', root.id, '--space', 'TEST', '--content', contentPath, ...options, '--json');
      assert.notEqual(rejected.code, 0);
      assert.match(rejected.stderr, error);
      assert.equal(requestCount(f, 'POST', createPath), postsBeforeFailure);
      assert.equal(requestCount({ requests: f.requests.slice(requestOffset) }, 'GET', /\/(?:pages|content)\/999$/), name === 'foreign' ? 1 : 0);
      assert.doesNotMatch(rejected.stdout + rejected.stderr, /FOREIGN SECRET BODY MUST NOT LEAK|cli-wave-f-secret|user:password/);
    }
    assert.ok(![...f.pages.values()].some(({ title }) => title.startsWith('Rejected ')));
    const invalidUse = await f.cli('read', '901', '--related', '902', '--json');
    assert.notEqual(invalidUse.code, 0);
    assert.match(invalidUse.stderr, /supported by create only/i);
  });

  test('CLI init create explore and term lifecycle (' + deployment + ')', async (t) => {
    const f = await wikiCliFixture(t, deployment);
    const init = await f.cli('init', '--space', 'TEST', '--topic', 'Release operations', '--json');
    assert.equal(init.code, 0, init.stderr);
    const root = JSON.parse(init.stdout);
    assert.equal(root.status, 'confirmed');
    assert.equal(root.reused, false);
    assert.match(root.id, /^\d+$/);
    assert.equal(root.spaceId, '12');
    assert.match(root.url, new RegExp('pageId=' + root.id + '$'));
    const postsAfterCreate = requestCount(f, 'POST', /\/pages$|\/content$/);
    assert.equal(postsAfterCreate, 1);
    const reused = await f.cli('init', '--space', 'TEST', '--topic', 'Release operations', '--existing-root', root.id, '--json');
    assert.equal(reused.code, 0, reused.stderr);
    assert.equal(JSON.parse(reused.stdout).reused, true);
    assert.equal(requestCount(f, 'POST', /\/pages$|\/content$/), postsAfterCreate);

    const contentPath = path.join(f.directory, 'term-content.md');
    await writeFile(contentPath, '# Release code\n\nInitial term definition.');
    const created = await f.cli('create', 'Release code', '--wiki-root', root.id, '--space', 'TEST', '--content', contentPath, '--json');
    assert.equal(created.code, 0, created.stderr);
    const term = JSON.parse(created.stdout);
    assert.equal(term.status, 'created');
    assert.equal(term.title, 'Release code');
    assert.equal(term.parentId, root.id);
    assert.equal(term.version, 1);
    assert.match(term.url, new RegExp('pageId=' + term.id + '$'));
    assert.equal(requestCount(f, 'POST', /\/pages$|\/content$/), postsAfterCreate + 1);
    assert.equal(f.properties.get(term.id).value.metadata.type, 'DefinedTerm');
    assert.deepEqual(term.resources.page, { status: 'saved', version: 1 });
    assert.deepEqual(term.resources.metadata, { status: 'saved' });

    const read = await f.cli('read', term.id, '--wiki-root', root.id, '--space', 'TEST', '--json');
    assert.equal(read.code, 0, read.stderr);
    const readReport = JSON.parse(read.stdout);
    assert.equal(readReport.id, term.id);
    assert.equal(readReport.parentId, root.id);
    assert.equal(readReport.version, 1);
    assert.match(readReport.body, /Initial term definition/);

    const snapshot = await readStorageSnapshot(f.api, term.id, { space: 'TEST' });
    const baseDocument = {
      metadata: {
        type: 'DefinedTerm', title: snapshot.title,
        confluence: {
          deployment: snapshot.tenant.deployment, api_url: snapshot.tenant.apiUrl,
          site_url: snapshot.tenant.siteUrl, id: snapshot.id, space: snapshot.space.key,
          version: snapshot.version, status: snapshot.status, parent_id: snapshot.parentId,
          url: snapshot.url, storage_hash: snapshot.storageHash,
          base_body_hash: bodyHash(snapshot.markdown), preserved: snapshot.preserved,
        },
      },
      body: snapshot.markdown,
    };
    const baseText = formatDocument(baseDocument);
    const draftText = formatDocument({ ...baseDocument, body: baseDocument.body.replace('Initial term definition.', 'Updated term definition.') });
    assert.notEqual(draftText, baseText);
    const basePath = path.join(f.directory, 'base.md');
    const draftPath = path.join(f.directory, 'draft.md');
    await writeFile(basePath, baseText);
    await writeFile(draftPath, draftText);
    const putsBeforeApply = requestCount(f, 'PUT', /\/pages\/\d+$|\/content\/\d+$/);
    const applied = await f.cli('apply', draftPath, '--base', basePath, '--wiki-root', root.id, '--space', 'TEST', '--json');
    assert.equal(applied.code, 0, applied.stderr + applied.stdout);
    const appliedReport = JSON.parse(applied.stdout);
    assert.equal(appliedReport.status, 'success');
    assert.equal(appliedReport.id, term.id);
    assert.equal(appliedReport.version, 2);
    assert.match(appliedReport.url, new RegExp('pageId=' + term.id + '$'));
    assert.equal(appliedReport.resources.page.status, 'saved');
    assert.ok(appliedReport.resources.property.status === 'preserved' || appliedReport.resources.property.status === 'saved');
    assert.equal(requestCount(f, 'PUT', /\/pages\/\d+$|\/content\/\d+$/), putsBeforeApply + 1);
    assert.match(f.pages.get(term.id).storage, /Updated term definition/);
    assert.equal(f.pages.get(term.id).parentId, root.id);

    const concurrentBase = await readStorageSnapshot(f.api, term.id, { space: 'TEST' });
    const concurrentDocument = {
      metadata: { type: 'DefinedTerm', title: concurrentBase.title, confluence: {
        deployment: concurrentBase.tenant.deployment, api_url: concurrentBase.tenant.apiUrl,
        site_url: concurrentBase.tenant.siteUrl, id: concurrentBase.id, space: concurrentBase.space.key,
        version: concurrentBase.version, status: concurrentBase.status, parent_id: concurrentBase.parentId,
        url: concurrentBase.url, storage_hash: concurrentBase.storageHash,
        base_body_hash: bodyHash(concurrentBase.markdown), preserved: concurrentBase.preserved,
      } }, body: concurrentBase.markdown,
    };
    const concurrentBaseText = formatDocument(concurrentDocument);
    const concurrentDraftText = formatDocument({ ...concurrentDocument, body: concurrentDocument.body.replace('Updated term definition.', 'Agent same-root change.') });
    const concurrentBasePath = path.join(f.directory, 'concurrent-base.md');
    const concurrentDraftPath = path.join(f.directory, 'concurrent-draft.md');
    await writeFile(concurrentBasePath, concurrentBaseText);
    await writeFile(concurrentDraftPath, concurrentDraftText);
    const sameRootMove = f.armRootReadTransition(root.id, term.id, {
      version: 2, storage: '<h1>Release code</h1><p>Updated term definition.</p><p>Concurrent same-root note.</p>',
    });
    const sameRootApplied = await f.cli('apply', concurrentDraftPath, '--base', concurrentBasePath, '--wiki-root', root.id, '--space', 'TEST', '--json');
    await sameRootMove;
    assert.equal(sameRootApplied.code, 0, sameRootApplied.stderr + sameRootApplied.stdout);
    assert.equal(JSON.parse(sameRootApplied.stdout).status, 'success');
    assert.equal(JSON.parse(sameRootApplied.stdout).version, 4);
    assert.equal(f.pages.get(term.id).parentId, root.id);
    assert.match(f.pages.get(term.id).storage, /Agent same-root change/);
    assert.match(f.pages.get(term.id).storage, /Concurrent same-root note/);
    assert.equal(f.pages.get(term.id).version, 4);

    const beforeExplore = f.requests.length;
    const explored = await f.cli('explore', 'release rollout instructions', '--wiki-root', root.id, '--space', 'TEST', '--json');
    assert.equal(explored.code, 0, explored.stderr);
    const report = JSON.parse(explored.stdout);
    assert.equal(report.status, 'partial');
    const candidate = report.evidence.find((item) => item.id === '900');
    assert.ok(candidate);
    assert.equal(candidate.version, 2);
    assert.match(candidate.url, /pageId=900$/);
    assert.ok(candidate.passages.some((passage) => passage.text.includes('RELEASE-42 is deployed')));
    assert.ok(candidate.routes.some((route) => route.kind === 'search' && route.space === 'TEST'));
    assert.ok(report.evidence.some((item) => item.id === term.id && item.version === 4));
    assert.ok(report.unresolvedLinks.some((link) => link.targetId === '9998'));
    assert.ok(report.coverage.limitations.includes('unresolved-targets'));
    assert.equal(report.usage.pageReads, 4);
    assert.equal(report.usage.searches, 1);
    assert.equal(report.usage.httpAttempts, 7);
    assert.ok(!explored.stdout.includes('STALE CANDIDATE EXCERPT'));
    assert.ok(!explored.stdout.includes('FOREIGN SECRET'));
    assert.ok(!explored.stdout.includes(f.token));
    const exploreRequests = f.requests.slice(beforeExplore);
    assert.equal(exploreRequests.length, 7);
    assert.equal(exploreRequests.filter((request) => request.method === 'GET' &&
      (deployment === 'datacenter'
        ? request.path.endsWith('/content/' + root.id + '/property/cfwiki-root')
        : request.path.endsWith('/pages/' + root.id + '/properties') && new URLSearchParams(request.query).get('key') === 'cfwiki-root')).length, 1);
    const candidatePath = deployment === 'datacenter' ? /\/content\/900$/ : /\/pages\/900$/;
    assert.equal(requestCount({ requests: exploreRequests }, 'GET', candidatePath), 1);
    assert.equal(requestCount({ requests: exploreRequests }, 'GET', deployment === 'datacenter' ? /\/content\/999$/ : /\/pages\/999$/), 0);
    assert.ok(report.usage.pageReads <= 12);

    const deletesBeforeTrash = requestCount(f, 'DELETE', /\/pages\/\d+$|\/content\/\d+$/);
    const trashed = await f.cli('delete', term.id, '--wiki-root', root.id, '--space', 'TEST', '--yes', '--version', '4', '--json');
    assert.equal(trashed.code, 0, trashed.stderr);
    const deleteReport = JSON.parse(trashed.stdout);
    assert.equal(deleteReport.status, 'trashed');
    assert.equal(deleteReport.preflightVersion, 4);
    assert.equal(deleteReport.racePossible, true);
    assert.equal(deleteReport.resources.backlinks.status, 'not_attempted');
    assert.equal(deleteReport.resources.page.status, 'trashed');
    assert.match(deleteReport.deletion, /not conditional on that version/);
    assert.equal(f.pages.get(term.id).status, 'trashed');
    assert.equal(requestCount(f, 'DELETE', /\/pages\/\d+$|\/content\/\d+$/), deletesBeforeTrash + 1);
  });
}

for (const deployment of ['cloud', 'datacenter']) {
  test('CLI generic delete rejects native and uncertain root markers (' + deployment + ')', async (t) => {
    const f = await wikiCliFixture(t, deployment);
    const initialized = await f.cli('init', '--space', 'TEST', '--topic', 'Protected root', '--json');
    assert.equal(initialized.code, 0, initialized.stderr);
    const root = JSON.parse(initialized.stdout);
    const rootPage = f.pages.get(root.id);
    assert.ok(rootPage);
    assert.equal(rootPage.parentId, deployment === 'cloud' ? '800' : null);
    assert.doesNotMatch(rootPage.storage, /data-cfwiki-root/);
    assert.equal(f.rootProperties.get(root.id).key, 'cfwiki-root');
    assert.equal(f.rootProperties.get(root.id).value.pageId, root.id);
    const markerReads = (requests) => requests.filter((request) => request.method === 'GET' &&
      (deployment === 'datacenter'
        ? request.path.endsWith('/property/cfwiki-root')
        : request.path.endsWith('/properties') && new URLSearchParams(request.query).get('key') === 'cfwiki-root')).length;
    const deletes = () => requestCount(f, 'DELETE', /\/(?:pages|content)\/\d+$/);

    let offset = f.requests.length;
    const byId = await f.cli('delete', root.id, '--yes', '--version', '1', '--json');
    assert.notEqual(byId.code, 0);
    assert.match(byId.stderr, /wiki root cannot be moved to trash/i);
    assert.equal(markerReads(f.requests.slice(offset)), 1);
    assert.equal(deletes(), 0);
    assert.equal(rootPage.status, 'current');

    const download = await f.cli('download', root.id);
    assert.equal(download.code, 0, download.stderr);
    const rootFile = path.join(f.directory, 'root.md');
    await writeFile(rootFile, download.stdout);
    offset = f.requests.length;
    const byFile = await f.cli('delete', rootFile, '--yes', '--version', '1', '--json');
    assert.notEqual(byFile.code, 0);
    assert.match(byFile.stderr, /wiki root cannot be moved to trash/i);
    assert.equal(markerReads(f.requests.slice(offset)), 1);
    assert.equal(deletes(), 0);
    assert.equal(rootPage.status, 'current');

    const originalMarker = f.rootProperties.get(root.id);
    f.rootProperties.set(root.id, { key: 'cfwiki-root', value: { schema: 999, pageId: '999', foreign: 'FOREIGN PROPERTY BODY MUST NOT LEAK' } });
    const invalidMarker = await f.cli('delete', root.id, '--yes', '--version', '1', '--json');
    assert.notEqual(invalidMarker.code, 0);
    assert.match(invalidMarker.stderr, /wiki root cannot be moved to trash/i);
    assert.equal(deletes(), 0);
    assert.doesNotMatch(invalidMarker.stdout + invalidMarker.stderr, /FOREIGN PROPERTY BODY MUST NOT LEAK/);
    f.rootProperties.set(root.id, originalMarker);

    f.rootPropertyReadFailures.set(root.id, 403);
    const deniedMarker = await f.cli('delete', root.id, '--yes', '--version', '1', '--json');
    assert.notEqual(deniedMarker.code, 0);
    assert.match(deniedMarker.stderr, /marker could not be checked/i);
    assert.equal(deletes(), 0);
    assert.doesNotMatch(deniedMarker.stdout + deniedMarker.stderr, /FOREIGN PROPERTY BODY MUST NOT LEAK|cli-wave-f-secret/);
    f.rootPropertyReadFailures.delete(root.id);

    f.seedPage({ id: '971', title: 'Foreign marked page', spaceId: '99', spaceKey: 'OTHER', storage: '<p>FOREIGN SECRET BODY MUST NOT LEAK</p>' });
    f.rootProperties.set('971', { key: 'cfwiki-root', value: { schema: 1, pageId: '971', spaceId: '99', spaceKey: 'OTHER' } });
    const foreignMarker = await f.cli('delete', '971', '--yes', '--version', '1', '--json');
    assert.notEqual(foreignMarker.code, 0);
    assert.match(foreignMarker.stderr, /wiki root cannot be moved to trash/i);
    assert.equal(deletes(), 0);
    assert.doesNotMatch(foreignMarker.stdout + foreignMarker.stderr, /FOREIGN SECRET BODY MUST NOT LEAK/);

    f.seedPage({ id: '972', title: 'Legacy root', storage: '<p data-cfwiki-root="1">Legacy.</p>' });
    const legacy = await f.cli('delete', '972', '--yes', '--version', '1', '--json');
    assert.notEqual(legacy.code, 0);
    assert.match(legacy.stderr, /wiki root cannot be moved to trash/i);
    assert.equal(deletes(), 0);

    f.seedPage({ id: '973', title: 'Ordinary page', storage: '<p>Ordinary.</p>', version: 2 });
    const stale = await f.cli('delete', '973', '--yes', '--version', '1', '--json');
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /version conflict/i);
    assert.equal(deletes(), 0);
    const ordinary = await f.cli('delete', '973', '--yes', '--version', '2', '--json');
    assert.equal(ordinary.code, 0, ordinary.stderr);
    assert.equal(JSON.parse(ordinary.stdout).status, 'trashed');
    assert.equal(f.pages.get('973').status, 'trashed');
    assert.equal(deletes(), 1);
    assert.equal(rootPage.status, 'current');
  });

  test('CLI rejects root deletion and foreign evidence (' + deployment + ')', async (t) => {
    const f = await wikiCliFixture(t, deployment);
    const init = await f.cli('init', '--space', 'TEST', '--topic', 'Guarded root', '--json');
    assert.equal(init.code, 0, init.stderr);
    const root = JSON.parse(init.stdout);
    f.seedPage({ id: '970', title: 'Authorized outside root', storage: '<p>Outside root page.</p>' });
    f.seedPage({ id: '971', title: 'Foreign secret', spaceId: '99', spaceKey: 'OTHER', storage: '<p>FOREIGN SECRET BODY MUST NOT LEAK</p>' });

    const rootDelete = await f.cli('delete', root.id, '--wiki-root', root.id, '--space', 'TEST', '--yes', '--version', '1', '--json');
    assert.notEqual(rootDelete.code, 0);
    assert.ok(!rootDelete.stdout.includes('FOREIGN SECRET'));
    assert.ok(!rootDelete.stderr.includes(f.token));
    assert.equal(requestCount(f, 'DELETE', /\/pages\/\d+$|\/content\/\d+$/), 0);
    const genericRootDelete = await f.cli('delete', root.id, '--yes', '--version', '1', '--json');
    assert.notEqual(genericRootDelete.code, 0);
    assert.match(genericRootDelete.stderr, /wiki root cannot be moved to trash/i);
    assert.equal(requestCount(f, 'DELETE', /\/pages\/\d+$|\/content\/\d+$/), 0);

    const missingConfirmation = await f.cli('delete', '970', '--wiki-root', root.id, '--space', 'TEST', '--version', '1', '--json');
    const missingVersion = await f.cli('delete', '970', '--wiki-root', root.id, '--space', 'TEST', '--yes', '--json');
    assert.notEqual(missingConfirmation.code, 0);
    assert.notEqual(missingVersion.code, 0);
    assert.equal(requestCount(f, 'DELETE', /\/pages\/\d+$|\/content\/\d+$/), 0);

    const foreignRead = await f.cli('read', '971', '--wiki-root', root.id, '--space', 'TEST', '--json');
    assert.notEqual(foreignRead.code, 0);
    assert.ok(!foreignRead.stdout.includes('FOREIGN SECRET BODY'));
    assert.ok(!foreignRead.stderr.includes('FOREIGN SECRET BODY'));
    assert.ok(!foreignRead.stdout.includes(f.token));

    const outsideRead = await f.cli('read', '970', '--wiki-root', root.id, '--space', 'TEST', '--json');
    assert.notEqual(outsideRead.code, 0);
    assert.ok(!outsideRead.stdout.includes('Outside root page.'));
    const outsideDownload = await f.cli('download', '970');
    assert.equal(outsideDownload.code, 0, outsideDownload.stderr);
    const basePath = path.join(f.directory, 'outside-base.md');
    const draftPath = path.join(f.directory, 'outside-draft.md');
    await writeFile(basePath, outsideDownload.stdout);
    await writeFile(draftPath, outsideDownload.stdout.replace('Outside root page.', 'Unauthorized root edit.'));
    const beforeApply = f.requests.length;
    const outsideApply = await f.cli('apply', draftPath, '--base', basePath, '--wiki-root', root.id, '--space', 'TEST', '--json');
    assert.notEqual(outsideApply.code, 0);
    assert.equal(requestCount({ requests: f.requests.slice(beforeApply) }, 'PUT', /\/pages\/\d+$|\/content\/\d+$/), 0);
    assert.ok(!outsideApply.stdout.includes('Outside root page.'));

    const moved = f.seedPage({ id: '701', title: 'Reparent race', parentId: root.id, storage: '<p>Original race definition.</p>' });
    const raceSnapshot = await readStorageSnapshot(f.api, moved.id, { space: 'TEST' });
    const raceDocument = { metadata: { type: 'DefinedTerm', title: raceSnapshot.title, confluence: {
      deployment: raceSnapshot.tenant.deployment, api_url: raceSnapshot.tenant.apiUrl,
      site_url: raceSnapshot.tenant.siteUrl, id: raceSnapshot.id, space: raceSnapshot.space.key,
      version: raceSnapshot.version, status: raceSnapshot.status, parent_id: raceSnapshot.parentId,
      url: raceSnapshot.url, storage_hash: raceSnapshot.storageHash,
      base_body_hash: bodyHash(raceSnapshot.markdown), preserved: raceSnapshot.preserved,
    } }, body: raceSnapshot.markdown };
    const raceBasePath = path.join(f.directory, 'race-base.md');
    const raceDraftPath = path.join(f.directory, 'race-draft.md');
    const raceBaseText = formatDocument(raceDocument);
    const raceDraftText = formatDocument({ ...raceDocument, body: raceDocument.body.replace('Original race definition.', 'Agent race change.') });
    await writeFile(raceBasePath, raceBaseText);
    await writeFile(raceDraftPath, raceDraftText);
    const raceFiles = [await readFile(raceBasePath), await readFile(raceDraftPath)];
    const raceWritesBefore = requestCount(f, 'PUT', /\/pages\/701$|\/content\/701$/);
    const racePropertiesBefore = requestCount(f, 'POST', /\/pages\/\d+\/properties$|\/content\/\d+\/property/)
      + requestCount(f, 'PUT', /\/pages\/\d+\/properties$|\/content\/\d+\/property/);
    const movedAfterRootResponse = f.armRootReadTransition(root.id, moved.id, {
      parentId: '800', storage: '<p>Concurrent outside-root body.</p>',
    });
    const raceRequestOffset = f.requests.length;
    const rootRace = await f.cli('apply', raceDraftPath, '--base', raceBasePath, '--wiki-root', root.id, '--space', 'TEST', '--json');
    await movedAfterRootResponse;
    assert.notEqual(rootRace.code, 0);
    const raceReport = JSON.parse(rootRace.stdout);
    assert.equal(raceReport.status, 'conflict');
    assert.equal(raceReport.id, moved.id);
    assert.ok(raceReport.conflicts.some((conflict) => conflict.code === 'wiki_root'));
    const raceRequests = f.requests.slice(raceRequestOffset);
    assert.equal(requestCount({ requests: raceRequests }, 'GET', /\/pages\/701$|\/content\/701$/), 3);
    assert.equal(requestCount({ requests: raceRequests }, 'GET', /\/pages\/\d+$|\/content\/\d+$/), 4);
    assert.equal(requestCount({ requests: raceRequests }, 'PUT', /\/pages\/701$|\/content\/701$/), 0);
    assert.equal(requestCount(f, 'PUT', /\/pages\/701$|\/content\/701$/), raceWritesBefore);
    const racePropertiesAfter = requestCount(f, 'POST', /\/pages\/\d+\/properties$|\/content\/\d+\/property/)
      + requestCount(f, 'PUT', /\/pages\/\d+\/properties$|\/content\/\d+\/property/);
    assert.equal(racePropertiesAfter, racePropertiesBefore);
    assert.equal(moved.parentId, '800');
    assert.equal(moved.version, 2);
    assert.equal(moved.storage, '<p>Concurrent outside-root body.</p>');
    assert.deepEqual(await readFile(raceBasePath), raceFiles[0]);
    assert.deepEqual(await readFile(raceDraftPath), raceFiles[1]);
    assert.ok(!rootRace.stdout.includes(f.token));
    assert.ok(!rootRace.stderr.includes(f.token));
    assert.ok(!rootRace.stdout.includes('Concurrent outside-root body.'));

    const contentPath = path.join(f.directory, 'bad-content.md');
    await writeFile(contentPath, '---\nconfluence:\n  space: OTHER\n  api_url: https://foreign.example.test/rest/api\n---\nMust not publish.');
    const beforeCreate = requestCount(f, 'POST', /\/pages$|\/content$/);
    const badCreate = await f.cli('create', 'Bad scope', '--wiki-root', root.id, '--space', 'TEST', '--content', contentPath, '--json');
    assert.notEqual(badCreate.code, 0);
    assert.match(badCreate.stderr, /cannot provide profile, space or root scope/i);
    assert.equal(requestCount(f, 'POST', /\/pages$|\/content$/), beforeCreate);
    const badCql = await f.cli('explore', 'question', '--wiki-root', root.id, '--space', 'TEST', '--cql', 'space = OTHER', '--json');
    assert.notEqual(badCql.code, 0);
    assert.ok(!badCql.stdout.includes('FOREIGN SECRET'));

    const beforeExplore = f.requests.length;
    const explored = await f.cli('explore', 'foreign secret query', '--wiki-root', root.id, '--space', 'TEST', '--json');
    assert.equal(explored.code, 0, explored.stderr);
    assert.ok(!explored.stdout.includes('FOREIGN SECRET BODY'));
    assert.ok(!explored.stdout.includes('FOREIGN SECRET SNIPPET'));
    assert.equal(requestCount({ requests: f.requests.slice(beforeExplore) }, 'GET', deployment === 'datacenter' ? /\/content\/971$/ : /\/pages\/971$/), 0);
    assert.ok(requestCount(f, 'DELETE', /\/pages\/\d+$|\/content\/\d+$/) === 0);
  });
}

async function scopedFixture(t, deployment) {
  const dc = deployment === 'datacenter';
  const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-scoped-'));
  const token = 'fixture-private-' + deployment;
  const requests = [];
  const state = { id: '42', spaceId: '12', status: 'current', version: 7, storage: '<h2>Old procedure</h2><p>Before update.</p>' };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams, authorization: req.headers.authorization });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const expectedAuth = dc ? 'Bearer ' + token : 'Basic ' + Buffer.from('fixture@example.test:' + token).toString('base64');
    if (req.headers.authorization !== expectedAuth) return send(401, { detail: token });
    if (url.pathname === (dc ? '/confluence/rest/api/space/TEST' : '/wiki/api/v2/spaces')) {
      return send(200, dc ? { id: '12', key: 'TEST', name: 'Test' } : { results: [{ id: '12', key: 'TEST', name: 'Test' }] });
    }
    if (url.pathname === (dc ? '/confluence/rest/api/search' : '/wiki/rest/api/search')) {
      return send(200, { results: [
        { content: { id: '42', title: '배포 절차', space: { key: 'TEST' }, version: { number: 1 } }, excerpt: 'stale candidate excerpt' },
        { content: { id: '99', title: 'Foreign', space: { key: 'OTHER' } }, excerpt: 'foreign candidate text' },
      ] });
    }
    if (url.pathname === (dc ? '/confluence/rest/api/content/42' : '/wiki/api/v2/pages/42')) {
      const page = { id: state.id, title: '배포 절차', status: state.status, version: { number: state.version }, body: state.storage === null ? {} : { storage: { value: state.storage } } };
      return send(200, dc ? { ...page, space: { id: state.spaceId, key: state.spaceId === '12' ? 'TEST' : 'OTHER' } } : { ...page, spaceId: state.spaceId });
    }
    if (url.pathname.includes('/property/') || url.pathname.endsWith('/properties')) return send(200, dc ? { value: { pageVersion: state.version, source: { body: 'contradictory cached text' } } } : { results: [{ key: 'confluence-wiki-md', value: { pageVersion: state.version, source: { body: 'contradictory cached text' } } }] });
    if (url.pathname.endsWith('/label') || url.pathname.endsWith('/labels')) return send(200, { results: [] });
    return send(404, {});
  });
  t.after(async () => {
    try {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      assert.equal(server.listening, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await assert.rejects(access(directory), { code: 'ENOENT' });
    }
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const origin = 'http://127.0.0.1:' + server.address().port;
  const site = origin + (dc ? '/confluence' : '');
  const profile = path.join(directory, 'profile.env');
  await writeFile(profile, Object.entries({
    CONFLUENCE_DEPLOYMENT: deployment,
    CONFLUENCE_SITE_URL: site,
    CONFLUENCE_API_URL: site + (dc ? '/rest/api' : '/wiki/api/v2'),
    CONFLUENCE_SPACE_KEY: 'TEST',
    CONFLUENCE_ALLOW_HTTP: 'true',
    ...(dc ? { CONFLUENCE_PAT: token } : { CONFLUENCE_EMAIL: 'fixture@example.test', CONFLUENCE_API_TOKEN: token }),
  }).map(([key, value]) => key + '=' + value).join('\n'));
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CONFLUENCE_')));
  const cli = async (...args) => {
    const child = spawn(process.execPath, [entry, ...args, '--env', profile], { cwd: directory, env: cleanEnv, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  };
  return { cli, state, requests, token, origin, directory };
}

for (const deployment of ['cloud', 'datacenter']) {
  test('CLI lookup escapes CQL text and keeps legacy search and read (' + deployment + ')', async (t) => {
    const f = await scopedFixture(t, deployment);
    const query = '" OR space = "OTHER';
    const lookup = await f.cli('lookup', query, '--space', 'TEST', '--json');
    assert.equal(lookup.code, 0, lookup.stderr);
    const searchRequest = f.requests.find((request) => request.path.endsWith('/search'));
    assert.match(searchRequest.query.get('cql'), /space = "TEST"/);
    assert.ok(searchRequest.query.get('cql').includes('title ~ "\\" OR space = \\"OTHER"'));
    assert.ok(!lookup.stdout.includes(f.token));
    for (const option of [['--cql', 'space = OTHER'], ['--local', f.directory]]) {
      const denied = await f.cli('lookup', 'release', '--space', 'TEST', ...option, '--json');
      assert.notEqual(denied.code, 0);
      assert.match(denied.stderr, /does not accept --cql or --local/);
      assert.ok(!denied.stderr.includes(f.token));
    }
    const beforeLegacy = f.requests.length;
    const legacySearch = await f.cli('search', 'release', '--cql', 'type = page', '--json');
    assert.equal(legacySearch.code, 0, legacySearch.stderr);
    assert.equal(f.requests.at(-1).query.get('cql'), 'type = page');
    const localFile = path.join(f.directory, 'release.md');
    await writeFile(localFile, '# release\n\nLocal matching release note.\n');
    const beforeLocal = f.requests.length;
    const localSearch = await f.cli('search', 'release', '--local', f.directory, '--json');
    assert.equal(localSearch.code, 0, localSearch.stderr);
    assert.equal(f.requests.length, beforeLocal);
    assert.ok(JSON.parse(localSearch.stdout).some((entry) => entry.title || entry.id));
    const humanRead = await f.cli('read', '42');
    assert.equal(humanRead.code, 0, humanRead.stderr);
    assert.match(humanRead.stdout, /Before update/);
    assert.ok(f.requests.length > beforeLegacy);
    assert.ok(!humanRead.stdout.includes(f.token));
    const download = await f.cli('download', '42');
    assert.equal(download.code, 0, download.stderr);
    assert.match(download.stdout, /Before update/);
  });

  test('CLI scoped read returns current selected page versions (' + deployment + ')', async (t) => {
    const f = await scopedFixture(t, deployment);
    const lookup = await f.cli('lookup', '배포 절차', '--space', 'TEST', '--limit', '10', '--json');
    assert.equal(lookup.code, 0, lookup.stderr);
    const candidates = JSON.parse(lookup.stdout);
    assert.deepEqual(Object.keys(candidates).sort(), ['query', 'results', 'searchedAt', 'space', 'truncated']);
    assert.deepEqual(Object.keys(candidates.results[0]).sort(), ['excerpt', 'id', 'title', 'url']);
    assert.equal(candidates.results.length, 1);
    assert.equal(candidates.results[0].id, '42');
    assert.ok(!lookup.stdout.includes('foreign candidate text'));
    assert.equal(candidates.space, 'TEST');
    assert.equal(candidates.truncated, false);
    assert.ok(!lookup.stdout.includes(f.token));
    assert.equal(f.requests.filter((request) => /\/(pages|content)\/42$/.test(request.path)).length, 0);
    f.state.version = 8;
    f.state.storage = '<h2>Current procedure</h2><p>Ship release 8.</p><ac:link><ri:page ri:content-id="43"/></ac:link>';
    const read = await f.cli('read', '42', '--space', 'TEST', '--json');
    assert.equal(read.code, 0, read.stderr);
    const evidence = JSON.parse(read.stdout);
    assert.equal(evidence.id, '42');
    assert.equal(evidence.version, 8);
    assert.match(evidence.url, /pageId=42$/);
    assert.ok(Number.isFinite(Date.parse(evidence.readAt)));
    assert.ok(evidence.passages.some((passage) => passage.text.includes('Ship release 8.')));
    assert.equal(evidence.forwardLinks[0].id, '43');
    assert.ok(Array.isArray(evidence.warnings));
    assert.ok(!read.stdout.includes('stale candidate excerpt'));
    assert.ok(!read.stdout.includes(f.token));
    assert.equal(f.requests.filter((request) => /\/(pages|content)\/42$/.test(request.path)).length, 1);
    assert.equal(f.requests.filter((request) => request.path.includes('property')).length, 0);
    assert.ok(f.requests.every((request) => request.method === 'GET'));
  });

  test('CLI scoped read rejects foreign pages (' + deployment + ')', async (t) => {
    const f = await scopedFixture(t, deployment);
    f.state.spaceId = '99';
    f.state.storage = '<p>foreign secret body</p>';
    const result = await f.cli('read', '42', '--space', 'TEST', '--json');
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /outside the trusted space/i);
    assert.ok(!result.stdout.includes('foreign secret body'));
    assert.ok(!result.stderr.includes('foreign secret body'));
    assert.ok(!result.stderr.includes(f.token));
  });

  test('CLI scoped read rejects missing storage and cached contradiction (' + deployment + ')', async (t) => {
    const f = await scopedFixture(t, deployment);
    f.state.storage = null;
    const missing = await f.cli('read', '42', '--space', 'TEST', '--json');
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /storage body is missing/i);
    assert.ok(!missing.stdout.includes('contradictory cached text'));
    f.state.storage = '<p>MALFORMED PRIVATE BODY';
    const malformed = await f.cli('read', '42', '--space', 'TEST', '--json');
    assert.notEqual(malformed.code, 0);
    assert.doesNotMatch(malformed.stdout + malformed.stderr, /MALFORMED PRIVATE BODY|contradictory cached text/);
    f.state.storage = '<p>Actual storage passage.</p>';
    const actual = await f.cli('read', '42', '--space', 'TEST', '--json');
    assert.equal(actual.code, 0, actual.stderr);
    assert.match(actual.stdout, /Actual storage passage/);
    assert.ok(!actual.stdout.includes('contradictory cached text'));
    assert.equal(f.requests.filter((request) => request.path.includes('property')).length, 0);
  });
}

test('configuration fails before requesting an unconfigured environment', () => {
  assert.throws(() => readConfig({}), /CONFLUENCE_SITE_URL/);
});

test('API calls authenticate, encode JSON, and preserve optimistic versioning', async (t) => {
  const requests = [];
  let version = 7;
  let body = '<p>original</p>';
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    if (req.method === 'PUT') {
      const update = JSON.parse(raw);
      if (update.version.number !== version + 1) {
        res.writeHead(409).end();
        return;
      }
      version = update.version.number;
      body = update.body.value;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: '42', spaceId: '12', title: 'Integration test', version: { number: version }, body: { storage: { value: body } } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = createClient({ apiBase: `http://127.0.0.1:${server.address().port}`, email: 'test@example.com', token: 'local-test-token' });
  const result = await verifyPageUpdate(client, '42', '12', '<p>updated &amp; verified</p>', 'updated');
  assert.equal(result.version.number, 8);
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'PUT', 'GET']);
  assert.ok(requests.every((request) => request.auth === `Basic ${Buffer.from('test@example.com:local-test-token').toString('base64')}`));
  assert.equal(requests[1].body.id, '42');
  assert.equal(requests[1].body.version.number, 8);
  assert.equal(requests[1].body.body.representation, 'storage');
});

test('verification refuses to update a page outside the configured space', async () => {
  let calls = 0;
  const client = async () => {
    calls++;
    return { id: '42', spaceId: 'different-space' };
  };
  await assert.rejects(verifyPageUpdate(client, '42', '12', '<p>x</p>', 'x'), /space/);
  assert.equal(calls, 1);
});

test('HTTP errors do not echo server responses containing secrets', async () => {
  const server = createServer((_req, res) => res.writeHead(401).end('local-test-token'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = createClient({ apiBase: `http://127.0.0.1:${server.address().port}`, email: 'test@example.com', token: 'local-test-token' });
    await assert.rejects(client('/spaces'), (error) => /401/.test(error.message) && !error.message.includes('local-test-token'));
  } finally {
    server.close();
  }
});
