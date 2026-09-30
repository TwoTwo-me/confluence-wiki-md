#!/usr/bin/env node
import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ConfluenceApi, readWikiConfig } from '../../src/api.mjs';
import { loadProfile } from '../../src/env.mjs';
import { loadStorageXml } from '../../src/document.mjs';
import { preparedBody } from './confluence.mjs';
import { readJson, saveJson, sha256, secretLooking, validateCorpus } from './collect.mjs';

export const LIMITS = Object.freeze({ chunkBytes: 48000, bodyBytes: 128000, catalogSources: 40, concurrency: 3 });
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const fingerprint = (value) => sha256(JSON.stringify(value));
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const xmlUnsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u;

export function splitText(text, limit = LIMITS.chunkBytes) {
  if (!Number.isSafeInteger(limit) || limit < 20) fail('invalid_chunk_limit');
  const chunks = []; let chunk = ''; let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(JSON.stringify(character)) - 2 + (character === '>' ? 12 : 0);
    if (bytes + size > limit) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += character; bytes += size;
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks;
}

export function buildPlan(corpus, binding) {
  validateCorpus(corpus);
  if (!corpus.length || !binding || !/^https?:\/\//.test(binding.tenant) || !/^\d+$/.test(binding.spaceId) || !/^\d+$/.test(binding.rootId) || !binding.spaceKey || !binding.actorId) fail('invalid_binding');
  const tenant = new URL(binding.tenant);
  if (tenant.href !== tenant.origin + '/' || tenant.username || tenant.password) fail('invalid_tenant');
  for (const key of ['apiUrl', 'v1Url']) {
    const url = new URL(binding[key]);
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) fail('invalid_api_binding');
  }
  const sources = []; const excludedSources = []; const chunks = new Map(); const chunkTitles = new Map();
  for (const doc of [...corpus].sort((a, b) => a.id.localeCompare(b.id))) {
    let text; let publicationUrl; let redactedUrls = 0; let redactedSignedUrls = 0;
    try {
    if (secretLooking(JSON.stringify(doc))) fail('secret_looking_source');
    const replacements = new Map([...new Set([...doc.text].filter((c) => xmlUnsafe.test(c)))].map((c) => [c, 'LAYAXML' + sha256(doc.text + c) + 'END']));
    let safeText = doc.text;
    for (const [character, token] of replacements) {
      if (safeText.includes(token)) fail('placeholder_collision');
      safeText = safeText.replaceAll(character, token);
    }
    safeText = safeText.replace(/https?:\/\/[^\s<>"'`]+/g, (value) => {
      const url = URL.parse(value);
      if (!url || (!url.username && !url.password)) return value;
      url.username = ''; url.password = ''; redactedUrls++; return url.href;
    });
    let prepared;
    for (let attempts = 0; attempts < 32; attempts++) {
      try { prepared = preparedBody({ ...doc, text: safeText }, 'cloud'); break; }
      catch (error) {
        if (error.code !== 'ERR_INVALID_URL' || !error.input) throw error;
        const original = safeText.includes(error.input) ? error.input : error.input.match(/^https?:\/\//)?.[0];
        if (!original || !safeText.includes(original)) throw error;
        const token = 'https://laya-placeholder.invalid/' + sha256(doc.id + original) + '/';
        if (safeText.includes(token)) fail('placeholder_collision');
        replacements.set(original, token); safeText = safeText.replaceAll(original, token);
      }
    }
    if (prepared === undefined) fail('invalid_link_preparation_limit');
    for (const [original, token] of [...replacements].reverse()) prepared = prepared.replaceAll(token, original);
    prepared = prepared.replace(/https?:\/\/[^\s<>"'`]+/g, (value) => {
      const trailer = value.match(/[),.;]+$/)?.[0] ?? '';
      const url = URL.parse(trailer ? value.slice(0, -trailer.length) : value);
      if (!url) return value;
      let changed = false;
      for (const key of [...url.searchParams.keys()]) {
        if (/^(?:x-amz-|x-goog-)/i.test(key) || /^(?:access_token|token|signature)$/i.test(key)) { url.searchParams.delete(key); changed = true; }
      }
      if (!changed) return value;
      redactedSignedUrls++; return url.href + trailer;
    });
    const match = prepared.match(/^Source ID: [^\n]+\n\nSource: <([^\n]+)>\n\n/);
    if (!match) fail('invalid_prepared_provenance');
    text = prepared.slice(match[0].length); publicationUrl = match[1];
    } catch (error) {
      excludedSources.push({ id: doc.id, source_type: doc.source_type, source_path: doc.source_path, source_url: doc.source_url, private: doc.private, source_sha256: doc.sha256, reason: error.code ?? 'preparation_failed', detail: error.message });
      continue;
    }
    const keys = splitText(text).map((chunk, index) => {
      const key = 'text/' + sha256(chunk);
      if (chunks.has(key) && chunks.get(key) !== chunk) fail('hash_collision');
      chunks.set(key, chunk);
      if (!chunkTitles.has(key)) chunkTitles.set(key, doc.title + ' - ' + doc.source_path + ' (' + (index + 1) + ')');
      return key;
    });
    sources.push({ id: doc.id, title: doc.title, source_type: doc.source_type, source_path: doc.source_path, source_url: doc.source_url, publication_url: publicationUrl, private: doc.private, source_sha256: doc.sha256, prepared_sha256: sha256(text), redacted_url_credentials: redactedUrls, redacted_signed_urls: redactedSignedUrls, parent_id: doc.parent_id ?? null, chunks: keys });
  }
  const planHash = fingerprint({ schema: 1, binding, limits: LIMITS, sources, excludedSources, chunks: [...chunks] });
  const units = [];
  const add = (key, title, parent, text, links = [], children = false) => {
    const unit = { key, title: [...title.replace(/[\x00-\x1f\x7f]/g, ' ')].slice(0, 110).join('') + ' [' + planHash.slice(0, 12) + '-' + sha256(key).slice(0, 12) + ']', parent, text, links, children };
    if (Buffer.byteLength(renderUnit(unit, () => binding.tenant + '/wiki/pages/viewpage.action?pageId=' + '9'.repeat(24))) > LIMITS.bodyBytes) fail('catalog_entry_too_large');
    units.push(unit);
  };
  add('index', 'Text study catalog', null, 'Text-only source catalogs and deduplicated content. Notion parent identifiers are retained in catalog metadata; these catalogs do not reproduce native hierarchy.', [], true);
  const buckets = [...new Set([...chunks.keys()].map((key) => key.slice(5, 6)))].sort();
  for (const bucket of buckets) add('bucket/' + bucket, 'Content ' + bucket, 'index', 'Deduplicated text chunks.', [], true);
  for (const [key, text] of chunks) add(key, chunkTitles.get(key), 'bucket/' + key.slice(5, 6), text);
  const groups = new Map();
  for (const source of sources) {
    const group = source.source_type === 'github' ? source.source_path.split('/').slice(0, 2).join('/') : 'Notion';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(source);
  }
  for (const [group, aliases] of groups) {
    const key = 'group/' + sha256(group);
    add(key, group, 'index', 'Source catalog. Each entry retains original identity, privacy and hashes; links open stored text.', [], true);
    for (let at = 0, page = 0; at < aliases.length; page++) {
      const batch = []; let size = 0;
      while (at < aliases.length && batch.length < LIMITS.catalogSources) {
        const { source_url, ...safeAlias } = aliases[at];
        const row = { ...safeAlias, source_url: safeAlias.publication_url };
        const bytes = Buffer.byteLength(JSON.stringify(row));
        if (batch.length && size + bytes > LIMITS.chunkBytes) break;
        if (bytes > LIMITS.chunkBytes) fail('catalog_entry_too_large');
        batch.push(row); at++; size += bytes;
      }
      add(key + '/' + page, group + ' sources ' + (page + 1), key, JSON.stringify(batch), [...new Set(batch.flatMap((source) => source.chunks))]);
    }
  }
  return { schema: 1, binding, planHash, limits: LIMITS, sources, excludedSources, units, counts: { collected: corpus.length, publishable: sources.length, excluded: excludedSources.length, sources: sources.length, private: corpus.filter((s) => s.private).length, redactedUrlCredentials: sources.reduce((n, s) => n + s.redacted_url_credentials, 0), redactedSignedUrls: sources.reduce((n, s) => n + s.redacted_signed_urls, 0), textUnits: chunks.size, units: units.length, groups: groups.size, preparedBytes: [...chunks.values()].reduce((n, t) => n + Buffer.byteLength(t), 0) } };
}

