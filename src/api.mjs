import { diagramProfile } from './diagrams.mjs';
import { preservationMode } from './document.mjs';
import { setTimeout } from 'node:timers/promises';
import { load } from 'cheerio';

export class ApiError extends Error {
  constructor(status, method, path) {
    const hints = { 401: 'Check authentication and token expiry.', 403: 'Check token scopes and page/space permissions.', 404: 'Page or space not found or not accessible.', 409: 'Version conflict. Download the latest page and merge your changes.', 429: 'Rate limited. Retry later; no automatic write retry was attempted.' };
    super(method + ' ' + path.split('?')[0] + ': HTTP ' + status + '. ' + (hints[status] ?? 'Request was rejected.'));
    this.name = 'ApiError';
    this.status = status;
  }
}

const stripSlash = (value) => value.replace(/\/+$/, '');
export function readWikiConfig(env) {
  if (!env.CONFLUENCE_SITE_URL) throw new Error('Missing CONFLUENCE_SITE_URL.');
  const deployment = env.CONFLUENCE_DEPLOYMENT || 'cloud';
  if (!['cloud', 'datacenter'].includes(deployment)) throw new Error('CONFLUENCE_DEPLOYMENT must be cloud or datacenter.');
  const token = env.CONFLUENCE_API_TOKEN || env.CONFLUENCE_PAT;
  if (!token) throw new Error('Missing CONFLUENCE_API_TOKEN or CONFLUENCE_PAT.');
  const auth = env.CONFLUENCE_AUTH || (deployment === 'datacenter' ? 'bearer' : 'basic');
  if (!['basic', 'bearer'].includes(auth)) throw new Error('CONFLUENCE_AUTH must be basic or bearer.');
  const email = env.CONFLUENCE_EMAIL || env.CONFLUENCE_USERNAME;
  if (auth === 'basic' && !email) throw new Error('Basic authentication requires CONFLUENCE_EMAIL or CONFLUENCE_USERNAME.');
  const validate = (value) => {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) throw new Error('Configured URLs cannot contain credentials, queries, or fragments.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && env.CONFLUENCE_ALLOW_HTTP === 'true')) throw new Error('Use HTTPS. Explicit CONFLUENCE_ALLOW_HTTP=true is required for a trusted HTTP test/intranet server.');
    return stripSlash(url.href);
  };
  const siteUrl = validate(env.CONFLUENCE_SITE_URL);
  let apiUrl = env.CONFLUENCE_API_URL;
  if (!apiUrl) {
    if (deployment === 'datacenter') apiUrl = siteUrl + '/rest/api';
    else if (env.CONFLUENCE_CLOUD_ID) {
      if (!/^[a-f0-9-]{36}$/i.test(env.CONFLUENCE_CLOUD_ID)) throw new Error('Invalid CONFLUENCE_CLOUD_ID.');
      apiUrl = 'https://api.atlassian.com/ex/confluence/' + env.CONFLUENCE_CLOUD_ID + '/wiki/api/v2';
    } else apiUrl = siteUrl + '/wiki/api/v2';
  }
  apiUrl = validate(apiUrl);
  const v1Url = env.CONFLUENCE_API_V1_URL ? validate(env.CONFLUENCE_API_V1_URL) : (deployment === 'cloud' ? apiUrl.replace(/\/api\/v2$/, '/rest/api') : apiUrl);
  const templateApiUrl = validate(env.CONFLUENCE_TEMPLATE_API_URL || (deployment === 'datacenter' ? v1Url.replace(/\/rest\/api$/, '/rest/experimental') : v1Url));
  if (deployment === 'cloud' && !apiUrl.endsWith('/api/v2')) throw new Error('Cloud CONFLUENCE_API_URL must end with /api/v2.');
  return { deployment, siteUrl, apiUrl, v1Url, templateApiUrl, token, auth, email, spaceKey: env.CONFLUENCE_SPACE_KEY, webBase: deployment === 'cloud' ? siteUrl + '/wiki' : siteUrl, diagramProfile: diagramProfile(env), preserve: preservationMode(env.CONFLUENCE_PRESERVE) };
}

export class ConfluenceApi {
  constructor(config) { this.config = config; }

  apiBase(version) { return version === 'template' ? this.config.templateApiUrl ?? this.config.v1Url : version === 1 ? this.config.v1Url : this.config.apiUrl; }

