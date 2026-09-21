import test from 'node:test';
import assert from 'node:assert/strict';
import { diagramBlocks, diagramProfile, prepareDiagrams, withoutDiagramPreservation } from '../src/diagrams.mjs';
import { markdownToStorage, storageToMarkdown } from '../src/document.mjs';
import { upload } from '../src/wiki.mjs';

const env = { CONFLUENCE_MERMAID_MACRO: 'mermaid-chart', CONFLUENCE_PLANTUML_MACRO: 'plantuml', CONFLUENCE_PLANTUML_SOURCE_PARAMETER: 'source', CONFLUENCE_PLANTUML_PARAMETERS: '{"theme":"plain"}' };
const validator = async (blocks) => blocks.map((block) => ({ language: block.language, engine: block.engine, version: 'fixture', line: block.line }));

test('diagram detection uses Markdown parsing, language aliases and original line positions', () => {
  const blocks = diagramBlocks('Text\n\n> ```Mermaid\n> graph TD; A-->B\n> ```\n\n```uml\nAlice -> Bob\n```\n\n````text\n```mermaid\nnot a diagram\n```\n````', 3);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => [block.engine, block.line]), [['mermaid', 6], ['plantuml', 10]]);
});

test('validated diagrams replace code macros and preserve non-diagram code fences', async () => {
  const body = '```mermaid\ngraph TD; A-->B\n```\n\n```js\nconst x = 1;\n```';
  const prepared = await prepareDiagrams(body, { env, requireMacros: true, validator });
  const storage = markdownToStorage(body, { diagrams: prepared.macros }).storage;
  assert.match(storage, /ac:name="mermaid-chart"/);
  assert.match(storage, /ac:name="code"/);
  assert.match(storage, /<!\[CDATA\[graph TD; A-->B/);
});

test('parameter-based diagram apps round-trip to editable fenced sources', async () => {
  const body = '```plantuml\n@startuml\nAlice -> Bob: hello & <world>\n@enduml\n```';
  const prepared = await prepareDiagrams(body, { env, requireMacros: true, validator });
  const storage = markdownToStorage(body, { diagrams: prepared.macros }).storage;
  assert.match(storage, /ac:name="source"/);
  assert.match(storage, /hello &amp; &lt;world&gt;/);
  const downloaded = storageToMarkdown(storage, { diagramProfile: diagramProfile(env) });
  assert.match(downloaded.markdown, /```plantuml\n@startuml/);
  assert.match(downloaded.markdown, /hello & <world>/);
  const changed = downloaded.markdown.replace('hello', 'updated');
  const next = await prepareDiagrams(changed, { env, requireMacros: true, validator });
  const updated = markdownToStorage(changed, { diagrams: next.macros, preserved: withoutDiagramPreservation(downloaded.preserved, true) }).storage;
  assert.match(updated, /ac:name="plantuml"/);
  assert.match(updated, /updated/);
  assert.doesNotMatch(updated, /ac:name="code"/);
});

test('missing macro configuration fails instead of silently publishing code or images', async () => {
  await assert.rejects(prepareDiagrams('```mermaid\ngraph TD; A-->B\n```', { requireMacros: true, validator }), /CONFLUENCE_MERMAID_MACRO/);
  const result = await prepareDiagrams('```mermaid\ninvalid\n```', { mode: 'code', requireMacros: true, validator });
  assert.deepEqual(result.blocks, []);
  assert.deepEqual(result.macros, {});
});

test('diagram validation failures include position and prevent native macro generation', async () => {
  await assert.rejects(prepareDiagrams('```mermaid\nbad\n```', { env, requireMacros: true, validator: async (blocks) => { throw new Error('Invalid syntax at line ' + blocks[0].line); } }), /Invalid syntax at line 1/);
  assert.throws(() => diagramProfile({ CONFLUENCE_MERMAID_MACRO: '<unsafe>' }), /valid macro name/);
});

test('server macro rejection prevents page writes after successful local validation', async () => {
  const body = '# Diagram\n\n```mermaid\ngraph TD; A-->B\n```';
  const prepared = await prepareDiagrams(body, { env, requireMacros: true, validator });
  let writes = 0;
  const api = {
    config: { siteUrl: 'https://wiki.example.test', apiUrl: 'https://wiki.example.test/rest/api' },
    getSpace: async () => ({ id: '1', key: 'TEST' }),
    previewStorage: async (storage) => { assert.match(storage, /mermaid-chart/); throw new Error('Server rejected macro'); },
    writePage: async () => { writes++; },
  };
  await assert.rejects(upload(api, body, { preparedDiagrams: prepared }), /Server rejected macro/);
  assert.equal(writes, 0);
});
