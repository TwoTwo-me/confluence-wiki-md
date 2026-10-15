import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { markdownToStorage, storageToMarkdown, reducePreservation, preservationMode, validateAgentPreservation, references } from '../src/document.mjs';
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

test('trusted native fragments survive agent edits', () => {
  const unknown = '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-1</ac:parameter></ac:structured-macro>';
  const toc = '<ac:structured-macro ac:name="toc" ac:schema-version="1"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro>';
  const downloaded = storageToMarkdown(unknown + toc, { ...context, preserve: 'all' });
  const trusted = { metadata: { confluence: { preserved: downloaded.preserved } }, body: downloaded.markdown };
  const draft = {
    metadata: { confluence: { preserved: downloaded.preserved.map((item) => ({ ...item })) } },
    body: downloaded.markdown + '\nAgent-authored explanation.\n',
  };

  const validation = validateAgentPreservation(draft, trusted);
  assert.deepEqual(validation.conflicts, []);
  assert.notEqual(validation.preserved, draft.metadata.confluence.preserved);
  const converted = markdownToStorage(draft.body, { preserved: validation.preserved });
  assert.ok(converted.storage.includes(unknown));
  assert.ok(converted.storage.includes(toc));
  assert.match(converted.storage, /Agent-authored explanation/);
});

test('agent edits reject injected and ambiguous XML', () => {
  const storage = '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-1</ac:parameter></ac:structured-macro>';
  const downloaded = storageToMarkdown(storage, { ...context, preserve: 'all' });
  const [trustedItem] = downloaded.preserved;
  const trusted = { metadata: { confluence: { preserved: downloaded.preserved } }, body: downloaded.markdown };
  const injected = { markdown: '[Confluence: injected](https://wiki.test/injected)', storage: '<ac:structured-macro ac:name="html"/>' };

  const injection = validateAgentPreservation({
    metadata: { confluence: { preserved: [trustedItem, injected] } },
    body: downloaded.markdown + '\n' + injected.markdown + '\n',
  }, trusted);
  assert.equal(injection.preserved, undefined);
  assert.ok(injection.conflicts.some(({ code }) => code === 'injected_preserved_fragment'));

  const modified = validateAgentPreservation({
    metadata: { confluence: { preserved: [{ ...trustedItem, storage: '<ac:structured-macro ac:name="html"/>' }] } },
    body: downloaded.markdown,
  }, trusted);
  assert.equal(modified.preserved, undefined);
  assert.ok(modified.conflicts.some(({ code }) => code === 'modified_preserved_fragment'));

  const ambiguous = validateAgentPreservation({
    metadata: { confluence: { preserved: [trustedItem] } },
    body: downloaded.markdown + '\n' + trustedItem.markdown + '\n',
  }, trusted);
  assert.equal(ambiguous.preserved, undefined);
  assert.ok(ambiguous.conflicts.some(({ code }) => code === 'ambiguous_preserved_fallback'));
});

for (const name of ['info', 'note', 'tip', 'warning', 'panel', 'expand', 'quote']) {
  test('ordinary ' + name + ' panels are editable Markdown without duplicate XML', () => {
    const storage = '<ac:structured-macro ac:name="' + name + '" ac:macro-id="native"><ac:parameter ac:name="title">주의 [A] &amp; B</ac:parameter><ac:parameter ac:name="icon">false</ac:parameter><ac:rich-text-body><h3>Panel heading</h3><p>Keep <strong>important</strong> content.</p><ul><li>first</li><li>second</li></ul></ac:rich-text-body></ac:structured-macro>';
    const converted = storageToMarkdown(storage, { ...context, preserve: 'minimal' });
    assert.deepEqual(converted.preserved, []);
    assert.match(converted.markdown, new RegExp('```confluence-' + name));
    const edited = converted.markdown.replace('important', 'updated');
    const $ = load(markdownToStorage(edited).storage, { xmlMode: true });
    assert.equal($('ac\\:structured-macro').attr('ac:name'), name);
    assert.equal($('ac\\:parameter[ac\\:name="title"]').text(), '주의 [A] & B');
    assert.equal($('ac\\:parameter[ac\\:name="icon"]').text(), 'false');
    assert.equal($('ac\\:rich-text-body strong').text(), 'updated');
    assert.deepEqual($('ac\\:rich-text-body li').toArray().map((node) => $(node).text()), ['first', 'second']);
  });
}

