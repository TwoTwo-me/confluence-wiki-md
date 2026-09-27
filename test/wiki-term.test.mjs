import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfluenceApi, readWikiConfig } from '../src/api.mjs';
import { initWiki } from '../src/wiki-init.mjs';
import { createTerm, readTerm, trashTerm, updateTerm } from '../src/wiki-term.mjs';

async function termFixture(t, deployment = 'cloud', mode = 'normal') {
  const dc = deployment === 'datacenter';
  const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-term-'));
  const token = 'fixture-term-secret';
  const pages = new Map();
  const history = new Map();
  const properties = new Map();
  const requests = [];
  const hooks = {};
  let serial = 100;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path: url.pathname, query: url.search, body, authorization: req.headers.authorization });
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
    if (req.headers.authorization !== 'Bearer ' + token) return send(401, { token, body: 'secret response' });
    const spacePath = dc ? '/rest/api/space/TEST' : '/wiki/api/v2/spaces';
    if (url.pathname === spacePath && req.method === 'GET') return send(200, dc ? { id: '12', key: 'TEST', name: 'Test' } : { results: [{ id: '12', key: 'TEST', name: 'Test', homepageId: '65822' }] });
    if (dc && url.pathname === '/rest/api/space/OTHER' && req.method === 'GET') return send(200, { id: '99', key: 'OTHER', name: 'Other' });
    if (url.pathname === (dc ? '/rest/api/content' : '/wiki/api/v2/pages') && req.method === 'POST') {
      const id = String(++serial);
      const parentId = dc ? body.ancestors?.at(-1)?.id ?? null : body.parentId ?? '65822';
      const storage = dc ? body.body.storage.value : body.body.value.replace(/ data-cfwiki-(?:root|topic)="[^"]*"/g, '');
      const page = { id, title: body.title, status: 'current', version: 1, spaceId: dc ? (body.space.key === 'OTHER' ? '99' : '12') : String(body.spaceId), spaceKey: dc ? body.space.key : 'TEST', parentId, storage, titleSeen: body.title };
      pages.set(id, page);
      history.set(id, new Map([[1, structuredClone(page)]]));
      return send(200, responsePage(page, dc));
    }
    const childPath = dc ? /^\/rest\/api\/content\/(\d+)\/child\/page$/ : /^\/wiki\/api\/v2\/pages\/(\d+)\/children$/;
    const child = url.pathname.match(childPath);
    if (child && req.method === 'GET') {
      const rows = [...pages.values()].filter((page) => page.parentId === child[1]).map((page) => responsePage(page, dc));
      return send(200, { results: rows });
    }
    const pagePath = url.pathname.match(dc ? /^\/rest\/api\/content\/(\d+)$/ : /^\/wiki\/api\/v2\/pages\/(\d+)$/);
    if (pagePath) {
      const page = pages.get(pagePath[1]);
      if (!page) return send(404, {});
      if (req.method === 'GET') {
        hooks.read?.(page, url);
        if (url.searchParams.has('version')) {
          const historical = history.get(page.id)?.get(Number(url.searchParams.get('version')));
          return historical ? send(200, responsePage({ ...historical, status: 'historical' }, dc)) : send(404, {});
        }
        return send(200, responsePage(page, dc));
      }
      if (req.method === 'PUT') {
        if (body.version.number !== page.version + 1) return send(409, { token, body: 'secret response' });
        history.get(page.id).set(page.version, structuredClone(page));
        page.title = body.title;
        page.storage = dc ? body.body.storage.value : body.body.value;
        page.parentId = dc ? body.ancestors?.at(-1)?.id ?? null : body.parentId ?? null;
        page.version = body.version.number;
        if (hooks.written?.(page, req)) return;
        return send(200, responsePage(page, dc));
      }
      if (req.method === 'DELETE') {
        page.status = 'trashed';
        return send(204);
      }
    }
    const dcPropertyGet = url.pathname.match(/^\/rest\/api\/content\/(\d+)\/property\/(?:confluence-wiki-md|cfwiki-root)$/);
    const dcPropertyPost = url.pathname.match(/^\/rest\/api\/content\/(\d+)\/property$/);
    const cloudProperty = url.pathname.match(/^\/wiki\/api\/v2\/pages\/(\d+)\/properties$/);
    if (dc && dcPropertyGet && req.method === 'GET') return properties.has(dcPropertyGet[1]) ? send(200, properties.get(dcPropertyGet[1])) : send(404, {});
    if (dc && dcPropertyPost && req.method === 'POST') {
      if (mode === 'partial-create' && dcPropertyPost[1] !== '101') return send(500, { token, body: 'secret response' });
      const property = { ...body, id: 'property-' + dcPropertyPost[1], version: body.version ?? { number: 1 } };
      properties.set(dcPropertyPost[1], property);
      return send(200, property);
    }
    if (!dc && cloudProperty && req.method === 'GET') return send(200, { results: properties.has(cloudProperty[1]) ? [properties.get(cloudProperty[1])] : [] });
    if (!dc && cloudProperty && req.method === 'POST') {
      if (mode === 'partial-create' && cloudProperty[1] !== '101') return send(500, { token, body: 'secret response' });
      const property = { ...body, id: 'property-' + cloudProperty[1], version: body.version ?? { number: 1 } };
      properties.set(cloudProperty[1], property);
      return send(200, property);
    }
    if (/\/(?:label|labels)$/.test(url.pathname) && req.method === 'GET') return send(200, { results: [] });
    return send(404, {});
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const env = {
    CONFLUENCE_SITE_URL: origin,
    CONFLUENCE_API_URL: origin + (dc ? '/rest/api' : '/wiki/api/v2'),
    ...(dc ? {} : { CONFLUENCE_API_V1_URL: origin + '/wiki/rest/api' }),
    CONFLUENCE_DEPLOYMENT: deployment,
    CONFLUENCE_AUTH: 'bearer',
    CONFLUENCE_PAT: token,
    CONFLUENCE_SPACE_KEY: 'TEST',
    CONFLUENCE_ALLOW_HTTP: 'true',
  };
  const api = new ConfluenceApi(readWikiConfig(env));
  const root = await initWiki(api, { space: 'TEST', topic: 'Term test' });
  assert.equal(root.status, 'confirmed');
  return { api, pages, history, properties, requests, root, token, mode, directory, hooks };
}

