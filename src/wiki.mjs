import { readFile, writeFile, mkdir, rename, access, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { parseDocument, formatDocument, markdownToStorage, storageToMarkdown, reducePreservation, references, hash, bodyHash } from './document.mjs';
import { prepareDiagrams, withoutDiagramPreservation } from './diagrams.mjs';
import { applyTemplate, templateDiagrams } from './templates.mjs';
import { prepareNativeTemplate } from './native-templates.mjs';

export async function saveFile(filename, content, { overwrite = false } = {}) {
  await mkdir(path.dirname(path.resolve(filename)), { recursive: true });
  if (!overwrite) { await writeFile(filename, content, { flag: 'wx', mode: 0o600 }); return; }
  const temporary = filename + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  await rename(temporary, filename);
}

function boundMetadata(api, page, metadata, extras = {}) {
  return { ...metadata, type: metadata.type ?? 'Reference', title: page.title, resource: metadata.resource ?? page.url, confluence: { ...metadata.confluence, deployment: api.config.deployment, api_url: api.config.apiUrl, site_url: api.config.siteUrl, id: page.id, version: page.version, status: page.status, space: page.spaceKey ?? metadata.confluence?.space ?? api.config.spaceKey, parent_id: page.parentId, url: page.url, ...extras } };
}

function checkBinding(api, metadata) {
  const meta = metadata.confluence;
  if (meta?.api_url && meta.api_url.replace(/\/+$/, '') !== api.config.apiUrl) throw new Error('Document API URL differs from the active configuration. Select the matching --env profile; front matter never redirects credentials.');
  if (meta?.site_url && meta.site_url.replace(/\/+$/, '') !== api.config.siteUrl) throw new Error('Document belongs to a different Confluence site.');
}

function preservationContext(api, id) {
  return { preserve: api.config.preserve ?? 'minimal', pageUrl: id ? api.pageUrl(id) : api.config.webBase, siteUrl: api.config.webBase, pageId: id, diagramProfile: api.config.diagramProfile };
}

export async function download(api, id, { version, pageLinks, assetsDir, assetPrefix, overwrite = false } = {}) {
  const page = await api.getPage(id, version);
  const property = await api.getProperty(id);
  const stored = !version || property?.value?.pageVersion === page.version ? property?.value : null;
  const labels = version ? [] : (await api.labels(id)).map((item) => item.name);
  const attachmentLinks = {};
  if (assetsDir) {
    for (const attachment of await api.attachments(id)) {
      const title = attachment.title;
      if (!title || path.basename(title) !== title || title.startsWith('.') || title.includes('\\')) throw new Error('Unsafe attachment filename returned by Confluence.');
      const filename = title;
      await saveFile(path.join(assetsDir, filename), await api.downloadAttachment(id, attachment), { overwrite });
      attachmentLinks[title] = (assetPrefix ?? './assets') + '/' + encodeURIComponent(filename);
    }
  }
  const converted = storageToMarkdown(page.storage, { ...preservationContext(api, page.id), pageLinks, attachments: attachmentLinks });
  let body = converted.markdown;
  let preserved = converted.preserved;
  if (!pageLinks && !assetsDir && stored?.pageVersion === page.version && stored?.source?.storageHash === hash(page.storage)) {
    const source = JSON.parse(gunzipSync(Buffer.from(stored.source.gzip, 'base64'), { maxOutputLength: 5 * 1024 * 1024 }).toString('utf8'));
    if (typeof source.body !== 'string' || !Array.isArray(source.preserved)) throw new Error('Invalid stored Markdown source.');
    body = source.body;
    preserved = source.preserved;
  }
  const metadata = boundMetadata(api, page, stored?.metadata ?? { type: 'Reference', tags: labels }, { ...(stored?.templateId ? { template_id: stored.templateId } : {}), labels, preserved, storage_hash: hash(page.storage), base_body_hash: bodyHash(body) });
  const doc = reducePreservation({ metadata, body, warnings: converted.warnings }, preservationContext(api, page.id));
  doc.metadata.confluence.base_body_hash = bodyHash(doc.body);
  return doc;
}

async function safeLocalPath(root, sourceDir, reference) {
  const pathname = decodeURIComponent(reference.split('#')[0].split('?')[0]);
  const target = path.resolve(pathname.startsWith('/') ? root : sourceDir, pathname.replace(/^\//, ''));
  const resolvedRoot = await realpath(root);
  const resolvedTarget = await realpath(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) throw new Error('Local reference escapes the allowed --root directory.');
  return resolvedTarget;
}

const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif' };

export async function upload(api, input, { filename, title, id, version, space, parent, root, dryRun = false, onWrite, diagrams, diagramEnv = {}, preparedDiagrams, template } = {}) {
  let doc = parseDocument(input);
  checkBinding(api, doc.metadata);
  doc = reducePreservation(doc, preservationContext(api, id ?? doc.metadata.confluence?.id));
  const markdownTitle = doc.body.match(/^#\s+(.+)$/m)?.[1];
  doc = await prepareNativeTemplate(api, doc, template, { id, space });
  const meta = doc.metadata.confluence ?? {};
  if (id && meta.id && id !== meta.id) throw new Error('--id conflicts with the page ID in front matter.');
  const pageId = id ?? meta.id;
  const expectedVersion = version ?? meta.version;
  if (pageId && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) throw new Error('Updating a page requires confluence.version or --version. Download it first.');
  const actualTitle = title ?? doc.metadata.title ?? markdownTitle ?? (filename ? path.basename(filename, path.extname(filename)) : null);
  if (!actualTitle?.trim()) throw new Error('A page title is required in front matter or --title.');
  const lineOffset = template?.kind === 'confluence' ? 0 : input.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').slice(0, -doc.body.length).split('\n').length - 1;
  const selected = templateDiagrams(template, diagramEnv, diagrams);
  const prepared = preparedDiagrams ?? await prepareDiagrams(doc.body, { ...selected, lineOffset, requireMacros: true });
  const target = await api.getSpace(space ?? meta.space);
  let current;
  if (pageId) {
    current = await api.getPage(pageId);
    if (current.status !== 'current') throw new Error('Only current published pages can be updated.');
    if (current.version !== expectedVersion) throw new Error('Version conflict: local ' + expectedVersion + ', remote ' + current.version + '. Download and merge before uploading.');
    if (String(target.id) !== current.spaceId) throw new Error('Refusing to update a page in another space.');
    if (meta.storage_hash && meta.storage_hash !== hash(current.storage)) throw new Error('Remote storage differs from the downloaded snapshot. Download and merge first.');
  }
  const userMetadata = Object.fromEntries(Object.entries(doc.metadata).filter(([key]) => key !== 'confluence'));
  if (Buffer.byteLength(JSON.stringify(userMetadata)) > 28000) throw new Error('OKF front matter exceeds the Confluence metadata size limit.');
  const labelList = meta.labels;
  if (labelList !== undefined && (!Array.isArray(labelList) || labelList.some((label) => typeof label !== 'string' || !/^[^\s<>"&]+$/.test(label)))) throw new Error('confluence.labels must contain valid Confluence label names.');
  const links = {};
  const images = {};
  const assets = new Map();
  for (const ref of references(doc.body)) {
    if (ref.kind === 'image' && pageId && /^https?:/i.test(ref.url ?? '')) {
      const url = new URL(ref.url);
      const prefix = new URL(api.config.webBase).pathname.replace(/\/$/, '') + '/download/attachments/' + pageId + '/';
      if (url.origin === new URL(api.config.webBase).origin && url.pathname.startsWith(prefix)) {
        const name = decodeURIComponent(url.pathname.slice(prefix.length));
        if (name && !/[\/\\]/.test(name)) { images[ref.url] = name; continue; }
      }
    }
    if (!ref.url || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(ref.url)) continue;
    if (ref.kind === 'link' && !/\.md(?:#.*)?$/i.test(ref.url)) continue;
    if (!filename) throw new Error('Relative Markdown links and images require a source file.');
    const local = await safeLocalPath(root ?? path.dirname(filename), path.dirname(filename), ref.url);
    if (ref.kind === 'link') {
      const other = parseDocument(await readFile(local, 'utf8'));
      checkBinding(api, other.metadata);
      if (!other.metadata.confluence?.id) throw new Error('Linked Markdown file has not been published: ' + ref.url + '. Use push for a bundle.');
      links[ref.url] = api.pageUrl(other.metadata.confluence.id) + (ref.url.includes('#') ? '#' + ref.url.split('#').slice(1).join('#') : '');
    } else {
      const mime = mimeTypes[path.extname(local).toLowerCase()];
      if (!mime) throw new Error('Embedded local images must use a supported image extension. Use attachments upload for other files.');
      const name = path.basename(local);
      if (assets.has(name) && assets.get(name).path !== local) throw new Error('Two image files share the same attachment name: ' + name);
      assets.set(name, { path: local, bytes: await readFile(local), mime });
      images[ref.url] = name;
    }
  }
  const preserved = withoutDiagramPreservation(meta.preserved, prepared.blocks.length > 0 || selected.mode === 'code');
  const converted = markdownToStorage(doc.body, { preserved, links, images, diagrams: prepared.macros, flattenNestedQuotes: api.config.deployment === 'cloud' });
  converted.storage = applyTemplate(converted.storage, template);
  const serverPreview = prepared.blocks.length || template?.toc || template?.kind === 'confluence' || converted.storage.includes('ac:name="toc"') ? await api.previewStorage(converted.storage, { pageId, space: target.key }) : null;
  if (dryRun) return { dryRun: true, id: pageId ?? null, title: actualTitle, version: pageId ? expectedVersion + 1 : 1, storage: converted.storage, attachments: [...assets.keys()], diagrams: prepared.checks, serverPreview, template: template?.source ?? 'none', warnings: [...(doc.warnings ?? []), ...converted.warnings] };
  const written = await api.writePage({ id: pageId, title: actualTitle, storage: converted.storage, space: target, parentId: parent ?? meta.parent_id ?? current?.parentId, version: expectedVersion });
  let result = { metadata: boundMetadata(api, written, doc.metadata, { space: target.key, ...(preserved.length ? { preserved } : {}) }), body: doc.body, warnings: [...(doc.warnings ?? []), ...converted.warnings] };
  if (!preserved.length) delete result.metadata.confluence.preserved;
  delete result.metadata.confluence.storage_hash;
  if (onWrite) await onWrite(result);
  try {
    for (const [name, asset] of assets) await api.uploadAttachment(written.id, name, asset.bytes, asset.mime);
    const actual = await api.getPage(written.id);
    if (actual.version !== written.version) throw new Error('Page changed again immediately after saving. Download and merge before retrying.');
    result = { ...result, metadata: boundMetadata(api, actual, result.metadata, { storage_hash: hash(actual.storage) }) };
    if (onWrite) await onWrite(result);
    const value = { schema: 1, pageVersion: actual.version, metadata: userMetadata, ...(meta.template_id ? { templateId: meta.template_id } : {}) };
    const source = { storageHash: hash(actual.storage), gzip: gzipSync(JSON.stringify({ body: doc.body, preserved })).toString('base64') };
    if (!Object.keys(images).length && !Object.keys(links).length && Buffer.byteLength(JSON.stringify({ ...value, source })) <= 30000) value.source = source;
    await api.setProperty(actual.id, value);
    if (labelList !== undefined) await api.setLabels(actual.id, [...new Set(labelList)]);
    result = { ...result, metadata: { ...result.metadata, confluence: { ...result.metadata.confluence, base_body_hash: bodyHash(result.body) } } };
    if (onWrite) await onWrite(result);
    return result;
  } catch (error) {
    throw new Error('Page ' + written.id + ' was saved at version ' + written.version + ', but metadata/attachment synchronization failed. The local file identity was updated when a file was provided. ' + error.message, { cause: error });
  }
}

export async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(filename));
    else if (entry.isFile() && /\.md$/i.test(entry.name) && !['index.md', 'log.md'].includes(entry.name)) files.push(filename);
  }
  return files.sort();
}

export async function searchLocal(directory, query) {
  const results = [];
  for (const filename of await markdownFiles(directory)) {
    const doc = parseDocument(await readFile(filename, 'utf8'));
    const content = [doc.metadata.title ?? '', ...(doc.metadata.tags ?? []), doc.body].join('\n');
    const index = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    if (index >= 0) results.push({ id: doc.metadata.confluence?.id ?? path.relative(directory, filename).replace(/\.md$/, ''), title: doc.metadata.title ?? path.basename(filename), url: path.relative(directory, filename), excerpt: content.slice(Math.max(0, index - 60), index + 180).replace(/\s+/g, ' ') });
  }
  return results;
}

export async function exportBundle(api, directory, { space, parent, limit = 1000, overwrite = false } = {}) {
  const pages = await api.listPages({ space, parent, limit });
  const ids = pages.map((page) => String(page.id));
  const links = Object.fromEntries(ids.map((id) => [id, './' + id + '.md']));
  const files = ids.map((id) => path.join(directory, 'pages', id + '.md'));
  if (!overwrite) for (const filename of [...files, path.join(directory, 'index.md')]) {
    try { await access(filename); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Output already exists: ' + filename + '. Use --overwrite explicitly.');
  }
  const index = ['---', 'okf_version: "0.2"', '---', '# Confluence wiki', ''];
  for (let i = 0; i < ids.length; i++) {
    const doc = await download(api, ids[i], { pageLinks: links });
    await saveFile(files[i], formatDocument(doc), { overwrite });
    index.push('- [' + doc.metadata.title.replace(/[\[\]\n]/g, ' ') + '](pages/' + ids[i] + '.md)' + (doc.metadata.description ? ' - ' + String(doc.metadata.description).replace(/\s+/g, ' ') : ''));
  }
  await saveFile(path.join(directory, 'index.md'), index.join('\n') + '\n', { overwrite });
  return { directory, pages: ids.length, index: path.join(directory, 'index.md') };
}

export async function pushBundle(api, directory, options = {}) {
  const selected = templateDiagrams(options.template, options.diagramEnv, options.diagrams);
  const files = await markdownFiles(directory);
  const targets = new Set(await Promise.all(files.map((filename) => realpath(filename))));
  const documents = [];
  const ids = new Set();
  for (const filename of files) {
    let doc = parseDocument(await readFile(filename, 'utf8'));
    checkBinding(api, doc.metadata);
    doc = reducePreservation(doc, preservationContext(api, doc.metadata.confluence?.id));
    doc = await prepareNativeTemplate(api, doc, options.template, { space: options.space });
    if (doc.metadata.confluence?.id) {
      if (ids.has(doc.metadata.confluence.id)) throw new Error('Duplicate page ID in bundle: ' + doc.metadata.confluence.id);
      ids.add(doc.metadata.confluence.id);
      const page = await api.getPage(doc.metadata.confluence.id);
      if (page.status !== 'current') throw new Error('Bundle contains a page that is not current: ' + filename);
      if (page.version !== doc.metadata.confluence.version) throw new Error('Version conflict in ' + filename + '. No bundle pages were changed.');
    }
    for (const ref of references(doc.body)) {
      if (!ref.url || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(ref.url)) continue;
      if (ref.kind === 'link' && !/\.md(?:#.*)?$/i.test(ref.url)) continue;
      const local = await safeLocalPath(directory, path.dirname(filename), ref.url);
      if (ref.kind === 'image' && !mimeTypes[path.extname(local).toLowerCase()]) throw new Error('Unsupported local image in ' + filename);
      if (ref.kind === 'link') {
        const linked = parseDocument(await readFile(local, 'utf8'));
        checkBinding(api, linked.metadata);
        if (!targets.has(local) && !linked.metadata.confluence?.id) throw new Error('Unpublished link target is excluded from the bundle: ' + ref.url);
      }
    }
    const prepared = await prepareDiagrams(doc.body, { ...selected, requireMacros: true });
    if (prepared.blocks.length || options.template?.toc || options.template?.kind === 'confluence' || /```confluence-toc\n/.test(doc.body)) {
      const preserved = withoutDiagramPreservation(doc.metadata.confluence?.preserved, prepared.blocks.length > 0 || selected.mode === 'code');
      const storage = applyTemplate(markdownToStorage(doc.body, { preserved, diagrams: prepared.macros, flattenNestedQuotes: api.config.deployment === 'cloud' }).storage, options.template);
      await api.previewStorage(storage, { pageId: doc.metadata.confluence?.id, space: options.space ?? doc.metadata.confluence?.space ?? api.config.spaceKey });
    }
    documents.push({ filename, doc, prepared });
  }
  for (const item of documents.filter((entry) => !entry.doc.metadata.confluence?.id)) {
    const space = await api.getSpace(options.space ?? item.doc.metadata.confluence?.space);
    const title = item.doc.metadata.title ?? item.doc.body.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(item.filename, '.md');
    const page = await api.writePage({ title, storage: '<p>Markdown bundle publication in progress.</p>', space, parentId: options.parent });
    item.doc.metadata = boundMetadata(api, page, item.doc.metadata, { space: space.key });
    await saveFile(item.filename, formatDocument(item.doc), { overwrite: true });
  }
  const result = [];
  for (const { filename, prepared } of documents) {
    const doc = await upload(api, await readFile(filename, 'utf8'), { ...options, preparedDiagrams: prepared, filename, root: directory, onWrite: (saved) => saveFile(filename, formatDocument(saved), { overwrite: true }) });
    result.push({ file: filename, id: doc.metadata.confluence.id, version: doc.metadata.confluence.version });
  }
  return result;
}