export function renderUnit(unit, urlFor) {
  const encoded = xmlUnsafe.test(unit.text);
  const text = encoded ? JSON.stringify(unit.text) : unit.text;
  const catalog = unit.key.startsWith('group/') && unit.links.length ? JSON.parse(unit.text) : null;
  const navigation = catalog ? '<ul>' + catalog.map((source) => '<li><strong>' + escape(source.title) + '</strong> ' + escape(source.source_path) + source.chunks.map((key, index) => ' <a href="' + escape(urlFor(key)) + '">[' + (index + 1) + ']</a>').join('') + ' <a href="' + escape(source.publication_url) + '">Original</a></li>').join('') + '</ul>' : '';
  const payload = '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">text</ac:parameter><ac:plain-text-body><![CDATA[' + text.replaceAll(']]>', ']]]]><![CDATA[>') + ']]></ac:plain-text-body></ac:structured-macro>';
  return navigation + '<p>Publication unit: ' + escape(unit.key) + '</p>' + (encoded ? '<p>Text encoding: JSON string (XML control characters preserved).</p>' : '') + (catalog ? '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Source records</ac:parameter><ac:rich-text-body>' + payload + '</ac:rich-text-body></ac:structured-macro>' : payload) + (unit.children ? '<ac:structured-macro ac:name="children" />' : '');
}

