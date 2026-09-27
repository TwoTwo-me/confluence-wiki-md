import { applyAgentEdit } from './agent-edit.mjs';
import { readStorageSnapshot } from './evidence.mjs';
import { bodyHash, formatDocument } from './document.mjs';
import { upload } from './wiki.mjs';
import { readWikiRoot } from './wiki-init.mjs';

function requireSpaceKey(space) {
  if (typeof space !== 'string' || !space.trim()) throw new Error('An explicit trusted space key is required.');
  return space.trim();
}

function requireNumericId(id, label = 'Page ID') {
  const value = String(id ?? '');
  if (!/^\d+$/.test(value)) throw new Error(label + ' must be numeric.');
  return value;
}

function requireTerm(term) {
  if (typeof term !== 'string' || !term.trim() || [...term.trim()].length > 200 || /[\u0000-\u001f\u007f]/.test(term)) {
    throw new Error('Term must be 1-200 characters without control characters.');
  }
  return term.trim().normalize('NFC');
}

function requireContent(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('Explicit Markdown content is required.');
  return content.trim();
}

async function trustedRoot(api, space, rootId) {
  const root = requireNumericId(rootId, 'Wiki root ID');
  return readWikiRoot(api, root, { space });
}

async function trustedTerm(api, space, rootId, id) {
  const termId = requireNumericId(id);
  if (termId === rootId) throw new Error('The wiki root cannot be used as a term page.');
  const snapshot = await readStorageSnapshot(api, termId, { space });
  if (snapshot.parentId !== rootId) throw new Error('The selected page is not a direct child of the verified wiki root.');
  return snapshot;
}

function externalUrl(value) {
  if (typeof value !== 'string') throw new Error('Source URLs must be HTTP or HTTPS URLs.');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Source URLs must be HTTP or HTTPS URLs.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Source URLs must be HTTP or HTTPS URLs without embedded credentials.');
  }
  return parsed.href;
}

async function renderContent(api, space, content, relatedIds, sourceUrls, selfId) {
  const uniqueIds = [...new Set(relatedIds.map((id) => requireNumericId(id, 'Related page ID')))];
  const related = [];
  for (const id of uniqueIds) {
    if (id === selfId) throw new Error('A term page cannot link to itself as a related page.');
    const page = await readStorageSnapshot(api, id, { space });
    related.push({ id, title: page.title, version: page.version, url: page.url });
  }
  const sources = [...new Set(sourceUrls.map(externalUrl))].map((url) => ({ url, fetched: false }));
  const sections = [content];
  if (related.length) sections.push('## Related pages\n\n' + related.map((page) => '- [' + String(page.title ?? 'Untitled page').replace(/[\[\]\r\n]/g, ' ') + '](' + page.url + ') (ID: ' + page.id + ', version: ' + page.version + ')').join('\n'));
  if (sources.length) sections.push('## Sources (not fetched)\n\n' + sources.map((source) => '- [' + source.url + '](<' + source.url + '>) (not fetched)').join('\n'));
  return { markdown: sections.join('\n\n'), related, sources };
}

async function exactChildren(api, space, rootId, title) {
  const listed = await api.listPages({ space, parent: rootId, limit: 1001 });
  if (listed.length >= 1001) throw new Error('Too many root children to verify an exact-title match safely; refusing creation.');
  const titleMatches = listed.filter((page) => page.title === title);
  if (titleMatches.some((page) => !/^\d+$/.test(String(page.id ?? '')))) {
    throw new Error('An exact-title child could not be identified safely; refusing creation.');
  }
  const ids = [...new Set(titleMatches.map((page) => String(page.id)))];
  const exact = [];
  for (const id of ids) {
    const snapshot = await readStorageSnapshot(api, id, { space });
    if (snapshot.title === title && snapshot.parentId === rootId) exact.push(snapshot);
  }
  if (exact.length > 1) throw new Error('Multiple exact-title children already exist under the selected root; refusing an ambiguous term.');
  if (exact.length === 1) throw new Error('An exact-title term child already exists under the selected root (ID ' + exact[0].id + ').');
}

