import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, formatDocument, markdownToStorage, storageToMarkdown } from '../src/document.mjs';

const context = { pageUrl: 'https://wiki.example.test/confluence/pages/viewpage.action?pageId=42', siteUrl: 'https://wiki.example.test/confluence', pageId: '42' };

test('OKF front matter preserves unknown structured fields and string page identity', () => {
  const input = '---\ntype: Playbook\ntitle: "문서"\nsources:\n  - id: source-a\n    resource: https://example.com\ncustom:\n  owner: team\nconfluence:\n  id: "42"\n  version: 7\n---\n# 문서\n';
  const doc = parseDocument(input);
  assert.equal(doc.metadata.confluence.id, '42');
  assert.deepEqual(parseDocument(formatDocument(doc)).metadata, doc.metadata);
  assert.equal(doc.body, '# 문서\n');
});

test('plain Markdown is accepted and receives an OKF type on export', () => {
  const doc = parseDocument('# Title\n\nBody');
  assert.equal(doc.metadata.type, 'Reference');
  assert.equal(parseDocument(formatDocument(doc)).body.trim(), '# Title\n\nBody');
});

for (const input of ['---\ntype: [broken\n---\nbody', '---\ntype: Reference\ntype: Other\n---\nbody', '---\ntype: 3\n---\nbody']) {
  test('invalid YAML or non-string OKF type is rejected: ' + input.slice(4, 24), () => assert.throws(() => parseDocument(input)));
}

