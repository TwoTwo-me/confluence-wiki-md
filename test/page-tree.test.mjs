import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadTree, exportBundle, markdownFiles, searchLocal } from '../src/wiki.mjs';
import { safePageTitle } from '../src/page-tree.mjs';
import { parseDocument } from '../src/document.mjs';

async function fixture(t, definitions) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-tree-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pages = new Map(definitions.map((page) => [page.id, { title: 'Page ' + page.id, parentId: null, version: 1, status: 'current', spaceId: '1', spaceKey: 'TEST', storage: '<p>Content</p>', ...page }]));
  const calls = [];
  const api = {
    config: { deployment: 'cloud', apiUrl: 'https://wiki.test/wiki/api/v2', siteUrl: 'https://wiki.test', webBase: 'https://wiki.test/wiki' },
    pageUrl: (id) => 'https://wiki.test/wiki/pages/viewpage.action?pageId=' + id,
    getPage: async (id) => ({ ...pages.get(id), url: api.pageUrl(id) }),
    getProperty: async () => null,
    labels: async () => [],
    attachments: async () => [],
    listPages: async (options) => { calls.push(options); return [...pages.values()].filter((page) => !options.parent || page.parentId === options.parent).slice(0, options.limit); },
  };
  return { directory, pages, api, calls };
}

