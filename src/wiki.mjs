import { readFile, writeFile, mkdir, rename, readdir, realpath, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { parseDocument, formatDocument, markdownToStorage, storageToMarkdown, reducePreservation, references, hash, bodyHash } from './document.mjs';
import { prepareDiagrams, withoutDiagramPreservation } from './diagrams.mjs';
import { applyTemplate, templateDiagrams } from './templates.mjs';
import { prepareNativeTemplate } from './native-templates.mjs';
import { restrictionPolicy, currentUser, getRestrictions, setRestrictions, expectedRestrictions, verifyRestrictions } from './restrictions.mjs';
import { TREE_MANIFEST, attachmentFilename, collectPageTree, treeFiles, localPageLinks } from './page-tree.mjs';

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

export async function download(api, id, { version, pageLinks, assetsDir, assetPrefix, overwrite = false, page: suppliedPage, attachmentFiles, attachmentNames = {}, saveAttachment = saveFile } = {}) {
  const page = suppliedPage ?? await api.getPage(id, version);
  const property = await api.getProperty(id);
  const stored = !version || property?.value?.pageVersion === page.version ? property?.value : null;
  const labels = version ? [] : (await api.labels(id)).map((item) => item.name);
  const attachmentLinks = Object.create(null);
  const attachmentReferences = Object.create(null);
  if (assetsDir) {
    for (const attachment of attachmentFiles ?? await api.attachments(id)) {
      const title = attachment.title;
      if (!title || path.basename(title) !== title || title.startsWith('.') || title.includes('\\')) throw new Error('Unsafe attachment filename returned by Confluence.');
      const filename = Object.hasOwn(attachmentNames, title) ? attachmentNames[title] : title;
      await saveAttachment(path.join(assetsDir, filename), await api.downloadAttachment(id, attachment), { overwrite });
      attachmentLinks[title] = (assetPrefix ?? './assets') + '/' + encodeURIComponent(filename);
      if (filename !== title || !mimeTypes[path.extname(filename).toLowerCase()]) attachmentReferences[attachmentLinks[title]] = title;
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
  const metadata = boundMetadata(api, page, stored?.metadata ?? { type: 'Reference', tags: labels }, { ...(stored?.templateId ? { template_id: stored.templateId } : {}), ...(Object.keys(attachmentReferences).length ? { attachment_files: attachmentReferences } : {}), labels, preserved, storage_hash: hash(page.storage), base_body_hash: bodyHash(body) });
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
  if (meta.attachment_files !== undefined && (!meta.attachment_files || typeof meta.attachment_files !== 'object' || Array.isArray(meta.attachment_files))) throw new Error('confluence.attachment_files must map local references to native attachment filenames.');
  for (const ref of references(doc.body)) {
    const mappedKey = ref.url?.split('#')[0];
    const mappedAttachment = meta.attachment_files && Object.hasOwn(meta.attachment_files, mappedKey) ? meta.attachment_files[mappedKey] : undefined;
    if (mappedAttachment !== undefined && (typeof mappedAttachment !== 'string' || !mappedAttachment || path.basename(mappedAttachment) !== mappedAttachment || mappedAttachment.startsWith('.') || mappedAttachment.includes('\\'))) throw new Error('Invalid native attachment filename in confluence.attachment_files.');
    if (ref.kind === 'link' && mappedAttachment !== undefined && pageId) {
      links[ref.url] = api.config.webBase + '/download/attachments/' + pageId + '/' + encodeURIComponent(mappedAttachment) + (ref.url.includes('#') ? '#' + ref.url.split('#').slice(1).join('#') : '');
      continue;
    }
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
      const name = mappedAttachment ?? path.basename(local);
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
    if (filename && onWrite) {
      try { await refreshTreeManifest(api, filename, result, root); }
      catch { result.warnings.push('The page and local Markdown were saved, but its tree manifest could not be refreshed. Keep the file and export to another directory before a title or parent move.'); }
    }
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
    else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      // Older exports generated a navigation-only index. A real page may be
      // named index.md or log.md, so identify legacy navigation by metadata.
      if (/^(?:index|log)\.md$/i.test(entry.name)) {
        const doc = parseDocument(await readFile(filename, 'utf8'));
        if (doc.metadata.okf_version && !doc.metadata.title && doc.metadata.type === 'Reference' && !doc.metadata.confluence?.id) continue;
      }
      files.push(filename);
    }
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

async function fileInfo(filename) {
  try { return await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function refreshTreeManifest(api, filename, doc, root) {
  const absolute = path.resolve(filename);
  let directory = root ? path.resolve(root) : path.dirname(absolute);
  while (true) {
    const manifestFile = path.join(directory, TREE_MANIFEST);
    const info = await fileInfo(manifestFile);
    if (info) {
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe tree manifest.');
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
      if (manifest.schema !== 1 || manifest.format !== 'id-title-tree' || manifest.api_url !== api.config.apiUrl || manifest.site_url !== api.config.siteUrl || !Array.isArray(manifest.pages)) return;
      const entry = manifest.pages.find((page) => String(page.id) === doc.metadata.confluence.id && manifestPath(directory, page.file) === absolute);
      if (!entry) return;
      const content = await readFile(absolute, 'utf8');
      const saved = parseDocument(content);
      if (saved.metadata.confluence?.id !== doc.metadata.confluence.id || saved.metadata.confluence?.version !== doc.metadata.confluence.version || saved.metadata.confluence?.storage_hash !== doc.metadata.confluence.storage_hash || bodyHash(saved.body) !== doc.metadata.confluence.base_body_hash) return;
      Object.assign(entry, { title: doc.metadata.title, version: doc.metadata.confluence.version, parent_id: doc.metadata.confluence.parent_id, sha256: hash(content) });
      await saveFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { overwrite: true });
      return;
    }
    if (root || !/^\d+$/.test(path.basename(directory))) return;
    directory = path.dirname(directory);
  }
}

async function checkTreeDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Page output escapes the selected directory.');
  let current = root;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const info = await fileInfo(current);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Page output directory must be a real directory: ' + current);
  }
}

function manifestPath(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')) throw new Error('Invalid file path in the cfwiki manifest.');
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep) || !/\.md$/i.test(resolved)) throw new Error('Invalid file path in the cfwiki manifest.');
  return resolved;
}

async function writePageTree(api, directory, pages, { rootId, version, overwrite = false, assets = false, bodyOnly = false } = {}) {
  const root = path.resolve(directory);
  const files = treeFiles(pages, root, { rootId });
  const manifestFile = path.join(root, TREE_MANIFEST);
  await checkTreeDirectory(root, root);
  const previousInfo = await fileInfo(manifestFile);
  if (previousInfo?.isSymbolicLink() || previousInfo && !previousInfo.isFile()) throw new Error('The cfwiki manifest must be a regular file.');
  const previous = previousInfo ? JSON.parse(await readFile(manifestFile, 'utf8')) : null;
  if (previous && (previous.schema !== 1 || previous.format !== 'id-title-tree' || !Array.isArray(previous.pages) || previous.api_url !== api.config.apiUrl || previous.site_url !== api.config.siteUrl)) throw new Error('The output manifest belongs to another Confluence profile or format. Choose another output directory.');
  const manifestIds = new Set();
  for (const entry of previous?.pages ?? []) {
    if (!entry || !/^\d+$/.test(String(entry.id)) || manifestIds.has(String(entry.id)) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid page entry in the cfwiki manifest.');
    manifestIds.add(String(entry.id));
    manifestPath(root, entry.file);
  }
  const entries = new Map((previous?.pages ?? []).map((entry) => [String(entry.id), entry]));
  const stale = new Map();
  const aliases = new Map();
  const attachmentLists = new Map();
  const attachmentNames = new Map();
  for (const [id, filename] of files) {
    const folder = path.dirname(filename);
    await checkTreeDirectory(root, folder);
    const old = entries.get(id);
    const oldFile = old ? manifestPath(root, old.file) : null;
    const oldInfo = oldFile && oldFile !== filename ? await fileInfo(oldFile) : null;
    if (oldInfo) {
      await checkTreeDirectory(root, path.dirname(oldFile));
      if (!overwrite || oldInfo.isSymbolicLink() || hash(await readFile(oldFile)) !== old.sha256) throw new Error('Page ' + id + ' moved or changed title, but its old Markdown has local edits or requires --overwrite: ' + oldFile + '. Keep or move that file before retrying.');
      const targetInfo = await fileInfo(filename);
      // On case-insensitive filesystems, A.md and a.md can name the same file.
      // Never unlink the old spelling after replacing its contents.
      if (targetInfo && oldInfo.nlink === 1 && targetInfo.dev === oldInfo.dev && targetInfo.ino === oldInfo.ino) aliases.set(oldFile, filename);
      else stale.set(oldFile, old.sha256);
    }
    for (const entry of await readdir(folder, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (!/\.md$/i.test(entry.name)) continue;
      const found = path.join(folder, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('Markdown output must be a regular file: ' + found);
      if (found !== filename && !stale.has(found) && !aliases.has(found)) throw new Error('Page folder already contains another Markdown file: ' + found + '. Keep or move it before retrying.');
      if (!overwrite) throw new Error('Output already exists: ' + found + '. Use --overwrite explicitly.');
    }
    if (assets) {
      const attachments = await api.attachments(id);
      const names = Object.create(null);
      const used = new Set();
      for (const attachment of attachments) {
        const name = attachmentFilename(attachment);
        if (Object.hasOwn(names, attachment.title) || used.has(name.toLocaleLowerCase())) throw new Error('Duplicate attachment filename returned by Confluence.');
        used.add(name.toLocaleLowerCase());
        names[attachment.title] = name;
        const info = await fileInfo(path.join(folder, name));
        if (info && (!overwrite || info.isSymbolicLink() || !info.isFile())) throw new Error('Attachment output already exists or is unsafe: ' + path.join(folder, name) + '. Use --overwrite for existing files.');
      }
      attachmentLists.set(id, attachments);
      attachmentNames.set(id, names);
    }
  }
  // Finish remote reads and conversion before creating local page files.
  const writes = [];
  const warnings = [];
  for (const [id, page] of pages) {
    const filename = files.get(id);
    const doc = await download(api, id, { page, version, pageLinks: localPageLinks(pages, files, id), overwrite, ...(assets ? { assetsDir: path.dirname(filename), assetPrefix: '.', attachmentFiles: attachmentLists.get(id), attachmentNames: attachmentNames.get(id), saveAttachment: async (file, bytes) => { writes.push({ filename: file, content: bytes }); } } : {}) });
    const content = bodyOnly ? doc.body : formatDocument(doc, { compact: true });
    writes.push({ filename, content });
    warnings.push(...doc.warnings.map((warning) => page.id + ': ' + warning));
    entries.set(id, { id, title: page.title, parent_id: page.parentId, version: page.version, file: path.relative(root, filename).split(path.sep).join('/'), sha256: hash(content) });
  }
  for (const write of writes) await saveFile(write.filename, write.content, { overwrite });
  for (const filename of aliases.values()) {
    const temporary = filename + '.' + randomUUID() + '.case.tmp';
    await rename(filename, temporary);
    try { await rename(temporary, filename); }
    catch (error) { await rename(temporary, filename).catch(() => {}); throw error; }
  }
  for (const [filename, expected] of stale) {
    if (hash(await readFile(filename)) !== expected) throw new Error('Old Markdown changed during download and was kept: ' + filename);
    await unlink(filename);
  }
  const manifest = { schema: 1, format: 'id-title-tree', api_url: api.config.apiUrl, site_url: api.config.siteUrl, pages: [...entries.values()].sort((a, b) => a.file.localeCompare(b.file)) };
  await saveFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { overwrite: Boolean(previous) });
  return { directory: root, pages: pages.size, files: [...files.values()], manifest: manifestFile, warnings };
}

export async function downloadTree(api, id, directory = '.', { recursive = false, limit = 1000, version, ...options } = {}) {
  if (recursive && version) throw new Error('Historical --version cannot be combined with --recursive.');
  const pages = await collectPageTree(api, { id, recursive, limit, version });
  return writePageTree(api, directory, pages, { ...options, rootId: id, version });
}

export async function exportBundle(api, directory, { space, parent, limit = 1000, ...options } = {}) {
  const pages = await collectPageTree(api, parent ? { id: parent, recursive: true, limit } : { space, limit });
  return writePageTree(api, directory, pages, { ...options, rootId: parent });
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
      await saveFile(item.filename, formatDocument({ ...item.doc, metadata }, { compact: true }), { overwrite: true });
    });
    item.doc.metadata = boundMetadata(api, page, item.doc.metadata, { space: space.key });
    await saveFile(item.filename, formatDocument(item.doc, { compact: true }), { overwrite: true });
  }
  const result = [];
  for (const { filename, prepared } of documents) {
    const doc = await upload(api, await readFile(filename, 'utf8'), { ...options, restrictions: undefined, preparedDiagrams: prepared, filename, root: directory, onWrite: (saved) => saveFile(filename, formatDocument(saved, { compact: true }), { overwrite: true }) });
    result.push({ file: filename, id: doc.metadata.confluence.id, version: doc.metadata.confluence.version });
  }
  return result;
}
