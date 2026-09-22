import { parseArgs } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { ConfluenceApi, readWikiConfig } from './api.mjs';
import { parseDocument, formatDocument, markdownToStorage, storageToMarkdown, reducePreservation, preservationMode, bodyStatus } from './document.mjs';
import { download, upload, saveFile, exportBundle, pushBundle, searchLocal } from './wiki.mjs';
import { prepareDiagrams, diagramProfile, withoutDiagramPreservation } from './diagrams.mjs';
import { defaultEnvPath, loadProfile } from './env.mjs';
import { loadTemplate, templateDiagrams, applyTemplate } from './templates.mjs';
import { instantiateTemplate, prepareNativeTemplate } from './native-templates.mjs';

export const help = `Usage: cfwiki <command> [arguments] [options]

  doctor                          Verify the selected API profile and space
  read ID                         Return an OKF Markdown document on stdout
  download ID [-o FILE.md]         Same as read; --output saves a Markdown file
  status FILE.md|-                Check local body edits against its saved hash; no API call
  upload FILE.md                  Create or version-check and update a page
  upload - --title TITLE          Read Markdown from stdin; return saved Markdown
  search QUERY                    Search Confluence; return a Markdown index
  search QUERY --local DIRECTORY  Search downloaded Markdown without an API call
  list [--space KEY]              List pages as a Markdown index
  export DIRECTORY               Download a space as an OKF bundle with index.md
  push DIRECTORY                 Publish a bundle and resolve local .md links
  templates list [--space KEY]    List native Confluence template IDs (--blueprints optional)
  templates read ID               Read a native template as Markdown; --to storage for XML
  delete ID|FILE.md --yes         Move a page to trash; requires its --version
  attachments list ID             List page attachments
  attachments upload ID FILE      Upload an explicit attachment file
  attachments download ID ATT_ID -o FILE  Download one attachment
  convert FILE --to storage|markdown      Convert locally; native template lookup needs --server
  validate FILE.md                Validate YAML, Markdown and diagram syntax locally
  smoke                           Run the original Cloud API connection check

Options:
  --env FILE        Select a profile instead of ~/.config/cfwiki/.env
                    XDG_CONFIG_HOME, when absolute, replaces ~/.config
  --output, -o     Save output instead of printing it; refuses to overwrite
  --overwrite      Explicitly replace an existing output file
  --json           Return structured JSON instead of Markdown
  --body-only      Omit front matter on read/download
  --preserve MODE  minimal (default): retain only non-reconstructible native XML;
                   all: keep original fragments; none: drop all preserved XML
                   Defaults to CONFLUENCE_PRESERVE when configured
  --version N      Historical version to read, or expected version for writes
  --id ID          Target page for upload (must match front matter if present)
  --title TITLE    Page title for upload
  --space KEY      Target space; defaults to front matter or environment
  --parent ID      Parent for upload/push, or direct children for list/export
  --root DIRECTORY Resolve local Markdown links within this bundle root
  --assets         Download attachments alongside --output Markdown
  --dry-run        Validate and preview a single upload without writing
  --template ID|NAME|FILE  Confluence template ID, default, none, or YAML file
                         Prefix non-numeric IDs with confluence:
                       Defaults to CONFLUENCE_TEMPLATE in the selected profile
  --diagrams MODE  Override template/CONFLUENCE_DIAGRAM_MODE (fallback: macro)
                   macro: validate and publish native diagram macros;
                   code: deliberately keep diagrams as ordinary code blocks
  --server         Enable remote template lookup and macro preview for validate/convert
  --cql EXPRESSION Use an explicit CQL search expression
  --limit N        Maximum list/search/export results (default: 1000 / 50)
  --yes            Required acknowledgement for moving a page to trash
  --help, -h       Show this help

Update files keep their page ID and version in YAML. Upload writes the new
identity/version back to the source file. Stale versions are never overwritten.
Use npm run -s confluence -- ... for clean Markdown stdout.
`;

