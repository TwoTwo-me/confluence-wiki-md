import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ConfluenceApi, readWikiConfig } from '../src/api.mjs';

async function fixture(t, deployment) {
  let acl = { read: { users: ['creator', 'actor', 'reader', 'fourth'], groups: ['group1', 'group2', 'group3'] }, update: { users: ['creator', 'actor', 'editor'], groups: ['editors'] } };
  const writes = [];
  const requests = [];
  const state = { broken: false, denied: false, malformed: false, hostile: false };
  const user = (id) => ({ type: 'known', [deployment === 'cloud' ? 'accountId' : 'username']: id });
  const group = (id) => ({ type: 'group', [deployment === 'cloud' ? 'id' : 'name']: id });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(url.pathname + url.search);
    let text = ''; for await (const chunk of req) text += chunk;
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/rest/api/user/current') return send(200, user('actor'));
    if (url.pathname === '/rest/api/content/42') return send(200, { id: '42', type: 'page', history: { createdBy: user('creator') } });
    if (url.pathname === '/api/v2/pages/42') return send(200, { id: '42', authorId: 'creator' });
    const operation = url.pathname.match(/\/restriction\/byOperation\/(read|update)$/)?.[1];
    if (operation) {
      if (state.malformed) return send(200, { operation, restrictions: {} });
      const start = Number(url.searchParams.get('start') ?? 0);
      const collection = (values, size, make) => ({ results: values.slice(start, start + size).map(make), start, limit: size, size: values.slice(start, start + size).length });
      const value = { operation, restrictions: { user: collection(acl[operation].users, 2, user), group: collection(acl[operation].groups, 1, group) } };
      if (state.hostile) value.restrictions.user._links = { next: 'https://evil.invalid/rest/api/content/42/restriction/byOperation/' + operation + '?start=2' };
      return send(200, value);
    }
    if (url.pathname === '/rest/api/content/42/restriction') {
      writes.push({ method: req.method, body: text ? JSON.parse(text) : null });
      if (state.denied) return send(403, { secret: 'never-show-this' });
      acl = { read: { users: [], groups: [] }, update: { users: [], groups: [] } };
      if (req.method === 'PUT') for (const item of JSON.parse(text)) acl[item.operation] = { users: (item.restrictions.user ?? []).map((x) => x.accountId ?? x.username), groups: (item.restrictions.group ?? []).map((x) => x.id ?? x.name) };
      if (state.broken) acl.read = { users: [], groups: [] };
      return send(200, { results: [] });
    }
    return send(404, {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = new ConfluenceApi(readWikiConfig({ CONFLUENCE_SITE_URL: base, CONFLUENCE_API_URL: base + (deployment === 'cloud' ? '/api/v2' : '/rest/api'), CONFLUENCE_API_V1_URL: base + '/rest/api', CONFLUENCE_DEPLOYMENT: deployment, CONFLUENCE_EMAIL: 'test@example.test', CONFLUENCE_API_TOKEN: 'synthetic', CONFLUENCE_ALLOW_HTTP: 'true' }));
  return { api, state, writes, requests, get acl() { return acl; } };
}

for (const deployment of ['cloud', 'datacenter']) {
  test('restrictions: replacement and nested pagination ' + deployment, async (t) => {
    const { getRestrictions, setRestrictions, restrictionPolicy } = await import('../src/restrictions.mjs');
    const f = await fixture(t, deployment);
    const initial = await getRestrictions(f.api, '42');
    assert.deepEqual(initial.read.users, ['actor', 'creator', 'fourth', 'reader']);
    assert.deepEqual(initial.read.groups, ['group1', 'group2', 'group3']);
    assert.equal(initial.scope, 'direct');
    assert.equal(initial.inheritedNotEvaluated, true);
    assert.equal(f.writes.length, 0);
    const restricted = await setRestrictions(f.api, '42', restrictionPolicy({ mode: 'view-edit', readUsers: ['reader'], editUsers: ['editor'], editGroups: ['editors'] }));
    assert.deepEqual(restricted.read.users, ['actor', 'creator', 'editor', 'reader']);
    assert.deepEqual(restricted.update.users, ['actor', 'creator', 'editor']);
    assert.deepEqual(restricted.read.groups, ['editors']);
    assert.equal(f.writes.length, 1);
    const edit = await setRestrictions(f.api, '42', restrictionPolicy({ mode: 'edit' }));
    assert.deepEqual(edit.read, { users: [], groups: [] });
    assert.deepEqual(edit.update.users, ['actor', 'creator']);
    const none = await setRestrictions(f.api, '42', restrictionPolicy({ mode: 'none' }));
    assert.equal(none.mode, 'none');
    assert.deepEqual(f.acl, { read: { users: [], groups: [] }, update: { users: [], groups: [] } });
  });

  test('restrictions: fail closed ' + deployment, async (t) => {
    const { getRestrictions, setRestrictions, restrictionPolicy } = await import('../src/restrictions.mjs');
    const f = await fixture(t, deployment);
    for (const input of [{ mode: 'typo' }, { mode: 'none', editUsers: ['actor'] }, { mode: 'edit', readGroups: ['team'] }, { mode: 'view-edit', readUsers: [''] }]) assert.throws(() => restrictionPolicy(input));
    await assert.rejects(getRestrictions(f.api, '../42'), /numeric/);
    assert.equal(f.requests.length, 0);
    f.state.denied = true;
    await assert.rejects(setRestrictions(f.api, '42', { mode: 'view-edit' }), (error) => /403/.test(error.message) && !error.message.includes('never-show-this'));
    assert.equal(f.writes.length, 1);
    f.state.denied = false; f.state.broken = true;
    await assert.rejects(setRestrictions(f.api, '42', { mode: 'view-edit' }), /verification|verify/i);
    assert.equal(f.writes.length, 2, 'verification failure must not remove restrictions');
    f.state.malformed = true;
    await assert.rejects(getRestrictions(f.api, '42'), /incomplete|missing|Malformed/i);
    f.state.malformed = false; f.state.hostile = true;
    await assert.rejects(getRestrictions(f.api, '42'), /pagination/i);
  });
}
