import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createClient, readConfig, verifyPageUpdate } from '../scripts/confluence.mjs';

test('configuration fails before requesting an unconfigured environment', () => {
  assert.throws(() => readConfig({}), /CONFLUENCE_SITE_URL/);
});

test('API calls authenticate, encode JSON, and preserve optimistic versioning', async (t) => {
  const requests = [];
  let version = 7;
  let body = '<p>original</p>';
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    if (req.method === 'PUT') {
      const update = JSON.parse(raw);
      if (update.version.number !== version + 1) {
        res.writeHead(409).end();
        return;
      }
      version = update.version.number;
      body = update.body.value;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: '42', spaceId: '12', title: 'Integration test', version: { number: version }, body: { storage: { value: body } } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = createClient({ apiBase: `http://127.0.0.1:${server.address().port}`, email: 'test@example.com', token: 'local-test-token' });
  const result = await verifyPageUpdate(client, '42', '12', '<p>updated &amp; verified</p>', 'updated');
  assert.equal(result.version.number, 8);
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'PUT', 'GET']);
  assert.ok(requests.every((request) => request.auth === `Basic ${Buffer.from('test@example.com:local-test-token').toString('base64')}`));
  assert.equal(requests[1].body.id, '42');
  assert.equal(requests[1].body.version.number, 8);
  assert.equal(requests[1].body.body.representation, 'storage');
});

test('verification refuses to update a page outside the configured space', async () => {
  let calls = 0;
  const client = async () => {
    calls++;
    return { id: '42', spaceId: 'different-space' };
  };
  await assert.rejects(verifyPageUpdate(client, '42', '12', '<p>x</p>', 'x'), /space/);
  assert.equal(calls, 1);
});

test('HTTP errors do not echo server responses containing secrets', async () => {
  const server = createServer((_req, res) => res.writeHead(401).end('local-test-token'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = createClient({ apiBase: `http://127.0.0.1:${server.address().port}`, email: 'test@example.com', token: 'local-test-token' });
    await assert.rejects(client('/spaces'), (error) => /401/.test(error.message) && !error.message.includes('local-test-token'));
  } finally {
    server.close();
  }
});