function canonicalStorage(storage) {
  const $ = loadStorageXml(storage);
  const nodeValue = (node) => {
    if (node.type === 'text') return node.data;
    if (node.type === 'cdata') return node.children.map(nodeValue).join('');
    if (node.type !== 'tag') fail('unexpected_storage_node');
    const attrs = Object.entries(node.attribs).filter(([key]) => !['ac:macro-id', 'ac:schema-version'].includes(key)).sort();
    const children = [];
    for (const child of node.children) {
      const value = nodeValue(child);
      if (typeof value === 'string' && typeof children.at(-1) === 'string') children[children.length - 1] += value;
      else children.push(value);
    }
    return [node.name, attrs, children];
  };
  return JSON.stringify($.root().contents().toArray().map(nodeValue));
}

export async function checkAccess(api, plan, approval) {
  const b = plan.binding;
  if (api.config.deployment !== 'cloud' || api.config.siteUrl !== b.tenant || api.config.apiUrl !== b.apiUrl || api.config.v1Url !== b.v1Url) fail('tenant_mismatch');
  if (plan.counts.private && (!approval || approval.schema !== 1 || approval.private_space_visibility_approved !== true || approval.future_invited_users_may_read_acknowledged !== true || approval.site !== b.tenant || approval.api_url !== b.apiUrl || approval.api_v1_url !== b.v1Url || approval.space !== b.spaceKey || approval.space_id !== b.spaceId || approval.root_id !== b.rootId || approval.actor_id !== b.actorId || approval.roster_human_count !== 1 || approval.anonymous_grants !== 0 || approval.unlicensed_grants !== 0 || approval.plan !== 'Free' || !Number.isFinite(Date.parse(approval.verified_at)) || !Number.isFinite(Date.parse(approval.approved_at)))) fail('private_consent_required');
  const actor = await api.request('/user/current', { version: 1 });
  if (actor.accountId !== b.actorId) fail('actor_mismatch');
  const space = await api.getSpace(b.spaceKey);
  if (String(space.id) !== b.spaceId || space.key !== b.spaceKey) fail('space_mismatch');
  const root = await api.getPage(b.rootId);
  if (root.id !== b.rootId || root.spaceId !== b.spaceId || root.status !== 'current') fail('root_mismatch');
  const permissions = await api.request('/space/' + encodeURIComponent(b.spaceKey) + '?expand=permissions', { version: 1 });
  if (String(permissions.id) !== b.spaceId || permissions.key !== b.spaceKey || !Array.isArray(permissions.permissions)) fail('permissions_unavailable');
  for (const permission of permissions.permissions) {
    if (permission.anonymousAccess !== false || permission.unlicensedAccess !== false) fail('unsafe_space_permissions');
  }
  return { actorId: actor.accountId, rootId: root.id, spaceId: root.spaceId, anonymousGrants: 0, unlicensedGrants: 0, verifiedAt: new Date().toISOString() };
}

