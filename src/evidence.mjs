import { hash, storageToMarkdown, loadStorageXml } from './document.mjs';
export { validateStorageXml } from './document.mjs';

export function hasSamePreservedXml(original, transformed) {
  return original.length === transformed.length &&
    original.every((fragment, index) => fragment.storage === transformed[index]?.storage);
}

function textifyCdata(storage, { preserved = [], richTextOnly = false } = {}) {
  const $ = loadStorageXml(storage);
  const preservedXml = new Set(preserved.map((fragment) => fragment.storage));
  let changed = false;
  const visit = (node, inRichText = false, inPlainText = false) => {
    if (node.type === 'tag') {
      if (!richTextOnly && preservedXml.has(storage.slice(node.startIndex, node.endIndex + 1))) return;
      inRichText ||= node.name === 'ac:rich-text-body';
      inPlainText ||= node.name === 'ac:plain-text-body';
    }
    if (node.type === 'cdata' && (!richTextOnly || inRichText) && !inPlainText) {
      node.type = 'text';
      node.data = (node.children ?? []).map((child) => child.data ?? '').join('');
      delete node.children;
      changed = true;
      return;
    }
    for (const child of node.children ?? []) visit(child, inRichText, inPlainText);
  };
  for (const node of $.root()[0].children) visit(node);
  return changed ? $.xml() : storage;
}

function projectRichTextCdata(fragment, options) {
  const storage = textifyCdata(fragment.storage, { richTextOnly: true });
  if (storage === fragment.storage) return fragment;
  const original = storageToMarkdown(fragment.storage, options);
  if (original.preserved.length !== 1 || original.preserved[0].storage !== fragment.storage ||
      original.preserved[0].markdown !== fragment.markdown) {
    throw new Error('Confluence CDATA evidence could not establish a preserved fragment identity.');
  }
  const projected = storageToMarkdown(storage, options);
  if (projected.preserved.length !== 1) {
    throw new Error('Confluence CDATA evidence changed a rich-text fragment boundary.');
  }
  // Only this fragment's Markdown projection is used. Keep its original XML bytes.
  return { ...fragment, markdown: projected.preserved[0].markdown };
}

function replaceProjectedFragments(markdown, original, projected) {
  const groups = new Map();
  for (let index = 0; index < original.length; index++) {
    if (original[index].markdown === projected[index].markdown) continue;
    const group = groups.get(original[index].markdown) ?? [];
    group.push(projected[index].markdown);
    groups.set(original[index].markdown, group);
  }
  for (const [before, after] of groups) {
    const positions = [];
    for (let index = 0; (index = markdown.indexOf(before, index)) !== -1; index += before.length) positions.push(index);
    if (positions.length !== after.length) {
      throw new Error('Confluence CDATA evidence could not map a rich-text passage to its preserved fragment.');
    }
    for (let index = positions.length - 1; index >= 0; index--) {
      const at = positions[index];
      markdown = markdown.slice(0, at) + after[index] + markdown.slice(at + before.length);
    }
  }
  return markdown;
}

function tenantConfiguration(api) {
  const { deployment, apiUrl, siteUrl, webBase } = api?.config ?? {};
  if (!['cloud', 'datacenter'].includes(deployment)) throw new Error('Invalid Confluence tenant configuration.');
  try {
    for (const value of [apiUrl, siteUrl, webBase]) {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
          url.href.replace(/\/+$/, '') !== value) throw new Error();
    }
    const expectedBase = deployment === 'cloud' ? siteUrl + '/wiki' : siteUrl;
    if (webBase !== expectedBase) throw new Error();
    if (deployment === 'datacenter' && apiUrl !== siteUrl + '/rest/api') throw new Error();
    if (deployment === 'cloud' && apiUrl !== siteUrl + '/wiki/api/v2' &&
        !/^https:\/\/api\.atlassian\.com\/ex\/confluence\/[a-f0-9-]{36}\/wiki\/api\/v2$/i.test(apiUrl)) throw new Error();
  } catch {
    throw new Error('Invalid Confluence tenant configuration.');
  }
  return { deployment, apiUrl, siteUrl };
}

function positiveVersion(value, message = 'Confluence returned an invalid positive page version.') {
  if (!Number.isInteger(value) || value < 1) throw new Error(message);
  return value;
}

function passagesFromMarkdown(markdown) {
  const passages = [];
  let qualifier = null;
  for (const block of markdown.trim().split(/\n{2,}/)) {
    if (!block) continue;
    const heading = block.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      qualifier = heading[1].trim();
      continue;
    }
    passages.push({ text: block, qualifier });
  }
  return passages;
}

