import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { forgeStorage } from './forge.mjs';

const engines = { mermaid: 'mermaid', uml: 'plantuml', plantuml: 'plantuml' };
const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const cdata = (value) => '<![CDATA[' + value.replaceAll(']]>', ']]]]><![CDATA[>') + ']]>';
export const diagramKey = (language, code) => createHash('sha256').update(language.toLowerCase() + '\0' + code).digest('hex');
export const diagramSource = (block) => block.engine === 'plantuml' && !/^\s*@start\w+/m.test(block.code) ? '@startuml\n' + block.code + '\n@enduml\n' : block.code;

export function diagramBlocks(markdown, lineOffset = 0) {
  return new MarkdownIt().use(footnote).parse(markdown, {}).filter((token) => token.type === 'fence' && Object.hasOwn(engines, token.info.trim().split(/\s+/)[0].toLowerCase())).map((token) => {
    const language = token.info.trim().split(/\s+/)[0].toLowerCase();
    return { language, engine: engines[language], code: token.content, line: (token.map?.[0] ?? 0) + lineOffset + 1, key: diagramKey(language, token.content) };
  });
}

export function diagramProfile(env = {}) {
  const profile = {};
  for (const engine of ['mermaid', 'plantuml']) {
    const prefix = 'CONFLUENCE_' + engine.toUpperCase();
    const name = env[prefix + '_MACRO'];
    if (!name) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(name)) throw new Error(prefix + '_MACRO is not a valid macro name.');
    let parameters = {};
    try { parameters = JSON.parse(env[prefix + '_PARAMETERS'] || '{}'); } catch { throw new Error(prefix + '_PARAMETERS must be a JSON object of strings.'); }
    if (!parameters || Array.isArray(parameters) || typeof parameters !== 'object' || Object.entries(parameters).some(([key, value]) => !key || typeof value !== 'string')) throw new Error(prefix + '_PARAMETERS must be a JSON object of strings.');
    const extensionKey = env[prefix + '_FORGE_EXTENSION_KEY'];
    const sourceParameter = env[prefix + '_SOURCE_PARAMETER'] || null;
    const adapter = env[prefix + '_ADAPTER'] || (extensionKey ? 'forge' : 'storage');
    if (!['storage', 'forge', 'mermaid-viewer'].includes(adapter)) throw new Error(prefix + '_ADAPTER must be storage, forge or mermaid-viewer.');
    if (adapter !== 'storage' && !extensionKey) throw new Error(prefix + '_FORGE_EXTENSION_KEY is required for this adapter.');
    if (adapter === 'mermaid-viewer' && engine !== 'mermaid') throw new Error('The mermaid-viewer adapter only supports Mermaid.');
    if (extensionKey && !/^[a-f0-9-]{36}\/[a-f0-9-]{36}\/static\/[a-zA-Z0-9_-]+$/.test(extensionKey)) throw new Error(prefix + '_FORGE_EXTENSION_KEY must identify an installed Forge extension.');
    if (adapter === 'forge' && !sourceParameter) throw new Error(prefix + '_SOURCE_PARAMETER is required for a Forge diagram app.');
    if (adapter === 'storage' && extensionKey) throw new Error('A Forge extension key cannot use the storage adapter.');
    profile[engine] = { name, sourceParameter, parameters, adapter, ...(extensionKey ? { extensionKey, title: env[prefix + '_TITLE'] || name } : {}) };
  }
  return profile;
}

export function macroStorage(block, profile) {
  const entry = profile[block.engine];
  if (!entry) throw new Error('Markdown line ' + block.line + ': configure CONFLUENCE_' + block.engine.toUpperCase() + '_MACRO for the installed Confluence app. No page was written.');
  const parameters = { ...entry.parameters };
  const source = diagramSource(block);
  if (entry.extensionKey) return forgeStorage(entry, source);
  if (entry.sourceParameter) parameters[entry.sourceParameter] = source;
  const params = Object.entries(parameters).map(([name, value]) => '<ac:parameter ac:name="' + xml(name) + '">' + xml(value) + '</ac:parameter>').join('');
  return '<ac:structured-macro ac:name="' + xml(entry.name) + '" ac:schema-version="1">' + params + (entry.sourceParameter ? '' : '<ac:plain-text-body>' + cdata(source) + '</ac:plain-text-body>') + '</ac:structured-macro>';
}

export async function validateDiagramBlocks(blocks, env = {}) {
  if (!blocks.length) return [];
  if (blocks.length > 100) throw new Error('A document can contain at most 100 diagram blocks.');
  for (const block of blocks) {
    if (!block.code.trim()) throw new Error('Markdown line ' + block.line + ': diagram is empty.');
    if (Buffer.byteLength(block.code) > 50000) throw new Error('Markdown line ' + block.line + ': diagram exceeds 50 KB.');
  }
  const worker = fileURLToPath(new URL('./diagram-worker.mjs', import.meta.url));
  const runtimeEnv = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker], { env: runtimeEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errorOutput = ''; let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, Math.min(300000, 30000 + blocks.length * 10000));
    child.stdout.on('data', (chunk) => { output += chunk; if (output.length > 100000) child.kill('SIGTERM'); });
    child.stderr.on('data', (chunk) => { if (errorOutput.length < 4000) errorOutput += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      if (expired) { reject(new Error('Diagram validation timed out. No page was written.')); return; }
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.error) reject(new Error(result.error || 'Diagram validation failed.'));
        else resolve(result.checks);
      } catch { reject(new Error('Diagram validator could not start. Check Node, Chrome and PlantUML installation. ' + errorOutput.slice(0, 500))); }
    });
    child.stdin.end(JSON.stringify({ blocks, chromePath: env.CFWIKI_CHROME_PATH || env.PUPPETEER_EXECUTABLE_PATH, plantumlPath: env.CFWIKI_PLANTUML_PATH || 'plantuml' }));
  });
}

export async function prepareDiagrams(markdown, { env = {}, lineOffset = 0, requireMacros = false, mode = 'macro', validator = validateDiagramBlocks } = {}) {
  if (!['macro', 'code'].includes(mode)) throw new Error('--diagrams must be macro or code.');
  const blocks = mode === 'code' ? [] : diagramBlocks(markdown, lineOffset);
  const checks = await validator(blocks, env);
  const profile = diagramProfile(env);
  const macros = Object.fromEntries(requireMacros ? blocks.map((block) => [block.key, macroStorage(block, profile)]) : []);
  return { blocks, checks, profile, macros };
}

export function withoutDiagramPreservation(preserved = [], enabled = false) {
  return enabled ? preserved.filter((item) => !diagramBlocks(item.markdown).length) : preserved;
}
