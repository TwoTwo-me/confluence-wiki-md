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
import { readEvidence, readStorageSnapshot } from './evidence.mjs';
import { extractStorageLinks } from './storage-links.mjs';
import { applyAgentEdit } from './agent-edit.mjs';
import { initWiki, WIKI_ROOT_PROPERTY } from './wiki-init.mjs';
import { createTerm, readTerm, trashTerm } from './wiki-term.mjs';
import { explore } from './explore.mjs';

export const help = `Usage: cfwiki <command> [arguments] [options]

  doctor                          Verify the selected API profile and space
  init --space KEY --topic TOPIC [--existing-root ID]
                                  Create or verify a topical wiki root
  create TERM --wiki-root ID --space KEY --content FILE.md
                                  Create a DefinedTerm page under a verified root
                                  Repeat --related ID and --source-url URL to add links
  explore QUESTION --wiki-root ID --space KEY --json
                                  Gather bounded, sourced evidence in one space
  read ID                         Return an OKF Markdown document on stdout
  read ID --wiki-root ID --space KEY
                                  Read a verified root child
  download ID [-o FILE.md]         Same as read; --output saves a Markdown file
  status FILE.md|-                Check local body edits against its saved hash; no API call
  apply DRAFT.md --base BASE.md --space KEY  Safely apply an edit to an existing page
  apply DRAFT.md --base BASE.md --wiki-root ID
                                  Also require root-child membership
  upload FILE.md                  Create or version-check and update a page
  upload - --title TITLE          Read Markdown from stdin; return saved Markdown
  search QUERY                    Search Confluence; return a Markdown index
  lookup QUERY --space KEY         Find scoped candidate pages without reading their bodies
  read ID --space KEY --json       Read verified live storage evidence for one page
  search QUERY --local DIRECTORY  Search downloaded Markdown without an API call
  list [--space KEY]              List pages as a Markdown index
  export DIRECTORY               Download a space as an OKF bundle with index.md
  push DIRECTORY                 Publish a bundle and resolve local .md links
  templates list [--space KEY]    List native Confluence template IDs (--blueprints optional)
  templates read ID               Read a native template as Markdown; --to storage for XML
  delete ID|FILE.md --yes --version N
                                  Move a page to trash after a version preflight
  delete ID --wiki-root ID --space KEY --yes --version N
                                  Trash a verified term child, never its root
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
  --wiki-root ID   Verified topical root for term reads/writes and exploration seed
  --existing-root ID  Verify and reuse an existing topical root
  --topic TOPIC    Topic name used by init
  --content FILE   Markdown body for create
  --related ID     Verify and link a current same-space page on create; repeatable
  --source-url URL Add an unfetched HTTP(S) source on create; repeatable
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
  --limit N        Maximum list/search/export results (lookup default: 10)
  --yes            Required acknowledgement for moving a page to trash
  --help, -h       Show this help

Update files keep their page ID and version in YAML. Upload writes the new
identity/version back to the source file. Stale versions are never overwritten.
Use npm run -s confluence -- ... for clean Markdown stdout.
`;

const escapeLabel = (value) => String(value).replace(/[\[\]\r\n]/g, ' ');
const indexMarkdown = (title, rows) => '# ' + title + '\n\n' + rows.map((row) => '- [' + escapeLabel(row.title ?? row.name ?? row.id) + '](' + String(row.url ?? '').replaceAll(' ', '%20') + ') · ID: `' + row.id + '`' + (row.version ? ' · version: `' + (row.version.number ?? row.version) + '`' : '') + (row.excerpt ? '\n  ' + row.excerpt.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ') : '')).join('\n') + '\n';

function redactOutput(value, api) {
  const secrets = [
    api.config.token,
    api.config.email,
    api.config.auth === 'bearer' ? 'Bearer ' + api.config.token : undefined,
    api.config.email ? 'Basic ' + Buffer.from(api.config.email + ':' + api.config.token).toString('base64') : undefined,
  ].filter(Boolean);
  const redact = (item) => {
    if (typeof item === 'string') return secrets.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), item);
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, redact(child)]));
    return item;
  };
  return redact(value);
}

