import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSamePreservedXml, readEvidence, readStorageSnapshot, validateStorageXml } from '../src/evidence.mjs';
import { hash } from '../src/document.mjs';

const config = {
  deployment: 'datacenter',
  apiUrl: 'https://wiki.example.test/confluence/rest/api',
  siteUrl: 'https://wiki.example.test/confluence',
  webBase: 'https://wiki.example.test/confluence',
  preserve: 'minimal',
};

function rawPage({
  id = '42',
  version = 8,
  status = 'current',
  spaceId = '1',
  spaceKey = 'TEST',
  storage = '<p>Not approved</p>',
} = {}) {
  return {
    id,
    title: 'Release decision',
    status,
    space: { id: spaceId, key: spaceKey },
    version: { number: version, when: '2026-09-27T00:00:00.000Z' },
    ...(storage === undefined ? {} : { body: { storage: { value: storage } } }),
  };
}

function fixture(t, pages, tenant = config) {
  const calls = [];
  const state = { active: true };
  t.after(() => {
    state.active = false;
    pages.clear();
  });
  const api = {
    config: tenant,
    pageUrl: (id) => tenant.webBase + '/pages/viewpage.action?pageId=' + id,
    async getSpace(key) {
      calls.push({ operation: 'space', key });
      return { id: '1', key: 'TEST' };
    },
    async getPage(id, version) {
      calls.push({ operation: 'page', id, version });
      const raw = pages.get(version ?? 'current');
      if (!raw) throw new Error('Fixture page is unavailable.');
      return {
        id: String(raw.id),
        title: raw.title,
        version: raw.version.number,
        status: raw.status,
        spaceId: String(raw.space?.id ?? ''),
        spaceKey: raw.space?.key,
        parentId: null,
        storage: raw.body?.storage?.value ?? '',
        url: api.pageUrl(raw.id),
        raw,
      };
    },
    async getProperty() {
      throw new Error('Cached content properties must not be read for evidence.');
    },
  };
  return { api, calls, state };
}

test('evidence uses live storage over cached Markdown', async (t) => {
  const pages = new Map([['current', rawPage()]]);
  const f = fixture(t, pages);
  const cachedProperty = {
    value: {
      pageVersion: 8,
      source: { body: 'Approved', metadata: { confluence: { id: 999, space: 'EVIL' } } },
    },
  };

  const evidence = await readEvidence(f.api, '42', {
    space: 'TEST',
    now: () => new Date('2026-09-27T01:02:03.000Z'),
    cachedProperty,
  });

  assert.equal(evidence.id, '42');
  assert.equal(typeof evidence.id, 'string');
  assert.equal(evidence.version, 8);
  assert.equal(evidence.sourceType, 'confluence-storage');
  assert.equal(evidence.readAt, '2026-09-27T01:02:03.000Z');
  assert.deepEqual(evidence.passages.map((passage) => passage.text), ['Not approved']);
  assert.doesNotMatch(JSON.stringify(evidence), /Approved|EVIL|999/);
  assert.deepEqual(f.calls, [
    { operation: 'space', key: 'TEST' },
    { operation: 'page', id: '42', version: undefined },
  ]);
  assert.equal(f.state.active, true);
});

test('native evidence refuses original parser loss before current or historical preservation', async (t) => {
  const storage = '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key" __proto__="keep-native-attribute">DOC-1</ac:parameter></ac:structured-macro>';
  for (const tenant of [config, { deployment: 'cloud', siteUrl: 'https://cloud.example.test', apiUrl: 'https://cloud.example.test/wiki/api/v2', webBase: 'https://cloud.example.test/wiki' }]) {
    for (const version of [undefined, 1]) {
      const f = fixture(t, new Map([[version ?? 'current', rawPage({ storage, version: 1, status: version ? 'historical' : 'current' })]]), tenant);
      await assert.rejects(readStorageSnapshot(f.api, '42', { space: 'TEST', version }), /without losing/i);
      await assert.rejects(readEvidence(f.api, '42', { space: 'TEST', version }), /without losing/i);
    }
  }
});

