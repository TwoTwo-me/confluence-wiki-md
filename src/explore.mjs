import { ApiError, ConfluenceApi } from './api.mjs';
import { readStorageSnapshot } from './evidence.mjs';
import { extractStorageLinks } from './storage-links.mjs';
import { verifyWikiRoot } from './wiki-init.mjs';

export const EXPLORE_LIMITS = Object.freeze({
  searches: 3,
  candidatesPerSearch: 10,
  pagesPerSearch: 2,
  pageReads: 12,
  depth: 2,
  outgoingPerRead: 8,
  exactTitleAttempts: 8,
  httpAttempts: 40,
  durationMs: 90_000,
  responseBytes: 1024 * 1024,
});

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function titleMismatch(snapshot, expected) {
  if (!snapshot || !expected) return null;
  if (snapshot.title !== expected.title) return 'title-changed';
  if (snapshot.space.id !== expected.space.id || snapshot.space.key !== expected.space.key) return 'title-space-changed';
  return null;
}

class BudgetError extends Error {
  constructor(limit) {
    super('Exploration budget reached: ' + limit);
    this.limit = limit;
  }
}

function frozenConfig(api) {
  const config = structuredClone(api.config);
  const { deployment, siteUrl, apiUrl, v1Url, webBase } = config;
  for (const value of [siteUrl, apiUrl, v1Url, webBase]) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || url.href.replace(/\/+$/, '') !== value) {
      throw new Error('Invalid exploration tenant URL.');
    }
  }
  const cloud = deployment === 'cloud';
  if (!['cloud', 'datacenter'].includes(deployment) ||
      webBase !== siteUrl + (cloud ? '/wiki' : '') ||
      (!cloud && apiUrl !== siteUrl + '/rest/api') ||
      (cloud && apiUrl !== siteUrl + '/wiki/api/v2' &&
        !/^https:\/\/api\.atlassian\.com\/ex\/confluence\/[a-f0-9-]{36}\/wiki\/api\/v2$/i.test(apiUrl)) ||
      v1Url !== (cloud ? apiUrl.replace(/\/api\/v2$/, '/rest/api') : apiUrl)) {
    throw new Error('Exploration requires one consistent Confluence tenant.');
  }
  return freeze(config);
}

/**
 * One provider-neutral invocation. `subqueries` are caller-authored focused text
 * queries, not CQL or instructions taken from a page. All input is copied before
 * the first request. `now` only timestamps evidence; it cannot extend the deadline.
 * The supplied API supplies configuration, not overridable/unbounded transports.
 */
