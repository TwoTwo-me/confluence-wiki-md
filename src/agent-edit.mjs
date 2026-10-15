import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ApiError } from './api.mjs';
import { parseDocument, formatDocument, bodyHash, markdownToStorage, storageToMarkdown, validateAgentPreservation, validateStorageXml, loadStorageXml } from './document.mjs';
import { readStorageSnapshot } from './evidence.mjs';
import { mergeDocument } from './merge.mjs';
import { upload } from './wiki.mjs';

// Cached source may omit the one final newline emitted by storageToMarkdown.
// Do not trim body whitespace or trust cached prose as historical authority.
const canonicalBody = (body) => body.endsWith('\n') ? body : body + '\n';

function assignCloudMacroIds(storage, preserved) {
  const $ = loadStorageXml(storage);
  const opaque = new Set(preserved.map((fragment) => fragment.storage));
  const supported = new Set(['code', 'toc', 'info', 'note', 'tip', 'warning', 'panel', 'expand', 'quote', 'anchor']);
  const raw = (node) => storage.slice(node.startIndex, node.endIndex + 1);
  const insertions = [];
  for (const node of $('ac\\:structured-macro, ac\\:macro').toArray()) {
    if (!supported.has($(node).attr('ac:name')) || $(node).attr('ac:macro-id') !== undefined ||
        [node, ...$(node).parents().toArray()].some((ancestor) => opaque.has(raw(ancestor)))) continue;
    // Splice only the opening tag. Serializing the whole document could change
    // quotes/entities inside a byte-exact native fragment elsewhere in it.
    let quote = null;
    for (let cursor = node.startIndex; cursor <= node.endIndex; cursor++) {
      const character = storage[cursor];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') {
        insertions.push({ at: storage[cursor - 1] === '/' ? cursor - 1 : cursor, value: ' ac:macro-id="' + randomUUID() + '"' });
        break;
      }
    }
  }
  for (const { at, value } of insertions.sort((left, right) => right.at - left.at)) storage = storage.slice(0, at) + value + storage.slice(at);
  return storage;
}

export function equivalentStorage(left, right, preserved) {
  for (const fragment of preserved) {
    if ([left, right].some((storage) => storage.split(fragment.storage).length - 1 !== 1)) return false;
  }
  try {
    validateStorageXml(left);
    validateStorageXml(right);
  } catch {
    return false;
  }
  if (left === right) return true;
  // Cheerio conflates XML control references with literal whitespace during
  // attribute/EOL normalization. These inputs require exact storage bytes.
  if ([left, right].some((storage) => /&#(?:0*(?:9|10|13)|x0*[9ad]);/i.test(storage))) {
    return false;
  }
  const fragments = new Map(preserved.map((fragment) => [fragment.storage, fragment]));
  const blocks = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'hr', 'pre']);
  const containers = new Set(['ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tfoot', 'tr']);
  const project = (storage) => {
    let $;
    try {
      $ = loadStorageXml(storage);
    } catch {
      return null;
    }
    const originalXml = (node) => storage.slice(node.startIndex, node.endIndex + 1);
    const block = (node) => node?.type === 'tag' &&
      (blocks.has(node.name) || fragments.get(originalXml(node))?.block === true);
    const visit = (node) => {
      if (node.type === 'text') {
        // Only inter-block layout whitespace is insignificant. Inline spaces,
        // preformatted text, attributes and element structure remain exact.
        if (/^[\t\r\n ]*$/.test(node.data) &&
            (node.parent.type === 'root' || containers.has(node.parent.name)) &&
            (!node.prev || block(node.prev)) && (!node.next || block(node.next))) return [];
        return [node.data];
      }
      if (node.type === 'tag' && fragments.has(originalXml(node))) return [{ xml: originalXml(node) }];
      // Whitespace sensitivity is inherited. Keep these whole subtrees opaque,
      // including descendants that would otherwise look like block containers.
      if (node.type !== 'tag' || node.name === 'pre' || node.attribs['xml:space'] === 'preserve' ||
          node.name.includes(':')) {
        return [{ xml: $.xml(node) }];
      }
      return [{
        name: node.name,
        attributes: Object.entries(node.attribs).sort(([a], [b]) => a.localeCompare(b)),
        children: node.children.flatMap(visit),
      }];
    };
    return $.root()[0].children.flatMap(visit);
  };
  const original = project(left);
  const transformed = project(right);
  return original !== null && transformed !== null && isDeepStrictEqual(original, transformed);
}

