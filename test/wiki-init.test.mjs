import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';
import { ConfluenceApi, readWikiConfig } from '../src/api.mjs';
import { initWiki, readWikiRoot, WIKI_ROOT_PROPERTY } from '../src/wiki-init.mjs';
import { explore } from '../src/explore.mjs';

async function initFixture(t, deployment = 'cloud', mode = 'normal') {
  const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-init-'));
  const pages = new Map();
  const properties = new Map();
  const space = { id: '65714', key: 'AGENTTEST', name: 'Agent test', ...(deployment === 'cloud' ? { homepageId: '65822' } : {}) };
  const requests = [];
  let serial = 700;
  let loseNextCreate = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path: url.pathname, query: url.search, body });
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };

    if (req.headers.authorization !== 'Bearer fixture-pat') return send(401, {});
    if (deployment === 'cloud' && url.pathname === '/wiki/api/v2/spaces') {
      return send(200, { results: [space] });
    }
    if (deployment === 'datacenter' && url.pathname === '/rest/api/space/AGENTTEST') {
      return send(200, space);
    }

    const createPath = deployment === 'cloud' ? '/wiki/api/v2/pages' : '/rest/api/content';
    if (url.pathname === createPath && req.method === 'POST') {
      // Model the AGENTTEST save control, not the successful preview converter.
      if (deployment === 'cloud' && load(body.body.value, { xmlMode: true }, false)('ac\\:structured-macro[ac\\:name="pagetree"]').length) {
        return send(500, {});
      }
      const id = String(++serial);
      const page = deployment === 'cloud'
        ? {
            id,
            title: body.title,
            status: 'current',
            spaceId: space.id,
            parentId: body.parentId ?? '65822',
            version: { number: 1 },
            body: { storage: { value: body.body.value
              .replace(/ data-cfwiki-(?:root|topic)="[^"]*"/g, '')
              .replace('<ac:structured-macro ac:name="children" ac:schema-version="1">',
                '<ac:structured-macro ac:name="children" ac:schema-version="2" ac:macro-id="11111111-2222-4333-8444-555555555555">') } },
          }
        : {
            ...body,
            id,
            status: 'current',
            space: { id: space.id, key: space.key },
            version: { number: 1 },
            ancestors: body.ancestors ?? [],
          };
      pages.set(id, page);
      if (loseNextCreate) {
        loseNextCreate = false;
        req.socket.destroy();
        return;
      }
      if (mode === 'invalid-create-response') return send(200, { id });
      return send(200, page);
    }

    const prefix = deployment === 'cloud' ? '/wiki/api/v2/pages/' : '/rest/api/content/';
    const propertyPath = url.pathname.match(/\/(?:pages|content)\/(\d+)\/(?:properties|property)(?:\/([^/]+))?$/);
    if (propertyPath) {
      const id = propertyPath[1];
      if (req.method === 'GET') {
        const property = properties.get(id);
        return deployment === 'cloud' ? send(200, { results: property ? [property] : [] }) : send(property ? 200 : 404, property ?? {});
      }
      if (req.method === 'POST') {
        if (mode === 'marker-denied') return send(403, { secret: 'must not escape' });
        const property = { ...body, id: '900', version: { number: 1 } };
        properties.set(id, property);
        if (mode === 'marker-lost') { req.socket.destroy(); return; }
        if (mode === 'marker-mismatch') property.value.topic = 'Wrong topic';
        return send(200, property);
      }
    }
    if (url.pathname.endsWith('/search')) return send(200, { results: [] });
    if (url.pathname.startsWith(prefix) && req.method === 'GET') {
      if (mode === 'read-denied') return send(404, {});
      const page = pages.get(url.pathname.slice(prefix.length));
      return page ? send(200, page) : send(404, {});
    }
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
  const env = deployment === 'cloud'
    ? {
        CONFLUENCE_SITE_URL: origin,
        CONFLUENCE_API_URL: origin + '/wiki/api/v2',
        CONFLUENCE_API_V1_URL: origin + '/wiki/rest/api',
        CONFLUENCE_DEPLOYMENT: 'cloud',
        CONFLUENCE_AUTH: 'bearer',
        CONFLUENCE_PAT: 'fixture-pat',
        CONFLUENCE_SPACE_KEY: 'AGENTTEST',
        CONFLUENCE_ALLOW_HTTP: 'true',
      }
    : {
        CONFLUENCE_SITE_URL: origin,
        CONFLUENCE_API_URL: origin + '/rest/api',
        CONFLUENCE_DEPLOYMENT: 'datacenter',
        CONFLUENCE_PAT: 'fixture-pat',
        CONFLUENCE_SPACE_KEY: 'AGENTTEST',
        CONFLUENCE_ALLOW_HTTP: 'true',
      };
  return {
    api: new ConfluenceApi(readWikiConfig(env)),
    pages,
    properties,
    space,
    requests,
    setLoseNextCreate() { loseNextCreate = true; },
  };
}

