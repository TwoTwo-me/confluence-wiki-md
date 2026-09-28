import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStorageLinks } from '../src/storage-links.mjs';
import { readStorageSnapshot } from '../src/evidence.mjs';

function snapshot(storage, { deployment = 'cloud' } = {}) {
  const siteUrl = deployment === 'cloud' ? 'https://cloud.example.test' : 'https://wiki.example.test/confluence';
  const webBase = deployment === 'cloud' ? siteUrl + '/wiki' : siteUrl;
  return {
    sourceType: 'confluence-storage',
    tenant: { deployment, siteUrl },
    space: { id: '1', key: 'TRUSTED' },
    id: '42',
    version: 8,
    url: webBase + '/pages/viewpage.action?pageId=42',
    storage,
  };
}

test('storage links include native panel target', () => {
  const storage = '<ac:structured-macro ac:name="info"><ac:rich-text-body>' +
    '<ac:structured-macro ac:name="panel"><ac:rich-text-body>' +
    '<p><ac:link ac:anchor="decision"><ri:page ri:content-id="99"/><ac:link-body>Decision</ac:link-body></ac:link></p>' +
    '</ac:rich-text-body></ac:structured-macro></ac:rich-text-body></ac:structured-macro>' +
    '<p><a href="/wiki/pages/viewpage.action?pageId=99#details">duplicate</a></p>' +
    '<p><a href="/wiki/spaces/TRUSTED/pages/99/Decision#summary">modern duplicate</a></p>';
  const result = extractStorageLinks(snapshot(storage));
  assert.equal(result.sourceId, '42');
  assert.equal(result.version, 8);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].id, '99');
  assert.deepEqual(result.links[0].fragments, ['decision', 'details', 'summary']);
  assert.equal(result.links[0].locations.length, 3);
  assert.match(result.links[0].locations[0].path, /ac:structured-macro\/ac:rich-text-body\/p\/ac:link$/);
});

test('storage links exclude synthetic and ambiguous targets', () => {
  const storage = '<p><ac:link><ri:page ri:content-title="Exact title" ri:space-key="TRUSTED"/></ac:link></p>' +
    '<p><ac:link><ri:page ri:content-title="Exact title" ri:space-key="TRUSTED"/></ac:link></p>' +
    '<p><ac:link><ri:page ri:content-title="Foreign" ri:space-key="OTHER"/></ac:link></p>' +
    '<ac:image><ri:page ri:content-id="501"/><ri:attachment ri:filename="501.png"/></ac:image>' +
    '<ac:link><ri:attachment ri:filename="502.pdf"/><ri:page ri:content-id="502"/></ac:link>' +
    '<ac:structured-macro ac:name="code"><ac:plain-text-body><a href="/wiki/pages/viewpage.action?pageId=503">example</a></ac:plain-text-body></ac:structured-macro>' +
    '<ac:structured-macro ac:name="noformat"><ac:plain-text-body><a href="/wiki/pages/viewpage.action?pageId=504">example</a></ac:plain-text-body></ac:structured-macro>' +
    '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="url"><a href="/wiki/pages/viewpage.action?pageId=505">parameter</a></ac:parameter></ac:structured-macro>' +
    '<ac:structured-macro ac:name="unknown"><ac:rich-text-body><a href="/wiki/pages/viewpage.action?pageId=506">fallback</a></ac:rich-text-body></ac:structured-macro>' +
    '<p><a href="/wiki/pages/viewpage.action?pageId=42#macro-fallback">same page</a></p>' +
    '<p><a href="#local">self anchor</a></p>' +
    '<p><a href="/wiki/download/attachments/42/507.png">attachment</a></p>' +
    '<p><a href="/wiki/rest/api/content/508">same-origin API</a></p>' +
    '<p><a href="https://cloud.example.test/other/pages/viewpage.action?pageId=509">wrong context</a></p>';
  const result = extractStorageLinks(snapshot(storage));
  assert.deepEqual(result.links, []);
  assert.equal(result.unresolved.length, 1);
  assert.deepEqual(result.unresolved.map(({ title, space, reason }) => ({ title, space, reason })), [
    { title: 'Exact title', space: 'TRUSTED', reason: 'title-only-exact-match-required' },
  ]);
  assert.equal(result.unresolved[0].locations.length, 2);
  assert.ok(result.unresolved.every((candidate) => !Object.hasOwn(candidate, 'id')));
});

