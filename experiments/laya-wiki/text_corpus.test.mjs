import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eligiblePath, sourceId, sha256, validateCorpus } from './collect.mjs';
import { blobHash, decodeBlob, parseTree, cachedText, parseOptions, BLOB_FETCH_ARGS } from './text_corpus.mjs';

test('existing eligibility and identity remain stable for text and excluded paths', () => {
  // Given
  const paths = ['README.md', 'docs/a.MDX', 'docs/a.rst', 'docs/a.txt', 'node_modules/a.md', 'dist/a.md', 'LICENSE.txt', 'package-lock.txt', 'image.png'];
  // When
  const selected = paths.map(eligiblePath);
  // Then
  assert.deepEqual(selected, [true, true, true, true, false, false, false, false, false]);
  assert.equal(sourceId('github', 'https://github.com/fixture/repo/blob/main/a.md', 'fixture/repo/a.md'), 'b3a272c4c32ba4069a5574582b507245286879a51fe0a601dace5de638ae1a53');
});

for (const [name, bytes, reason] of [
  ['invalid UTF8', Buffer.from([0xff]), 'invalid_utf8'],
  ['binary', Buffer.from('a\0b'), 'binary_content'],
  ['empty', Buffer.from(' \n'), 'empty_content'],
  ['secret', Buffer.from('api_key = ' + 'x'.repeat(30)), 'secret_looking_content'],
]) test('rejects ' + name + ' before corpus admission', () => {
  // Given
  const hash = blobHash(bytes);
  // When / Then
  assert.throws(() => decodeBlob(bytes, hash), { message: reason });
});

test('rejects a blob whose bytes do not match the requested Git identity', () => {
  // Given
  const bytes = Buffer.from('modified');
  // When / Then
  assert.throws(() => decodeBlob(bytes, '0'.repeat(40)), { message: 'blob_hash_mismatch' });
});

test('preserves meaningful oversized UTF8 and BOM exactly', () => {
  // Given
  const original = '\ufeff' + '가'.repeat(200000);
  const bytes = Buffer.from(original);
  // When
  const text = decodeBlob(bytes, blobHash(bytes));
  // Then
  assert.equal(text, original);
  assert.ok(Buffer.byteLength(text) > 512 * 1024);
});

test('tree parser preserves tabs and newlines in paths and reports symlinks/submodules', () => {
  // Given
  const hash = 'a'.repeat(40);
  const bytes = Buffer.from(`100644 blob ${hash}\tdocs/a\tb\nc.md\0` + `120000 blob ${hash}\tlink.md\0` + `160000 commit ${hash}\tmodule\0`);
  // When
  const entries = parseTree(bytes);
  // Then
  assert.deepEqual(entries.map((e) => [e.mode, e.type, e.path]), [['100644', 'blob', 'docs/a\tb\nc.md'], ['120000', 'blob', 'link.md'], ['160000', 'commit', 'module']]);
});

