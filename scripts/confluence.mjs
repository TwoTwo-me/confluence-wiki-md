#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runCli } from '../src/cli.mjs';
import { loadProfile } from '../src/env.mjs';

const statePath = new URL('../.confluence-dev.json', import.meta.url);
const reportPath = new URL('../artifacts/smoke-test.json', import.meta.url);

export function readConfig(env) {
  const required = ['CONFLUENCE_SITE_URL', 'CONFLUENCE_EMAIL', 'CONFLUENCE_CLOUD_ID', 'CONFLUENCE_SPACE_KEY', 'CONFLUENCE_API_TOKEN'];
  for (const key of required) {
    if (!env[key]?.trim()) throw new Error(`Missing ${key}. Configure ~/.config/cfwiki/.env or select a Cloud profile with --env.`);
  }
  const site = new URL(env.CONFLUENCE_SITE_URL);
  if (site.protocol !== 'https:' || !site.hostname.endsWith('.atlassian.net') || site.username || site.password || site.port || site.search || site.hash || site.pathname !== '/') {
    throw new Error('CONFLUENCE_SITE_URL must be an HTTPS Atlassian site origin.');
  }
  const cloudId = env.CONFLUENCE_CLOUD_ID.trim();
  if (!/^[a-f0-9-]{36}$/i.test(cloudId)) throw new Error('CONFLUENCE_CLOUD_ID must be the site cloud UUID.');
  return {
    siteUrl: site.origin,
    apiBase: `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2`,
    email: env.CONFLUENCE_EMAIL.trim(),
    token: env.CONFLUENCE_API_TOKEN.trim(),
    spaceKey: env.CONFLUENCE_SPACE_KEY.trim(),
  };
}

export function createClient({ apiBase, email, token }) {
  const authorization = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  return async (path, { method = 'GET', body } = {}) => {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Expected a relative API path.');
    const response = await fetch(`${apiBase}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: authorization, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const hints = {
        400: 'Check the request body and page version.',
        401: 'Check the email, token, expiration, and cloud ID.',
        403: 'Check token scopes and space permissions.',
        404: 'Check the page/space ID and account access.',
        409: 'The page changed concurrently. Read it again before updating.',
        429: 'Rate limit reached. Retry after the server Retry-After interval.',
      };
      throw new Error(`${method} ${path.split('?')[0]}: HTTP ${response.status}. ${hints[response.status] ?? 'Check Atlassian service availability.'}`);
    }
    return response.json();
  };
}

export async function verifyPageUpdate(client, pageId, spaceId, storage, marker) {
  const path = `/pages/${encodeURIComponent(pageId)}`;
  const current = await client(`${path}?body-format=storage`);
  if (current.spaceId !== spaceId) throw new Error('Refusing to update a page outside the configured space.');
  if (!Number.isInteger(current.version?.number)) throw new Error('Page response is missing its version number.');
  const expectedVersion = current.version.number + 1;
  await client(path, {
    method: 'PUT',
    body: {
      id: pageId,
      status: 'current',
      title: current.title,
      body: { representation: 'storage', value: storage },
      version: { number: expectedVersion, message: 'Development API read/write verification' },
    },
  });
  const updated = await client(`${path}?body-format=storage`);
  if (updated.version?.number !== expectedVersion || !updated.body?.storage?.value?.includes(marker)) {
    throw new Error('Read-back verification failed: content or version differs from the update.');
  }
  return updated;
}

async function findSpace(client, key) {
  const data = await client(`/spaces?keys=${encodeURIComponent(key)}`);
  const space = data.results?.find((item) => item.key === key);
  if (!space) throw new Error(`Space ${key} is not visible to this account. Create the test space first.`);
  return space;
}

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function smoke(config, client, space) {
  let state = await loadState();
  if (state && (state.siteUrl !== config.siteUrl || state.spaceId !== space.id)) {
    throw new Error('Saved test page belongs to another site or space. Review .confluence-dev.json before continuing.');
  }
  const runId = crypto.randomUUID();
  const createdMarker = `created-${runId}`;
  let created = false;
  if (!state) {
    const page = await client('/pages', {
      method: 'POST',
      body: {
        spaceId: space.id,
        status: 'current',
        title: `Agent API development check ${runId.slice(0, 8)}`,
        body: { representation: 'storage', value: `<h1>API development environment</h1><p>${createdMarker}</p>` },
      },
    });
    state = { siteUrl: config.siteUrl, spaceId: space.id, pageId: page.id };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    const readBack = await client(`/pages/${encodeURIComponent(page.id)}?body-format=storage`);
    if (!readBack.body?.storage?.value?.includes(createdMarker)) throw new Error('Created page did not contain the expected content.');
    created = true;
  }
  const marker = `verified-${runId}`;
  const storage = `<h1>Confluence agent development environment</h1>
<p>Local API authentication, page reading, and versioned updates are working.</p>
<h2>Verified operations</h2>
<ul><li>Scoped API token authentication</li><li>Space and page reads</li><li>Page creation and updates</li></ul>
<table><tbody><tr><th>Check</th><th>Result</th></tr><tr><td>Read/write round trip</td><td>Passed</td></tr></tbody></table>
<h2>Unicode check</h2><p>마크다운 위키 개발환경: 한글 표시 확인</p>
<p><strong>Verification marker:</strong> <code>${marker}</code></p>
<p>Next step: connect a Markdown-to-Confluence converter.</p>`;
  const page = await verifyPageUpdate(client, state.pageId, space.id, storage, marker);
  const report = {
    checkedAt: new Date().toISOString(),
    siteUrl: config.siteUrl,
    space: { id: space.id, key: space.key, name: space.name },
    pageId: page.id,
    pageUrl: `${config.siteUrl}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(page.id)}`,
    version: page.version.number,
    checks: { create: created ? 'passed' : 'reused existing test page', read: 'passed', update: 'passed', readBack: 'passed' },
    marker,
  };
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

async function main(args) {
  if (args[0] !== 'smoke') return runCli(args);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { env: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) return runCli(['--help']);
  if (positionals.length !== 1) throw new Error('Usage: cfwiki smoke [--env FILE]');
  const config = readConfig(await loadProfile(values.env));
  const client = createClient(config);
  const space = await findSpace(client, config.spaceKey);
  await smoke(config, client, space);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
