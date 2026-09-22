import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';
import { parseTemplate, loadTemplate, templateDiagrams, applyTemplate } from '../src/templates.mjs';
import { prepareDiagrams } from '../src/diagrams.mjs';
import { markdownToStorage, storageToMarkdown, formatDocument } from '../src/document.mjs';
import { upload, pushBundle } from '../src/wiki.mjs';

test('template selection resolves env paths beside the profile and CLI paths beside the working directory', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-template-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profileDir = path.join(directory, 'profile');
  await mkdir(profileDir);
  await writeFile(path.join(profileDir, 'wiki.yaml'), 'version: 1\ntoc:\n  position: bottom\n');
  await writeFile(path.join(directory, 'wiki.yaml'), 'version: 1\ntoc:\n  enabled: false\n');
  const options = { cwd: directory, envFile: path.join(profileDir, '.env'), env: { CONFLUENCE_TEMPLATE: 'wiki.yaml' } };
  assert.equal((await loadTemplate(undefined, options)).toc.position, 'bottom');
  assert.equal((await loadTemplate('wiki.yaml', options)).toc.enabled, false);
  assert.equal(await loadTemplate('none', { ...options, env: { CONFLUENCE_TEMPLATE: 'missing.yaml' } }), null);
  assert.equal((await loadTemplate('default', options)).toc.parameters.maxLevel, '3');
  assert.equal(await loadTemplate(undefined), null);
  await assert.rejects(loadTemplate('missing.yaml', options), /ENOENT/);
});

test('template schema rejects ambiguous or unsupported settings without accepting credential fields', () => {
  for (const yaml of [
    'version: 2', 'version: 1\nversion: 1', 'version: 1\ntoken: secret', 'version: 1\ntoc: false',
    'version: 1\ntoc:\n  position: middle', 'version: 1\ntoc:\n  enabled: "false"',
    'version: 1\ntoc:\n  parameters:\n    maxLevel: 7',
    'version: 1\ntoc:\n  parameters:\n    minLevel: 4\n    maxLevel: 2',
    'version: 1\ndiagrams:\n  mode: image', 'version: 1\ndiagrams:\n  uml: {}',
    'version: 1\ndiagrams:\n  mermaid:\n    parameters:\n      theme: [dark]',
  ]) assert.throws(() => parseTemplate(yaml));
  assert.throws(() => parseTemplate('x'.repeat(65537)), /64 KB/);
});

test('fixed TOC replaces existing TOCs once and preserves code text, tables and other macros', async () => {
  const template = await loadTemplate('default');
  const old = '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">6</ac:parameter></ac:structured-macro>';
  const body = '<h2>Heading</h2><table><tr><td rowspan="2">Value</td></tr><tr><td>Next</td></tr></table><ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[<ac:structured-macro ac:name="toc"/>]]></ac:plain-text-body></ac:structured-macro><ac:structured-macro ac:name="include"><ac:parameter ac:name="">DOCS:Page</ac:parameter></ac:structured-macro>';
  const result = applyTemplate(old + body + old, template);
  const $ = load(result, { xmlMode: true });
  assert.equal($('ac\\:structured-macro[ac\\:name="toc"]').length, 1);
  assert.equal($.root().children().first().attr('ac:name'), 'toc');
  assert.equal($('ac\\:structured-macro[ac\\:name="toc"] ac\\:parameter[ac\\:name="maxLevel"]').text(), '3');
  assert.equal($('td[rowspan]').attr('rowspan'), '2');
  assert.equal($('ac\\:plain-text-body').text(), '<ac:structured-macro ac:name="toc"/>');
  assert.equal($('ac\\:structured-macro[ac\\:name="include"]').length, 1);
  assert.equal(applyTemplate(result, template), result);
  assert.equal(applyTemplate(old + body, null), old + body);
  assert.equal(load(applyTemplate(result, parseTemplate('version: 1\ntoc:\n  enabled: false')), { xmlMode: true })('ac\\:structured-macro[ac\\:name="toc"]').length, 0);
});