async function readInput(filename) {
  if (filename !== '-') return readFile(filename, 'utf8');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function runCli(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, output: { type: 'string', short: 'o' }, env: { type: 'string' }, json: { type: 'boolean' }, overwrite: { type: 'boolean' }, 'body-only': { type: 'boolean' }, assets: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' }, version: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' }, space: { type: 'string' }, parent: { type: 'string' }, base: { type: 'string' }, root: { type: 'string' }, 'wiki-root': { type: 'string' }, 'existing-root': { type: 'string' }, topic: { type: 'string' }, content: { type: 'string' }, related: { type: 'string', multiple: true }, 'source-url': { type: 'string', multiple: true }, cql: { type: 'string' }, local: { type: 'string' }, limit: { type: 'string' }, to: { type: 'string' }, diagrams: { type: 'string' }, server: { type: 'boolean' }, template: { type: 'string' }, blueprints: { type: 'boolean' }, preserve: { type: 'string' },
  } });
  const [command, target, extra] = positionals;
  if (!command || values.help) { process.stdout.write(help); return; }
  if (!['doctor', 'init', 'create', 'explore', 'read', 'download', 'status', 'upload', 'search', 'lookup', 'apply', 'list', 'export', 'push', 'delete', 'attachments', 'templates', 'convert', 'validate'].includes(command)) throw new Error('Unknown command. Use --help.');
  const templateCommands = ['read', 'download', 'upload', 'export', 'push', 'convert', 'validate'];
  if (values.template !== undefined && !templateCommands.includes(command)) throw new Error('--template is supported by read, download, upload, export, push, convert and validate.');
  if (values.preserve !== undefined && ![...templateCommands, 'templates'].includes(command)) throw new Error('--preserve is supported by document and template commands only.');
  const numeric = (value, name) => { if (value === undefined) return undefined; const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new Error(name + ' must be a positive integer.'); return number; };
  const version = numeric(values.version, '--version');
  const limit = numeric(values.limit, '--limit');
  if (command === 'lookup') {
    if (!values.space?.trim()) throw new Error('lookup requires an explicit --space KEY.');
    if (values.cql !== undefined || values.local !== undefined) throw new Error('lookup does not accept --cql or --local.');
  }
  const rootScopedCommands = ['create', 'explore'];
  if (values['wiki-root'] !== undefined && ![...rootScopedCommands, 'read', 'apply', 'delete'].includes(command)) {
    throw new Error('--wiki-root is supported by create, explore, read, apply and delete only.');
  }
  if (values.topic !== undefined && command !== 'init') throw new Error('--topic is supported by init only.');
  if (values['existing-root'] !== undefined && command !== 'init') throw new Error('--existing-root is supported by init only.');
  if (values.content !== undefined && command !== 'create') throw new Error('--content is supported by create only.');
  if ((values.related !== undefined || values['source-url'] !== undefined) && command !== 'create') {
    throw new Error('--related and --source-url are supported by create only.');
  }
  if (command === 'init') {
    if (positionals.length !== 1) throw new Error('init takes no positional arguments.');
    if (!values.space?.trim() || !values.topic?.trim()) throw new Error('init requires --space KEY and --topic TOPIC.');
    if (values.cql !== undefined || values.local !== undefined || values['wiki-root'] !== undefined || values.content !== undefined ||
        values.id !== undefined || values.version !== undefined || values.parent !== undefined || values.root !== undefined || values.overwrite) {
      throw new Error('init received an incompatible option.');
    }
    if (values['existing-root'] !== undefined && !/^\d+$/.test(values['existing-root'])) throw new Error('--existing-root must be numeric.');
    if (values.output) throw new Error('init reports to stdout and does not write output files.');
  }
  let termContentPath;
  if (command === 'create') {
    if (positionals.length !== 2) throw new Error('create requires exactly TERM.');
    if (!values.space?.trim() || !values['wiki-root'] || !values.content) throw new Error('create requires --wiki-root ID, --space KEY and --content FILE.md.');
    if (values.cql !== undefined || values.local !== undefined || values.root !== undefined ||
        values.id !== undefined || values.version !== undefined || values.parent !== undefined || values.overwrite) {
      throw new Error('create received an incompatible option.');
    }
    if (values.output) throw new Error('create reports to stdout and does not write output files.');
    for (const id of values.related ?? []) {
      if (!/^\d+$/.test(id)) throw new Error('--related IDs must be numeric.');
    }
    for (const value of values['source-url'] ?? []) {
      let url;
      try { url = new URL(value); } catch { throw new Error('--source-url must be an HTTP or HTTPS URL without credentials.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('--source-url must be an HTTP or HTTPS URL without credentials.');
      }
    }
    termContentPath = path.resolve(values.content);
    await access(termContentPath);
  }
  if (command === 'explore') {
    if (positionals.length !== 2) throw new Error('explore requires one quoted QUESTION.');
    if (!values.space?.trim() || !values['wiki-root']) throw new Error('explore requires --wiki-root ID and --space KEY.');
    if (values.cql !== undefined || values.local !== undefined || values.root !== undefined || values.output ||
        values.id !== undefined || values.version !== undefined || values.parent !== undefined || values.overwrite) {
      throw new Error('explore received an incompatible option.');
    }
  }
  if (values['wiki-root'] !== undefined && !/^\d+$/.test(values['wiki-root'])) throw new Error('--wiki-root must be numeric.');
  let applyFiles;
  if (command === 'apply') {
    const forbidden = ['id', 'version', 'parent', 'cql', 'local', 'overwrite'];
    const supplied = forbidden.filter((key) => values[key] !== undefined && values[key] !== false);
    if (supplied.length) throw new Error('apply does not accept ' + supplied.map((key) => '--' + key).join(', ') + '.');
    if (!values.base) throw new Error('apply requires --base BASE.md.');
    if (!values.space?.trim()) throw new Error('apply requires an explicit --space KEY.');
    if (!values.env || !path.isAbsolute(values.env)) throw new Error('apply requires an absolute --env profile path.');
    if (values.output) throw new Error('apply reports to stdout and does not write output files.');
    if (!target || extra !== undefined || positionals.length !== 2) throw new Error('apply requires exactly DRAFT.md and --base BASE.md.');
    const draftPath = path.resolve(target);
    const basePath = path.resolve(values.base);
    if (draftPath === basePath) throw new Error('apply requires distinct base and draft paths.');
    await access(draftPath);
    await access(basePath);
    applyFiles = { draftPath, basePath };
  }
  if (command === 'read' && values.space && version !== undefined) throw new Error('Scoped read requires the current page; omit --version.');
  for (const key of ['id', 'parent']) if (values[key] && !/^\d+$/.test(values[key])) throw new Error('--' + key + ' must be numeric.');
  if (!['doctor', 'list', 'init'].includes(command) && !target) throw new Error(command + ' requires an argument.');
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
  if (command === 'apply') {
    const [baseSource, draftSource] = await Promise.all([
      readFile(applyFiles.basePath, 'utf8'),
      readFile(applyFiles.draftPath, 'utf8'),
    ]);
    const env = await loadProfile(values.env);
    env.CONFLUENCE_PRESERVE = 'all';
    const api = new ConfluenceApi(readWikiConfig(env));
    api.config.versionMessage = 'AI edit via cfwiki';
    if (values['wiki-root']) {
      if (!values.space?.trim() || values.root !== undefined || values.cql !== undefined || values.local !== undefined) {
        throw new Error('Root-bound apply requires --space KEY and does not accept --root, --cql or --local.');
      }
      const base = parseDocument(baseSource);
      const draft = parseDocument(draftSource);
      for (const document of [base, draft]) {
        const binding = document.metadata.confluence;
        if (!binding || binding.deployment !== api.config.deployment || binding.api_url !== api.config.apiUrl ||
            binding.site_url !== api.config.siteUrl || binding.space !== values.space || !/^\d+$/.test(binding.id ?? '')) {
          throw new Error('Root-bound apply files must match the selected profile, space and existing page.');
        }
      }
      await readTerm(api, { space: values.space, rootId: values['wiki-root'], id: base.metadata.confluence.id });
    }
    const applyOptions = values['wiki-root']
      ? { space: values.space, wikiRoot: values['wiki-root'] }
      : { space: values.space };
    const outcome = await applyAgentEdit(api, baseSource, draftSource, applyOptions);
    const safe = { status: outcome.status, id: outcome.id ?? null };
    if (outcome.status === 'success') {
      let confirmedMessage = null;
      try {
        let rawPage;
        const scoped = Object.create(api);
        scoped.getPage = async (...arguments_) => {
          const page = await api.getPage(...arguments_);
          rawPage = page.raw;
          return page;
        };
        const observed = await readStorageSnapshot(scoped, outcome.id, { space: values.space });
        if (observed.version === outcome.version && typeof rawPage?.version?.message === 'string') {
          confirmedMessage = rawPage.version.message;
        }
      } catch {
        // The edit is already complete; a later message read cannot change its outcome.
      }
      const reconciled = outcome.resources?.page?.status === 'reconciled';
      Object.assign(safe, {
        url: outcome.document.metadata.confluence.url, version: outcome.version, warnings: outcome.warnings,
        writeMessage: {
          requested: api.config.versionMessage, confirmed: confirmedMessage,
          outcome: reconciled ? 'reconciled-state' : 'accepted-response',
          ...(reconciled ? { authorship: 'unknown' } : {}),
        },
        ...(values['wiki-root'] ? { resources: outcome.resources } : {}),
      });
    }
    else if (outcome.status === 'conflict') safe.conflicts = (outcome.conflicts ?? []).map((conflict) => ({ code: conflict.code ?? conflict.kind ?? 'conflict', message: conflict.message ?? 'The edit could not be applied safely.' }));
    else Object.assign(safe, {
      attemptedVersion: outcome.attemptedVersion ?? null, outcome: outcome.outcome ?? 'unresolved', message: outcome.message ?? 'The write outcome requires inspection.',
      ...(values['wiki-root'] && outcome.resources ? { resources: outcome.resources } : {}),
    });
    Object.assign(safe, redactOutput(safe, api));
    const text = safe.status === 'success'
      ? '# Agent edit applied\n\n- ID: ' + safe.id + '\n- Version: ' + safe.version + '\n- URL: ' + safe.url +
        '\n- Write message requested: ' + safe.writeMessage.requested +
        '\n- Write message confirmed: ' + (safe.writeMessage.confirmed ?? 'unavailable') +
        '\n- Write outcome: ' + safe.writeMessage.outcome +
        (safe.writeMessage.authorship ? '\n- Authorship: ' + safe.writeMessage.authorship : '') + '\n'
      : safe.status === 'conflict'
        ? '# Agent edit conflict\n\n' + safe.conflicts.map((conflict) => '- ' + conflict.code + ': ' + conflict.message).join('\n') + '\n'
        : '# Agent edit unresolved\n\n- ID: ' + (safe.id ?? 'unknown') + '\n- Attempted version: ' + (safe.attemptedVersion ?? 'unknown') + '\n- ' + safe.message + '\n';
    await emit(text, safe);
    if (outcome.status !== 'success') process.exitCode = 1;
    return;
  }
  if (command === 'create' || command === 'explore' || command === 'init') {
    const env = await loadProfile(values.env);
    const api = new ConfluenceApi(readWikiConfig(env));
    if (command === 'init') {
      const result = await initWiki(api, { space: values.space, topic: values.topic, existingRoot: values['existing-root'] });
      const report = { status: result.status, reused: result.reused, id: result.id, version: result.version, url: result.url, spaceId: result.spaceId, spaceKey: result.spaceKey, topic: result.topic };
      const safeReport = redactOutput(report, api);
      await emit(result.status === 'confirmed'
        ? '# Wiki root confirmed\n\n- ID: ' + safeReport.id + '\n- Version: ' + safeReport.version + '\n- URL: ' + safeReport.url + '\n'
        : '# Wiki root unresolved\n\n- Status: ' + safeReport.status + '\n- ID: ' + (safeReport.id ?? 'unknown') + '\n', safeReport);
      if (result.status !== 'confirmed') process.exitCode = 1;
      return;
    }
    if (command === 'create') {
      const supplied = parseDocument(await readFile(termContentPath, 'utf8'));
      const forbiddenMetadata = ['confluence', 'profile', 'profile_path', 'tenant', 'space', 'space_id', 'space_key', 'spaceId', 'scope', 'root', 'root_id', 'rootId', 'wiki_root', 'wiki-root', 'api', 'api_url', 'site_url', 'deployment', 'cloud_id'];
      if (forbiddenMetadata.some((key) => Object.hasOwn(supplied.metadata, key))) {
        throw new Error('Term content cannot provide profile, space or root scope.');
      }
      const result = await createTerm(api, {
        space: values.space, rootId: values['wiki-root'], term: target, content: supplied.body,
        relatedIds: values.related ?? [], sourceUrls: values['source-url'] ?? [],
      });
      const report = {
        status: result.status, id: result.id, title: result.title, parentId: result.parentId,
        version: result.version, url: result.url, spaceId: result.spaceId,
        resources: result.status === 'created'
          ? { page: { status: 'saved', version: result.version }, metadata: { status: 'saved' } }
          : { page: { status: 'saved', version: result.version }, metadata: { status: 'failed', outcome: 'unresolved' } },
        ...(result.sources ? { sources: result.sources } : {}),
        ...(result.related ? { related: result.related } : {}),
        ...(result.warnings ? { warnings: result.warnings } : {}),
        ...(result.message ? { message: result.message } : {}),
      };
      const safeReport = redactOutput(report, api);
      await emit('# Term ' + (result.status === 'created' ? 'created' : 'partially created') + '\n\n- ID: ' + safeReport.id + '\n- Parent: ' + safeReport.parentId + '\n- Version: ' + safeReport.version + '\n- URL: ' + safeReport.url + '\n', safeReport);
      if (result.status !== 'created') process.exitCode = 1;
      return;
    }
    const result = await explore(api, { question: target, root: values['wiki-root'], space: values.space });
    const report = {
      status: result.evidence.length ? result.unresolvedLinks.length || result.unresolved.length ? 'partial' : 'unassessed' : 'abstained',
      evidence: result.evidence.map((item) => ({
        sourceType: item.sourceType, id: item.id, title: item.title, space: item.space,
        version: item.version, url: item.url, readAt: item.readAt, passages: item.passages,
        routes: item.routes, warnings: item.warnings, claimsStatus: item.claimsStatus,
      })),
      links: result.links, unresolved: result.unresolved, unresolvedLinks: result.unresolvedLinks,
      materialCorrectionLinks: result.materialCorrectionLinks, searches: result.searches,
      selections: result.selections, usage: result.usage, stopReason: result.stopReason,
      budgetLimits: result.budgetLimits, coverage: result.coverage,
    };
    Object.assign(report, redactOutput(report, api));
    const text = '# Exploration ' + report.status + '\n\n' +
      report.evidence.map((item) => '## ' + item.title + '\n\n- ID: ' + item.id + '\n- Version: ' + item.version + '\n- URL: ' + item.url + '\n' + item.passages.map((passage) => '\n' + passage.text).join('') + '\n').join('\n') +
      '\nLimitations: ' + report.coverage.limitations.join(', ') + '\n' +
      report.coverage.notes.map((note) => '- ' + note).join('\n') + '\n';
    await emit(text, report);
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
    case 'lookup': {
      const candidates = await api.searchScoped(target, { space: values.space, limit });
      await emit(indexMarkdown('Confluence lookup candidates (unverified)', candidates.results), candidates);
      break;
    }
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
      if (command === 'read' && values['wiki-root']) {
        if (!values.space?.trim()) throw new Error('Root-verified read requires an explicit --space KEY.');
        if (values.cql !== undefined || values.local !== undefined || values.root !== undefined) throw new Error('Root-verified read received an incompatible scope option.');
        if (values.assets || values['body-only'] || values.output) throw new Error('Root-verified read returns evidence on stdout and does not accept --assets, --body-only or --output.');
        const page = await readTerm(api, { space: values.space, rootId: values['wiki-root'], id: target });
        const report = redactOutput(page, api);
        await emit('# Verified term page\n\n- ID: ' + report.id + '\n- Version: ' + report.version + '\n- URL: ' + report.url + '\n\n' + report.body + '\n', report);
        break;
      }
      if (command === 'read' && values.space) {
        if (values.assets || values['body-only']) throw new Error('Scoped read does not accept --assets or --body-only.');
        let storage;
        const evidenceApi = Object.create(api);
        evidenceApi.getPage = async (...arguments_) => {
          const page = await api.getPage(...arguments_);
          storage = page.raw?.body?.storage?.value;
          return page;
        };
        const evidence = await readEvidence(evidenceApi, target, { space: values.space });
        const edges = extractStorageLinks({ ...evidence, storage });
        const result = redactOutput({ ...evidence, forwardLinks: edges.links, unresolvedLinks: edges.unresolved }, api);
        await emit('# Verified Confluence evidence\n\n- ID: ' + result.id + '\n- Version: ' + result.version + '\n- URL: ' + result.url + '\n- Read at: ' + result.readAt + '\n\n' + result.passages.map((passage) => passage.text).join('\n\n') + '\n', result);
        break;
      }
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
      if (values['wiki-root']) {
        if (!values.yes || version === undefined) throw new Error('Root-bound delete requires --yes and an explicit --version N.');
        if (!values.space?.trim()) throw new Error('Root-bound delete requires an explicit --space KEY.');
        if (!/^\d+$/.test(target)) throw new Error('Root-bound delete requires a numeric term page ID.');
        if (values.cql !== undefined || values.local !== undefined || values.root !== undefined || values.parent !== undefined) throw new Error('Root-bound delete received an incompatible option.');
        const result = await trashTerm(api, { space: values.space, rootId: values['wiki-root'], id: target, version, confirmed: true });
        const report = { status: result.status, id: result.id, version: result.version, url: result.url, spaceId: result.spaceId, preflightVersion: result.preflightVersion, racePossible: result.racePossible, resources: { page: { status: 'trashed' }, backlinks: { status: 'not_attempted' } }, deletion: result.deletion };
        await emit('# Term moved to trash\n\n- ID: ' + report.id + '\n- Preflight version: ' + report.preflightVersion + '\n- URL: ' + report.url + '\n- A concurrent change remains possible between preflight and delete.\n', report);
        break;
      }
      if (!values.yes || version === undefined) throw new Error('delete requires explicit --yes and --version N. It moves a page to trash, without purging it.');
      let id = target;
      let expected = version;
      if (/\.md$/i.test(target)) {
        const doc = parseDocument(await readFile(target, 'utf8'));
        if (doc.metadata.confluence?.api_url !== api.config.apiUrl) throw new Error('File API URL does not match the active profile.');
        id = doc.metadata.confluence?.id;
      }
      if (!expected) throw new Error('delete requires an explicit --version N.');
      const page = await api.getPage(id);
      if (page.storage.includes('data-cfwiki-root="1"')) throw new Error('A wiki root cannot be moved to trash.');
      let rootMarker;
      try {
        rootMarker = await api.getProperty(id, WIKI_ROOT_PROPERTY);
      } catch {
        throw new Error('Wiki root marker could not be checked; refusing to trash page.');
      }
      if (rootMarker === undefined) throw new Error('Wiki root marker could not be checked; refusing to trash page.');
      if (rootMarker !== null) throw new Error('A wiki root cannot be moved to trash.');
      if (page.status !== 'current') throw new Error('Only current published pages can be moved to trash.');
      if (page.version !== expected) throw new Error('Version conflict. Refusing to delete a changed page.');
      await api.deletePage(id);
      const report = { status: 'trashed', id, version: page.version, url: page.url, preflightVersion: page.version, racePossible: true, resources: { page: { status: 'trashed' }, backlinks: { status: 'not_attempted' } }, deletion: 'Confluence accepted the trash request after a version preflight; delete is not conditional on that version.' };
      await emit('# Page moved to trash\n\n- ID: ' + id + '\n- Preflight version: ' + page.version + '\n- URL: ' + page.url + '\n- A concurrent change remains possible between preflight and delete.\n', redactOutput(report, api));
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