test('storage links validate Cloud and Data Center tenant contexts', () => {
  const cloud = extractStorageLinks(snapshot(
    '<a href="/wiki/pages/viewpage.action?pageId=100#cloud">cloud</a>' +
    '<a href="/confluence/pages/viewpage.action?pageId=101">wrong context</a>',
  ));
  assert.deepEqual(cloud.links.map(({ id }) => id), ['100']);
  assert.deepEqual(cloud.links[0].fragments, ['cloud']);

  const dc = extractStorageLinks(snapshot(
    '<a href="/confluence/pages/viewpage.action?pageId=200#dc">dc</a>' +
    '<a href="/confluence/display/TRUSTED/Exact+Runbook#section">title</a>' +
    '<a href="/display/TRUSTED/Outside">context escape</a>' +
    '<a href="/confluence/display/OTHER/Foreign">foreign title</a>',
    { deployment: 'datacenter' },
  ));
  assert.deepEqual(dc.links.map(({ id }) => id), ['200']);
  assert.equal(dc.unresolved.length, 1);
  assert.deepEqual({ title: dc.unresolved[0].title, space: dc.unresolved[0].space, reason: dc.unresolved[0].reason }, {
    title: 'Exact Runbook',
    space: 'TRUSTED',
    reason: 'title-only-exact-match-required',
  });
});

test('storage links reject encoded traversal routes', () => {
  const result = extractStorageLinks(snapshot(
    '<a href="/wiki/spaces/TRUSTED%2F..%2FEVIL/pages/991/Injected">encoded separators</a>' +
    '<a href="/wiki/spaces/TRUSTED%252F..%252FEVIL/pages/993/Double">double encoded separators</a>',
  ));
  assert.deepEqual(result.links, []);
  assert.deepEqual(result.unresolved, []);
});

test('storage links reject recursive encoded route matrix', () => {
  const recursive = (value, depth = 6) => {
    for (let pass = 0; pass < depth; pass++) value = encodeURIComponent(value);
    return value;
  };
  const hostileSpaces = [
    'TRUSTED' + recursive('/') + '..' + recursive('/') + 'other',
    'TRUSTED' + recursive('\\') + '..' + recursive('\\') + 'other',
    recursive('..'),
    'TRUSTED' + recursive('%ZZ'),
  ];
  const storage = hostileSpaces.map((space, index) =>
    '<a href="/wiki/spaces/' + space + '/pages/' + (991 + index) + '/Hostile">hostile</a>',
  ).join('');
  const result = extractStorageLinks(snapshot(storage));
  assert.deepEqual(result.links, []);
  assert.deepEqual(result.unresolved, []);
});

test('storage links reject raw backslash URL matrix', () => {
  const origins = [
    'https://cloud.example.test',
    String.raw`https:\\cloud.example.test`,
    '//cloud.example.test',
    String.raw`\\cloud.example.test`,
  ];
  const tails = [
    String.raw`\wiki\spaces\TRUSTED\pages\991\Hostile`,
    String.raw`/wiki\spaces\TRUSTED\pages\992\Hostile`,
    String.raw`/wiki/spaces\TRUSTED\pages\993\Hostile`,
    String.raw`/wiki/spaces/TRUSTED\pages\994\Hostile`,
    String.raw`\wiki/spaces/TRUSTED/pages/995/Hostile`,
  ];
  const hostile = origins.flatMap((origin) => tails.map((tail) => origin + tail));
  assert.equal(hostile.length, 20);
  const storage = hostile.map((href) => '<a href="' + href + '">hostile</a>').join('') +
    '<a href="../spaces/TRUSTED/pages/996/Relative#ok">relative</a>';
  const result = extractStorageLinks(snapshot(storage));
  assert.deepEqual(result.links.map(({ id }) => id), ['996']);
  assert.deepEqual(result.links[0].fragments, ['ok']);
  assert.deepEqual(result.unresolved, []);
});

