import { readFile, writeFile, mkdir, rename, access, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { parseDocument, formatDocument, markdownToStorage, storageToMarkdown, reducePreservation, references, hash, bodyHash } from './document.mjs';
import { prepareDiagrams, withoutDiagramPreservation } from './diagrams.mjs';
import { applyTemplate, templateDiagrams } from './templates.mjs';
import { prepareNativeTemplate } from './native-templates.mjs';
import { restrictionPolicy, currentUser, getRestrictions, setRestrictions, expectedRestrictions, verifyRestrictions } from './restrictions.mjs';

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

async function createProtectedPage(api, fields, policy, onProgress, recovery) {
  if (!recovery && policy.mode === 'none') {
    const page = await api.writePage(fields);
    await onProgress(page);
    return page;
  }
  let page = recovery?.page;
  let pending = recovery?.pending;
  try {
    const actor = await currentUser(api);
    const privatePolicy = restrictionPolicy({ mode: 'view-edit' });
    if (recovery) {
      if (api.config.deployment !== 'datacenter' || !pending || !/^[a-f0-9-]{36}$/.test(pending.nonce ?? '') || pending.id !== page.id || page.title !== 'cfwiki-pending-' + pending.nonce || page.version !== 1 || page.storage !== '<p>Preparing restricted page.</p>') throw new Error('Invalid pending page recovery marker. Inspect the saved page; no content was published by this attempt.');
    } else if (api.config.deployment === 'cloud') {
      page = await api.writePage({ ...fields, privateCreate: true });
      await onProgress(page);
    } else {
      const nonce = randomUUID();
      page = await api.writePage({ ...fields, title: 'cfwiki-pending-' + nonce, storage: '<p>Preparing restricted page.</p>' });
      pending = { nonce, id: page.id };
      await onProgress(page, pending);
    }
    if (api.config.deployment === 'cloud') {
      verifyRestrictions(await getRestrictions(api, page.id), expectedRestrictions(privatePolicy, actor));
    } else {
      await setRestrictions(api, page.id, privatePolicy);
      page = await api.writePage({ ...fields, id: page.id, version: page.version });
      await onProgress(page);
    }
    if (JSON.stringify(policy) !== JSON.stringify(privatePolicy)) await setRestrictions(api, page.id, policy);
    return page;
  } catch (error) {
    const partial = page ? 'Page ' + page.id + ' exists at version ' + page.version + '. Its returned identity was offered to local writeback; inspect that file before retrying. Use restrictions get ' + page.id + ' to inspect access. ' : 'No page identity was returned. Do not blindly repeat an uncertain create. ';
    throw new Error('Restricted page publication failed. ' + partial + 'Cloud Free cannot create restricted pages; check the plan, scopes, and permissions. ' + error.message, { cause: error });
  }
}

// Legacy upload synchronizes all secondary resources by default. A caller that
// owns only the page may explicitly preserve each resource with secondarySync.
// An unknown create result is never retried: without a confirmed ID, inspect
// Confluence before invoking upload again rather than risking a duplicate POST.
export async function upload(api, input, { filename, title, id, version, space, parent, root, dryRun = false, onWrite, diagrams, diagramEnv = {}, preparedDiagrams, template, restrictions, defaultRestrictions = 'view-edit', secondarySync = {} } = {}) {
  let doc = parseDocument(input);
  checkBinding(api, doc.metadata);
  doc = reducePreservation(doc, preservationContext(api, id ?? doc.metadata.confluence?.id));
  const markdownTitle = doc.body.match(/^#\s+(.+)$/m)?.[1];
  doc = await prepareNativeTemplate(api, doc, template, { id, space });
  const meta = doc.metadata.confluence ?? {};
  if (id && meta.id && id !== meta.id) throw new Error('--id conflicts with the page ID in front matter.');
  const pageId = id ?? meta.id;
  const policy = restrictionPolicy(restrictions ?? { mode: defaultRestrictions });
  if (pageId && !meta.pending_create && restrictions !== undefined) throw new Error('Use restrictions set to change existing page restrictions. Upload restriction flags apply only to new pages.');
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
  if (secondarySync.attachments === false && assets.size) throw new Error('This edit cannot publish local attachment bytes.');
  const preserved = withoutDiagramPreservation(meta.preserved, prepared.blocks.length > 0 || selected.mode === 'code');
  const converted = markdownToStorage(doc.body, { preserved, links, images, diagrams: prepared.macros, flattenNestedQuotes: api.config.deployment === 'cloud' });
  converted.storage = applyTemplate(converted.storage, template);
  const serverPreview = prepared.blocks.length || template?.toc || template?.kind === 'confluence' || converted.storage.includes('ac:name="toc"') ? await api.previewStorage(converted.storage, { pageId, space: target.key }) : null;
  if (dryRun) return { dryRun: true, id: pageId ?? null, title: actualTitle, version: pageId ? expectedVersion + 1 : api.config.deployment === 'datacenter' && policy.mode !== 'none' ? 2 : 1, storage: converted.storage, restrictions: pageId && !meta.pending_create ? { action: 'preserve-existing' } : { action: 'create', ...policy }, attachments: [...assets.keys()], diagrams: prepared.checks, serverPreview, template: template?.source ?? 'none', warnings: [...(doc.warnings ?? []), ...converted.warnings] };
  const resources = {
    page: { status: 'unresolved', attemptedVersion: pageId ? expectedVersion + 1 : api.config.deployment === 'datacenter' && policy.mode !== 'none' ? 2 : 1 },
    property: { status: secondarySync.property === false ? 'preserved' : 'not_attempted' },
    labels: { status: secondarySync.labels === false ? 'preserved' : labelList === undefined ? 'not_requested' : 'not_attempted' },
    attachments: { status: secondarySync.attachments === false ? 'preserved' : assets.size ? 'not_attempted' : 'not_requested' },
  };
  const fields = { id: pageId, title: actualTitle, storage: converted.storage, space: target, parentId: parent ?? meta.parent_id ?? current?.parentId, version: expectedVersion, ...(api.config.versionMessage ? { message: api.config.versionMessage } : {}) };
  let knownId = pageId ?? null;
  const progress = async (page, pending) => {
    knownId = page.id;
    const metadata = boundMetadata(api, page, doc.metadata, { space: target.key });
    metadata.title = actualTitle;
    delete metadata.confluence.storage_hash;
    if (pending) metadata.confluence.pending_create = pending;
    else delete metadata.confluence.pending_create;
    if (onWrite) await onWrite({ metadata, body: doc.body, warnings: doc.warnings ?? [] });
  };
  let written;
  try {
    written = !pageId || meta.pending_create ? await createProtectedPage(api, fields, policy, progress, meta.pending_create ? { page: current, pending: meta.pending_create } : undefined) : await api.writePage(fields);
  } catch (error) {
    throw Object.assign(new Error('Page publication is unresolved. No automatic create retry is safe. ' + error.message, { cause: error }), {
      status: 'partial', outcome: 'unresolved', id: knownId ?? error.writtenPage?.id ?? error.cause?.writtenPage?.id ?? null, resources,
    });
  }
  resources.page = { status: 'saved', version: written.version };
  let result = { metadata: boundMetadata(api, written, doc.metadata, { space: target.key, ...(preserved.length ? { preserved } : {}) }), body: doc.body, warnings: [...(doc.warnings ?? []), ...converted.warnings], resources };
  if (!preserved.length) delete result.metadata.confluence.preserved;
  delete result.metadata.confluence.pending_create;
  delete result.metadata.confluence.storage_hash;
  let syncing;
  try {
    if (onWrite) await onWrite(result);
    if (assets.size) {
      syncing = 'attachments';
      for (const [name, asset] of assets) await api.uploadAttachment(written.id, name, asset.bytes, asset.mime);
      resources.attachments = { status: 'saved' };
    }
    syncing = 'page';
    const actual = await api.getPage(written.id);
    if (actual.version !== written.version) throw new Error('Page changed again immediately after saving. Download and merge before retrying.');
    syncing = undefined;
    result = { ...result, metadata: boundMetadata(api, actual, result.metadata) };
    if (onWrite) await onWrite(result);
    if (secondarySync.property !== false) {
      syncing = 'property';
      const value = { schema: 1, pageVersion: actual.version, metadata: userMetadata, ...(meta.template_id ? { templateId: meta.template_id } : {}) };
      const source = { storageHash: hash(actual.storage), gzip: gzipSync(JSON.stringify({ body: doc.body, preserved })).toString('base64') };
      if (!Object.keys(images).length && !Object.keys(links).length && Buffer.byteLength(JSON.stringify({ ...value, source })) <= 30000) value.source = source;
      await api.setProperty(actual.id, value);
      resources.property = { status: 'saved' };
    }
    if (secondarySync.labels !== false && labelList !== undefined) {
      syncing = 'labels';
      await api.setLabels(actual.id, [...new Set(labelList)]);
      resources.labels = { status: 'saved' };
    }
    syncing = undefined;
    result = { ...result, metadata: { ...result.metadata, confluence: { ...result.metadata.confluence, storage_hash: hash(actual.storage), base_body_hash: bodyHash(result.body) } } };
    if (onWrite) await onWrite(result);
    return result;
  } catch (error) {
    if (syncing) resources[syncing] = { status: syncing === 'page' ? 'unresolved' : 'failed', outcome: 'unresolved' };
    throw Object.assign(new Error('Page ' + written.id + ' was saved at version ' + written.version + ', but metadata/attachment synchronization failed. The local file identity was updated when a file was provided. ' + error.message, { cause: error }), {
      status: 'partial', outcome: 'unresolved', id: written.id, version: written.version, resources,
    });
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
  const policy = restrictionPolicy(options.restrictions ?? { mode: options.defaultRestrictions ?? 'view-edit' });
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
    const page = await createProtectedPage(api, { title, storage: '<p>Markdown bundle publication in progress.</p>', space, parentId: options.parent ?? item.doc.metadata.confluence?.parent_id }, policy, async (created, pending) => {
      const metadata = boundMetadata(api, created, item.doc.metadata, { space: space.key });
      metadata.title = title;
      if (pending) metadata.confluence.pending_create = pending;
      else delete metadata.confluence.pending_create;
      await saveFile(item.filename, formatDocument({ ...item.doc, metadata }), { overwrite: true });
    });
    item.doc.metadata = boundMetadata(api, page, item.doc.metadata, { space: space.key });
    await saveFile(item.filename, formatDocument(item.doc), { overwrite: true });
  }
  const result = [];
  for (const { filename, prepared } of documents) {
    const doc = await upload(api, await readFile(filename, 'utf8'), { ...options, restrictions: undefined, preparedDiagrams: prepared, filename, root: directory, onWrite: (saved) => saveFile(filename, formatDocument(saved), { overwrite: true }) });
    result.push({ file: filename, id: doc.metadata.confluence.id, version: doc.metadata.confluence.version });
  }
  return result;
}
