#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { sha256, validateCorpus } from './collect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const python = path.join(root, 'artifacts/laya-wiki/venv/bin/python');
const budget = Object.freeze({ candidates: 40, max_reads: 8, max_options: 4 });
const specs = [
  ['c-vpn/README.md', 'c-vpn의 현재 진행 체크리스트에서 AES-128-CBC와 HMAC-SHA256/PRF는 구현 완료로 표시되나요?', ['- [x] AES-128-CBC 암/복호화 (라운드 자체 구현)', '- [x] HMAC-SHA256 / PRF / PRF+ (내장 구현)']],
  ['c-vpn/README.md', 'c-vpn에서 X25519는 현재 실제로 구현되어 있나요, 다음 단계에서는 어떤 라이브러리 연동을 제안하나요?', ['- [ ] X25519 실제 구현 (현재 placeholder)', '1. X25519 구현 또는 libsodium 연동 (옵션 플래그)']],
  ['openscience/README.md', 'OpenScience를 계정 없이 자체 API 키로 이용할 때 키와 요청은 어디에 남거나 전송되나요?', ['using your own API keys. No account is required.', 'Your keys stay on your machine and requests go straight to the provider.']],
  ['openscience/README.md', 'OpenScience는 기본 연구 에이전트 외에 어떤 전문 에이전트와 비평·문헌 검토 역할을 제공하나요?', ['A `research` agent by default, plus `biology`, `physics`, and `ml` specialists, with critique and literature-review sub-agents and a read-only plan mode.']],
  ['openscience/README.md', 'OpenScience에서 Atlas가 과금하는 범위와 bring-your-own-key 이용 정책은 어떻게 다른가요?', ['Bring-your-own-key usage is always free and is never gated — Atlas only meters the models it serves.']],
  ['nuclei-templates/README_KR.md', 'nuclei-templates 한국어 소개에서 상위 10개 지표보다 자세한 통계와 기계가 읽을 통계는 어떤 파일로 안내하나요?', ['더 자세한 정보는 [이곳](TEMPLATES-STATS.md)에서 확인 가능하고, [JSON](TEMPLATES-STATS.json) 형식으로도 확인 가능합니다.']],
];
const controls = [
  ['ZXM_FRESH_LUNAR_FERRY_20260930', 'ZXM_FRESH_LUNAR_FERRY_20260930 사업의 승인된 월면 여객선 출항 날짜와 계약 금액은 무엇인가요?'],
  ['QVM_FRESH_UNICORN_PERMIT_20260930', 'Which authority issued QVM_FRESH_UNICORN_PERMIT_20260930 and what is its approved permit number?'],
];

export function freshCases(docs) {
  const evidence = [];
  const cases = specs.map(([suffix, query, quotes], index) => {
    const matches = docs.filter((doc) => doc.source_path === 'TwoTwo-me/' + suffix);
    if (matches.length !== 1 || quotes.some((quote) => !matches[0].text.includes(quote))) throw new Error('Source evidence missing: ' + suffix);
    const doc = matches[0];
    evidence.push({ case_id: 'metadata-' + (index + 1), source_id: doc.id, source_path: doc.source_path, source_sha256: doc.sha256, quotes });
    return { id: 'metadata-' + (index + 1), kind: 'question', query, start_id: 'virtual-menu-' + index, target_ids: [doc.id], split: 'test' };
  });
  for (const [marker, query] of controls) {
    if (docs.some((doc) => [doc.title, doc.source_path, doc.text].some((text) => text.includes(marker)))) throw new Error('Control marker occurs in corpus');
    const index = cases.length;
    cases.push({ id: 'metadata-' + (index + 1), kind: 'unanswerable', query, start_id: 'virtual-menu-' + index, target_ids: [], split: 'test' });
    evidence.push({ case_id: 'metadata-' + (index + 1), absent_marker: marker, searched_public_documents: docs.length });
  }
  return { cases, evidence };
}

