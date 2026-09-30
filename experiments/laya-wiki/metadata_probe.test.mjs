import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { sha256, sourceId } from './collect.mjs';
import { buildGraph, pairedGraph, rankMenus } from './metadata_probe.mjs';

function document(index, privateSource = false) {
  const source_path = `fixture/project/docs/${index}.md`;
  const source_url = `https://github.com/fixture/project/blob/main/docs/${index}.md`;
  const text = 'Shared ordinary documentation';
  return { id: sourceId('github', source_url, source_path), title: 'Document', text, source_path, source_url, source_type: 'github', private: privateSource, sha256: sha256(text) };
}
const query = { id: 'test', start_id: 'virtual-menu-0', query: 'needle', target_ids: [], kind: 'unanswerable', split: 'test' };

test('virtual menus preserve ranking order and expose only public source metadata', () => {
  // Given
  const docs = Array.from({ length: 45 }, (_, index) => document(index));
  const ranking = docs.slice(5).map((doc) => doc.id).reverse();
  // When
  const graph = buildGraph(docs, [query], [ranking]);
  // Then
  assert.deepEqual(graph.nodes.at(-1).links.map((link) => link.target_id), ranking);
  assert.ok(graph.nodes.slice(0, -1).every((node) => node.links.length === 0));
  assert.equal(graph.summary.artificial_edges, 40);
  assert.ok(graph.nodes.at(-1).links.every((link) => docs.some((doc) => doc.id === link.target_id && link.label.includes(doc.source_path))));
});

test('evaluation targets cannot alter synthetic menu content or ordering', () => {
  // Given
  const docs = [document(0), document(1)];
  const rankings = [docs.map((doc) => doc.id)];
  // When
  const original = buildGraph(docs, [query], rankings);
  const changed = buildGraph(docs, [{ ...query, id: 'different-case', kind: 'question', target_ids: [docs[1].id] }], rankings);
  // Then
  assert.deepEqual(changed, original);
});

test('private source admission fails instead of relabeling', () => {
  // Given
  const doc = document(0, true);
  // When / Then
  assert.throws(() => buildGraph([doc], [query], [[doc.id]]), /public GitHub/);
  assert.equal(doc.private, true);
});

test('duplicate, unknown and oversized menu candidates fail at the boundary', () => {
  // Given
  const docs = [document(0), document(1)];
  // When / Then
  for (const ids of [[docs[0].id, docs[0].id], [docs[0].id, 'missing'], docs.map((doc) => doc.id).concat('extra')]) assert.throws(() => buildGraph(docs, [query], [ids]), /candidate ranking/);
});

test('real BM25 adapter ranks source-path metadata without receiving target labels', () => {
  // Given
  const docs = [document('haystack'), document('needle')];
  // When
  const result = rankMenus(docs, [{ ...query, target_ids: [docs[0].id] }]);
  // Then
  assert.equal(result.rankings[0][0], docs[1].id);
  assert.ok(Number.isFinite(result.index_seconds) && result.index_seconds >= 0);
});

test('paired readback preserves frozen menus and source identity', () => {
  // Given
  const docs = [document(0)];
  const graph = buildGraph(docs, [query], [[docs[0].id]]);
  const text = 'Verified readback body';
  const matched = [{ ...docs[0], text, sha256: sha256(text), pages: [{ id: '123', version: 1, url: 'https://wiki.example/123' }] }];
  // When
  const paired = pairedGraph(graph, matched);
  // Then
  assert.equal(paired.nodes[0].text, text);
  assert.deepEqual(paired.nodes.at(-1), graph.nodes.at(-1));
  assert.equal(paired.source_mode, 'confluence-readback');
});

test('paired readback fails on missing source pages', () => {
  // Given
  const docs = [document(0)];
  const graph = buildGraph(docs, [query], [[docs[0].id]]);
  // When / Then
  assert.throws(() => pairedGraph(graph, docs), /publisher match/);
});

test('CLI rejects partial pairing arguments before reading corpora', () => {
  // Given / When
  const result = spawnSync(process.execPath, ['experiments/laya-wiki/metadata_probe.mjs', '--output', '/never-created', '--frozen', 'missing'], { encoding: 'utf8' });
  // Then
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pairing arguments/);
});
