import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { ConfluenceApi, readWikiConfig } from '../src/api.mjs';
import { applyAgentEdit, equivalentStorage } from '../src/agent-edit.mjs';
import { parseDocument, formatDocument, hash, bodyHash, storageToMarkdown, loadStorageXml } from '../src/document.mjs';
import { download, upload } from '../src/wiki.mjs';

const baseStorage = '<p>First original</p><p>Middle unchanged</p><p>Last original</p>';
const remoteStorage = baseStorage.replace('Last original', 'Last remote');
const native = '<ac:structured-macro ac:name="jira" ac:macro-id="stable"><ac:parameter ac:name="key">DOC-1</ac:parameter></ac:structured-macro>';

for (const name of ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf', '__defineGetter__', 'ac:label', '_', 'data.a-b']) {
  for (const [context, wrap] of [
    ['ordinary', (body) => body],
    ['pre', (body) => '<pre><blockquote>' + body + '</blockquote></pre>'],
    ['native', (body) => '<ac:structured-macro ac:name="unknown"><ac:rich-text-body>' + body + '</ac:rich-text-body></ac:structured-macro>'],
  ]) {
    test('storage comparison never loses legal attributes: ' + context + '/' + name, () => {
      const original = wrap('<p ' + name + '="one">alpha</p>');
      assert.equal(equivalentStorage(original, original, []), true);
      for (const changed of [
        wrap('<p ' + name + '="two">alpha</p>'),
        wrap('<p ' + name + '="">alpha</p>'),
        wrap('<p>alpha</p>'),
      ]) {
        assert.equal(equivalentStorage(original, changed, []), false);
        assert.equal(equivalentStorage(changed, original, []), false);
      }
    });
  }
}

test('storage comparison refuses malformed lexical input before equality', () => {
  for (const whitespace of ['\u00a0', '\u2003', '\u2028', '\ufeff']) {
    const invalid = '<p title="&#9;">alpha</p' + whitespace + '>';
    assert.equal(equivalentStorage(invalid, invalid, []), false);
    assert.equal(equivalentStorage('<p>alpha</p>', '<p>alpha</p' + whitespace + '>', []), false);
  }
  assert.equal(equivalentStorage('<p title="one">alpha</p>', '<p title = "one">alpha</p >', []), true);
  assert.equal(equivalentStorage('<p title="alpha\u00a0beta">text</p>', '<p title="alpha beta">text</p>', []), false);
});

for (const [context, wrap] of [
  ['attribute', (value) => '<a title="alpha' + value + 'beta">label</a>'],
  ['pre-attribute', (value) => '<pre><a title="alpha' + value + 'beta">label</a></pre>'],
  ['text', (value) => '<p>alpha' + value + 'beta</p>'],
  ['pre-text', (value) => '<pre><blockquote><p>alpha' + value + 'beta</p></blockquote></pre>'],
]) {
  for (const point of [9, 10, 13]) {
    for (const reference of ['&#' + point + ';', '&#000' + point + ';', '&#x' + point.toString(16) + ';', '&#x000' + point.toString(16).toUpperCase() + ';']) {
      test('storage equivalence refuses ambiguous control references: ' + context + '/' + reference, () => {
        const literal = wrap(String.fromCharCode(point));
        const referenced = wrap(reference);
        assert.equal(equivalentStorage(literal, literal, []), true);
        assert.equal(equivalentStorage(referenced, referenced, []), true);
        assert.equal(equivalentStorage(literal, referenced, []), false);
        assert.equal(equivalentStorage(referenced, literal, []), false);
        // An unrelated layout rewrite is also uncertain with this parser.
        assert.equal(equivalentStorage('<p>Outside</p>\n' + referenced, '<p>Outside</p>' + referenced, []), false);
      });
    }
  }
  test('storage equivalence retains ordinary entity normalization: ' + context, () => {
    for (const reference of ['&#32;', '&#00032;', '&#x20;', '&#x00020;']) {
      assert.equal(equivalentStorage(wrap(' '), wrap(reference), []), true);
      assert.equal(equivalentStorage(wrap(reference), wrap(' '), []), true);
    }
    // Escaping the ampersand makes this literal text, not a TAB reference.
    const subtree = '<blockquote>' + wrap('&amp;#9;') + '</blockquote>';
    assert.equal(equivalentStorage('<p>Outside</p>\n' + subtree, '<p>Outside</p>' + subtree, []), true);
  });
}

test('storage equivalence retains exact native bytes and order around entities', () => {
  const second = native.replace('stable', 'second').replace('DOC-1', 'DOC-2');
  for (const first of [native, native.replace('DOC-1', 'DOC-&#9;')]) {
    const preserved = [first, second].map((storage) => ({ storage, block: true }));
    const intended = '<p>Outside</p>\n' + first + second;
    assert.equal(equivalentStorage(intended, intended, preserved), true);
    assert.equal(equivalentStorage(intended, intended.replace('\n', ''), preserved), first === native);
    for (const changed of [
      intended.replace(first + second, second + first),
      intended.replace(first, ''),
      intended + first,
      intended.replace('DOC-1', 'DOC-&#49;').replace('DOC-&#9;', 'DOC-\t'),
    ]) {
      assert.equal(equivalentStorage(intended, changed, preserved), false);
      assert.equal(equivalentStorage(changed, intended, preserved), false);
    }
    // Exact-storage fallback must not bypass fragment uniqueness.
    assert.equal(equivalentStorage(intended + first, intended + first, preserved), false);
  }
});

// Include XML contexts that the Markdown sanitizer will not emit, without
// weakening that sanitizer or replacing the real CLI publication regressions.
for (const [context, open, close] of [
  ['pre', '<pre><blockquote>', '</blockquote></pre>'],
  ['nested-pre', '<pre><blockquote><pre><blockquote>', '</blockquote></pre></blockquote></pre>'],
  ['xml-space', '<blockquote xml:space="preserve"><blockquote>', '</blockquote></blockquote>'],
  ['xml-space-default-child', '<blockquote xml:space="preserve"><blockquote xml:space="default">', '</blockquote></blockquote>'],
]) {
  for (const [content, first, second, preserved] of [
    ['text', '<p>alpha</p>', '<p>beta</p>', []],
    ['escaped-text', '<p>&lt;alpha&gt; &amp; &#32;</p>', '<p>beta</p>', []],
    ['CDATA', '<p><![CDATA[alpha ]]></p>', '<p>beta</p>', []],
    ['native-child', '<p>alpha</p>', native, [{ storage: native, block: true }]],
  ]) {
    test('storage equivalence preserves inherited whitespace: ' + context + '/' + content, () => {
      const subtree = open + first + ' ' + second + close;
      const intended = '<p>Outside</p>\n' + subtree;
      const normalized = '<p>Outside</p>' + subtree;
      assert.equal(equivalentStorage(intended, intended, preserved), true);
      assert.equal(equivalentStorage(normalized, intended, preserved), true);
      // Entity spelling can change, but its decoded whitespace cannot disappear.
      assert.equal(equivalentStorage(normalized.replace(first + ' ', first + '&#32;'), intended, preserved), true);
      for (const whitespace of ['', '\t', '\n', '  ']) {
        const changed = normalized.replace(first + ' ' + second, first + whitespace + second);
        assert.equal(equivalentStorage(changed, intended, preserved), false);
        assert.equal(equivalentStorage(intended, changed, preserved), false);
      }
      assert.equal(equivalentStorage(normalized.replace('alpha', 'changed'), intended, preserved), false);
      if (preserved.length) {
        assert.equal(equivalentStorage(normalized.replace('DOC-1', 'DOC-2'), intended, preserved), false);
        assert.equal(equivalentStorage(normalized.replace(native, ''), intended, preserved), false);
        assert.equal(equivalentStorage(normalized + native, intended, preserved), false);
      }
    });
  }
}

