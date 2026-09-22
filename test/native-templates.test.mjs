import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateTemplate, prepareNativeTemplate } from '../src/native-templates.mjs';
import { loadTemplate } from '../src/templates.mjs';
import { markdownToStorage } from '../src/document.mjs';

const config = { templateApiUrl: 'https://wiki.example.test/rest/api', webBase: 'https://wiki.example.test', spaceKey: 'TEST', diagramProfile: {} };
const native = { id: '42', name: 'Runbook', space: 'TEST', labels: ['runbook'], storage: '<h2>Team header</h2><ac:structured-macro ac:name="toc"/><p>{{cfwiki.body}}</p><p>Team footer</p>' };
const doc = { metadata: { title: 'My page' }, body: '# My body\n\n| Name | Value |\n| --- | --- |\n| A | 1 |\n\n```js\nconst x = 1;\n```\n' };

test('native ID selection requires no file and supports qualified blueprint IDs', async () => {
  assert.equal((await loadTemplate(undefined, { env: { CONFLUENCE_TEMPLATE: '42' } })).id, '42');
  assert.equal((await loadTemplate('confluence:com.example:runbook')).id, 'com.example:runbook');
  await assert.rejects(loadTemplate('confluence:../42'), /Invalid/);
});

test('native template inserts Markdown at its slot and returns the complete editable document', () => {
  const result = instantiateTemplate(doc, native, config);
  assert.equal(result.metadata.title, 'My page');
  assert.equal(result.metadata.confluence.template_id, '42');
  assert.ok(result.body.includes(doc.body));
  assert.ok(result.body.indexOf('Team header') < result.body.indexOf('# My body'));
  assert.ok(result.body.indexOf('Team footer') > result.body.indexOf('const x = 1;'));
  const storage = markdownToStorage(result.body, { preserved: result.metadata.confluence.preserved }).storage;
  assert.equal((storage.match(/ac:name="toc"/g) ?? []).length, 1);
  assert.doesNotMatch(storage, /cfwiki.body|CFWIKIBODY/);
  assert.match(storage, /<table>/);
});

test('templates without a slot append the document; incompatible variables and attachments fail clearly', () => {
  const result = instantiateTemplate(doc, { ...native, storage: '<p>Prefix</p>' }, config);
  assert.ok(result.body.indexOf('Prefix') < result.body.indexOf('# My body'));
  for (const storage of ['<p>{{cfwiki.body}}</p><p>{{cfwiki.body}}</p>', '<p>Inline {{cfwiki.body}} value</p>', '<at:var at:name="user"/>', '<ac:image><ri:attachment ri:filename="image.png"/></ac:image>', '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>{{cfwiki.body}}</p></ac:rich-text-body></ac:structured-macro>']) {
    assert.throws(() => instantiateTemplate(doc, { ...native, storage }, config));
  }
  assert.throws(() => instantiateTemplate(doc, native, config, 'OTHER'), /another space/);
  assert.throws(() => instantiateTemplate(doc, { ...native, storage: '<table><tr><td><p>{{cfwiki.body}}</p></td></tr></table>' }, config), /outside tables/);
  assert.throws(() => instantiateTemplate(doc, { ...native, storage: '<blockquote><p>{{cfwiki.body}}</p></blockquote>' }, config), /outside tables/);
});

test('existing pages and already initialized drafts do not refetch or duplicate their template', async () => {
  let reads = 0;
  const api = { config, getTemplate: async () => { reads++; return native; } };
  const template = await loadTemplate('42');
  const initialized = await prepareNativeTemplate(api, doc, template);
  const repeated = await prepareNativeTemplate(api, initialized, template);
  assert.equal(repeated.body, initialized.body);
  const existing = { ...doc, metadata: { confluence: { id: '9', version: 1 } } };
  assert.equal(await prepareNativeTemplate(api, existing, template), existing);
  assert.equal(reads, 1);
  await assert.rejects(prepareNativeTemplate(api, initialized, await loadTemplate('43')), /different/);
});
