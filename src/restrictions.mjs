const numericId = (value) => {
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error('Page ID must be numeric and positive.');
  return String(value);
};
const sorted = (values) => [...new Set(values)].sort();
const identifier = (value) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);

export function restrictionPolicy({ mode = 'view-edit', readUsers = [], readGroups = [], editUsers = [], editGroups = [] } = {}) {
  if (!['none', 'edit', 'view-edit'].includes(mode)) throw new Error('Restrictions must be none, edit, or view-edit.');
  for (const list of [readUsers, readGroups, editUsers, editGroups]) {
    if (!Array.isArray(list) || list.some((value) => !identifier(value))) throw new Error('Restriction users/groups must be non-empty identifiers without control characters.');
  }
  if (mode === 'none' && [readUsers, readGroups, editUsers, editGroups].some((list) => list.length)) throw new Error('none restrictions cannot have user/group allowlists.');
  if (mode === 'edit' && (readUsers.length || readGroups.length)) throw new Error('edit restrictions cannot have read allowlists.');
  return { mode, readUsers: sorted(readUsers), readGroups: sorted(readGroups), editUsers: sorted(editUsers), editGroups: sorted(editGroups) };
}

function userId(api, user) {
  const value = api.config.deployment === 'cloud' ? user?.accountId : user?.username;
  if (!identifier(value)) throw new Error('Confluence did not return a usable ' + (api.config.deployment === 'cloud' ? 'account ID' : 'username') + '.');
  return value;
}

export async function currentUser(api) {
  return userId(api, await api.request('/user/current', { version: 1 }));
}

export async function pageCreator(api, pageId) {
  const id = numericId(pageId);
  if (api.config.deployment === 'cloud') {
    const page = await api.request('/pages/' + id);
    if (String(page.id) !== id || !identifier(page.authorId)) throw new Error('Confluence did not return the requested page creator.');
    return page.authorId;
  }
  const page = await api.request('/content/' + id + '?expand=history.createdBy', { version: 1 });
  if (String(page.id) !== id || page.type !== 'page') throw new Error('Restrictions require an accessible page.');
  return userId(api, page.history?.createdBy);
}

function validateNext(api, link, resource, start) {
  if (!link) return;
  const url = new URL(link, api.config.v1Url + '/');
  const bases = [api.config.v1Url, api.config.webBase].map((value) => new URL(value));
  if (!bases.some((base) => base.origin === url.origin) || !url.pathname.endsWith(resource) || url.username || url.password || url.hash) throw new Error('Unsafe restriction pagination URL.');
  const next = Number(url.searchParams.get('start'));
  if (!Number.isSafeInteger(next) || next <= start) throw new Error('Restriction pagination did not advance.');
}

async function operationRestrictions(api, id, operation) {
  const resource = '/content/' + id + '/restriction/byOperation/' + operation;
  const result = { users: [], groups: [] };
  const seen = new Set();
  let start = 0;
  for (;;) {
    const value = await api.request(resource + '?start=' + start + '&limit=100', { version: 1 });
    if (value.operation !== operation) throw new Error('Malformed restriction operation returned by Confluence.');
    const progress = [];
    for (const [kind, output] of [['user', 'users'], ['group', 'groups']]) {
      const collection = value.restrictions?.[kind];
      if (!collection || !Array.isArray(collection.results)) throw new Error('Incomplete restrictions: missing expanded ' + kind + ' results.');
      const offset = collection.start ?? start;
      const limit = collection.limit ?? 100;
      const size = collection.size ?? collection.results.length;
      if (!Number.isSafeInteger(offset) || offset !== start || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(size) || size !== collection.results.length || size > limit) throw new Error('Malformed restriction pagination metadata.');
      validateNext(api, collection._links?.next, resource, start);
      const ids = collection.results.map((subject) => kind === 'user' ? userId(api, subject) : api.config.deployment === 'cloud' ? subject.id : subject.name);
      if (ids.some((subject) => !identifier(subject))) throw new Error('Malformed restriction principal returned by Confluence.');
      result[output].push(...ids);
      if (size === limit || collection._links?.next) progress.push(limit);
    }
    validateNext(api, value._links?.next, resource, start);
    if (!progress.length && !value._links?.next) break;
    const signature = JSON.stringify([value.restrictions.user.results, value.restrictions.group.results]);
    if (seen.has(signature)) throw new Error('Restriction pagination repeated results; refusing an incomplete ACL.');
    seen.add(signature);
    start += progress.length ? Math.min(...progress) : 100;
    if (start > 1_000_000) throw new Error('Restriction pagination exceeded the safety bound; no truncated ACL was returned.');
  }
  return { users: sorted(result.users), groups: sorted(result.groups) };
}

export async function getRestrictions(api, pageId) {
  const id = numericId(pageId);
  const read = await operationRestrictions(api, id, 'read');
  const update = await operationRestrictions(api, id, 'update');
  const mode = read.users.length || read.groups.length ? 'view-edit' : update.users.length || update.groups.length ? 'edit' : 'none';
  return { pageId: id, scope: 'direct', mode, read, update, inheritedNotEvaluated: true };
}

export function expectedRestrictions(policy, actor, creator = actor) {
  const selected = restrictionPolicy(policy);
  const update = selected.mode === 'none' ? { users: [], groups: [] } : { users: sorted([actor, creator, ...selected.editUsers]), groups: selected.editGroups };
  const read = selected.mode !== 'view-edit' ? { users: [], groups: [] } : { users: sorted([...update.users, ...selected.readUsers]), groups: sorted([...update.groups, ...selected.readGroups]) };
  return { read, update };
}

export function verifyRestrictions(actual, expected) {
  if (JSON.stringify(actual.read) !== JSON.stringify(expected.read) || JSON.stringify(actual.update) !== JSON.stringify(expected.update)) throw new Error('Restriction verification failed for page ' + actual.pageId + '. The server did not retain the requested direct allowlists; inspect restrictions before retrying.');
}

export async function setRestrictions(api, pageId, policy) {
  const id = numericId(pageId);
  const selected = restrictionPolicy(policy);
  let expected = { read: { users: [], groups: [] }, update: { users: [], groups: [] } };
  if (selected.mode === 'none') {
    await api.request('/content/' + id + '/restriction', { version: 1, method: 'DELETE' });
  } else {
    const actor = await currentUser(api);
    const creator = await pageCreator(api, id);
    expected = expectedRestrictions(selected, actor, creator);
    const cloud = api.config.deployment === 'cloud';
    const body = ['read', 'update'].filter((key) => expected[key].users.length || expected[key].groups.length).map((operation) => ({
      operation,
      restrictions: {
        ...(expected[operation].users.length ? { user: expected[operation].users.map((value) => ({ type: 'known', [cloud ? 'accountId' : 'username']: value })) } : {}),
        ...(expected[operation].groups.length ? { group: expected[operation].groups.map((value) => ({ type: 'group', [cloud ? 'id' : 'name']: value })) } : {}),
      },
    }));
    try { await api.request('/content/' + id + '/restriction', { version: 1, method: 'PUT', body }); }
    catch (error) { throw new Error('Could not set restrictions on page ' + id + '. Cloud Free does not support restrictions; also check token scopes and space permissions. ' + error.message, { cause: error }); }
  }
  const actual = await getRestrictions(api, id);
  verifyRestrictions(actual, expected);
  return actual;
}
