import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfluenceApi, readWikiConfig } from '../src/api.mjs';

const config = (deployment = 'cloud') => readWikiConfig({ CONFLUENCE_SITE_URL: 'https://wiki.example.test/confluence', CONFLUENCE_API_URL: deployment === 'cloud' ? 'https://api.example.test/wiki/api/v2' : 'https://wiki.example.test/confluence/rest/api', CONFLUENCE_EMAIL: 'test@example.test', CONFLUENCE_API_TOKEN: 'test-token', CONFLUENCE_DEPLOYMENT: deployment, CONFLUENCE_SPACE_KEY: 'TEST' });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('Cloud page writes use v2 bodies, Basic auth and explicit next version', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...options });
    const body = JSON.parse(options.body);
    return response({ ...body, id: body.id ?? '42', version: body.version ?? { number: 1 }, body: { storage: { value: body.body.value } } });
  });
  const api = new ConfluenceApi(config());
  const created = await api.writePage({ title: 'Page', storage: '<p>Body</p>', space: { id: '1' }, parentId: '5' });
  const updated = await api.writePage({ id: created.id, title: 'Page', storage: '<p>Updated</p>', space: { id: '1' }, version: created.version });
  assert.equal(updated.version, 2);
  assert.equal(calls[0].url, 'https://api.example.test/wiki/api/v2/pages');
  assert.equal(calls[1].url, 'https://api.example.test/wiki/api/v2/pages/42');
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].body).body, { representation: 'storage', value: '<p>Body</p>' });
  assert.equal(calls[0].headers.Authorization, 'Basic ' + Buffer.from('test@example.test:test-token').toString('base64'));
  assert.equal(calls[0].redirect, 'error');
});

for (const deployment of ['cloud', 'datacenter']) {
  test(deployment + ' attachment create/update sends multipart to the correct API', async (t) => {
    const writes = [];
    let exists = false;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (String(url).includes('/download')) return new Response('first');
      if (options.method === 'GET') return response({ results: exists ? [{ id: deployment === 'cloud' ? '99' : 'att99', title: 'diagram.svg', _links: { download: '/download/attachments/42/diagram.svg' } }] : [] });
      writes.push({ url, ...options });
      exists = true;
      return response({ results: [{ id: 'att99' }] });
    });
    const api = new ConfluenceApi(config(deployment));
    await api.uploadAttachment('42', 'diagram.svg', Buffer.from('first'), 'image/svg+xml');
    await api.uploadAttachment('42', 'diagram.svg', Buffer.from('second'), 'image/svg+xml');
    assert.equal(writes[0].method, deployment === 'cloud' ? 'PUT' : 'POST');
    assert.equal(writes[1].method, 'POST');
    assert.ok(writes[1].url.endsWith('/content/42/child/attachment/att99/data'));
    assert.equal(writes[1].headers['X-Atlassian-Token'], 'nocheck');
    assert.equal(await writes[1].body.get('file').text(), 'second');
    assert.equal(writes[1].body.get('file').name, 'diagram.svg');
  });
}

test('signed attachment redirects receive no API credentials', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://media.example.test/file?signature=test' } }) : new Response('image-bytes');
  });
  const bytes = await new ConfluenceApi(config()).downloadAttachment('42', { id: 'att99' });
  assert.equal(bytes.toString(), 'image-bytes');
  assert.ok(calls[0].headers.Authorization);
  assert.equal(calls[1].headers, undefined);
  assert.equal(calls[1].redirect, 'error');
});

test('Data Center attachment download keeps the corporate context path', async (t) => {
  let requested;
  t.mock.method(globalThis, 'fetch', async (url) => { requested = String(url); return new Response('data'); });
  await new ConfluenceApi(config('datacenter')).downloadAttachment('42', { _links: { download: '/download/attachments/42/file.png' } });
  assert.equal(requested, 'https://wiki.example.test/confluence/download/attachments/42/file.png');
  await new ConfluenceApi(config('datacenter')).downloadAttachment('42', { _links: { download: '/confluence/download/attachments/42/file.png' } });
  assert.equal(requested, 'https://wiki.example.test/confluence/download/attachments/42/file.png');
});

test('pagination refuses another origin and errors never expose response secrets', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response({ results: [], _links: { next: 'https://evil.example.test/?cursor=x' } }));
  await assert.rejects(new ConfluenceApi(config()).paginate('/pages'), /outside/);
  globalThis.fetch.mock.mockImplementation(async () => response({ secret: 'sensitive-server-content' }, 403));
  await assert.rejects(new ConfluenceApi(config()).getPage('42'), (error) => /HTTP 403/.test(error.message) && !error.message.includes('sensitive-server-content'));
});

test('Cloud macro previews use asynchronous conversion without publishing content', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...options });
    return response(options.method === 'POST' ? { asyncId: 'preview-1' } : { status: 'COMPLETE', value: '<svg><text>Diagram</text></svg>' });
  });
  const result = await new ConfluenceApi(config()).previewStorage('<ac:structured-macro ac:name="mermaid"/>', { space: 'TEST' });
  assert.equal(result.verified, true);
  assert.match(calls[0].url, /\/rest\/api\/contentbody\/convert\/async\/view\?spaceKeyContext=TEST$/);
  assert.match(calls[1].url, /convert\/async\/preview-1$/);
  assert.equal(JSON.parse(calls[0].body).representation, 'storage');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

test('Data Center rejects an unknown macro preview, including HTTP 200 error bodies', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /\/contentbody\/convert\/view/);
    return response({ value: '<span class="error">Unknown macro: mermaid</span>' });
  });
  await assert.rejects(new ConfluenceApi(config('datacenter')).previewStorage('<macro/>'), /rejected a diagram macro preview/);
});

test('Cloud unknown macro image placeholders cannot pass server validation', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => response(options.method === 'POST' ? { asyncId: 'preview-placeholder' } : {
    status: 'COMPLETED',
    representation: 'view',
    value: '<img class="wysiwyg-unknown-macro" src="https://wiki.example.test/wiki/plugins/servlet/confluence/placeholder/unknown-macro?name=cfwiki-uninstalled-validation-probe&amp;locale=ko_KR&amp;version=2" />',
  }));
  await assert.rejects(new ConfluenceApi(config()).previewStorage('<ac:structured-macro ac:name="cfwiki-uninstalled-validation-probe"/>'), /rejected a diagram macro preview/);
});

test('iframe previews are explicitly marked as dynamic app output', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response({ value: '<iframe src="https://app.example.test"></iframe>' }));
  assert.equal((await new ConfluenceApi(config('datacenter')).previewStorage('<macro/>')).dynamic, true);
});

test('valid diagram labels mentioning syntax errors are not treated as renderer failures', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response({ value: '<svg><text>Syntax error handler</text></svg>' }));
  assert.equal((await new ConfluenceApi(config('datacenter')).previewStorage('<macro/>')).verified, true);
});