test('native evidence retains raw quote and entity spelling while projecting rich CDATA', async (t) => {
  const code = "<ac:structured-macro ac:name='code'><ac:plain-text-body><![CDATA[raw <code> &amp;]]></ac:plain-text-body></ac:structured-macro>";
  const panel = "<ac:structured-macro ac:name='info'><ac:rich-text-body><p>The release is <![CDATA[not ]]>approved.</p>" + code + '</ac:rich-text-body></ac:structured-macro>';
  const f = fixture(t, new Map([['current', rawPage({ storage: panel })]]));
  const snapshot = await readStorageSnapshot(f.api, '42', { space: 'TEST' });
  const evidence = await readEvidence(f.api, '42', { space: 'TEST' });
  assert.deepEqual(snapshot.preserved.map((item) => item.storage), [panel]);
  assert.ok(evidence.passages.some(({ text }) => text.includes('not approved')));
  assert.ok(evidence.passages.some(({ text }) => text.includes('raw <code> &amp;')));
});

test('storage snapshot supplies verified historical merge baseline', async (t) => {
  const historicalStorage = '<p>Version seven</p><ac:structured-macro ac:name="jira" ac:macro-id="m7"><ac:parameter ac:name="key">PROJ-7</ac:parameter></ac:structured-macro>';
  const currentStorage = '<p>Version eight</p>';
  const pages = new Map([
    [7, rawPage({ version: 7, status: 'historical', storage: historicalStorage })],
    ['current', rawPage({ version: 8, storage: currentStorage })],
  ]);
  const f = fixture(t, pages);

  const baseline = await readStorageSnapshot(f.api, '42', { space: 'TEST', version: 7 });
  const current = await readStorageSnapshot(f.api, '42', { space: 'TEST' });

  assert.equal(baseline.id, '42');
  assert.equal(baseline.version, 7);
  assert.equal(baseline.status, 'historical');
  assert.equal(baseline.storage, historicalStorage);
  assert.equal(baseline.preserved[0].storage, '<ac:structured-macro ac:name="jira" ac:macro-id="m7"><ac:parameter ac:name="key">PROJ-7</ac:parameter></ac:structured-macro>');
  assert.ok(baseline.warnings.some((warning) => warning.includes('jira')));
  assert.equal(current.version, 8);
  assert.equal(current.storage, currentStorage);
  assert.notEqual(baseline.storageHash, current.storageHash);
  assert.deepEqual(f.calls.filter((call) => call.operation === 'page'), [
    { operation: 'page', id: '42', version: 7 },
    { operation: 'page', id: '42', version: undefined },
  ]);
});

test('evidence rejects missing storage and foreign page', async (t) => {
  const missing = fixture(t, new Map([['current', rawPage({ storage: null })]]));
  await assert.rejects(
    readEvidence(missing.api, '42', { space: 'TEST' }),
    /storage body is missing/i,
  );

  const wrongId = fixture(t, new Map([['current', rawPage({ id: '99' })]]));
  await assert.rejects(
    readEvidence(wrongId.api, '42', { space: 'TEST' }),
    /requested page ID/i,
  );

  const wrongSpace = fixture(t, new Map([['current', rawPage({ spaceId: '2', spaceKey: 'OTHER' })]]));
  await assert.rejects(
    readEvidence(wrongSpace.api, '42', { space: 'TEST' }),
    /trusted space/i,
  );
});

test('evidence rejects invalid status, version, and tenant configuration before disclosure', async (t) => {
  const invalidStatus = fixture(t, new Map([['current', rawPage({ status: 'trashed' })]]));
  await assert.rejects(readStorageSnapshot(invalidStatus.api, '42', { space: 'TEST' }), /page status/i);

  const invalidVersion = fixture(t, new Map([['current', rawPage({ version: 0 })]]));
  await assert.rejects(readStorageSnapshot(invalidVersion.api, '42', { space: 'TEST' }), /positive page version/i);

  const invalidTenant = fixture(t, new Map([['current', rawPage()]]));
  invalidTenant.api.config = { ...config, apiUrl: 'not-a-url' };
  await assert.rejects(readStorageSnapshot(invalidTenant.api, '42', { space: 'TEST' }), /tenant configuration/i);
  assert.equal(invalidTenant.calls.length, 0);
});

test('Cloud and Data Center snapshots use their trusted context and preserve ac/ri storage', async (t) => {
  const storage = '<h2>Decision</h2><p><ac:link><ri:page ri:content-id="99"/><ac:plain-text-link-body>Related</ac:plain-text-link-body></ac:link></p>';
  const tenants = [
    config,
    { deployment: 'cloud', siteUrl: 'https://cloud.example.test', apiUrl: 'https://cloud.example.test/wiki/api/v2', webBase: 'https://cloud.example.test/wiki' },
  ];
  for (const tenant of tenants) {
    const f = fixture(t, new Map([['current', rawPage({ storage })]]), tenant);
    const snapshot = await readStorageSnapshot(f.api, '42', { space: 'TEST' });
    const evidence = await readEvidence(f.api, '42', { space: 'TEST' });
    assert.equal(snapshot.storage, storage);
    assert.equal(snapshot.url, tenant.webBase + '/pages/viewpage.action?pageId=42');
    assert.equal(evidence.url, snapshot.url);
    assert.deepEqual(evidence.passages, [{ text: `[Related](${tenant.webBase}/pages/viewpage.action?pageId=99)`, qualifier: 'Decision' }]);
  }
});

