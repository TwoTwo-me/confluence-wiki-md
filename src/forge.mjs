import { randomUUID } from 'node:crypto';
import { load } from 'cheerio';

const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const parameter = (key, value) => '<ac:adf-parameter key="' + xml(key) + '">' + xml(value) + '</ac:adf-parameter>';
const attribute = (key, value) => '<ac:adf-attribute key="' + key + '">' + xml(value) + '</ac:adf-attribute>';

export function forgeStorage(entry, source) {
  const localId = randomUUID();
  const title = entry.title || entry.name;
  const viewer = entry.adapter === 'mermaid-viewer';
  const guest = { ...entry.parameters, ...(viewer ? {} : { [entry.sourceParameter]: source }) };
  const parameters = parameter('local-id', localId) + parameter('extension-id', 'ari:cloud:ecosystem::extension/' + entry.extensionKey) + parameter('extension-title', title) + '<ac:adf-parameter key="guest-params">' + Object.entries(guest).map(([key, value]) => parameter(key, value)).join('') + '</ac:adf-parameter>';
  const node = '<ac:adf-node type="extension">' + attribute('extension-type', 'com.atlassian.ecosystem') + attribute('extension-key', entry.extensionKey) + '<ac:adf-attribute key="parameters">' + parameters + '</ac:adf-attribute>' + attribute('text', title) + attribute('layout', 'default') + attribute('local-id', localId) + '</ac:adf-node>';
  const code = viewer ? '<ac:structured-macro ac:name="code" ac:schema-version="1"><ac:parameter ac:name="language">none</ac:parameter><ac:parameter ac:name="title">mermaid</ac:parameter><ac:plain-text-body><![CDATA[' + source.replaceAll(']]>', ']]]]><![CDATA[>') + ']]></ac:plain-text-body></ac:structured-macro>' : '';
  return code + '<ac:adf-extension' + (viewer ? ' data-cfwiki-viewer="true"' : '') + '>' + node + '<ac:adf-fallback>' + node + '</ac:adf-fallback></ac:adf-extension>';
}

export function finalizeForgeViewers(storage) {
  if (!storage.includes('data-cfwiki-viewer')) return storage;
  const $ = load(storage, { xmlMode: true });
  const codes = $('ac\\:structured-macro').toArray().filter((node) => $(node).attr('ac:name') === 'code');
  $('ac\\:adf-extension[data-cfwiki-viewer]').each((_i, node) => {
    const index = codes.indexOf($(node).prev()[0]);
    if (index < 0) throw new Error('Mermaid viewer is missing its source code block.');
    $(node).find('ac\\:adf-parameter[key="guest-params"]').each((_j, guest) => {
      $(guest).children('[key="index"]').remove();
      $(guest).append('<ac:adf-parameter key="index" type="integer">' + index + '</ac:adf-parameter>');
    });
    $(node).removeAttr('data-cfwiki-viewer');
  });
  return $.xml();
}

export function freshForgeIds(storage) {
  if (!storage.includes('<ac:adf-extension')) return storage;
  const $ = load(storage, { xmlMode: true });
  $('ac\\:adf-extension').each((_i, node) => {
    const id = randomUUID();
    $(node).find('ac\\:adf-parameter[key="local-id"], ac\\:adf-attribute[key="local-id"]').text(id);
  });
  return $.xml();
}

export function readForgeDiagrams($, profile) {
  const codes = $('ac\\:structured-macro').toArray().filter((node) => $(node).attr('ac:name') === 'code');
  const nodes = $('ac\\:adf-extension').toArray().filter((node) => !$(node).parents('ac\\:adf-extension, ac\\:structured-macro, ac\\:macro').length);
  const viewers = nodes.filter((node) => Object.values(profile).some((entry) => entry.adapter === 'mermaid-viewer' && entry.extensionKey === $(node).children('ac\\:adf-node').first().children('[key="extension-key"]').text()));
  return nodes.map((node) => {
    const extension = $(node).children('ac\\:adf-node').first();
    const key = extension.children('[key="extension-key"]').text();
    const match = Object.entries(profile).find(([_engine, entry]) => entry.extensionKey && entry.extensionKey === key);
    if (!match) return { node };
    const [engine, entry] = match;
    const guest = extension.children('[key="parameters"]').children('[key="guest-params"]');
    if (entry.adapter === 'mermaid-viewer') {
      const index = guest.children('[key="index"]');
      const explicitIndex = /^(0|[1-9]\d*)$/.test(index.text()) ? Number(index.text()) : -1;
      const code = index.length ? codes[explicitIndex] : codes.length === viewers.length && $(node).prev()[0] === codes[viewers.indexOf(node)] ? $(node).prev()[0] : null;
      return code ? { node, engine, source: $(code).children('ac\\:plain-text-body').text(), code } : { node };
    }
    const source = guest.children().filter((_i, item) => $(item).attr('key') === entry.sourceParameter);
    return source.length ? { node, engine, source: source.text() } : { node };
  });
}