function responsePage(page, dc) {
  return dc
    ? { id: page.id, title: page.title, status: page.status, version: { number: page.version }, body: { storage: { value: page.storage } }, space: { id: page.spaceId, key: page.spaceKey }, ancestors: page.parentId ? [{ id: page.parentId }] : [] }
    : { id: page.id, title: page.title, status: page.status, version: { number: page.version }, body: { storage: { value: page.storage } }, spaceId: page.spaceId, ...(page.parentId ? { parentId: page.parentId } : {}) };
}

const mutations = (fixture) => fixture.requests.filter((request) => ['POST', 'PUT', 'DELETE'].includes(request.method));

test('updateTerm refuses a move to parent 800 during historical preflight', async (t) => {
  for (const deployment of ['cloud', 'datacenter']) {
    await t.test(deployment, async (t) => {
      const f = await termFixture(t, deployment);
      const child = await createTerm(f.api, { space: 'TEST', rootId: f.root.id, term: 'Race term', content: 'Original.' });
      const before = mutations(f).length;
      f.hooks.read = (page, url) => {
        if (page.id === child.id && url.searchParams.has('version')) {
          page.parentId = '800';
          page.version = 2;
        }
      };
      const result = await updateTerm(f.api, { space: 'TEST', rootId: f.root.id, id: child.id, version: 1, content: 'Agent update.' });
      assert.equal(result.status, 'conflict');
      assert.equal(result.conflicts[0].code, 'wiki_root');
      assert.equal(mutations(f).length, before);
      assert.equal(f.pages.get(child.id).version, 2);
      assert.equal(f.pages.get(child.id).parentId, '800');
      assert.doesNotMatch(f.pages.get(child.id).storage, /Agent update/);
    });
  }
});

