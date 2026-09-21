import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { prepareDiagrams, diagramProfile } from '../src/diagrams.mjs';
import { markdownToStorage, storageToMarkdown } from '../src/document.mjs';

const extensionKey = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/static/plantuml';
const env = {
  CONFLUENCE_PLANTUML_MACRO: 'plantuml',
  CONFLUENCE_PLANTUML_FORGE_EXTENSION_KEY: extensionKey,
  CONFLUENCE_PLANTUML_SOURCE_PARAMETER: 'source',
};
const validator = async () => [];
const source = '@startuml\nAlice -> Bob: hello & <world>\n@enduml\n';
const fixture = '<ac:adf-extension><ac:adf-node type="extension"><ac:adf-attribute key="extension-type">com.atlassian.ecosystem</ac:adf-attribute><ac:adf-attribute key="extension-key">' + extensionKey + '</ac:adf-attribute><ac:adf-attribute key="parameters"><ac:adf-parameter key="local-id">33333333-3333-4333-8333-333333333333</ac:adf-parameter><ac:adf-parameter key="guest-params"><ac:adf-parameter key="source">@startuml\nAlice -&gt; Bob: hello &amp; &lt;world&gt;\n@enduml\n</ac:adf-parameter></ac:adf-parameter></ac:adf-attribute></ac:adf-node></ac:adf-extension>';

test('Forge source parameters publish escaped diagram source through the configured extension', async () => {
  const body = '```plantuml\n' + source + '```';
  const prepared = await prepareDiagrams(body, { env, requireMacros: true, validator });
  const storage = markdownToStorage(body, { diagrams: prepared.macros }).storage;
  const $ = load(storage, { xmlMode: true });
  assert.equal($('ac\\:adf-extension').length, 1);
  assert.equal($('ac\\:adf-node').first().children('[key="extension-key"]').text(), extensionKey);
  assert.equal($('ac\\:adf-node').first().find('[key="source"]').text(), source);
});

test('native Forge diagrams download as editable fences without exposing extension internals', () => {
  const result = storageToMarkdown(fixture, { diagramProfile: diagramProfile(env) });
  assert.equal(result.markdown.trim(), '```plantuml\n' + source + '```');
  assert.equal(result.preserved.length, 1);
});

test('unconfigured Forge extensions download as a URL and preserve their storage', () => {
  const pageUrl = 'https://wiki.example.test/pages/123';
  const result = storageToMarkdown(fixture, { pageUrl });
  assert.match(result.markdown, /\]\(https:\/\/wiki\.example\.test\/pages\/123\)/);
  assert.doesNotMatch(result.markdown, /33333333|com\.atlassian\.ecosystem|hello/);
  assert.equal(result.preserved[0].storage, fixture);
});

test('repeated diagram fences receive different Forge local IDs', async () => {
  const body = ('```plantuml\n' + source + '```\n\n').repeat(2);
  const prepared = await prepareDiagrams(body, { env, requireMacros: true, validator });
  const $ = load(markdownToStorage(body, { diagrams: prepared.macros }).storage, { xmlMode: true });
  const ids = $('ac\\:adf-extension').map((_i, node) => $(node).children('ac\\:adf-node').find('ac\\:adf-parameter[key="local-id"]').text()).get();
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
});

const viewerEnv = {
  CONFLUENCE_MERMAID_MACRO: 'mermaid-diagram',
  CONFLUENCE_MERMAID_FORGE_EXTENSION_KEY: extensionKey.replace(/plantuml$/, 'mermaid-diagram'),
  CONFLUENCE_MERMAID_ADAPTER: 'mermaid-viewer',
};

test('Mermaid viewer indexes refer to all code blocks and remain integers', async () => {
  const body = '```js\nconst answer = 42;\n```\n\n' + '```mermaid\nflowchart LR\n A-->B\n```\n\n'.repeat(2);
  const prepared = await prepareDiagrams(body, { env: viewerEnv, requireMacros: true, validator });
  const result = markdownToStorage(body, { diagrams: prepared.macros });
  const $ = load(result.storage, { xmlMode: true });
  const indexes = $('ac\\:adf-extension').map((_i, node) => {
    const index = $(node).children('ac\\:adf-node').find('[key="index"]');
    assert.equal(index.attr('type'), 'integer');
    return index.text();
  }).get();
  assert.deepEqual(indexes, ['1', '2']);
  assert.doesNotMatch(result.storage, /data-cfwiki/);
  const downloaded = storageToMarkdown(result.storage, { diagramProfile: diagramProfile(viewerEnv) });
  assert.equal((downloaded.markdown.match(/```mermaid/g) ?? []).length, 2);
  assert.equal((downloaded.markdown.match(/A-->B/g) ?? []).length, 2);
  assert.match(downloaded.markdown, /const answer = 42/);
});

test('Forge diagrams inside rich macros retain their source and complete wrapper', () => {
  const storage = '<ac:structured-macro ac:name="expand"><ac:rich-text-body>' + fixture + '</ac:rich-text-body></ac:structured-macro>';
  const result = storageToMarkdown(storage, { diagramProfile: diagramProfile(env) });
  assert.match(result.markdown, /hello & <world>/);
  assert.doesNotMatch(result.markdown, /CFWIKISNIPPET/);
  assert.equal(result.preserved.length, 1);
  assert.equal(result.preserved[0].storage, storage);
});

test('invalid Mermaid viewer indexes retain a URL and the unconsumed source block', async () => {
  const body = '```mermaid\nflowchart LR\n A-->B\n```';
  const prepared = await prepareDiagrams(body, { env: viewerEnv, requireMacros: true, validator });
  const storage = markdownToStorage(body, { diagrams: prepared.macros }).storage.replaceAll('type="integer">0', 'type="integer">99');
  const result = storageToMarkdown(storage, { diagramProfile: diagramProfile(viewerEnv), pageUrl: 'https://wiki.example.test/123' });
  assert.match(result.markdown, /A-->B/);
  assert.match(result.markdown, /Confluence: Forge macro/);
  assert.equal(result.warnings.length, 1);
});
