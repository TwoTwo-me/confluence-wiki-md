#!/usr/bin/env node
import { lstat, readdir, readFile, writeFile, mkdir, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { sourceId, sha256, secretLooking, saveJson, validateCorpus } from './collect.mjs';

export function nativeId(name) {
  return name.match(/(?:^|[ /])([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:_all)?(?:\.(?:md|csv))?$/i)?.[1].replaceAll('-', '').toLowerCase();
}
export function decodeText(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('invalid_utf8'); }
  if (text.includes('\0')) throw new Error('binary_content');
  if (!text.trim()) throw new Error('empty_content');
  if (secretLooking(text)) throw new Error('secret_looking_content');
  return text;
}
export function options(args) {
  const { values } = parseArgs({ args, options: { input: { type: 'string' }, output: { type: 'string', default: 'artifacts/laya-wiki/text-expansion/notion' }, help: { type: 'boolean' } } });
  if (!values.help && (!values.input?.trim() || !values.output.trim())) throw new Error('input_and_output_required');
  return values;
}
async function inventory(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else files.push({ path: path.relative(root, full), type: entry.isSymbolicLink() ? 'symlink' : entry.isFile() ? 'file' : 'special' });
    }
  }
  await visit(root);
  return files;
}
export async function collectExport({ input, output }) {
  if (!(await lstat(input)).isDirectory()) throw new Error('input_must_be_real_directory');
  const root = await realpath(input);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const destination = await realpath(output);
  const relative = path.relative(root, destination);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('output_must_be_outside_export');
  await mkdir(path.join(destination, 'raw'), { recursive: true, mode: 0o700 });
  const files = await inventory(root);
  const manifest = { schema: 1, started_at: new Date().toISOString(), files, documents: [], references: [], media_reads: 0, cache_hits: 0,
    limits: ['Native export files only; inaccessible, foreign, omitted and unexported pages are not inventoried.', 'Block-level completeness and selected database-view row completeness cannot be established from exported files.', 'Reference detection covers Markdown inline links and native Notion page URLs; other reference syntax may remain unresolved.'], complete: false };
  const corpus = [];
  const seen = new Set();
  const save = () => saveJson(path.join(destination, 'source-manifest.json'), manifest);
  for (const entry of files) {
    if (entry.type !== 'file') { entry.status = 'excluded'; entry.reason = entry.type + '_not_followed'; continue; }
    const extension = path.extname(entry.path).toLowerCase();
    if (!['.md', '.csv'].includes(extension)) { entry.status = 'excluded'; entry.reason = 'non_text_export_file'; continue; }
    const id = nativeId(path.basename(entry.path));
    if (!id) { entry.status = 'excluded'; entry.reason = 'export_file_without_native_uuid'; continue; }
    const source_url = 'https://www.notion.so/' + id;
    const source_path = id + (extension === '.csv' ? '/database.csv' : '');
    entry.native_id = id; entry.id = sourceId('notion', source_url, source_path);
    if (seen.has(entry.id)) { entry.status = 'unavailable'; entry.reason = 'duplicate_source_identity'; continue; }
    seen.add(entry.id);
    try {
      const file = path.join(root, entry.path);
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try {
        if (!(await handle.stat()).isFile()) throw new Error('file_type_changed');
        bytes = await handle.readFile();
      } finally { await handle.close(); }
      entry.bytes = bytes.length;
      const text = decodeText(bytes);
      const parents = path.dirname(entry.path).split(path.sep).reverse().map(nativeId).filter(Boolean);
      const parent = parents.find((value) => value !== id);
      const doc = { id: entry.id, title: path.basename(entry.path, extension).replace(/ [a-f0-9-]{32,36}(?:_all)?$/i, ''), text,
        source_type: 'notion', source_url, source_path, private: true, sha256: sha256(text), ...(parent ? { parent_id: parent } : {}),
        notion: { native_id: id, export_path: entry.path, format: extension.slice(1), block_coverage: 'unknown', ...(extension === '.csv' ? { database_view_coverage: 'exported_view_only' } : {}) } };
      validateCorpus([doc]);
      const raw = path.join(destination, 'raw', entry.id + '.txt');
      let cached = false;
      try { cached = sha256(await readFile(raw)) === doc.sha256; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (cached) manifest.cache_hits++;
      else await writeFile(raw, text, { mode: 0o600 });
      entry.status = 'collected'; entry.sha256 = doc.sha256; entry.cache_hit = cached;
      corpus.push(doc); manifest.documents.push({ ...entry, source_type: 'notion', source_path, source_url, private: true });
      if (extension === '.md') {
        for (const match of text.matchAll(/(?<!!)\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
          let target;
          try { target = decodeURIComponent(match[1]); } catch { manifest.references.push({ source_id: doc.id, status: 'unresolved', reason: 'invalid_link_encoding' }); continue; }
          const native = target.match(/^https?:\/\/(?:www\.|app\.)?notion\.(?:so|com)\/(?:.*?)([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:[?#]|$)/i)?.[1].replaceAll('-', '').toLowerCase();
          if (native) manifest.references.push({ source_id: doc.id, native_id: native, status: 'pending' });
          else if (/\.(md|csv)(?:[#?].*)?$/i.test(target) && !/^https?:\/\//i.test(target)) manifest.references.push({ source_id: doc.id, export_path: path.normalize(path.join(path.dirname(entry.path), target.split(/[?#]/)[0])), status: 'pending' });
        }
      }
    } catch (error) { entry.status = 'unavailable'; entry.reason = error.code ?? error.message; }
    await save();
  }
  const nativeIds = new Set(corpus.map((d) => d.notion.native_id));
  const capturedPaths = new Set(corpus.map((d) => d.notion.export_path));
  for (const reference of manifest.references.filter((r) => r.status === 'pending')) {
    reference.status = reference.native_id ? nativeIds.has(reference.native_id) ? 'captured' : 'unresolved' : capturedPaths.has(reference.export_path) ? 'captured' : 'unresolved';
    if (reference.status === 'unresolved') reference.reason = 'referenced_page_not_captured';
  }
  validateCorpus(corpus);
  manifest.finished_at = new Date().toISOString(); manifest.collected = corpus.length;
  manifest.export_files_accounted = files.every((f) => ['collected', 'excluded', 'unavailable'].includes(f.status));
  manifest.export_text_complete = files.filter((f) => f.type === 'file' && /\.(md|csv)$/i.test(f.path)).every((f) => f.status === 'collected');
  await saveJson(path.join(destination, 'corpus.json'), corpus); await save();
  return { files: files.length, collected: corpus.length, unavailable: files.filter((f) => f.status === 'unavailable').length, excluded: files.filter((f) => f.status === 'excluded').length,
    unresolved_references: manifest.references.filter((r) => r.status === 'unresolved').length, cache_hits: manifest.cache_hits, media_reads: 0, export_files_accounted: manifest.export_files_accounted, export_text_complete: manifest.export_text_complete, complete: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = options(process.argv.slice(2));
    if (args.help) console.log('Usage: node experiments/laya-wiki/notion_text_export.mjs --input EXTRACTED_DIRECTORY [--output DIRECTORY]\nCollect native Notion Markdown/CSV text without network or media reads. Native UUID identities, explicit file accounting and unresolved references are preserved. Workspace/block completeness is unknown.');
    else console.log(JSON.stringify(await collectExport(args)));
  } catch (error) { console.error(JSON.stringify({ error: error.code ?? error.message })); process.exitCode = 1; }
}
