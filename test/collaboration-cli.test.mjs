import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile, symlink, mkdir } from 'node:fs/promises';
import { parseDocument } from '../src/document.mjs';
import { collaborationServer } from './helpers/collaboration-server.mjs';

const good = (result) => { assert.equal(result.code, 0, result.stderr); return result; };
for (const deployment of ['cloud', 'datacenter']) test('CLI collaboration: lifecycle ' + deployment, async (t) => {
  const f = await collaborationServer(t, deployment);
  const source = path.join(f.dir, 'comment.md'); await writeFile(source, '한글 **comment**\n');
  const created = JSON.parse(good(await f.cli(['comments', 'create', '42', source, '--json'])).stdout);
  const saved = parseDocument(await readFile(source, 'utf8'));
  assert.equal(saved.metadata.confluence_comment.id, created.id); assert.equal(saved.metadata.confluence_comment.author_id, 'quoted:\nname');
  const read = good(await f.cli(['comments', 'read', created.id])); assert.match(read.stdout, /confluence_comment:/);
  assert.doesNotMatch(good(await f.cli(['comments', 'read', created.id, '--body-only'])).stdout, /confluence_comment:/);
  good(await f.cli(['comments', 'update', created.id, source, '--version', '1']));
  assert.equal(parseDocument(await readFile(source, 'utf8')).metadata.confluence_comment.version, 2);
  assert.equal(JSON.parse(good(await f.cli(['comments', 'list', '42', '--json'])).stdout).length, 1);
  if (deployment === 'cloud') {
    const reply = JSON.parse(good(await f.cli(['comments', 'reply', created.id, '-', '--json'], 'reply')).stdout);
    assert.equal(reply.parentCommentId, created.id);
    assert.equal(JSON.parse(good(await f.cli(['comments', 'replies', created.id, '--json'])).stdout)[0].id, reply.id);
    const inline = JSON.parse(good(await f.cli(['comments', 'create', '42', '-', '--kind', 'inline', '--selection', 'Body', '--selection-count', '1', '--selection-index', '0', '--json'], 'inline')).stdout);
    const resolved = JSON.parse(good(await f.cli(['comments', 'resolve', inline.id, '--kind', 'inline', '--resolved', 'true', '--version', '1', '--json'])).stdout);
    assert.equal(resolved.resolved, true);
    good(await f.cli(['comments', 'resolve', inline.id, '--kind', 'inline', '--resolved', 'false', '--version', '2']));
  }
  const deleted = good(await f.cli(['comments', 'delete', created.id, '--version', '2', '--yes']));
  assert.match(deleted.stdout, /deleted/i); assert.doesNotMatch(deleted.stdout, /trash/i);
  for (const mode of ['view-edit', 'edit', 'none']) {
    const value = JSON.parse(good(await f.cli(['restrictions', 'set', '42', '--restrictions', mode, '--json'])).stdout); assert.equal(value.mode, mode);
    assert.equal(JSON.parse(good(await f.cli(['restrictions', 'get', '42', '--json'])).stdout).mode, mode);
  }
  const allowed = JSON.parse(good(await f.cli(['restrictions', 'set', '42', '--restrictions', 'view-edit', '--read-user', 'reader-a', '--read-user', 'reader-b', '--edit-group', 'editors', '--json'])).stdout);
  assert.deepEqual(allowed.read.users, ['actor', 'creator', 'reader-a', 'reader-b']);
  assert.deepEqual(allowed.read.groups, ['editors']);
  assert.ok(f.calls.every((call) => call.auth === (deployment === 'cloud' ? 'Basic' : 'Bearer')));
});

