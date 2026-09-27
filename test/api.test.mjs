import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfluenceApi, readWikiConfig } from '../src/api.mjs';

const config = (deployment = 'cloud') => readWikiConfig({ CONFLUENCE_SITE_URL: 'https://wiki.example.test/confluence', CONFLUENCE_API_URL: deployment === 'cloud' ? 'https://api.example.test/wiki/api/v2' : 'https://wiki.example.test/confluence/rest/api', CONFLUENCE_EMAIL: 'test@example.test', CONFLUENCE_API_TOKEN: 'test-token', CONFLUENCE_DEPLOYMENT: deployment, CONFLUENCE_SPACE_KEY: 'TEST' });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

for (const deployment of ['cloud', 'datacenter']) {
  test(deployment + ' named root property uses native wire without touching Markdown metadata', async (t) => {
    const calls = [];
    const properties = new Map([['confluence-wiki-md', { id: '8', key: 'confluence-wiki-md', value: { metadata: { type: 'Collection' } }, version: { number: 1 } }]]);
    const api = new ConfluenceApi(config(deployment));
    const dc = deployment === 'datacenter';
    t.mock.method(globalThis, 'fetch', async (input, options) => {
      const url = new URL(input);
      const body = options.body && JSON.parse(options.body);
      const key = body?.key ?? (dc ? decodeURIComponent(url.pathname.split('/').at(-1)) : url.searchParams.get('key'));
      calls.push({ path: url.pathname, query: url.search, method: options.method, body });
      if (options.method === 'GET') {
        const property = properties.get(key);
        return dc ? response(property ?? {}, property ? 200 : 404) : response({ results: property ? [property] : [] });
      }
      const property = { ...body, id: '9', version: body.version ?? { number: 1 } };
      properties.set(key, property);
      return response(property);
    });
    const value = { schema: 1, pageId: '42', topic: 'Release' };
    await api.setProperty('42', value, 'cfwiki-root');
    assert.deepEqual((await api.getProperty('42', 'cfwiki-root')).value, value);
    await api.setProperty('42', { ...value, topic: 'Updated' }, 'cfwiki-root');
    assert.deepEqual((await api.getProperty('42')).value, { metadata: { type: 'Collection' } });
    const writes = calls.filter((call) => call.method !== 'GET');
    assert.deepEqual(writes.map((call) => call.method), ['POST', 'PUT']);
    assert.equal(writes[0].path, dc ? '/confluence/rest/api/content/42/property' : '/wiki/api/v2/pages/42/properties');
    assert.equal(writes[1].path, dc ? '/confluence/rest/api/content/42/property/cfwiki-root' : '/wiki/api/v2/pages/42/properties/9');
    assert.equal(writes[1].body.version.number, 2);
    assert.ok(writes.every((call) => call.body.key === 'cfwiki-root'));
  });
}

for (const deployment of ['cloud', 'datacenter']) {
  test(deployment + ' native templates use their own REST base and preserve opaque IDs', async (t) => {
    const calls = [];
    const id = 'com.example:runbook';
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization });
      return response({ templateId: id, name: 'Runbook', templateType: 'page', space: { key: 'TEST' }, body: { storage: { value: '<p>Native body</p>' } }, labels: [{ name: 'runbook' }] });
    });
    const api = new ConfluenceApi(config(deployment));
    assert.equal((await api.getTemplate(id)).storage, '<p>Native body</p>');
    assert.ok(calls[0].url.endsWith('/template/com.example%3Arunbook?expand=body.storage'));
    assert.match(calls[0].url, deployment === 'cloud' ? /\/wiki\/rest\/api\/template\// : /\/confluence\/rest\/experimental\/template\//);
    assert.ok(calls[0].authorization.startsWith(deployment === 'cloud' ? 'Basic ' : 'Bearer '));
    await assert.rejects(api.getTemplate('../42'), /Invalid/);
    assert.equal(calls.length, 1);
  });
}

