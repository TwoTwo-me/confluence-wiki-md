import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { markdownToStorage, storageToMarkdown, reducePreservation, preservationMode } from '../src/document.mjs';
import { forgeStorage } from '../src/forge.mjs';

const context = { pageUrl: 'https://wiki.test/wiki/pages/viewpage.action?pageId=42', siteUrl: 'https://wiki.test/wiki', pageId: '42' };

test('table pipes, inline code, line breaks and sub/sup formatting survive without preservation', () => {
  const original = '| Left | Middle | Right |\n| :--- | :---: | ---: |\n| pipe \\| value | `x\\|y` | 456 |\n| [link](https://example.com) | first<br>second | 789 |\n\nH<sub>2</sub>O and x<sup>2</sup>.';
  const first = markdownToStorage(original).storage;
  const extracted = storageToMarkdown(first, { ...context, preserve: 'none' });
  const second = markdownToStorage(extracted.markdown).storage;
  const inspect = (storage) => {
    const $ = load(storage, { xmlMode: true });
    return { cells: $('table tr').toArray().map((r) => $(r).find('th,td').toArray().map((c) => $(c).html())), sub: $('sub').text(), sup: $('sup').text() };
  };
  assert.deepEqual(inspect(second), inspect(first));
});

test('minimal Markdown conversion needs no preserved XML for code, images, page links or a TOC', () => {
  const md = '```confluence-toc\nminLevel: 2\nmaxLevel: 3\n```\n\n## Heading\n\n| Key | Value |\n| --- | --- |\n| **one** | `two` |\n\n```javascript\nconst x = "```";\n```\n\n![image](https://wiki.test/a.svg)\n';
  const storage = markdownToStorage(md).storage + '<p><ac:link><ri:page ri:content-id="99"/><ac:plain-text-link-body><![CDATA[Target]]></ac:plain-text-link-body></ac:link></p>';
  const minimal = storageToMarkdown(storage, { ...context, preserve: 'minimal' });
  assert.deepEqual(minimal.preserved, []);
  assert.match(minimal.markdown, /confluence-toc/);
  const again = markdownToStorage(minimal.markdown).storage;
  const $ = load(again, { xmlMode: true });
  assert.equal($('table td').length, 2);
  assert.equal($('ac\\:structured-macro[ac\\:name="toc"]').length, 1);
  assert.equal($('ac\\:parameter[ac\\:name="maxLevel"]').text(), '3');
  assert.match(again, /pageId=99/);
  assert.match(again, /const x/);
  assert.match(again, /ri:url/);
});

test('minimal retains unknown macros, merged tables, mentions, and custom code titles', () => {
  const storage = '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-1</ac:parameter></ac:structured-macro><table><tr><td colspan="2">merged</td></tr></table><ac:link><ri:user ri:account-id="user"/></ac:link><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">json</ac:parameter><ac:parameter ac:name="title">Configuration example</ac:parameter><ac:plain-text-body><![CDATA[{"enabled":true}]]></ac:plain-text-body></ac:structured-macro>';
  const minimal = storageToMarkdown(storage, { ...context, preserve: 'minimal' });
  assert.equal(minimal.preserved.length, 4);
  const none = storageToMarkdown(storage, { ...context, preserve: 'none' });
  assert.deepEqual(none.preserved, []);
  assert.ok(none.warnings.some((message) => message.includes('Dropped preservation')));
  assert.match(none.markdown, /Confluence: jira/);
});

test('recognized Forge diagram source is sufficient without XML and old cached metadata can be reduced', () => {
  const entry = { name: 'mermaid-viewer', adapter: 'mermaid-viewer', extensionKey: 'app/env/static/key', parameters: {} };
  const profile = { mermaid: entry };
  const source = 'flowchart LR\n  A --> B\n';
  const storage = forgeStorage(entry, source);
  const all = storageToMarkdown(storage, { ...context, diagramProfile: profile });
  const minimal = storageToMarkdown(storage, { ...context, diagramProfile: profile, preserve: 'minimal' });
  assert.equal(all.preserved.length, 1);
  assert.deepEqual(minimal.preserved, []);
  assert.match(minimal.markdown, /A --> B/);
  const reduced = reducePreservation({ metadata: { confluence: { id: '42', version: 3, preserved: all.preserved } }, body: all.markdown }, { ...context, diagramProfile: profile });
  assert.equal(reduced.metadata.confluence.preserved, undefined);
  assert.equal(reduced.body, all.markdown);
  assert.equal(reduced.metadata.confluence.version, 3);
});

