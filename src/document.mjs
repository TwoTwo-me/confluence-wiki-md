import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import Turndown from 'turndown';
import gfm from 'turndown-plugin-gfm';
import { load } from 'cheerio';
import { parseDocument as parseYaml, stringify } from 'yaml';
import sanitizeHtml from 'sanitize-html';
import { createHash, randomUUID } from 'node:crypto';
import { diagramKey } from './diagrams.mjs';
import { freshForgeIds, readForgeDiagrams, finalizeForgeViewers } from './forge.mjs';

export function validateStorageXml(storage) {
  const invalid = () => { throw new Error('Confluence storage is malformed XML.'); };
  const validXmlCodePoint = (point) => point === 0x9 || point === 0xa || point === 0xd ||
    (point >= 0x20 && point <= 0xd7ff) || (point >= 0xe000 && point <= 0xfffd) ||
    (point >= 0x10000 && point <= 0x10ffff);
  for (const character of storage) {
    if (!validXmlCodePoint(character.codePointAt(0))) invalid();
  }
  const validateReferences = (value) => {
    for (let index = 0; index < value.length; index++) {
      if (value[index] !== '&') continue;
      const match = value.slice(index).match(/^&(?:#(?:[0-9]+|x[0-9a-fA-F]+)|[A-Za-z_:][\w.:-]*);/);
      if (!match) invalid();
      const reference = match[0].slice(1, -1);
      if (reference[0] === '#') {
        const hexadecimal = reference[1] === 'x';
        const digits = reference.slice(hexadecimal ? 2 : 1);
        const point = Number.parseInt(digits, hexadecimal ? 16 : 10);
        if (!Number.isFinite(point) || !validXmlCodePoint(point)) invalid();
      } else if (!['amp', 'lt', 'gt', 'apos', 'quot'].includes(reference)) {
        invalid();
      }
      index += match[0].length - 1;
    }
  };
  const name = /^[A-Za-z_][\w.:-]*/;
  const validQName = (value) => {
    const firstColon = value.indexOf(':');
    if (firstColon !== value.lastIndexOf(':')) return false;
    const components = firstColon < 0 ? [value] : value.split(':');
    return components.every((component) => /^[A-Za-z_][A-Za-z0-9._-]*$/.test(component));
  };
  const stack = [];
  const elements = new Map();
  let at = 0;
  while (at < storage.length) {
    if (storage[at] !== '<') {
      const nextTag = storage.indexOf('<', at);
      const text = storage.slice(at, nextTag < 0 ? storage.length : nextTag);
      if (text.includes(']]>')) invalid();
      validateReferences(text);
      at = nextTag < 0 ? storage.length : nextTag;
      continue;
    }
    if (storage.startsWith('<!--', at)) {
      const end = storage.indexOf('-->', at + 4);
      if (end < 0 || storage.slice(at + 4, end).includes('--')) invalid();
      at = end + 3;
      continue;
    }
    if (storage.startsWith('<![CDATA[', at)) {
      const end = storage.indexOf(']]>', at + 9);
      if (end < 0) invalid();
      at = end + 3;
      continue;
    }
    if (storage.startsWith('<?', at)) {
      const end = storage.indexOf('?>', at + 2);
      if (end < 0) invalid();
      at = end + 2;
      continue;
    }
    const nextTag = storage.indexOf('<', at);
    validateReferences(storage.slice(at, nextTag < 0 ? storage.length : nextTag));
    let cursor = at + 1;
    const closing = storage[cursor] === '/';
    if (closing) cursor++;
    const tag = storage.slice(cursor).match(name)?.[0];
    if (!tag || !validQName(tag)) invalid();
    cursor += tag.length;
    if (closing) {
      if (!/^[ \t\r\n]*>/.test(storage.slice(cursor)) || stack.pop() !== tag) invalid();
      at = storage.indexOf('>', cursor) + 1;
      continue;
    }
    let selfClosing = false;
    const attributes = new Set();
    while (cursor < storage.length) {
      const rest = storage.slice(cursor);
      const whitespace = rest.match(/^[ \t\r\n]*/)[0].length;
      cursor += whitespace;
      if (storage.startsWith('/>', cursor)) { selfClosing = true; cursor += 2; break; }
      if (storage[cursor] === '>') { cursor++; break; }
      if (!whitespace) invalid();
      const attribute = storage.slice(cursor).match(name)?.[0];
      if (!attribute || !validQName(attribute)) invalid();
      if (attributes.has(attribute)) invalid();
      attributes.add(attribute);
      cursor += attribute.length;
      cursor += storage.slice(cursor).match(/^[ \t\r\n]*/)[0].length;
      if (storage[cursor++] !== '=') invalid();
      cursor += storage.slice(cursor).match(/^[ \t\r\n]*/)[0].length;
      const quote = storage[cursor++];
      if (quote !== '"' && quote !== "'") invalid();
      const end = storage.indexOf(quote, cursor);
      if (end < 0 || storage.slice(cursor, end).includes('<')) invalid();
      validateReferences(storage.slice(cursor, end));
      cursor = end + 1;
    }
    if (cursor > storage.length || (storage[cursor - 1] !== '>' && !selfClosing)) invalid();
    elements.set(at, { name: tag, attributes: [...attributes] });
    if (!selfClosing) stack.push(tag);
    at = cursor;
  }
  if (stack.length) invalid();
  return elements;
}

export function loadStorageXml(storage) {
  const elements = validateStorageXml(storage);
  const $ = load(storage, { xmlMode: true, withStartIndices: true, withEndIndices: true });
  const invalid = () => { throw new Error('Confluence storage cannot be represented without losing element or attribute data.'); };
  // Check original input before conversion, including opaque/native descendants.
  for (const node of $('*').toArray()) {
    const original = elements.get(node.startIndex);
    if (!original || original.name !== node.name ||
        original.attributes.length !== Object.keys(node.attribs).length ||
        original.attributes.some((name) => !Object.hasOwn(node.attribs, name) || typeof node.attribs[name] !== 'string')) invalid();
    elements.delete(node.startIndex);
  }
  if (elements.size) invalid();
  return $;
}

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const bodyHash = (body) => 'sha256:' + hash(body.replaceAll('\r\n', '\n'));

export function bodyStatus({ metadata, body }) {
  const baseBodyHash = metadata.confluence?.base_body_hash ?? null;
  const currentBodyHash = bodyHash(body);
  const bodyModified = baseBodyHash === null ? null : baseBodyHash !== currentBodyHash;
  return { bodyStatus: bodyModified === null ? 'unknown' : bodyModified ? 'modified' : 'unchanged', bodyModified, baseBodyHash, currentBodyHash };
}

const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const cdata = (value) => '<![CDATA[' + value.replaceAll(']]>', ']]]]><![CDATA[>') + ']]>';
export function preservationMode(value = 'minimal') {
  if (!['minimal', 'all', 'none'].includes(value)) throw new Error('Preservation must be minimal, all, or none.');
  return value;
}

function tocStorage(source) {
  if (Buffer.byteLength(source) > 65536) throw new Error('confluence-toc parameters exceed 64 KiB.');
  const yaml = parseYaml(source, { uniqueKeys: true });
  if (yaml.errors.length) throw new Error('Invalid confluence-toc YAML: ' + yaml.errors[0].message.split('\n')[0]);
  const parameters = yaml.toJS({ maxAliasCount: 20 }) ?? {};
  if (typeof parameters !== 'object' || Array.isArray(parameters) || Object.entries(parameters).some(([key, value]) => !key || !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))) throw new Error('confluence-toc expects a YAML mapping of scalar parameters.');
  return '<ac:structured-macro ac:name="toc" ac:schema-version="1">' + Object.entries(parameters).map(([key, value]) => '<ac:parameter ac:name="' + escapeXml(key) + '">' + escapeXml(String(value)) + '</ac:parameter>').join('') + '</ac:structured-macro>';
}
const languageMap = { js: 'javascript', ts: 'typescript', sh: 'bash', py: 'python', yml: 'yaml' };
const codeLanguages = new Set(['none', 'text', 'javascript', 'typescript', 'python', 'bash', 'java', 'json', 'yaml', 'xml', 'html', 'css', 'sql', 'go', 'rust', 'c', 'cpp', 'csharp', 'ruby', 'php', 'powershell', 'diff']);
const codeMacro = (code, language) => {
  const normalized = languageMap[language] ?? language;
  const supported = codeLanguages.has(normalized) ? normalized : 'none';
  const title = language && supported !== language ? '<ac:parameter ac:name="title">' + escapeXml(language) + '</ac:parameter>' : '';
  return '<ac:structured-macro ac:name="code" ac:schema-version="1"><ac:parameter ac:name="language">' + escapeXml(supported || 'none') + '</ac:parameter>' + title + '<ac:plain-text-body>' + cdata(code) + '</ac:plain-text-body></ac:structured-macro>';
};

export function parseDocument(source) {
  if (typeof source !== 'string') throw new Error('Document must be UTF-8 Markdown text.');
  const normalized = source.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  let metadata = {};
  let body = normalized;
  if (normalized.startsWith('---\n')) {
    const closing = /^---[\t ]*$/m.exec(normalized.slice(4));
    const end = closing ? closing.index + 3 : -1;
    if (end < 0) throw new Error('Unterminated YAML front matter.');
    const yaml = parseYaml(normalized.slice(4, end), { uniqueKeys: true });
    if (yaml.errors.length) throw new Error('Invalid YAML front matter: ' + yaml.errors[0].message.split('\n')[0]);
    metadata = yaml.toJS({ maxAliasCount: 50 }) ?? {};
    if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('YAML front matter must be a mapping.');
    body = normalized.slice(4 + closing.index + closing[0].length).replace(/^\n/, '');
  }
  if (metadata.type === undefined) metadata.type = 'Reference';
  if (typeof metadata.type !== 'string' || !metadata.type.trim()) throw new Error('OKF type must be a non-empty string.');
  if (metadata.title !== undefined && (typeof metadata.title !== 'string' || !metadata.title.trim())) throw new Error('title must be a non-empty string.');
  if (metadata.tags !== undefined && (!Array.isArray(metadata.tags) || metadata.tags.some((tag) => typeof tag !== 'string'))) throw new Error('tags must be a list of strings.');
  if (metadata.confluence !== undefined) {
    const meta = metadata.confluence;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('confluence metadata must be a mapping.');
    if (meta.id !== undefined && !/^\d+$/.test(String(meta.id))) throw new Error('confluence.id must be a numeric page ID.');
    if (meta.id !== undefined) meta.id = String(meta.id);
    if (meta.template_id !== undefined) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/.test(String(meta.template_id))) throw new Error('confluence.template_id must be a valid Confluence template ID.');
      meta.template_id = String(meta.template_id);
    }
    if (meta.version !== undefined && (!Number.isSafeInteger(meta.version) || meta.version < 1)) throw new Error('confluence.version must be a positive integer.');
    if (meta.base_body_hash !== undefined && (typeof meta.base_body_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(meta.base_body_hash))) throw new Error('confluence.base_body_hash must be sha256: followed by 64 lowercase hexadecimal characters.');
    if (meta.preserved !== undefined && (!Array.isArray(meta.preserved) || meta.preserved.some((item) => !item || typeof item.markdown !== 'string' || typeof item.storage !== 'string'))) throw new Error('Invalid preserved Confluence fragments.');
  }
  return { metadata, body };
}

