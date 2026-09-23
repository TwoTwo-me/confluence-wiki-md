import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ConfluenceApi, readWikiConfig } from '../src/api.mjs';
import { upload, pushBundle } from '../src/wiki.mjs';
import { formatDocument, parseDocument } from '../src/document.mjs';

async function fixture(t, deployment) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-protected-'));
  const pages = new Map(); const properties = new Map(); const events = [];
  let serial = 100;
  const state = { deny: false, ignorePrivate: false, failContent: false };
  const cloud = deployment === 'cloud';
  const actor = { type: 'known', [cloud ? 'accountId' : 'username']: 'actor' };
  const acl = () => ({ read: { users: ['actor'], groups: [] }, update: { users: ['actor'], groups: [] } });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const route = url.pathname.replace(/^\/(?:api\/v2|rest\/api)/, '');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
    if (route === '/user/current') return send(200, actor);
    if (route === '/spaces') return send(200, { results: [{ id: '1', key: 'TEST' }] });
    if (route === '/space/TEST') return send(200, { id: '1', key: 'TEST' });
    if (['/content', '/pages'].includes(route) && req.method === 'POST') {
      if (state.deny && cloud && url.searchParams.get('private') === 'true') return send(403, {});
      const id = String(++serial);
      const page = { id, title: body.title, status: 'current', type: 'page', space: { id: '1', key: 'TEST' }, spaceId: '1', authorId: 'actor', history: { createdBy: actor }, version: { number: 1 }, body: { storage: { value: body.body.storage?.value ?? body.body.value } } };
      page.acl = cloud && url.searchParams.get('private') === 'true' && !state.ignorePrivate ? acl() : { read: { users: [], groups: [] }, update: { users: [], groups: [] } };
      pages.set(id, page); events.push({ action: 'create', id, private: url.searchParams.get('private'), title: page.title, storage: page.body.storage.value, protected: page.acl.read.users.length > 0 });
      return send(200, page);
    }
    const match = route.match(/^\/(?:content|pages)\/(\d+)(.*)$/);
    if (!match) return send(404, {});
    const [, id, suffix] = match; const page = pages.get(id);
    if (!page) return send(404, {});
    if (!suffix) {
      if (req.method === 'GET') return send(200, page);
      if (req.method === 'DELETE') { pages.delete(id); return send(204); }
      if (req.method === 'PUT') {
        if (state.failContent) return send(503, {});
        if (body.version.number !== page.version.number + 1) return send(409, {});
        page.title = body.title; page.body.storage.value = body.body.storage?.value ?? body.body.value; page.version = body.version;
        events.push({ action: 'write', id, title: page.title, storage: page.body.storage.value, protected: page.acl.read.users.length > 0 }); return send(200, page);
      }
    }
    if (suffix.startsWith('/restriction/byOperation/')) {
      const operation = suffix.split('/').at(-1);
      const collection = (items) => ({ results: items, start: 0, size: items.length, limit: 100 });
      events.push({ action: 'acl-read', id, operation });
      return send(200, { operation, restrictions: { user: collection(page.acl[operation].users.map((value) => ({ type: 'known', [cloud ? 'accountId' : 'username']: value }))), group: collection(page.acl[operation].groups.map((value) => ({ type: 'group', [cloud ? 'id' : 'name']: value }))) } });
    }
    if (suffix === '/restriction') {
      if (state.deny) return send(403, {});
      page.acl = { read: { users: [], groups: [] }, update: { users: [], groups: [] } };
      for (const item of body ?? []) page.acl[item.operation] = { users: (item.restrictions.user ?? []).map((value) => value.accountId ?? value.username), groups: (item.restrictions.group ?? []).map((value) => value.id ?? value.name) };
      events.push({ action: 'acl-write', id }); return send(200, { results: [] });
    }
    if (suffix.startsWith('/propert')) {
      if (req.method === 'GET') return cloud ? send(200, { results: properties.has(id) ? [properties.get(id)] : [] }) : properties.has(id) ? send(200, properties.get(id)) : send(404, {});
      properties.set(id, { ...body, id: 'prop-' + id, version: body.version ?? { number: 1 } }); return send(200, properties.get(id));
    }
    if (['/label', '/labels', '/attachments', '/child/attachment'].includes(suffix)) return send(200, { results: [] });
    return send(404, {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = new ConfluenceApi(readWikiConfig({ CONFLUENCE_SITE_URL: base, CONFLUENCE_API_URL: base + (cloud ? '/api/v2' : '/rest/api'), CONFLUENCE_API_V1_URL: base + '/rest/api', CONFLUENCE_DEPLOYMENT: deployment, CONFLUENCE_EMAIL: 'test@example.test', CONFLUENCE_API_TOKEN: 'synthetic', CONFLUENCE_SPACE_KEY: 'TEST', CONFLUENCE_ALLOW_HTTP: 'true' }));
  return { api, state, pages, events, directory };
}

for (const deployment of ['cloud', 'datacenter']) {
  test('protected pages: upload and mixed bundle ' + deployment, async (t) => {
    const f = await fixture(t, deployment);
    const doc = await upload(f.api, '---\ntitle: Private title\n---\nPrivate body');
    const page = f.pages.get(doc.metadata.confluence.id);
    assert.deepEqual(page.acl.read.users, ['actor']);
    assert.deepEqual(page.acl.update.users, ['actor']);
    assert.ok(f.events.filter((event) => /Private/.test((event.storage ?? '') + (event.title ?? ''))).every((event) => event.protected), 'private content was never published before protection');
    const firstEvents = f.events.length;
    await upload(f.api, formatDocument({ ...doc, body: 'Edited body' }));
    assert.equal(f.events.slice(firstEvents).filter((event) => event.action === 'acl-write').length, 0, 'ordinary update preserves ACL');
    await assert.rejects(upload(f.api, formatDocument(doc), { restrictions: { mode: 'none' } }), /restrictions set/);
    const old = await upload(f.api, '---\ntitle: Existing shared\n---\nExisting', { restrictions: { mode: 'none' } });
    await writeFile(path.join(f.directory, 'old.md'), formatDocument(old));
    await writeFile(path.join(f.directory, 'a.md'), '---\ntitle: New A\n---\n[B](b.md)');
    await writeFile(path.join(f.directory, 'b.md'), '---\ntitle: New B\n---\n[A](a.md)');
    await pushBundle(f.api, f.directory);
    assert.deepEqual(f.pages.get(old.metadata.confluence.id).acl.read.users, []);
    for (const file of ['a.md', 'b.md']) {
      const saved = parseDocument(await readFile(path.join(f.directory, file), 'utf8'));
      assert.deepEqual(f.pages.get(saved.metadata.confluence.id).acl.read.users, ['actor']);
      assert.match(f.pages.get(saved.metadata.confluence.id).body.storage.value, /pageId=/);
    }
  });

  test('protected pages: fail closed and resume ' + deployment, async (t) => {
    const f = await fixture(t, deployment); f.state.deny = true;
    let saved;
    const source = '---\ntitle: Confidential title\n---\nConfidential body';
    await assert.rejects(upload(f.api, source, { onWrite: async (doc) => { saved = structuredClone(doc); } }), /restricted|restriction|private/i);
    assert.equal(f.events.some((event) => /Confidential/.test((event.storage ?? '') + (event.title ?? ''))), false);
    if (deployment === 'cloud') { assert.equal(f.pages.size, 0); return; }
    assert.ok(saved.metadata.confluence.pending_create);
    assert.equal(saved.metadata.title, 'Confidential title');
    const id = saved.metadata.confluence.id;
    f.state.deny = false;
    const resumed = await upload(f.api, formatDocument(saved));
    assert.equal(resumed.metadata.confluence.id, id);
    assert.equal(f.pages.size, 1);
    assert.equal(resumed.metadata.confluence.pending_create, undefined);
    assert.match(f.pages.get(id).body.storage.value, /Confidential body/);
    assert.deepEqual(f.pages.get(id).acl.read.users, ['actor']);
    const forged = { ...resumed, metadata: { ...resumed.metadata, confluence: { ...resumed.metadata.confluence, pending_create: { nonce: 'forged' } } } };
    await assert.rejects(upload(f.api, formatDocument(forged)), /pending|recovery/i);
  });
}
