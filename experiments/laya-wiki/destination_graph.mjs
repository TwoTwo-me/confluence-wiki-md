import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const compact = value => String(value ?? '').replaceAll('-', '').toLowerCase();
const hash = text => createHash('sha256').update(text).digest('hex');
const capturedCollectionStatuses = new Set(['captured', 'count_matched', 'rows_and_templates_count_matched']);

export function buildGraph(corpus, state) {
  if (!Array.isArray(corpus) || !state.workspace || !state.blocks || !state.collections) throw new Error('Invalid corpus or capture state');
  const blocks = new Map(Object.entries(state.blocks).map(([id, block]) => [compact(id), block]));
  const collections = new Map(Object.entries(state.collections).filter(([, c]) => capturedCollectionStatuses.has(c.status)).map(([id, c]) => [compact(id), c]));
  const docs = new Map();
  const sourceIds = new Set();
  const summary = { excluded_documents: 0, unmapped_references: 0, parent_cycles: 0, decoded_newlines: 0, media_reads: 0, network_requests: 0 };
  for (const doc of corpus) {
    if (sourceIds.has(doc.id)) throw new Error(`Duplicate source ID: ${doc.id}`);
    sourceIds.add(doc.id);
    const id = compact(doc.notion?.native_id);
    const block = blocks.get(id);
    if (doc.notion?.format !== 'md' || block?.status !== 'captured' || (block.space_id && compact(block.space_id) !== compact(state.workspace))) {
      summary.excluded_documents++;
      continue;
    }
    if (docs.has(id)) throw new Error(`Duplicate native ID: ${id}`);
    if (!/^[a-f0-9]{32}$/.test(id) || typeof doc.text !== 'string' || typeof doc.title !== 'string' || !doc.title.trim()) throw new Error('Malformed Markdown document');
    const decoded = !doc.text.includes('\n') && doc.text.includes('\\n');
    const text = decoded ? doc.text.replaceAll('\\n', '\n') : doc.text;
    summary.decoded_newlines += Number(decoded);
    docs.set(id, { ...doc, text, display_name: doc.title, links: [], provenance: { native_id: id, workspace: state.workspace, captured_status: block.status, text_transform: decoded ? 'literal-newline-decoding' : 'identity', original_sha256: hash(doc.text) }, sha256: hash(text) });
  }
  const parentOf = native => {
    const seen = new Set([native]);
    let parent = compact(blocks.get(native)?.parent_id);
    while (parent) {
      if (seen.has(parent)) { summary.parent_cycles++; return null; }
      seen.add(parent);
      if (docs.has(parent)) return parent;
      const collection = collections.get(parent);
      if (collection) { parent = compact(collection.block_id || collection.parent_block_id); continue; }
      const block = blocks.get(parent);
      if (!block || block.status !== 'captured') return null;
      parent = compact(block.parent_id);
    }
    return null;
  };
  const parents = new Map();
  for (const [id, doc] of docs) {
    const parent = parentOf(id);
    if (parent) parents.set(id, parent);
    else if (doc.parent_id && docs.has(compact(doc.parent_id))) {
      summary.unmapped_references++;
    }
  }
  for (const [id, doc] of docs) {
    const parts = [doc.title], seen = new Set([id]);
    let parent = parents.get(id);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      parts.unshift(docs.get(parent).title);
      parent = parents.get(parent);
    }
    if (parent) summary.parent_cycles++;
    doc.display_name = parts.join(' / ');
  }
  const connect = (source, target, kind, receipt, label) => {
    const from = docs.get(source), to = docs.get(target);
    if (!from || !to) { summary.unmapped_references++; return; }
    if (source === target) { summary.parent_cycles++; return; }
    if (from.links.some(e => e.target_id === to.id && e.provenance.kind === kind)) return;
    from.links.push({ target_id: to.id, label: label || to.title, source_url: to.source_url, provenance: { kind, receipt } });
  };
  for (const [child, parent] of parents) {
    connect(parent, child, 'containment', `blocks/${child}/parent_id`);
    connect(child, parent, 'parent-breadcrumb', `blocks/${child}/parent_id`);
  }
  for (const [collectionId, collection] of Object.entries(state.collections)) {
    if (!capturedCollectionStatuses.has(collection.status)) continue;
    const view = compact(collection.block_id || collection.parent_block_id);
    const source = docs.has(view) ? view : parentOf(view);
    for (const [field, kind] of [['row_ids', 'collection-row'], ['template_ids', 'collection-template']]) {
      for (const row of collection[field] ?? []) {
        const target = compact(row);
        connect(source, target, kind, `collections/${collectionId}/${field}`);
        if (source && docs.has(target)) connect(target, source, 'parent-breadcrumb', `collections/${collectionId}/${field}`);
      }
    }
  }
  for (const [id, doc] of docs) {
    let fence = null;
    for (const line of doc.text.split('\n')) {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        continue;
      }
      if (fence || /^ {4}|^\t/.test(line)) continue;
      const prose = line.replace(/(`+).*?\1/g, '');
      for (const match of prose.matchAll(/(?<!!)\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
        const url = new URL(match[2]);
        if (!(url.hostname === 'notion.so' || url.hostname.endsWith('.notion.so') || url.hostname.endsWith('.notion.site'))) continue;
        const target = compact(url.pathname.match(/([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/)?$/i)?.[1]);
        if (target) connect(id, target, 'body-hyperlink', `markdown:${match[2]}`, match[1]);
      }
    }
  }
  const nodes = [...docs.values()];
  return { schema: 1, source_mode: 'notion-native-local', private: true, nodes, summary: { ...summary, nodes: nodes.length, edges: nodes.reduce((n, d) => n+d.links.length, 0), duplicate_display_names: nodes.length-new Set(nodes.map(n => n.display_name)).size, edge_kinds: [...new Set(nodes.flatMap(n => n.links.map(l => l.provenance.kind)))] } };
}

export async function main(args) {
  const { values } = parseArgs({ args, options: { corpus: { type: 'string' }, state: { type: 'string' }, output: { type: 'string' } }, strict: true });
  if (!values.corpus || !values.state || !values.output) throw new Error('Required: --corpus C --state S --output O');
  const corpus = await readFile(values.corpus, 'utf8');
  const state = await readFile(values.state, 'utf8');
  const graph = buildGraph(JSON.parse(corpus), JSON.parse(state));
  graph.provenance = { corpus_sha256: hash(corpus), state_sha256: hash(state), media_reads: 0, network_requests: 0 };
  await mkdir(dirname(values.output), { recursive: true });
  await writeFile(values.output, `${JSON.stringify(graph, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(graph.summary)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
