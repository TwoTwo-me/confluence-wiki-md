import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDiagrams } from '../src/diagrams.mjs';
import { upload, download } from '../src/wiki.mjs';
import { formatDocument } from '../src/document.mjs';
import { diagramProfile } from '../src/diagrams.mjs';

test('real Mermaid and PlantUML engines accept flowcharts, sequence and class diagrams', async () => {
  const body = '```mermaid\nflowchart TD\n A[Start] --> B[End]\n```\n\n```uml\n@startuml\nAlice -> Bob: request\nBob --> Alice: response\n@enduml\n```\n\n```plantuml\n@startuml\nclass Customer\nclass Order\nCustomer "1" -- "many" Order\n@enduml\n```';
  const result = await prepareDiagrams(body);
  assert.equal(result.checks.length, 3);
  assert.ok(result.checks.every((check) => check.version && check.version !== 'unknown'));
});

test('real Mermaid rejects invalid input with its document position', async () => {
  await assert.rejects(prepareDiagrams('# Title\n\n```mermaid\ngraph TD\n A[broken\n```', { lineOffset: 4 }), /mermaid at Markdown line 7/);
});

test('real PlantUML rejects invalid input and external file includes', async () => {
  await assert.rejects(prepareDiagrams('```uml\n@startuml\nthis is not valid uml @@@\n@enduml\n```'), /uml at Markdown line 1/);
  await assert.rejects(prepareDiagrams('```plantuml\n@startuml\n!include /etc/passwd\n@enduml\n```'), /plantuml at Markdown line 1/);
});

test('invalid diagrams stop upload before any Confluence request', async () => {
  const api = { config: {}, getSpace: async () => { throw new Error('Unexpected API request'); } };
  await assert.rejects(upload(api, '# Invalid\n\n```mermaid\ngraph TD\n A[broken\n```'), /mermaid at Markdown line 3/);
});

test('real validated diagrams survive native macro create, download, edit and update', async () => {
  const env = { CONFLUENCE_MERMAID_MACRO: 'mermaid-chart', CONFLUENCE_PLANTUML_MACRO: 'plantuml', CONFLUENCE_PLANTUML_SOURCE_PARAMETER: 'source' };
  let page; let property; let previews = 0; let labels = [];
  const api = {
    config: { siteUrl: 'https://wiki.example.test', apiUrl: 'https://wiki.example.test/rest/api', webBase: 'https://wiki.example.test', spaceKey: 'TEST', deployment: 'datacenter', diagramProfile: diagramProfile(env) },
    getSpace: async () => ({ id: '1', key: 'TEST' }),
    previewStorage: async (storage) => { assert.match(storage, /ac:name="mermaid-chart"/); assert.match(storage, /ac:name="source"/); previews++; return { verified: true }; },
    writePage: async (input) => { page = { ...input, id: '42', spaceId: '1', spaceKey: 'TEST', version: (page?.version ?? 0) + 1, status: 'current', url: 'https://wiki.example.test/pages/42' }; return page; },
    getPage: async () => page,
    getProperty: async () => ({ value: property }),
    setProperty: async (_id, value) => { property = value; },
    labels: async () => labels.map((name) => ({ name })),
    setLabels: async (_id, names) => { labels = names; },
  };
  const body = '# Native diagrams\n\n```mermaid\ngraph TD; A-->B\n```\n\n```uml\nAlice -> Bob: first\n```';
  await upload(api, body, { diagramEnv: env });
  assert.doesNotMatch(page.storage, /ac:name="code"|<ac:image/);
  assert.match(page.storage, /@startuml/);
  page.storage += '<p>Edited in browser</p>';
  page.version++;
  const doc = await download(api, '42');
  assert.match(doc.body, /```mermaid/);
  assert.match(doc.body, /```plantuml/);
  doc.body = doc.body.replace('first', 'second');
  await upload(api, formatDocument(doc), { diagramEnv: env });
  assert.equal(page.version, 3);
  assert.match(page.storage, /second/);
  assert.equal(previews, 2);
});
