import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDocument } from '../src/merge.mjs';

const fallback = '[Confluence: jira](https://wiki.test/page#macro-jira)';
const native = { markdown: fallback, storage: '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">DOC-1</ac:parameter></ac:structured-macro>', block: true };

const document = (metadata, body) => ({ metadata: structuredClone(metadata), body });

test('merges independent agent and remote edits', () => {
  const base = document({
    type: 'Reference',
    title: 'Release guide',
    owner: { team: 'docs' },
    tags: ['release'],
    confluence: { id: '42', version: 7, preserved: [native] },
  }, 'first\n' + fallback + '\nlast\n');
  const local = document({
    ...base.metadata,
    title: 'Release playbook',
    confluence: { id: '999', version: 99, preserved: [native] },
  }, 'FIRST\n' + fallback + '\nlast\n');
  const remote = document({
    ...base.metadata,
    owner: { team: 'platform' },
    confluence: { id: '42', version: 8, preserved: [native] },
  }, 'first\n' + fallback + '\nLAST\n');
  const snapshots = structuredClone({ base, local, remote });

  const result = mergeDocument(base, local, remote);

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.document, {
    metadata: {
      confluence: { id: '42', version: 8, preserved: [native] },
      owner: { team: 'platform' },
      tags: ['release'],
      title: 'Release playbook',
      type: 'Reference',
    },
    body: 'FIRST\n' + fallback + '\nLAST\n',
  });
  assert.deepEqual({ base, local, remote }, snapshots);

  const inserted = mergeDocument(
    document({ type: 'Reference' }, 'alpha\nomega\n'),
    document({ type: 'Reference' }, 'alpha\nshared\nomega\n'),
    document({ type: 'Reference' }, 'alpha\nshared\nomega\n'),
  );
  assert.equal(inserted.document.body, 'alpha\nshared\nomega\n');
});

test('refuses overlapping and ambiguous preserved edits', () => {
  const plain = { type: 'Reference' };
  const overlap = mergeDocument(
    document(plain, 'one\ntwo\n'),
    document(plain, 'one\nLOCAL\n'),
    document(plain, 'one\nREMOTE\n'),
  );
  assert.equal(overlap.document, null);
  assert.ok(overlap.conflicts.some((conflict) => conflict.scope === 'body' && conflict.kind === 'overlap'));

  const preservedMetadata = { type: 'Reference', confluence: { id: '42', version: 7, preserved: [native] } };
  const repeated = mergeDocument(
    document(preservedMetadata, fallback + '\n' + fallback + '\n'),
    document(preservedMetadata, fallback + '\n' + fallback + '\nlocal\n'),
    document(preservedMetadata, fallback + '\n' + fallback + '\nremote\n'),
  );
  assert.equal(repeated.document, null);
  assert.ok(repeated.conflicts.some((conflict) => conflict.scope === 'preserved' && conflict.kind === 'ambiguous'));

  const relocated = mergeDocument(
    document(preservedMetadata, 'before\n' + fallback + '\nafter\n'),
    document(preservedMetadata, 'before\nafter\n' + fallback + '\n'),
    document(preservedMetadata, 'before\n' + fallback + '\nafter\n'),
  );
  assert.equal(relocated.document, null);
  assert.ok(relocated.conflicts.some((conflict) => conflict.scope === 'preserved' && conflict.kind === 'modified' && conflict.side === 'local'));

  const changedNative = structuredClone(preservedMetadata);
  changedNative.confluence.preserved[0].storage = '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">INJECTED</ac:parameter></ac:structured-macro>';
  const opaque = mergeDocument(
    document(preservedMetadata, fallback + '\n'),
    document(changedNative, fallback + '\nlocal\n'),
    document(preservedMetadata, fallback + '\nremote\n'),
  );
  assert.equal(opaque.document, null);
  assert.ok(opaque.conflicts.some((conflict) => conflict.scope === 'preserved' && conflict.kind === 'modified' && conflict.side === 'local'));
  assert.equal(JSON.stringify(opaque).includes('INJECTED'), false);
});

test('collapses repeated identical insertions and conflicts on different insertions', () => {
  const metadata = { type: 'Reference' };
  const base = document(metadata, 'alpha\nomega\n');
  const identical = mergeDocument(
    base,
    document(metadata, 'alpha\ninserted\nomega\n'),
    document(metadata, 'alpha\ninserted\nomega\n'),
  );
  assert.deepEqual(identical.conflicts, []);
  assert.equal(identical.document.body, 'alpha\ninserted\nomega\n');

  const different = mergeDocument(
    base,
    document(metadata, 'alpha\nlocal\nomega\n'),
    document(metadata, 'alpha\nremote\nomega\n'),
  );
  assert.equal(different.document, null);
  assert.ok(different.conflicts.some((conflict) => conflict.scope === 'body'));
});

test('preserves newline boundaries and treats trailing newline changes as edits', () => {
  const metadata = { type: 'Reference' };
  const independent = mergeDocument(
    document(metadata, 'one\ntwo\n'),
    document(metadata, 'ONE\ntwo\n'),
    document(metadata, 'one\ntwo'),
  );
  assert.deepEqual(independent.conflicts, []);
  assert.equal(independent.document.body, 'ONE\ntwo');

  const overlap = mergeDocument(
    document(metadata, 'one\ntwo\n'),
    document(metadata, 'one\ntwo'),
    document(metadata, 'one\nTWO\n'),
  );
  assert.equal(overlap.document, null);
  assert.ok(overlap.conflicts.some((conflict) => conflict.scope === 'body'));
});