function writeCount(fixture) {
  return fixture.requests.filter((request) => request.method === 'POST' && /\/(?:pages|content)$/.test(request.path)).length;
}

test('init publishes one self-rooted native page tree without root rewrites', async (t) => {
  for (const deployment of ['cloud', 'datacenter']) {
    const cloud = deployment === 'cloud';
    const injectedTopic = cloud
      ? 'Scope <ac:structured-macro ac:name="children"><ac:parameter ac:name="page">OTHER:Home</ac:parameter></ac:structured-macro>'
      : 'Scope <ac:structured-macro ac:name="pagetree"><ac:parameter ac:name="root">@none</ac:parameter></ac:structured-macro>';
    for (const topic of ['Navigation', injectedTopic]) {
      await t.test(deployment + (topic === 'Navigation' ? ' normal topic' : ' XML-like topic'), async (t) => {
        const f = await initFixture(t, deployment);
        const root = await initWiki(f.api, { space: 'AGENTTEST', topic });
        assert.equal(root.status, 'confirmed');
        const stored = f.pages.get(root.id).body.storage.value;
        const create = f.requests.find((request) => request.method === 'POST' && /\/(?:pages|content)$/.test(request.path));
        const sent = deployment === 'cloud' ? create.body.body.value : create.body.body.storage.value;
        let macroBytes;
        for (const [readback, storage] of [[false, sent], [true, stored]]) {
          const $ = load(storage, { xmlMode: true }, false);
          const macro = $('ac\\:structured-macro[ac\\:name="pagetree"], ac\\:structured-macro[ac\\:name="children"]');
          assert.equal(macro.length, 1, 'Initial storage must contain one executable native page tree.');
          assert.equal(macro.parents().length, 0, 'The control must not be inside a code/plain-text wrapper.');
          assert.equal(macro.attr('ac:name'), cloud ? 'children' : 'pagetree');
          assert.equal(macro.attr('ac:schema-version'), cloud && readback ? '2' : '1');
          assert.deepEqual(Object.keys(macro[0].attribs).sort(), cloud && readback
            ? ['ac:macro-id', 'ac:name', 'ac:schema-version']
            : ['ac:name', 'ac:schema-version']);
          if (cloud && readback) assert.match(macro.attr('ac:macro-id'), /^[a-f0-9-]{36}$/);
          assert.deepEqual(macro.children().toArray().map((node) => ({
            tag: node.name, attributes: { ...node.attribs }, text: $(node).text(),
          })), [{ tag: 'ac:parameter', attributes: { 'ac:name': cloud ? 'all' : 'root' }, text: cloud ? 'true' : '@self' }]);
          macroBytes = $.xml(macro);
          assert.doesNotMatch(macroBytes, /@home|@parent|@none|spaceKey|OTHER:Home|65714|65822|fixture-pat|Bearer|https?:/);
        }
        if (cloud) assert.notEqual(sent, stored, 'Cloud normalizes the macro on its initial save.');
        else assert.equal(sent, stored);
        assert.equal(f.requests.length, 8, 'Navigation requires no extra request or unborn page ID.');
        assert.equal(writeCount(f), 1);
        assert.equal(f.properties.get(root.id).key, WIKI_ROOT_PROPERTY);
        assert.equal(f.properties.get(root.id).value.topic, topic);

        const child = await f.api.writePage({ title: 'New child', storage: '<p>Child</p>', space: f.space, parentId: root.id });
        assert.equal((await f.api.getPage(child.id)).parentId, root.id);
        const beforeReuse = f.requests.length;
        const reused = await initWiki(f.api, { space: 'AGENTTEST', topic, existingRoot: root.id });
        assert.equal(reused.status, 'confirmed');
        assert.equal(reused.reused, true);
        assert.equal(f.requests.length - beforeReuse, 3);
        assert.ok(f.requests.slice(beforeReuse).every((request) => request.method === 'GET'));
        const snapshot = await readWikiRoot(f.api, root.id, { space: 'AGENTTEST', topic });
        assert.equal(snapshot.storage, stored);
        assert.equal(snapshot.version, 1);
        assert.equal(snapshot.parentId, deployment === 'cloud' ? '65822' : null);
        assert.equal(snapshot.preserved.filter((fragment) => fragment.storage === macroBytes).length, 1);
        assert.equal(f.requests.length, 16);
        assert.equal(writeCount(f), 2, 'Only the root and new child are published.');
        assert.equal(f.requests.filter((request) => request.method === 'POST' && /\/(?:properties|property)$/.test(request.path)).length, 1);
        assert.equal(f.requests.filter((request) => ['PUT', 'DELETE'].includes(request.method)).length, 0);
      });
    }
  }
});