export function formatDocument({ metadata, body }) {
  return '---\n' + stringify(metadata, { lineWidth: 0, aliasDuplicateObjects: false }) + '---\n' + body;
}

export function markdownToStorage(source, { preserved = [], links = {}, images = {}, diagrams = {}, flattenNestedQuotes = false } = {}) {
  const replacements = new Map();
  const stash = (xml, inline = false) => {
    const id = 'cfwiki-' + randomUUID();
    replacements.set(id, xml);
    return '<' + (inline ? 'span' : 'div') + ' data-cfwiki="' + id + '"> </' + (inline ? 'span' : 'div') + '>';
  };
  let input = source;
  for (const item of preserved) {
    if (item.markdown && input.includes(item.markdown)) input = input.replace(item.markdown, stash(item.storage, item.block === false));
  }
  const md = new MarkdownIt({ html: true, xhtmlOut: true, linkify: true }).use(footnote).use(taskLists);
  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    const language = token.info.trim().split(/\s+/)[0];
    if (language === 'confluence-toc') return stash(tocStorage(token.content));
    return stash(freshForgeIds(diagrams[diagramKey(language, token.content)] ?? codeMacro(token.content, language)));
  };
  md.renderer.rules.code_block = (tokens, index) => stash(codeMacro(tokens[index].content, ''));
  md.renderer.rules.footnote_anchor_name = (tokens, index) => encodeURIComponent(tokens[index].meta.label ?? String(tokens[index].meta.id + 1));
  const raw = md.render(input);
  const sanitized = sanitizeHtml(raw, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'input', 'del', 's', 'sup', 'sub', 'section', 'details', 'summary'],
    allowedAttributes: { '*': ['id', 'class', 'data-cfwiki'], a: ['href', 'title', 'id'], img: ['src', 'alt', 'title', 'width', 'height'], input: ['type', 'checked', 'disabled'], th: ['align', 'style', 'colspan', 'rowspan'], td: ['align', 'style', 'colspan', 'rowspan'], ol: ['start'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedStyles: { '*': { 'text-align': [/^(left|center|right)$/] } },
  });
  const $ = load(sanitized, { xmlMode: true });
  const warnings = [];
  if (flattenNestedQuotes) {
    const nested = $('blockquote blockquote').toArray();
    for (const node of nested) {
      const prefix = '› '.repeat($(node).parents('blockquote').length);
      const paragraphs = $(node).children('p');
      if (paragraphs.length) paragraphs.each((_i, p) => $(p).prepend(prefix));
      else $(node).prepend($('<p></p>').text(prefix.trimEnd()));
    }
    for (const node of nested.reverse()) $(node).replaceWith(($(node).html() ?? '').trim());
    if (nested.length) warnings.push('Confluence Cloud nested quotes were flattened with › depth markers to avoid hidden text in its renderer.');
  }
  $('a[href]').each((_i, node) => {
    const href = $(node).attr('href');
    if (links[href]) $(node).attr('href', links[href]);
  });
  $('img').each((_i, node) => {
    const src = $(node).attr('src');
    if (!src) return;
    const image = images[src];
    const attributes = ' ac:alt="' + escapeXml($(node).attr('alt') ?? '') + '"';
    $(node).replaceWith(stash('<ac:image' + attributes + '>' + (image ? '<ri:attachment ri:filename="' + escapeXml(image) + '"/>' : '<ri:url ri:value="' + escapeXml(src) + '"/>') + '</ac:image>', true));
  });
  $('sup.footnote-ref[id], sup.footnote-ref [id], li.footnote-item[id]').each((_i, node) => {
    const target = $(node).closest('sup.footnote-ref').length ? $(node).closest('sup.footnote-ref') : $(node);
    target.prepend(stash('<ac:structured-macro ac:name="anchor" ac:schema-version="1"><ac:parameter ac:name="">' + escapeXml($(node).attr('id')) + '</ac:parameter></ac:structured-macro>', true));
  });
  let taskId = 0;
  $('li.task-list-item').toArray().reverse().forEach((node) => {
    const checkbox = $(node).find('input[type="checkbox"]').first();
    const done = checkbox.attr('checked') !== undefined;
    checkbox.remove();
    $(node).replaceWith(stash('<ac:task-list><ac:task><ac:task-id>' + (++taskId) + '</ac:task-id><ac:task-status>' + (done ? 'complete' : 'incomplete') + '</ac:task-status><ac:task-body>' + ($(node).html() ?? '').trim() + '</ac:task-body></ac:task></ac:task-list>'));
  });
  $('ul.contains-task-list').each((_i, node) => { if (!$(node).children('li').length) $(node).replaceWith($(node).html() ?? ''); });
  let storage = $.xml();
  for (const [id, xml] of [...replacements].reverse()) {
    storage = storage.replace(new RegExp('<(?:div|span) data-cfwiki="' + id + '">[\\s\\S]*?</(?:div|span)>'), () => xml);
  }
  return { storage: finalizeForgeViewers(storage).trim(), warnings };
}