  async request(path, { method = 'GET', body, form, version = 2, raw = false } = {}) {
    if (!path.startsWith('/') || path.startsWith('//') || path.split('?')[0].split('/').includes('..')) throw new Error('Expected a relative API resource path.');
    const base = this.apiBase(version);
    const auth = this.config.auth === 'bearer' ? 'Bearer ' + this.config.token : 'Basic ' + Buffer.from(this.config.email + ':' + this.config.token).toString('base64');
    const response = await fetch(base + path, {
      method,
      redirect: raw ? 'manual' : 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: auth, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(form ? { 'X-Atlassian-Token': 'nocheck' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : form ? { body: form } : {}),
    });
    if (raw && response.status >= 300 && response.status < 400) return response;
    if (!response.ok) throw new ApiError(response.status, method, path);
    if (raw) return response;
    if (response.status === 204) return null;
    return response.json();
  }

  async paginate(path, { version = 2, limit = 1000 } = {}) {
    const results = [];
    const seen = new Set();
    let next = path;
    while (next && results.length < limit) {
      if (seen.has(next)) throw new Error('Pagination cycle detected.');
      seen.add(next);
      const data = await this.request(next, { version });
      if (!Array.isArray(data.results)) throw new Error('API result is missing its results array.');
      results.push(...data.results.slice(0, limit - results.length));
      const link = data._links?.next;
      if (!link) break;
      const url = new URL(link, this.apiBase(version));
      if (![this.config.apiUrl, this.config.v1Url, this.config.siteUrl, this.apiBase(version)].map((base) => new URL(base).origin).includes(url.origin)) throw new Error('Refusing pagination outside the configured Confluence origin.');
      next = path.split('?')[0] + url.search;
    }
    return results;
  }

  pageUrl(id) { return this.config.webBase + '/pages/viewpage.action?pageId=' + encodeURIComponent(id); }

  async templateRequest(operation) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) throw new Error('Template API denied access (HTTP ' + error.status + '). Check template/space permissions and token scopes; Cloud granular tokens need read:template:confluence and read:content-details:confluence.', { cause: error });
      throw error;
    }
  }

  async listTemplates({ space, blueprint = false, limit = 50 } = {}) {
    const query = new URLSearchParams({ start: '0', limit: String(Math.min(limit, 100)), ...(space ? { spaceKey: space } : {}) });
    const result = await this.templateRequest(() => this.paginate('/template/' + (blueprint ? 'blueprint' : 'page') + '?' + query, { version: 'template', limit }));
    return result.map((item) => ({ id: String(item.templateId), name: item.name, description: item.description ?? '', type: item.templateType, space: item.space?.key ?? null }));
  }

  async getTemplate(id) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/.test(String(id))) throw new Error('Invalid Confluence template ID.');
    const result = await this.templateRequest(() => this.request('/template/' + encodeURIComponent(id) + '?expand=body.storage', { version: 'template' }));
    if (String(result.templateId) !== String(id) || typeof result.body?.storage?.value !== 'string') throw new Error('Confluence did not return the requested template ID and storage body.');
    return { id: String(result.templateId), name: result.name, description: result.description ?? '', type: result.templateType, space: result.space?.key ?? null, storage: result.body.storage.value, labels: (result.labels ?? []).map((item) => item.name) };
  }

  async previewStorage(storage, { pageId, space } = {}) {
    const query = new URLSearchParams({ ...(pageId ? { contentIdContext: pageId } : {}), ...(space ? { spaceKeyContext: space } : {}) });
    const body = { value: storage, representation: 'storage' };
    let result;
    if (this.config.deployment === 'datacenter') result = await this.request('/contentbody/convert/view?' + query, { version: 1, method: 'POST', body });
    else {
      const queued = await this.request('/contentbody/convert/async/view?' + query, { version: 1, method: 'POST', body });
      if (!queued.asyncId) throw new Error('Confluence did not return a preview task ID.');
      for (let attempt = 0; attempt < 20; attempt++) {
        result = await this.request('/contentbody/convert/async/' + encodeURIComponent(queued.asyncId), { version: 1 });
        if (typeof result.value === 'string' || result.error || result.status === 'FAILED') break;
        await setTimeout(500);
      }
    }
    if (result?.error || result?.status === 'FAILED' || typeof result?.value !== 'string') throw new Error('Confluence could not render the diagram preview. Check the installed macro and its configuration. No page was written.');
    const $ = load(result.value);
    const genericError = $('.error').toArray().some((node) => /unknown macro|macro not found|error rendering macro|unable to render|syntax error/i.test($(node).text()));
    if ($('.error-macro, .aui-message-error, .wysiwyg-unknown-macro, [data-macro-error]').length || genericError || /^\s*(unknown macro:|error rendering macro|macro not found:)/i.test($.text())) throw new Error('Confluence rejected a diagram macro preview. Check its installed app, macro name and syntax. No page was written.');
    if (!result.value.trim()) throw new Error('Confluence returned an empty diagram preview. No page was written.');
    return { verified: true, dynamic: $('iframe, [data-macro-name]').length > 0 };
  }

  normalize(page) {
    const id = String(page.id);
    const version = typeof page.version === 'object' ? page.version.number : page.version;
    if (!/^\d+$/.test(id) || !Number.isInteger(version)) throw new Error('Invalid page identity/version returned by Confluence.');
    return { id, title: page.title, version, status: page.status, spaceId: String(page.spaceId ?? page.space?.id ?? ''), spaceKey: page.space?.key, parentId: page.parentId ?? page.ancestors?.at(-1)?.id ?? null, storage: page.body?.storage?.value ?? '', url: this.pageUrl(id), updated: page.version?.createdAt ?? page.version?.when, raw: page };
  }

  async getPage(id, version) {
    if (!/^\d+$/.test(String(id))) throw new Error('Page ID must be numeric.');
    const dc = this.config.deployment === 'datacenter';
    const query = new URLSearchParams(dc ? { expand: 'body.storage,version,space,ancestors' } : { 'body-format': 'storage' });
    if (version) query.set('version', String(version));
    return this.normalize(await this.request((dc ? '/content/' : '/pages/') + id + '?' + query, { version: dc ? 1 : 2 }));
  }

  async getSpace(key = this.config.spaceKey) {
    if (!key) throw new Error('Specify --space or CONFLUENCE_SPACE_KEY.');
    if (this.config.deployment === 'datacenter') return this.request('/space/' + encodeURIComponent(key), { version: 1 });
    const data = await this.request('/spaces?keys=' + encodeURIComponent(key));
    const result = data.results.find((space) => space.key === key);
    if (!result) throw new Error('Configured space is not accessible.');
    return result;
  }

  async listPages({ space, parent, limit = 1000 } = {}) {
    const dc = this.config.deployment === 'datacenter';
    if (parent) return this.paginate(dc ? '/content/' + parent + '/child/page?expand=version,space&limit=100' : '/pages/' + parent + '/children?limit=100', { version: dc ? 1 : 2, limit });
    const target = await this.getSpace(space);
    return this.paginate(dc ? '/content?type=page&spaceKey=' + encodeURIComponent(target.key) + '&expand=version,space&limit=100' : '/pages?space-id=' + target.id + '&limit=100', { version: dc ? 1 : 2, limit });
  }

  async search(query, { space, cql, limit = 50 } = {}) {
    const quote = (value) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
    const expression = cql || 'type = page AND text ~ ' + quote(query) + ((space ?? this.config.spaceKey) ? ' AND space = ' + quote(space ?? this.config.spaceKey) : '');
    const results = await this.paginate('/search?cql=' + encodeURIComponent(expression) + '&limit=' + Math.min(limit, 100), { version: 1, limit });
    return results.map((entry) => ({ id: String(entry.content?.id ?? entry.id), title: entry.content?.title ?? entry.title, excerpt: entry.excerpt ?? '', url: this.pageUrl(entry.content?.id ?? entry.id) }));
  }

  async writePage({ id, title, storage, space, parentId, version, message }) {
    const dc = this.config.deployment === 'datacenter';
    const body = dc ? { type: 'page', title, space: { key: space.key }, body: { storage: { representation: 'storage', value: storage } }, ...(parentId ? { ancestors: [{ id: parentId }] } : {}) } : { title, spaceId: String(space.id), status: 'current', body: { representation: 'storage', value: storage }, ...(parentId ? { parentId: String(parentId) } : {}) };
    if (id) Object.assign(body, { id: String(id), status: 'current', version: { number: version + 1, message: message ?? 'Update from Markdown' } });
    const data = await this.request((dc ? '/content' : '/pages') + (id ? '/' + id : ''), { version: dc ? 1 : 2, method: id ? 'PUT' : 'POST', body });
    return this.normalize(data);
  }

  async deletePage(id) {
    const dc = this.config.deployment === 'datacenter';
    return this.request((dc ? '/content/' : '/pages/') + id, { method: 'DELETE', version: dc ? 1 : 2 });
  }

  async getProperty(id) {
    const dc = this.config.deployment === 'datacenter';
    const path = dc ? '/content/' + id + '/property/confluence-wiki-md' : '/pages/' + id + '/properties?key=confluence-wiki-md';
    try {
      const data = await this.request(path, { version: dc ? 1 : 2 });
      return dc ? data : data.results.find((item) => item.key === 'confluence-wiki-md') ?? null;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async setProperty(id, value) {
    if (Buffer.byteLength(JSON.stringify(value)) > 30000) throw new Error('Front matter exceeds the Confluence content property size limit.');
    const existing = await this.getProperty(id);
    const dc = this.config.deployment === 'datacenter';
    const path = dc ? '/content/' + id + '/property' + (existing ? '/confluence-wiki-md' : '') : '/pages/' + id + '/properties' + (existing ? '/' + existing.id : '');
    return this.request(path, { version: dc ? 1 : 2, method: existing ? 'PUT' : 'POST', body: { key: 'confluence-wiki-md', value, ...(existing ? { version: { number: existing.version.number + 1 } } : {}) } });
  }

  async labels(id) {
    const dc = this.config.deployment === 'datacenter';
    return this.paginate(dc ? '/content/' + id + '/label?limit=200' : '/pages/' + id + '/labels?limit=200', { version: dc ? 1 : 2 });
  }

  async setLabels(id, labels) {
    const existing = await this.labels(id);
    const names = existing.map((item) => item.name);
    const added = labels.filter((name) => !names.includes(name));
    if (added.length) await this.request('/content/' + id + '/label', { version: 1, method: 'POST', body: added.map((name) => ({ prefix: 'global', name })) });
    for (const name of names.filter((item) => !labels.includes(item))) await this.request('/content/' + id + '/label?name=' + encodeURIComponent(name), { version: 1, method: 'DELETE' });
  }

  async attachments(id) {
    const dc = this.config.deployment === 'datacenter';
    return this.paginate(dc ? '/content/' + id + '/child/attachment?limit=100' : '/pages/' + id + '/attachments?limit=100', { version: dc ? 1 : 2 });
  }

  async uploadAttachment(id, filename, bytes, mime = 'application/octet-stream') {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), filename);
    form.append('minorEdit', 'true');
    const base = '/content/' + id + '/child/attachment';
    const existing = (await this.attachments(id)).find((item) => item.title === filename);
    if (existing) {
      const remote = await this.downloadAttachment(id, existing);
      if (remote.equals(Buffer.from(bytes))) return { id: String(existing.id), title: filename, unchanged: true };
      const attachmentId = this.config.deployment === 'cloud' && !String(existing.id).startsWith('att') ? 'att' + existing.id : existing.id;
      return this.request(base + '/' + attachmentId + '/data', { version: 1, method: 'POST', form });
    }
    if (this.config.deployment === 'datacenter') return this.request(base, { version: 1, method: 'POST', form });
    return this.request(base, { version: 1, method: 'PUT', form });
  }

  async downloadAttachment(pageId, attachment) {
    let response;
    if (this.config.deployment === 'datacenter') {
      const link = attachment._links?.download;
      if (!link) throw new Error('Attachment download URL is missing.');
      const site = new URL(this.config.siteUrl);
      const context = site.pathname.replace(/\/$/, '');
      const url = new URL(/^https?:\/\//i.test(link) ? link : context && link.startsWith(context + '/') ? site.origin + link : this.config.siteUrl + '/' + link.replace(/^\//, ''));
      if (url.origin !== new URL(this.config.siteUrl).origin) throw new Error('Refusing authenticated attachment download outside the configured site.');
      response = await fetch(url, { headers: { Authorization: this.config.auth === 'bearer' ? 'Bearer ' + this.config.token : 'Basic ' + Buffer.from(this.config.email + ':' + this.config.token).toString('base64') }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    } else response = await this.request('/content/' + pageId + '/child/attachment/' + String(attachment.id).replace(/^att/, '') + '/download', { version: 1, raw: true });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Attachment redirect is missing its location.');
      const url = new URL(location, response.url || this.config.v1Url);
      if (url.protocol !== 'https:') throw new Error('Refusing insecure attachment redirect.');
      response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    }
    if (!response.ok) throw new ApiError(response.status, 'GET', '/attachment-download');
    return Buffer.from(await response.arrayBuffer());
  }
}