test('evidence rejects spoofed tenant base and unrelated same-origin page URL before disclosure', async (t) => {
  for (const tenant of [
    { ...config, webBase: 'https://evil.example.test/confluence' },
    { ...config, webBase: 'https://wiki.example.test/other-context' },
    { deployment: 'cloud', siteUrl: 'https://cloud.example.test', apiUrl: 'https://cloud.example.test/wiki/api/v2', webBase: 'https://evil.example.test/wiki' },
    { deployment: 'cloud', siteUrl: 'https://cloud.example.test', apiUrl: 'https://cloud.example.test/wiki/api/v2', webBase: 'https://cloud.example.test/other-context' },
    { ...config, apiUrl: 'https://wiki.example.test/confluence/not-api' },
    { ...config, siteUrl: 'https://wiki.example.test/confluence?spoof=1' },
  ]) {
    const f = fixture(t, new Map([['current', rawPage()]]), tenant);
    await assert.rejects(readEvidence(f.api, '42', { space: 'TEST' }), /tenant configuration/i);
    await assert.rejects(readStorageSnapshot(f.api, '42', { space: 'TEST' }), /tenant configuration/i);
    assert.deepEqual(f.calls, []);
  }

  for (const tenant of [config, { deployment: 'cloud', siteUrl: 'https://cloud.example.test', apiUrl: 'https://cloud.example.test/wiki/api/v2', webBase: 'https://cloud.example.test/wiki' }]) {
    const f = fixture(t, new Map([['current', rawPage()]]), tenant);
    f.api.pageUrl = () => tenant.webBase + '/not-a-page?token=SPOOF';
    await assert.rejects(readEvidence(f.api, '42', { space: 'TEST' }), /canonical page URL/i);
    await assert.rejects(readStorageSnapshot(f.api, '42', { space: 'TEST' }), /canonical page URL/i);
  }
});

test('malformed storage rejects without evidence, links, or snapshot while namespaced storage succeeds', async (t) => {
  const malformed = '<p>before<ac:structured-macro ac:name="jira"><p>after';
  for (const tenant of [config, { deployment: 'cloud', siteUrl: 'https://cloud.example.test', apiUrl: 'https://cloud.example.test/wiki/api/v2', webBase: 'https://cloud.example.test/wiki' }]) {
    const f = fixture(t, new Map([['current', rawPage({ storage: malformed })]]), tenant);
    await assert.rejects(readEvidence(f.api, '42', { space: 'TEST' }), /malformed XML/i);
    await assert.rejects(readStorageSnapshot(f.api, '42', { space: 'TEST' }), /malformed XML/i);
  }
});

test('storage XML rejects invalid entity references, duplicate attributes, and literal XML characters before either reader returns', async (t) => {
  const invalidStorage = [
    '<ac::link/>',
    '<ac:/>',
    '<ac:1bad/>',
    '<ac:.bad/>',
    '<ac:-bad/>',
    '<p ac::name="value"/>',
    '<p ac:="value"/>',
    '<p ac:1bad="value"/>',
    '<p ac:.bad="value"/>',
    '<p ac:-bad="value"/>',
    '<p data-x="one" data-x="two">Middle</p>',
    '<p>before\u0001after</p>',
    '<p title="before\u0001after">text</p>',
    '<![CDATA[before\u0001after]]>',
    '<!-- before\u0001after -->',
    '<p>before &bogus; after</p>',
    '<p>before & after</p>',
    '<p>&#0;</p>',
    '<p>&#xD800;</p>',
    '<p>&#x110000;</p>',
    '<ac:link ac:label="bad &bogus; label"><ri:page ri:content-id="99"/></ac:link>',
    '<ac:link ac:label="bad & label"><ri:page ri:content-id="99"/></ac:link>',
    '<ac:link ac:label="&#x1; label"><ri:page ri:content-id="99"/></ac:link>',
  ];
  for (const storage of invalidStorage) {
    for (const tenant of [config, { deployment: 'cloud', siteUrl: 'https://cloud.example.test', apiUrl: 'https://cloud.example.test/wiki/api/v2', webBase: 'https://cloud.example.test/wiki' }]) {
      const f = fixture(t, new Map([['current', rawPage({ storage })]]), tenant);
      await assert.rejects(readEvidence(f.api, '42', { space: 'TEST' }), /malformed XML/i, storage);
      await assert.rejects(readStorageSnapshot(f.api, '42', { space: 'TEST' }), /malformed XML/i, storage);
    }
  }
});

