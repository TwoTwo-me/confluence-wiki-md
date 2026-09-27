import { load } from 'cheerio';

const RICH_BODY_MACROS = new Set(['expand', 'info', 'note', 'panel', 'quote', 'tip', 'warning']);

function trustedContext(snapshot) {
  if (snapshot?.sourceType !== 'confluence-storage' ||
      typeof snapshot.storage !== 'string' ||
      !/^\d+$/.test(snapshot.id) ||
      !Number.isInteger(snapshot.version) ||
      snapshot.version < 1 ||
      typeof snapshot.space?.key !== 'string' ||
      !snapshot.space.key.trim()) {
    throw new Error('A verified Confluence storage snapshot is required.');
  }
  const { deployment, siteUrl } = snapshot.tenant ?? {};
  if (!['cloud', 'datacenter'].includes(deployment) || typeof siteUrl !== 'string') {
    throw new Error('A verified Confluence storage snapshot is required.');
  }
  let site;
  try { site = new URL(siteUrl); } catch { throw new Error('A verified Confluence storage snapshot is required.'); }
  if (!['http:', 'https:'].includes(site.protocol) || site.username || site.password || site.search || site.hash ||
      site.href.replace(/\/+$/, '') !== siteUrl) throw new Error('A verified Confluence storage snapshot is required.');
  const webBase = deployment === 'cloud' ? siteUrl + '/wiki' : siteUrl;
  if (snapshot.url !== webBase + '/pages/viewpage.action?pageId=' + encodeURIComponent(snapshot.id)) {
    throw new Error('Snapshot page URL is outside the trusted Confluence context.');
  }
  const base = new URL(webBase);
  return {
    base,
    sourceUrl: new URL(snapshot.url),
    deployment,
    path: base.pathname.replace(/\/+$/, ''),
    spaceKey: snapshot.space.key,
  };
}

function decoded(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}