// Adapted from wiki.test.mjs's serverFixture, kept local because that helper is
// private and this fixture needs historical versions plus both REST dialects.
async function serverFixture(t, deployment, { storage = baseStorage, current = remoteStorage, version = 8, baselineVersion = 7, parentId = '5' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-agent-fixture-'));
  const originalTmp = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  const requests = [];
  const events = new EventEmitter();
  const dc = deployment === 'datacenter';
  const prefix = dc ? '/confluence/rest/api' : '/wiki/api/v2';
  const pagePath = prefix + (dc ? '/content/42' : '/pages/42');
  const rawPage = (value, number) => ({
    id: '42', title: 'Page', status: 'current', version: { number },
    ...(dc ? { space: { id: '1', key: 'TEST' }, ancestors: [{ id: parentId }] } : { spaceId: '1', parentId }),
    body: { storage: { value, representation: 'storage' } },
  });
  const history = new Map([[baselineVersion, rawPage(storage, baselineVersion)]]);
  const state = { page: rawPage(current, version), property: null, labels: ['remote-label'], attachments: [], mode: null, applied: 0, postreads: 0, gate: null, responseGate: null };
  state.currentReads = 0;
  state.currentGates = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const body = text && req.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text || null;
    requests.push({ method: req.method, path: url.pathname, query: url.search, body });
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    const authorization = dc ? 'Bearer fixture-pat' : 'Basic ' + Buffer.from('fixture@example.test:fixture-pat').toString('base64');
    if (req.headers.authorization !== authorization) return send(401, {});
    if (url.pathname === prefix + (dc ? '/space/TEST' : '/spaces')) {
      return send(200, dc ? { id: '1', key: 'TEST' } : { results: [{ id: '1', key: 'TEST' }] });
    }
    const rootPath = prefix + (dc ? '/content/5' : '/pages/5');
    if (req.method === 'GET' && url.pathname === rootPath) {
      return send(200, {
        ...rawPage('<p>Fixture wiki root</p>', 1), id: '5', title: 'Fixture Wiki',
        ...(dc ? { ancestors: [] } : { parentId: null }),
      });
    }
    if (req.method === 'GET' && url.pathname === rootPath + (dc ? '/property/cfwiki-root' : '/properties')) {
      const marker = { key: 'cfwiki-root', value: {
        schema: 1, pageId: '5', spaceId: '1', spaceKey: 'TEST', topic: 'Fixture',
        tenant: { deployment, siteUrl: api.config.siteUrl, apiUrl: api.config.apiUrl },
      } };
      return send(200, dc ? marker : { results: [marker] });
    }
    if (url.pathname === prefix + (dc ? '/content' : '/pages') && req.method === 'POST') {
      state.page = { ...rawPage(dc ? body.body.storage.value : body.body.value, 1), title: body.title };
      state.applied++;
      events.emit('created');
      if (state.responseGate) await state.responseGate.promise;
      if (state.mode === 'lost-create') { req.socket.destroy(); return; }
      return send(200, state.page);
    }
    if (url.pathname === pagePath) {
      if (req.method === 'GET') {
        const requested = url.searchParams.get('version');
        if (requested) {
          events.emit('historical-read');
          if (state.historyGate) await state.historyGate.promise;
          const page = history.get(Number(requested));
          return page ? send(200, { ...page, status: 'historical' }) : send(404, {});
        }
        const gate = state.currentGates.get(++state.currentReads);
        if (gate) {
          events.emit('gated-current', state.currentReads);
          await gate.promise;
        }
        if (state.readStatus) return send(state.readStatus, {});
        if (state.mode === 'postread-failure' && state.applied) return send(404, {});
        if (state.applied && ++state.postreads > 1 && state.mode === 'verification-conflict') return send(409, {});
        return send(200, state.page);
      }
      if (req.method === 'PUT') {
        events.emit('put', body);
        if (state.gate) await state.gate.promise;
        if (body.version.number !== state.page.version.number + 1) return send(409, {});
        if (state.mode === 'http-failure') return send(500, {});
        if (state.mode === 'lost-before-commit' || state.mode === 'lost-always-before-commit') {
          if (state.mode === 'lost-before-commit') state.mode = null;
          events.emit('lost-before-commit');
          if (state.responseGate) await state.responseGate.promise;
          req.socket.destroy();
          return;
        }
        const updated = {
          ...state.page, ...body,
          ...(dc ? { space: state.page.space } : {}),
          body: { storage: { value: dc ? body.body.storage.value : body.body.value, representation: 'storage' } },
        };
        if (state.mode !== 'false-success') {
          state.page = updated;
          state.applied++;
        }
        if (state.mode === 'changed-storage') state.page.body.storage.value = '<p>Unexpected server body</p>';
        if (state.normalizeStorage) state.page.body.storage.value = state.normalizeStorage(state.page.body.storage.value);
        if (state.mode === 'property-race') {
          state.property = { id: 'property-1', key: 'confluence-wiki-md', version: { number: 2 }, value: { metadata: { owner: 'competing owner' } } };
        }
        events.emit('applied', updated);
        if (state.responseGate) await state.responseGate.promise;
        if (state.mode === 'lost-response') { req.socket.destroy(); return; }
        return send(200, state.mode === 'wrong-id' ? { ...updated, id: '99' } : updated);
      }
    }
    const propertyPath = pagePath + (dc ? '/property' : '/properties');
    if (url.pathname === propertyPath || url.pathname.startsWith(propertyPath + '/')) {
      if (req.method === 'GET') {
        return dc
          ? (state.property ? send(200, state.property) : send(404, {}))
          : send(200, { results: state.property ? [state.property] : [] });
      }
      events.emit('property-write', body);
      if (state.propertyGate) await state.propertyGate.promise;
      if (state.mode === 'property-failure') return send(500, {});
      if (state.property && body.version?.number !== state.property.version.number + 1) return send(409, {});
      state.property = { ...body, id: 'property-1', version: body.version ?? { number: 1 } };
      return send(200, state.property);
    }
    const v1Page = (dc ? '/confluence' : '/wiki') + '/rest/api/content/42';
    if (url.pathname === pagePath + (dc ? '/label' : '/labels') && req.method === 'GET') {
      return send(200, { results: state.labels.map((name) => ({ name })) });
    }
    if (url.pathname === v1Page + '/label') {
      if (state.mode === 'labels-failure') return send(500, {});
      if (req.method === 'POST') state.labels.push(...body.map((item) => item.name));
      if (req.method === 'DELETE') state.labels = state.labels.filter((name) => name !== url.searchParams.get('name'));
      return send(200, {});
    }
    if (url.pathname === pagePath + (dc ? '/child/attachment' : '/attachments') && req.method === 'GET') {
      return send(200, { results: state.attachments });
    }
    if (url.pathname === v1Page + '/child/attachment') {
      if (state.mode === 'attachments-failure') return send(500, {});
      state.attachments.push({ id: '123', title: 'image.svg' });
      return send(200, { results: state.attachments });
    }
    return send(404, {});
  });
  t.after(async () => {
    state.gate?.resolve();
    state.responseGate?.resolve();
    state.propertyGate?.resolve();
    state.historyGate?.resolve();
    for (const gate of state.currentGates.values()) gate.resolve();
    try {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      assert.equal(server.listening, false);
    } finally {
      if (originalTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmp;
      await rm(directory, { recursive: true, force: true });
      await assert.rejects(access(directory), { code: 'ENOENT' });
    }
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const origin = 'http://127.0.0.1:' + server.address().port;
  const api = new ConfluenceApi(readWikiConfig({
    CONFLUENCE_SITE_URL: origin + (dc ? '/confluence' : ''),
    CONFLUENCE_DEPLOYMENT: deployment,
    CONFLUENCE_PAT: 'fixture-pat',
    CONFLUENCE_EMAIL: 'fixture@example.test',
    CONFLUENCE_SPACE_KEY: 'TEST',
    CONFLUENCE_ALLOW_HTTP: 'true',
  }));
  const converted = storageToMarkdown(storage, {
    pageUrl: api.pageUrl('42'), siteUrl: api.config.webBase, pageId: '42', preserve: 'all',
  });
  const base = {
    metadata: {
      type: 'Reference', title: 'Page',
      confluence: {
        deployment, api_url: api.config.apiUrl, site_url: api.config.siteUrl,
        id: '42', version: baselineVersion, space: 'TEST', parent_id: parentId,
        storage_hash: hash(storage), base_body_hash: bodyHash(converted.markdown), preserved: converted.preserved,
      },
    },
    body: converted.markdown,
  };
  const draft = structuredClone(base);
  draft.body = draft.body.replace('First original', 'First local');
  const files = [path.join(directory, 'base.md'), path.join(directory, 'draft.md')];
  const invoke = async (baseDoc = base, draftDoc = draft, options = { space: 'TEST' }) => {
    const sources = [formatDocument(baseDoc), formatDocument(draftDoc)];
    await Promise.all(files.map((file, index) => writeFile(file, sources[index])));
    const config = structuredClone(api.config);
    try {
      return await applyAgentEdit(api, await readFile(files[0], 'utf8'), await readFile(files[1], 'utf8'), options);
    } finally {
      assert.deepEqual(await Promise.all(files.map((file) => readFile(file, 'utf8'))), sources);
      assert.equal((await readdir(directory)).some((name) => name.startsWith('cfwiki-agent-edit-')), false);
      assert.deepEqual(api.config, config);
    }
  };
  const cli = async (...args) => {
    const profile = path.join(directory, 'profile.env');
    await writeFile(profile, [
      'CONFLUENCE_SITE_URL=' + api.config.siteUrl,
      'CONFLUENCE_DEPLOYMENT=' + deployment,
      'CONFLUENCE_PAT=fixture-pat',
      'CONFLUENCE_EMAIL=fixture@example.test',
      'CONFLUENCE_SPACE_KEY=TEST',
      'CONFLUENCE_ALLOW_HTTP=true',
    ].join('\n'));
    try {
      const result = await promisify(execFile)(process.execPath, [path.resolve('scripts/confluence.mjs'), ...args, '--env', profile, ...(args[0] === 'download' ? [] : ['--json'])], { timeout: 10000 });
      return { ...result, code: 0 };
    } catch (error) {
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
  };
  return { api, base, draft, state, history, requests, events, invoke, pagePath, files, directory, cli };
}

const puts = (f) => f.requests.filter((r) => r.method === 'PUT' && r.path === f.pagePath);
const assertNoWrite = (f, before) => {
  assert.equal(puts(f).length, 0);
  assert.equal(f.state.applied, 0);
  assert.deepEqual(f.state.page, before);
};

for (const deployment of ['cloud', 'datacenter']) {
  for (const lost of [false, true]) {
    test('CLI layout preserves minimal and all baselines through apply: response lost ' + lost + ' - ' + deployment, { timeout: 15000 }, async (t) => {
      const fragment = "<ac:structured-macro ac:name='jira' ac:macro-id='raw'><ac:parameter ac:name='key'>DOC-&#49;</ac:parameter></ac:structured-macro>";
      const layout = "<ac:layout><ac:layout-section ac:type='single'><ac:layout-cell>" + fragment + '</ac:layout-cell></ac:layout-section></ac:layout>';
      const storage = baseStorage + layout;
      assert.equal(hash(layout), '4f3df708473b50dfb71a8ba28d5301875e47d4ccbf882350ed1746ce8cd45523');
      assert.equal(hash(storage), 'b347c9ae22f8d6c876ded16a2cdbef9603d5c9c20f6de8032e9437672fcb8d93');
      const f = await serverFixture(t, deployment, { current: baseStorage, version: 1, baselineVersion: 1 });
      f.state.page.body.storage.value = storage;
      f.history.get(1).body.storage.value = storage;
      const minimal = await f.cli('download', '42', '--output', f.files[0]);
      assert.equal(f.requests.length, 3);
      const all = await f.cli('download', '42', '--output', f.files[1], '--preserve', 'all');
      assert.equal(f.requests.length, 6);
      assert.equal(all.code, 0, all.stderr);
      const source = await readFile(f.files[1], 'utf8');
      const fragments = parseDocument(source).metadata.confluence.preserved.map((item) => item.storage);
      const edited = path.join(f.directory, 'edited.md');
      const draft = source.replace('First original', 'First local');
      await writeFile(edited, draft);
      f.state.mode = lost ? 'lost-response' : null;
      const start = f.requests.length;
      const applied = await f.cli('apply', edited, '--base', f.files[1], '--wiki-root', '5', '--space', 'TEST');
      assert.ok(applied.stdout, applied.stderr);
      const outcome = JSON.parse(applied.stdout);
      const methods = Object.fromEntries(['GET', 'PUT', 'POST', 'DELETE'].map((method) =>
        [method, f.requests.slice(start).filter((request) => request.method === method).length]));
      t.diagnostic(JSON.stringify({ deployment, lost, minimalExit: minimal.code, allExit: all.code,
        preserved: fragments.length, applyExit: applied.code, outcome: outcome.status, methods,
        originalHash: hash(storage), persistedHash: hash(f.state.page.body.storage.value) }));
      assert.equal(minimal.code, 0, minimal.stderr);
      assert.deepEqual(fragments, [fragment]);
      assert.equal(await readFile(f.files[0], 'utf8'), source);
      assert.equal(await readFile(f.files[1], 'utf8'), source);
      assert.equal(await readFile(edited, 'utf8'), draft);
      assert.equal(applied.code, 0, applied.stdout);
      assert.equal(outcome.status, 'success');
      assert.equal(outcome.resources.page.status, lost ? 'reconciled' : 'saved');
      assert.equal(f.state.page.version.number, 2);
      assert.equal(f.state.applied, 1);
      assert.equal(f.state.page.body.storage.value.split(fragment).length - 1, 1);
      assert.match(f.state.page.body.storage.value, /First local/);
      assert.doesNotThrow(() => loadStorageXml(f.state.page.body.storage.value));
      assert.deepEqual(methods, { GET: lost ? 23 : 21, PUT: 1, POST: 0, DELETE: 0 });
    });
  }

  for (const lost of [false, true]) {
    test('CLI native baseline refuses original parser loss before publication: response lost ' + lost + ' - ' + deployment, { timeout: 15000 }, async (t) => {
      const f = await serverFixture(t, deployment, { current: baseStorage, version: 1, baselineVersion: 1 });
      const originalNative = native.replace('ac:name="key"', 'ac:name="key" __proto__="keep-native-attribute"');
      const originalStorage = baseStorage + originalNative;
      f.state.page.body.storage.value = originalStorage;
      f.history.get(1).body.storage.value = originalStorage;
      f.state.mode = lost ? 'lost-response' : null;
      const before = structuredClone(f.state.page);
      const downloaded = await f.cli('download', '42', '--output', f.files[0]);
      let outcome;
      if (downloaded.code === 0) {
        const source = await readFile(f.files[0], 'utf8');
        const draft = source.replace('First original', 'First local');
        await writeFile(f.files[1], draft);
        const applied = await f.cli('apply', f.files[1], '--base', f.files[0], '--wiki-root', '5', '--space', 'TEST');
        outcome = JSON.parse(applied.stdout);
        assert.deepEqual(await Promise.all(f.files.map((file) => readFile(file, 'utf8'))), [source, draft]);
      }
      const submitted = puts(f)[0]?.body;
      const storage = submitted && (deployment === 'cloud' ? submitted.body.value : submitted.body.storage.value);
      assert.equal(hash(originalStorage), '756fc2bf5cb0ad3877b2643b3247dbdfcf3f6d00a4a1096c3241cbc5f4966b94');
      if (storage) assert.equal(hash(storage), '4447531e95cf40b501a0609047d5db91ffd38c2c97513669ca871bf49ca747b0');
      t.diagnostic(JSON.stringify({ deployment, lost, downloadExit: downloaded.code, outcome, puts: puts(f).length,
        nativeKept: f.state.page.body.storage.value.includes(originalNative), submittedHash: storage && hash(storage) }));
      assert.equal(downloaded.code, 1, JSON.stringify(outcome));
      assert.match(downloaded.stderr, /without losing/i);
      assert.equal(downloaded.stdout, '');
      await assert.rejects(access(f.files[0]), { code: 'ENOENT' });
      assertNoWrite(f, before);
      assert.equal(f.requests.length, 3);
      assert.ok(f.requests.every((request) => request.method === 'GET'));
    });

    test('CLI native baseline preserves original quote and entity bytes: response lost ' + lost + ' - ' + deployment, { timeout: 15000 }, async (t) => {
      const originalNative = "<ac:structured-macro ac:name='jira' ac:macro-id='raw'><ac:parameter ac:name='key'>DOC-&#49;</ac:parameter></ac:structured-macro>";
      const storage = baseStorage + originalNative;
      const f = await serverFixture(t, deployment, { storage, current: storage, version: 1, baselineVersion: 1 });
      assert.equal((await f.cli('download', '42', '--output', f.files[0])).code, 0);
      const source = await readFile(f.files[0], 'utf8');
      assert.equal(parseDocument(source).metadata.confluence.preserved[0].storage, originalNative);
      const draft = source.replace('First original', 'First local');
      await writeFile(f.files[1], draft);
      f.state.mode = lost ? 'lost-response' : null;
      const start = f.requests.length;
      const result = await f.cli('apply', f.files[1], '--base', f.files[0], '--wiki-root', '5', '--space', 'TEST');
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const outcome = JSON.parse(result.stdout);
      assert.equal(outcome.status, 'success');
      assert.equal(outcome.resources.page.status, lost ? 'reconciled' : 'saved');
      assert.equal(puts(f).length, 1);
      assert.equal(f.state.applied, 1);
      assert.equal(f.state.page.body.storage.value.split(originalNative).length - 1, 1);
      assert.deepEqual(await Promise.all(f.files.map((file) => readFile(file, 'utf8'))), [source, draft]);
      assert.equal(f.requests.slice(start).filter((request) => request.method === 'GET').length, lost ? 23 : 21);
      assert.ok(f.requests.filter((request) => request.method !== 'GET').every((request) => request.path === f.pagePath && request.method === 'PUT'));
    });
  }

  for (const cached of [false, true]) {
    test('generic download refuses original parser loss before cached preservation: ' + cached + ' - ' + deployment, async (t) => {
      const f = await serverFixture(t, deployment, { current: baseStorage, version: 1, baselineVersion: 1 });
      const storage = baseStorage + native.replace('ac:name="key"', 'ac:name="key" __proto__="keep-native-attribute"');
      f.state.page.body.storage.value = storage;
      if (cached) f.state.property = { id: 'property-1', key: 'confluence-wiki-md', version: { number: 1 }, value: {
        pageVersion: 1, source: { storageHash: hash(storage), gzip: gzipSync(JSON.stringify({ body: f.base.body, preserved: [] })).toString('base64') },
      } };
      const before = structuredClone(f.state.page);
      await assert.rejects(download(f.api, '42'), /without losing/i);
      assertNoWrite(f, before);
      assert.equal(f.requests.length, 3);
      assert.ok(f.requests.every((request) => request.method === 'GET'));
    });
  }

  for (const side of ['historical', 'current']) {
    test('agent native trust refuses ' + side + ' parser loss before PUT - ' + deployment, async (t) => {
      const safe = baseStorage + native;
      const unsafe = safe.replace('ac:name="key"', 'ac:name="key" __proto__="keep-native-attribute"');
      const f = await serverFixture(t, deployment, { storage: safe, current: safe, version: 2, baselineVersion: 1 });
      if (side === 'historical') {
        f.history.get(1).body.storage.value = unsafe;
        f.base.metadata.confluence.storage_hash = hash(unsafe);
        f.draft.metadata.confluence.storage_hash = hash(unsafe);
      } else f.state.page.body.storage.value = unsafe;
      const before = structuredClone(f.state.page);
      const result = await f.invoke(f.base, f.draft, { space: 'TEST', wikiRoot: '5' });
      assert.equal(result.status, 'conflict', JSON.stringify(result));
      assert.equal(result.conflicts[0].code, 'validation');
      assertNoWrite(f, before);
      assert.equal(f.requests.length, side === 'historical' ? 2 : 4);
      assert.ok(f.requests.every((request) => request.method === 'GET'));
    });
  }

  for (const scenario of ['downloaded-baseline', 'normalized-storage', 'both']) {
    test('CLI F3 applies ' + scenario + ' from v1 - ' + deployment, { timeout: 15000 }, async (t) => {
      const f = await serverFixture(t, deployment, { current: baseStorage, version: 1, baselineVersion: 1 });
      if (scenario !== 'normalized-storage') {
        // createTerm stores content without its final newline in the OKF source.
        const body = f.base.body.slice(0, -1);
        f.state.property = { id: 'property-1', key: 'confluence-wiki-md', version: { number: 1 }, value: {
          pageVersion: 1, metadata: { type: 'DefinedTerm', title: 'Page' },
          source: { storageHash: hash(baseStorage), gzip: gzipSync(JSON.stringify({ body, preserved: [] })).toString('base64') },
        } };
      }
      const downloaded = await f.cli('download', '42', '--output', f.files[0]);
      assert.equal(downloaded.code, 0, downloaded.stderr);
      assert.equal(downloaded.stdout, '');
      assert.equal(f.requests.length, 3);
      const baseline = await readFile(f.files[0], 'utf8');
      const doc = parseDocument(baseline);
      assert.equal(doc.body, scenario === 'normalized-storage' ? f.base.body : f.base.body.slice(0, -1));
      assert.equal(doc.metadata.confluence.base_body_hash, bodyHash(doc.body));
      const draft = formatDocument({ ...doc, body: doc.body.replace('First original', 'First local') });
      await writeFile(f.files[1], draft);
      if (scenario !== 'downloaded-baseline') f.state.normalizeStorage = (storage) => storage.replaceAll('</p>\n<p>', '</p><p>');
      const start = f.requests.length;
      const result = await f.cli('apply', f.files[1], '--base', f.files[0], '--wiki-root', '5', '--space', 'TEST');
      assert.ok(result.stdout, result.stderr);
      const outcome = JSON.parse(result.stdout);
      const counts = Object.fromEntries(['GET', 'PUT', 'POST', 'DELETE'].map((method) => [method, f.requests.slice(start).filter((r) => r.method === method).length]));
      t.diagnostic(JSON.stringify({
        scenario, deployment, code: result.code, outcome, counts,
        downloadedBody: { length: doc.body.length, hash: bodyHash(doc.body) },
        historicalBody: { length: f.base.body.length, hash: bodyHash(f.base.body) },
        submittedHash: puts(f).length ? hash(deployment === 'cloud' ? puts(f)[0].body.body.value : puts(f)[0].body.body.storage.value) : null,
        persistedHash: hash(f.state.page.body.storage.value),
      }));
      assert.deepEqual(await Promise.all(f.files.map((file) => readFile(file, 'utf8'))), [baseline, draft]);
      assert.equal(result.code, 0, JSON.stringify(outcome));
      assert.equal(outcome.status, 'success');
      assert.equal(outcome.version, 2);
      assert.equal(outcome.resources.page.status, 'saved');
      assert.deepEqual(counts, { GET: 21, PUT: 1, POST: 0, DELETE: 0 });
      assert.equal(f.state.applied, 1);
      assert.equal(f.state.page.version.number, 2);
      assert.match(f.state.page.body.storage.value, /First local/);
      assert.match(f.state.page.body.storage.value, /Last original/);
    });
  }

  test('agent apply rejects same-version storage mutation before merge - ' + deployment, async (t) => {
    const f = await serverFixture(t, deployment, { version: 7 });
    const before = structuredClone(f.state.page);
    const result = await f.invoke();
    assert.equal(result.status, 'conflict', JSON.stringify(result));
    assert.equal(result.conflicts[0].code, 'version');
    assertNoWrite(f, before);
    assert.ok(f.requests.every((request) => request.method === 'GET'));
  });

  for (const overlap of [false, true]) {
    test('CLI F3 merges downloaded newline-free baseline without losing stale protection: ' + overlap + ' - ' + deployment, { timeout: 15000 }, async (t) => {
      const f = await serverFixture(t, deployment, { current: baseStorage, version: 7 });
      f.state.property = { id: 'property-1', key: 'confluence-wiki-md', version: { number: 1 }, value: {
        pageVersion: 7, metadata: { type: 'Reference', title: 'Page' },
        source: { storageHash: hash(baseStorage), gzip: gzipSync(JSON.stringify({ body: f.base.body.slice(0, -1), preserved: [] })).toString('base64') },
      } };
      assert.equal((await f.cli('download', '42', '--output', f.files[0])).code, 0);
      const source = await readFile(f.files[0], 'utf8');
      await writeFile(f.files[1], source.replace('First original', 'First local'));
      f.state.page.version.number = 8;
      f.state.page.body.storage.value = baseStorage.replace(overlap ? 'First original' : 'Last original', overlap ? 'First remote' : 'Last remote');
      const before = structuredClone(f.state.page);
      const result = await f.cli('apply', f.files[1], '--base', f.files[0], '--wiki-root', '5', '--space', 'TEST');
      assert.ok(result.stdout, result.stderr);
      const outcome = JSON.parse(result.stdout);
      assert.equal(result.code, overlap ? 1 : 0, result.stdout);
      assert.equal(outcome.status, overlap ? 'conflict' : 'success');
      if (overlap) {
        assert.ok(outcome.conflicts.some((conflict) => conflict.code === 'overlap'));
        assertNoWrite(f, before);
      } else {
        assert.equal(outcome.version, 9);
        assert.equal(puts(f).length, 1);
        assert.match(f.state.page.body.storage.value, /First local/);
        assert.match(f.state.page.body.storage.value, /Last remote/);
      }
      assert.equal(await readFile(f.files[0], 'utf8'), source);
    });
  }

  const richStorage = baseStorage.replace('Middle unchanged', '<strong>Middle unchanged</strong> <a href="https://example.test" title="target">link &amp; label</a>') + native;
  const normalizeStorage = (storage) => storage.replaceAll('>\n<', '><')
    .replace('href="https://example.test" title="target"', 'title="target" href="https://example.test"')
    .replace('link &amp; label', 'link &#38; label');
  for (const lost of [false, true]) {
    for (const scenario of ['NBSP-closing-tag', 'extra-ordinary-attribute']) {
      test('CLI F3 rejects lexical parser mismatch: ' + scenario + ', response lost ' + lost + ' - ' + deployment, { timeout: 15000 }, async (t) => {
        const f = await serverFixture(t, deployment, { current: baseStorage, version: 1, baselineVersion: 1 });
        assert.equal((await f.cli('download', '42', '--output', f.files[0])).code, 0);
        assert.equal(f.requests.length, 3);
        const source = await readFile(f.files[0], 'utf8');
        const draft = source.replace('First original', 'First local');
        await writeFile(f.files[1], draft);
        f.state.mode = lost ? 'lost-response' : null;
        f.state.normalizeStorage = (storage) => scenario === 'NBSP-closing-tag'
          ? storage.replace(/<\/p>$/, '</p\u00a0>')
          : storage.replace('<p>Last original</p>', '<p __proto__="server-added">Last original</p>');
        const start = f.requests.length;
        const result = await f.cli('apply', f.files[1], '--base', f.files[0], '--wiki-root', '5', '--space', 'TEST');
        assert.ok(result.stdout, result.stderr);
        const outcome = JSON.parse(result.stdout);
        assert.equal(puts(f).length, 1);
        assert.equal(f.state.applied, 1);
        assert.equal(f.state.page.version.number, 2);
        const submitted = deployment === 'cloud' ? puts(f)[0].body.body.value : puts(f)[0].body.body.storage.value;
        assert.equal(hash(submitted), '5d9c8a2486a312d19486502f879c37a15eb23b8cdcfd15b42fac5580cfa7a8e4');
        assert.equal(hash(f.state.page.body.storage.value), scenario === 'NBSP-closing-tag'
          ? 'b4eb459a4f0f708a9613b54c849eb4ad4c98f08d2a63d3484a1d53ece8a2d56a'
          : '625ab1b9908a72b77e7131a76463207719952e68c03f09e92f97e16a2cc48e5a');
        assert.deepEqual(await Promise.all(f.files.map((file) => readFile(file, 'utf8'))), [source, draft]);
        const methods = Object.fromEntries(['GET', 'PUT', 'POST', 'DELETE'].map((method) =>
          [method, f.requests.slice(start).filter((request) => request.method === method).length]));
        t.diagnostic(JSON.stringify({ deployment, scenario, lost, exit: result.code, status: outcome.status, page: outcome.resources?.page, methods }));
        assert.equal(result.code, 1, result.stdout);
        assert.equal(outcome.status, 'partial');
        assert.equal(outcome.outcome, 'unresolved');
        assert.equal(outcome.resources.page.status, 'unresolved');
        assert.deepEqual(methods, { GET: 17, PUT: 1, POST: 0, DELETE: 0 });
      });
    }

    test('CLI F3 rejects changed XML attribute control reference: response lost ' + lost + ' - ' + deployment, { timeout: 15000 }, async (t) => {
      const f = await serverFixture(t, deployment, { current: baseStorage, version: 1, baselineVersion: 1 });
      assert.equal((await f.cli('download', '42', '--output', f.files[0])).code, 0);
      const source = await readFile(f.files[0], 'utf8');
      const draft = source.replace('First original', 'First local') +
        '\n<pre><a href="https://example.test" title="alpha\tbeta">label</a></pre>\n';
      await writeFile(f.files[1], draft);
      f.state.mode = lost ? 'lost-response' : null;
      f.state.normalizeStorage = (storage) => storage.replace('title="alpha\tbeta"', 'title="alpha&#9;beta"');
      const start = f.requests.length;
      const result = await f.cli('apply', f.files[1], '--base', f.files[0], '--wiki-root', '5', '--space', 'TEST');
      assert.ok(result.stdout, result.stderr);
      const outcome = JSON.parse(result.stdout);
      assert.equal(puts(f).length, 1);
      assert.equal(f.state.applied, 1);
      const submitted = deployment === 'cloud' ? puts(f)[0].body.body.value : puts(f)[0].body.body.storage.value;
      assert.equal(hash(submitted), '5ffc78a383144386c59d6780ed534e6202e0ebcf5ed0f5efd5b4f6eacfe7c581');
      assert.equal(hash(f.state.page.body.storage.value), 'df8fbcf5574e282a9f8e8e3116e7895117b11480eb24ca1900f5145dfb6ded0c');
      assert.deepEqual(await Promise.all(f.files.map((file) => readFile(file, 'utf8'))), [source, draft]);
      const methods = Object.fromEntries(['GET', 'PUT', 'POST', 'DELETE'].map((method) =>
        [method, f.requests.slice(start).filter((request) => request.method === method).length]));
      t.diagnostic(JSON.stringify({ deployment, lost, exit: result.code, status: outcome.status, page: outcome.resources?.page, methods }));
      assert.equal(result.code, 1, result.stdout);
      assert.equal(outcome.status, 'partial');
      assert.equal(outcome.outcome, 'unresolved');
      assert.equal(outcome.resources.page.status, 'unresolved');
      assert.deepEqual(methods, { GET: 17, PUT: 1, POST: 0, DELETE: 0 });
    });

    for (const [shape, subtree] of [
      ['reviewer', '<pre><blockquote><p>alpha</p> <p>beta</p></blockquote></pre>'],
      ['nested', '<pre><div><pre><blockquote><p>alpha</p> <p>beta</p></blockquote></pre></div></pre>'],
      ['escaped', '<pre><blockquote><p>&lt;alpha&gt; &amp; &#32;</p> <p>beta</p></blockquote></pre>'],
    ]) {
      test('CLI F3 rejects changed inherited pre whitespace: ' + shape + ', response lost ' + lost + ' - ' + deployment, { timeout: 15000 }, async (t) => {
        const f = await serverFixture(t, deployment, { current: baseStorage, version: 1, baselineVersion: 1 });
        assert.equal((await f.cli('download', '42', '--output', f.files[0])).code, 0);
        const source = await readFile(f.files[0], 'utf8');
        const draft = source.replace('First original', 'First local') + '\n' + subtree + '\n';
        await writeFile(f.files[1], draft);
        f.state.mode = lost ? 'lost-response' : null;
        f.state.normalizeStorage = (storage) => storage.replace('</p> <p>beta</p>', '</p><p>beta</p>');
        const start = f.requests.length;
        const result = await f.cli('apply', f.files[1], '--base', f.files[0], '--wiki-root', '5', '--space', 'TEST');
        assert.ok(result.stdout, result.stderr);
        const outcome = JSON.parse(result.stdout);
        assert.equal(puts(f).length, 1);
        assert.equal(f.state.applied, 1);
        const submitted = deployment === 'cloud' ? puts(f)[0].body.body.value : puts(f)[0].body.body.storage.value;
        assert.ok(submitted.includes('</p> <p>beta</p>'));
        assert.equal(f.state.page.body.storage.value, submitted.replace('</p> <p>beta</p>', '</p><p>beta</p>'));
        if (shape === 'reviewer') {
          assert.equal(hash(submitted), 'a2a4e7226280372f5a9fd0110707135c09f52b4e51fac2da9329f6c176fc0e61');
          assert.equal(hash(f.state.page.body.storage.value), 'd8424f5e384fcecda7df7b520edb0d71ebbb127f821000a4ad9e08d9051fbbb3');
        }
        assert.deepEqual(await Promise.all(f.files.map((file) => readFile(file, 'utf8'))), [source, draft]);
        const methods = Object.fromEntries(['GET', 'PUT', 'POST', 'DELETE'].map((method) =>
          [method, f.requests.slice(start).filter((request) => request.method === method).length]));
        t.diagnostic(JSON.stringify({ deployment, shape, lost, exit: result.code, status: outcome.status, page: outcome.resources?.page, methods }));
        assert.equal(result.code, 1, result.stdout);
        assert.equal(outcome.status, 'partial');
        assert.equal(outcome.outcome, 'unresolved');
        assert.equal(outcome.resources.page.status, 'unresolved');
        assert.deepEqual(methods, { GET: 17, PUT: 1, POST: 0, DELETE: 0 });
      });
    }

    test('CLI F3 confirms normalized storage with exact native XML: response lost ' + lost + ' - ' + deployment, { timeout: 15000 }, async (t) => {
      const f = await serverFixture(t, deployment, { storage: richStorage, current: richStorage, version: 1, baselineVersion: 1 });
      assert.equal((await f.cli('download', '42', '--output', f.files[0])).code, 0);
      const source = await readFile(f.files[0], 'utf8');
      await writeFile(f.files[1], source.replace('First original', 'First local'));
      f.state.normalizeStorage = normalizeStorage;
      f.state.mode = lost ? 'lost-response' : null;
      const start = f.requests.length;
      const result = await f.cli('apply', f.files[1], '--base', f.files[0], '--wiki-root', '5', '--space', 'TEST');
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const outcome = JSON.parse(result.stdout);
      assert.equal(outcome.status, 'success');
      assert.equal(outcome.version, 2);
      assert.equal(outcome.resources.page.status, lost ? 'reconciled' : 'saved');
      if (lost) assert.equal(outcome.resources.page.authorship, 'unknown');
      assert.equal(f.state.applied, 1);
      assert.equal(puts(f).length, 1);
      assert.equal(f.state.page.body.storage.value.split(native).length - 1, 1);
      assert.equal(f.requests.slice(start).filter((r) => r.method === 'GET').length, lost ? 23 : 21);
      assert.ok(f.requests.filter((r) => r.method !== 'GET').every((r) => r.method === 'PUT' && r.path === f.pagePath));
      const submitted = deployment === 'cloud' ? puts(f)[0].body.body.value : puts(f)[0].body.body.storage.value;
      assert.notEqual(hash(submitted), hash(f.state.page.body.storage.value));
      assert.equal(await readFile(f.files[0], 'utf8'), source);
    });

    test('CLI F3 rejects another same-version normalization after confirmation: response lost ' + lost + ' - ' + deployment, { timeout: 15000 }, async (t) => {
      const f = await serverFixture(t, deployment, { current: baseStorage, version: 1, baselineVersion: 1 });
      assert.equal((await f.cli('download', '42', '--output', f.files[0])).code, 0);
      const source = await readFile(f.files[0], 'utf8');
      await writeFile(f.files[1], source.replace('First original', 'First local'));
      f.state.normalizeStorage = normalizeStorage;
      f.state.mode = lost ? 'lost-response' : null;
      const gate = Promise.withResolvers();
      const readNumber = lost ? 8 : 7;
      f.state.currentGates.set(readNumber, gate);
      const reached = once(f.events, 'gated-current', { signal: AbortSignal.timeout(5000) });
      const pending = f.cli('apply', f.files[1], '--base', f.files[0], '--wiki-root', '5', '--space', 'TEST');
      assert.deepEqual(await reached, [readNumber]);
      f.state.page.body.storage.value = f.state.page.body.storage.value.replaceAll('</p><p>', '</p>\n<p>');
      const changed = structuredClone(f.state.page);
      gate.resolve();
      const result = await pending;
      assert.equal(result.code, 1, result.stdout + result.stderr);
      const outcome = JSON.parse(result.stdout);
      assert.equal(outcome.status, 'partial');
      assert.equal(outcome.resources.page.status, 'unresolved');
      assert.equal(puts(f).length, 1);
      assert.equal(f.state.applied, 1);
      assert.deepEqual(f.state.page, changed);
    });

    for (const change of ['body', 'native-parameter', 'native-attributes', 'missing-native', 'duplicate-native', 'link', 'structure', 'inline-space', 'missing-storage', 'version', 'space', 'root', 'status']) {
      test('agent normalized confirmation refuses ' + change + ', response lost ' + lost + ' - ' + deployment, { timeout: 10000 }, async (t) => {
        const f = await serverFixture(t, deployment, { storage: richStorage, current: richStorage, version: 7 });
        f.state.normalizeStorage = normalizeStorage;
        f.state.mode = lost ? 'lost-response' : null;
        f.state.responseGate = Promise.withResolvers();
        const reached = once(f.events, 'applied', { signal: AbortSignal.timeout(5000) });
        const pending = f.invoke(f.base, f.draft, { space: 'TEST', wikiRoot: '5' });
        await reached;
        const body = f.state.page.body.storage;
        if (change === 'body') body.value = body.value.replace('Last original', 'Concurrent edit');
        if (change === 'native-parameter') body.value = body.value.replace('DOC-1', 'DOC-2');
        if (change === 'native-attributes') body.value = body.value.replace('ac:name="jira" ac:macro-id="stable"', 'ac:macro-id="stable" ac:name="jira"');
        if (change === 'missing-native') body.value = body.value.replace(native, '');
        if (change === 'duplicate-native') body.value += native;
        if (change === 'link') body.value = body.value.replace('https://example.test', 'https://foreign.test');
        if (change === 'structure') body.value = body.value.replace('<strong>', '<em>').replace('</strong>', '</em>');
        if (change === 'inline-space') body.value = body.value.replace('</strong> <a', '</strong><a');
        if (change === 'missing-storage') delete f.state.page.body.storage;
        if (change === 'version') f.state.page.version.number++;
        if (change === 'space') {
          if (deployment === 'cloud') f.state.page.spaceId = '2';
          else f.state.page.space = { id: '2', key: 'OTHER' };
        }
        if (change === 'root') {
          if (deployment === 'cloud') f.state.page.parentId = '800';
          else f.state.page.ancestors = [{ id: '800' }];
        }
        if (change === 'status') f.state.page.status = 'trashed';
        const changed = structuredClone(f.state.page);
        f.state.responseGate.resolve();
        const result = await pending;
        assert.equal(result.status, 'partial', JSON.stringify(result));
        assert.equal(result.outcome, 'unresolved');
        assert.equal(result.resources.page.status, 'unresolved');
        assert.equal(result.document, undefined);
        assert.equal(f.state.applied, 1);
        assert.equal(puts(f).length, 1);
        // An accepted response exposing the wrong version fails before readback.
        assert.equal(f.requests.filter((r) => r.method === 'GET').length, change === 'version' && !lost ? 10 : 12);
        assert.ok(f.requests.filter((r) => r.method !== 'GET').every((r) => r.method === 'PUT' && r.path === f.pagePath));
        assert.deepEqual(f.state.page, changed);
      });
    }
  }

  test('agent normalized recovery never replays a same-version changed base - ' + deployment, { timeout: 10000 }, async (t) => {
    const f = await serverFixture(t, deployment);
    f.state.mode = 'lost-before-commit';
    f.state.responseGate = Promise.withResolvers();
    const reached = once(f.events, 'lost-before-commit', { signal: AbortSignal.timeout(5000) });
    const pending = f.invoke(f.base, f.draft, { space: 'TEST', wikiRoot: '5' });
    await reached;
    f.state.page.body.storage.value = f.state.page.body.storage.value.replaceAll('</p><p>', '</p>\n<p>');
    const changed = structuredClone(f.state.page);
    f.state.responseGate.resolve();
    const result = await pending;
    assert.equal(result.status, 'partial', JSON.stringify(result));
    assert.equal(result.resources.page.status, 'unresolved');
    assert.equal(puts(f).length, 1);
    assert.equal(f.state.applied, 0);
    assert.deepEqual(f.state.page, changed);
    assert.equal(f.requests.filter((r) => r.method === 'GET').length, 12);
    assert.ok(f.requests.filter((r) => r.method !== 'GET').every((r) => r.method === 'PUT' && r.path === f.pagePath));
  });

  test('rooted agent apply rejects reparenting after caller root check - ' + deployment, { timeout: 10000 }, async (t) => {
    const f = await serverFixture(t, deployment, { parentId: '101' });
    assert.equal((await f.api.getPage('42')).parentId, '101');
    f.state.historyGate = Promise.withResolvers();
    const reached = once(f.events, 'historical-read', { signal: AbortSignal.timeout(5000) });
    const pending = f.invoke(f.base, f.draft, { space: 'TEST', wikiRoot: '101' });
    await reached;
    if (deployment === 'cloud') f.state.page.parentId = '800';
    else f.state.page.ancestors = [{ id: '800' }];
    f.state.page.version.number = 9;
    f.state.page.body.storage.value = remoteStorage.replace('Last remote', 'Sensitive moved page');
    const moved = structuredClone(f.state.page);
    f.state.historyGate.resolve();
    const result = await pending;
    assert.equal(result.status, 'conflict', JSON.stringify(result));
    assert.equal(result.conflicts[0].code, 'wiki_root');
    assertNoWrite(f, moved);
    assert.ok(f.requests.every((request) => request.method === 'GET'));
    assert.doesNotMatch(JSON.stringify(result), /Sensitive moved page|First local/);
  });

  for (const mode of [null, 'lost-response', 'lost-before-commit']) {
    test('rooted agent apply retains allowed parent through publication and recovery: ' + mode + ' - ' + deployment, { timeout: 10000 }, async (t) => {
      const f = await serverFixture(t, deployment, { parentId: '101' });
      f.state.mode = mode;
      if (mode === 'lost-response') f.draft.metadata.title = 'Rooted title';
      f.draft.metadata.confluence.parent_id = '800';
      f.draft.metadata.confluence.wikiRoot = '800';
      f.state.gate = Promise.withResolvers();
      const reached = once(f.events, 'put', { signal: AbortSignal.timeout(5000) });
      const pending = f.invoke(f.base, f.draft, { space: 'TEST', wikiRoot: 101 });
      await reached;
      f.state.gate.resolve();
      const result = await pending;
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(result.version, 9);
      assert.equal(result.document.metadata.confluence.parent_id, '101');
      assert.equal(result.resources.page.status, mode === 'lost-response' ? 'reconciled' : 'saved');
      assert.equal(result.resources.property.status, mode === 'lost-response' ? 'saved' : 'preserved');
      assert.equal(f.state.applied, 1);
      assert.equal(puts(f).length, mode === 'lost-before-commit' ? 2 : 1);
      assert.ok(puts(f).every((request) => (deployment === 'cloud' ? request.body.parentId : request.body.ancestors[0].id) === '101'));
      if (mode === 'lost-before-commit') assert.deepEqual(puts(f)[0].body, puts(f)[1].body);
    });
  }

  for (const readNumber of [2, 3]) {
    test('rooted agent apply rejects a moved last preflight snapshot: ' + readNumber + ' - ' + deployment, { timeout: 10000 }, async (t) => {
      const f = await serverFixture(t, deployment, { parentId: '101' });
      const gate = Promise.withResolvers();
      f.state.currentGates.set(readNumber, gate);
      const reached = once(f.events, 'gated-current', { signal: AbortSignal.timeout(5000) });
      const pending = f.invoke(f.base, f.draft, { space: 'TEST', wikiRoot: '101' });
      assert.deepEqual(await reached, [readNumber]);
      if (deployment === 'cloud') f.state.page.parentId = '800';
      else f.state.page.ancestors = [{ id: '800' }];
      f.state.page.version.number++;
      const moved = structuredClone(f.state.page);
      gate.resolve();
      const result = await pending;
      assert.equal(result.status, 'conflict', JSON.stringify(result));
      assert.equal(result.conflicts[0].code, 'wiki_root');
      assertNoWrite(f, moved);
      assert.ok(f.requests.every((request) => request.method === 'GET'));
    });
  }

  for (const atPut of [false, true]) {
    test('rooted agent apply rejects concurrent version races: ' + atPut + ' - ' + deployment, { timeout: 10000 }, async (t) => {
      const f = await serverFixture(t, deployment, { parentId: '101' });
      const gate = Promise.withResolvers();
      if (atPut) f.state.gate = gate;
      else f.state.currentGates.set(3, gate);
      const reached = once(f.events, atPut ? 'put' : 'gated-current', { signal: AbortSignal.timeout(5000) });
      const pending = f.invoke(f.base, f.draft, { space: 'TEST', wikiRoot: '101' });
      await reached;
      f.state.page.version.number++;
      f.state.page.body.storage.value = '<p>Competing writer keeps this body</p>';
      const remote = structuredClone(f.state.page);
      gate.resolve();
      const result = await pending;
      assert.equal(result.status, 'conflict', JSON.stringify(result));
      if (atPut) assert.equal(result.conflicts[0].code, 'version');
      assert.equal(puts(f).length, atPut ? 1 : 0);
      assert.equal(f.state.applied, 0);
      assert.deepEqual(f.state.page, remote);
      assert.ok(f.requests.filter((request) => request.path.includes('/propert')).every((request) => request.method === 'GET'));
    });
  }

  for (const mode of ['lost-before-commit', 'lost-response']) {
    test('rooted agent apply never retries or syncs after recovery sees reparenting: ' + mode + ' - ' + deployment, { timeout: 10000 }, async (t) => {
      const f = await serverFixture(t, deployment, { parentId: '101' });
      f.draft.metadata.title = 'Intended title';
      f.state.mode = mode;
      f.state.responseGate = Promise.withResolvers();
      const reached = once(f.events, mode === 'lost-response' ? 'applied' : 'lost-before-commit', { signal: AbortSignal.timeout(5000) });
      const pending = f.invoke(f.base, f.draft, { space: 'TEST', wikiRoot: '101' });
      await reached;
      if (deployment === 'cloud') f.state.page.parentId = '800';
      else f.state.page.ancestors = [{ id: '800' }];
      f.state.page.version.number++;
      const moved = structuredClone(f.state.page);
      f.state.responseGate.resolve();
      const result = await pending;
      assert.equal(result.status, 'partial', JSON.stringify(result));
      assert.equal(result.code, 'wiki_root');
      assert.equal(result.outcome, 'unresolved');
      assert.equal(result.resources.page.status, 'unresolved');
      assert.equal(result.document, undefined);
      assert.equal(puts(f).length, 1);
      assert.equal(f.state.applied, mode === 'lost-response' ? 1 : 0);
      assert.deepEqual(f.state.page, moved);
      assert.ok(f.requests.filter((request) => request.path.includes('/propert')).every((request) => request.method === 'GET'));
    });
  }

  test('rooted agent apply rejects moved state after a lost request replay - ' + deployment, { timeout: 10000 }, async (t) => {
    const f = await serverFixture(t, deployment, { parentId: '101' });
    f.state.mode = 'lost-before-commit';
    f.state.responseGate = Promise.withResolvers();
    const reachedLoss = once(f.events, 'lost-before-commit', { signal: AbortSignal.timeout(5000) });
    const pending = f.invoke(f.base, f.draft, { space: 'TEST', wikiRoot: '101' });
    await reachedLoss;
    f.state.gate = Promise.withResolvers();
    const reachedReplay = once(f.events, 'put', { signal: AbortSignal.timeout(5000) });
    f.state.responseGate.resolve();
    await reachedReplay;
    if (deployment === 'cloud') f.state.page.parentId = '800';
    else f.state.page.ancestors = [{ id: '800' }];
    f.state.page.version.number++;
    const moved = structuredClone(f.state.page);
    f.state.gate.resolve();
    const result = await pending;
    assert.equal(result.status, 'partial', JSON.stringify(result));
    assert.equal(result.code, 'wiki_root');
    assert.equal(result.resources.page.status, 'unresolved');
    assert.equal(puts(f).length, 2);
    assert.deepEqual(puts(f)[0].body, puts(f)[1].body);
    assert.equal(f.state.applied, 0);
    assert.deepEqual(f.state.page, moved);
    assert.ok(f.requests.filter((request) => request.path.includes('/propert')).every((request) => request.method === 'GET'));
  });

  test('rooted agent apply rechecks the root before changed title property writes - ' + deployment, { timeout: 10000 }, async (t) => {
    const f = await serverFixture(t, deployment, { parentId: '101' });
    f.draft.metadata.title = 'Intended title';
    const gate = Promise.withResolvers();
    f.state.currentGates.set(5, gate);
    const reached = once(f.events, 'gated-current', { signal: AbortSignal.timeout(5000) });
    const pending = f.invoke(f.base, f.draft, { space: 'TEST', wikiRoot: '101' });
    assert.deepEqual(await reached, [5]);
    if (deployment === 'cloud') f.state.page.parentId = '800';
    else f.state.page.ancestors = [{ id: '800' }];
    f.state.page.version.number++;
    const moved = structuredClone(f.state.page);
    gate.resolve();
    const result = await pending;
    assert.equal(result.status, 'partial', JSON.stringify(result));
    assert.equal(result.code, 'wiki_root');
    assert.equal(result.resources.page.status, 'unresolved');
    assert.equal(result.resources.property.status, 'failed');
    assert.equal(puts(f).length, 1);
    assert.equal(f.state.applied, 1);
    assert.deepEqual(f.state.page, moved);
    assert.ok(f.requests.filter((request) => request.path.includes('/propert')).every((request) => request.method === 'GET'));
  });

  for (const wikiRoot of ['', null, 'not-an-id', '42']) {
    test('rooted agent apply rejects invalid or self root: ' + wikiRoot + ' - ' + deployment, async (t) => {
      const f = await serverFixture(t, deployment);
      const before = structuredClone(f.state.page);
      const result = await f.invoke(f.base, f.draft, { space: 'TEST', wikiRoot });
      assert.equal(result.status, 'conflict');
      assert.equal(result.conflicts[0].code, 'wiki_root');
      assertNoWrite(f, before);
      assert.equal(f.requests.length, 0);
    });
  }

  test('unscoped agent apply still accepts the current parent - ' + deployment, async (t) => {
    const f = await serverFixture(t, deployment, { parentId: '101' });
    if (deployment === 'cloud') f.state.page.parentId = '800';
    else f.state.page.ancestors = [{ id: '800' }];
    f.state.page.version.number++;
    const result = await f.invoke();
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.document.metadata.confluence.parent_id, '800');
    assert.equal(result.version, 10);
    assert.equal(puts(f).length, 1);
  });

  test('agent apply reconciles lost update response - ' + deployment, { timeout: 10000 }, async (t) => {
    const f = await serverFixture(t, deployment);
    f.state.mode = 'lost-response';
    f.state.gate = Promise.withResolvers();
    const reachedPut = once(f.events, 'put', { signal: AbortSignal.timeout(5000) });
    const pending = f.invoke();
    await reachedPut;
    f.state.gate.resolve();
    const result = await pending;
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.resources.page.status, 'reconciled');
    assert.equal(result.resources.page.authorship, 'unknown');
    assert.equal(result.version, 9);
    assert.equal(f.state.applied, 1);
    assert.equal(puts(f).length, 1);
    assert.equal(f.state.page.version.number, 9);
    for (const resource of ['property', 'labels', 'attachments']) {
      assert.equal(result.resources[resource].status, 'preserved');
    }
    assert.ok(f.requests.filter((request) => request.method !== 'GET').every((request) => request.path === f.pagePath));
  });

  test('agent apply reconciles lost update response with changed title property - ' + deployment, { timeout: 10000 }, async (t) => {
    const f = await serverFixture(t, deployment);
    f.draft.metadata.title = 'Recovered title';
    f.state.property = { id: 'property-1', key: 'confluence-wiki-md', version: { number: 1 }, value: { metadata: { title: 'Page', owner: 'remote owner' } } };
    f.state.mode = 'lost-response';
    f.state.responseGate = Promise.withResolvers();
    const reached = once(f.events, 'applied', { signal: AbortSignal.timeout(5000) });
    const pending = f.invoke();
    await reached;
    f.state.responseGate.resolve();
    const result = await pending;
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.resources.page.status, 'reconciled');
    assert.equal(result.resources.page.authorship, 'unknown');
    assert.equal(result.resources.property.status, 'saved');
    assert.equal(result.resources.labels.status, 'preserved');
    assert.equal(result.resources.attachments.status, 'preserved');
    assert.equal(f.state.property.value.metadata.title, 'Recovered title');
    assert.equal(f.state.property.value.metadata.owner, 'remote owner');
    assert.equal(f.state.property.version.number, 2);
    assert.equal(f.state.page.version.number, 9);
    assert.equal(puts(f).length, 1);
  });

  test('agent apply merges disjoint concurrent page edits - ' + deployment, async (t) => {
    const f = await serverFixture(t, deployment);
    const result = await f.invoke();
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.version, 9);
    assert.equal(result.document.metadata.confluence.version, 9);
    assert.equal(result.document.metadata.confluence.storage_hash, hash(f.state.page.body.storage.value));
    assert.match(f.state.page.body.storage.value, /First local/);
    assert.match(f.state.page.body.storage.value, /Last remote/);
    assert.equal(f.state.page.version.number, 9);
    assert.equal(f.state.applied, 1);
    assert.equal(puts(f).length, 1);
    assert.equal(puts(f)[0].body.version.number, 9);
    const reads = f.requests.filter((r) => r.method === 'GET' && r.path === f.pagePath);
    assert.equal(new URLSearchParams(reads[0].query).get('version'), '7');
    assert.equal(new URLSearchParams(reads[1].query).has('version'), false);
    for (const read of reads) {
      const query = new URLSearchParams(read.query);
      assert.equal(deployment === 'cloud' ? query.get('body-format') : query.get('expand'),
        deployment === 'cloud' ? 'storage' : 'body.storage,version,space,ancestors');
    }
    const body = puts(f)[0].body;
    assert.equal(deployment === 'cloud' ? body.body.representation : body.body.storage.representation, 'storage');
    assert.equal(deployment === 'cloud' ? body.parentId : body.ancestors[0].id, '5');
    assert.ok(f.requests.every((r) => !(r.method === 'POST' && /\/(pages|content)$/.test(r.path))));
  });

  test('agent apply updates a current baseline once - ' + deployment, async (t) => {
    const f = await serverFixture(t, deployment, { current: baseStorage, version: 7 });
    const result = await f.invoke();
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.version, 8);
    assert.equal(puts(f).length, 1);
  });

  test('agent apply preserves remote storage over contradictory cache - ' + deployment, async (t) => {
    const f = await serverFixture(t, deployment);
    f.state.property = {
      id: 'property-1', version: { number: 1 }, key: 'confluence-wiki-md',
      value: {
        pageVersion: 8, metadata: { type: 'Playbook', owner: 'remote-owner', confluence: { id: '999' } },
        source: { storageHash: hash(remoteStorage), gzip: gzipSync(JSON.stringify({ body: 'CACHE LIES\n', preserved: [] })).toString('base64') },
      },
    };
    assert.equal((await download(f.api, '42')).body, 'CACHE LIES\n');
    f.requests.length = 0;
    const result = await f.invoke();
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.version, 9);
    assert.match(f.state.page.body.storage.value, /First local/);
    assert.match(f.state.page.body.storage.value, /Last remote/);
    assert.doesNotMatch(f.state.page.body.storage.value, /CACHE LIES/);
    assert.equal(f.state.property.value.metadata.owner, 'remote-owner');
    assert.equal(f.state.property.value.metadata.type, 'Playbook');
    assert.equal(result.document.metadata.confluence.id, '42');
    assert.equal(puts(f).length, 1);
  });

  test('agent apply rejects stale overlapping edits - ' + deployment, async (t) => {
    const f = await serverFixture(t, deployment, { current: baseStorage.replace('First original', 'First remote') });
    const before = structuredClone(f.state.page);
    const result = await f.invoke();
    assert.equal(result.status, 'conflict');
    assert.ok(result.conflicts.some((c) => c.kind === 'overlap'));
    assertNoWrite(f, before);
  });

  test('agent apply rejects unverified cached baseline - ' + deployment, async (t) => {
    const f = await serverFixture(t, deployment);
    const before = structuredClone(f.state.page);
    f.base.body = 'Invented cached baseline\n';
    f.base.metadata.confluence.base_body_hash = bodyHash(f.base.body);
    f.draft.body = 'Invented local edit\n';
    const result = await f.invoke();
    assert.equal(result.status, 'conflict');
    assert.equal(result.conflicts[0].code, 'unverified_baseline');
    assertNoWrite(f, before);
  });

  test('agent apply rejects a downloaded contradictory baseline before merge - ' + deployment, async (t) => {
    const f = await serverFixture(t, deployment);
    const remote = structuredClone(f.state.page);
    f.state.page = structuredClone(f.history.get(7));
    f.state.property = {
      id: 'property-1', version: { number: 1 }, key: 'confluence-wiki-md',
      value: {
        pageVersion: 7, metadata: { type: 'Reference' },
        source: { storageHash: hash(baseStorage), gzip: gzipSync(JSON.stringify({ body: 'CACHE BASE LIES\n', preserved: [] })).toString('base64') },
      },
    };
    const baseline = await download(f.api, '42');
    assert.equal(baseline.body, 'CACHE BASE LIES\n');
    assert.equal(baseline.metadata.confluence.storage_hash, hash(baseStorage));
    assert.equal(baseline.metadata.confluence.version, 7);
    f.state.page = remote;
    const draft = { ...baseline, body: 'Agent edit based on the cached lie.\n' };
    const before = f.requests.length;
    const result = await f.invoke(baseline, draft);
    assert.equal(result.status, 'conflict');
    assert.equal(result.conflicts[0].code, 'unverified_baseline');
    assertNoWrite(f, remote);
    assert.ok(f.requests.slice(before).some((request) => request.path === f.pagePath && new URLSearchParams(request.query).get('version') === '7'));
    assert.ok(f.requests.every((request) => request.method === 'GET'));
  });

  test('agent apply rejects a competing PUT without overwrite - ' + deployment, { timeout: 10000 }, async (t) => {
    const f = await serverFixture(t, deployment);
    f.state.gate = Promise.withResolvers();
    const reachedPut = once(f.events, 'put', { signal: AbortSignal.timeout(5000) });
    const pending = f.invoke();
    const [body] = await reachedPut;
    assert.equal(body.version.number, 9);
    f.state.page.version.number = 9;
    f.state.page.body.storage.value = '<p>Competing writer owns version nine</p>';
    const competitor = structuredClone(f.state.page);
    f.state.gate.resolve();
    const result = await pending;
    assert.equal(result.status, 'conflict');
    assert.equal(result.conflicts[0].code, 'version');
    assert.equal(puts(f).length, 1);
    assert.equal(f.state.applied, 0);
    assert.deepEqual(f.state.page, competitor);
  });

  test('agent apply preserves trusted native XML and ignores draft control fields - ' + deployment, async (t) => {
    const storage = '<p>First original</p>' + native + '<p>Last original</p>';
    const f = await serverFixture(t, deployment, { storage, current: storage.replace('Last original', 'Last remote') });
    Object.assign(f.draft.metadata.confluence, { parent_id: '999', storage_hash: 'forged', labels: ['injected'], template_id: '999' });
    const result = await f.invoke();
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(f.state.page.body.storage.value.split(native).length - 1, 1);
    assert.equal(result.document.metadata.confluence.parent_id, '5');
    assert.ok(f.requests.every((r) => !r.path.includes('/label') && !r.path.includes('/template')));
  });

  test('agent apply merges verified titles and preserves unrelated current metadata - ' + deployment, async (t) => {
    const f = await serverFixture(t, deployment);
    f.draft.metadata.title = 'Local title';
    f.state.property = { id: 'property-1', key: 'confluence-wiki-md', version: { number: 1 }, value: { metadata: { owner: 'current owner' } } };
    const result = await f.invoke();
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(f.state.page.title, 'Local title');
    assert.equal(result.resources.property.status, 'saved');
    assert.equal(f.state.property.value.metadata.title, 'Local title');
    assert.equal(f.state.property.value.metadata.owner, 'current owner');
  });

  test('agent apply preserves property already at the intended title - ' + deployment, async (t) => {
    const f = await serverFixture(t, deployment);
    f.draft.metadata.title = 'Local title';
    f.state.property = { id: 'property-1', key: 'confluence-wiki-md', version: { number: 1 }, value: { metadata: { title: 'Local title', owner: 'remote owner' } } };
    const before = structuredClone(f.state.property);
    const result = await f.invoke();
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(f.state.page.title, 'Local title');
    assert.equal(result.resources.property.status, 'preserved');
    assert.deepEqual(f.state.property, before);
    assert.ok(f.requests.filter((request) => request.path.includes('/propert')).every((request) => request.method === 'GET'));
  });

  for (const side of ['historical', 'current']) {
    for (const shape of ['CDATA', 'template']) {
      test('agent apply rejects lossy ' + side + ' ' + shape + ' representation - ' + deployment, async (t) => {
        const original = side === 'historical' ? baseStorage : remoteStorage;
        const text = side === 'historical' ? 'Last original' : 'Last remote';
        const lossy = original.replace('<p>' + text + '</p>',
          shape === 'CDATA' ? '<p><![CDATA[' + text + ']]></p>' : '<template>' + text + '</template>');
        const f = await serverFixture(t, deployment, side === 'historical' ? { storage: lossy } : { current: lossy });
        const before = structuredClone(f.state.page);
        const result = await f.invoke();
        assert.equal(result.status, 'conflict', JSON.stringify(result));
        assert.equal(result.conflicts[0].code, 'representation');
        assertNoWrite(f, before);
        assert.ok(f.requests.every((request) => request.method === 'GET'));
      });
    }
  }

  const opaqueCdata = '<ac:structured-macro ac:name="opaque" ac:macro-id="fixed"><ac:rich-text-body><p><![CDATA[Native payload]]></p></ac:rich-text-body></ac:structured-macro>';
  test('agent apply rejects CDATA outside a trusted native fragment - ' + deployment, async (t) => {
    const storage = '<p>First original</p>' + opaqueCdata + '<p>Last original</p>';
    const current = storage.replace('<p>Last original</p>', '<p>Last <![CDATA[Native payload]]> remote</p>');
    const f = await serverFixture(t, deployment, { storage, current });
    const before = structuredClone(f.state.page);
    const result = await f.invoke();
    assert.equal(result.status, 'conflict', JSON.stringify(result));
    assert.equal(result.conflicts[0].code, 'representation');
    assertNoWrite(f, before);
    assert.ok(f.requests.every((request) => request.method === 'GET'));
  });

  for (const [kind, fragment] of [
    ['opaque', opaqueCdata],
    ['code', '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">text</ac:parameter><ac:plain-text-body><![CDATA[Native payload\n]]></ac:plain-text-body></ac:structured-macro>'],
  ]) {
    test('agent apply retains trusted ' + kind + ' native CDATA - ' + deployment, async (t) => {
      const storage = '<p>First original</p>' + fragment + '<p>Last original</p>';
      const f = await serverFixture(t, deployment, { storage, current: storage.replace('Last original', 'Last remote') });
      const result = await f.invoke();
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(result.version, 9);
      assert.equal(puts(f).length, 1);
      assert.equal(f.state.page.body.storage.value.split(fragment).length - 1, 1);
      assert.match(f.state.page.body.storage.value, /First local/);
      assert.match(f.state.page.body.storage.value, /Last remote/);
    });
    test('agent apply reconciles lost update response with ' + kind + ' native CDATA - ' + deployment, { timeout: 10000 }, async (t) => {
      const storage = '<p>First original</p>' + fragment + '<p>Last original</p>';
      const f = await serverFixture(t, deployment, { storage, current: storage.replace('Last original', 'Last remote') });
      f.state.mode = 'lost-response';
      f.state.responseGate = Promise.withResolvers();
      const reached = once(f.events, 'applied', { signal: AbortSignal.timeout(5000) });
      const pending = f.invoke();
      await reached;
      f.state.responseGate.resolve();
      const result = await pending;
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(result.resources.page.status, 'reconciled');
      assert.equal(result.resources.page.authorship, 'unknown');
      assert.equal(result.version, 9);
      assert.equal(f.state.applied, 1);
      assert.equal(puts(f).length, 1);
      assert.equal(f.state.page.body.storage.value.split(fragment).length - 1, 1);
    });
  }

  for (const mode of ['postread-failure', 'http-failure', 'false-success', 'wrong-id', 'changed-storage', 'verification-conflict']) {
    test('agent apply reports unresolved partial rather than misleading success: ' + mode + ' - ' + deployment, async (t) => {
      const f = await serverFixture(t, deployment);
      f.state.mode = mode;
      const result = await f.invoke();
      assert.equal(result.status, 'partial', JSON.stringify(result));
      assert.equal(result.outcome, 'unresolved');
      assert.equal(result.attemptedVersion, 9);
      assert.equal(result.version, undefined);
      assert.equal(result.document, undefined);
      assert.equal(result.resources.page.status, 'unresolved');
      assert.equal(puts(f).length, 1);
      assert.equal(f.state.applied, ['http-failure', 'false-success'].includes(mode) ? 0 : 1);
      assert.ok(f.requests.every((r) => !/\/(pages|content)\/99/.test(r.path)));
    });
  }

  for (const mode of ['lost-before-commit', 'lost-always-before-commit', 'lost-retry-response']) {
    test('agent apply replays only the identical PUT at a matching base: ' + mode + ' - ' + deployment, { timeout: 10000 }, async (t) => {
      const f = await serverFixture(t, deployment);
      f.state.mode = mode === 'lost-retry-response' ? 'lost-before-commit' : mode;
      f.state.responseGate = Promise.withResolvers();
      const reachedLoss = once(f.events, 'lost-before-commit', { signal: AbortSignal.timeout(5000) });
      const pending = f.invoke();
      await reachedLoss;
      if (mode === 'lost-retry-response') f.state.mode = 'lost-response';
      f.state.responseGate.resolve();
      const result = await pending;
      assert.equal(puts(f).length, 2);
      assert.deepEqual(puts(f)[0].body, puts(f)[1].body);
      assert.equal(result.status, mode === 'lost-always-before-commit' ? 'partial' : 'success', JSON.stringify(result));
      assert.equal(f.state.applied, mode === 'lost-always-before-commit' ? 0 : 1);
      assert.equal(f.state.page.version.number, mode === 'lost-always-before-commit' ? 8 : 9);
      assert.equal(result.resources.page.status, mode === 'lost-retry-response' ? 'reconciled' : mode === 'lost-always-before-commit' ? 'unresolved' : 'saved');
      const between = f.requests.slice(f.requests.indexOf(puts(f)[0]) + 1, f.requests.indexOf(puts(f)[1]));
      assert.ok(between.some((request) => request.method === 'GET' && request.path === f.pagePath));
    });
  }

  for (const atBase of [false, true]) {
    for (const field of ['id', 'title', 'parentId', 'spaceId', 'status', 'storage', 'version', 'missing-storage', 'denied']) {
      test('agent apply leaves changed ' + (atBase ? 'base' : 'intended') + ' tuple unresolved: ' + field + ' - ' + deployment, { timeout: 10000 }, async (t) => {
        const f = await serverFixture(t, deployment);
        f.state.mode = atBase ? 'lost-before-commit' : 'lost-response';
        f.state.responseGate = Promise.withResolvers();
        const reached = once(f.events, atBase ? 'lost-before-commit' : 'applied', { signal: AbortSignal.timeout(5000) });
        const pending = f.invoke();
        await reached;
        if (field === 'id') f.state.page.id = '99';
        if (field === 'title') f.state.page.title = 'Another title';
        if (field === 'parentId') {
          if (deployment === 'cloud') f.state.page.parentId = '6';
          else f.state.page.ancestors = [{ id: '6' }];
        }
        if (field === 'spaceId') {
          if (deployment === 'cloud') f.state.page.spaceId = '2';
          else f.state.page.space = { id: '2', key: 'OTHER' };
        }
        if (field === 'status') f.state.page.status = 'trashed';
        if (field === 'storage') f.state.page.body.storage.value = '<p>Competing content</p>';
        if (field === 'version') f.state.page.version.number = 10;
        if (field === 'missing-storage') delete f.state.page.body.storage;
        if (field === 'denied') f.state.readStatus = 403;
        const remote = structuredClone(f.state.page);
        f.state.responseGate.resolve();
        const result = await pending;
        assert.equal(result.status, 'partial', JSON.stringify(result));
        assert.equal(result.outcome, 'unresolved');
        assert.equal(result.resources.page.status, 'unresolved');
        assert.equal(result.document, undefined);
        assert.equal(puts(f).length, 1);
        assert.equal(f.state.applied, atBase ? 0 : 1);
        assert.deepEqual(f.state.page, remote);
        assert.ok(f.requests.filter((request) => request.method !== 'GET').every((request) => request.path === f.pagePath));
      });
    }
  }

  for (const identical of [false, true]) {
    test('agent apply rechecks a rejected replay without claiming its first write: ' + identical + ' - ' + deployment, { timeout: 10000 }, async (t) => {
      const f = await serverFixture(t, deployment);
      f.state.mode = 'lost-before-commit';
      f.state.responseGate = Promise.withResolvers();
      const reachedLoss = once(f.events, 'lost-before-commit', { signal: AbortSignal.timeout(5000) });
      const pending = f.invoke();
      await reachedLoss;
      f.state.gate = Promise.withResolvers();
      const reachedRetry = once(f.events, 'put', { signal: AbortSignal.timeout(5000) });
      f.state.responseGate.resolve();
      const [body] = await reachedRetry;
      f.state.page.version.number = 9;
      f.state.page.body.storage.value = identical
        ? (deployment === 'cloud' ? body.body.value : body.body.storage.value)
        : '<p>Competing writer</p>';
      f.state.gate.resolve();
      const result = await pending;
      assert.equal(result.status, identical ? 'success' : 'partial', JSON.stringify(result));
      assert.equal(result.resources.page.status, identical ? 'reconciled' : 'unresolved');
      if (identical) assert.equal(result.resources.page.authorship, 'unknown');
      assert.equal(puts(f).length, 2);
      assert.deepEqual(puts(f)[0].body, puts(f)[1].body);
      assert.equal(f.state.applied, 0);
      assert.equal(f.state.page.version.number, 9);
    });
  }

  test('agent apply cannot attribute identical state to its lost request - ' + deployment, { timeout: 10000 }, async (t) => {
    const f = await serverFixture(t, deployment);
    f.state.mode = 'lost-before-commit';
    f.state.responseGate = Promise.withResolvers();
    const reached = once(f.events, 'lost-before-commit', { signal: AbortSignal.timeout(5000) });
    const pending = f.invoke();
    await reached;
    // A different writer publishes the exact intended tuple while our PUT is lost.
    const body = puts(f)[0].body;
    f.state.page.title = body.title;
    f.state.page.version.number = body.version.number;
    f.state.page.body.storage.value = deployment === 'cloud' ? body.body.value : body.body.storage.value;
    f.state.responseGate.resolve();
    const result = await pending;
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.resources.page.status, 'reconciled');
    assert.equal(result.resources.page.authorship, 'unknown');
    assert.equal(f.state.applied, 0);
    assert.equal(puts(f).length, 1);
  });

  test('agent apply preserves concurrently changed secondary resources - ' + deployment, { timeout: 10000 }, async (t) => {
    const f = await serverFixture(t, deployment);
    f.base.metadata.owner = f.draft.metadata.owner = 'stale draft owner';
    f.base.metadata.confluence.labels = f.draft.metadata.confluence.labels = ['stale-draft-label'];
    f.state.property = { id: 'property-1', version: { number: 1 }, value: { metadata: { owner: 'initial owner' } } };
    f.state.responseGate = Promise.withResolvers();
    const reached = once(f.events, 'applied', { signal: AbortSignal.timeout(5000) });
    const pending = f.invoke();
    await reached;
    f.state.property = { id: 'property-1', version: { number: 2 }, value: { metadata: { owner: 'competing owner' } } };
    f.state.labels = ['competing-label'];
    f.state.attachments = [{ id: '123', title: 'remote.svg', version: { number: 2 } }];
    const remote = structuredClone({ property: f.state.property, labels: f.state.labels, attachments: f.state.attachments });
    f.state.responseGate.resolve();
    const result = await pending;
    assert.equal(result.status, 'success', JSON.stringify(result));
    for (const resource of ['property', 'labels', 'attachments']) {
      assert.equal(result.resources[resource].status, 'preserved');
      assert.deepEqual(f.state[resource], remote[resource]);
    }
    assert.ok(f.requests.filter((request) => request.method !== 'GET').every((request) => request.path === f.pagePath));
  });

  test('agent apply leaves partial metadata and unknown creates unresolved - ' + deployment, async (t) => {
    for (const mode of ['property-failure', 'property-race', 'property-version-race', 'reconciled-property-race']) {
      await t.test('changed title ' + mode + ' is partial', { timeout: 10000 }, async (t) => {
        const f = await serverFixture(t, deployment);
        f.draft.metadata.title = 'Intended new title';
        f.state.property = { id: 'property-1', key: 'confluence-wiki-md', version: { number: 1 }, value: { metadata: { title: 'Page', owner: 'original owner' } } };
        f.state.mode = mode === 'property-failure' ? mode : mode === 'reconciled-property-race' ? 'lost-response' : null;
        const propertyRace = mode === 'property-version-race';
        const gate = Promise.withResolvers();
        if (propertyRace) f.state.propertyGate = gate;
        else f.state.responseGate = gate;
        const reached = once(f.events, propertyRace ? 'property-write' : 'applied', { signal: AbortSignal.timeout(5000) });
        const pending = f.invoke();
        await reached;
        if (mode !== 'property-failure') {
          f.state.property = { id: 'property-1', key: 'confluence-wiki-md', version: { number: 2 }, value: { metadata: { title: 'Competing title metadata', owner: 'competing owner' } } };
        }
        const remote = structuredClone(f.state.property);
        gate.resolve();
        const result = await pending;
        assert.equal(result.status, 'partial', JSON.stringify(result));
        assert.equal(result.resources.page.status, mode === 'reconciled-property-race' ? 'reconciled' : 'saved');
        assert.equal(result.resources.property.status, 'failed');
        assert.equal(result.resources.labels.status, 'preserved');
        assert.equal(result.resources.attachments.status, 'preserved');
        assert.equal(result.document, undefined);
        assert.equal(result.version, undefined);
        assert.equal(result.outcome, 'unresolved');
        assert.equal(f.state.page.version.number, 9);
        assert.equal(puts(f).length, 1);
        assert.deepEqual(f.state.property, remote);
        const writes = f.requests.filter((request) => request.method !== 'GET' && request.path.includes('/propert'));
        assert.equal(writes.length, mode === 'property-race' || mode === 'reconciled-property-race' ? 0 : 1);
      });
    }
    for (const resource of ['property', 'labels', 'attachments']) {
      await t.test(resource + ' failure retains the old local baseline', { timeout: 10000 }, async (t) => {
        const f = await serverFixture(t, deployment);
        f.state.mode = resource + '-failure';
        const doc = structuredClone(f.draft);
        doc.metadata.confluence.version = 8;
        doc.metadata.confluence.storage_hash = hash(remoteStorage);
        doc.metadata.confluence.labels = ['desired-label'];
        if (resource === 'attachments') {
          await writeFile(path.join(f.directory, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
          doc.body += '\n![image](./image.svg)\n';
        }
        f.state.gate = Promise.withResolvers();
        const reached = once(f.events, 'put', { signal: AbortSignal.timeout(5000) });
        let saved;
        const pending = assert.rejects(upload(f.api, formatDocument(doc), {
          filename: f.files[1], onWrite: async (value) => { saved = structuredClone(value); },
        }), (error) => {
          assert.equal(error.status, 'partial');
          assert.equal(error.outcome, 'unresolved');
          assert.equal(error.id, '42');
          assert.equal(error.version, 9);
          assert.equal(error.resources.page.status, 'saved');
          assert.equal(error.resources[resource].status, 'failed');
          assert.equal(error.resources[resource].outcome, 'unresolved');
          assert.equal(error.resources.property.status, resource === 'property' ? 'failed' : resource === 'attachments' ? 'not_attempted' : 'saved');
          assert.equal(error.resources.labels.status, resource === 'labels' ? 'failed' : 'not_attempted');
          return true;
        });
        await reached;
        f.state.gate.resolve();
        await pending;
        assert.equal(saved.metadata.confluence.version, 9);
        assert.equal(saved.metadata.confluence.base_body_hash, f.base.metadata.confluence.base_body_hash);
        assert.equal(saved.metadata.confluence.storage_hash, undefined);
        assert.equal(f.state.applied, 1);
        assert.equal(puts(f).length, 1);
      });
    }
    await t.test('unknown create does not issue a second POST', { timeout: 10000 }, async (t) => {
      const f = await serverFixture(t, deployment);
      f.state.mode = 'lost-create';
      f.state.responseGate = Promise.withResolvers();
      const reached = once(f.events, 'created', { signal: AbortSignal.timeout(5000) });
      let saves = 0;
      const pending = assert.rejects(upload(f.api, '# Unknown create', { defaultRestrictions: 'none', onWrite: async () => { saves++; } }), (error) => {
        assert.equal(error.status, 'partial');
        assert.equal(error.outcome, 'unresolved');
        assert.equal(error.id, null);
        assert.equal(error.resources.page.status, 'unresolved');
        assert.equal(error.resources.property.status, 'not_attempted');
        assert.equal(error.resources.labels.status, 'not_requested');
        assert.equal(error.resources.attachments.status, 'not_requested');
        return true;
      });
      await reached;
      f.state.responseGate.resolve();
      await pending;
      assert.equal(f.requests.filter((request) => request.method === 'POST' && /\/(pages|content)$/.test(request.path)).length, 1);
      assert.equal(f.state.applied, 1);
      assert.equal(f.state.page.version.number, 1);
      assert.equal(saves, 0);
    });
  });

  test('legacy upload still synchronizes all requested secondary resources - ' + deployment, async (t) => {
    const f = await serverFixture(t, deployment);
    const doc = structuredClone(f.draft);
    doc.metadata.confluence.version = 8;
    doc.metadata.confluence.storage_hash = hash(remoteStorage);
    doc.metadata.confluence.labels = ['desired-label'];
    doc.metadata.owner = 'human owner';
    await writeFile(path.join(f.directory, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    doc.body += '\n![image](./image.svg)\n';
    const result = await upload(f.api, formatDocument(doc), { filename: f.files[1] });
    for (const resource of ['page', 'property', 'labels', 'attachments']) assert.equal(result.resources[resource].status, 'saved');
    assert.equal(f.state.property.value.metadata.owner, 'human owner');
    assert.deepEqual(f.state.labels, ['desired-label']);
    assert.equal(f.state.attachments.length, 1);
    assert.equal(result.metadata.confluence.base_body_hash, bodyHash(result.body));
    assert.equal(result.metadata.confluence.storage_hash, hash(f.state.page.body.storage.value));
  });

  for (const failure of [false, true]) {
    test('CLI agent recovery ' + (failure ? 'leaves changed tuple unresolved' : 'reconciles lost update response') + ' - ' + deployment, { timeout: 15000 }, async (t) => {
      const f = await serverFixture(t, deployment);
      const sources = [formatDocument(f.base), formatDocument(f.draft)];
      await Promise.all(f.files.map((file, index) => writeFile(file, sources[index])));
      f.state.mode = 'lost-response';
      f.state.responseGate = Promise.withResolvers();
      const reached = once(f.events, 'applied', { signal: AbortSignal.timeout(5000) });
      const pending = f.cli('apply', f.files[1], '--base', f.files[0], '--space', 'TEST');
      await reached;
      if (failure) f.state.page.title = 'Competing title';
      f.state.responseGate.resolve();
      const result = await pending;
      assert.equal(result.code, failure ? 1 : 0, result.stderr);
      const outcome = JSON.parse(result.stdout);
      assert.equal(outcome.status, failure ? 'partial' : 'success');
      if (failure) assert.equal(outcome.outcome, 'unresolved');
      else assert.equal(outcome.version, 9);
      assert.equal(puts(f).length, 1);
      assert.equal(f.state.page.version.number, 9);
      assert.equal(f.state.applied, 1);
      assert.deepEqual(await Promise.all(f.files.map((file) => readFile(file, 'utf8'))), sources);
      assert.doesNotMatch(result.stdout + result.stderr, /fixture-pat/);
    });
  }

  for (const scenario of ['unknown-history', 'wrong-hash', 'wrong-title', 'foreign-space', 'remote-foreign-space', 'foreign-tenant', 'unbound', 'different-id', 'draft-version', 'metadata-edit']) {
    test('agent apply refuses invalid authority: ' + scenario + ' - ' + deployment, async (t) => {
      const f = await serverFixture(t, deployment);
      if (scenario === 'unknown-history') f.history.clear();
      if (scenario === 'wrong-hash') f.base.metadata.confluence.storage_hash = '0'.repeat(64);
      if (scenario === 'wrong-title') f.base.metadata.title = 'Fake baseline title';
      if (scenario === 'foreign-space') f.draft.metadata.confluence.space = 'OTHER';
      if (scenario === 'remote-foreign-space') {
        if (deployment === 'cloud') f.state.page.spaceId = '2';
        else f.state.page.space = { id: '2', key: 'OTHER' };
      }
      if (scenario === 'foreign-tenant') f.draft.metadata.confluence.site_url = 'https://foreign.example.test';
      if (scenario === 'unbound') delete f.draft.metadata.confluence;
      if (scenario === 'different-id') f.draft.metadata.confluence.id = '99';
      if (scenario === 'draft-version') f.draft.metadata.confluence.version = 99;
      if (scenario === 'metadata-edit') f.draft.metadata.owner = 'unverifiable';
      const before = structuredClone(f.state.page);
      const result = await f.invoke();
      assert.equal(result.status, 'conflict', JSON.stringify(result));
      assertNoWrite(f, before);
      if (['foreign-space', 'foreign-tenant', 'unbound', 'different-id', 'draft-version', 'metadata-edit'].includes(scenario)) {
        assert.equal(f.requests.length, 0);
      }
    });
  }

  for (const attribute of ['ac:1bad', 'ac:.bad', 'ac:-bad']) {
    test('agent apply rejects invalid QName ' + attribute + ' in current storage - ' + deployment, async (t) => {
      const current = remoteStorage.replace('<p>Middle unchanged</p>', '<p ' + attribute + '="x">Middle unchanged</p>');
      const f = await serverFixture(t, deployment, { current });
      const before = structuredClone(f.state.page);
      const historical = structuredClone(f.history.get(7));
      const inputs = structuredClone([f.base, f.draft]);
      const result = await f.invoke();
      assert.equal(result.status, 'conflict', JSON.stringify(result));
      assert.equal(result.conflicts[0].code, 'validation');
      assertNoWrite(f, before);
      assert.deepEqual(f.history.get(7), historical);
      assert.deepEqual([f.base, f.draft], inputs);
      assert.ok(f.requests.some((request) => request.path === f.pagePath && !new URLSearchParams(request.query).has('version')));
      assert.equal(f.requests.filter((request) => /\/propert/.test(request.path) && request.method !== 'GET').length, 0);
      assert.ok(f.requests.every((request) => request.method === 'GET'));
    });
  }

  for (const side of ['historical', 'current']) {
    for (const [kind, invalid] of [
      ['duplicate-attribute', '<p data-x="one" data-x="two">Middle unchanged</p>'],
      ['U+0001', '<p>Middle unchanged' + String.fromCharCode(1) + '</p>'],
    ]) {
      test('agent apply rejects ' + side + ' ' + kind + ' XML without PUT - ' + deployment, async (t) => {
        const source = (side === 'historical' ? baseStorage : remoteStorage).replace('<p>Middle unchanged</p>', invalid);
        const f = await serverFixture(t, deployment, side === 'current' ? { current: source } : {});
        if (side === 'historical') {
          // Do not ask the now-guarded converter to manufacture an invalid baseline.
          f.history.get(7).body.storage.value = source;
          f.base.metadata.confluence.storage_hash = hash(source);
          f.draft.metadata.confluence.storage_hash = hash(source);
        }
        const before = structuredClone(f.state.page);
        const historical = structuredClone(f.history.get(7));
        const result = await f.invoke();
        assert.equal(result.status, 'conflict', JSON.stringify(result));
        assert.equal(result.conflicts[0].code, 'validation');
        assertNoWrite(f, before);
        assert.deepEqual(f.history.get(7), historical);
        assert.ok(f.requests.some((request) => request.path === f.pagePath));
        assert.ok(f.requests.every((request) => request.method === 'GET'));
      });
    }
  }

  for (const scenario of ['malformed-history', 'malformed-current', 'changed-native', 'injected-native', 'changed-block', 'missing-fallback', 'duplicate-fallback', 'conflicting-fallback']) {
    test('agent apply rejects unsafe native preservation: ' + scenario + ' - ' + deployment, async (t) => {
      const storage = '<p>First original</p>' + native + '<p>Last original</p>';
      const f = await serverFixture(t, deployment, { storage, current: storage });
      if (scenario === 'malformed-history') f.history.get(7).body.storage.value = '<ac:structured-macro><p>broken</ac:structured-macro>';
      if (scenario === 'malformed-current') f.state.page.body.storage.value = '<ac:link><ri:page></ac:link>';
      if (scenario === 'changed-native') f.state.page.body.storage.value = storage.replace('DOC-1', 'DOC-2');
      if (scenario === 'injected-native') f.draft.metadata.confluence.preserved[0].storage = '<script>bad</script>';
      if (scenario === 'changed-block') f.draft.metadata.confluence.preserved[0].block = false;
      if (scenario === 'missing-fallback') f.draft.body = f.draft.body.replace(f.base.metadata.confluence.preserved[0].markdown, '');
      if (scenario === 'duplicate-fallback') f.draft.body += '\n' + f.base.metadata.confluence.preserved[0].markdown + '\n';
      if (scenario === 'conflicting-fallback') {
        const duplicate = storage.replace(native, native + native.replace('DOC-1', 'DOC-2'));
        f.history.get(7).body.storage.value = duplicate;
        const converted = storageToMarkdown(duplicate, { pageUrl: f.api.pageUrl('42'), siteUrl: f.api.config.webBase, pageId: '42' });
        f.base.body = converted.markdown;
        f.base.metadata.confluence.storage_hash = hash(duplicate);
        f.base.metadata.confluence.preserved = converted.preserved;
        f.draft = structuredClone(f.base);
        f.draft.body = f.draft.body.replace('First original', 'First local');
      }
      const before = structuredClone(f.state.page);
      const result = await f.invoke(f.base, f.draft);
      assert.equal(result.status, 'conflict', JSON.stringify(result));
      assertNoWrite(f, before);
    });
  }
}