test('custom TOC location and XML-sensitive parameters survive serialization', () => {
  const template = parseTemplate('version: 1\ntoc:\n  position: bottom\n  parameters:\n    include: "API & <Guide>"\n    printable: false\n    minLevel: 2');
  const $ = load(applyTemplate('<h2>API &amp; Guide</h2>', template), { xmlMode: true });
  assert.equal($.root().children().last().attr('ac:name'), 'toc');
  assert.equal($('ac\\:parameter[ac\\:name="include"]').text(), 'API & <Guide>');
  assert.equal($('ac\\:parameter[ac\\:name="printable"]').text(), 'false');
});

test('diagram settings merge template parameters over env and explicit mode wins', async () => {
  const env = { CONFLUENCE_MERMAID_MACRO: 'old-mermaid', CONFLUENCE_MERMAID_PARAMETERS: '{"theme":"old","width":"100"}', CONFLUENCE_DIAGRAM_MODE: 'code' };
  const template = parseTemplate('version: 1\ndiagrams:\n  mode: macro\n  mermaid:\n    macro: team-mermaid\n    parameters:\n      theme: plain\n      height: 200');
  const selected = templateDiagrams(template, env);
  assert.equal(selected.mode, 'macro');
  assert.deepEqual(JSON.parse(selected.env.CONFLUENCE_MERMAID_PARAMETERS), { theme: 'plain', width: '100', height: '200' });
  assert.equal(env.CONFLUENCE_MERMAID_MACRO, 'old-mermaid');
  assert.equal(templateDiagrams(template, env, 'code').mode, 'code');
  assert.equal(templateDiagrams(null, env).mode, 'code');
  assert.throws(() => templateDiagrams(null, {}, 'invalid'), /mode/);
  const markdown = '```mermaid\ngraph LR; A-->B\n```';
  const prepared = await prepareDiagrams(markdown, { ...selected, requireMacros: true, validator: async () => [] });
  const storage = markdownToStorage(markdown, { diagrams: prepared.macros }).storage;
  assert.match(storage, /ac:name="team-mermaid"/);
  assert.match(storage, /ac:name="theme">plain/);
  assert.match(storageToMarkdown(storage, { diagramProfile: prepared.profile }).markdown, /graph LR; A-->B/);
});

test('TOC server rejection prevents upload and bundle placeholder creation before writes', async (t) => {
  const template = await loadTemplate('default');
  let writes = 0;
  const api = {
    config: { siteUrl: 'https://wiki.example.test', apiUrl: 'https://wiki.example.test/rest/api', spaceKey: 'TEST' },
    getSpace: async () => ({ id: '1', key: 'TEST' }),
    previewStorage: async (storage) => { assert.match(storage, /ac:name="toc"/); throw new Error('TOC rejected'); },
    writePage: async () => { writes++; },
  };
  const input = '---\ntitle: Template test\n---\n## Heading\n';
  await assert.rejects(upload(api, input, { template }), /TOC rejected/);
  const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-template-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'page.md'), input);
  await assert.rejects(pushBundle(api, directory, { template }), /TOC rejected/);
  assert.equal(writes, 0);
});

test('code mode does not restore a preserved native diagram over the selected template mode', async () => {
  const body = '```mermaid\ngraph LR; A-->B\n```';
  const input = formatDocument({ metadata: { title: 'Code only', confluence: { preserved: [{ markdown: body, storage: '<ac:structured-macro ac:name="old-mermaid"/>' }] } }, body });
  const api = { config: {}, getSpace: async () => ({ id: '1', key: 'TEST' }) };
  const result = await upload(api, input, { dryRun: true, template: parseTemplate('version: 1\ndiagrams:\n  mode: code') });
  assert.match(result.storage, /ac:name="code"/);
  assert.doesNotMatch(result.storage, /ac:name="old-mermaid"/);
  assert.match(result.storage, /graph LR; A-->B/);
});