test('updateTerm reports partial after uncertain or final-read reparenting', async (t) => {
  for (const deployment of ['cloud', 'datacenter']) {
    for (const stage of ['lost-response', 'final-read']) {
      await t.test(deployment + ' ' + stage, async (t) => {
        const f = await termFixture(t, deployment);
        const child = await createTerm(f.api, { space: 'TEST', rootId: f.root.id, term: 'Race term', content: 'Original.' });
        let written = false;
        let moved = false;
        let postWriteReads = 0;
        const move = (page) => { page.parentId = '800'; page.version++; moved = true; };
        f.hooks.written = (page, req) => {
          if (page.id !== child.id) return false;
          written = true;
          if (stage === 'lost-response') {
            move(page);
            req.socket.destroy();
            return true;
          }
          return false;
        };
        f.hooks.read = (page) => {
          // upload confirmation, apply confirmation, then updateTerm confirmation.
          if (written && page.id === child.id && ++postWriteReads === 3) move(page);
        };
        const before = mutations(f).length;
        const result = await updateTerm(f.api, { space: 'TEST', rootId: f.root.id, id: child.id, version: 1, content: 'Agent update.' });
        assert.equal(result.status, 'partial', JSON.stringify(result));
        assert.equal(result.outcome, 'unresolved');
        assert.equal(result.id, child.id);
        assert.equal(result.attemptedVersion, 2);
        if (stage === 'lost-response') assert.equal(result.code, 'wiki_root');
        assert.equal(result.resources.page.status, 'unresolved');
        assert.equal(moved, true);
        assert.equal(f.pages.get(child.id).parentId, '800');
        assert.match(f.pages.get(child.id).storage, /Agent update/);
        assert.equal(mutations(f).length - before, 1, 'No replay or secondary write after the move.');
        assert.equal(mutations(f).at(-1).method, 'PUT');
        assert.doesNotMatch(JSON.stringify(result), /fixture-term-secret/);
      });
    }
  }
});

test('term lifecycle creates reads updates and trashes child', async (t) => {
  for (const deployment of ['cloud', 'datacenter']) {
    await t.test(deployment, async (t) => {
      const f = await termFixture(t, deployment);
      const related = await f.api.writePage({ title: 'Related protocol', storage: '<p>Related page.</p>', space: await f.api.getSpace('TEST') });
      const made = await createTerm(f.api, {
        space: 'TEST', rootId: f.root.id, term: 'Release process',
        content: '# Release process\n\nInitial term definition.',
        relatedIds: [related.id], sourceUrls: ['https://docs.example.test/releases?q=1'],
      });
      assert.equal(made.status, 'created');
      assert.equal(made.title, 'Release process');
      assert.equal(made.parentId, f.root.id);
      assert.equal(made.version, 1);
      assert.match(made.url, new RegExp('pageId=' + made.id + '$'));
      assert.deepEqual(made.related.map(({ id }) => id), [related.id]);
      assert.deepEqual(made.sources, [{ url: 'https://docs.example.test/releases?q=1', fetched: false }]);
      assert.equal(f.properties.get(made.id).value.metadata.type, 'DefinedTerm');
      assert.match(f.pages.get(made.id).storage, new RegExp('pageId=' + related.id));
      assert.match(f.pages.get(made.id).storage, /not fetched/);
      assert.ok(!f.requests.some((request) => new URL(request.path === '' ? 'http://fixture.invalid' : 'http://fixture.invalid' + request.path).hostname === 'docs.example.test'));

      const read = await readTerm(f.api, { space: 'TEST', rootId: f.root.id, id: made.id });
      assert.equal(read.id, made.id);
      assert.equal(read.parentId, f.root.id);
      assert.equal(read.version, 1);
      assert.match(read.body, /Initial term definition/);
      assert.match(read.body, /docs\.example\.test/);
      const outside = await f.api.writePage({ title: 'Ordinary authorized page', storage: '<p>Read is allowed.</p>', space: await f.api.getSpace('TEST') });
      assert.match((await readTerm(f.api, { space: 'TEST', id: outside.id })).body, /Read is allowed/);

      const updated = await updateTerm(f.api, {
        space: 'TEST', rootId: f.root.id, id: made.id, version: 1,
        content: '# Release process\n\nUpdated term definition.',
        relatedIds: [related.id], sourceUrls: ['https://docs.example.test/releases?q=1'],
      });
      assert.equal(updated.status, 'updated', JSON.stringify(updated));
      assert.equal(updated.version, 2);
      assert.equal(updated.parentId, f.root.id);
      assert.match(f.pages.get(made.id).storage, /Updated term definition/);
      assert.match(f.pages.get(made.id).storage, new RegExp('pageId=' + related.id));
      assert.match(f.pages.get(made.id).storage, /not fetched/);

      const trashed = await trashTerm(f.api, { space: 'TEST', rootId: f.root.id, id: made.id, version: 2, confirmed: true });
      assert.equal(trashed.status, 'trashed');
      assert.equal(trashed.version, 2);
      assert.equal(f.pages.get(made.id).status, 'trashed');
      assert.match(trashed.deletion, /not conditional on that version/);
    });
  }
});