test('init creates topical root and verifies existing ID', async (t) => {
  for (const deployment of ['cloud', 'datacenter']) {
    await t.test(deployment, async (t) => {
      const fixture = await initFixture(t, deployment);
      const created = await initWiki(fixture.api, { space: 'AGENTTEST', topic: '배포 운영' });
      assert.deepEqual(
        {
          status: created.status,
          reused: created.reused,
          version: created.version,
          spaceId: created.spaceId,
          spaceKey: created.spaceKey,
          topic: created.topic,
        },
        {
          status: 'confirmed',
          reused: false,
          version: 1,
          spaceId: '65714',
          spaceKey: 'AGENTTEST',
          topic: '배포 운영',
        },
      );
      assert.match(created.id, /^\d+$/);
      assert.match(created.url, new RegExp('pageId=' + created.id + '$'));
      assert.equal(writeCount(fixture), 1);
      assert.equal(fixture.requests.filter((request) => request.method === 'POST' && /\/(?:properties|property)$/.test(request.path)).length, 1);
      assert.equal(fixture.properties.get(created.id).key, WIKI_ROOT_PROPERTY);
      assert.equal(fixture.properties.get(created.id).value.pageId, created.id);

      const page = fixture.pages.get(created.id);
      const storage = page.body.storage.value;
      if (deployment === 'cloud') {
        assert.equal(page.parentId, '65822');
        assert.doesNotMatch(storage, /data-cfwiki-(root|topic)/);
      }
      else assert.deepEqual(page.ancestors, []);
      const $ = load(storage, { xmlMode: true }, false);
      const hrefs = $('a[href]').toArray().map((node) => $(node).attr('href'));
      assert.ok(hrefs.includes('https://nodejs.org/en/download'));
      assert.ok(hrefs.includes('https://github.com/TwoTwo-me/confluence-wiki-md'));
      const installCommands = $('pre').toArray()
        .flatMap((node) => $(node).text().split(/\r?\n/))
        .map((command) => command.trim().split(/\s+/))
        .filter(([program, command]) => program === 'npm' && command === 'install');
      assert.deepEqual(installCommands, [['npm', 'install', '--global', '@twotwo-me/confluence-wiki-md']]);
      assert.doesNotMatch(storage, /fixture-pat|CONFLUENCE_API_TOKEN=|CONFLUENCE_PAT=/);

      const beforeReuse = fixture.requests.length;
      const reused = await initWiki(fixture.api, {
        space: 'AGENTTEST',
        topic: '배포 운영',
        existingRoot: created.id,
      });
      assert.equal(reused.status, 'confirmed');
      assert.equal(reused.reused, true);
      assert.equal(reused.id, created.id);
      assert.equal(reused.version, created.version);
      assert.equal(reused.url, created.url);
      assert.equal(writeCount(fixture), 1);
      assert.equal(fixture.requests.slice(beforeReuse).filter((request) => request.method !== 'GET').length, 0);
    });
  }
});

