#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { markdownToStorage, loadStorageXml } from '../../src/document.mjs';
import { validateCorpus, saveJson, sha256 } from './collect.mjs';

function canonical(value, base) {
  const url = new URL(value, base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  url.hash = '';
  if (url.hostname === 'github.com' && url.pathname.includes('/blob/')) url.search = '';
  return url.href;
}

export function exportGraph(corpus, sourceMode) {
  validateCorpus(corpus);
  if (!['local', 'confluence-readback'].includes(sourceMode)) throw new Error('Unknown graph source mode.');
  if (corpus.some((doc) => doc.private || (sourceMode === 'confluence-readback' && !doc.confluence?.integrity))) throw new Error('Graph requires public documents and verified Confluence snapshots.');
  const aliases = new Map();
  for (const doc of corpus) {
    for (const value of [doc.source_url, ...(doc.confluence ? [doc.confluence.url] : [])]) {
      const url = canonical(value);
      if (!url || (aliases.has(url) && aliases.get(url) !== doc.id)) throw new Error('Graph URL identity is unsafe or ambiguous.');
      aliases.set(url, doc.id);
    }
  }
  let unmapped = 0, selfLinks = 0;
  const nodes = corpus.map((doc) => {
    const $ = loadStorageXml(markdownToStorage(doc.text, { flattenNestedQuotes: true }).storage);
    const links = [], seen = new Set();
    $('a[href]').each((_i, element) => {
      const href = $(element).attr('href');
      let url;
      try { url = canonical(href, doc.source_url); } catch { unmapped++; return; }
      const target = aliases.get(url);
      if (!target) { unmapped++; return; }
      if (target === doc.id) { selfLinks++; return; }
      if (seen.has(target)) return;
      seen.add(target);
      links.push({ target_id: target, label: $(element).text().replace(/\s+/g, ' ').trim().slice(0, 160), source_url: url });
    });
    return { ...doc, links };
  });
  const summary = { nodes: nodes.length, edges: nodes.reduce((n, doc) => n + doc.links.length, 0), nodes_with_links: nodes.filter((doc) => doc.links.length).length, unmapped_links: unmapped, self_links: selfLinks, external_links_fetched: 0, artificial_edges: 0 };
  return { schema: 1, source_mode: sourceMode, graph_sha256: sha256(JSON.stringify(nodes)), nodes, summary };
}

export function freezeCases(graph, publicCases) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const ordered = [...nodes.values()].sort((a, b) => a.source_path.localeCompare(b.source_path, 'en'));
  const roots = ordered.filter((doc) => /^[^/]+\/[^/]+\/README\.md$/.test(doc.source_path));
  if (roots.length !== 2) throw new Error('This study requires the two preregistered public repository README roots.');
  const rows = [];
  for (const start of ordered) {
    const distance = new Map([[start.id, 0]]), queue = [start.id];
    for (let i = 0; i < queue.length; i++) {
      for (const edge of nodes.get(queue[i]).links) if (!distance.has(edge.target_id)) { distance.set(edge.target_id, distance.get(queue[i]) + 1); queue.push(edge.target_id); }
    }
    for (const target of ordered) {
      const hops = distance.get(target.id);
      if ((hops === 2 || hops === 3) && rows.length < 6) rows.push({ id: 'named-' + (rows.length + 1), kind: 'named-goal', query: 'Reach the linked document named ' + target.source_path + '.', start_id: start.id, target_ids: [target.id], split: 'test', selection: 'first six sorted pairs with shortest path two or three; topology only, before model' });
    }
  }
  if (rows.length !== 6) throw new Error('The public graph lacks six natural multihop cases.');
  for (const query of publicCases.filter((item) => item.split === 'test')) {
    if (query.relevant_ids.some((id) => !nodes.has(id))) throw new Error('Question label is outside public graph.');
    for (const [index, root] of roots.entries()) rows.push({ id: query.id + '-root-' + (index + 1), kind: query.relevant_ids.length ? 'question' : 'unanswerable', query: query.query, start_id: root.id, target_ids: query.relevant_ids, split: query.split, selection: 'each fixed repository root; no answer-label-based start selection' });
  }
  for (const [index, root] of roots.entries()) {
    const other = roots[1 - index];
    rows.push({ id: 'cross-repo-' + (index + 1), kind: 'unreachable', query: 'Reach the linked document named ' + other.source_path + '.', start_id: root.id, target_ids: [other.id], split: 'test', selection: 'disconnected real repository roots; no artificial bridge' });
  }
  return rows;
}

async function main() {
  const { values } = parseArgs({ options: { corpus: { type: 'string' }, output: { type: 'string' }, mode: { type: 'string', default: 'local' }, 'cases-output': { type: 'string' }, 'public-cases': { type: 'string', default: 'experiments/laya-wiki/results/public-cases.json' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('Usage: node experiments/laya-wiki/graph_export.mjs --corpus FILE --output FILE [--mode local|confluence-readback] [--cases-output FILE] [--public-cases FILE]\nExports only real hyperlinks between registered public document identities; no external fetches or artificial bridges. Cases use structural multihop pairs and both fixed roots for every public test question.'); return; }
  if (!values.corpus || !values.output) throw new Error('Both --corpus and --output are required.');
  const graph = exportGraph(JSON.parse(await readFile(values.corpus, 'utf8')), values.mode);
  await saveJson(values.output, graph);
  if (values['cases-output']) await saveJson(values['cases-output'], freezeCases(graph, JSON.parse(await readFile(values['public-cases'], 'utf8'))));
  console.log(JSON.stringify({ ...graph.summary, graph: values.output, cases: values['cases-output'] ?? null, graph_sha256: graph.graph_sha256 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
