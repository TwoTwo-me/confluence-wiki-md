import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectExport, nativeId, options } from './notion_text_export.mjs';
import { validateCorpus } from './collect.mjs';

const parentId = 'a'.repeat(32);
const pageId = 'b'.repeat(32);
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'notion-export-'));
  const input = path.join(root, 'input'); const output = path.join(root, 'output');
  await mkdir(input);
  try { await run({ root, input, output }); } finally { await rm(root, { recursive: true, force: true }); }
}
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('nested Unicode page and same-page CSV keep distinct native identities and parent', async () => fixture(async ({ input, output }) => {
  // Given
  const folder = '상위 페이지 ' + parentId;
  await mkdir(path.join(input, folder));
  await writeFile(path.join(input, folder, '문서 ' + pageId + '.md'), '# 문서\n[Foreign](https://www.notion.so/' + 'c'.repeat(32) + ')');
  await writeFile(path.join(input, folder, '문서 ' + pageId + '.csv'), 'Name,Value\n하나,둘');
  // When
  const result = await collectExport({ input, output });
  // Then
  const docs = validateCorpus(await json(path.join(output, 'corpus.json')));
  assert.equal(result.collected, 2);
  assert.equal(new Set(docs.map((d) => d.id)).size, 2);
  assert.deepEqual(new Set(docs.map((d) => d.source_path)), new Set([pageId, pageId + '/database.csv']));
  assert.ok(docs.every((d) => d.parent_id === parentId && d.private));
  assert.equal(result.unresolved_references, 1);
  assert.equal(result.complete, false);
}));

test('all boundary files are accounted while media and symlinks are never followed', async () => fixture(async ({ input, output }) => {
  // Given
  const files = [
    ['secret ' + '1'.repeat(32) + '.md', 'api_key = ' + 'x'.repeat(30)],
    ['binary ' + '2'.repeat(32) + '.md', Buffer.from('a\0b')],
    ['invalid ' + '3'.repeat(32) + '.csv', Buffer.from([0xff])],
    ['index.md', '# Export index'],
    ['image.png', Buffer.from([0xff, 0, 0xff])],
    ['empty ' + '4'.repeat(32) + '.md', ' \n'],
  ];
  for (const [name, bytes] of files) await writeFile(path.join(input, name), bytes);
  await symlink('/does-not-exist', path.join(input, 'linked ' + pageId + '.md'));
  // When
  const result = await collectExport({ input, output });
  // Then
  const manifest = await json(path.join(output, 'source-manifest.json'));
  assert.equal(result.files, 7);
  assert.equal(result.collected, 0);
  assert.equal(result.media_reads, 0);
  assert.equal(result.export_files_accounted, true);
  assert.deepEqual(manifest.files.map((f) => f.reason).sort(), ['secret_looking_content', 'binary_content', 'invalid_utf8', 'export_file_without_native_uuid', 'non_text_export_file', 'empty_content', 'symlink_not_followed'].sort());
  assert.ok(manifest.files.filter((f) => f.status === 'excluded').every((f) => f.bytes === undefined));
}));

test('oversized text is preserved and a verified unchanged resume avoids rewriting raw cache', async () => fixture(async ({ input, output }) => {
  // Given
  const text = '\ufeff' + '문서'.repeat(100000);
  await writeFile(path.join(input, 'Large ' + pageId + '.md'), text);
  await collectExport({ input, output });
  const before = await readFile(path.join(output, 'corpus.json'), 'utf8');
  const doc = JSON.parse(before)[0];
  const raw = path.join(output, 'raw', doc.id + '.txt');
  const modified = (await stat(raw, { bigint: true })).mtimeNs;
  // When
  const resumed = await collectExport({ input, output });
  // Then
  assert.equal(resumed.cache_hits, 1);
  assert.equal((await stat(raw, { bigint: true })).mtimeNs, modified);
  assert.equal(await readFile(path.join(output, 'corpus.json'), 'utf8'), before);
  assert.equal(doc.text, text);
  assert.ok(Buffer.byteLength(text) > 512 * 1024);
}));

test('duplicate native identities are reported and corrupted cache is refreshed', async () => fixture(async ({ input, output }) => {
  // Given
  await writeFile(path.join(input, 'A ' + pageId + '.md'), '# A');
  await writeFile(path.join(input, 'B ' + pageId + '.md'), '# B');
  await collectExport({ input, output });
  const doc = (await json(path.join(output, 'corpus.json')))[0];
  await writeFile(path.join(output, 'raw', doc.id + '.txt'), 'corrupted');
  // When
  const resumed = await collectExport({ input, output });
  // Then
  const manifest = await json(path.join(output, 'source-manifest.json'));
  assert.equal(resumed.collected, 1);
  assert.equal(resumed.cache_hits, 0);
  assert.equal(manifest.files.filter((f) => f.reason === 'duplicate_source_identity').length, 1);
  assert.equal(await readFile(path.join(output, 'raw', doc.id + '.txt'), 'utf8'), '# A');
}));

test('relative exported links resolve only to collected file paths', async () => fixture(async ({ input, output }) => {
  // Given
  const target = 'Nested 한글 ' + pageId + '.md';
  await writeFile(path.join(input, target), '# Target');
  await writeFile(path.join(input, 'Root ' + parentId + '.md'), '[Captured](' + encodeURIComponent(target) + ')\n[Missing](Missing%20' + 'c'.repeat(32) + '.md)\n![Image](photo.png)');
  // When
  await collectExport({ input, output });
  // Then
  const manifest = await json(path.join(output, 'source-manifest.json'));
  assert.deepEqual(manifest.references.map((r) => r.status).sort(), ['captured', 'unresolved']);
}));

test('real CLI handles export, help and malformed arguments with network denied', async () => fixture(async ({ input, output }) => {
  // Given
  await writeFile(path.join(input, 'CLI ' + pageId + '.md'), '# CLI');
  const binary = path.resolve('experiments/laya-wiki/notion_text_export.mjs');
  const invoke = (args) => spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '--allow-fs-write=*', binary, ...args], { encoding: 'utf8' });
  // When
  const results = [invoke(['--input', input, '--output', output]), invoke(['--help']), invoke(['--unknown']), invoke([])];
  // Then
  assert.deepEqual(results.map((r) => r.status), [0, 0, 1, 1]);
  assert.equal(JSON.parse(results[0].stdout).collected, 1);
  assert.ok(results[1].stdout.length > 0);
  assert.throws(() => options(['--input', '']));
  assert.equal(nativeId('A aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.md'), 'a'.repeat(8) + 'b'.repeat(4) + 'c'.repeat(4) + 'd'.repeat(4) + 'e'.repeat(12));
}));