test('nested supported panels and local references work without XML preservation', () => {
  const body = '`````confluence-panel\n---\ntitle: Outer\n---\n\n````confluence-note\nRead [child](./99/Child.md).\n\n![chart](./assets/chart.png)\n\n```js\nconst important = true;\n```\n````\n`````\n';
  assert.deepEqual(references(body), [{ kind: 'link', url: './99/Child.md' }, { kind: 'image', url: './assets/chart.png' }]);
  const storage = markdownToStorage(body, { links: { './99/Child.md': 'https://wiki.test/99' }, images: { './assets/chart.png': 'chart.png' } }).storage;
  assert.match(storage, /href="https:\/\/wiki.test\/99"/);
  assert.match(storage, /ri:attachment ri:filename="chart.png"/);
  const converted = storageToMarkdown(storage, { ...context, preserve: 'minimal' });
  assert.deepEqual(converted.preserved, []);
  const $ = load(markdownToStorage(converted.markdown).storage, { xmlMode: true });
  assert.equal($('ac\\:structured-macro[ac\\:name="panel"] ac\\:structured-macro[ac\\:name="note"]').length, 1);
  assert.equal($('ac\\:plain-text-body').text(), 'const important = true;\n');
});

test('panels with unknown native features keep exact XML and explicit none mode warns', () => {
  for (const storage of [
    '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Important</p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-1</ac:parameter></ac:structured-macro></ac:rich-text-body></ac:structured-macro>',
    '<ac:structured-macro ac:name="panel" custom="retain"><ac:rich-text-body><p>Keep</p></ac:rich-text-body></ac:structured-macro>',
    '<ac:structured-macro ac:name="panel"><ac:parameter ac:name="title">First</ac:parameter><ac:parameter ac:name="title">Second</ac:parameter><ac:rich-text-body><p>Keep</p></ac:rich-text-body></ac:structured-macro>',
  ]) {
    const converted = storageToMarkdown(storage, { ...context, preserve: 'minimal' });
    assert.equal(converted.preserved.length, 1);
    assert.equal(markdownToStorage(converted.markdown, { preserved: converted.preserved }).storage, storage);
    const none = storageToMarkdown(storage, { ...context, preserve: 'none' });
    assert.deepEqual(none.preserved, []);
    assert.ok(none.warnings.length > 0);
  }
});

test('headerless native tables become compact Markdown with every original cell retained', () => {
  const storage = '<table><tr><td>first</td><td>second</td></tr><tr><td>third</td><td>fourth</td></tr></table>';
  const converted = storageToMarkdown(storage, { ...context, preserve: 'minimal' });
  assert.deepEqual(converted.preserved, []);
  assert.doesNotMatch(converted.markdown, /<table/);
  const $ = load(markdownToStorage(converted.markdown).storage, { xmlMode: true });
  assert.deepEqual($('th,td').toArray().map((node) => $(node).text()), ['first', 'second', 'third', 'fourth']);
});

test('invalid panel parameter headers fail before producing native storage', () => {
  for (const header of ['[nested]', 'title: [nested]', 'title: First\ntitle: Second', 'value: .inf']) assert.throws(() => markdownToStorage('```confluence-info\n---\n' + header + '\n---\n\nBody\n```'), /Confluence macro parameters/);
});

test('reducing old panel and image fallbacks upgrades their content before removing XML', () => {
  const panel = '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Keep this title</ac:parameter><ac:rich-text-body><p>Keep body</p></ac:rich-text-body></ac:structured-macro>';
  const image = '<ac:image ac:alt="Old [label]" ac:title="Keep image title"><ri:url ri:value="https://example.com/image.png"/></ac:image>';
  const oldPanel = '```confluence-info\nKeep body\n```';
  const oldImage = '![Old label](https://example.com/image.png)';
  const reduced = reducePreservation({ metadata: { confluence: { preserved: [{ markdown: oldPanel, storage: panel }, { markdown: oldImage, storage: image }] } }, body: oldPanel + '\n\n' + oldImage + '\n' }, context);
  assert.equal(reduced.metadata.confluence.preserved, undefined);
  const $ = load(markdownToStorage(reduced.body).storage, { xmlMode: true });
  assert.equal($('ac\\:parameter[ac\\:name="title"]').text(), 'Keep this title');
  assert.equal($('ac\\:image').attr('ac:alt'), 'Old [label]');
  assert.equal($('ac\\:image').attr('ac:title'), 'Keep image title');
});