test('merges metadata by key while treating arrays atomically', () => {
  const base = document({ type: 'Reference', title: 'Base', owner: 'docs', tags: ['base'] }, 'body\n');
  const independent = mergeDocument(
    base,
    document({ ...base.metadata, title: 'Local' }, base.body),
    document({ ...base.metadata, owner: 'platform' }, base.body),
  );
  assert.deepEqual(independent.document.metadata, { owner: 'platform', tags: ['base'], title: 'Local', type: 'Reference' });

  const arrays = mergeDocument(
    base,
    document({ ...base.metadata, tags: ['base', 'local'] }, base.body),
    document({ ...base.metadata, tags: ['base', 'remote'] }, base.body),
  );
  assert.equal(arrays.document, null);
  assert.ok(arrays.conflicts.some((conflict) => conflict.scope === 'metadata' && conflict.key === 'tags'));
});

test('merges at the LCS cell limit and conflicts just over it', () => {
  // 2048 x 2048 cells is the 16 MiB Uint32 payload limit.
  const source = Array.from({ length: 2047 }, (_, index) => `line ${index}\n`);
  const metadata = { type: 'Reference' };
  const base = document(metadata, source.join(''));
  const localLines = [...source];
  localLines[0] = 'LOCAL\n';
  const remoteLines = [...source];
  remoteLines[remoteLines.length - 1] = 'REMOTE\n';
  const local = document(metadata, localLines.join(''));
  const remote = document(metadata, remoteLines.join(''));
  const snapshots = structuredClone({ base, local, remote });

  const atLimit = mergeDocument(base, local, remote);
  assert.deepEqual(atLimit.conflicts, []);
  assert.equal(atLimit.document.body, ['LOCAL\n', ...source.slice(1, -1), 'REMOTE\n'].join(''));

  const overLimit = mergeDocument(base, document(metadata, local.body + 'extra\n'), remote);
  assert.equal(overLimit.document, null);
  assert.deepEqual(overLimit.conflicts, [{
    scope: 'body', kind: 'size-limit', sides: ['local'], maxLcsCells: 4194304,
  }]);
  assert.deepEqual({ base, local, remote }, snapshots);
});

test('merges large unchanged, identical, and one-sided bodies without LCS', () => {
  const source = Array.from({ length: 5000 }, (_, index) => `line ${index}\n`);
  const metadata = { type: 'Reference' };
  const base = document(metadata, source.join(''));
  const unchangedLocal = document(metadata, base.body);
  const unchangedRemote = document(metadata, base.body);
  const sharedLines = [...source];
  sharedLines[2500] = 'SHARED\n';
  const sharedLocal = document(metadata, sharedLines.join(''));
  const sharedRemote = document(metadata, sharedLocal.body);
  const localLines = [...source];
  localLines[0] = 'LOCAL\n';
  const oneSidedLocal = document(metadata, localLines.join(''));
  const oneSidedRemote = document(metadata, base.body);
  const snapshots = structuredClone({ base, unchangedLocal, unchangedRemote, sharedLocal, sharedRemote, oneSidedLocal, oneSidedRemote });

  for (const [local, remote, expected] of [
    [unchangedLocal, unchangedRemote, base.body],
    [sharedLocal, sharedRemote, sharedLocal.body],
    [oneSidedLocal, oneSidedRemote, oneSidedLocal.body],
    [document(metadata, base.body), oneSidedLocal, oneSidedLocal.body],
  ]) {
    const result = mergeDocument(base, local, remote);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.document.body, expected);
  }
  assert.deepEqual({ base, unchangedLocal, unchangedRemote, sharedLocal, sharedRemote, oneSidedLocal, oneSidedRemote }, snapshots);
});

test('large body fast paths still merge metadata and validate preserved fragments', () => {
  const source = Array.from({ length: 5000 }, (_, index) => `line ${index}\n`);
  source[2500] = fallback + '\n';
  const metadata = { type: 'Reference', confluence: { id: '42', version: 1, preserved: [native] } };
  const base = document(metadata, source.join(''));
  const local = document({ ...structuredClone(metadata), title: 'Local' }, base.body);
  const remote = document({ ...structuredClone(metadata), owner: 'Remote' }, base.body);
  const merged = mergeDocument(base, local, remote);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.document.metadata.title, 'Local');
  assert.equal(merged.document.metadata.owner, 'Remote');

  const forged = structuredClone(local);
  forged.metadata.confluence.preserved[0].storage = '<ac:structured-macro>FORGED</ac:structured-macro>';
  const rejected = mergeDocument(base, forged, remote);
  assert.equal(rejected.document, null);
  assert.ok(rejected.conflicts.some((conflict) => conflict.scope === 'preserved' && conflict.kind === 'modified'));
  assert.equal(JSON.stringify(rejected).includes('FORGED'), false);
});

test('divergent large concurrent edits retain structured size-limit conflicts', () => {
  const source = Array.from({ length: 5000 }, (_, index) => `line ${index}\n`);
  const metadata = { type: 'Reference' };
  const base = document(metadata, source.join(''));
  const localLines = [...source];
  localLines[0] = 'LOCAL\n';
  const remoteLines = [...source];
  remoteLines[remoteLines.length - 1] = 'REMOTE\n';
  const local = document(metadata, localLines.join(''));
  const remote = document(metadata, remoteLines.join(''));
  const snapshots = structuredClone({ base, local, remote });

  const result = mergeDocument(base, local, remote);

  assert.equal(result.document, null);
  assert.deepEqual(result.conflicts, [{ scope: 'body', kind: 'size-limit', sides: ['local', 'remote'], maxLcsCells: 4194304 }]);
  assert.deepEqual({ base, local, remote }, snapshots);
});