test('init refuses wrong root and uncertain creation', async (t) => {
  const fixture = await initFixture(t, 'cloud');
  const requestCount = fixture.requests.length;
  await assert.rejects(
    initWiki(fixture.api, { space: 'AGENTTEST', topic: '\nunsafe' }),
    /without control characters/,
  );
  assert.equal(fixture.requests.length, requestCount);

  const created = await initWiki(fixture.api, { space: 'AGENTTEST', topic: 'Expected topic' });
  const writesAfterCreate = writeCount(fixture);
  await assert.rejects(
    initWiki(fixture.api, { space: 'AGENTTEST', topic: 'Wrong topic', existingRoot: created.id }),
    (error) => /does not match/.test(error.message) && !error.message.includes('This page is'),
  );
  assert.equal(writeCount(fixture), writesAfterCreate);

  const page = fixture.pages.get(created.id);
  page.spaceId = '99';
  await assert.rejects(
    initWiki(fixture.api, { space: 'AGENTTEST', topic: 'Expected topic', existingRoot: created.id }),
    /outside the trusted space/,
  );
  assert.equal(writeCount(fixture), writesAfterCreate);

  fixture.setLoseNextCreate();
  const uncertain = await initWiki(fixture.api, { space: 'AGENTTEST', topic: 'Uncertain topic' });
  assert.equal(uncertain.status, 'unresolved');
  assert.equal(uncertain.id, null);
  assert.match(uncertain.reason, /before any retry/);
  assert.equal(writeCount(fixture), writesAfterCreate + 1);
  assert.equal(
    fixture.requests.filter((request) => request.path.includes('/search')).length,
    0,
    'search-index silence must not drive a retry',
  );
});

test('init refuses unmarked copied foreign and reparented roots without writes', async (t) => {
  for (const deployment of ['cloud', 'datacenter']) {
    await t.test(deployment, async (t) => {
      const f = await initFixture(t, deployment);
      const root = await initWiki(f.api, { space: 'AGENTTEST', topic: 'Trusted' });
      const originalPage = structuredClone(f.pages.get(root.id));
      const originalProperty = structuredClone(f.properties.get(root.id));
      const before = f.requests.length;
      for (const change of [
        () => f.properties.delete(root.id),
        () => { f.properties.get(root.id).value.pageId = '999'; },
        () => { f.properties.get(root.id).value.tenant.siteUrl = 'https://foreign.invalid'; },
        () => { f.properties.get(root.id).value.spaceId = '99'; },
        () => { f.properties.get(root.id).value.topic = 'Other'; },
        () => { f.pages.get(root.id).title = 'Other Wiki'; },
        () => { f.pages.get(root.id).status = 'trashed'; },
        () => { const page = f.pages.get(root.id); if (deployment === 'cloud') page.parentId = '800'; else page.ancestors = [{ id: '800' }]; },
        () => { const page = f.pages.get(root.id); if (deployment === 'cloud') page.spaceId = '99'; else page.space.id = '99'; },
      ]) {
        f.pages.set(root.id, structuredClone(originalPage));
        f.properties.set(root.id, structuredClone(originalProperty));
        change();
        await assert.rejects(initWiki(f.api, { space: 'AGENTTEST', topic: 'Trusted', existingRoot: root.id }));
      }
      assert.equal(f.requests.slice(before).filter((request) => request.method !== 'GET').length, 0);
    });
  }
});

test('Cloud homepage parent must resolve from the selected space response', async (t) => {
  const f = await initFixture(t);
  const root = await initWiki(f.api, { space: 'AGENTTEST', topic: 'Trusted' });
  for (const homepageId of [undefined, 'invalid', '800', root.id]) {
    f.space.homepageId = homepageId;
    const before = f.requests.length;
    await assert.rejects(initWiki(f.api, { space: 'AGENTTEST', topic: 'Trusted', existingRoot: root.id }), /does not match/);
    assert.equal(f.requests.slice(before).filter((request) => request.method !== 'GET').length, 0);
  }
});

test('init retains known ID on marker failure or delayed visibility without retry', async (t) => {
  for (const deployment of ['cloud', 'datacenter']) {
    for (const mode of ['marker-denied', 'marker-lost', 'marker-mismatch', 'read-denied']) {
      await t.test(deployment + ' ' + mode, async (t) => {
        const f = await initFixture(t, deployment, mode);
        const result = await initWiki(f.api, { space: 'AGENTTEST', topic: 'Partial' });
        assert.equal(result.status, 'unresolved');
        assert.equal(result.id, '701');
        assert.equal(result.version, 1);
        assert.equal(result.url, f.api.pageUrl('701'));
        assert.equal(writeCount(f), 1);
        assert.equal(f.requests.filter((request) => request.method === 'POST' && /\/(?:properties|property)$/.test(request.path)).length, mode === 'read-denied' ? 0 : 1);
        assert.equal(f.requests.filter((request) => ['PUT', 'DELETE'].includes(request.method)).length, 0);
        assert.doesNotMatch(JSON.stringify(result), /must not escape|fixture-pat/);
        if (mode === 'marker-lost') {
          const before = f.requests.length;
          const recovered = await initWiki(f.api, { space: 'AGENTTEST', topic: 'Partial', existingRoot: result.id });
          assert.equal(recovered.status, 'confirmed');
          assert.equal(f.requests.slice(before).filter((request) => request.method !== 'GET').length, 0);
        }
      });
    }
  }
});