export function validateAgentPreservation(draft, trusted) {
  const conflict = (code, message, markdown) => ({ code, message, ...(markdown === undefined ? {} : { markdown }) });
  const conflicts = [];
  const body = draft?.body;
  const draftItems = draft?.metadata?.confluence?.preserved ?? [];
  const trustedItems = trusted?.metadata?.confluence?.preserved ?? [];
  if (typeof body !== 'string') conflicts.push(conflict('invalid_draft', 'Agent draft body must be Markdown text.'));
  if (!Array.isArray(draftItems)) conflicts.push(conflict('invalid_draft_preservation', 'Agent draft preserved fragments must be a list.'));
  if (!Array.isArray(trustedItems)) conflicts.push(conflict('invalid_trusted_preservation', 'Trusted preserved fragments must be a list.'));
  if (conflicts.length) return { conflicts };

  const valid = (item) => item && typeof item.markdown === 'string' && item.markdown.length > 0 && typeof item.storage === 'string' && item.storage.length > 0;
  const trustedByMarkdown = new Map();
  for (const item of trustedItems) {
    if (!valid(item)) {
      conflicts.push(conflict('invalid_trusted_fragment', 'Trusted preserved fragment is malformed.', item?.markdown));
      continue;
    }
    const matches = trustedByMarkdown.get(item.markdown) ?? [];
    matches.push(item);
    trustedByMarkdown.set(item.markdown, matches);
  }
  for (const [markdown, items] of trustedByMarkdown) {
    if (items.length > 1) conflicts.push(conflict('ambiguous_preserved_fallback', 'Trusted preserved fallback is duplicated and cannot be mapped uniquely.', markdown));
  }

  const seenDraft = new Set();
  for (const item of draftItems) {
    if (!valid(item)) {
      conflicts.push(conflict('invalid_draft_fragment', 'Agent draft preserved fragment is malformed.', item?.markdown));
      continue;
    }
    if (seenDraft.has(item.markdown)) conflicts.push(conflict('ambiguous_preserved_fallback', 'Agent draft preserved fallback is duplicated and cannot be mapped uniquely.', item.markdown));
    seenDraft.add(item.markdown);
    const matches = trustedByMarkdown.get(item.markdown) ?? [];
    if (matches.length === 0) conflicts.push(conflict('injected_preserved_fragment', 'Agent draft introduced an untrusted preserved fragment.', item.markdown));
    else if (matches.length === 1 && item.storage !== matches[0].storage) conflicts.push(conflict('modified_preserved_fragment', 'Agent draft modified trusted preserved XML.', item.markdown));
  }

  for (const item of trustedItems.filter(valid)) {
    if (!seenDraft.has(item.markdown)) {
      conflicts.push(conflict('missing_preserved_fragment', 'Agent draft removed trusted preserved fragment metadata.', item.markdown));
      continue;
    }
    const occurrences = body.split(item.markdown).length - 1;
    if (occurrences !== 1) conflicts.push(conflict('ambiguous_preserved_fallback', 'Trusted preserved fallback must occur exactly once in the agent draft.', item.markdown));
  }
  if (conflicts.length) return { conflicts };
  return { preserved: trustedItems.map((item) => ({ ...item })), conflicts: [] };
}