test('native template list paginates and scope errors do not expose response bodies', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return response({ results: [{ templateId: String(calls.length), name: 'Template', templateType: 'page' }], _links: calls.length === 1 ? { next: '/wiki/rest/api/template/page?spaceKey=TEST&start=1&limit=1' } : {} });
  });
  const api = new ConfluenceApi(config());
  assert.deepEqual((await api.listTemplates({ space: 'TEST', limit: 2 })).map((item) => item.id), ['1', '2']);
  assert.match(calls[0], /spaceKey=TEST/);
  assert.match(calls[1], /start=1/);
  globalThis.fetch.mock.mockImplementation(async () => response({ secret: 'private-token' }, 401));
  await assert.rejects(api.getTemplate('42'), (error) => /read:template:confluence/.test(error.message) && !error.message.includes('private-token'));
});

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

test('scoped search returns candidates without body reads', async (t) => {
  let handler;
  t.mock.method(globalThis, 'fetch', (...args) => handler(...args));
  for (const deployment of ['cloud', 'datacenter']) {
    const calls = [];
    handler = async (url) => {
      calls.push(String(url));
      return response({
        results: [
          { content: { id: '41', title: 'Markdown guide', space: { key: 'TEST' } }, excerpt: 'Title match' },
          { content: { id: '42', title: 'Publishing', space: { key: 'TEST' } }, excerpt: 'Uses Markdown text' },
        ],
      });
    };
    const result = await new ConfluenceApi(config(deployment)).searchScoped('Markdown', { space: 'TEST', limit: 3 });
    assert.deepEqual(result.results.map(({ id, title, excerpt }) => ({ id, title, excerpt })), [
      { id: '41', title: 'Markdown guide', excerpt: 'Title match' },
      { id: '42', title: 'Publishing', excerpt: 'Uses Markdown text' },
    ]);
    assert.equal(result.query, 'Markdown');
    assert.equal(result.space, 'TEST');
    assert.equal(result.truncated, false);
    assert.match(result.searchedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(calls.length, 1);
    assert.ok(calls.every((url) => new URL(url).pathname.endsWith('/search')));
    const cql = new URL(calls[0]).searchParams.get('cql');
    assert.match(cql, /space = "TEST"/);
    assert.match(cql, /\(title ~ "Markdown" OR text ~ "Markdown"\)/);
    assert.ok(result.results.every((item) => !('body' in item) && !('version' in item)));
  }
});

test('scoped search rejects cross-space and CQL injection', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return response({
      results: [
        { content: { id: '41', title: 'Foreign', space: { key: 'OTHER' } }, excerpt: 'Out of scope' },
        { content: { id: '42', title: 'Trusted', space: { key: 'TEST' } }, excerpt: 'In scope' },
      ],
    });
  });
  const api = new ConfluenceApi(config());
  await assert.rejects(api.searchScoped('Markdown'), /explicit trusted space/);
  const query = 'Markdown" OR space = "OTHER';
  const result = await api.searchScoped(query, { space: 'TEST', cql: 'type = page' });
  assert.deepEqual(result.results.map((item) => item.id), ['42']);
  assert.equal(calls.length, 1);
  const cql = new URL(calls[0]).searchParams.get('cql');
  assert.match(cql, /^type = page AND space = "TEST" AND \(title ~ /);
  assert.ok(cql.includes('Markdown\\" OR space = \\"OTHER'));
  assert.notEqual(cql, 'type = page');
});

test('scoped search caps empty pagination and retains filter', async (t) => {
  let handler;
  t.mock.method(globalThis, 'fetch', (...args) => handler(...args));
  for (const deployment of ['cloud', 'datacenter']) {
    const calls = [];
    handler = async (url) => {
      calls.push(String(url));
      return response({
        results: [],
        _links: { next: '/rest/api/search?cql=type%20%3D%20page&cursor=cursor-' + calls.length + '&start=' + calls.length },
      });
    };
    const result = await new ConfluenceApi(config(deployment)).searchScoped('Markdown', { space: 'TEST', limit: 100, maxPages: 99 });
    assert.deepEqual(result.results, []);
    assert.equal(result.truncated, true);
    assert.equal(calls.length, 2);
    for (const url of calls) {
      const params = new URL(url).searchParams;
      assert.equal(params.get('cql'), 'type = page AND space = "TEST" AND (title ~ "Markdown" OR text ~ "Markdown")');
      assert.equal(params.get('limit'), '50');
    }
    assert.equal(new URL(calls[1]).searchParams.get('cursor'), 'cursor-1');
  }
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