test('storage links reject entity traversal and foreign modern routes from admitted panel storage', async () => {
  const storage = '<ac:structured-macro ac:name="info"><ac:rich-text-body>' +
    '<p><ac:link ac:anchor="native"><ri:page ri:content-id="997"/><ac:link-body>Native target</ac:link-body></ac:link></p>' +
    '<p><a href="/wiki/spaces/TRUSTED&#47;..&#47;EVIL/pages/991/Hostile">entity slash</a></p>' +
    '<p><a href="/wiki/spaces/TRUSTED&#92;..&#92;EVIL/pages/992/Hostile">entity backslash</a></p>' +
    '<p><a href="/wiki/spaces/EVIL/pages/993/Hostile">foreign modern route</a></p>' +
    '<p><a href="../spaces/TRUSTED/pages/996/Relative#ok">relative target</a></p>' +
    '</ac:rich-text-body></ac:structured-macro>';
  let reads = 0;
  const siteUrl = 'https://cloud.example.test';
  const api = {
    config: { deployment: 'cloud', siteUrl, webBase: siteUrl + '/wiki', apiUrl: siteUrl + '/wiki/api/v2' },
    getSpace: async () => ({ id: '1', key: 'TRUSTED' }),
    getPage: async (id) => {
      reads++;
      assert.equal(id, '42');
      return { id, spaceId: '1', version: 8, status: 'current', raw: {
        id, spaceId: '1', status: 'current', title: 'Source', version: { number: 8 }, body: { storage: { value: storage } },
      } };
    },
    pageUrl: (id) => siteUrl + '/wiki/pages/viewpage.action?pageId=' + id,
  };
  const admitted = await readStorageSnapshot(api, '42', { space: 'TRUSTED' });
  const result = extractStorageLinks(admitted);
  assert.equal(reads, 1);
  assert.equal(result.sourceId, '42');
  assert.equal(result.version, 8);
  assert.deepEqual(result.links.map(({ id }) => id), ['997', '996']);
  assert.deepEqual(result.links.map(({ fragments }) => fragments), [['native'], ['ok']]);
  assert.match(result.links[0].locations[0].path, /ac:structured-macro\/ac:rich-text-body\/p\/ac:link$/);
  assert.match(result.links[1].locations[0].path, /ac:structured-macro\/ac:rich-text-body\/p\/a$/);
  assert.deepEqual(result.unresolved, []);
  assert.doesNotMatch(JSON.stringify(result), /Hostile|991|992|993|FOREIGN SECRET BODY/);
});

test('storage links resolve relative panel page routes', () => {
  const storage = '<ac:structured-macro ac:name="info"><ac:rich-text-body>' +
    '<p><a href="../spaces/TRUSTED/pages/992/Relative#hint">relative target</a></p>' +
    '</ac:rich-text-body></ac:structured-macro>';
  const result = extractStorageLinks(snapshot(storage));
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].id, '992');
  assert.deepEqual(result.links[0].fragments, ['hint']);
  assert.equal(result.links[0].locations[0].label, 'relative target');
  assert.match(result.links[0].locations[0].path, /ac:structured-macro\/ac:rich-text-body\/p\/a$/);
});

test('storage links require an admitted verified raw snapshot', () => {
  const valid = snapshot('<a href="/wiki/pages/viewpage.action?pageId=99">target</a>');
  for (const invalid of [
    { ...valid, sourceType: 'markdown' },
    { ...valid, id: 'invalid' },
    { ...valid, version: 0 },
    { ...valid, storage: null },
    { ...valid, url: 'https://cloud.example.test/other/pages/viewpage.action?pageId=42' },
    { ...valid, tenant: { ...valid.tenant, siteUrl: 'https://cloud.example.test/other' } },
  ]) {
    assert.throws(() => extractStorageLinks(invalid), /verified|trusted Confluence context/i);
  }
});