export async function explore(api, {
  space, spaces = space === undefined ? [] : [space], root, question,
  subqueries = [], budgets = {}, profile = null, now = () => new Date(),
} = {}) {
  const config = frozenConfig(api);
  if (typeof question !== 'string' || !question.trim()) throw new Error('A question is required.');
  if (!/^\d+$/.test(String(root ?? ''))) throw new Error('A numeric root seed is required.');
  if (!Array.isArray(spaces) || !spaces.length ||
      spaces.some((key) => typeof key !== 'string' || !key.trim())) {
    throw new Error('Explicit trusted space keys are required.');
  }
  if (!Array.isArray(subqueries) || subqueries.some((query) => typeof query !== 'string' || !query.trim())) {
    throw new Error('Focused subqueries must be nonempty strings.');
  }
  if (profile !== null && typeof profile !== 'string') throw new Error('Profile must be a caller-selected name.');
  const limits = { ...EXPLORE_LIMITS };
  for (const [name, value] of Object.entries(budgets)) {
    if (!Object.hasOwn(limits, name) || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid exploration budget: ' + name);
    }
    limits[name] = Math.min(value, limits[name]);
  }
  const input = freeze({
    profile, root: String(root), question: question.trim(),
    spaceKeys: [...new Set(spaces.map((key) => key.trim()))],
    queries: [...new Set([question, ...subqueries].map((query) => query.trim()))],
    budgets: limits,
    tenant: { deployment: config.deployment, siteUrl: config.siteUrl, apiUrl: config.apiUrl },
  });
  const started = performance.now();
  const deadline = AbortSignal.timeout(limits.durationMs);
  const fetchRequest = globalThis.fetch;
  const usage = { searches: 0, pageReads: 0, exactTitleAttempts: 0, httpAttempts: 0 };
  const limitations = new Set();
  const budgetLimits = new Set();
  const searches = [];
  const selections = [];
  const nodes = new Map();
  const titles = new Map();
  const searchQueue = [];
  const forwardQueue = [];
  const resolvedSpaces = [];
  const rootSpaces = new Map();
  const tenantKey = JSON.stringify(input.tenant);
  let scope;
  let fatal = false;

  const checkTime = () => {
    if (deadline.aborted || performance.now() - started >= limits.durationMs) throw new BudgetError('durationMs');
  };
  const charge = (name) => {
    checkTime();
    if (usage[name] >= limits[name]) throw new BudgetError(name);
    usage[name]++;
  };
  const failure = (error) => {
    if (error.limit || deadline.aborted) {
      const limit = error.limit ?? 'durationMs';
      budgetLimits.add(limit);
      limitations.add('budget');
      if (['httpAttempts', 'durationMs'].includes(limit)) fatal = true;
      return 'budget:' + limit;
    }
    const denied = [401, 403, 404].includes(error.status);
    limitations.add(denied ? 'denied' : 'failed-read-or-discovery');
    return denied ? 'denied' : 'invalid-or-failed-response';
  };

  // Never mutate the caller's API or use its unbounded request/paginate methods.
  const client = new ConfluenceApi(config);
  client.request = async (path, { version = 2, method = 'GET' } = {}) => {
    if (method !== 'GET' || ![1, 2].includes(version) || !path.startsWith('/') ||
        path.startsWith('//') || path.split('?')[0].split('/').includes('..')) {
      throw new Error('Exploration only permits relative read requests.');
    }
    charge('httpAttempts');
    const authorization = config.auth === 'bearer' ? 'Bearer ' + config.token :
      'Basic ' + Buffer.from(config.email + ':' + config.token).toString('base64');
    const response = await fetchRequest(client.apiBase(version) + path, {
      method: 'GET', redirect: 'error', signal: deadline,
      headers: { Authorization: authorization, Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(response.status, 'GET', path);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing response body.');
    const chunks = [];
    let bytes = 0;
    let complete = false;
    try {
      if (Number(response.headers.get('content-length')) > limits.responseBytes) throw new BudgetError('responseBytes');
      while (true) {
        checkTime();
        const { value, done } = await reader.read();
        if (done) { complete = true; break; }
        bytes += value.byteLength;
        if (bytes > limits.responseBytes) throw new BudgetError('responseBytes');
        chunks.push(value);
      }
      checkTime();
      return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    } finally {
      if (!complete) await reader.cancel();
      reader.releaseLock();
    }
  };

  const discover = (id, depth, route, queue) => {
    if (!/^\d+$/.test(String(id))) {
      limitations.add('invalid-discovery');
      return null;
    }
    const key = tenantKey + ':' + id;
    let node = nodes.get(key);
    if (!node) {
      node = { id: String(id), bestDepth: depth, expandedDepth: null, status: 'pending', routes: [], edges: [] };
      nodes.set(key, node);
    }
    if (titleMismatch(node.snapshot, route.expected)) return node;
    const routeKey = JSON.stringify(route);
    if (!node.routes.some((previous) => JSON.stringify(previous) === routeKey)) node.routes.push(route);
    node.bestDepth = Math.min(node.bestDepth, depth);
    if (node.status === 'pending' || (node.status === 'read' && (node.expandedDepth === null || node.bestDepth < node.expandedDepth))) {
      if (!queue.includes(node)) queue.push(node);
    }
    return node;
  };

  const resolveTitle = async (edge) => {
    const key = JSON.stringify([tenantKey, edge.space, edge.title]);
    if (titles.has(key)) return titles.get(key);
    let result;
    try {
      charge('exactTitleAttempts');
      const query = new URLSearchParams({
        type: 'page', status: 'current', spaceKey: edge.space, title: edge.title, limit: '2', expand: 'space',
      });
      const data = await client.request('/content?' + query, { version: 1 });
      const entries = data.results;
      const match = Array.isArray(entries) && entries.length === 1 ? entries[0] : null;
      const trustedSpace = resolvedSpaces.find((item) => item.key === edge.space);
      if (!match || data._links?.next || (data.totalSize ?? data.size ?? 1) > 1 ||
          match.title !== edge.title || !/^\d+$/.test(String(match.id)) ||
          (match.space?.key !== undefined && match.space.key !== edge.space) ||
          (match.space?.id !== undefined && String(match.space.id) !== trustedSpace.id)) {
        limitations.add('unresolved-title');
        result = { reason: 'ambiguous-or-unresolved-title' };
      } else result = { id: String(match.id) };
    } catch (error) {
      result = { reason: failure(error) };
    }
    titles.set(key, result);
    return result;
  };

  const expand = async (node) => {
    if (!node.routes.length) return;
    if (node.expandedDepth !== null && node.expandedDepth <= node.bestDepth) return;
    node.expandedDepth = node.bestDepth;
    const route = node.routes.find((item) => item.depth === node.bestDepth);
    for (const edge of node.edges) {
      if (!edge.admitted) continue;
      edge.depth = node.bestDepth + 1;
      if (edge.depth > limits.depth) {
        edge.reason = 'budget:depth';
        budgetLimits.add('depth');
        limitations.add('budget');
        continue;
      }
      if (fatal) { edge.reason = 'invocation-stopped'; continue; }
      const target = edge.id ? { id: edge.id } : await resolveTitle(edge);
      if (!target.id) { edge.reason = target.reason; continue; }
      edge.reason = null;
      edge.target = discover(target.id, edge.depth, {
        kind: 'forward', depth: edge.depth, sourceId: node.id, sourceVersion: node.snapshot.version,
        path: [...route.path, target.id], locations: edge.locations,
        ...(edge.expected ? { expected: edge.expected } : {}),
      }, forwardQueue);
    }
  };

  const visit = async (node, frontier) => {
    const cached = node.status === 'read';
    selections.push({ frontier, id: node.id, depth: node.bestDepth, operation: cached ? 'expand' : 'read' });
    if (!cached) {
      try {
        charge('pageReads');
        const page = await client.getPage(node.id);
        if (page.raw?.type !== undefined && page.raw.type !== 'page') throw new Error('Linked content is not a page.');
        const selectedSpace = resolvedSpaces.find((item) => item.id === page.spaceId);
        if (!selectedSpace) throw new Error('Page is outside the frozen spaces.');
        node.snapshot = await readStorageSnapshot({
          config,
          getSpace: async () => selectedSpace,
          getPage: async () => page,
          pageUrl: (id) => client.pageUrl(id),
        }, node.id, { space: selectedSpace.key, now });
        if (node.id === input.root) {
          await verifyWikiRoot(client, node.snapshot, rootSpaces.get(selectedSpace.id));
        }
        checkTime();
        // Lookup metadata is only a candidate identity. Recheck it against the
        // current body before using the route or its depth to expand descendants.
        node.routes = node.routes.filter((route) => !titleMismatch(node.snapshot, route.expected));
        node.bestDepth = Math.min(...node.routes.map((route) => route.depth));
        const extracted = extractStorageLinks(node.snapshot);
        const edges = [...extracted.links, ...extracted.unresolved].sort((a, b) => a.locations[0].index - b.locations[0].index);
        node.edges = edges.map((edge, index) => ({
          ...edge, admitted: index < limits.outgoingPerRead,
          ...(edge.title ? { expected: freeze({
            title: edge.title, space: resolvedSpaces.find((item) => item.key === edge.space),
          }) } : {}),
          reason: index < limits.outgoingPerRead ? null : 'budget:outgoingPerRead',
          materiality: /correct|supersed|amend|retract|errat/i.test(
            [edge.title ?? '', ...edge.locations.map((location) => location.label ?? '')].join(' '),
          ) ? 'possible-correction' : 'unassessed',
        }));
        if (edges.length > limits.outgoingPerRead) {
          limitations.add('budget');
          budgetLimits.add('outgoingPerRead');
        }
        if (node.snapshot.warnings.length || node.snapshot.preserved.length) limitations.add('incomplete-extraction');
        node.status = 'read';
      } catch (error) {
        node.status = 'unresolved';
        node.reason = failure(error);
        delete node.snapshot;
        return;
      }
    }
    await expand(node);
  };
  const useful = (queue) => {
    while (queue.length) {
      const node = queue[0];
      if (node.status === 'pending' || (node.status === 'read' && node.routes.length &&
          (node.expandedDepth === null || node.bestDepth < node.expandedDepth))) return true;
      queue.shift();
    }
    return false;
  };

  try {
    for (const key of input.spaceKeys) {
      const result = await client.getSpace(key);
      if (result?.key !== key || !/^\d+$/.test(String(result.id))) throw new Error('Space did not resolve exactly.');
      if (resolvedSpaces.some((item) => item.id === String(result.id))) throw new Error('Space identities are ambiguous.');
      resolvedSpaces.push(freeze({ key, id: String(result.id) }));
      rootSpaces.set(String(result.id), freeze(result));
    }
    scope = freeze({ ...input, spaces: [...resolvedSpaces] });
    const seed = discover(input.root, 0, { kind: 'root', depth: 0, path: [input.root] }, forwardQueue);
    forwardQueue.shift();
    await visit(seed, 'root');
    const queryQueue = input.queries.flatMap((query) => resolvedSpaces.map((item) => ({ query, space: item.key })));
    let turn = 'search';
    while (!fatal) {
      checkTime();
      const forwardReady = useful(forwardQueue);
      const searchReady = useful(searchQueue) || queryQueue.length > 0;
      if (!searchReady && !forwardReady) break;
      const frontier = (turn === 'search' && searchReady) || !forwardReady ? 'search' : 'forward';
      turn = frontier === 'search' ? 'forward' : 'search';
      if (frontier === 'forward') {
        await visit(forwardQueue.shift(), frontier);
        continue;
      }
      if (useful(searchQueue)) {
        await visit(searchQueue.shift(), frontier);
        continue;
      }
      const search = queryQueue.shift();
      try {
        if (!limits.candidatesPerSearch || !limits.pagesPerSearch) {
          throw new BudgetError(!limits.candidatesPerSearch ? 'candidatesPerSearch' : 'pagesPerSearch');
        }
        charge('searches');
        const result = await client.searchScoped(search.query, {
          space: search.space, limit: limits.candidatesPerSearch, maxPages: limits.pagesPerSearch,
        });
        searches.push({ ...search, truncated: result.truncated, candidateIds: result.results.map((item) => item.id) });
        if (result.truncated) limitations.add('truncated-search');
        for (const candidate of result.results) {
          discover(candidate.id, 0, { kind: 'search', depth: 0, path: [candidate.id], ...search }, searchQueue);
        }
        if (useful(searchQueue)) await visit(searchQueue.shift(), 'search');
      } catch (error) {
        searches.push({ ...search, reason: failure(error), candidateIds: [] });
        if (error.limit === 'searches' || !limits.candidatesPerSearch || !limits.pagesPerSearch) queryQueue.length = 0;
      }
    }
  } catch (error) {
    failure(error);
  }

  const evidence = [];
  const unresolved = [];
  const links = [];
  for (const node of nodes.values()) {
    if (node.status !== 'read' || !node.routes.length) {
      unresolved.push({ id: node.id, reason: node.reason ?? (node.snapshot ? 'title-target-changed' : 'invocation-stopped'), routes: node.routes });
      continue;
    }
    for (const edge of node.edges) {
      const { target, admitted, ...link } = edge;
      const reason = edge.reason ?? titleMismatch(target?.snapshot, edge.expected) ?? (target?.status === 'read' ? null :
        target?.reason ?? 'invocation-stopped');
      links.push({ ...link, targetId: target?.id ?? edge.id ?? null, status: reason ? 'unresolved' : 'read', reason });
    }
    const snapshot = node.snapshot;
    const passages = [];
    let qualifier = null;
    for (const block of snapshot.markdown.trim().split(/\n{2,}/)) {
      if (!block) continue;
      const heading = block.match(/^#{1,6}\s+(.+)$/);
      if (heading) qualifier = heading[1].trim();
      else passages.push({ text: block, qualifier });
    }
    evidence.push({ ...snapshot, passages, routes: node.routes, bestDepth: node.bestDepth, expandedDepth: node.expandedDepth });
  }
  const unresolvedLinks = links.filter((link) => link.status === 'unresolved');
  for (const item of evidence) {
    item.unresolvedLinks = unresolvedLinks.filter((link) => link.sourceId === item.id);
    item.claimsStatus = item.unresolvedLinks.length ? 'unresolved-dependencies' : 'unassessed';
  }
  if (unresolvedLinks.length || unresolved.length) limitations.add('unresolved-targets');
  const stopReason = limitations.has('budget') ? 'budget' : limitations.has('denied') ? 'denied' :
    limitations.has('failed-read-or-discovery') ? 'incomplete' : 'exhausted';
  limitations.add(stopReason);
  return {
    scope: scope ?? freeze({ ...input, spaces: [...resolvedSpaces] }),
    evidence, links, unresolved, unresolvedLinks,
    materialCorrectionLinks: links.filter((link) => link.materiality === 'possible-correction'),
    searches, selections, usage: { ...usage, elapsedMs: performance.now() - started },
    stopReason, budgetLimits: [...budgetLimits],
    coverage: {
      limitations: [...limitations], atomicSnapshot: false, crossInvocationBudget: false, sufficient: null,
      notes: [
        'Evidence is current at each read, not an atomic cross-page snapshot.',
        'Exhausted queues, denials, extraction gaps and budget stops do not establish that no other pages exist.',
        'Search ranking and root proximity are discovery hints, not authority or proof.',
        'The host must assess claim support and all unresolved dependencies; correction labels are only hints.',
        'Limits apply only to this invocation. Separate invocations do not share a per-question cap.',
      ],
    },
  };
}