test('corrupt resumed cache falls back to verified prior cache and stale hash misses', async () => {
  // Given
  const root = await mkdtemp(path.join(tmpdir(), 'laya-cache-'));
  try {
    const roots = [path.join(root, 'current'), path.join(root, 'prior')];
    for (const dir of roots) await mkdir(path.join(dir, 'raw'), { recursive: true });
    const bytes = Buffer.from('# Original');
    await writeFile(path.join(roots[0], 'raw', 'id.txt'), 'corrupt');
    await writeFile(path.join(roots[1], 'raw', 'id.txt'), bytes);
    // When
    const results = await Promise.all([cachedText({ id: 'id', blob_sha: blobHash(bytes) }, roots), cachedText({ id: 'id', blob_sha: blobHash(Buffer.from('changed')) }, roots)]);
    // Then
    assert.deepEqual(results, ['# Original', undefined]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('corpus validation rejects duplicates and modified content at the output boundary', () => {
  // Given
  const source_url = 'https://github.com/fixture/repo/blob/main/a.md';
  const source_path = 'fixture/repo/a.md';
  const doc = { title: 'a.md', text: 'content', source_url, source_path, source_type: 'github', private: true, id: sourceId('github', source_url, source_path), sha256: sha256('content') };
  // When / Then
  assert.equal(validateCorpus([doc]).length, 1);
  assert.throws(() => validateCorpus([doc, doc]));
  assert.throws(() => validateCorpus([{ ...doc, text: 'modified' }]));
});

test('CLI malformed arguments fail before any GitHub process can run', async () => {
  // Given
  const root = await mkdtemp(path.join(tmpdir(), 'laya-cli-'));
  const marker = path.join(root, 'called');
  try {
    await writeFile(path.join(root, 'gh'), '#!/bin/sh\ntouch "$CALL_MARKER"\nexit 99\n', { mode: 0o700 });
    // When
    const result = spawnSync(process.execPath, ['experiments/laya-wiki/text_corpus.mjs', '--owner', 'bad/owner'], { env: { ...process.env, PATH: root + ':' + process.env.PATH, CALL_MARKER: marker } });
    // Then
    assert.equal(result.status, 1);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    assert.throws(() => parseOptions(['--unknown']));
    assert.throws(() => parseOptions(['--output', '']));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real filtered shallow Git fetch batches document blobs while leaving media absent', async () => {
  // Given
  const root = await mkdtemp(path.join(tmpdir(), 'laya-git-'));
  const source = path.join(root, 'source');
  const clone = path.join(root, 'clone');
  const git = (directory, args, input) => {
    const result = spawnSync('git', ['-C', directory, ...args], { input, encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    await mkdir(source);
    git(source, ['init', '-b', 'main']);
    git(source, ['config', 'uploadpack.allowFilter', 'true']);
    git(source, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    await writeFile(path.join(source, 'a.md'), '# One');
    await writeFile(path.join(source, 'b.txt'), 'Two');
    await writeFile(path.join(source, 'image.png'), Buffer.from([0, 255, 0, 255]));
    git(source, ['add', '.']);
    git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    const wanted = ['a.md', 'b.txt'].map((p) => git(source, ['rev-parse', 'HEAD:' + p]).trim());
    git(root, ['clone', '--bare', '--depth=1', '--filter=blob:none', 'file://' + source, clone]);
    assert.equal(git(clone, ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype)']).split('\n').filter((t) => t === 'blob').length, 0);
    // When
    git(clone, BLOB_FETCH_ARGS, wanted.join('\n') + '\n');
    // Then
    const blobs = git(clone, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).trim().split('\n').filter((r) => r.endsWith(' blob')).map((r) => r.split(' ')[0]);
    assert.deepEqual(blobs.sort(), wanted.sort());
    assert.equal(git(clone, ['cat-file', 'blob', wanted.find((id) => id === blobHash(Buffer.from('# One')))]), '# One');
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'gh'), '#!' + process.execPath + '\nconsole.log(JSON.stringify(process.argv[3] === "user" ? {login:"fixture"} : [[{owner:{login:"fixture"},full_name:"fixture/repo",private:true,default_branch:"main",size:0}]]));\n', { mode: 0o700 });
    const output = path.join(root, 'output');
    const env = { ...process.env, PATH: bin + ':' + process.env.PATH, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.file://' + source + '.insteadOf', GIT_CONFIG_VALUE_0: 'https://github.com/fixture/repo.git' };
    const invocation = ['experiments/laya-wiki/text_corpus.mjs', '--owner', 'fixture', '--output', output, '--cache', path.join(root, 'empty')];
    const first = spawnSync(process.execPath, invocation, { env, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const firstCorpus = await readFile(path.join(output, 'corpus.json'), 'utf8');
    const resumed = spawnSync(process.execPath, invocation, { env, encoding: 'utf8' });
    assert.equal(resumed.status, 0, resumed.stderr);
    const manifest = JSON.parse(await readFile(path.join(output, 'source-manifest.json'), 'utf8'));
    assert.equal(await readFile(path.join(output, 'corpus.json'), 'utf8'), firstCorpus);
    assert.equal(manifest.collected, 2);
    assert.equal(manifest.cache_hits, 2);
    assert.equal(manifest.complete, true);
    assert.equal(manifest.media_fetches, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