test('CommonMark formatting, GFM tables, tasks, and standard links become storage', () => {
  const md = '# Title\n\n**bold** *italic* ~~old~~ `inline` & < >\n\n> Quote\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[label](https://example.com/a_(b)?x=1&y=2 "title")\n\n![alt](https://example.com/img.png)\n';
  const result = markdownToStorage(md);
  for (const fragment of ['<h1>', '<strong>', '<em>', '<s>', '<code>', '<blockquote>', '<ol>', '<table>', 'ac:task-list', 'ac:task-status', 'https://example.com/a_(b)', 'ri:url']) assert.ok(result.storage.includes(fragment), fragment);
  const back = storageToMarkdown(result.storage, context);
  assert.match(back.markdown, /\[label\]\(https:\/\/example.com\/a_\\?\(b\\?\)/);
  assert.match(back.markdown, /\[x\] done/);
  assert.match(back.markdown, /\[ \] todo/);
  assert.match(back.markdown, /\|.*A.*\|.*B/);
});

test('fenced code including backticks and CDATA terminators round-trips without loss', () => {
  const code = 'const x = "```";\n// ]]> & <tag>\n';
  const result = markdownToStorage('````javascript\n' + code + '````\n');
  assert.match(result.storage, /ac:name="code"/);
  const back = storageToMarkdown(result.storage, context);
  assert.ok(back.markdown.includes(code.trimEnd()));
  assert.match(back.markdown, /````javascript/);
});

test('Mermaid imports as portable code and exports with its language', () => {
  const result = markdownToStorage('```mermaid\ngraph TD\n A --> B\n```\n');
  const back = storageToMarkdown(result.storage, context);
  assert.match(back.markdown, /```mermaid\ngraph TD\n A --> B/);
});

test('native Mermaid macros export as code and restore unchanged macro XML', () => {
  const storage = '<ac:structured-macro ac:name="mermaid" ac:macro-id="m1"><ac:plain-text-body><![CDATA[graph TD\n A --> B]]></ac:plain-text-body></ac:structured-macro>';
  const back = storageToMarkdown(storage, context);
  assert.match(back.markdown, /```mermaid/);
  assert.equal(markdownToStorage(back.markdown, { preserved: back.preserved }).storage.trim(), storage);
});

test('unconvertible macros become page URLs and retain their original XML for re-upload', () => {
  const storage = '<ac:structured-macro ac:name="jira" ac:macro-id="m2"><ac:parameter ac:name="key">PROJ-1</ac:parameter></ac:structured-macro>';
  const back = storageToMarkdown(storage, context);
  assert.ok(back.markdown.includes(context.pageUrl));
  assert.equal(back.preserved.length, 1);
  assert.equal(markdownToStorage(back.markdown, { preserved: back.preserved }).storage.trim(), storage);
});

test('page links, attachments, mentions, and complex tables retain a useful reference', () => {
  const storage = '<p><ac:link><ri:page ri:content-id="99"/><ac:plain-text-link-body><![CDATA[Other page]]></ac:plain-text-link-body></ac:link></p><ac:image ac:alt="diagram"><ri:attachment ri:filename="diagram.png"/></ac:image><p><ac:link><ri:user ri:account-id="u1"/></ac:link></p><table><tr><td colspan="2">merged</td></tr></table>';
  const back = storageToMarkdown(storage, context);
  assert.match(back.markdown, /pageId=99/);
  assert.match(back.markdown, /diagram\.png/);
  assert.ok(back.preserved.length >= 2);
});

test('unsafe links and active raw HTML cannot execute on upload', () => {
  const result = markdownToStorage('<script>alert(1)</script>\n\n<a href="javascript:alert(1)">bad</a>');
  assert.doesNotMatch(result.storage, /<script|href="javascript:/);
});

test('footnote identifiers and definitions survive a storage round trip', () => {
  const result = markdownToStorage('Fact.[^source-a]\n\n[^source-a]: Source A\n');
  const back = storageToMarkdown(result.storage, context);
  assert.match(back.markdown, /\[\^source-a\]/);
  assert.match(back.markdown, /\[\^source-a\]: Source A/);
});

test('code blank lines and inline reference placement survive conversion', () => {
  const body = '```text\nfirst\n\n\nlast\n```\n\nSee ![image](https://example.com/x.png) here.';
  const back = storageToMarkdown(markdownToStorage(body).storage, context);
  assert.ok(back.markdown.includes('first\n\n\nlast'));
  assert.ok(back.markdown.includes('See ![image](https://example.com/x.png) here.'));
});

test('nested rich macros preserve their original complete XML', () => {
  const storage = '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Important</p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">json</ac:parameter><ac:plain-text-body><![CDATA[{"a":1}]]></ac:plain-text-body></ac:structured-macro></ac:rich-text-body></ac:structured-macro>';
  const back = storageToMarkdown(storage, context);
  assert.match(back.markdown, /confluence-info/);
  assert.match(back.markdown, /```json/);
  assert.equal(back.preserved.length, 1);
  assert.equal(markdownToStorage(back.markdown, { preserved: back.preserved }).storage, storage);
});

test('code and images inside tasks leave no internal placeholders', () => {
  const storage = markdownToStorage('- [x] item\n\n  ```js\n  const a = 1;\n  ```\n\n  ![image](https://example.com/x.png)\n').storage;
  assert.doesNotMatch(storage, /data-cfwiki/);
  assert.match(storage, /const a = 1/);
  assert.match(storage, /ri:url/);
});

test('loose task lists keep checked state through two conversions', () => {
  const original = '- [x] first\n\n- [ ] second\n';
  const first = storageToMarkdown(markdownToStorage(original).storage, context);
  const second = storageToMarkdown(markdownToStorage(first.markdown).storage, context);
  assert.match(second.markdown, /\[x\] first/);
  assert.match(second.markdown, /\[ \] second/);
});

test('Confluence-stripped HTML IDs do not lose footnote identifiers', () => {
  const storage = markdownToStorage('Fact.[^source]\n\n[^source]: Evidence\n').storage.replace(/ id="[^"]*"/g, '');
  assert.match(storage, /<ac:parameter ac:name="">fnrefsource<\/ac:parameter>/);
  const back = storageToMarkdown(storage, context);
  assert.match(back.markdown, /\[\^source\]: Evidence/);
  assert.doesNotMatch(back.markdown, /Confluence: anchor/);
});