async function bounded(items, action) {
  let cursor = 0; let error;
  await Promise.all(Array.from({ length: LIMITS.concurrency }, async () => {
    while (!error && cursor < items.length) {
      const item = items[cursor++];
      try { await action(item); } catch (caught) { error ??= caught; }
    }
  }));
  if (error) throw error;
}

export async function publishPlan(api, plan, { output, approval } = {}) {
  if (!output) fail('output_required');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const lockPath = path.join(output, 'publication.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    const cacheFile = path.join(output, 'binding.json');
    const cache = await readJson(cacheFile, null);
    const expected = { schema: 1, planHash: plan.planHash, binding: plan.binding };
    if (cache && fingerprint(cache) !== fingerprint(expected)) fail('cache_binding_mismatch');
    const access = await checkAccess(api, plan, approval);
    await saveJson(path.join(output, 'access.json'), access);
    if (!cache) await saveJson(cacheFile, expected);
    const records = new Map(); const liveText = new Map();
    const urlFor = (key) => api.pageUrl(records.get(key).id);
    const ensure = async (unit) => {
      const file = path.join(output, 'units', sha256(unit.key) + '.json');
      const parentId = unit.parent ? records.get(unit.parent).id : plan.binding.rootId;
      const storage = renderUnit(unit, urlFor);
      if (Buffer.byteLength(storage) > LIMITS.bodyBytes) fail('storage_size_limit');
      const signature = fingerprint({ unit, parentId, storage });
      let entry = await readJson(file, null);
      if (entry && (entry.signature !== signature || entry.planHash !== plan.planHash)) fail('journal_changed');
      if (entry && !['accepted', 'confirmed'].includes(entry.status)) fail('ambiguous_mutation_requires_reconciliation');
      if (!entry) {
        entry = { key: unit.key, planHash: plan.planHash, signature, status: 'pending', parentId, title: unit.title };
        await saveJson(file, entry);
        const created = await api.request('/pages', { method: 'POST', body: { spaceId: plan.binding.spaceId, status: 'current', title: unit.title, parentId, body: { representation: 'storage', value: storage } } });
        entry.id = String(created.id); entry.version = created.version?.number; entry.status = 'accepted';
        await saveJson(file, entry);
      }
      if (!/^\d+$/.test(entry.id) || !Number.isInteger(entry.version) || entry.version < 1) fail('invalid_created_identity');
      const live = await api.getPage(entry.id);
      if (live.id !== entry.id || live.title !== unit.title || String(live.parentId) !== parentId || live.spaceId !== plan.binding.spaceId || live.status !== 'current' || live.version !== entry.version) fail('readback_identity_mismatch');
      if (canonicalStorage(live.storage) !== canonicalStorage(storage)) fail('readback_content_mismatch');
      const $ = loadStorageXml(live.storage);
      const payload = $('ac\\:plain-text-body').text();
      const text = xmlUnsafe.test(unit.text) ? JSON.parse(payload) : payload;
      if (text !== unit.text) fail('readback_text_mismatch');
      await saveJson(path.join(output, 'readback', sha256(unit.key) + '.json'), { id: live.id, version: live.version, key: unit.key, text, text_sha256: sha256(text), storage_sha256: sha256(live.storage), verifiedAt: new Date().toISOString() });
      entry.status = 'confirmed'; await saveJson(file, entry); records.set(unit.key, entry); liveText.set(unit.key, text);
    };
    const pending = new Map(plan.units.map((unit) => [unit.key, unit]));
    while (pending.size) {
      const ready = [...pending.values()].filter((unit) => (!unit.parent || records.has(unit.parent)) && unit.links.every((key) => records.has(key)));
      if (!ready.length) fail('plan_dependency_cycle');
      await bounded(ready, ensure);
      for (const unit of ready) pending.delete(unit.key);
    }
    const matched = plan.sources.map((source) => {
      const text = source.chunks.map((key) => liveText.get(key)).join('');
      if (sha256(text) !== source.prepared_sha256) fail('source_readback_mismatch');
      return { ...source, text, sha256: sha256(text), pages: source.chunks.map((key) => ({ id: records.get(key).id, version: records.get(key).version, url: urlFor(key) })) };
    });
    await saveJson(path.join(output, 'matched-corpus.json'), matched);
    await saveJson(path.join(output, 'mapping.json'), [...matched.map(({ text, ...source }) => ({ ...source, status: 'verified' })), ...plan.excludedSources.map((source) => ({ ...source, status: 'excluded' }))]);
    const summary = { ...plan.counts, confirmed: records.size, matched: matched.length, verified: matched.length, planHash: plan.planHash, writesRetried: 0 };
    await saveJson(path.join(output, 'publication.json'), summary); return summary;
  } finally { await lock.close(); await unlink(lockPath); }
}