function storageIsRepresentable(snapshot) {
  const fragments = new Map(snapshot.preserved.map((item, index) => [item.storage, index]));
  const project = (storage) => {
    const $ = loadStorageXml(storage);
    const parts = [];
    const counts = snapshot.preserved.map(() => 0);
    let unhandledCdata = false;
    const visit = (node) => {
      // Turndown can silently discard CDATA. Only a whole trusted native
      // ancestor, retained verbatim without visiting children, may bypass it.
      if (node.type === 'cdata') {
        unhandledCdata = true;
        return;
      }
      const fragment = node.type === 'tag' ? fragments.get(storage.slice(node.startIndex, node.endIndex + 1)) : undefined;
      if (fragment !== undefined) {
        counts[fragment]++;
        parts.push({ fragment });
        return;
      }
      if (node.type === 'text') {
        const text = node.data.replace(/\s+/g, ' ').trim();
        if (text) parts.push(text);
      }
      for (const child of node.children ?? []) visit(child);
    };
    for (const node of $.root()[0].children) visit(node);
    return unhandledCdata || counts.some((count) => count !== 1) ? null : parts;
  };
  const original = project(snapshot.storage);
  if (original === null) return false;
  const rendered = markdownToStorage(snapshot.markdown, { preserved: snapshot.preserved });
  return isDeepStrictEqual(original, project(rendered.storage));
}

function snapshotDocument(snapshot) {
  return {
    metadata: {
      type: 'Reference',
      title: snapshot.title,
      confluence: {
        deployment: snapshot.tenant.deployment,
        api_url: snapshot.tenant.apiUrl,
        site_url: snapshot.tenant.siteUrl,
        id: snapshot.id,
        space: snapshot.space.key,
        version: snapshot.version,
        status: snapshot.status,
        parent_id: snapshot.parentId,
        url: snapshot.url,
        storage_hash: snapshot.storageHash,
        base_body_hash: bodyHash(snapshot.markdown),
        preserved: snapshot.preserved,
      },
    },
    body: snapshot.markdown,
  };
}

