import { isDeepStrictEqual } from 'node:util';
import { readStorageSnapshot } from './evidence.mjs';

export const WIKI_ROOT_PROPERTY = 'cfwiki-root';

function topicValue(value) {
  if (typeof value !== 'string') throw new Error('Wiki topic must be a string.');
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Wiki topic must be 1-160 characters without control characters.');
  }
  const topic = value.trim().normalize('NFC');
  if (!topic || [...topic].length > 160) {
    throw new Error('Wiki topic must be 1-160 characters without control characters.');
  }
  return topic;
}

function rootId(value) {
  const id = String(value ?? '');
  if (!/^\d+$/.test(id)) throw new Error('Existing root ID must be numeric.');
  return id;
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function rootTitle(topic) {
  return topic + ' Wiki';
}

function rootStorage(topic, deployment) {
  const escapedTopic = escapeXml(topic);
  const skillPath = '$(npm root -g)/@twotwo-me/confluence-wiki-md/skills/confluence-wiki';
  return [
    '<p><strong>Type:</strong> Collection</p>',
    '<h1>' + escapedTopic + '</h1>',
    '<p>This page is the top-level navigation root for the <strong>' + escapedTopic + '</strong> topic. Add term pages beneath this page and keep Confluence as the authoritative copy.</p>',
    '<h2>Page tree</h2>',
    deployment === 'cloud'
      ? '<ac:structured-macro ac:name="children" ac:schema-version="1"><ac:parameter ac:name="all">true</ac:parameter></ac:structured-macro>'
      : '<ac:structured-macro ac:name="pagetree" ac:schema-version="1"><ac:parameter ac:name="root">@self</ac:parameter></ac:structured-macro>',
    '<h2>Install the CLI</h2>',
    '<p>Install <a href="https://nodejs.org/en/download">Node.js 24 or newer</a>, then install <a href="https://github.com/TwoTwo-me/confluence-wiki-md">@twotwo-me/confluence-wiki-md</a> from GitHub Packages:</p>',
    '<pre>npm install --global @twotwo-me/confluence-wiki-md\ncfwiki --help</pre>',
    '<h2>Install the agent skill</h2>',
    '<p>Each contributor installs the packaged <code>confluence-wiki</code> skill for their own agent. Link <code>' + escapeXml(skillPath) + '</code> into <code>${CODEX_HOME:-$HOME/.codex}/skills/confluence-wiki</code> for Codex or <code>$HOME/.claude/skills/confluence-wiki</code> for Claude.</p>',
    '<h2>Connect with your own identity</h2>',
    '<p>Copy the matching Cloud or Data Center profile example to <code>$HOME/.config/cfwiki/.env</code>, or select a private profile explicitly with <code>--env /absolute/path/to/profile.env</code>. Never copy another user&apos;s token into this page or another shared document. Access remains controlled by the selected Confluence account and space permissions.</p>',
    '<h2>Navigate and contribute</h2>',
    '<p>Use this page ID as the explicit <code>--wiki-root</code>. Read current pages before citing them, include the page ID, version, URL, and supporting passage, and treat search snippets only as discovery hints. Download before editing and use version-safe contribution commands; do not bypass conflicts or blindly retry an uncertain create.</p>',
  ].join('');
}

function verifiedResult(page, space, topic, reused) {
  return {
    status: 'confirmed',
    reused,
    id: page.id,
    version: page.version,
    url: page.url,
    spaceId: String(space.id),
    spaceKey: space.key,
    topic,
  };
}

function verifyRootPage(api, page, space, topic) {
  const homepage = String(space.homepageId ?? '');
  const matches = page
    && page.status === 'current'
    && page.space.id === String(space.id)
    && page.space.key === space.key
    && page.id !== homepage
    && (page.parentId === null ||
      (api.config.deployment === 'cloud' && /^\d+$/.test(homepage) && page.parentId === homepage))
    && page.title === rootTitle(topic)
    && Number.isInteger(page.version)
    && page.version > 0
    && page.url === api.pageUrl(page.id);
  if (!matches) throw new Error('Existing root does not match the requested current top-level topic in this space.');
  return page;
}

function rootIdentity(api, page, topic) {
  return {
    schema: 1, pageId: page.id, spaceId: page.space.id, spaceKey: page.space.key, topic,
    tenant: { deployment: api.config.deployment, siteUrl: api.config.siteUrl, apiUrl: api.config.apiUrl },
  };
}

// The snapshot must come from readStorageSnapshot and space from getSpace in
// the caller's selected tenant. Body text, attributes and IDs alone prove nothing.
export async function verifyWikiRoot(api, snapshot, space, topic) {
  topic = topicValue(topic ?? (snapshot.title?.endsWith(' Wiki') ? snapshot.title.slice(0, -5) : ''));
  verifyRootPage(api, snapshot, space, topic);
  const property = await api.getProperty(snapshot.id, WIKI_ROOT_PROPERTY);
  if (property?.key !== WIKI_ROOT_PROPERTY || !isDeepStrictEqual(property.value, rootIdentity(api, snapshot, topic))) {
    throw new Error('The selected wiki root identity could not be verified in the trusted space.');
  }
  return snapshot;
}

export async function readWikiRoot(api, id, { space, topic } = {}) {
  const selectedSpace = await api.getSpace(space);
  const scoped = Object.create(api);
  scoped.getSpace = async () => selectedSpace;
  const snapshot = await readStorageSnapshot(scoped, rootId(id), { space });
  return verifyWikiRoot(api, snapshot, selectedSpace, topic);
}

function unresolved(space, topic, page) {
  return {
    status: 'unresolved',
    reused: false,
    id: page?.id ?? null,
    version: page?.version ?? null,
    url: page?.url ?? null,
    spaceId: String(space.id),
    spaceKey: space.key,
    topic,
    reason: 'Root creation could not be confirmed. Reconcile the known result before any retry.',
  };
}

export async function initWiki(api, { space, topic: inputTopic, existingRoot } = {}) {
  const topic = topicValue(inputTopic);
  const selectedSpace = await api.getSpace(space);
  const spaceKey = space ?? api.config.spaceKey;
  if (selectedSpace?.key !== spaceKey || !/^\d+$/.test(String(selectedSpace.id))) {
    throw new Error('Confluence did not resolve the trusted space exactly.');
  }
  const scoped = Object.create(api);
  scoped.getSpace = async () => selectedSpace;

  if (existingRoot !== undefined && existingRoot !== null) {
    const id = rootId(existingRoot);
    const snapshot = await readStorageSnapshot(scoped, id, { space: spaceKey });
    const page = await verifyWikiRoot(api, snapshot, selectedSpace, topic);
    return verifiedResult(page, selectedSpace, topic, true);
  }

  let written;
  try {
    written = await api.writePage({
      title: rootTitle(topic),
      storage: rootStorage(topic, api.config.deployment),
      space: selectedSpace,
    });
  } catch (error) {
    if (Number.isInteger(error?.status)) throw error;
    return unresolved(selectedSpace, topic, error.writtenPage);
  }

  try {
    // Only this invocation's successful POST may install the native marker.
    // An unmarked --existing-root is never adopted or modified.
    const snapshot = await readStorageSnapshot(scoped, written.id, { space: spaceKey });
    verifyRootPage(api, snapshot, selectedSpace, topic);
    await api.setProperty(snapshot.id, rootIdentity(api, snapshot, topic), WIKI_ROOT_PROPERTY);
    const page = await readWikiRoot(api, written.id, { space: spaceKey, topic });
    return verifiedResult(page, selectedSpace, topic, false);
  } catch {
    return unresolved(selectedSpace, topic, written);
  }
}