export function parseOptions(args) {
  const { values } = parseArgs({ args, options: { corpus: { type: 'string', multiple: true }, binding: { type: 'string' }, output: { type: 'string' }, approval: { type: 'string' }, env: { type: 'string' }, publish: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) return values;
  if (!values.corpus?.length || !values.binding || !values.output || Object.values(values).some((v) => typeof v === 'string' && !v.trim()) || values.corpus.some((v) => !v.trim())) fail('invalid_arguments');
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log('Usage: node experiments/laya-wiki/text_publish.mjs --corpus FILE [--corpus FILE] --binding FILE --output DIR [--publish --env FILE --approval FILE]\nDefault: offline plan only. Binding: {tenant,apiUrl,v1Url,spaceId,spaceKey,rootId,actorId}. Private approval: {schema:1,private_space_visibility_approved:true,future_invited_users_may_read_acknowledged:true,site,api_url,api_v1_url,space,space_id,root_id,actor_id,roster_human_count:1,anonymous_grants:0,unlicensed_grants:0,plan:"Free",verified_at,approved_at}. Publish never retries mutations; pending journals require manual reconciliation.');
    else {
      const corpus = (await Promise.all(options.corpus.map((file) => readJson(file)))).flat();
      const plan = buildPlan(corpus, await readJson(options.binding));
      await saveJson(path.join(options.output, 'plan.json'), plan);
      const result = options.publish ? await publishPlan(new ConfluenceApi(readWikiConfig(await loadProfile(options.env))), plan, { output: options.output, approval: options.approval ? await readJson(options.approval) : null }) : plan.counts;
      console.log(JSON.stringify(Object.fromEntries(Object.entries(result).filter(([, value]) => typeof value === 'number'))));
    }
  } catch (error) { console.error(JSON.stringify({ error: error.code ?? 'publication_failed', httpStatus: error.status ?? null })); process.exitCode = 1; }
}