export function fenced(code, language = '') {
  const longest = Math.max(2, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return fence + language.replace(/[\r\n`]/g, '') + '\n' + code.replace(/\n$/, '') + '\n' + fence;
}

export function references(markdown) {
  const result = [];
  const visit = (tokens) => {
    for (const token of tokens) {
      if (token.type === 'image') result.push({ kind: 'image', url: token.attrGet('src') });
      if (token.type === 'link_open') result.push({ kind: 'link', url: token.attrGet('href') });
      if (token.children) visit(token.children);
    }
  };
  visit(new MarkdownIt().use(footnote).parse(markdown, {}));
  return result;
}

export function storageToMarkdown(storage, { pageUrl, siteUrl, pageId, pageLinks = {}, attachments = {}, diagramProfile = {}, preserve = 'all' } = {}) {
  preservationMode(preserve);
  const $ = loadStorageXml(storage);
  const snippets = [];
  const preserved = [];
  const warnings = [];
  const origin = pageUrl ?? siteUrl ?? 'https://example.invalid';
  const td = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*', strongDelimiter: '**' });
  td.use(gfm.gfm);
  td.keep(['sub', 'sup']);
  td.addRule('cfwiki-table-cell', { filter: ['th', 'td'], replacement: (content, node) => {
    const prefix = node.parentNode.firstChild === node ? '| ' : ' ';
    return prefix + content.trim().replace(/\|/g, '\\|').replace(/[ \t]*\n[ \t]*/g, '<br>') + ' |';
  } });
  td.addRule('strikethrough', { filter: ['del', 's', 'strike'], replacement: (content) => '~~' + content + '~~' });
  td.addRule('cfwiki-snippet', { filter: (node) => node.hasAttribute?.('data-cfwiki-md'), replacement: (_content, node) => {
    const spacing = node.getAttribute('data-cfwiki-block') === 'true' ? '\n\n' : '';
    return spacing + 'CFWIKISNIPPET' + node.getAttribute('data-cfwiki-md') + 'END' + spacing;
  } });
  td.addRule('hard-break', { filter: 'br', replacement: () => '  \n' });
  const replace = (node, markdown, preserve = false, block = true) => {
    if (!block && $(node).parents('th,td').length) markdown = markdown.replace(/\|/g, '\\|').replace(/[ \t]*\n[ \t]*/g, '<br>');
    if (preserve) preserved.push({ markdown, storage: storage.slice(node.startIndex, node.endIndex + 1), block });
    const index = snippets.push(markdown) - 1;
    $(node).replaceWith('<span data-cfwiki-md="' + index + '" data-cfwiki-block="' + block + '">cfwiki</span>');
  };
  const reference = (label, url = origin) => '[' + label.replace(/[\[\]]/g, '') + '](' + String(url).replaceAll(' ', '%20').replaceAll('(', '%28').replaceAll(')', '%29') + ')';
  const param = (node, name) => $(node).children('ac\\:parameter').filter((_i, item) => $(item).attr('ac:name') === name).text();
  for (const diagram of readForgeDiagrams($, diagramProfile)) {
    if (diagram.code) $(diagram.code).remove();
    replace(diagram.node, diagram.engine ? fenced(diagram.source, diagram.engine) : reference('Confluence: Forge macro'), !diagram.engine || preserve === 'all');
    if (!diagram.engine) warnings.push('Referenced unsupported Forge macro.');
  }
  $('table').each((_i, node) => {
    if (node.parent && $(node).find('[colspan], [rowspan], table').length) {
      replace(node, reference('Confluence table'), true);
      warnings.push('Referenced table with merged or nested cells.');
    }
  });
  $('ac\\:structured-macro, ac\\:macro').toArray().filter((node) => !$(node).parents('ac\\:structured-macro, ac\\:macro').length).forEach((node) => {
    if (!node.parent) return;
    const name = $(node).attr('ac:name') ?? 'macro';
    const plain = $(node).children('ac\\:plain-text-body');
    const diagram = Object.entries(diagramProfile).find(([_engine, entry]) => entry.name === name);
    if (name === 'anchor' && $(node).parents('sup.footnote-ref, li.footnote-item').length) { $(node).remove(); return; }
    if (diagram) {
      const [engine, entry] = diagram;
      replace(node, fenced(entry.sourceParameter ? param(node, entry.sourceParameter) : plain.text(), engine), preserve === 'all');
    } else if (name === 'toc' && preserve !== 'all' && !$(node).children().not('ac\\:parameter').length && !$(node).children('ac\\:parameter').children().length) {
      const parameters = Object.fromEntries($(node).children('ac\\:parameter').toArray().map((item) => [$(item).attr('ac:name') ?? '', $(item).text()]));
      replace(node, fenced(stringify(parameters, { lineWidth: 0 }), 'confluence-toc'));
    } else if (name === 'code' || name === 'noformat') {
      const language = param(node, 'language');
      const title = param(node, 'title');
      const customTitle = title && ((language !== 'none' && languageMap[title] !== language) || !/^[a-zA-Z0-9][a-zA-Z0-9_+.#-]*$/.test(title));
      const customParameters = $(node).children('ac\\:parameter').toArray().some((item) => !['language', 'title'].includes($(item).attr('ac:name')));
      replace(node, fenced(plain.text(), (language === 'none' && title) || (languageMap[title] === language && title) || (language === 'none' ? '' : language)), preserve === 'all' || Boolean(customTitle) || customParameters);
    } else if (plain.length) {
      replace(node, fenced(plain.text(), name), true);
    } else if (['info', 'note', 'tip', 'warning', 'panel', 'expand', 'quote'].includes(name)) {
      const rich = $(node).children('ac\\:rich-text-body').html() ?? '';
      const nested = storageToMarkdown(rich, { pageUrl, siteUrl, pageId, pageLinks, attachments, diagramProfile, preserve });
      replace(node, fenced(nested.markdown, 'confluence-' + name), true);
    } else {
      const macroId = $(node).attr('ac:macro-id');
      const url = param(node, 'url') || (macroId ? origin + '#macro-' + encodeURIComponent(macroId) : origin);
      replace(node, reference('Confluence: ' + name, url), true);
      warnings.push('Referenced unsupported macro: ' + name);
    }
  });
  $('ac\\:task').each((_i, node) => {
    const checked = $(node).children('ac\\:task-status').text() === 'complete';
    const content = td.turndown($(node).children('ac\\:task-body').html() ?? '').trim();
    replace(node, '- [' + (checked ? 'x' : ' ') + '] ' + content);
  });
  // Move existing children when unwrapping; reparsing resets raw-source offsets.
  $('ac\\:task-list').each((_i, node) => $(node).replaceWith($(node).contents()));
  $('ac\\:image').each((_i, node) => {
    const attachment = $(node).find('ri\\:attachment').attr('ri:filename');
    const remote = $(node).find('ri\\:url').attr('ri:value');
    const url = attachment ? (attachments[attachment] ?? siteUrl + '/download/attachments/' + pageId + '/' + encodeURIComponent(attachment)) : remote;
    const customImage = ['ac:width', 'ac:height', 'ac:thumbnail', 'ac:style', 'ac:border', 'ac:hspace', 'ac:vspace'].some((name) => $(node).attr(name) !== undefined) || $(node).find('ri\\:page').length > 0;
    if (url) replace(node, '!' + reference($(node).attr('ac:alt') ?? attachment ?? 'image', url), preserve === 'all' || customImage, false);
    else replace(node, reference('Confluence image'), true, false);
  });
  $('ac\\:link').each((_i, node) => {
    const page = $(node).find('ri\\:page');
    const id = page.attr('ri:content-id');
    const title = page.attr('ri:content-title');
    const space = page.attr('ri:space-key');
    const filename = $(node).find('ri\\:attachment').attr('ri:filename');
    const label = $(node).find('ac\\:plain-text-link-body, ac\\:link-body').text() || title || filename || 'Confluence reference';
    let target = origin;
    if (id) target = pageLinks[id] ?? siteUrl + '/pages/viewpage.action?pageId=' + encodeURIComponent(id);
    else if (title) target = pageLinks[title] ?? siteUrl + '/pages/viewpage.action?' + new URLSearchParams({ ...(space ? { spaceKey: space } : {}), title }).toString();
    else if (filename) target = attachments[filename] ?? siteUrl + '/download/attachments/' + pageId + '/' + encodeURIComponent(filename);
    const anchor = $(node).attr('ac:anchor');
    if (anchor) target += '#' + encodeURIComponent(anchor);
    replace(node, reference(label, target), preserve === 'all' || !(id || title || filename), false);
  });
  $('a[href]').each((_i, node) => {
    const href = $(node).attr('href');
    const id = href?.match(/(?:pageId=|\/pages\/)(\d+)/)?.[1];
    const sameSite = href && siteUrl && new URL(href, origin).origin === new URL(siteUrl).origin;
    if (id && sameSite && pageLinks[id]) $(node).attr('href', pageLinks[id]);
    else if (href && !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) $(node).attr('href', new URL(href, origin).href);
  });
  $('th, td').each((_i, node) => {
    const alignment = $(node).attr('style')?.match(/text-align:\s*(left|center|right)/)?.[1];
    if (alignment) $(node).attr('align', alignment);
  });
  $('sup.footnote-ref').each((_i, node) => {
    const href = $(node).find('a').attr('href') ?? '';
    replace(node, '[^' + decodeURIComponent(href.split('#fn')[1] ?? 'note') + ']', false, false);
  });
  $('li.footnote-item').each((_i, node) => {
    const backref = $(node).find('.footnote-backref').attr('href')?.split('#fnref')[1];
    const id = decodeURIComponent(($(node).attr('id') ?? '').replace(/^fn/, '') || backref || String(_i + 1));
    $(node).find('.footnote-backref').remove();
    replace(node, '[^' + id + ']: ' + td.turndown($(node).html() ?? '').trim().replaceAll('\n', '\n    '));
  });
  $('hr.footnotes-sep').remove();
  $('section.footnotes, ol.footnotes-list').each((_i, node) => $(node).replaceWith($(node).contents()));
  $('ac\\:layout, ac\\:layout-section, ac\\:layout-cell, ac\\:rich-text-body').each((_i, node) => $(node).replaceWith($(node).contents()));
  $('*').toArray().reverse().forEach((node) => {
    if (node.parent && /^(ac:|ri:)/.test(node.name)) replace(node, reference('Confluence: ' + node.name), true, false);
  });
  let markdown = td.turndown($.xml()).replace(/\n{3,}/g, '\n\n');
  // Expand protected snippets after Turndown so code whitespace stays exact.
  for (let i = 0; i <= snippets.length && /CFWIKISNIPPET\d+END/.test(markdown); i++) {
    markdown = markdown.replace(/CFWIKISNIPPET(\d+)END/g, (_match, index) => snippets[Number(index)] ?? '');
  }
  markdown = markdown.trim() + '\n';
  if (preserve === 'none' && preserved.length) warnings.push('Dropped preservation for ' + preserved.length + ' unsupported or customized element(s); their Markdown references or code remain, but native behavior may be lost.');
  return { markdown, preserved: preserve === 'none' ? [] : preserved, warnings };
}

export function reducePreservation(doc, { preserve = 'minimal', ...context } = {}) {
  preservationMode(preserve);
  if (preserve === 'all') return doc;
  let body = doc.body;
  const kept = [];
  const warnings = [...(doc.warnings ?? [])];
  for (const item of doc.metadata.confluence?.preserved ?? []) {
    if (!item.markdown || !body.includes(item.markdown)) continue;
    const engine = item.markdown.match(/^`{3,}(mermaid|uml|plantuml)\n/)?.[1];
    if (engine && context.diagramProfile?.[engine === 'uml' ? 'plantuml' : engine]) continue;
    const converted = storageToMarkdown(item.storage, { ...context, preserve: 'minimal' });
    if (!converted.preserved.length) {
      if (/^```confluence-toc\n/.test(converted.markdown)) body = body.replace(item.markdown, () => converted.markdown.trimEnd());
    } else if (preserve === 'minimal') kept.push(item);
    else warnings.push('Dropped a preserved Confluence element; its Markdown reference or code remains, but native behavior may be lost.');
  }
  const metadata = { ...doc.metadata, confluence: { ...doc.metadata.confluence } };
  if (kept.length) metadata.confluence.preserved = kept;
  else delete metadata.confluence.preserved;
  return { ...doc, metadata, body, warnings };
}
