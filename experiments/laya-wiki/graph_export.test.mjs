import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGraph } from './graph_export.mjs';
import { sha256, sourceId } from './collect.mjs';

function document(file, text) {
  const source_path = 'owner/repo/' + file, source_url = 'https://github.com/owner/repo/blob/main/' + file;
  return { id: sourceId('github', source_url, source_path), title: file, text, source_path, source_url, source_type: 'github', private: false, sha256: sha256(text) };
}

test('export resolves rendered relative links and drops external, code and self links', () => {
  const start = document('README.md', '[guide](docs/guide.md#usage) [self](README.md) [outside](https://example.com/guide.md)\n\n```md\n[not rendered](docs/code.md)\n```');
  const guide = document('docs/guide.md', '# Guide'), code = document('docs/code.md', '# Code');
  const graph = exportGraph([start, guide, code], 'local');
  assert.deepEqual(graph.nodes[0].links.map((edge) => edge.target_id), [guide.id]);
  assert.equal(graph.summary.edges, 1);
});

test('export matches registered Confluence alias to the source identity', () => {
  const target = document('target.md', '# target');
  target.confluence = { id: '102', version: 1, url: 'https://wiki.example.com/wiki/pages/viewpage.action?pageId=102', integrity: true };
  const start = document('README.md', '[target](https://wiki.example.com/wiki/pages/viewpage.action?pageId=102)');
  start.confluence = { id: '101', version: 1, url: 'https://wiki.example.com/wiki/pages/viewpage.action?pageId=101', integrity: true };
  const graph = exportGraph([start, target], 'confluence-readback');
  assert.equal(graph.nodes[0].links[0].target_id, target.id);
});

test('export refuses private corpus before exposing document contents', () => {
  const privateDoc = { ...document('README.md', '# private'), private: true };
  assert.throws(() => exportGraph([privateDoc], 'local'), /public documents/);
});
