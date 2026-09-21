import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { parseDocument, formatDocument } from '../src/document.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'artifacts', 'live-' + Date.now());
assert.ok(directory.startsWith(path.join(root, 'artifacts') + path.sep), 'Live test output must be inside artifacts.');
await mkdir(directory, { recursive: true });
const cli = async (...args) => (await exec(process.execPath, [path.join(root, 'scripts/confluence.mjs'), ...args], { cwd: root, maxBuffer: 5 * 1024 * 1024 })).stdout;
const note = (message) => process.stdout.write(message + '\n');
const source = parseDocument(await readFile(path.join(root, 'examples/reference.md'), 'utf8'));
source.metadata.title += ' ' + path.basename(directory);
const input = path.join(directory, 'reference.md');
if (!process.argv[2]) {
  await writeFile(input, formatDocument(source), { mode: 0o600 });
  await copyFile(path.join(root, 'examples/sample.svg'), path.join(directory, 'sample.svg'));
}
const local = parseDocument(await readFile(input, 'utf8'));
const created = local.metadata.confluence?.id ? parseDocument(await cli('read', local.metadata.confluence.id)) : parseDocument(await cli('upload', input, '--diagrams', 'code'));
const id = created.metadata.confluence.id;
note('Created demo page ' + id);
const copy = path.join(directory, 'downloaded.md');
await cli('download', id, '-o', copy, '--assets', '--overwrite');
const downloaded = parseDocument(await readFile(copy, 'utf8'));
for (const expected of ['mermaid', 'Markdown', '한글', 'https://example.com', '[x] Create', '[^okf]']) assert.ok(downloaded.body.includes(expected), 'Missing downloaded content: ' + expected);
assert.equal(downloaded.metadata.custom.owner, 'documentation-team');
assert.match(downloaded.body, /\[\^okf\]:/);
assert.ok(downloaded.metadata.confluence.labels.includes('markdown-wiki'));
assert.equal(await readFile(path.join(directory, 'downloaded-assets/sample.svg'), 'utf8'), await readFile(path.join(root, 'examples/sample.svg'), 'utf8'));
const stale = path.join(directory, 'stale.md');
await writeFile(stale, formatDocument(downloaded), { mode: 0o600 });
await writeFile(copy, formatDocument({ ...downloaded, body: downloaded.body + '\n## Round-trip verified\n\n수정 후 재업로드 확인. ' + new Date().toISOString() + '\n' }), { mode: 0o600 });
const updated = parseDocument(await cli('upload', copy, '--diagrams', 'code'));
assert.equal(updated.metadata.confluence.version, created.metadata.confluence.version + 1);
assert.match(parseDocument(await cli('read', id)).body, /수정 후 재업로드 확인/);
assert.match(parseDocument(await cli('read', id)).body, /\[x\] Create/);
await assert.rejects(cli('upload', stale, '--diagrams', 'code'), /Version conflict/);
note('Download, attachment bytes, update and stale-version rejection passed.');
let found = false;
for (let attempt = 0; attempt < 6; attempt++) {
  const search = JSON.parse(await cli('search', 'Markdown', '--cql', 'type = page AND id = ' + id, '--json'));
  if (search.some((row) => row.id === id)) { found = true; break; }
  note('Waiting for Confluence search indexing (' + (attempt + 1) + '/6).');
  await setTimeout(5000);
}
assert.ok(found, 'Search did not return the demo page within the indexing window. Resume this run later with its artifacts directory.');
await cli('export', path.join(directory, 'bundle'), '--overwrite');
const localSearch = await cli('search', 'Round-trip verified', '--local', path.join(directory, 'bundle'));
assert.ok(localSearch.includes(id));
note('Remote search, OKF export and local Markdown search passed.');
const disposable = path.join(directory, 'disposable.md');
await writeFile(disposable, '---\ntype: Reference\ntitle: Disposable CRUD test ' + Date.now() + '\n---\nDelete only this test page.\n', { mode: 0o600 });
const temporary = parseDocument(await cli('upload', disposable));
await cli('delete', disposable, '--yes');
try {
  const trashed = parseDocument(await cli('read', temporary.metadata.confluence.id));
  assert.equal(trashed.metadata.confluence.status, 'trashed');
} catch (error) {
  if (!/HTTP 404/.test(error.message)) throw error;
}
note('Disposable page confirmed in trash (or no longer accessible).');
const report = { passed: true, at: new Date().toISOString(), deployment: created.metadata.confluence.deployment, pageId: id, version: updated.metadata.confluence.version, url: updated.metadata.confluence.url, directory, deletedPageId: temporary.metadata.confluence.id, checks: ['create', 'markdown-download', 'attachment-byte-equality', 'okf-metadata', 'labels', 'versioned-update', 'conflict-rejection', 'remote-search', 'bundle-export', 'local-search', 'soft-delete'] };
await writeFile(path.join(root, 'artifacts/live-test.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
note(JSON.stringify(report, null, 2));
