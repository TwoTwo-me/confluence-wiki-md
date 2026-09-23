import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export async function collaborationServer(t, deployment = 'cloud') {
  const dir = await mkdtemp(path.join(tmpdir(), 'cfwiki-collaboration-'));
  const calls = []; const comments = new Map(); const pages = new Map([['42', { id: '42', title: 'Existing', type: 'page', authorId: 'creator', status: 'current', spaceId: '1', space: { id: '1', key: 'TEST' }, version: { number: 1 }, body: { storage: { value: '<p>Body</p>' } }, history: { createdBy: { username: 'creator' } } }]]);
  const acls = new Map(); let sequence = 100;
  const state = { denied: 0 };
  const empty = () => ({ read: { users: [], groups: [] }, update: { users: [], groups: [] } });
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const url = new URL(req.url, 'http://localhost');
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization?.split(' ')[0] });
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
    if (state.denied) return send(state.denied, { secret: 'server-secret-do-not-emit' });
    if (url.pathname.endsWith('/user/current')) return send(200, { accountId: 'actor', username: 'actor' });
    if (url.pathname.endsWith('/spaces')) return send(200, { results: [{ id: '1', key: 'TEST', name: 'Test' }] });
    if (url.pathname.endsWith('/space/TEST')) return send(200, { id: '1', key: 'TEST', name: 'Test' });
    const restricted = url.pathname.match(/\/content\/(\d+)\/restriction(?:\/byOperation\/(read|update))?$/);
    if (restricted) {
      const id = restricted[1]; const operation = restricted[2];
      if (operation) {
        const acl = (acls.get(id) ?? empty())[operation];
        return send(200, { operation, restrictions: { user: { results: acl.users.map((id) => ({ accountId: id, username: id })), start: 0, limit: 100, size: acl.users.length }, group: { results: acl.groups.map((id) => ({ id, name: id })), start: 0, limit: 100, size: acl.groups.length } } });
      }
      const acl = empty();
      if (req.method === 'PUT') for (const item of body) acl[item.operation] = { users: (item.restrictions.user ?? []).map((user) => user.accountId ?? user.username), groups: (item.restrictions.group ?? []).map((group) => group.id ?? group.name) };
      acls.set(id, acl); return send(200, {});
    }
    if (/\/(?:properties|label|labels|attachment|attachments)$/.test(url.pathname)) return send(200, { results: [] });
    if (url.pathname.includes('/property')) return send(req.method === 'GET' ? 404 : 200, {});
    const collection = url.pathname.match(/\/pages\/(\d+)\/(footer|inline)-comments$/);
    const children = url.pathname.match(/\/(footer|inline)-comments\/(\d+)\/children$/);
    if (collection || children || url.pathname.endsWith('/child/comment')) return send(200, { results: [...comments.values()].filter((item) => children ? item.parentCommentId === children[2] : !item.parentCommentId) });
    const commentPath = url.pathname.match(/\/(footer|inline)-comments(?:\/(\d+))?$/);
    const dcComment = deployment === 'datacenter' && (body?.type === 'comment' || comments.has(url.pathname.split('/').at(-1)));
    if (commentPath || dcComment) {
      const id = commentPath?.[2] ?? url.pathname.split('/').at(-1);
      if (req.method === 'GET') return send(comments.has(id) ? 200 : 404, comments.get(id) ?? {});
      if (req.method === 'DELETE') { comments.delete(id); return send(204); }
      const key = req.method === 'POST' ? String(++sequence) : id; const old = comments.get(key) ?? {};
      const item = { ...old, id: key, type: 'comment', pageId: body.pageId ?? body.container?.id ?? old.pageId, parentCommentId: body.parentCommentId ?? old.parentCommentId, version: { ...body.version, number: body.version?.number ?? 1, authorId: 'quoted:\nname' }, body: { storage: { value: body.body.value ?? body.body.storage.value } }, ...(deployment === 'datacenter' ? { extensions: { location: 'footer' } } : {}), ...(body.resolved !== undefined ? { resolutionStatus: body.resolved ? 'resolved' : 'open' } : {}) };
      comments.set(key, item); return send(200, item);
    }
    const page = url.pathname.match(/\/(?:pages|content)(?:\/(\d+))?$/);
    if (page) {
      const id = page[1];
      if (req.method === 'GET') return send(pages.has(id) ? 200 : 404, pages.get(id) ?? {});
      if (req.method === 'DELETE') { pages.delete(id); return send(204); }
      const key = id ?? String(++sequence);
      const value = { ...(pages.get(key) ?? {}), ...body, id: key, type: 'page', authorId: 'actor', history: { createdBy: { username: 'actor' } }, status: 'current', version: body.version ?? { number: 1 }, space: { id: '1', key: 'TEST' }, spaceId: '1', body: { storage: { value: body.body.value ?? body.body.storage.value } } };
      pages.set(key, value);
      if (url.searchParams.get('private') === 'true') acls.set(key, { read: { users: ['actor'], groups: [] }, update: { users: ['actor'], groups: [] } });
      return send(200, value);
    }
    send(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const profile = path.join(dir, 'profile.env');
  await writeFile(profile, ['CONFLUENCE_SITE_URL=' + base, 'CONFLUENCE_API_URL=' + base + (deployment === 'cloud' ? '/wiki/api/v2' : '/rest/api'), 'CONFLUENCE_API_V1_URL=' + base + '/rest/api', 'CONFLUENCE_DEPLOYMENT=' + deployment, 'CONFLUENCE_EMAIL=test@example.test', 'CONFLUENCE_API_TOKEN=synthetic', 'CONFLUENCE_ALLOW_HTTP=true', 'CONFLUENCE_SPACE_KEY=TEST', 'CONFLUENCE_TEMPLATE=none', 'CONFLUENCE_DIAGRAM_MODE=code'].join('\n'));
  async function cli(args, input = '') {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CONFLUENCE_') && key !== 'XDG_CONFIG_HOME'));
    env.XDG_CONFIG_HOME = dir;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/confluence.mjs', ...args, '--env', profile], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr })); child.stdin.end(input);
    });
  }
  return { cli, dir, calls, comments, pages, acls, state, profile };
}
