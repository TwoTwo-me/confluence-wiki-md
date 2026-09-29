#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const sourceId = (type, url, sourcePath) => sha256(JSON.stringify([type, url, sourcePath]));
export const MAX_BYTES = 512 * 1024;
const excluded = /(?:^|\/)(?:node_modules|vendor|build|dist|\.git|\.next|coverage|target|venv|\.venv|__pycache__|Pods|\.cache)(?:\/|$)/i;
export const eligiblePath = (p) => /\.(?:md|mdx|rst|txt)$/i.test(p) && !excluded.test(p) && !/(?:^|\/)(?:.*lock.*|LICENSE|COPYING)\.txt$/i.test(p);
export function secretLooking(text) {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{32,})\b|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9/+_-]{24,}/i.test(text);
}
export async function saveJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const tmp = filename + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, filename);
}
export async function readJson(filename, fallback) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export function validateCorpus(corpus) {
  if (!Array.isArray(corpus)) throw new Error('Corpus must be a JSON array.');
  const ids = new Set();
  for (const doc of corpus) {
    if (!doc || !['github', 'notion'].includes(doc.source_type) || typeof doc.private !== 'boolean' ||
      ['id', 'title', 'text', 'source_url', 'source_path', 'sha256'].some((k) => typeof doc[k] !== 'string' || !doc[k].trim())) throw new Error('Malformed corpus document.');
    const url = new URL(doc.source_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || doc.text.includes('\0')) throw new Error('Unsafe corpus document.');
    if (doc.sha256 !== sha256(doc.text) || doc.id !== sourceId(doc.source_type, doc.source_url, doc.source_path)) throw new Error('Corpus identity/content hash mismatch.');
    if (ids.has(doc.id)) throw new Error('Duplicate corpus identity.');
    ids.add(doc.id);
  }
  return corpus;
}
function makeDoc(fields) { return { ...fields, id: sourceId(fields.source_type, fields.source_url, fields.source_path), sha256: sha256(fields.text) }; }
export function parseNotion(raw, filename) {
  if (!raw || typeof raw.text !== 'string' || typeof raw.title !== 'string' || !raw.url) throw new Error('Malformed Notion capture: expected title, url, text.');
  const url = new URL(raw.url);
  if (!/(^|\.)notion\.(?:so|com)$/.test(url.hostname)) throw new Error('Notion capture URL is not a Notion URL.');
  const content = raw.text.match(/<content>\s*([\s\S]*?)\s*<\/content>/);
  if (!content) throw Object.assign(new Error('Notion capture has no complete <content> body.'), { reason: /<blank-page\b/.test(raw.text) ? 'empty_notion_page' : raw.metadata?.type === 'database' ? 'database_metadata_without_content' : 'missing_content_body' });
  const match = url.pathname.replaceAll('-', '').match(/[a-f0-9]{32}(?:$|\/)/i);
  const nativeId = match?.[0].replaceAll('/', '').toLowerCase() ?? path.basename(filename, '.json');
  const metadata = raw.metadata ?? {};
  const parent = raw.capture_parent_id ?? raw.parent_id ?? metadata.parent_id ?? metadata.parent?.page_id;
  return makeDoc({ title: raw.title || 'Untitled', text: content[1], source_url: raw.url, source_type: 'notion', source_path: nativeId,
    private: true, ...(parent ? { parent_id: String(parent).replaceAll('-', '') } : {}),
    notion: { metadata, parent: raw.parent ?? metadata.parent ?? null, truncated: Boolean(raw.truncated || metadata.truncated || /truncat(?:ed|ion)/i.test(raw.text.replace(content[0], '')) || /<omitted\b/.test(raw.text)), unknown_block_count: Math.max(raw.unknown_block_count ?? 0, (raw.text.match(/<unknown\b/g) ?? []).length), unknown_block_ids: raw.unknown_block_ids ?? [], capture_root: raw.capture_root ?? null, children: [...content[1].matchAll(/<(?:page|database)\b[^>]*url="([^"]+)"/g)].map((m) => m[1]), last_edited_at: raw.page_last_edited_at ?? null } });
}
async function jsonFiles(dir) {
  const found = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.isDirectory()) found.push(...await jsonFiles(path.join(dir, item.name)));
    else if (item.isFile() && /\.json(?:\.capture)?$/.test(item.name)) found.push(path.join(dir, item.name));
  }
  return found.sort();
}
export async function gh(args) {
  const { stdout } = await run('gh', args, { maxBuffer: 48 * 1024 * 1024, timeout: 120_000 });
  return JSON.parse(stdout);
}
export async function collect({ owner = 'TwoTwo-me', output = 'artifacts/laya-wiki', notionDir, inventoryOnly = false, onlyRepo = [], github = gh } = {}) {
  if (!/^[A-Za-z0-9-]+$/.test(owner)) throw new Error('Invalid GitHub owner.');
  if (!Array.isArray(onlyRepo) || onlyRepo.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(name))) throw new Error('Invalid repository selection.');
  const selectedRepos = new Set(onlyRepo.map((name) => name.includes('/') ? name : owner + '/' + name));
  await mkdir(path.join(output, 'raw'), { recursive: true, mode: 0o700 });
  const manifestPath = path.join(output, 'source-manifest.json');
  const old = await readJson(manifestPath, { documents: [] });
  const cached = new Map(old.documents.map((d) => [d.id, d]));
  const manifest = { schema: 1, started_at: new Date().toISOString(), owner, limits: { per_file_bytes: MAX_BYTES, concurrency: 4, repository_limit: 10000 }, repositories: [], documents: [], gaps: [], inventory_only: inventoryOnly, selected_repositories: [...selectedRepos] };
  const corpus = [];
  const save = () => saveJson(manifestPath, manifest);
  const repos = await github(['repo', 'list', owner, '--limit', '10000', '--json', 'nameWithOwner,url,isPrivate,isFork,defaultBranchRef,isArchived']);
  if (!Array.isArray(repos)) throw new Error('Malformed repository inventory.');
  if (repos.length === 10000) manifest.gaps.push({ reason: 'repository_inventory_limit_reached' });
  await saveJson(path.join(output, 'github-inventory.json'), repos);
  for (const name of selectedRepos) if (!repos.some((repo) => repo.nameWithOwner === name)) manifest.gaps.push({ repository: name, reason: 'selected_repository_not_in_owned_inventory' });
  for (const repo of repos) {
    if (selectedRepos.size && !selectedRepos.has(repo.nameWithOwner)) continue;
    if (!repo.nameWithOwner?.startsWith(owner + '/') || typeof repo.isPrivate !== 'boolean' || typeof repo.url !== 'string') throw new Error('Malformed or unowned repository.');
    const record = { ...repo, status: 'pending' }; manifest.repositories.push(record);
    if (!repo.defaultBranchRef?.name) { record.status = 'unavailable'; record.reason = 'no_default_branch'; await save(); continue; }
    let tree;
    try { tree = await github(['api', 'repos/' + repo.nameWithOwner + '/git/trees/' + encodeURIComponent(repo.defaultBranchRef.name) + '?recursive=1']); }
    catch (e) { record.status = 'unavailable'; record.reason = 'tree_request_failed'; record.error = e.code ?? e.status ?? e.name; await save(); continue; }
    if (!Array.isArray(tree.tree)) throw new Error('Malformed GitHub tree.');
    record.status = tree.truncated ? 'partial' : 'inventoried'; record.tree_sha = tree.sha;
    if (tree.truncated) { record.reason = 'tree_truncated'; manifest.gaps.push({ repository: repo.nameWithOwner, reason: 'tree_truncated' }); }
    const entries = tree.tree.filter((item) => item.type === 'blob' && /\.(?:md|mdx|rst|txt)$/i.test(item.path));
    for (let offset = 0; offset < entries.length; offset += 4) {
      const batch = await Promise.all(entries.slice(offset, offset + 4).map(async (item) => {
        const source_url = repo.url + '/blob/' + encodeURIComponent(repo.defaultBranchRef.name) + '/' + item.path.split('/').map(encodeURIComponent).join('/');
        const source_path = repo.nameWithOwner + '/' + item.path;
        const id = sourceId('github', source_url, source_path);
        const entry = { id, source_url, source_path, source_type: 'github', private: repo.isPrivate, blob_sha: item.sha, bytes: item.size, status: 'pending' };
        if (!eligiblePath(item.path)) return { entry: { ...entry, status: 'excluded', reason: 'dependency_build_vendor_or_lockfile' } };
        if (item.size > MAX_BYTES) return { entry: { ...entry, status: 'unavailable', reason: 'oversize' } };
        if (inventoryOnly) return { entry: { ...entry, status: 'not_collected', reason: 'inventory_only' } };
        try {
          let text;
          const prior = cached.get(id);
          if (prior?.status === 'collected' && prior.blob_sha === item.sha) {
            try { const candidate = await readFile(path.join(output, 'raw', id + '.txt'), 'utf8'); if (Buffer.byteLength(candidate) <= MAX_BYTES && sha256(candidate) === prior.sha256 && createHash('sha1').update('blob ' + Buffer.byteLength(candidate) + '\0').update(candidate).digest('hex') === item.sha) text = candidate; } catch (e) { if (e.code !== 'ENOENT') throw e; }
          }
          const cacheHit = text !== undefined;
          if (!cacheHit) {
            const blob = await github(['api', 'repos/' + repo.nameWithOwner + '/git/blobs/' + item.sha]);
            if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.sha !== item.sha) throw new Error('Malformed blob response.');
            const bytes = Buffer.from(blob.content, 'base64');
            if (bytes.length > MAX_BYTES) return { entry: { ...entry, status: 'unavailable', reason: 'oversize' } };
            if (createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') !== item.sha) throw new Error('Blob hash mismatch.');
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
          }
          if (!text.trim() || text.includes('\0')) return { entry: { ...entry, status: 'unavailable', reason: 'empty_or_binary' } };
          if (secretLooking(text)) return { entry: { ...entry, status: 'unavailable', reason: 'secret_looking_content' } };
          const doc = makeDoc({ title: item.path, text, source_url, source_path, source_type: 'github', private: repo.isPrivate });
          await writeFile(path.join(output, 'raw', id + '.txt'), text, { mode: 0o600 });
          return { doc, entry: { ...entry, status: 'collected', sha256: doc.sha256, cache_hit: cacheHit } };
        } catch (e) { return { entry: { ...entry, status: 'unavailable', reason: 'blob_fetch_or_validation_failed', error: e.code ?? e.status ?? e.name } }; }
      }));
      for (const result of batch) { manifest.documents.push(result.entry); if (result.doc) corpus.push(result.doc); }
      await save();
    }
  }
  if (notionDir && !inventoryOnly) {
    let files;
    try { files = await jsonFiles(notionDir); } catch (e) { if (e.code !== 'ENOENT') throw e; files = []; manifest.gaps.push({ reason: 'notion_directory_missing' }); }
    for (const filename of files) {
      try {
        const raw = await readJson(filename); const doc = parseNotion(raw, filename);
        const entry = { id: doc.id, source_type: 'notion', source_path: doc.source_path, source_url: doc.source_url, private: true, capture: path.relative(output, filename), notion: doc.notion };
        if (Buffer.byteLength(doc.text) > MAX_BYTES || !doc.text.trim() || secretLooking(doc.text)) {
          manifest.documents.push({ ...entry, status: 'unavailable', reason: Buffer.byteLength(doc.text) > MAX_BYTES ? 'oversize' : !doc.text.trim() ? 'empty' : 'secret_looking_content' });
        } else if (!corpus.some((d) => d.id === doc.id)) {
          corpus.push(doc); manifest.documents.push({ ...entry, status: 'collected', sha256: doc.sha256 });
          if (doc.notion.truncated) manifest.gaps.push({ id: doc.id, reason: 'notion_capture_truncated' });
          if (doc.notion.unknown_block_count) manifest.gaps.push({ id: doc.id, reason: 'notion_unknown_blocks', count: doc.notion.unknown_block_count });
        }
      } catch (e) { manifest.documents.push({ capture: path.relative(output, filename), source_type: 'notion', status: 'unavailable', reason: e.reason ?? 'malformed_notion_capture', error: e.name }); }
      await save();
    }
  }
  const capturedNotionIds = new Set(corpus.filter((d) => d.source_type === 'notion').map((d) => d.source_path));
  for (const doc of corpus.filter((d) => d.source_type === 'notion')) {
    for (const url of doc.notion.children) {
      const childId = url.replaceAll('-', '').match(/[a-f0-9]{32}(?:$|[/?#])/i)?.[0].replace(/[/?#]$/, '');
      if (!childId || !capturedNotionIds.has(childId.toLowerCase())) manifest.gaps.push({ parent_id: doc.id, url, reason: 'notion_child_not_captured' });
    }
  }
  validateCorpus(corpus);
  manifest.finished_at = new Date().toISOString(); manifest.collected = corpus.length;
  manifest.complete = !inventoryOnly && !manifest.gaps.length && manifest.repositories.every((r) => r.status === 'inventoried') && manifest.documents.every((d) => ['collected', 'excluded'].includes(d.status));
  await saveJson(path.join(output, 'corpus.json'), corpus); await save();
  return { collected: corpus.length, repositories: manifest.repositories.length, inventory_repositories: repos.length, unavailable: manifest.documents.filter((d) => d.status === 'unavailable').length, gaps: manifest.gaps.length, complete: manifest.complete, manifest: manifestPath };
}
async function main() {
  const { values } = parseArgs({ options: { owner: { type: 'string', default: 'TwoTwo-me' }, output: { type: 'string', default: 'artifacts/laya-wiki' }, 'notion-dir': { type: 'string' }, 'inventory-only': { type: 'boolean' }, 'only-repo': { type: 'string', multiple: true }, help: { type: 'boolean' } } });
  if (values.help) { console.log('Usage: node experiments/laya-wiki/collect.mjs [--owner TwoTwo-me] [--output artifacts/laya-wiki] [--notion-dir artifacts/laya-wiki/notion-raw] [--inventory-only] [--only-repo OWNER/REPO ...]\nReads owned GitHub repositories through gh, caches validated blobs, and consumes captured Notion JSON <content> bodies. No content execution. 512 KiB/file; four concurrent blob requests. Writes private corpus, raw cache, inventory and explicit gap/status manifest. Secret detection is heuristic, not a guarantee.'); return; }
  console.log(JSON.stringify(await collect({ owner: values.owner, output: values.output, notionDir: values['notion-dir'], inventoryOnly: values['inventory-only'], onlyRepo: values['only-repo'] })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error('Collection failed: ' + e.name + '. Inspect source-manifest.json; no source bodies are printed.'); process.exitCode = 1; });