export async function readStorageSnapshot(api, id, { space, version, now = () => new Date() } = {}) {
  const tenant = tenantConfiguration(api);
  const pageId = String(id);
  if (!/^\d+$/.test(pageId)) throw new Error('Page ID must be numeric.');
  if (typeof space !== 'string' || !space.trim()) throw new Error('A trusted space key is required.');
  if (version !== undefined) positiveVersion(version, 'Historical page version must be a positive integer.');

  const targetSpace = await api.getSpace(space);
  const targetSpaceId = String(targetSpace?.id ?? '');
  if (!targetSpaceId || targetSpace?.key !== space) throw new Error('Confluence did not resolve the trusted space exactly.');

  const page = await api.getPage(pageId, version);
  const raw = page?.raw;
  if (!raw || typeof raw !== 'object') throw new Error('Confluence did not return a raw page response.');

  const actualId = String(raw.id ?? '');
  if (actualId !== pageId || String(page.id) !== pageId) throw new Error('Confluence did not return the requested page ID.');

  const actualSpaceId = String(raw.spaceId ?? raw.space?.id ?? '');
  const actualSpaceKey = raw.space?.key ?? page.spaceKey;
  if (actualSpaceId !== targetSpaceId || String(page.spaceId) !== targetSpaceId || (actualSpaceKey && actualSpaceKey !== space)) {
    throw new Error('Confluence returned a page outside the trusted space.');
  }

  const rawVersion = typeof raw.version === 'object' ? raw.version?.number : raw.version;
  const actualVersion = positiveVersion(rawVersion);
  if (page.version !== actualVersion || (version !== undefined && actualVersion !== version)) {
    throw new Error('Confluence returned a different page version.');
  }

  const status = raw.status ?? page.status;
  const allowedStatuses = version === undefined ? ['current'] : ['current', 'historical'];
  if (!allowedStatuses.includes(status)) throw new Error('Confluence returned an inappropriate page status.');

  if (!raw.body?.storage || !Object.hasOwn(raw.body.storage, 'value') || typeof raw.body.storage.value !== 'string') {
    throw new Error('Confluence storage body is missing.');
  }
  const storage = raw.body.storage.value;

  const url = api.pageUrl(pageId);
  const expectedUrl = api.config.webBase + '/pages/viewpage.action?pageId=' + encodeURIComponent(pageId);
  if (url !== expectedUrl) {
    throw new Error('Confluence returned an invalid canonical page URL for the configured tenant.');
  }
  const conversionOptions = {
    pageUrl: url,
    siteUrl: api.config.webBase,
    pageId,
    diagramProfile: api.config.diagramProfile,
    preserve: 'all',
  };
  const original = storageToMarkdown(storage, conversionOptions);
  const textualStorage = textifyCdata(storage, { preserved: original.preserved });
  let converted = original;
  if (textualStorage !== storage || storage.includes('<![CDATA[')) {
    const textual = textualStorage === storage ? original : storageToMarkdown(textualStorage, conversionOptions);
    if (!hasSamePreservedXml(original.preserved, textual.preserved)) {
      throw new Error('Confluence CDATA conversion changed trusted native fragment bytes or order.');
    }
    const projected = original.preserved.map((fragment) => projectRichTextCdata(fragment, conversionOptions));
    converted = {
      ...textual,
      markdown: replaceProjectedFragments(textual.markdown, original.preserved, projected),
      preserved: projected,
    };
  }
  const readAt = now();
  if (!(readAt instanceof Date) || Number.isNaN(readAt.valueOf())) throw new Error('Evidence read time is invalid.');
  const parentId = raw.parentId ?? raw.ancestors?.at(-1)?.id;

  return {
    sourceType: 'confluence-storage',
    tenant,
    space: { id: targetSpaceId, key: space },
    id: pageId,
    title: raw.title ?? page.title,
    version: actualVersion,
    status,
    parentId: parentId == null ? null : String(parentId),
    url,
    readAt: readAt.toISOString(),
    updated: raw.version?.createdAt ?? raw.version?.when ?? null,
    storageHash: hash(storage),
    storage,
    markdown: converted.markdown,
    preserved: converted.preserved,
    warnings: converted.warnings,
  };
}

export async function readEvidence(api, id, options) {
  const snapshot = await readStorageSnapshot(api, id, options);
  return {
    sourceType: snapshot.sourceType,
    tenant: snapshot.tenant,
    space: snapshot.space,
    id: snapshot.id,
    title: snapshot.title,
    version: snapshot.version,
    status: snapshot.status,
    url: snapshot.url,
    readAt: snapshot.readAt,
    updated: snapshot.updated,
    storageHash: snapshot.storageHash,
    passages: passagesFromMarkdown(snapshot.markdown),
    warnings: snapshot.warnings,
  };
}