test('storage XML rejects raw CDATA terminators but preserves valid native CDATA on Cloud and Data Center', async (t) => {
  for (const tenant of [config, { deployment: 'cloud', siteUrl: 'https://cloud.example.test', apiUrl: 'https://cloud.example.test/wiki/api/v2', webBase: 'https://cloud.example.test/wiki' }]) {
    const malformed = '<p>MALFORMED_SECRET ]]> admitted</p>';
    const invalid = fixture(t, new Map([['current', rawPage({ storage: malformed })]]), tenant);
    await assert.rejects(readEvidence(invalid.api, '42', { space: 'TEST' }), /malformed XML/i);
    await assert.rejects(readStorageSnapshot(invalid.api, '42', { space: 'TEST' }), /malformed XML/i);

    const validStorage = '<p><![CDATA[Native payload]]></p>';
    const valid = fixture(t, new Map([['current', rawPage({ storage: validStorage })]]), tenant);
    const snapshot = await readStorageSnapshot(valid.api, '42', { space: 'TEST' });
    const evidence = await readEvidence(valid.api, '42', { space: 'TEST' });
    assert.equal(snapshot.storage, validStorage);
    assert.equal(evidence.storageHash, snapshot.storageHash);
  }
});

const xmlWhitespaceForms = (space) => [
  '<p>alpha</p' + space + '>',
  '<p' + space + '>alpha</p>',
  '<p' + space + 'title="one">alpha</p>',
  '<p title' + space + '="one">alpha</p>',
  '<p title=' + space + '"one">alpha</p>',
  '<p title="one"' + space + 'other="two">alpha</p>',
  '<p title="one"' + space + '/>',
  '<p title="one"' + space + '>alpha</p>',
];

for (const space of ['\u00a0', '\u2003', '\u2028', '\u2029', '\ufeff', '\u0085']) {
  test('storage XML rejects non-XML token whitespace U+' + space.codePointAt(0).toString(16), async (t) => {
    for (const tenant of [config, { deployment: 'cloud', siteUrl: 'https://cloud.example.test', apiUrl: 'https://cloud.example.test/wiki/api/v2', webBase: 'https://cloud.example.test/wiki' }]) {
      for (const storage of xmlWhitespaceForms(space)) {
        const f = fixture(t, new Map([['current', rawPage({ storage })]]), tenant);
        await assert.rejects(readEvidence(f.api, '42', { space: 'TEST' }), /malformed XML/i, storage);
        await assert.rejects(readStorageSnapshot(f.api, '42', { space: 'TEST' }), /malformed XML/i, storage);
      }
    }
  });
}

test('storage XML admits only XML token spaces without rejecting Unicode content or legal attributes', async (t) => {
  for (const tenant of [config, { deployment: 'cloud', siteUrl: 'https://cloud.example.test', apiUrl: 'https://cloud.example.test/wiki/api/v2', webBase: 'https://cloud.example.test/wiki' }]) {
    const sources = [' ', '\t', '\r', '\n', ' \t\r\n'].flatMap(xmlWhitespaceForms);
    const lossy = '<p __proto__="one" constructor="two" title="alpha\u00a0\u2003beta">alpha\u00a0beta</p>' +
      '<!-- \u00a0\u2003 -->' +
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[\u00a0\u2003]]></ac:plain-text-body></ac:structured-macro>';
    assert.deepEqual(validateStorageXml(lossy).get(0).attributes, ['__proto__', 'constructor', 'title']);
    const unrepresentable = fixture(t, new Map([['current', rawPage({ storage: lossy })]]), tenant);
    await assert.rejects(readStorageSnapshot(unrepresentable.api, '42', { space: 'TEST' }), /without losing/i);
    await assert.rejects(readEvidence(unrepresentable.api, '42', { space: 'TEST' }), /without losing/i);
    sources.push(lossy.replace(' __proto__="one"', ''));
    for (const storage of sources) {
      const f = fixture(t, new Map([['current', rawPage({ storage })]]), tenant);
      const snapshot = await readStorageSnapshot(f.api, '42', { space: 'TEST' });
      const evidence = await readEvidence(f.api, '42', { space: 'TEST' });
      assert.equal(snapshot.storage, storage);
      assert.equal(evidence.storageHash, hash(storage));
    }
  }
});