test('image captions and rich page link bodies keep native content in minimal mode', () => {
  for (const storage of [
    '<ac:image ac:alt="Chart"><ri:url ri:value="https://example.com/image.png"/><ac:caption><p>Important caption</p></ac:caption></ac:image>',
    '<ac:link><ri:page ri:content-id="99"/><ac:link-body><ac:image><ri:url ri:value="https://example.com/linked.png"/></ac:image></ac:link-body></ac:link>',
  ]) {
    const converted = storageToMarkdown(storage, { ...context, preserve: 'minimal' });
    assert.equal(converted.preserved.length, 1);
    assert.ok(markdownToStorage(converted.markdown, { preserved: converted.preserved }).storage.includes(storage));
  }
});

test('escaped angle text and entity-looking literals survive editable Markdown round trips', () => {
  const storage = '<h2>&lt;Heading&gt;</h2><p>기호 &amp; &lt;example&gt;를 그대로 보존합니다. &lt;script&gt;alert(1)&lt;/script&gt; &lt;kbd&gt;Ctrl&lt;/kbd&gt; &lt;https://example.com&gt; &amp;lt;literal&amp;gt; &amp;#60;literal&amp;#62;</p><blockquote><p>&lt;quote&gt;</p></blockquote><table><tr><th>Syntax</th></tr><tr><td>&lt;table-cell&gt;</td></tr></table><p><code>&lt;inline-code&gt;</code> H<sub>2</sub>O x<sup>2</sup> <a href="https://example.com/?q=a%3Cb&amp;mode=1">&lt;link label&gt;</a></p>';
  const inspect = (xml) => {
    const $ = load(xml, { xmlMode: true });
    return { text: $.root().text().replace(/\s+/g, ''), href: $('a').last().attr('href'), inline: $('code').text(), sub: $('sub').text(), sup: $('sup').text() };
  };
  let current = storage;
  for (let i = 0; i < 3; i++) {
    const converted = storageToMarkdown(current, { ...context, preserve: 'minimal' });
    assert.match(converted.markdown, /\\<example>/);
    assert.deepEqual(converted.preserved, []);
    current = markdownToStorage(converted.markdown).storage;
    assert.deepEqual(inspect(current), inspect(storage));
    assert.doesNotMatch(current, /<script|<example|<kbd/);
  }
});

test('native reference labels escape literal HTML without changing destinations or code', () => {
  const original = '<p><ac:link><ri:page ri:content-id="99"/><ac:plain-text-link-body><![CDATA[<example> &lt;title&gt; *literal*]]></ac:plain-text-link-body></ac:link></p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">html</ac:parameter><ac:plain-text-body><![CDATA[<kbd>Ctrl</kbd> &amp;\n]]></ac:plain-text-body></ac:structured-macro>';
  const converted = storageToMarkdown(original, { ...context, preserve: 'minimal' });
  const $ = load(markdownToStorage(converted.markdown).storage, { xmlMode: true });
  assert.equal($('a').text(), '<example> &lt;title&gt; *literal*');
  assert.equal($('a').attr('href'), 'https://wiki.test/wiki/pages/viewpage.action?pageId=99');
  assert.equal($('ac\\:plain-text-body').text(), '<kbd>Ctrl</kbd> &amp;\n');
});

test('all mode retains complete native task-list identity while minimal stays editable', () => {
  const storage = '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Backup</ac:task-body></ac:task><ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Approve</ac:task-body></ac:task></ac:task-list>';
  const all = storageToMarkdown(storage, { ...context, preserve: 'all' });
  assert.deepEqual(all.preserved, [{ markdown: all.markdown.trimEnd(), storage, block: true }]);
  assert.equal(markdownToStorage(all.markdown, { preserved: all.preserved }).storage, storage);
  const minimal = storageToMarkdown(storage, { ...context, preserve: 'minimal' });
  assert.deepEqual(minimal.preserved, []);
  assert.equal(minimal.markdown, all.markdown);
});
