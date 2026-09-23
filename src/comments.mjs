import { parseDocument, formatDocument, markdownToStorage, storageToMarkdown } from './document.mjs';

const dc = (api) => api.config.deployment === 'datacenter';
const numeric = (value) => { if (!/^\d+$/.test(String(value))) throw new Error('Comment/page ID must be numeric.'); return String(value); };
const positive = (value) => { if (!Number.isSafeInteger(value) || value < 1) throw new Error('Expected version/limit must be a positive integer.'); return value; };
const kindOf = (kind) => { if (!['footer', 'inline'].includes(kind)) throw new Error('Comment kind must be footer or inline.'); return kind; };
const unsupported = (operation) => { throw new Error('Data Center ' + operation + ' is not supported by this CLI.'); };
const resource = (api, id, kind) => dc(api) ? '/content' + (id ? '/' + id : '') : '/' + kind + '-comments' + (id ? '/' + id : '');
const expand = 'body.storage,version,history,ancestors,container,extensions.inlineProperties,extensions.resolution';

function commentUrl(api, link) {
  if (!link) return null;
  if (typeof link !== 'string' || /[\\\x00-\x20\x7f]/.test(link)) throw new Error('Unsafe comment permalink.');
  const base = new URL(api.config.webBase);
  const candidate = new URL(link, base.href + '/');
  if (!['http:', 'https:'].includes(candidate.protocol) || candidate.origin !== base.origin || candidate.username || candidate.password) throw new Error('Unsafe comment permalink.');
  const context = base.pathname.replace(/\/$/, '');
  const pathname = decodeURIComponent(link.split(/[?#]/)[0]);
  if (pathname.split('/').some((part) => part === '..' || part === '.')) throw new Error('Unsafe comment permalink.');
  if (context && candidate.pathname !== context && !candidate.pathname.startsWith(context + '/')) candidate.pathname = context + '/' + candidate.pathname.replace(/^\/+/, '');
  return candidate.href;
}

function normalize(api, raw, kind, context = {}) {
  const id = numeric(raw.id);
  if (raw.type && raw.type !== 'comment') throw new Error('Target is not a comment.');
  const actualKind = raw.extensions?.location ?? (raw.extensions?.inlineProperties ? 'inline' : kind);
  if (actualKind !== kind) throw new Error('Comment kind does not match target.');
  const version = raw.version?.number ?? null;
  if (version !== null) positive(version);
  const storage = raw.body?.storage?.value;
  if (typeof storage !== 'string') throw new Error('Comment storage body is missing.');
  const parent = raw.parentCommentId ?? raw.ancestors?.filter((item) => item.type === 'comment').at(-1)?.id ?? context.parentCommentId ?? null;
  const page = raw.pageId ?? (raw.container?.type === 'page' ? raw.container.id : undefined) ?? raw.ancestors?.filter((item) => item.type === 'page').at(-1)?.id ?? context.pageId ?? null;
  const url = commentUrl(api, raw._links?.webui);
  const resolution = raw.resolutionStatus ?? raw.extensions?.resolution?.status;
  return { id, pageId: page === null ? null : String(page), parentCommentId: parent === null ? null : String(parent), kind, version,
    authorId: raw.authorId ?? raw.history?.createdBy?.accountId ?? raw.history?.createdBy?.username ?? raw.version?.authorId ?? raw.version?.by?.username ?? null,
    createdAt: raw.createdAt ?? raw.history?.createdDate ?? null, updatedAt: raw.version?.createdAt ?? raw.version?.when ?? null,
    resolved: typeof raw.resolved === 'boolean' ? raw.resolved : resolution === 'resolved' ? true : resolution === 'open' || resolution === 'reopened' ? false : null,
    storage, body: storageToMarkdown(storage, { siteUrl: api.config.siteUrl, pageUrl: url ?? undefined, pageId: page, preserve: 'none' }).markdown, url };
}

function inputDocument(api, input, expected) {
  const doc = typeof input === 'string' ? parseDocument(input) : input;
  if (!doc || typeof doc.body !== 'string' || !doc.body.trim()) throw new Error('Comment body must not be empty.');
  if (doc.metadata?.confluence !== undefined) throw new Error('Page metadata cannot be used for a comment.');
  const meta = doc.metadata?.confluence_comment;
  if (meta !== undefined) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('confluence_comment must be a mapping.');
    const checks = { site: api.config.siteUrl, api: api.config.apiUrl, ...expected };
    for (const [key, value] of Object.entries(checks)) {
      if (meta[key] !== undefined && meta[key] !== null && (value === null || value === undefined || String(meta[key]) !== String(value))) throw new Error('Comment metadata ' + key + ' does not match the explicit target.');
    }
    if (meta.version !== undefined) positive(meta.version);
  }
  return doc;
}

function storageBody(doc) {
  // The page converter treats this one fence specially; comments keep every fence as code.
  const body = doc.body.replace(/^([ \t]*)(`{3,}|~{3,})confluence-toc(?=\s|$)/gm, '$1$2text');
  return markdownToStorage(body).storage;
}

export async function listComments(api, pageId, { kind = 'footer', limit = 1000 } = {}) {
  numeric(pageId); kindOf(kind); positive(limit);
  const path = dc(api) ? '/content/' + pageId + '/child/comment?' + new URLSearchParams({ location: kind, depth: 'all', expand, limit: String(Math.min(limit, 100)) }) : '/pages/' + pageId + '/' + kind + '-comments?body-format=storage&limit=' + Math.min(limit, 100);
  return (await api.paginate(path, { version: dc(api) ? 1 : 2, limit })).map((raw) => normalize(api, raw, kind, { pageId: String(pageId) }));
}

export async function getComment(api, id, { kind = 'footer' } = {}) {
  numeric(id); kindOf(kind);
  const raw = await api.request(resource(api, id, kind) + '?' + (dc(api) ? new URLSearchParams({ expand }) : 'body-format=storage'), { version: dc(api) ? 1 : 2 });
  const comment = normalize(api, raw, kind);
  if (comment.id !== String(id)) throw new Error('Returned comment ID does not match target.');
  return comment;
}

export async function listReplies(api, id, { kind = 'footer', limit = 1000 } = {}) {
  numeric(id); kindOf(kind); positive(limit);
  if (dc(api)) unsupported('reply traversal');
  const parent = await getComment(api, id, { kind });
  return (await api.paginate(resource(api, id, kind) + '/children?body-format=storage&limit=' + Math.min(limit, 100), { limit })).map((raw) => normalize(api, raw, kind, { pageId: parent.pageId, parentCommentId: String(id) }));
}

export async function createComment(api, targetId, input, { kind = 'footer', reply = false, selection, selectionCount, selectionIndex } = {}) {
  numeric(targetId); kindOf(kind);
  if (dc(api) && (reply || kind === 'inline')) unsupported(reply ? 'reply creation' : 'inline writes');
  if (kind === 'inline' && !reply) {
    if (typeof selection !== 'string' || !selection.trim() || !Number.isSafeInteger(selectionCount) || selectionCount < 1 || !Number.isSafeInteger(selectionIndex) || selectionIndex < 0 || selectionIndex >= selectionCount) throw new Error('Inline comments require a selection, positive selection count, and valid zero-based selection index.');
  } else if ([selection, selectionCount, selectionIndex].some((value) => value !== undefined)) throw new Error('Selection is only valid for inline root creation.');
  let doc = inputDocument(api, input, { id: null, kind, ...(reply ? { parent_comment_id: targetId } : { page_id: targetId, parent_comment_id: null }) });
  const parent = reply ? await getComment(api, targetId, { kind }) : null;
  if (reply) doc = inputDocument(api, input, { id: null, kind, page_id: parent.pageId, parent_comment_id: targetId });
  const storage = storageBody(doc);
  const body = dc(api) ? { type: 'comment', container: { id: String(targetId), type: 'page' }, body: { storage: { representation: 'storage', value: storage } } } : { ...(reply ? { parentCommentId: String(targetId) } : { pageId: String(targetId) }), body: { representation: 'storage', value: storage }, ...(kind === 'inline' && !reply ? { inlineCommentProperties: { textSelection: selection, textSelectionMatchCount: selectionCount, textSelectionMatchIndex: selectionIndex } } : {}) };
  return normalize(api, await api.request(resource(api, null, kind), { method: 'POST', version: dc(api) ? 1 : 2, body }), kind, { pageId: reply ? parent.pageId : String(targetId), parentCommentId: reply ? String(targetId) : null });
}

export async function updateComment(api, id, input, { kind = 'footer', version, resolved } = {}) {
  numeric(id); kindOf(kind); positive(version);
  if (dc(api) && kind === 'inline') unsupported('inline writes');
  if (resolved !== undefined && (kind !== 'inline' || typeof resolved !== 'boolean')) throw new Error('Resolution requires an inline comment and boolean resolved value.');
  if (input === undefined && resolved === undefined) throw new Error('Comment body must not be empty.');
  if (input !== undefined) inputDocument(api, input, { id, kind, version });
  const current = await getComment(api, id, { kind });
  if (current.version !== version) throw new Error('Comment version conflict. Read the latest comment before writing.');
  const doc = input === undefined ? null : inputDocument(api, input, { id, kind, version, page_id: current.pageId, parent_comment_id: current.parentCommentId });
  const storage = doc ? storageBody(doc) : current.storage;
  const body = { version: { number: version + 1 }, body: dc(api) ? { storage: { representation: 'storage', value: storage } } : { representation: 'storage', value: storage }, ...(dc(api) ? { type: 'comment', id: String(id) } : {}), ...(resolved !== undefined ? { resolved } : {}) };
  return normalize(api, await api.request(resource(api, id, kind), { method: 'PUT', version: dc(api) ? 1 : 2, body }), kind, current);
}

export async function deleteComment(api, id, { kind = 'footer', version } = {}) {
  numeric(id); kindOf(kind); positive(version);
  if (dc(api) && kind === 'inline') unsupported('inline writes');
  const current = await getComment(api, id, { kind });
  if (current.version !== version) throw new Error('Comment version conflict. Read the latest comment before deleting.');
  await api.request(resource(api, id, kind), { method: 'DELETE', version: dc(api) ? 1 : 2 });
  return { id: String(id), kind, deleted: true, versionChecked: version, atomicVersionCheck: false };
}

export function formatComment(api, comment) {
  return formatDocument({ metadata: { confluence_comment: { site: api.config.siteUrl, api: api.config.apiUrl, id: comment.id, page_id: comment.pageId, parent_comment_id: comment.parentCommentId, kind: comment.kind, version: comment.version, author_id: comment.authorId, created_at: comment.createdAt, updated_at: comment.updatedAt, resolved: comment.resolved, url: comment.url } }, body: comment.body });
}

export function formatComments(api, comments) { return comments.map((comment) => formatComment(api, comment)).join('\n'); }