test('evidence extracts CDATA text faithfully and retains trusted native CDATA', async (t) => {
  const native = '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[<b>not approved</b> &amp;]]></ac:plain-text-body></ac:structured-macro>';
  const adjacentNative = '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[second <i>native</i> fragment]]></ac:plain-text-body></ac:structured-macro>';
  const storage = '<p>The release is <![CDATA[not ]]>approved.</p>' + native + adjacentNative;
  const f = fixture(t, new Map([['current', rawPage({ storage })]]));

  const snapshot = await readStorageSnapshot(f.api, '42', { space: 'TEST' });
  const evidence = await readEvidence(f.api, '42', { space: 'TEST' });

  assert.deepEqual(evidence.passages, [
    { text: 'The release is not approved.', qualifier: null },
    { text: '```\n<b>not approved</b> &amp;\n```', qualifier: null },
    { text: '```\nsecond <i>native</i> fragment\n```', qualifier: null },
  ]);
  assert.equal(snapshot.storage, storage);
  assert.equal(snapshot.storageHash, hash(storage));
  assert.deepEqual(snapshot.preserved.map((item) => item.storage), [native, adjacentNative]);
});

test('preserved XML validation rejects equal-count byte changes and reordering', () => {
  const first = { storage: '<ac:structured-macro ac:name="code"><![CDATA[<b>A</b>]]></ac:structured-macro>' };
  const second = { storage: '<ac:structured-macro ac:name="code"><![CDATA[<b>B</b>]]></ac:structured-macro>' };
  const escaped = { storage: '<ac:structured-macro ac:name="code">&lt;b&gt;A&lt;/b&gt;</ac:structured-macro>' };

  assert.equal(hasSamePreservedXml([first, second], [first, second]), true);
  assert.equal(hasSamePreservedXml([first], [escaped]), false);
  assert.equal(hasSamePreservedXml([first, second], [second, first]), false);
});

test('nested rich-text CDATA is cited faithfully while the original panel XML stays byte exact', async (t) => {
  const code = '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[<b>native</b> &amp;]]></ac:plain-text-body></ac:structured-macro>';
  const panel = '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>The release is <![CDATA[not ]]>approved.</p>' + code + '</ac:rich-text-body></ac:structured-macro>';
  const f = fixture(t, new Map([['current', rawPage({ storage: panel })]]));

  const snapshot = await readStorageSnapshot(f.api, '42', { space: 'TEST' });
  const evidence = await readEvidence(f.api, '42', { space: 'TEST' });

  assert.deepEqual(snapshot.preserved.map((item) => item.storage), [panel]);
  assert.ok(evidence.passages.some((passage) => passage.text.includes('The release is not approved.')));
  assert.ok(!evidence.passages.some((passage) => passage.text.includes('The release is approved.')));
  assert.ok(evidence.passages.some((passage) => passage.text.includes('<b>native</b> &amp;')));
});

test('storage XML accepts predefined and numeric entities, CDATA ampersands, comments, and native links', async (t) => {
  const storage = '<p title="&quot; &apos;">A &amp; B &lt; C &gt; D &#65; &#x1F642;</p>' +
    '<!-- comment &bogus; & -->' +
    '<p><![CDATA[literal &bogus; & bare <text>]]></p>' +
    '<ac:link><ri:page ri:content-id="99"/><ac:plain-text-link-body>Related</ac:plain-text-link-body></ac:link>';
  const f = fixture(t, new Map([['current', rawPage({ storage })]]));

  const snapshot = await readStorageSnapshot(f.api, '42', { space: 'TEST' });
  const evidence = await readEvidence(f.api, '42', { space: 'TEST' });

  assert.equal(snapshot.storage, storage);
  assert.equal(snapshot.storageHash.length, 64);
  assert.match(snapshot.markdown, /A & B < C > D A/);
  assert.match(snapshot.storage, /literal &bogus; & bare <text>/);
  assert.deepEqual(evidence.passages.map(({ text }) => text), [
    'A & B < C > D A 🙂',
    'literal &bogus; & bare <text>',
    '[Related](https://wiki.example.test/confluence/pages/viewpage.action?pageId=99)',
  ]);
});