function hasEncodedTraversal(href) {
  const withoutOrigin = href.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*|^\/\/[^/]*/i, '');
  const rawPath = withoutOrigin.split(/[?#]/, 1)[0];
  return rawPath.split('/').some((segment) => {
    if (!segment.includes('%')) return false;
    let value = segment;
    while (value.includes('%')) {
      const next = decoded(value);
      if (next === null || next.length >= value.length) return true;
      value = next;
      if (value === '.' || value === '..' || /[\\/]/.test(value)) return true;
    }
    return false;
  });
}

function hasUnsafeDotSegments(href) {
  const withoutOrigin = href.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*|^\/\/[^/]*/i, '');
  const rawPath = withoutOrigin.split(/[?#]/, 1)[0];
  const rooted = rawPath.startsWith('/');
  let sawContent = false;
  for (const segment of rawPath.split('/')) {
    if (segment === '.' || segment === '..') {
      if (rooted || sawContent) return true;
    } else if (segment) sawContent = true;
  }
  return false;
}

function pageTargetFromHref(href, context) {
  if (!href || href.startsWith('#') || href.includes('\\') || hasEncodedTraversal(href) || hasUnsafeDotSegments(href)) return null;
  let url;
  try { url = new URL(href, context.sourceUrl); } catch { return null; }
  if (url.origin !== context.base.origin || url.username || url.password) return null;
  const fragment = url.hash ? url.hash.slice(1) : undefined;
  if (url.pathname === context.path + '/pages/viewpage.action') {
    const ids = url.searchParams.getAll('pageId');
    if (ids.length === 1 && /^\d+$/.test(ids[0])) return { id: ids[0], ...(fragment ? { fragment } : {}) };
    const title = url.searchParams.get('title')?.trim();
    const space = url.searchParams.get('spaceKey') || context.spaceKey;
    if (title && space === context.spaceKey) return { title, space, ...(fragment ? { fragment } : {}) };
    return null;
  }
  const escaped = context.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const modern = url.pathname.match(new RegExp('^' + escaped + '/spaces/([^/]+)/pages/(\\d+)(?:/[^/]*)?/?$'));
  if (modern && decoded(modern[1]) === context.spaceKey) return { id: modern[2], ...(fragment ? { fragment } : {}) };
  if (context.deployment === 'datacenter') {
    const display = url.pathname.match(new RegExp('^' + escaped + '/display/([^/]+)/(.+?)/?$'));
    if (display) {
      const space = decoded(display[1]);
      const title = decoded(display[2].replaceAll('+', ' '))?.trim();
      if (space === context.spaceKey && title) return { title, space, ...(fragment ? { fragment } : {}) };
    }
  }
  return null;
}

function sourceLocation($, node, index, fragment) {
  const ancestors = $(node).parents().toArray().reverse().map((parent) => parent.tagName ?? parent.name).filter(Boolean);
  const label = $(node).text().trim();
  return { index, path: '/' + [...ancestors, node.tagName ?? node.name].join('/'), ...(fragment ? { fragment } : {}), ...(label ? { label } : {}) };
}

/** Extract page edges from one previously admitted Confluence storage snapshot. */
export function extractStorageLinks(snapshot) {
  const context = trustedContext(snapshot);
  const sourceId = snapshot.id;
  const version = snapshot.version;
  const $ = load(snapshot.storage, { xmlMode: true });
  const grouped = new Map();
  const unresolved = new Map();
  let locationIndex = 0;
  const ignored = (node) => {
    if ($(node).closest('ac\\:image, ri\\:attachment, ac\\:parameter, ac\\:plain-text-body, pre, code').length) return true;
    for (const macro of $(node).parents('ac\\:structured-macro, ac\\:macro').toArray()) {
      if (!RICH_BODY_MACROS.has($(macro).attr('ac:name'))) return true;
      let child = node;
      while (child?.parent && child.parent !== macro) child = child.parent;
      if (child?.name !== 'ac:rich-text-body') return true;
    }
    return false;
  };
  const locationFor = (node, fragment) => sourceLocation($, node, locationIndex++, fragment);
  const add = (target, location) => {
    if (target.id === sourceId) return;
    const previous = grouped.get(target.id);
    if (previous) {
      previous.locations.push(location);
      if (location.fragment && !previous.fragments.includes(location.fragment)) previous.fragments.push(location.fragment);
    } else grouped.set(target.id, { sourceId, version, ...target, fragments: location.fragment ? [location.fragment] : [], locations: [location] });
  };
  const addUnresolved = (target, location, reason) => {
    const key = target.title + ':' + (target.space ?? '');
    const previous = unresolved.get(key);
    if (previous) previous.locations.push(location);
    else unresolved.set(key, { sourceId, version, ...target, locations: [location], reason });
  };

  $('ac\\:link').each((_i, node) => {
    if (ignored(node)) return;
    const pages = $(node).children('ri\\:page');
    if (pages.length !== 1 || $(node).find('ri\\:attachment, ri\\:url, ri\\:user').length) return;
    const page = pages.first();
    const id = page.attr('ri:content-id');
    const title = page.attr('ri:content-title');
    const space = page.attr('ri:space-key') || undefined;
    const fragment = $(node).attr('ac:anchor') || undefined;
    const location = locationFor(node, fragment);
    if (id && /^\d+$/.test(id)) add({ id, ...(fragment ? { fragment } : {}) }, location);
    else if (!id && title && (!space || space === context.spaceKey)) {
      addUnresolved({ title, space: space ?? context.spaceKey, ...(fragment ? { fragment } : {}) }, location, 'title-only-exact-match-required');
    }
  });

  $('a[href]').each((_i, node) => {
    if (ignored(node) || $(node).parents('ac\\:link, ac\\:image').length) return;
    const target = pageTargetFromHref($(node).attr('href'), context);
    if (!target || target.id === sourceId) return;
    const location = locationFor(node, target.fragment);
    if (target.id) add(target, location);
    else addUnresolved(target, location, 'title-only-exact-match-required');
  });

  return { sourceId, version, links: [...grouped.values()], unresolved: [...unresolved.values()] };
}