test('CLI collaboration: rejects unsafe input', async (t) => {
  const f = await collaborationServer(t);
  for (const args of [
    ['comments', 'delete', '42', '--version', '1'], ['comments', 'update', '42', '-'], ['comments', 'read', '42', 'extra'],
    ['comments', 'read', '42', '--template', 'none'], ['comments', 'read', '42', '--title', 'x'], ['comments', 'read', '42', '--kind', 'typo'],
    ['comments', 'create', '42', '-', '--kind', 'inline', '--selection', 'Body', '--selection-count', '1', '--selection-index', '1'],
    ['comments', 'resolve', '42', '--version', '1', '--resolved', 'true'], ['comments', 'resolve', '42', '--kind', 'inline', '--version', '1', '--resolved', 'yes'],
    ['restrictions', 'set', '42'], ['restrictions', 'get', '42', '--restrictions', 'none'], ['upload', '-', '--read-user', 'someone'],
    ['read', '42', '--restrictions', 'none'], ['restrictions', 'set', '42', '--restrictions', 'edit', '--read-user', 'someone'],
    ['comments', 'update', '42', '-', '--version', '1e2'], ['comments', 'create', '42', '-', '--selection-index', '0'],
  ]) { const result = await f.cli(args, 'body'); assert.notEqual(result.code, 0, args.join(' ')); }
  assert.equal(f.calls.length, 0);
  assert.match((await f.cli(['comments', 'delete', '42', '--version', '1'])).stderr, /comments delete requires --yes/);
  assert.match((await f.cli(['comments', 'update', '42', '-'], 'body')).stderr, /comments update requires --version/);
  assert.match((await f.cli(['comments', 'create', '42', '-'], '   ')).stderr, /body must not be empty/);
  assert.equal(f.calls.length, 0);
  const root = JSON.parse(good(await f.cli(['comments', 'create', '42', '-', '--json'], 'body')).stdout);
  const before = f.calls.filter((c) => c.method !== 'GET').length;
  assert.notEqual((await f.cli(['comments', 'update', root.id, '-', '--version', '99'], 'body')).code, 0);
  const file = path.join(f.dir, 'occupied.md'); await writeFile(file, 'body');
  assert.notEqual((await f.cli(['comments', 'create', '42', '-', '--output', file], 'body')).code, 0);
  assert.notEqual((await f.cli(['comments', 'create', '42', file, '--output', file, '--overwrite'])).code, 0);
  const alias = path.join(f.dir, 'alias.md'); await symlink(file, alias);
  assert.notEqual((await f.cli(['comments', 'create', '42', file, '--output', alias, '--overwrite'])).code, 0);
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, before);
  f.state.denied = 401; const denied = await f.cli(['comments', 'list', '42']); assert.notEqual(denied.code, 0); assert.match(denied.stderr, /HTTP 401/); assert.doesNotMatch(denied.stderr, /server-secret/);
});

test('CLI collaboration: rejects unsafe input Data Center unsupported writes', async (t) => {
  const f = await collaborationServer(t, 'datacenter');
  for (const args of [
    ['comments', 'reply', '42', '-'],
    ['comments', 'create', '42', '-', '--kind', 'inline', '--selection', 'Body', '--selection-count', '1', '--selection-index', '0'],
    ['comments', 'delete', '42', '--kind', 'inline', '--version', '1', '--yes'],
  ]) { const value = await f.cli(args, 'body'); assert.notEqual(value.code, 0); assert.match(value.stderr, /Data Center .* is not supported/); }
  assert.equal(f.calls.length, 0);
});

for (const deployment of ['cloud', 'datacenter']) test('CLI collaboration: lifecycle protected upload and push ' + deployment, async (t) => {
  const f = await collaborationServer(t, deployment);
  const file = path.join(f.dir, 'private.md'); await writeFile(file, '---\ntitle: Confidential title\n---\nConfidential body');
  good(await f.cli(['upload', file]));
  const doc = parseDocument(await readFile(file, 'utf8')); const id = doc.metadata.confluence.id;
  assert.deepEqual(f.acls.get(id).read.users, ['actor']);
  const create = f.calls.find((call) => call.method === 'POST' && /\/(pages|content)$/.test(call.path));
  if (deployment === 'cloud') assert.equal(create.query.private, 'true');
  else {
    assert.match(create.body.title, /^cfwiki-pending-/); assert.doesNotMatch(JSON.stringify(create.body), /Confidential/);
    const finalWrite = f.calls.findIndex((call) => call.method === 'PUT' && call.body?.title === 'Confidential title');
    const aclRead = f.calls.findIndex((call) => call.path.endsWith('/restriction/byOperation/update'));
    assert.ok(aclRead >= 0 && aclRead < finalWrite);
  }
  const before = f.calls.length;
  good(await f.cli(['upload', file]));
  assert.equal(f.calls.slice(before).filter((call) => /\/restriction/.test(call.path) && call.method !== 'GET').length, 0);
  assert.notEqual((await f.cli(['upload', file, '--restrictions', 'none'])).code, 0);
  const bundle = path.join(f.dir, 'bundle'); await mkdir(bundle);
  await writeFile(path.join(bundle, 'old.md'), await readFile(file, 'utf8'));
  await writeFile(path.join(bundle, 'new.md'), '---\ntitle: New bundle page\n---\nNew body');
  const pushStart = f.calls.length; good(await f.cli(['push', bundle]));
  const newDoc = parseDocument(await readFile(path.join(bundle, 'new.md'), 'utf8'));
  assert.deepEqual(f.acls.get(newDoc.metadata.confluence.id).read.users, ['actor']);
  assert.equal(f.calls.slice(pushStart).filter((call) => call.path === '/rest/api/content/' + id + '/restriction' && call.method !== 'GET').length, 0);
  const shared = JSON.parse(good(await f.cli(['upload', '-', '--title', 'Shared', '--restrictions', 'none', '--json'], 'shared')).stdout);
  assert.equal(f.acls.get(shared.metadata.confluence.id), undefined);
});
