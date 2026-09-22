import { randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import { storageToMarkdown } from './document.mjs';

export function instantiateTemplate(doc, native, config, space) {
  const targetSpace = space ?? doc.metadata.confluence?.space ?? config.spaceKey;
  if (native.space && targetSpace && native.space !== targetSpace) throw new Error('The Confluence template belongs to another space.');
  const $ = load(native.storage, { xmlMode: true });
  if ($('at\\:var, at\\:declarations, ac\\:variable').length) throw new Error('This template contains unresolved Confluence variables. Use a static template with a {{cfwiki.body}} paragraph.');
  if ($('ri\\:attachment').length) throw new Error('Template attachments cannot be copied through the template API. Use URL images or local images in the Markdown body.');
  const slots = $('p').filter((_i, node) => $(node).text().trim() === '{{cfwiki.body}}');
  if (slots.length > 1) throw new Error('A template may contain only one {{cfwiki.body}} paragraph.');
  if (slots.parents('table, blockquote, ac\\:structured-macro, ac\\:macro').length) throw new Error('The template body slot must be outside tables, blockquotes and macros.');
  if (!slots.length && native.storage.includes('{{cfwiki.body}}')) throw new Error('{{cfwiki.body}} must be a standalone paragraph in the template.');
  const marker = 'CFWIKIBODY' + randomUUID().replaceAll('-', '') + 'END';
  if (slots.length) slots.first().text(marker);
  else $.root().append($('<p></p>').text(marker));
  const converted = storageToMarkdown($.xml(), { pageUrl: (config.templateApiUrl ?? config.v1Url) + '/template/' + encodeURIComponent(native.id), siteUrl: config.webBase, diagramProfile: config.diagramProfile, preserve: config.preserve ?? 'minimal' });
  if (converted.markdown.split(marker).length !== 2 || converted.preserved.some((item) => item.markdown.includes(marker))) throw new Error('The template body slot is inside a structure that cannot be edited as Markdown. Move it to a standalone paragraph outside macros.');
  const body = converted.markdown.replace(marker, () => doc.body);
  const preserved = [...converted.preserved, ...(doc.metadata.confluence?.preserved ?? [])];
  const metadata = { ...doc.metadata, confluence: { ...doc.metadata.confluence, template_id: native.id, ...(native.space ? { space: native.space } : {}), ...(doc.metadata.confluence?.labels === undefined && native.labels.length ? { labels: native.labels } : {}) } };
  if (preserved.length) metadata.confluence.preserved = preserved;
  else delete metadata.confluence.preserved;
  return { metadata, body, warnings: converted.warnings };
}

export async function prepareNativeTemplate(api, doc, template, { id, space } = {}) {
  if (template?.kind !== 'confluence' || id || doc.metadata.confluence?.id) return doc;
  const previous = doc.metadata.confluence?.template_id;
  if (previous !== undefined) {
    if (String(previous) !== template.id) throw new Error('The draft already uses a different Confluence template. Start a new draft instead of nesting templates.');
    return doc;
  }
  return instantiateTemplate(doc, await api.getTemplate(template.id), api.config, space);
}
