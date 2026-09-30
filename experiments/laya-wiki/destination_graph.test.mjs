import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from './destination_graph.mjs';

const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map(c => c.repeat(32));
function fixture() {
  return {
    corpus: ids.slice(0, 5).map((id, i) => ({ id: `source-${i}`, title: `Page ${i}`, text: 'body', source_url: `https://notion.so/${id}`, notion: { native_id: id, format: 'md' } })),
    state: { workspace: 'workspace', blocks: Object.fromEntries(ids.slice(0, 5).map(id => [id, { status: 'captured', parent_id: null }])), collections: {} },
  };
}

test('containment and breadcrumb use captured parent chain', () => {
  const { corpus, state } = fixture();
  state.blocks[ids[1]].parent_id = ids[5];
  state.blocks[ids[5]] = { status: 'captured', parent_id: ids[0] };
  const graph = buildGraph(corpus, state);
  assert.equal(graph.nodes[1].display_name, 'Page 0 / Page 1');
  assert.equal(graph.nodes[0].links[0].target_id, 'source-1');
  assert.equal(graph.nodes[1].links[0].provenance.kind, 'parent-breadcrumb');
});

test('collection row and template edges use known captured documents', () => {
  const { corpus, state } = fixture();
  state.collections.example = { status: 'count_matched', block_id: ids[0], row_ids: [ids[1], ids[5]], template_ids: [ids[2]] };
  const graph = buildGraph(corpus, state);
  assert.deepEqual(graph.nodes[0].links.map(e => e.provenance.kind), ['collection-row', 'collection-template']);
  assert.equal(graph.summary.unmapped_references, 1);
});

test('row breadcrumb resolves collection parent to captured view', () => {
  const { corpus, state } = fixture();
  state.blocks[ids[1]].parent_id = ids[5];
  state.collections[ids[5]] = { status: 'count_matched', block_id: ids[0], row_ids: [ids[1]], template_ids: [] };
  const graph = buildGraph(corpus, state);
  assert.equal(graph.nodes[1].display_name, 'Page 0 / Page 1');
});

test('foreign and missing references cannot become graph nodes', () => {
  const { corpus, state } = fixture();
  state.blocks[ids[1]].status = 'foreign';
  state.blocks[ids[2]].space_id = 'another-workspace';
  corpus[0].text = `[foreign](https://notion.so/${ids[1]})\n[missing](https://notion.so/${ids[5]})`;
  const graph = buildGraph(corpus, state);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.nodes[0].links.length, 0);
  assert.equal(graph.summary.unmapped_references, 2);
});

test('fenced samples inline code images and raw URLs are not hyperlinks', () => {
  const { corpus, state } = fixture();
  corpus[0].text = `[real](https://notion.so/${ids[1]})\n\`\`\`json\n[fenced](https://notion.so/${ids[2]})\n\`\`\`\n\`[inline](https://notion.so/${ids[3]})\`\n![image](https://notion.so/${ids[4]})\nhttps://notion.so/${ids[4]}`;
  const graph = buildGraph(corpus, state);
  assert.deepEqual(graph.nodes[0].links.map(e => e.target_id), ['source-1']);
  assert.equal(graph.summary.media_reads, 0);
  assert.equal(graph.summary.network_requests, 0);
});

test('duplicate source and native identities are rejected', () => {
  const { corpus, state } = fixture();
  assert.throws(() => buildGraph([...corpus, corpus[0]], state), /Duplicate source/);
  assert.throws(() => buildGraph([...corpus, { ...corpus[0], id: 'new-source' }], state), /Duplicate native/);
});

test('parent cycles terminate and are reported', () => {
  const { corpus, state } = fixture();
  state.blocks[ids[0]].parent_id = ids[1];
  state.blocks[ids[1]].parent_id = ids[0];
  const graph = buildGraph(corpus, state);
  assert.ok(graph.summary.parent_cycles > 0);
});

test('literal newlines decode before code-fence filtering', () => {
  const { corpus, state } = fixture();
  corpus[0].text = `\`\`\`\\n[sample](https://notion.so/${ids[1]})\\n\`\`\``;
  const graph = buildGraph(corpus, state);
  assert.equal(graph.summary.decoded_newlines, 1);
  assert.equal(graph.nodes[0].links.length, 0);
});

test('rows_and_templates_count_matched enables parent and collection edges', () => {
  const { corpus, state } = fixture();
  state.blocks[ids[1]].parent_id = ids[5];
  state.collections[ids[5]] = { status: 'rows_and_templates_count_matched', block_id: ids[0], row_ids: [ids[1]], template_ids: [ids[2]] };
  const graph = buildGraph(corpus, state);
  assert.equal(graph.nodes[1].display_name, 'Page 0 / Page 1');
  assert.ok(graph.nodes[0].links.some(e => e.target_id === 'source-1' && e.provenance.kind === 'collection-row'));
  assert.ok(graph.nodes[0].links.some(e => e.target_id === 'source-2' && e.provenance.kind === 'collection-template'));
});

for (const csvFirst of [false, true]) {
  test(`CSV duplicate native ID is excluded with csvFirst=${csvFirst}`, () => {
    const { corpus, state } = fixture();
    const csv = { ...corpus[0], id: 'csv-source', notion: { ...corpus[0].notion, format: 'csv' } };
    const graph = buildGraph(csvFirst ? [csv, ...corpus] : [...corpus, csv], state);
    assert.equal(graph.nodes.length, 5);
    assert.equal(graph.summary.excluded_documents, 1);
    assert.throws(() => buildGraph([...corpus, { ...csv, id: corpus[0].id }], state), /Duplicate source/);
  });
}
