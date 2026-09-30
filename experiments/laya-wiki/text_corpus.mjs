#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { eligiblePath, sourceId, sha256, secretLooking, validateCorpus, saveJson, gh } from './collect.mjs';

export const blobHash = (bytes) => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
export const BLOB_FETCH_ARGS = ['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance', '--recurse-submodules=no', '--filter=blob:none', '--stdin', 'origin'];
export function decodeBlob(bytes, expected) {
  if (blobHash(bytes) !== expected) throw new Error('blob_hash_mismatch');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('invalid_utf8'); }
  if (text.includes('\0')) throw new Error('binary_content');
  if (!text.trim()) throw new Error('empty_content');
  if (secretLooking(text)) throw new Error('secret_looking_content');
  return text;
}
export function parseTree(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\0').filter(Boolean).map((row) => {
    const match = row.match(/^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/);
    if (!match) throw new Error('malformed_git_tree');
    return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
  });
}
function command(binary, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, timeout: 180_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' } }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr.toString();
        const reason = /Remote branch .* not found|couldn't find remote ref/.test(message) ? 'default_branch_unavailable' :
          /Authentication failed|could not read Username|Permission denied/.test(message) ? 'authentication_failed' : 'command_failed';
        reject(Object.assign(new Error(reason), { code: error.code, signal: error.signal }));
      }
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export async function cachedText(entry, roots) {
  for (const root of roots) {
    try { return decodeBlob(await readFile(path.join(root, 'raw', entry.id + '.txt')), entry.blob_sha); }
    catch (error) { if (error.code && error.code !== 'ENOENT') throw error; }
  }
  return undefined;
}
export function parseOptions(args) {
  const { values } = parseArgs({ args, options: { owner: { type: 'string', default: 'TwoTwo-me' }, output: { type: 'string', default: 'artifacts/laya-wiki/text-expansion/github' }, cache: { type: 'string', default: 'artifacts/laya-wiki' }, help: { type: 'boolean' } } });
  if (!/^[A-Za-z0-9-]+$/.test(values.owner) || !values.output.trim() || !values.cache.trim()) throw new Error('invalid_arguments');
  return values;
}
export async function collectText({ owner, output, cache }) {
  if (!/^[A-Za-z0-9-]+$/.test(owner)) throw new Error('invalid_owner');
  const actor = await gh(['api', 'user']);
  if (actor.login.toLowerCase() !== owner.toLowerCase()) throw new Error('owned_private_inventory_requires_owner_login');
  const pages = await gh(['api', 'user/repos?affiliation=owner&per_page=100&sort=full_name', '--paginate', '--slurp']);
  const repos = pages.flat();
  const names = new Set();
  for (const repo of repos) {
    if (repo.owner?.login.toLowerCase() !== owner.toLowerCase() || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.full_name) ||
      typeof repo.private !== 'boolean' || names.has(repo.full_name)) throw new Error('invalid_owned_inventory');
    names.add(repo.full_name);
  }
  await mkdir(path.join(output, 'raw'), { recursive: true, mode: 0o700 });
  await saveJson(path.join(output, 'github-inventory.json'), repos.map((r) => ({ name: r.full_name, private: r.private, fork: r.fork, archived: r.archived, default_branch: r.default_branch })));
  const manifest = { schema: 1, started_at: new Date().toISOString(), owner, strategy: 'depth1_blob_none_then_eligible_blob_batch_fetch',
    media_fetches: 0, blob_fetch_batches: 0, cache_hits: 0, repositories: [], documents: [], complete: false };
  const corpus = [];
  const save = () => saveJson(path.join(output, 'source-manifest.json'), manifest);
  for (const repo of repos) {
    const record = { repository: repo.full_name, private: repo.private, fork: repo.fork, archived: repo.archived, default_branch: repo.default_branch, status: 'pending' };
    manifest.repositories.push(record);
    if (!repo.default_branch) { record.status = 'unavailable'; record.reason = 'no_default_branch'; await save(); continue; }
    const directory = path.resolve(output, 'git', sha256(repo.full_name));
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    const git = (args, input) => command('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', '-C', directory, ...args], input);
    let entries;
    try {
      let exists = true;
      try { await stat(path.join(directory, 'HEAD')); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
      if (!exists) await command('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'clone', '--bare', '--depth=1', '--filter=blob:none', '--single-branch', '--branch', repo.default_branch, 'https://github.com/' + repo.full_name + '.git', directory]);
      else await git(['fetch', '--depth=1', '--filter=blob:none', '--no-tags', 'origin', '+refs/heads/' + repo.default_branch + ':refs/heads/' + repo.default_branch]);
      if ((await git(['config', '--get', 'remote.origin.partialclonefilter'])).toString().trim() !== 'blob:none') throw new Error('partial_clone_filter_missing');
      record.commit_sha = (await git(['rev-parse', 'refs/heads/' + repo.default_branch])).toString().trim();
      record.tree_sha = (await git(['rev-parse', record.commit_sha + '^{tree}'])).toString().trim();
      entries = parseTree(await git(['ls-tree', '-rz', record.commit_sha]));
      record.tree_entries = entries.length;
      record.non_document_entries = entries.filter((e) => !/\.(md|mdx|rst|txt)$/i.test(e.path)).length;
    } catch (error) { record.status = 'unavailable'; record.reason = 'git_tree_' + error.message; record.error = error.code ?? error.name; await save(); continue; }
    const pending = [];
    for (const item of entries.filter((e) => /\.(md|mdx|rst|txt)$/i.test(e.path))) {
      const source_url = 'https://github.com/' + repo.full_name + '/blob/' + encodeURIComponent(repo.default_branch) + '/' + item.path.split('/').map(encodeURIComponent).join('/');
      const source_path = repo.full_name + '/' + item.path;
      const entry = { id: sourceId('github', source_url, source_path), source_url, source_path, source_type: 'github', private: repo.private, blob_sha: item.sha, status: 'pending' };
      manifest.documents.push(entry);
      if (!eligiblePath(item.path) || item.type !== 'blob' || !['100644', '100755'].includes(item.mode)) {
        entry.status = 'excluded'; entry.reason = eligiblePath(item.path) ? 'symlink_or_submodule' : 'dependency_build_vendor_or_lockfile'; continue;
      }
      const text = await cachedText(entry, [output, cache]);
      pending.push({ item, entry, text });
    }
    const missing = [...new Set(pending.filter((p) => p.text === undefined).map((p) => p.item.sha))];
    let fetchError;
    for (let start = 0; start < missing.length; start += 256) {
      const batch = missing.slice(start, start + 256);
      try { await git(BLOB_FETCH_ARGS, batch.join('\n') + '\n'); manifest.blob_fetch_batches++; }
      catch (error) { fetchError = error.code ?? error.message; }
    }
    for (const pendingDoc of pending) {
      const { item, entry } = pendingDoc;
      try {
        let text = pendingDoc.text;
        entry.cache_hit = text !== undefined;
        if (entry.cache_hit) manifest.cache_hits++;
        else {
          const size = Number((await git(['cat-file', '-s', item.sha])).toString().trim());
          entry.bytes = size;
          if (size > 128 * 1024 * 1024) throw new Error('text_exceeds_128MiB_process_buffer');
          text = decodeBlob(await git(['cat-file', 'blob', item.sha]), item.sha);
        }
        entry.bytes = Buffer.byteLength(text);
        const doc = { id: entry.id, title: item.path, text, source_url: entry.source_url, source_path: entry.source_path, source_type: 'github', private: repo.private, sha256: sha256(text) };
        validateCorpus([doc]);
        await writeFile(path.join(output, 'raw', entry.id + '.txt'), text, { mode: 0o600 });
        entry.status = 'collected'; entry.sha256 = doc.sha256; corpus.push(doc);
      } catch (error) { entry.status = 'unavailable'; entry.reason = error.message; if (fetchError) entry.fetch_error = fetchError; }
    }
    const allowed = new Set(pending.map((p) => p.item.sha));
    const objects = (await git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'])).toString().trim().split('\n');
    const blobs = objects.filter((row) => row.endsWith(' blob')).map((row) => row.split(' ')[0]);
    record.stored_blob_objects = blobs.length;
    record.non_document_blob_objects = blobs.filter((id) => !allowed.has(id)).length;
    manifest.media_fetches += record.non_document_blob_objects;
    record.status = 'inventoried'; record.eligible = pending.length;
    await save();
    console.log(JSON.stringify({ repositories_processed: manifest.repositories.length, inventory_repositories: repos.length, collected: corpus.length, cache_hits: manifest.cache_hits }));
  }
  validateCorpus(corpus);
  manifest.finished_at = new Date().toISOString();
  manifest.collected = corpus.length;
  manifest.eligible = manifest.documents.filter((d) => d.status !== 'excluded').length;
  manifest.unavailable = manifest.documents.filter((d) => d.status === 'unavailable').length;
  manifest.complete = manifest.repositories.every((r) => r.status === 'inventoried') && manifest.unavailable === 0 && manifest.media_fetches === 0;
  manifest.coverage_accounted = manifest.repositories.every((r) => ['inventoried', 'unavailable'].includes(r.status)) && manifest.documents.every((d) => ['collected', 'excluded', 'unavailable'].includes(d.status));
  await saveJson(path.join(output, 'corpus.json'), corpus); await save();
  return { repositories: repos.length, eligible: manifest.eligible, collected: corpus.length, unavailable: manifest.unavailable, media_fetches: manifest.media_fetches, complete: manifest.complete, coverage_accounted: manifest.coverage_accounted };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log('Usage: node experiments/laya-wiki/text_corpus.mjs [--owner LOGIN] [--output DIRECTORY] [--cache DIRECTORY]\nCollect all owned public/private default-branch md/mdx/rst/txt documents via filtered Git and verified cache. No checkout, media or attachment requests. Explicit exclusions and failures are saved in source-manifest.json.');
    else console.log(JSON.stringify(await collectText(options)));
  } catch (error) { console.error(JSON.stringify({ error: error.code ?? error.message })); process.exitCode = 1; }
}