export function rankMenus(docs, queries) {
  // This read-only adapter receives no evaluation labels and imports no model runtime.
  const code = `import json, sys, time
from pydantic import BaseModel, ConfigDict
sys.path.insert(0, sys.argv[1])
from models import BM25, Document
class Query(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    query: str
class Request(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    docs: list[Document]
    queries: list[Query]
request = Request.model_validate_json(sys.stdin.buffer.read())
started = time.perf_counter()
index = BM25([d.title + "\\n" + d.source_path + "\\n" + d.text for d in request.docs])
index_seconds = time.perf_counter() - started
started = time.perf_counter()
rankings = [[request.docs[i].id for i in index.rank(q.query)[:40]] for q in request.queries]
print(json.dumps({"rankings": rankings, "index_seconds": index_seconds, "ranking_seconds": time.perf_counter()-started}, allow_nan=False))`;
  const child = spawnSync(python, ['-c', code, here], { input: JSON.stringify({ docs, queries: queries.map(({ query }) => ({ query })) }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error('BM25 adapter failed: ' + child.stderr);
  return JSON.parse(child.stdout);
}

export function buildGraph(docs, cases, rankings) {
  validateCorpus(docs);
  if (docs.some((doc) => doc.private || doc.source_type !== 'github')) throw new Error('Only genuinely public GitHub sources are permitted');
  if (rankings.length !== cases.length) throw new Error('One ranking required per case');
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const menus = cases.map((item, index) => {
    const ids = rankings[index];
    if (ids.length !== Math.min(budget.candidates, docs.length) || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) throw new Error('Invalid bounded candidate ranking');
    return { id: item.start_id, title: 'Public document search', source_path: 'virtual/public-search', source_url: 'urn:laya:virtual-public-search', text: 'Public project document search results. Select a document to read for the query.', private: false, synthetic: true, links: ids.map((id) => ({ target_id: id, label: byId.get(id).source_path + ' | ' + byId.get(id).title, source_url: byId.get(id).source_url })) };
  });
  return { schema: 1, source_mode: 'local', nodes: [...docs.map((doc) => ({ ...doc, links: [] })), ...menus], summary: { nodes: docs.length + menus.length, source_documents: docs.length, edges: rankings.reduce((sum, ids) => sum + ids.length, 0), artificial_edges: rankings.reduce((sum, ids) => sum + ids.length, 0), native_wiki_edges: 0, topology: 'local virtual retrieval menus from public metadata+text BM25; not native wiki navigation' } };
}

export function pairedGraph(frozen, matched) {
  validateCorpus(matched);
  const byId = new Map(matched.map((doc) => [doc.id, doc]));
  const nodes = frozen.nodes.map((node) => {
    if (node.synthetic) return node;
    const doc = byId.get(node.id);
    if (!doc || doc.private || doc.source_path !== node.source_path || !Array.isArray(doc.pages) || !doc.pages.length) throw new Error('Missing public verified publisher match: ' + node.id);
    return { ...doc, links: [] };
  });
  return { ...frozen, source_mode: 'confluence-readback', nodes, summary: { ...frozen.summary, topology: 'same frozen virtual retrieval menus; source bodies from publisher matched readback' } };
}

async function main() {
  const { values } = parseArgs({ options: { corpus: { type: 'string', default: 'artifacts/laya-wiki/text-expansion/github/corpus.json' }, output: { type: 'string' }, 'paired-corpus': { type: 'string' }, frozen: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('Usage: node experiments/laya-wiki/metadata_probe.mjs --output NEW_DIR [--corpus FILE]\nPair frozen menus: --output NEW_DIR --frozen DIR --paired-corpus publisher/matched-corpus.json\nCreates frozen public-only virtual menus, 6 source-grounded questions and 2 controls; never invokes Laya.'); return; }
  if (!values.output || Boolean(values.frozen) !== Boolean(values['paired-corpus'])) throw new Error('Provide new --output and both pairing arguments together');
  const started = Date.now();
  let outputs, details;
  if (values.frozen) {
    const graphBytes = await readFile(path.join(values.frozen, 'graph.json'));
    const caseBytes = await readFile(path.join(values.frozen, 'cases.json'));
    const matchedBytes = await readFile(values['paired-corpus']);
    const graph = pairedGraph(JSON.parse(graphBytes), JSON.parse(matchedBytes));
    outputs = { 'graph.json': graph, 'cases.json': JSON.parse(caseBytes) };
    details = { paired_with: values.frozen, frozen_graph_sha256: sha256(graphBytes), frozen_cases_sha256: sha256(caseBytes), matched_corpus_sha256: sha256(matchedBytes), source_documents: graph.summary.source_documents };
  } else {
    const corpusBytes = await readFile(values.corpus);
    const all = validateCorpus(JSON.parse(corpusBytes));
    const docs = all.filter((doc) => doc.private === false && doc.source_type === 'github');
    const { cases, evidence } = freshCases(docs);
    const ranking = rankMenus(docs, cases);
    const graph = buildGraph(docs, cases, ranking.rankings);
    const rows = cases.map((item, index) => ({ case_id: item.id, kind: item.kind, target_ids: item.target_ids, candidate_ids: ranking.rankings[index], hit3: item.target_ids.some((id) => ranking.rankings[index].slice(0, 3).includes(id)), covered40: item.target_ids.some((id) => ranking.rankings[index].includes(id)) }));
    const positives = rows.filter((row) => row.kind === 'question');
    outputs = { 'corpus.json': docs, 'cases.json': cases, 'evidence.json': evidence, 'graph.json': graph, 'bm25.json': { index_fields: ['title', 'source_path', 'text'], corpus_documents: docs.length, rows, positive_denominator: positives.length, hit3: positives.filter((row) => row.hit3).length, covered40: positives.filter((row) => row.covered40).length, index_seconds: ranking.index_seconds, ranking_seconds: ranking.ranking_seconds } };
    details = { input_corpus_sha256: sha256(corpusBytes), input_documents: all.length, source_documents: docs.length, excluded_documents: all.length - docs.length };
  }
  const serialized = Object.fromEntries(Object.entries(outputs).map(([name, data]) => [name, JSON.stringify(data, null, 2) + '\n']));
  const manifest = { schema: 1, frozen_at: new Date().toISOString(), ...details, budget, artifact_sha256: Object.fromEntries(Object.entries(serialized).map(([name, text]) => [name, sha256(text)])), generator_sha256: sha256(await readFile(fileURLToPath(import.meta.url))), bm25_implementation_sha256: sha256(await readFile(path.join(here, 'models.py'))), graph_engine_sha256: sha256(await readFile(path.join(here, 'graph_benchmark.py'))), scope: 'Fresh diagnostic subset over public GitHub only; differs from the all-9434 primary benchmark. Six questions cover three source documents and are not independent topic samples.', menu_policy: 'Top 40 global metadata+text BM25 results, frozen in ranking order; no target-aware filtering; four options per decision; retained frontier; real document nodes have no outgoing links.', stopping: 'Oracle source-ID stop only after a logical document read. Deployment requires separate answer-sufficiency verification. Controls cannot succeed.', tuning: 'One fixed probe; no model-driven case, candidate, prompt or budget tuning.', paid_api_calls: 0, model_calls: 0, build_seconds: (Date.now()-started)/1000 };
  await mkdir(values.output, { recursive: false });
  for (const [name, text] of Object.entries(serialized)) await writeFile(path.join(values.output, name), text, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(values.output, 'preregistration.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output: values.output, ...details, budget, frozen_at: manifest.frozen_at }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
