import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseDocument as parseYaml } from 'yaml';
import { load } from 'cheerio';
import { defaultEnvPath } from './env.mjs';
import { diagramProfile } from './diagrams.mjs';

const defaultTemplate = {
  version: 1,
  toc: { enabled: true, position: 'top', parameters: { minLevel: '2', maxLevel: '3', outline: 'false' } },
};

function mapping(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + ' must be a mapping.');
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(name + ' contains unsupported fields.');
}

function parameters(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + ' must be a mapping of scalar values.');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (!key || !['string', 'number', 'boolean'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item))) throw new Error(name + ' must contain named string, number or boolean values.');
    return [key, String(item)];
  }));
}

export function parseTemplate(source) {
  if (Buffer.byteLength(source) > 65536) throw new Error('Template exceeds 64 KB.');
  const yaml = parseYaml(source, { uniqueKeys: true });
  if (yaml.errors.length) throw new Error('Invalid template YAML. Check syntax and duplicate keys.');
  const value = yaml.toJS({ maxAliasCount: 20 });
  mapping(value, ['version', 'toc', 'diagrams'], 'Template');
  if (value.version !== 1) throw new Error('Template version must be 1.');
  const result = { version: 1 };
  if (value.toc !== undefined) {
    mapping(value.toc, ['enabled', 'position', 'parameters'], 'toc');
    const { enabled = true, position = 'top' } = value.toc;
    if (typeof enabled !== 'boolean') throw new Error('toc.enabled must be true or false.');
    if (!['top', 'bottom'].includes(position)) throw new Error('toc.position must be top or bottom.');
    const params = parameters(value.toc.parameters ?? {}, 'toc.parameters');
    for (const key of ['minLevel', 'maxLevel']) if (params[key] !== undefined && !/^[1-6]$/.test(params[key])) throw new Error('toc.parameters.' + key + ' must be between 1 and 6.');
    if (Number(params.minLevel ?? 1) > Number(params.maxLevel ?? 6)) throw new Error('TOC minLevel must not exceed maxLevel.');
    result.toc = { enabled, position, parameters: params };
  }
  if (value.diagrams !== undefined) {
    mapping(value.diagrams, ['mode', 'mermaid', 'plantuml'], 'diagrams');
    result.diagrams = {};
    if (value.diagrams.mode !== undefined) {
      if (!['macro', 'code'].includes(value.diagrams.mode)) throw new Error('diagrams.mode must be macro or code.');
      result.diagrams.mode = value.diagrams.mode;
    }
    for (const engine of ['mermaid', 'plantuml']) {
      const entry = value.diagrams[engine];
      if (entry === undefined) continue;
      mapping(entry, ['macro', 'adapter', 'extension_key', 'source_parameter', 'title', 'parameters'], 'diagrams.' + engine);
      const normalized = {};
      for (const [key, item] of Object.entries(entry)) {
        if (key === 'parameters') normalized.parameters = parameters(item, 'diagrams.' + engine + '.parameters');
        else {
          if (typeof item !== 'string' || !item.trim()) throw new Error('diagrams.' + engine + '.' + key + ' must be a non-empty string.');
          normalized[key] = item;
        }
      }
      result.diagrams[engine] = normalized;
    }
  }
  return result;
}

export async function loadTemplate(selection, { env = {}, envFile = defaultEnvPath(), cwd = process.cwd() } = {}) {
  const chosen = selection ?? env.CONFLUENCE_TEMPLATE ?? 'none';
  if (chosen === 'none') return null;
  if (chosen === 'default') return { ...structuredClone(defaultTemplate), source: 'default' };
  if (typeof chosen !== 'string' || !chosen.trim()) throw new Error('Template must be default, none, or a YAML file path.');
  if (/^\d+$/.test(chosen) || chosen.startsWith('confluence:')) {
    const id = chosen.startsWith('confluence:') ? chosen.slice('confluence:'.length) : chosen;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/.test(id)) throw new Error('Invalid Confluence template ID.');
    return { kind: 'confluence', id, source: 'confluence:' + id };
  }
  const base = selection === undefined ? path.dirname(path.resolve(cwd, envFile)) : cwd;
  const filename = chosen.startsWith('~/') ? path.join(homedir(), chosen.slice(2)) : path.resolve(base, chosen);
  return { ...parseTemplate(await readFile(filename, 'utf8')), source: filename };
}

export function templateDiagrams(template, env = {}, mode) {
  const merged = { ...env };
  const fields = { macro: 'MACRO', adapter: 'ADAPTER', extension_key: 'FORGE_EXTENSION_KEY', source_parameter: 'SOURCE_PARAMETER', title: 'TITLE' };
  for (const engine of ['mermaid', 'plantuml']) {
    const entry = template?.diagrams?.[engine];
    if (!entry) continue;
    const prefix = 'CONFLUENCE_' + engine.toUpperCase() + '_';
    for (const [field, suffix] of Object.entries(fields)) if (entry[field] !== undefined) merged[prefix + suffix] = entry[field];
    if (entry.parameters !== undefined) {
      let existing;
      try { existing = JSON.parse(merged[prefix + 'PARAMETERS'] || '{}'); }
      catch { throw new Error(prefix + 'PARAMETERS must be valid JSON.'); }
      merged[prefix + 'PARAMETERS'] = JSON.stringify({ ...parameters(existing, prefix + 'PARAMETERS'), ...entry.parameters });
    }
  }
  diagramProfile(merged);
  const selected = mode ?? template?.diagrams?.mode ?? env.CONFLUENCE_DIAGRAM_MODE ?? 'macro';
  if (!['macro', 'code'].includes(selected)) throw new Error('Diagram mode must be macro or code.');
  return { env: merged, mode: selected };
}

export function applyTemplate(storage, template) {
  if (!template?.toc) return storage;
  const $ = load(storage, { xmlMode: true });
  $('ac\\:structured-macro, ac\\:macro').filter((_i, node) => node.attribs['ac:name'] === 'toc').remove();
  if (template.toc.enabled) {
    const toc = $('<ac:structured-macro ac:name="toc" ac:schema-version="1"></ac:structured-macro>');
    for (const [name, value] of Object.entries(template.toc.parameters)) toc.append($('<ac:parameter></ac:parameter>').attr('ac:name', name).text(value));
    if (template.toc.position === 'bottom') $.root().append(toc);
    else $.root().prepend(toc);
  }
  return $.xml().trim();
}
