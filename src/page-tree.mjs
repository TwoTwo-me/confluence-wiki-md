import path from 'node:path';

export const TREE_MANIFEST = 'cfwiki-manifest.json';

function boundedFilename(value, maximum = 180) {
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character) > maximum) break;
    result += character;
  }
  return result;
}

export function safePageTitle(title) {
  let result = String(title ?? '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim().replace(/^\.+/, '_').replace(/[. ]+$/, '');
  result = boundedFilename(result).replace(/[. ]+$/, '') || 'Untitled';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = '_' + result;
  return result;
}

export function attachmentFilename(attachment) {
  if (!/^(?:att)?\d+$/.test(String(attachment.id))) throw new Error('Invalid attachment identity returned by Confluence.');
  const title = attachment.title;
  if (!title || path.basename(title) !== title || title.startsWith('.') || title.includes('\\')) throw new Error('Unsafe attachment filename returned by Confluence.');
  let name = safePageTitle(title);
  // Numeric names are reserved for descendant page directories.
  if (/^\d+$/.test(name)) name = 'attachment-' + String(attachment.id).replace(/^att/, '') + '-' + name;
  // A Markdown attachment must not become a second page or a push target.
  if (/\.md$/i.test(name)) name = 'attachment-' + String(attachment.id).replace(/^att/, '') + '-' + name + '.attachment';
  return name;
}

function pageIdentity(page) {
  const id = String(page?.id);
  if (!/^\d+$/.test(id) || typeof page.title !== 'string') throw new Error('Invalid page identity/title returned by Confluence.');
  return { ...page, id, parentId: page.parentId == null ? null : String(page.parentId) };
}

function pageLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER) throw new Error('Page limit must be a positive safe integer below ' + Number.MAX_SAFE_INTEGER + '.');
}

function exceeded(limit) {
  return new Error('Page tree exceeds --limit ' + limit + '. Increase --limit; no files were written.');
}

export async function collectPageTree(api, { id, recursive = false, space, limit = 1000, version } = {}) {
  pageLimit(limit);
  const pages = new Map();
  const get = async (pageId, selectedVersion) => {
    if (!/^\d+$/.test(String(pageId))) throw new Error('Page ID must be numeric.');
    const page = pageIdentity(await api.getPage(String(pageId), selectedVersion));
    if (page.id !== String(pageId)) throw new Error('Confluence returned a different page ID.');
    return page;
  };
  if (id !== undefined) {
    const root = await get(id, version);
    pages.set(root.id, root);
    if (recursive) {
      const queue = [root];
      for (let index = 0; index < queue.length; index++) {
        const parent = queue[index];
        const children = await api.listPages({ parent: parent.id, limit: limit - pages.size + 1 });
        const listed = new Set();
        for (const child of children) {
          const childId = String(child.id);
          if (listed.has(childId)) continue;
          listed.add(childId);
          if (pages.has(childId)) throw new Error('Cycle or duplicate parent detected in the Confluence page tree: ' + childId + '.');
          if (pages.size === limit) throw exceeded(limit);
          const page = await get(childId);
          if (page.parentId !== parent.id) throw new Error('Page parent changed while collecting the tree: ' + childId + '. Retry the download.');
          if (page.spaceId !== root.spaceId) throw new Error('A descendant belongs to another space: ' + childId + '.');
          pages.set(page.id, page);
          queue.push(page);
        }
      }
    }
  } else {
    const listed = await api.listPages({ space, limit: limit + 1 });
    const ids = [...new Set(listed.map((page) => String(page.id)))];
    if (ids.length > limit) throw exceeded(limit);
    for (const pageId of ids) pages.set(pageId, await get(pageId));
  }
  return pages;
}

export function treeFiles(pages, directory, { rootId } = {}) {
  const files = new Map();
  const visiting = new Set();
  const folder = (id) => {
    if (files.has(id)) return path.dirname(files.get(id));
    if (visiting.has(id)) throw new Error('Cycle detected in Confluence parent IDs: ' + id + '.');
    visiting.add(id);
    const page = pages.get(id);
    const parent = id !== String(rootId) && pages.has(page.parentId) ? folder(page.parentId) : directory;
    const result = path.join(parent, id);
    files.set(id, path.join(result, safePageTitle(page.title) + '.md'));
    visiting.delete(id);
    return result;
  };
  for (const id of pages.keys()) folder(id);
  return files;
}

const encodeSegment = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase());

export function localPageLinks(pages, files, sourceId) {
  const links = Object.create(null);
  const titles = new Map();
  for (const page of pages.values()) titles.set(page.title, titles.has(page.title) ? null : page.id);
  for (const [id, filename] of files) {
    let relative = path.relative(path.dirname(files.get(sourceId)), filename).split(path.sep).map(encodeSegment).join('/');
    if (!relative.startsWith('.')) relative = './' + relative;
    links[id] = relative;
    if (titles.get(pages.get(id).title) === id && !pages.has(pages.get(id).title)) links[pages.get(id).title] = relative;
  }
  return links;
}