test('legacy TOC fallback becomes an editable directive without dropping its parameters', () => {
  const storage = '<ac:structured-macro ac:name="toc" ac:macro-id="a"><ac:parameter ac:name="maxLevel">4</ac:parameter></ac:structured-macro>';
  const all = storageToMarkdown(storage, context);
  const doc = { metadata: { confluence: { preserved: all.preserved, base_body_hash: 'unchanged-baseline' } }, body: all.markdown + '\n## Content\n' };
  const reduced = reducePreservation(doc, context);
  assert.equal(reduced.metadata.confluence.preserved, undefined);
  assert.match(reduced.body, /```confluence-toc\nmaxLevel: "4"\n```/);
  assert.equal(reduced.metadata.confluence.base_body_hash, 'unchanged-baseline');
  assert.match(markdownToStorage(reduced.body).storage, /ac:name="maxLevel">4/);
});

test('invalid preservation selections and TOC mappings fail before publishing', () => {
  assert.throws(() => preservationMode('typo'), /Preservation/);
  for (const yaml of ['[one, two]', 'key: [nested]', 'key: first\nkey: second', 'maxLevel: .inf']) {
    assert.throws(() => markdownToStorage('```confluence-toc\n' + yaml + '\n```'), /confluence-toc/);
  }
});

test('minimal retains custom image sizing and descriptive no-language code titles', () => {
  const storage = '<ac:image ac:width="40"><ri:url ri:value="https://example.com/image.png"/></ac:image><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">none</ac:parameter><ac:parameter ac:name="title">Example configuration</ac:parameter><ac:plain-text-body><![CDATA[value]]></ac:plain-text-body></ac:structured-macro>';
  const result = storageToMarkdown(storage, { ...context, preserve: 'minimal' });
  assert.equal(result.preserved.length, 2);
  const restored = markdownToStorage(result.markdown, { preserved: result.preserved }).storage;
  assert.match(restored, /ac:width="40"/);
  assert.match(restored, /Example configuration/);
});

test('minimal removes orphaned preserved entries after their body content was edited', () => {
  const doc = { metadata: { confluence: { preserved: [{ markdown: '[old](https://example.com)', storage: '<ac:structured-macro ac:name="jira"/>' }] } }, body: 'Replacement text.\n' };
  const reduced = reducePreservation(doc, context);
  assert.equal(reduced.metadata.confluence.preserved, undefined);
  assert.equal(reduced.body, doc.body);
});

test('Cloud quote normalization keeps all text and depth markers through a cache-free round trip', () => {
  const body = '> Outer\n>\n> > Nested\n> >\n> > Another paragraph\n> >\n> > > Third level\n';
  const original = markdownToStorage(body).storage;
  assert.equal(load(original, { xmlMode: true })('blockquote blockquote').length, 2);
  const cloud = markdownToStorage(body, { flattenNestedQuotes: true });
  const $ = load(cloud.storage, { xmlMode: true });
  assert.equal($('blockquote blockquote').length, 0);
  assert.deepEqual($('blockquote p').toArray().map((n) => $(n).text()), ['Outer', '› Nested', '› Another paragraph', '› › Third level']);
  assert.equal(cloud.warnings.length, 1);
  const md = storageToMarkdown(cloud.storage, { ...context, preserve: 'none' });
  assert.deepEqual(md.preserved, []);
  assert.equal(markdownToStorage(md.markdown, { flattenNestedQuotes: true }).storage, cloud.storage);
});