test('init retains a returned ID even when the POST response cannot be normalized', async (t) => {
  const f = await initFixture(t, 'cloud', 'invalid-create-response');
  const result = await initWiki(f.api, { space: 'AGENTTEST', topic: 'Unknown version' });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.id, '701');
  assert.equal(result.version, null);
  assert.equal(result.url, f.api.pageUrl('701'));
  assert.equal(writeCount(f), 1);
  assert.equal(f.requests.filter((request) => request.method !== 'GET').length, 1);
});

test('root navigation preserves authored forward links and storage evidence', async (t) => {
  for (const deployment of ['cloud', 'datacenter']) {
    await t.test(deployment, async (t) => {
      const f = await initFixture(t, deployment);
      const root = await initWiki(f.api, { space: 'AGENTTEST', topic: 'Linked evidence' });
      const child = await f.api.writePage({
        title: 'Linked support', storage: '<p>Current linked evidence.</p>',
        space: f.space, parentId: root.id,
      });
      // Model an authored link in current root storage, not a link invented
      // from the navigation macro's rendered output or a cached body.
      const currentRoot = f.pages.get(root.id);
      currentRoot.version.number = 2;
      currentRoot.body.storage.value += '<ac:structured-macro ac:name="info"><ac:rich-text-body>' +
        '<p>Authored root evidence.</p><ac:link><ri:page ri:content-id="' + child.id + '"/>' +
        '<ac:link-body>Linked support</ac:link-body></ac:link></ac:rich-text-body></ac:structured-macro>';
      const before = f.requests.length;
      const result = await explore(f.api, { space: 'AGENTTEST', root: root.id, question: 'Linked support' });
      assert.deepEqual(result.evidence.map((page) => page.id), [root.id, child.id]);
      const [rootEvidence, childEvidence] = result.evidence;
      assert.equal(rootEvidence.version, 2);
      assert.equal(rootEvidence.storage, currentRoot.body.storage.value);
      assert.ok(rootEvidence.passages.some((passage) => passage.text.includes('Authored root evidence.')));
      assert.equal(rootEvidence.preserved.filter((fragment) =>
        fragment.storage.includes('ac:name="' + (deployment === 'cloud' ? 'children' : 'pagetree') + '"')).length, 1);
      assert.equal(childEvidence.version, 1);
      assert.deepEqual(childEvidence.passages, [{ text: 'Current linked evidence.', qualifier: null }]);
      assert.deepEqual(childEvidence.routes[0].path, [root.id, child.id]);
      assert.equal(childEvidence.routes[0].sourceVersion, 2);
      assert.deepEqual(result.links.map(({ sourceId, targetId, status }) => ({ sourceId, targetId, status })),
        [{ sourceId: root.id, targetId: child.id, status: 'read' }]);
      assert.equal(result.usage.pageReads, 2);
      assert.equal(result.usage.httpAttempts, 5);
      assert.equal(f.requests.length - before, 5);
      assert.ok(f.requests.slice(before).every((request) => request.method === 'GET'));
    });
  }
});

test('explore admits only the same verified native root seed', async (t) => {
  for (const deployment of ['cloud', 'datacenter']) {
    await t.test(deployment, async (t) => {
      const f = await initFixture(t, deployment);
      const root = await initWiki(f.api, { space: 'AGENTTEST', topic: 'Explore' });
      const before = f.requests.length;
      const result = await explore(f.api, { space: 'AGENTTEST', root: root.id, question: 'Navigation' });
      assert.deepEqual(result.evidence.map((page) => page.id), [root.id]);
      assert.equal(result.usage.httpAttempts, 4);
      assert.equal(result.usage.pageReads, 1);
      f.properties.delete(root.id);
      const refused = await explore(f.api, { space: 'AGENTTEST', root: root.id, question: 'Navigation' });
      assert.deepEqual(refused.evidence, []);
      assert.equal(refused.unresolved[0].id, root.id);
      assert.equal(refused.stopReason, 'incomplete');
      assert.equal(refused.usage.httpAttempts, 4);
      assert.equal(f.requests.slice(before).filter((request) => request.method !== 'GET').length, 0);
    });
  }
});
