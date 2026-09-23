import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ConfluenceApi, readWikiConfig } from '../src/api.mjs';
import { parseDocument } from '../src/document.mjs';
import { listComments, listReplies, getComment, createComment, updateComment, deleteComment, formatComment, formatComments } from '../src/comments.mjs';

async function fixture(t, deployment = 'cloud') {
  const calls = []; const comments = new Map(); let count = 100; let status; let next;
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const url = new URL(req.url, 'http://local');
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    res.setHeader('content-type', 'application/json');
    if (status) { res.writeHead(status); res.end(JSON.stringify({ secret: 'do-not-print' })); return; }
    const id = url.pathname.match(/\/(\d+)(?:\/children)?$/)?.[1];
    const kind = url.pathname.includes('inline') || url.searchParams.get('location') === 'inline' ? 'inline' : 'footer';
    if (req.method === 'DELETE') { comments.delete(id); res.writeHead(204); res.end(); return; }
    if (req.method === 'POST' || req.method === 'PUT') {
      const key = req.method === 'POST' ? String(++count) : id;
      const previous = comments.get(key) ?? {};
      const value = { ...previous, id: key, type: 'comment', pageId: body.pageId ?? previous.pageId ?? body.container?.id, parentCommentId: body.parentCommentId ?? previous.parentCommentId, version: body.version ?? { number: 1, authorId: 'a:\nquoted' }, body: { storage: { value: body.body.value ?? body.body.storage.value } }, ...(body.resolved !== undefined ? { resolutionStatus: body.resolved ? 'resolved' : 'open' } : {}), ...(deployment === 'datacenter' ? { extensions: { location: kind } } : {}) };
      comments.set(key, value); res.end(JSON.stringify(value)); return;
    }
    if (url.pathname.endsWith('comments') || url.pathname.endsWith('/comment') || url.pathname.endsWith('/children')) {
      res.end(JSON.stringify({ results: [...comments.values()], ...(next ? { _links: { next } } : {}) })); return;
    }
    res.end(JSON.stringify(comments.get(id) ?? { id, type: 'page', body: { storage: { value: '' } } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const api = new ConfluenceApi(readWikiConfig({ CONFLUENCE_SITE_URL: 'http://127.0.0.1:' + server.address().port, CONFLUENCE_ALLOW_HTTP: 'true', CONFLUENCE_DEPLOYMENT: deployment, CONFLUENCE_EMAIL: 'test@example.test', CONFLUENCE_API_TOKEN: 'synthetic' }));
  return { api, calls, comments, status: (value) => { status = value; }, next: (value) => { next = value; } };
}

for (const kind of ['footer', 'inline']) test('comments: CRUD replies and inline resolution ' + kind, async (t) => {
  const f = await fixture(t);
  const root = await createComment(f.api, '42', '한글 **본문**\n\n```mermaid\ngraph TD; A-->B\n```', { kind, ...(kind === 'inline' ? { selection: 'anchor', selectionCount: 1, selectionIndex: 0 } : {}) });
  assert.equal(root.pageId, '42'); assert.equal(root.version, 1); assert.match(root.storage, /ac:name="code"/); assert.doesNotMatch(root.storage, /ac:name="mermaid"/);
  assert.equal((await getComment(f.api, root.id, { kind })).id, root.id);
  const reply = await createComment(f.api, root.id, '답글', { kind, reply: true });
  const post = f.calls.filter((c) => c.method === 'POST').at(-1).body;
  assert.equal(post.parentCommentId, root.id); assert.equal(post.pageId, undefined); assert.equal(reply.pageId, '42');
  const nested = await createComment(f.api, reply.id, 'nested', { kind, reply: true });
  assert.equal(nested.parentCommentId, reply.id);
  assert.ok((await listReplies(f.api, root.id, { kind })).length >= 1);
  assert.ok((await listComments(f.api, '42', { kind })).length >= 1);
  const formatted = formatComment(f.api, root);
  assert.equal(parseDocument(formatted).metadata.confluence_comment.author_id, 'a:\nquoted');
  assert.equal(parseDocument(formatted).metadata.confluence, undefined);
  assert.match(formatComments(f.api, [root, reply]), /confluence_comment:/);
  const updated = await updateComment(f.api, root.id, formatted, { kind, version: 1 });
  assert.equal(updated.version, 2); assert.equal(f.calls.at(-1).body.version.number, 2);
  let version = 2;
  if (kind === 'inline') {
    const resolved = await updateComment(f.api, root.id, undefined, { kind, version, resolved: true });
    assert.equal(resolved.resolved, true); assert.equal(resolved.storage, updated.storage); version++;
    const reopened = await updateComment(f.api, root.id, undefined, { kind, version, resolved: false });
    assert.equal(reopened.resolved, false); version++;
  }
  assert.equal((await deleteComment(f.api, root.id, { kind, version })).atomicVersionCheck, false);
  assert.equal(f.comments.has(root.id), false);
});

test('comments: rejected operations stale bindings target kind and DC boundaries', async (t) => {
  const f = await fixture(t);
  const root = await createComment(f.api, '42', 'body');
  const writes = () => f.calls.filter((c) => c.method !== 'GET').length;
  const before = writes();
  await assert.rejects(updateComment(f.api, root.id, 'body', { version: 2 }), /version conflict/);
  await assert.rejects(deleteComment(f.api, root.id, { version: 2 }), /version conflict/);
  await assert.rejects(updateComment(f.api, root.id, 'body'), /positive integer/);
  await assert.rejects(updateComment(f.api, root.id, '---\nconfluence_comment:\n  site: https://evil.test\n---\nbody', { version: 1 }), /metadata site/);
  for (const [key, value] of [['id', '999'], ['kind', 'inline'], ['page_id', '999'], ['parent_comment_id', '999'], ['api', 'https://evil.test']]) {
    await assert.rejects(updateComment(f.api, root.id, `---\nconfluence_comment:\n  ${key}: '${value}'\n---\nbody`, { version: 1 }), /metadata/);
  }
  await assert.rejects(createComment(f.api, '42', '---\nconfluence:\n  id: 42\n---\nbody'), /Page metadata/);
  await assert.rejects(updateComment(f.api, '999', 'body', { version: 1 }), /not a comment/);
  assert.equal(writes(), before);
  const d = await fixture(t, 'datacenter');
  for (const operation of [() => createComment(d.api, '42', 'body', { reply: true }), () => createComment(d.api, '42', 'body', { kind: 'inline' }), () => updateComment(d.api, '42', 'body', { kind: 'inline', version: 1 }), () => deleteComment(d.api, '42', { kind: 'inline', version: 1 }), () => listReplies(d.api, '42')]) await assert.rejects(operation(), /Data Center .* is not supported/);
  assert.equal(d.calls.length, 0);
});

test('comments: DC footer CRUD and inline reads', async (t) => {
  const f = await fixture(t, 'datacenter');
  const root = await createComment(f.api, '42', 'body');
  assert.equal(f.calls.at(-1).body.container.id, '42');
  assert.equal((await updateComment(f.api, root.id, 'updated', { version: 1 })).version, 2);
  await listComments(f.api, '42');
  assert.equal(f.calls.at(-1).query.location, 'footer'); assert.equal(f.calls.at(-1).query.depth, 'all');
  f.comments.set('200', { id: '200', type: 'comment', version: { number: 1 }, body: { storage: { value: '<p>inline</p>' } }, extensions: { location: 'inline', resolution: { status: 'resolved' } } });
  assert.equal((await getComment(f.api, '200', { kind: 'inline' })).resolved, true);
  await assert.rejects(getComment(f.api, '200'), /kind/);
  await deleteComment(f.api, root.id, { version: 2 });
});

for (const status of [401, 403, 404, 409]) test('comments: rejected operations HTTP ' + status, async (t) => {
  const f = await fixture(t); f.status(status);
  await assert.rejects(listComments(f.api, '42'), (error) => error.status === status && !error.message.includes('do-not-print'));
  assert.equal(f.calls.length, 1);
});

test('comments: rejected operations malicious pagination and cycle', async (t) => {
  const f = await fixture(t);
  for (const link of ['https://evil.test/wiki/api/v2/pages/42/footer-comments?cursor=x', '/wiki/api/v2/pages/99/footer-comments?cursor=x']) {
    f.next(link); const before = f.calls.length;
    await assert.rejects(listComments(f.api, '42'), /outside/); assert.equal(f.calls.length, before + 1);
  }
  f.next('/wiki/api/v2/pages/42/footer-comments?body-format=storage&limit=100');
  await assert.rejects(listComments(f.api, '42'), /cycle/);
});

test('comments: permalinks preserve Cloud and Data Center context', async () => {
  for (const [deployment, webBase, link, expected] of [
    ['cloud', 'https://site.atlassian.net/wiki', '/spaces/AGENTTEST/pages/1605633/Page?focusedCommentId=101', 'https://site.atlassian.net/wiki/spaces/AGENTTEST/pages/1605633/Page?focusedCommentId=101'],
    ['cloud', 'https://site.atlassian.net/wiki', '/wiki/spaces/AGENTTEST/pages/1605633/Page', 'https://site.atlassian.net/wiki/spaces/AGENTTEST/pages/1605633/Page'],
    ['cloud', 'https://site.atlassian.net/wiki', 'https://site.atlassian.net/wiki/spaces/AGENTTEST/pages/1605633/Page', 'https://site.atlassian.net/wiki/spaces/AGENTTEST/pages/1605633/Page'],
    ['datacenter', 'https://site.example/confluence', '/pages/viewpage.action?pageId=42&focusedCommentId=101', 'https://site.example/confluence/pages/viewpage.action?pageId=42&focusedCommentId=101'],
    ['datacenter', 'https://site.example/confluence', '/confluence/pages/viewpage.action?pageId=42', 'https://site.example/confluence/pages/viewpage.action?pageId=42'],
  ]) {
    const api = { config: { deployment, webBase, siteUrl: new URL(webBase).origin }, request: async () => ({ id: '101', type: 'comment', version: { number: 1 }, body: { storage: { value: '<p>Body</p>' } }, _links: { webui: link } }) };
    assert.equal((await getComment(api, '101')).url, expected);
  }
});

test('comments: permalinks reject external and dangerous server links', async () => {
  for (const link of ['https://evil.test/wiki/page', '//evil.test/wiki/page', 'javascript:alert(1)', 'https://user:password@site.atlassian.net/wiki/page', '../outside', '/wiki/%2e%2e/outside', '/wiki\\evil', '/wiki/page\n']) {
    const api = { config: { deployment: 'cloud', webBase: 'https://site.atlassian.net/wiki', siteUrl: 'https://site.atlassian.net' }, request: async () => ({ id: '101', version: { number: 1 }, body: { storage: { value: '<p>Body</p>' } }, _links: { webui: link } }) };
    await assert.rejects(getComment(api, '101'), /Unsafe comment permalink/);
  }
});