test('space export builds ancestor folders and encodes links to siblings, parents and unique page titles', async (t) => {
  const f = await fixture(t, [
    { id: '1111', title: '안녕 # (root)', storage: '<p><a href="https://wiki.test/wiki/pages/2222/child#section">Child</a></p><ac:link><ri:page ri:content-title="index"/></ac:link>' },
    { id: '2222', parentId: '1111', title: '어서와', storage: '<p><a href="https://wiki.test/wiki/pages/viewpage.action?pageId=1111#hello">Parent</a></p><ac:link><ri:page ri:content-id="3333"/></ac:link>' },
    { id: '3333', parentId: '1111', title: 'index' },
    { id: '4444', parentId: '3333', title: 'log' },
  ]);
  const result = await exportBundle(f.api, f.directory);
  assert.equal(result.pages, 4);
  const root = parseDocument(await readFile(path.join(f.directory, '1111/안녕 # (root).md'), 'utf8'));
  const child = parseDocument(await readFile(path.join(f.directory, '1111/2222/어서와.md'), 'utf8'));
  assert.match(root.body, /\.\/2222\/%EC%96%B4%EC%84%9C%EC%99%80\.md#section/);
  assert.match(root.body, /\.\/3333\/index\.md/);
  assert.match(child.body, /\.\.\/%EC%95%88%EB%85%95%20%23%20%28root%29\.md#hello/);
  assert.match(child.body, /\.\.\/3333\/index\.md/);
  assert.equal(root.metadata.confluence.base_body_hash.startsWith('sha256:'), true);
  assert.deepEqual((await markdownFiles(f.directory)).map((file) => path.basename(file)).sort(), ['index.md', 'log.md', '안녕 # (root).md', '어서와.md'].sort());
  assert.equal((await searchLocal(f.directory, 'Content')).length, 2);
  assert.equal((await readdir(f.directory)).includes('index.md'), false);
});

test('duplicate titles retain remote title-only references and remain distinct by numeric ID', async (t) => {
  const f = await fixture(t, [
    { id: '1', title: 'Same', storage: '<ac:link><ri:page ri:content-title="Same"/></ac:link>' },
    { id: '2', title: 'Same' },
    { id: '3', title: '../bad\\name:*?' },
  ]);
  await exportBundle(f.api, f.directory);
  const body = parseDocument(await readFile(path.join(f.directory, '1/Same.md'), 'utf8')).body;
  assert.match(body, /https:\/\/wiki.test\/wiki\/pages\/viewpage.action/);
  assert.ok(await readFile(path.join(f.directory, '2/Same.md'), 'utf8'));
  assert.equal((await readdir(path.join(f.directory, '3'))).filter((file) => file.endsWith('.md')).length, 1);
  assert.equal(safePageTitle('CON'), '_CON');
  assert.equal(safePageTitle('..'), '_');
  assert.ok(Buffer.byteLength(safePageTitle('가'.repeat(200))) <= 180);
});

test('a clean title rename replaces one tracked Markdown, but preserves stale files with local edits', async (t) => {
  const f = await fixture(t, [{ id: '1', title: 'Before' }]);
  await downloadTree(f.api, '1', f.directory);
  f.pages.get('1').title = 'After';
  await assert.rejects(downloadTree(f.api, '1', f.directory), /requires --overwrite/);
  await downloadTree(f.api, '1', f.directory, { overwrite: true });
  assert.deepEqual(await readdir(path.join(f.directory, '1')), ['After.md']);
  await writeFile(path.join(f.directory, '1/After.md'), (await readFile(path.join(f.directory, '1/After.md'), 'utf8')).replace('Content', 'Local edit'));
  f.pages.get('1').title = 'Newest';
  await assert.rejects(downloadTree(f.api, '1', f.directory, { overwrite: true }), /local edits/);
  assert.match(await readFile(path.join(f.directory, '1/After.md'), 'utf8'), /Local edit/);
  assert.deepEqual(await readdir(path.join(f.directory, '1')), ['After.md']);
});

test('moving a page updates tracked paths without leaving a duplicate page', async (t) => {
  const f = await fixture(t, [{ id: '1' }, { id: '2' }]);
  await exportBundle(f.api, f.directory);
  f.pages.get('2').parentId = '1';
  await exportBundle(f.api, f.directory, { overwrite: true });
  assert.ok(await readFile(path.join(f.directory, '1/2/Page 2.md'), 'utf8'));
  assert.equal((await markdownFiles(f.directory)).length, 2);
});

test('case-only title changes leave exactly the requested filename on every filesystem', async (t) => {
  const f = await fixture(t, [{ id: '1', title: 'Before' }]);
  await downloadTree(f.api, '1', f.directory);
  f.pages.get('1').title = 'before';
  await downloadTree(f.api, '1', f.directory, { overwrite: true });
  assert.deepEqual(await readdir(path.join(f.directory, '1')), ['before.md']);
  assert.equal(parseDocument(await readFile(path.join(f.directory, '1/before.md'), 'utf8')).metadata.title, 'before');
});

test('attachments stay beside their page without colliding with Markdown pages or numeric child folders', async (t) => {
  const f = await fixture(t, [{ id: '1', title: 'Photo', storage: '<ac:image><ri:attachment ri:filename="hello image.png"/></ac:image><ac:link><ri:attachment ri:filename="notes.md"/></ac:link>' }, { id: '2', parentId: '1' }]);
  f.api.attachments = async (id) => id === '1' ? [{ id: 'att90', title: 'hello image.png' }, { id: '91', title: 'notes.md' }, { id: '92', title: '2' }] : [];
  f.api.downloadAttachment = async (_id, attachment) => Buffer.from(attachment.title);
  await downloadTree(f.api, '1', f.directory, { assets: true, recursive: true });
  const files = await readdir(path.join(f.directory, '1'));
  assert.deepEqual(files.sort(), ['Photo.md', 'hello image.png', 'attachment-91-notes.md.attachment', 'attachment-92-2', '2'].sort());
  const doc = parseDocument(await readFile(path.join(f.directory, '1/Photo.md'), 'utf8'));
  assert.match(doc.body, /\.\/hello%20image.png/);
  assert.match(doc.body, /\.\/attachment-91-notes.md.attachment/);
  assert.equal(doc.metadata.confluence.attachment_files['./attachment-91-notes.md.attachment'], 'notes.md');
  assert.equal((await markdownFiles(f.directory)).length, 2);
});

test('limits, cycles, unrelated Markdown and symlink folders fail before local writes', async (t) => {
  const f = await fixture(t, [{ id: '1' }, { id: '2', parentId: '1' }]);
  await assert.rejects(downloadTree(f.api, '1', f.directory, { recursive: true, limit: 1 }), /exceeds --limit/);
  assert.deepEqual(await readdir(f.directory), []);
  f.pages.get('1').parentId = '2';
  await assert.rejects(exportBundle(f.api, f.directory), /Cycle detected/);
  assert.deepEqual(await readdir(f.directory), []);
  await assert.rejects(downloadTree(f.api, '1', f.directory, { recursive: true }), /Cycle or duplicate parent/);
  f.pages.get('1').parentId = null;
  await mkdir(path.join(f.directory, '1'));
  await writeFile(path.join(f.directory, '1/local.md'), 'My work');
  await assert.rejects(downloadTree(f.api, '1', f.directory, { overwrite: true }), /another Markdown/);
  assert.equal(await readFile(path.join(f.directory, '1/local.md'), 'utf8'), 'My work');
  const other = path.join(f.directory, 'other');
  await mkdir(other);
  await symlink(other, path.join(f.directory, '2'));
  await assert.rejects(downloadTree(f.api, '2', f.directory, { overwrite: true }), /real directory/);
  assert.deepEqual(await readdir(other), []);
});

test('legacy navigation metadata stays excluded while real index and log files are searched', async (t) => {
  const f = await fixture(t, []);
  await writeFile(path.join(f.directory, 'index.md'), '---\nokf_version: "0.2"\n---\n# Confluence wiki\n');
  await mkdir(path.join(f.directory, '1'));
  await writeFile(path.join(f.directory, '1/index.md'), '---\ntitle: index\nconfluence:\n  id: "1"\n---\nReal index');
  await writeFile(path.join(f.directory, 'log.md'), '# Real log');
  assert.equal((await markdownFiles(f.directory)).length, 2);
});