const escapeLabel = (value) => String(value).replace(/[\[\]\r\n]/g, ' ');
const indexMarkdown = (title, rows) => '# ' + title + '\n\n' + rows.map((row) => '- [' + escapeLabel(row.title ?? row.name ?? row.id) + '](' + String(row.url ?? '').replaceAll(' ', '%20') + ') · ID: `' + row.id + '`' + (row.version ? ' · version: `' + (row.version.number ?? row.version) + '`' : '') + (row.excerpt ? '\n  ' + row.excerpt.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ') : '')).join('\n') + '\n';

async function readInput(filename) {
  if (filename !== '-') return readFile(filename, 'utf8');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function runCli(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, output: { type: 'string', short: 'o' }, env: { type: 'string' }, json: { type: 'boolean' }, overwrite: { type: 'boolean' }, 'body-only': { type: 'boolean' }, assets: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' }, version: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' }, space: { type: 'string' }, parent: { type: 'string' }, root: { type: 'string' }, cql: { type: 'string' }, local: { type: 'string' }, limit: { type: 'string' }, to: { type: 'string' }, diagrams: { type: 'string' }, server: { type: 'boolean' }, template: { type: 'string' }, blueprints: { type: 'boolean' }, preserve: { type: 'string' },
  } });
  const [command, target, extra] = positionals;
  if (!command || values.help) { process.stdout.write(help); return; }
  if (!['doctor', 'read', 'download', 'status', 'upload', 'search', 'list', 'export', 'push', 'delete', 'attachments', 'templates', 'convert', 'validate'].includes(command)) throw new Error('Unknown command. Use --help.');
  const templateCommands = ['read', 'download', 'upload', 'export', 'push', 'convert', 'validate'];
  if (values.template !== undefined && !templateCommands.includes(command)) throw new Error('--template is supported by read, download, upload, export, push, convert and validate.');
  if (values.preserve !== undefined && ![...templateCommands, 'templates'].includes(command)) throw new Error('--preserve is supported by document and template commands only.');
  const numeric = (value, name) => { if (value === undefined) return undefined; const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new Error(name + ' must be a positive integer.'); return number; };
  const version = numeric(values.version, '--version');
  const limit = numeric(values.limit, '--limit');
  for (const key of ['id', 'parent']) if (values[key] && !/^\d+$/.test(values[key])) throw new Error('--' + key + ' must be numeric.');
  if (!['doctor', 'list'].includes(command) && !target) throw new Error(command + ' requires an argument.');
  if (!['attachments', 'templates'].includes(command) && positionals.length > 2) throw new Error('Unexpected extra arguments. Quote search queries containing spaces.');
  const emit = async (text, object) => {
    const content = values.json ? JSON.stringify(object, null, 2) + '\n' : text;
    if (values.output) { await saveFile(values.output, content, { overwrite: values.overwrite }); process.stderr.write('Saved ' + values.output + '\n'); }
    else process.stdout.write(content);
  };
  if (command === 'status') {
    if (target !== '-' && !/\.md$/i.test(target)) throw new Error('status expects a .md file or - for stdin.');
    if (values.output) throw new Error('status reports to stdout and does not write files.');
    const doc = parseDocument(await readInput(target));
    const state = { file: target === '-' ? null : path.resolve(target), id: doc.metadata.confluence?.id ?? null, version: doc.metadata.confluence?.version ?? null, ...bodyStatus(doc) };
    await emit('# Local body status\n\n- Body: ' + state.bodyStatus + '\n- Base hash: ' + (state.baseBodyHash ?? 'missing') + '\n- Current hash: ' + state.currentBodyHash + '\n\nChecks Markdown body only; excludes YAML and remote changes.\n', state);
    return;
  }
  const env = await loadProfile(values.env);
  env.CONFLUENCE_PRESERVE = preservationMode(values.preserve ?? env.CONFLUENCE_PRESERVE);
  const template = templateCommands.includes(command) ? await loadTemplate(values.template, { env, envFile: values.env ?? defaultEnvPath() }) : null;
  const selected = templateCommands.includes(command) ? templateDiagrams(template, env, values.diagrams) : { env, mode: values.diagrams };
  if (['convert', 'validate'].includes(command)) {
    const source = await readInput(target);
    const withNativeTemplate = async (doc) => {
      doc = reducePreservation(doc, { preserve: env.CONFLUENCE_PRESERVE, diagramProfile: diagramProfile(selected.env) });
      if (template?.kind !== 'confluence' || doc.metadata.confluence?.id) return doc;
      if (doc.metadata.confluence?.template_id) {
        if (doc.metadata.confluence.template_id !== template.id) throw new Error('The draft already uses a different Confluence template.');
        return doc;
      }
      if (!values.server) throw new Error('A Confluence template ID requires an API lookup. Add --server or use --template none for local-only conversion/validation.');
      return prepareNativeTemplate(new ConfluenceApi(readWikiConfig(selected.env)), doc, template, { space: values.space });
    };
    if (command === 'validate') {
      const doc = await withNativeTemplate(parseDocument(source));
      const lineOffset = template?.kind === 'confluence' ? 0 : source.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').slice(0, -doc.body.length).split('\n').length - 1;
      const prepared = await prepareDiagrams(doc.body, { ...selected, lineOffset, requireMacros: values.server });
      const result = markdownToStorage(doc.body, { preserved: withoutDiagramPreservation(doc.metadata.confluence?.preserved, prepared.blocks.length > 0 || selected.mode === 'code'), diagrams: prepared.macros, flattenNestedQuotes: selected.env.CONFLUENCE_DEPLOYMENT !== 'datacenter' });
      for (const warning of [...(doc.warnings ?? []), ...result.warnings]) process.stderr.write('Note: ' + warning + '\n');
      result.storage = applyTemplate(result.storage, template);
      const serverPreview = values.server && (prepared.blocks.length || template?.toc || template?.kind === 'confluence' || result.storage.includes('ac:name="toc"')) ? await new ConfluenceApi(readWikiConfig(selected.env)).previewStorage(result.storage, { pageId: doc.metadata.confluence?.id, space: values.space ?? doc.metadata.confluence?.space ?? env.CONFLUENCE_SPACE_KEY }) : null;
      await emit('# Valid Markdown\n\n- OKF type: ' + doc.metadata.type + '\n- Template: ' + (template?.source ?? 'none') + '\n- Storage bytes: ' + Buffer.byteLength(result.storage) + '\n- Diagram syntax checks: ' + prepared.checks.length + '\n' + prepared.checks.map((check) => '  - ' + check.engine + ' ' + check.version + ' · Markdown line ' + check.line + '\n').join('') + (serverPreview ? '- Confluence preview: accepted' + (serverPreview.dynamic ? ' (dynamic app output still requires browser verification)' : '') + '\n' : ''), { valid: true, type: doc.metadata.type, storageBytes: Buffer.byteLength(result.storage), diagrams: prepared.checks, serverPreview, template: template?.source ?? 'none' });
    } else if (values.to === 'storage') {
      const doc = await withNativeTemplate(parseDocument(source));
      const prepared = await prepareDiagrams(doc.body, { ...selected, requireMacros: true });
      const result = markdownToStorage(doc.body, { preserved: withoutDiagramPreservation(doc.metadata.confluence?.preserved, prepared.blocks.length > 0 || selected.mode === 'code'), diagrams: prepared.macros, flattenNestedQuotes: selected.env.CONFLUENCE_DEPLOYMENT !== 'datacenter' });
      for (const warning of [...(doc.warnings ?? []), ...result.warnings]) process.stderr.write('Note: ' + warning + '\n');
      result.storage = applyTemplate(result.storage, template);
      result.template = template?.source ?? 'none';
      if (values.server) result.serverPreview = await new ConfluenceApi(readWikiConfig(selected.env)).previewStorage(result.storage, { pageId: doc.metadata.confluence?.id, space: values.space ?? doc.metadata.confluence?.space ?? env.CONFLUENCE_SPACE_KEY });
      await emit(result.storage + '\n', result);
    } else if (values.to === 'markdown') {
      const result = storageToMarkdown(source, { pageUrl: 'https://example.invalid/source', siteUrl: 'https://example.invalid', pageId: '0', diagramProfile: diagramProfile(selected.env), preserve: env.CONFLUENCE_PRESERVE });
      const doc = { metadata: { type: 'Reference', ...(result.preserved.length ? { confluence: { preserved: result.preserved } } : {}) }, body: result.markdown };
      await emit(formatDocument(doc), doc);
      for (const warning of result.warnings) process.stderr.write('Note: ' + warning + '\n');
    } else throw new Error('convert requires --to storage or --to markdown.');
    return;
  }
  if (command === 'search' && values.local) { const rows = await searchLocal(values.local, target); await emit(indexMarkdown('Local wiki search', rows), rows); return; }
  const api = new ConfluenceApi(readWikiConfig(selected.env));
  switch (command) {
    case 'templates': {
      if (target === 'list' && positionals.length === 2) {
        const rows = await api.listTemplates({ space: values.space, blueprint: values.blueprints, limit });
        const cell = (value) => String(value ?? '').replace(/[|\r\n]/g, ' ');
        await emit('# Confluence templates\n\n| ID | Name | Space | Type |\n| --- | --- | --- | --- |\n' + rows.map((row) => '| ' + [row.id, row.name, row.space ?? 'global', row.type].map(cell).join(' | ') + ' |').join('\n') + '\n', rows);
      } else if (target === 'read' && extra && positionals.length === 3) {
        const native = await api.getTemplate(extra);
        if (values.to === 'storage') { await emit(native.storage + '\n', native); break; }
        if (values.to !== undefined && values.to !== 'markdown') throw new Error('templates read --to must be markdown or storage.');
        const doc = instantiateTemplate({ metadata: { type: 'Reference', title: native.name, confluence: { api_url: api.config.apiUrl, site_url: api.config.siteUrl } }, body: '' }, native, api.config, native.space);
        await emit(values['body-only'] ? doc.body : formatDocument(doc), doc);
        for (const warning of doc.warnings) process.stderr.write('Note: ' + warning + '\n');
      } else throw new Error('Use templates list [--space KEY] or templates read ID.');
      break;
    }
    case 'doctor': {
      const space = await api.getSpace(values.space);
      const result = { authenticated: true, deployment: api.config.deployment, auth: api.config.auth, api_url: api.config.apiUrl, space: { id: String(space.id), key: space.key, name: space.name } };
      await emit('# Connection verified\n\n- Deployment: ' + result.deployment + '\n- Authentication: ' + result.auth + '\n- Space: ' + space.name + ' (' + space.key + ')\n', result);
      break;
    }
    case 'read':
    case 'download': {
      if (!/^\d+$/.test(target)) throw new Error('Page ID must be numeric.');
      if (values.assets && !values.output) throw new Error('--assets requires --output FILE.md.');
      if (values.output && !values.overwrite) {
        try { await access(values.output); throw new Error('Output already exists. Use --overwrite explicitly.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const folder = values.output ? path.basename(values.output, path.extname(values.output)) + '-assets' : null;
      const doc = await download(api, target, { version, overwrite: values.overwrite, ...(values.assets ? { assetsDir: path.join(path.dirname(values.output), folder), assetPrefix: './' + folder } : {}) });
      await emit(values['body-only'] ? doc.body : formatDocument(doc), doc);
      for (const warning of doc.warnings) process.stderr.write('Note: ' + warning + '\n');
      break;
    }
    case 'upload': {
      if (target !== '-' && !/\.md$/i.test(target)) throw new Error('upload expects a .md file or - for stdin.');
      const filename = target === '-' ? undefined : path.resolve(target);
      const doc = await upload(api, await readInput(target), { filename, title: values.title, id: values.id, version, space: values.space, parent: values.parent, root: values.root ? path.resolve(values.root) : undefined, dryRun: values['dry-run'], template, diagrams: selected.mode, diagramEnv: selected.env, onWrite: filename ? (saved) => saveFile(filename, formatDocument(saved), { overwrite: true }) : undefined });
      await emit(values['dry-run'] ? '# Upload preview\n\n' + '```json\n' + JSON.stringify(doc, null, 2) + '\n```\n' : formatDocument(doc), doc);
      for (const warning of doc.warnings ?? []) process.stderr.write('Note: ' + warning + '\n');
      break;
    }
    case 'search': { const rows = await api.search(target, { space: values.space, cql: values.cql, limit }); await emit(indexMarkdown('Confluence search', rows), rows); break; }
    case 'list': { const rows = (await api.listPages({ space: values.space, parent: values.parent, limit })).map((page) => ({ ...page, url: api.pageUrl(page.id) })); await emit(indexMarkdown('Confluence pages', rows), rows); break; }
    case 'export': { const result = await exportBundle(api, target, { space: values.space, parent: values.parent, limit, overwrite: values.overwrite }); await emit('# Exported OKF bundle\n\n- Pages: ' + result.pages + '\n- Index: ' + result.index + '\n', result); break; }
    case 'push': { const result = await pushBundle(api, path.resolve(target), { space: values.space, parent: values.parent, template, diagrams: selected.mode, diagramEnv: selected.env }); await emit(indexMarkdown('Published bundle', result.map((item) => ({ ...item, title: item.file, url: api.pageUrl(item.id) }))), result); break; }
    case 'delete': {
      if (!values.yes) throw new Error('delete requires --yes and an expected version. It moves the page to trash, without purging it.');
      let id = target;
      let expected = version;
      if (/\.md$/i.test(target)) {
        const doc = parseDocument(await readFile(target, 'utf8'));
        if (doc.metadata.confluence?.api_url !== api.config.apiUrl) throw new Error('File API URL does not match the active profile.');
        id = doc.metadata.confluence?.id;
        expected = version ?? doc.metadata.confluence?.version;
      }
      if (!expected) throw new Error('delete requires --version or a downloaded .md file containing a version.');
      const page = await api.getPage(id);
      if (page.status !== 'current') throw new Error('Only current published pages can be moved to trash.');
      if (page.version !== expected) throw new Error('Version conflict. Refusing to delete a changed page.');
      await api.deletePage(id);
      await emit('# Page moved to trash\n\n- ID: ' + id + '\n', { id, deleted: true, purged: false });
      break;
    }
    case 'attachments': {
      if (!/^\d+$/.test(extra ?? '')) throw new Error('attachments requires list|upload|download followed by a page ID.');
      const argument = positionals[3];
      if (target === 'list') {
        const rows = await api.attachments(extra);
        await emit(indexMarkdown('Attachments', rows.map((item) => ({ ...item, url: api.pageUrl(extra) }))), rows);
      } else if (target === 'upload' && argument) {
        const result = await api.uploadAttachment(extra, path.basename(argument), await readFile(argument));
        await emit('# Attachment uploaded\n\n- File: ' + path.basename(argument) + '\n', result);
      } else if (target === 'download' && argument && values.output) {
        const attachment = (await api.attachments(extra)).find((item) => String(item.id).replace(/^att/, '') === argument.replace(/^att/, ''));
        if (!attachment) throw new Error('Attachment was not found on this page.');
        await saveFile(values.output, await api.downloadAttachment(extra, attachment), { overwrite: values.overwrite });
        process.stderr.write('Saved ' + values.output + '\n');
      } else throw new Error('Invalid attachments command. Use --help.');
      break;
    }
  }
}