function portableSnapshotDocument(snapshot, api) {
  const document = snapshotDocument(snapshot);
  const kept = [];
  for (const fragment of snapshot.preserved) {
    const converted = storageToMarkdown(fragment.storage, {
      pageUrl: snapshot.url, siteUrl: api.config.webBase, pageId: snapshot.id,
      diagramProfile: api.config.diagramProfile,
      preserve: 'minimal',
    });
    const replacement = converted.markdown.trimEnd();
    const ordinary = replacement === fragment.markdown;
    const toc = /^`{3,}confluence-toc\n/.test(replacement);
    // Never replace a projected evidence fallback with a lossy conversion of
    // its raw XML (notably rich-text CDATA). Unknown/custom native XML remains
    // a byte-exact fragment. Portable content must match trusted evidence.
    if (!converted.preserved.length && (ordinary || toc)) document.body = document.body.replace(fragment.markdown, () => replacement);
    else kept.push(fragment);
  }
  document.metadata.confluence.preserved = kept;
  document.metadata.confluence.base_body_hash = bodyHash(document.body);
  return document;
}

const userFields = (metadata) => Object.fromEntries(
  Object.entries(metadata).filter(([key]) => !['title', 'confluence', 'preserved'].includes(key)),
);

const pageTuple = (page) => ({
  id: page.id,
  title: page.title,
  parentId: page.parentId ?? null,
  spaceId: page.spaceId ?? page.space.id,
  status: page.status,
  storage: page.storage,
  version: page.version,
});

/**
 * Apply an existing page's verified body/title edit. Sources are Markdown text,
 * not paths. Conflict means no accepted page write; partial means unresolved
 * publication, never permission to retry or overwrite automatically.
 * wikiRoot is a caller-trusted direct-parent constraint, never a draft field.
 */
export async function applyAgentEdit(api, baseSource, draftSource, { space, wikiRoot } = {}) {
  let id;
  let directory;
  let attempted = false;
  let rejectedVersion = false;
  let rootMismatch = false;
  let intended;
  let confirmed;
  let pageOutcome = { status: 'not_attempted' };
  let resources = {
    property: { status: 'preserved' },
    labels: { status: 'preserved' },
    attachments: { status: 'preserved' },
  };
  const conflict = (code, message, conflicts = [{ code, message }]) => ({ status: 'conflict', id: id ?? null, conflicts });
  const requireRoot = (page) => {
    if (wikiRoot !== undefined && (page.id === wikiRoot || page.parentId !== wikiRoot)) {
      rootMismatch = true;
      throw new Error('The page is not a direct child of the selected wiki root.');
    }
  };
  const readCurrent = async () => {
    const snapshot = await readStorageSnapshot(api, id, { space });
    requireRoot(snapshot);
    return snapshot;
  };
  try {
    const base = parseDocument(baseSource);
    const draft = parseDocument(draftSource);
    const binding = base.metadata.confluence;
    id = binding?.id;
    if (typeof space !== 'string' || !space.trim() || !/^\d+$/.test(id ?? '')) {
      return conflict('binding', 'An existing numeric page ID and exact trusted space are required.');
    }
    if (wikiRoot !== undefined) {
      wikiRoot = String(wikiRoot);
      if (!/^\d+$/.test(wikiRoot) || wikiRoot === id) {
        return conflict('wiki_root', 'A numeric wiki root distinct from the edited page is required.');
      }
    }
    for (const doc of [base, draft]) {
      const meta = doc.metadata.confluence;
      if (meta?.id !== id || meta.space !== space ||
          meta.deployment !== api.config.deployment || meta.api_url !== api.config.apiUrl ||
          meta.site_url !== api.config.siteUrl || !Number.isSafeInteger(meta.version) || meta.version < 1) {
        return conflict('binding', 'Both documents must bind the same existing page, tenant and exact space.');
      }
    }
    if (draft.metadata.confluence.version !== binding.version) {
      return conflict('binding', 'The draft must retain its baseline version.');
    }
    // Historical raw storage cannot authenticate arbitrary historical properties.
    // Do not interpret an unprovable property change as a B-to-L edit.
    if (!isDeepStrictEqual(userFields(base.metadata), userFields(draft.metadata)) ||
        !isDeepStrictEqual(base.metadata.preserved, draft.metadata.preserved)) {
      return conflict('unverified_metadata', 'Only storage-verifiable body and title edits can be applied automatically.');
    }

    const historical = await readStorageSnapshot(api, id, { space, version: binding.version });
    if (!storageIsRepresentable(historical)) {
      return conflict('representation', 'Historical storage cannot be represented safely as Markdown and trusted native fragments.');
    }
    // Downloads may omit XML for content fully represented by supported
    // Markdown. Infer that representation only from a verified historical
    // snapshot; no omitted unknown fragment or draft-provided XML is trusted.
    const portable = (binding.preserved?.length ?? 0) < historical.preserved.length;
    const trustedBase = portable ? portableSnapshotDocument(historical, api) : snapshotDocument(historical);
    if (binding.storage_hash !== historical.storageHash || canonicalBody(base.body) !== trustedBase.body ||
        base.metadata.title !== historical.title) {
      return conflict('unverified_baseline', 'The claimed hash, body and title must match historical Confluence storage.');
    }
    for (const doc of [base, draft]) {
      const validation = validateAgentPreservation(doc, trustedBase);
      if (validation.conflicts.length) return conflict('preservation', 'Untrusted native fragments.', validation.conflicts);
    }
    const current = await readCurrent();
    if (!storageIsRepresentable(current)) {
      return conflict('representation', 'Current storage cannot be represented safely as Markdown and trusted native fragments.');
    }
    if (current.version < historical.version) return conflict('version', 'Current storage predates the verified baseline.');
    if (current.version === historical.version &&
        !isDeepStrictEqual(pageTuple(current), pageTuple({ ...historical, status: 'current' }))) {
      return conflict('version', 'Current storage changed without advancing the verified baseline version.');
    }
    const trustedRemote = portable ? portableSnapshotDocument(current, api) : snapshotDocument(current);
    const local = {
      metadata: {
        ...trustedBase.metadata,
        title: draft.metadata.title ?? historical.title,
        confluence: { ...trustedBase.metadata.confluence, preserved: draft.metadata.confluence.preserved ?? [] },
      },
      body: canonicalBody(draft.body),
    };
    const merged = mergeDocument(trustedBase, local, trustedRemote);
    if (merged.conflicts.length) return conflict('merge', 'Concurrent edits cannot be merged safely.', merged.conflicts);
    const validation = validateAgentPreservation(merged.document, trustedRemote);
    if (validation.conflicts.length) return conflict('preservation', 'Ambiguous merged native fragments.', validation.conflicts);
    merged.document.metadata.confluence.preserved = validation.preserved;

    // Carry forward current OKF fields, never source.body/source.preserved or
    // property-provided identity. These fields do not participate in B/L/R.
    const property = await api.getProperty(id);
    const metadata = property?.value?.metadata ?? {};
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return conflict('metadata', 'Current OKF metadata is not a mapping.');
    }
    merged.document.metadata = {
      ...userFields(metadata),
      ...merged.document.metadata,
      type: metadata.type ?? 'Reference',
    };

    directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-agent-edit-'));
    const filename = path.join(directory, 'merged.md');
    await writeFile(filename, formatDocument(merged.document), { flag: 'wx', mode: 0o600 });
    // Scope preservation to this invocation; never mutate the shared API/profile.
    const scoped = Object.create(api);
    scoped.config = { ...api.config, preserve: 'all' };
    const matchesIntended = (page) => isDeepStrictEqual({ ...pageTuple(page), storage: intended.storage }, intended) &&
      equivalentStorage(page.storage, intended.storage, validation.preserved);
    scoped.getProperty = async (pageId) => {
      const latest = await api.getProperty(pageId);
      if (!isDeepStrictEqual(latest, property)) {
        throw new Error('OKF metadata changed concurrently; synchronization remains unresolved.');
      }
      if (wikiRoot !== undefined) await scoped.getPage();
      return latest;
    };
    scoped.getPage = async () => {
      try {
        const latest = await readCurrent();
        const matches = attempted && !confirmed
          ? matchesIntended(latest)
          : isDeepStrictEqual(pageTuple(latest), confirmed ?? pageTuple(current));
        if (!matches) {
          throw new Error('Published storage does not match the complete intended page update.');
        }
        // Normalization is admitted once. Later same-version changes are not
        // another normalization opportunity or permission to replay the PUT.
        if (attempted) confirmed ??= pageTuple(latest);
        return { ...latest, spaceId: latest.space.id, spaceKey: latest.space.key };
      } catch (error) {
        if (attempted) pageOutcome = { status: 'unresolved', attemptedVersion: intended.version };
        throw error;
      }
    };
    scoped.writePage = async (page) => {
      if (wikiRoot !== undefined) {
        requireRoot(page);
        await scoped.getPage();
      }
      if (page.id !== id || page.version !== current.version || String(page.space.id) !== current.space.id ||
          page.space.key !== space || (page.parentId ?? null) !== current.parentId) {
        throw new Error('Upload changed the verified page binding.');
      }
      // Cloud assigns IDs to new native macros. Supply them before freezing the
      // intended tuple, keeping strict readback and identical retry payloads.
      if (api.config.deployment === 'cloud') page = { ...page, storage: assignCloudMacroIds(page.storage, validation.preserved) };
      for (const fragment of validation.preserved) {
        if (page.storage.split(fragment.storage).length - 1 !== 1) {
          throw new Error('Upload did not preserve a trusted native fragment exactly once.');
        }
      }
      intended = pageTuple({ ...page, spaceId: String(page.space.id), status: 'current', version: current.version + 1 });
      attempted = true;
      pageOutcome = { status: 'unresolved', attemptedVersion: intended.version };
      let written;
      try {
        written = await api.writePage(page);
      } catch (error) {
        rejectedVersion = error instanceof ApiError && error.status === 409;
        if (rejectedVersion) throw error;
        let latest = await readCurrent();
        // A transport failure at the unchanged complete base permits one replay
        // of this same versioned request, never a new version or an unbound POST.
        if (!(error instanceof ApiError) && isDeepStrictEqual(pageTuple(latest), pageTuple(current))) {
          try {
            written = await api.writePage(page);
          } catch {
            // Even a retry rejection cannot establish what the first request did.
            latest = await readCurrent();
          }
        }
        if (!written) {
          if (!matchesIntended(latest)) throw error;
          confirmed = pageTuple(latest);
          written = { ...latest, spaceId: latest.space.id, spaceKey: latest.space.key };
          // Matching contents prove state, not which writer produced it.
          pageOutcome = { status: 'reconciled', version: latest.version, authorship: 'unknown' };
        }
      }
      if (written.id !== id || written.version !== intended.version) {
        throw new Error('The write response did not confirm the intended page identity and version.');
      }
      if (pageOutcome.status !== 'reconciled') pageOutcome = { status: 'saved', version: written.version };
      return written;
    };
    const document = await upload(scoped, await readFile(filename, 'utf8'), {
      filename, space, id, version: current.version,
      // A verified title change also changes OKF's title. Only that explicit
      // intent opts into the guarded property write; a body-only edit preserves
      // the property rather than refreshing a cache or copying draft metadata.
      secondarySync: {
        property: merged.document.metadata.title !== current.title && merged.document.metadata.title !== metadata.title,
        labels: false, attachments: false,
      },
    });
    resources = document.resources;
    const actual = await scoped.getPage();
    resources = { ...resources, page: pageOutcome };
    document.resources = resources;
    return { status: 'success', id, version: actual.version, document, resources, warnings: [
      ...historical.warnings, ...actual.warnings,
      ...(pageOutcome.status === 'reconciled' ? ['Intended page state reconciled after an uncertain response; authorship is unknown.'] : []),
    ] };
  } catch (error) {
    if (!attempted || rejectedVersion) {
      return conflict(rootMismatch ? 'wiki_root' : rejectedVersion ? 'version' : 'validation', error.message);
    }
    return {
      status: 'partial', id, attemptedVersion: intended.version, outcome: 'unresolved', message: error.message,
      ...(rootMismatch ? { code: 'wiki_root' } : {}),
      resources: { ...(error.resources ?? resources), page: pageOutcome },
    };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
