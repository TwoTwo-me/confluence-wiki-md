#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ConfluenceApi, readWikiConfig } from '../../src/api.mjs';
import { loadProfile } from '../../src/env.mjs';
import { initWiki } from '../../src/wiki-init.mjs';
import { upload } from '../../src/wiki.mjs';
import { formatDocument, markdownToStorage, storageToMarkdown, loadStorageXml } from '../../src/document.mjs';
import { getRestrictions } from '../../src/restrictions.mjs';
import { sha256, saveJson, readJson, validateCorpus, secretLooking } from './collect.mjs';

const SPACE = 'AGENTTEST';
const normalize = (text) => text.replaceAll('\r\n', '\n').trim();
const binding = (api) => ({ deployment: api.config.deployment, site: api.config.siteUrl, api: api.config.apiUrl, space: SPACE });
export function preparedBody(doc, deployment = 'cloud') {
  const converted = markdownToStorage(doc.text, { flattenNestedQuotes: deployment === 'cloud' });
  const $ = loadStorageXml(converted.storage);
  $('a[href]').each((_i, node) => { const href = $(node).attr('href'); if (href && !href.startsWith('#')) $(node).attr('href', new URL(href, doc.source_url).href); });
  $('ri\\:url').each((_i, node) => { const value = $(node).attr('ri:value'); if (value) $(node).attr('ri:value', new URL(value, doc.source_url).href); });
  $('ac\\:image').each((_i, node) => {
    const url = $(node).find('ri\\:url').attr('ri:value');
    const link = $('<a></a>').text('Image: ' + ($(node).attr('ac:alt') || 'source asset'));
    if (url) link.attr('href', url);
    $(node).replaceWith(link);
  });
  const body = storageToMarkdown($.xml(), { preserve: 'none', pageUrl: doc.source_url, siteUrl: new URL(doc.source_url).origin }).markdown;
  return 'Source ID: ' + doc.id + '\n\nSource: <' + doc.source_url + '>\n\n' + body;
}
function expectedText(body, api) {
  return normalize(storageToMarkdown(markdownToStorage(body, { flattenNestedQuotes: api.config.deployment === 'cloud' }).storage, { preserve: 'none', siteUrl: api.config.webBase }).markdown);
}
function pageText(page, api) {
  return storageToMarkdown(page.storage, { preserve: 'none', pageUrl: page.url, siteUrl: api.config.webBase, pageId: page.id }).markdown;
}
function requireBinding(api, manifest) {
  if (JSON.stringify(manifest.binding) !== JSON.stringify(binding(api))) throw new Error('Manifest tenant/space binding mismatch.');
}
async function protectedRead(api, id) {
  const acl = await getRestrictions(api, id);
  if (!(acl.read.users.length + acl.read.groups.length) || !(acl.update.users.length + acl.update.groups.length)) throw new Error('Private page lacks direct view/edit protection.');
}
export class RecordedApi extends ConfluenceApi {
  constructor(config, { output, requestLimit = Infinity } = {}) { super(config); this.output = output; this.requestLimit = requestLimit; this.http = []; }
  async request(resource, options = {}) {
    if (this.http.length >= this.requestLimit) throw new Error('HTTP request budget exhausted.');
    const item = { method: options.method ?? 'GET', resource: resource.split('?')[0], started_at: new Date().toISOString() };
    this.http.push(item); const start = performance.now();
    try {
      const response = await super.request(resource, { ...options, raw: true });
      item.status = response.status;
      if (response.status >= 300 && response.status < 400) throw new Error('Unexpected redirect.');
      if (options.raw) return response;
      if (response.status === 204) { item.bytes = 0; return null; }
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('HTTP response exceeds 2 MiB budget.'); chunks.push(chunk); }
      item.bytes = bytes;
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return options.metadata ? { data, headers: response.headers } : data;
    } catch (e) { item.status ??= e.status ?? null; item.error = e.name; throw e; }
    finally { item.elapsed_ms = performance.now() - start; if (this.output) await saveJson(this.output, this.http); }
  }
}
export async function importCorpus(api, corpus, { output = 'artifacts/laya-wiki', initialize = initWiki, publish = upload } = {}) {
  validateCorpus(corpus);
  if (corpus.some((d) => secretLooking(d.text))) throw new Error('Secret-looking corpus content refused.');
  const filename = path.join(output, 'confluence-manifest.json');
  const manifest = await readJson(filename, { schema: 1, binding: binding(api), topic: 'Laya study ' + new Date().toISOString().slice(0, 10) + ' ' + randomUUID().slice(0, 8), root: null, pages: {}, documents: {}, private_blocker: null });
  requireBinding(api, manifest);
  const save = () => saveJson(filename, manifest);
  if (manifest.root?.status === 'confirmed') {
    const root = await initialize(api, { space: SPACE, topic: manifest.topic, existingRoot: manifest.root.id });
    if (root.status !== 'confirmed') throw new Error('Existing root verification failed.');
  } else if (manifest.root) throw new Error('Root outcome is unresolved; reconcile the saved identity before retrying.');
  else {
    manifest.root = { status: 'pending' }; await save();
    try { manifest.root = await initialize(api, { space: SPACE, topic: manifest.topic }); await save(); }
    catch (e) { manifest.root = { status: 'unresolved', error: e.name, http_status: e.status ?? null }; await save(); throw e; }
    if (manifest.root.status !== 'confirmed') throw new Error('Root was not confirmed; inspect the saved outcome.');
  }
  const targetSpace = await api.getSpace(SPACE);
  const ensure = async (key, title, body, parent, isPrivate) => {
    const expected = expectedText(body, api);
    const inputHash = sha256(body);
    const entry = manifest.pages[key];
    if (entry) {
      if (entry.input_hash !== inputHash || entry.private !== isPrivate) throw new Error('Cached source changed; explicit reconciliation required.');
      if (entry.status !== 'confirmed') throw new Error('Prior mutation unresolved; no blind retry.');
      const live = await api.getPage(entry.id);
      if (live.title !== entry.title || String(live.parentId) !== String(parent) || live.spaceId !== String(targetSpace.id) || live.status !== 'current' || sha256(normalize(pageText(live, api))) !== entry.expected_hash) throw new Error('Live page differs from journal; explicit reconciliation required.');
      if (isPrivate) await protectedRead(api, entry.id);
      return entry;
    }
    const titleSafe = title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 125) + ' [' + sha256(manifest.topic + key).slice(0, 12) + ']';
    const state = { status: 'pending', title: titleSafe, private: isPrivate, parent_id: parent, input_hash: inputHash, expected_hash: sha256(expected), expected_text: expected };
    manifest.pages[key] = state; await save();
    try {
      const result = await publish(api, formatDocument({ metadata: { type: 'Article', title: titleSafe }, body }), {
        title: titleSafe, space: SPACE, parent, diagrams: 'code', restrictions: { mode: isPrivate ? 'view-edit' : 'none' },
        secondarySync: { property: false, labels: false, attachments: false },
        onWrite: async (saved) => { const meta = saved.metadata.confluence; Object.assign(state, { id: meta.id, version: meta.version, url: meta.url ?? api.pageUrl(meta.id), pending_create: meta.pending_create ?? null }); await save(); },
      });
      const meta = result.metadata.confluence;
      Object.assign(state, { id: meta.id, version: meta.version, url: meta.url ?? api.pageUrl(meta.id) });
      const live = await api.getPage(state.id);
      if (live.title !== state.title || String(live.parentId) !== String(parent) || live.spaceId !== String(targetSpace.id) || live.status !== 'current') throw new Error('Created page identity/ancestry mismatch.');
      if (isPrivate) await protectedRead(api, state.id);
      if (normalize(pageText(live, api)) !== expected) throw new Error('Created page content does not match normalized source.');
      state.status = 'confirmed'; state.storage_sha256 = sha256(live.storage); state.version = live.version; await save(); return state;
    } catch (e) {
      state.status = 'unresolved'; state.error = e.name; state.http_status = e.cause?.cause?.status ?? e.cause?.status ?? e.status ?? null;
      state.reason = isPrivate ? 'protected_creation_or_verification_failed' : 'publication_or_verification_failed';
      if (e.id && !state.id) state.id = e.id;
      if (isPrivate) manifest.private_blocker = { key, id: state.id ?? null, version: state.version ?? null, pending_create: state.pending_create ?? null, http_status: state.http_status, reason: state.reason };
      await save(); throw e;
    }
  };
  const byNative = new Map(corpus.filter((d) => d.source_type === 'notion').map((d) => [d.source_path.replaceAll('-', ''), d]));
  const importing = new Set();
  const importDoc = async (doc) => {
    if (importing.has(doc.id)) throw new Error('Notion parent cycle.');
    const previous = manifest.documents[doc.id];
    if (previous?.source_sha256 && previous.source_sha256 !== doc.sha256) { manifest.documents[doc.id] = { ...previous, status: 'blocked', reason: 'source_hash_changed' }; await save(); return null; }
    if (doc.private && manifest.private_blocker) { manifest.documents[doc.id] = { status: 'blocked', source_sha256: doc.sha256, reason: 'private_protection_blocker' }; await save(); return null; }
    importing.add(doc.id);
    try {
      const section = await ensure('section/' + doc.source_type, doc.source_type === 'github' ? 'GitHub' : 'Notion', 'Collected source documents.', manifest.root.id, doc.source_type === 'notion');
      let parent = section.id;
      if (doc.source_type === 'github') {
        const segments = doc.source_path.split('/');
        for (let depth = 2; depth < segments.length; depth++) {
          const group = segments.slice(0, depth).join('/');
          parent = (await ensure('group/' + group, group, 'Source document collection.', parent, doc.private)).id;
        }
      } else if (doc.parent_id && byNative.has(doc.parent_id.replaceAll('-', ''))) {
        const parentDoc = await importDoc(byNative.get(doc.parent_id.replaceAll('-', '')));
        if (!parentDoc) throw new Error('Notion parent unavailable.');
        parent = parentDoc.id;
      }
      const page = await ensure('doc/' + doc.id, doc.title, preparedBody(doc, api.config.deployment), parent, doc.private);
      manifest.documents[doc.id] = { status: 'confirmed', id: page.id, version: page.version, url: page.url, source_sha256: doc.sha256, expected_hash: page.expected_hash, anchor: 'Source ID: ' + doc.id };
      await save(); return page;
    } catch (e) {
      manifest.documents[doc.id] = { status: 'blocked', source_sha256: doc.sha256, reason: manifest.private_blocker && doc.private ? 'private_protection_blocker' : 'hierarchy_or_mutation_unresolved', error: e.name };
      await save(); return null;
    } finally { importing.delete(doc.id); }
  };
  for (const doc of corpus) await importDoc(doc);
  manifest.finished_at = new Date().toISOString(); manifest.expected_documents = corpus.length; await save();
  return { root: manifest.root, confirmed: Object.values(manifest.documents).filter((d) => d.status === 'confirmed').length, blocked: Object.values(manifest.documents).filter((d) => d.status !== 'confirmed').length, private_blocker: Boolean(manifest.private_blocker), manifest: filename };
}
export async function readback(api, corpus, { output = 'artifacts/laya-wiki' } = {}) {
  validateCorpus(corpus);
  const manifest = await readJson(path.join(output, 'confluence-manifest.json')); requireBinding(api, manifest);
  const targetSpace = await api.getSpace(SPACE);
  const results = []; const roundtrip = [];
  const report = { expected_documents: corpus.length, started_at: new Date().toISOString(), documents: results };
  for (const doc of corpus) {
    const entry = manifest.documents[doc.id];
    if (entry?.status !== 'confirmed') { results.push({ source_id: doc.id, status: 'unavailable', reason: entry?.reason ?? 'not_imported' }); continue; }
    const start = performance.now();
    try {
      const page = await api.getPage(entry.id);
      if (page.id !== entry.id || page.spaceId !== String(targetSpace.id) || page.status !== 'current' || String(page.parentId) !== String(manifest.pages['doc/' + doc.id].parent_id)) throw new Error('Readback page identity/ancestry mismatch.');
      if (doc.private) await protectedRead(api, page.id);
      const text = pageText(page, api);
      const integrity = sha256(normalize(text)) === entry.expected_hash && doc.sha256 === entry.source_sha256;
      const sourceAnchor = 'Source ID: ' + doc.id;
      if (!text.includes(sourceAnchor)) throw new Error('Source anchor missing.');
      results.push({ source_id: doc.id, status: integrity ? 'verified' : 'mismatch', id: page.id, version: page.version, url: page.url, read_at: new Date().toISOString(), elapsed_ms: performance.now() - start, storage_sha256: sha256(page.storage), actual_hash: sha256(normalize(text)), expected_hash: entry.expected_hash, normalized_integrity: integrity });
      const body = text.replace(/^Source ID: [a-f0-9]+\s*\n+Source: [^\n]+\n*/, '').trim();
      roundtrip.push({ ...doc, text: body, sha256: sha256(body), confluence: { id: page.id, version: page.version, url: page.url, integrity } });
      await saveJson(path.join(output, 'readback-pages', doc.id + '.json'), page);
    } catch (e) { results.push({ source_id: doc.id, id: entry.id, status: 'failed', error: e.name, http_status: e.status ?? null }); }
    await saveJson(path.join(output, 'readback.json'), report);
  }
  report.verified = results.filter((r) => r.status === 'verified').length; report.complete = report.verified === corpus.length && corpus.length > 0;
  await saveJson(path.join(output, 'confluence-corpus.json'), roundtrip); await saveJson(path.join(output, 'readback.json'), report);
  return { expected: corpus.length, verified: report.verified, complete: report.complete, report: path.join(output, 'readback.json') };
}
export async function query(api, text, { output = 'artifacts/laya-wiki', limit = 10 } = {}) {
  if (!text?.trim() || text.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Query requires 1-500 characters and limit 1-20.');
  const manifest = await readJson(path.join(output, 'confluence-manifest.json')); requireBinding(api, manifest);
  if (manifest.root.status !== 'confirmed') throw new Error('Root unconfirmed.');
  const quote = (s) => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
  const cql = 'type = page AND space = "AGENTTEST" AND ancestor = ' + quote(manifest.root.id) + ' AND text ~ ' + quote(text);
  const started = performance.now(); const before = api.http?.length ?? 0;
  const sourceMap = new Map(Object.entries(manifest.documents).filter(([, d]) => d.status === 'confirmed').map(([id, d]) => [d.id, id]));
  const candidates = await api.search(text, { space: SPACE, cql, limit });
  const pages = [];
  for (const candidate of candidates) {
    const sourceId = sourceMap.get(candidate.id); if (!sourceId) continue;
    const start = performance.now();
    try { const page = await api.getPage(candidate.id); pages.push({ source_id: sourceId, id: page.id, version: page.version, url: page.url, text: pageText(page, api), elapsed_ms: performance.now() - start }); }
    catch (e) { pages.push({ source_id: sourceId, id: candidate.id, error: e.name }); }
  }
  const result = { query: text, cql, limit, candidate_count: candidates.length, possibly_truncated: candidates.length === limit, pages, elapsed_ms: performance.now() - started, http_requests: (api.http?.length ?? 0) - before, response_bytes: (api.http ?? []).slice(before).reduce((n, r) => n + (r.bytes ?? 0), 0) };
  const filename = path.join(output, 'queries', sha256(text) + '.json'); await saveJson(filename, result);
  return { candidates: candidates.length, fetched: pages.filter((p) => p.text).length, elapsed_ms: result.elapsed_ms, http_requests: result.http_requests, result: filename };
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { env: { type: 'string' }, output: { type: 'string', default: 'artifacts/laya-wiki' }, corpus: { type: 'string' }, limit: { type: 'string', default: '10' }, help: { type: 'boolean' } } });
  if (values.help || !positionals.length) { console.log('Usage: node experiments/laya-wiki/confluence.mjs <import|readback|query TEXT> [--env PROFILE] [--output artifacts/laya-wiki] [--corpus FILE] [--limit 10]\nUses only AGENTTEST. import creates a unique root and hierarchy; private uploads require verified view-edit protection. Journal blocks unknown/stale mutations; reconcile manually before retry. readback writes confluence-corpus.json and integrity report. query scopes CQL to the study root, max 20 candidates / 40 HTTP requests / 2 MiB per response. Diagram fences remain code; assets are links. Bodies and HTTP receipts stay in the output directory; stdout contains summaries.'); return; }
  const command = positionals[0];
  if (!['import', 'readback', 'query'].includes(command)) throw new Error('Unknown subcommand.');
  const config = readWikiConfig(await loadProfile(values.env));
  const api = new RecordedApi(config, { output: path.join(values.output, command + '-http.json'), requestLimit: command === 'query' ? 40 : Infinity });
  const options = { output: values.output, limit: Number(values.limit) };
  const result = command === 'query' ? await query(api, positionals.slice(1).join(' '), options) : await (command === 'import' ? importCorpus : readback)(api, await readJson(values.corpus ?? path.join(values.output, 'corpus.json')), options);
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error('Confluence experiment failed: ' + e.name + '. Inspect the saved manifest/HTTP receipt; no automatic retry was attempted.'); process.exitCode = 1; });