test('term lifecycle refuses ambiguity foreign roots and root deletion', async (t) => {
  for (const deployment of ['cloud', 'datacenter']) {
    await t.test(deployment, async (t) => {
      const f = await termFixture(t, deployment);
      let syntheticId = 800;
      const createChild = (title, parentId = f.root.id, spaceId = '12', spaceKey = 'TEST') => {
        const id = String(++syntheticId);
        const page = { id, title, status: 'current', version: 1, spaceId, spaceKey, parentId, storage: '<p>Candidate</p>' };
        f.pages.set(id, page);
        f.history.set(id, new Map([[1, structuredClone(page)]]));
        return page;
      };
      const before = mutations(f).length;
      createChild('Ambiguous term');
      createChild('Ambiguous term');
      const afterAmbiguous = mutations(f).length;
      await assert.rejects(createTerm(f.api, { space: 'TEST', rootId: f.root.id, term: 'Ambiguous term', content: 'Definition.' }), /Multiple exact-title children/);
      assert.equal(mutations(f).length, afterAmbiguous);

      const unrelated = createChild('Unrelated same-space page', null);
      await assert.rejects(readTerm(f.api, { space: 'TEST', rootId: f.root.id, id: unrelated.id }), /not a term child/);
      await assert.rejects(updateTerm(f.api, { space: 'TEST', rootId: f.root.id, id: unrelated.id, version: 1, content: 'Changed.' }), /not a direct child/);
      await assert.rejects(trashTerm(f.api, { space: 'TEST', rootId: f.root.id, id: unrelated.id, version: 1, confirmed: true }), /not a direct child/);
      await assert.rejects(trashTerm(f.api, { space: 'TEST', rootId: f.root.id, id: f.root.id, version: 1, confirmed: true }), /cannot be moved to trash/);
      await assert.rejects(updateTerm(f.api, { space: 'TEST', rootId: f.root.id, id: unrelated.id, version: 9, content: 'Changed.' }), /not a direct child/);
      const child = createChild('Versioned term');
      await assert.rejects(updateTerm(f.api, { space: 'TEST', rootId: f.root.id, id: child.id, version: 8, content: 'Changed.' }), /version changed/);
      await assert.rejects(trashTerm(f.api, { space: 'TEST', rootId: f.root.id, id: child.id, version: 8, confirmed: true }), /version changed/);
      const otherRoot = createChild('Other Wiki', null, '99', 'OTHER');
      await assert.rejects(createTerm(f.api, { space: 'TEST', rootId: otherRoot.id, term: 'Blocked', content: 'Definition.' }), /outside the trusted space/);
      const foreignRelated = createChild('Foreign related page', null, '99', 'OTHER');
      await assert.rejects(createTerm(f.api, { space: 'TEST', rootId: f.root.id, term: 'Blocked related', content: 'Definition.', relatedIds: [foreignRelated.id] }), /outside the trusted space/);
      await assert.rejects(trashTerm(f.api, { space: 'TEST', rootId: f.root.id, id: child.id, version: 1 }), /explicit confirmation/);
      assert.equal(mutations(f).length, afterAmbiguous);
      assert.equal(mutations(f).filter((request) => request.method === 'PUT' || request.method === 'DELETE').length, 0);
      assert.ok(before >= 1);
    });
  }
});

test('term lifecycle retains known identity after partial create', async (t) => {
  for (const deployment of ['cloud', 'datacenter']) {
    await t.test(deployment, async (t) => {
      const f = await termFixture(t, deployment, 'partial-create');
      const createsBefore = f.requests.filter((request) => request.method === 'POST' && /pages$|content$/.test(request.path)).length;
      const result = await createTerm(f.api, { space: 'TEST', rootId: f.root.id, term: 'Partial term', content: 'An explicit definition.' });
      assert.equal(result.status, 'partial');
      assert.match(result.id, /^\d+$/);
      assert.equal(result.parentId, f.root.id);
      assert.equal(result.version, 1);
      assert.match(result.url, new RegExp('pageId=' + result.id + '$'));
      assert.ok(f.pages.has(result.id));
      assert.equal(f.requests.filter((request) => request.method === 'POST' && /pages$|content$/.test(request.path)).length - createsBefore, 1);
      assert.ok(!JSON.stringify(result).includes(f.token));
    });
  }
});