export async function createTerm(api, { space: inputSpace, rootId, term: inputTerm, content: inputContent, relatedIds = [], sourceUrls = [] } = {}) {
  const space = requireSpaceKey(inputSpace);
  const term = requireTerm(inputTerm);
  const content = requireContent(inputContent);
  const root = await trustedRoot(api, space, rootId);
  const selectedSpace = await api.getSpace(space);
  if (String(selectedSpace.id) !== root.space.id || selectedSpace.key !== space) throw new Error('The selected space identity changed while verifying the wiki root.');
  await exactChildren(api, space, root.id, term);
  const prepared = await renderContent(api, space, content, relatedIds, sourceUrls);
  const document = formatDocument({ metadata: { type: 'DefinedTerm', title: term }, body: prepared.markdown });
  let written;
  try {
    const saved = await upload(api, document, {
      title: term,
      space,
      parent: root.id,
      onWrite: (doc) => { written = doc; },
    });
    written = saved;
    const snapshot = await trustedTerm(api, space, root.id, saved.metadata.confluence.id);
    return {
      status: 'created', id: snapshot.id, title: snapshot.title, parentId: snapshot.parentId,
      version: snapshot.version, url: snapshot.url, spaceId: snapshot.space.id,
      related: prepared.related, sources: prepared.sources, warnings: saved.warnings ?? [],
    };
  } catch (error) {
    if (!written?.metadata?.confluence?.id) throw error;
    const meta = written.metadata.confluence;
    return {
      status: 'partial', id: meta.id, title: written.metadata.title ?? term,
      parentId: meta.parent_id ?? root.id, version: meta.version ?? null,
      url: meta.url ?? api.pageUrl(meta.id), spaceId: String(selectedSpace.id),
      outcome: 'metadata-sync-failed', message: 'The term page was created, but secondary synchronization did not complete.',
      related: prepared.related, sources: prepared.sources,
    };
  }
}

export async function readTerm(api, { space: inputSpace, id, rootId } = {}) {
  const space = requireSpaceKey(inputSpace);
  const pageId = requireNumericId(id);
  const snapshot = await readStorageSnapshot(api, pageId, { space });
  if (rootId !== undefined) {
    const root = await trustedRoot(api, space, rootId);
    if (pageId === root.id || snapshot.parentId !== root.id) throw new Error('The selected page is not a term child of the verified wiki root.');
  }
  return {
    status: 'read', id: snapshot.id, title: snapshot.title, parentId: snapshot.parentId,
    version: snapshot.version, url: snapshot.url, spaceId: snapshot.space.id,
    body: snapshot.markdown, warnings: snapshot.warnings,
  };
}

export async function updateTerm(api, { space: inputSpace, rootId, id, version, term: inputTerm, content: inputContent, relatedIds = [], sourceUrls = [] } = {}) {
  const space = requireSpaceKey(inputSpace);
  const root = await trustedRoot(api, space, rootId);
  const termId = requireNumericId(id);
  const snapshot = await trustedTerm(api, space, root.id, termId);
  if (!Number.isSafeInteger(version) || version !== snapshot.version) throw new Error('Term version changed. Read the current page and prepare the update again.');
  const term = requireTerm(inputTerm ?? snapshot.title);
  const content = requireContent(inputContent);
  const prepared = await renderContent(api, space, content, relatedIds, sourceUrls, termId);
  const baseline = {
    metadata: {
      type: 'DefinedTerm',
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
  const draft = formatDocument({ ...baseline, metadata: { ...baseline.metadata, title: term }, body: prepared.markdown });
  const outcome = await applyAgentEdit(api, formatDocument(baseline), draft, { space, wikiRoot: root.id });
  if (outcome.status !== 'success') return outcome;
  let updated;
  try {
    updated = await trustedTerm(api, space, root.id, termId);
  } catch {
    return {
      status: 'partial', id: termId, attemptedVersion: outcome.version, outcome: 'unresolved',
      message: 'The term update was saved, but its final root membership could not be confirmed.',
      resources: { ...outcome.resources, page: { status: 'unresolved', attemptedVersion: outcome.version } },
    };
  }
  return {
    status: 'updated', id: updated.id, title: updated.title, parentId: updated.parentId,
    version: updated.version, url: updated.url, spaceId: updated.space.id,
    related: prepared.related, sources: prepared.sources, warnings: outcome.warnings,
  };
}

export async function trashTerm(api, { space: inputSpace, rootId, id, version, confirmed = false } = {}) {
  const space = requireSpaceKey(inputSpace);
  if (!confirmed) throw new Error('Trashing a term requires explicit confirmation.');
  const root = await trustedRoot(api, space, rootId);
  const termId = requireNumericId(id);
  if (termId === root.id) throw new Error('The wiki root cannot be moved to trash.');
  const snapshot = await trustedTerm(api, space, root.id, termId);
  if (!Number.isSafeInteger(version) || version !== snapshot.version) throw new Error('Term version changed. Read the current page before trashing it.');
  try {
    await api.deletePage(termId);
  } catch (error) {
    if (error?.status === 409 || error?.status === 404) throw new Error('The term changed or became inaccessible after preflight; its trash state is unresolved.');
    throw error;
  }
  return {
    status: 'trashed', id: termId, version: snapshot.version, url: snapshot.url,
    spaceId: snapshot.space.id, preflightVersion: snapshot.version, racePossible: true,
    deletion: 'Confluence accepted the trash request after a version preflight; delete is not conditional on that version.',
  };
}
