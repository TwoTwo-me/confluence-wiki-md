import { parseDocument as parseYaml } from 'yaml';

export const richMacros = new Set(['info', 'note', 'tip', 'warning', 'panel', 'expand', 'quote']);

export function richMacroName(info) {
  const language = info.trim().split(/\s+/)[0];
  const name = language.startsWith('confluence-') ? language.slice(11) : '';
  return richMacros.has(name) ? name : null;
}

export function richMacroBody(source) {
  if (!source.startsWith('---\n')) return { parameters: {}, body: source, bodyLineOffset: 0 };
  const closing = /^---[\t ]*$/m.exec(source.slice(4));
  if (!closing) throw new Error('Unterminated Confluence macro parameter header.');
  const header = source.slice(4, 4 + closing.index);
  if (Buffer.byteLength(header) > 65536) throw new Error('Confluence macro parameters exceed 64 KiB.');
  const yaml = parseYaml(header, { uniqueKeys: true });
  if (yaml.errors.length) throw new Error('Invalid Confluence macro parameters: ' + yaml.errors[0].message.split('\n')[0]);
  const parameters = yaml.toJS({ maxAliasCount: 20 }) ?? {};
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || Object.entries(parameters).some(([key, value]) => !key || !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))) throw new Error('Confluence macro parameters must be a YAML mapping of scalar values.');
  const body = source.slice(4 + closing.index + closing[0].length).replace(/^\n/, '');
  return { parameters, body, bodyLineOffset: source.slice(0, source.length - body.length).split('\n').length - 1 };
}
