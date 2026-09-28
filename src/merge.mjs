import { isDeepStrictEqual } from 'node:util';

const missing = Symbol('missing');
const protectedMetadata = new Set(['confluence', 'preserved']);
// Uint32 LCS payload is limited to 16 MiB per comparison, excluding row overhead.
const maxLcsCells = 16 * 1024 * 1024 / Uint32Array.BYTES_PER_ELEMENT;

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const slot = (value, key) => own(value, key) ? value[key] : missing;
const sameSlot = (left, right) => left === missing || right === missing ? left === right : isDeepStrictEqual(left, right);
const cloneSlot = (value) => value === missing ? missing : structuredClone(value);

function assertDocument(name, document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new TypeError(name + ' document must be an object.');
  if (!document.metadata || typeof document.metadata !== 'object' || Array.isArray(document.metadata)) throw new TypeError(name + ' metadata must be an object.');
  if (typeof document.body !== 'string') throw new TypeError(name + ' body must be a string.');
}

function mergeMetadata(base, local, remote, conflicts) {
  const metadata = {};
  const keys = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort();

  for (const key of keys) {
    const baseValue = slot(base, key);
    const localValue = slot(local, key);
    const remoteValue = slot(remote, key);
    let resolved;

    if (protectedMetadata.has(key)) {
      resolved = remoteValue;
    } else if (sameSlot(localValue, baseValue)) {
      resolved = remoteValue;
    } else if (sameSlot(remoteValue, baseValue) || sameSlot(localValue, remoteValue)) {
      resolved = localValue;
    } else {
      conflicts.push({
        scope: 'metadata',
        kind: 'overlap',
        key,
        base: cloneSlot(baseValue),
        local: cloneSlot(localValue),
        remote: cloneSlot(remoteValue),
      });
      continue;
    }

    if (resolved !== missing) metadata[key] = structuredClone(resolved);
  }

  return metadata;
}

function lines(source) {
  return source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function fitsLcsBudget(baseCount, changedCount) {
  // Division avoids overflowing the cell product before the allocation check.
  return Number.isSafeInteger(baseCount + 1)
    && Number.isSafeInteger(changedCount + 1)
    && baseCount + 1 <= Math.floor(maxLcsCells / (changedCount + 1));
}

function editsFrom(base, changed) {
  const common = Array.from({ length: base.length + 1 }, () => new Uint32Array(changed.length + 1));
  for (let i = base.length - 1; i >= 0; i--) {
    for (let j = changed.length - 1; j >= 0; j--) {
      common[i][j] = base[i] === changed[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }

  const edits = [];
  let i = 0;
  let j = 0;
  while (i < base.length || j < changed.length) {
    if (i < base.length && j < changed.length && base[i] === changed[j]) {
      i++;
      j++;
      continue;
    }

    const start = i;
    const replacement = [];
    while (i < base.length || j < changed.length) {
      if (i < base.length && j < changed.length && base[i] === changed[j]) break;
      if (j < changed.length && (i === base.length || common[i][j + 1] > common[i + 1][j])) replacement.push(changed[j++]);
      else i++;
    }
    edits.push({ start, end: i, lines: replacement });
  }
  return edits;
}

function sameEdit(left, right) {
  return left.start === right.start && left.end === right.end && isDeepStrictEqual(left.lines, right.lines);
}

function editsOverlap(left, right) {
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;
  if (leftInsertion && rightInsertion) return left.start === right.start;
  if (leftInsertion) return left.start > right.start && left.start < right.end;
  if (rightInsertion) return right.start > left.start && right.start < left.end;
  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function mergeBody(baseBody, localBody, remoteBody, conflicts) {
  if (localBody === baseBody) return remoteBody;
  if (remoteBody === baseBody || localBody === remoteBody) return localBody;
  const baseLines = lines(baseBody);
  const localEdits = editsFrom(baseLines, lines(localBody));
  const remoteEdits = editsFrom(baseLines, lines(remoteBody));
  const mergedEdits = [...localEdits];

  for (const remoteEdit of remoteEdits) {
    const identical = localEdits.find((localEdit) => sameEdit(localEdit, remoteEdit));
    if (identical) continue;
    const overlap = localEdits.find((localEdit) => editsOverlap(localEdit, remoteEdit));
    if (overlap) {
      conflicts.push({
        scope: 'body',
        kind: 'overlap',
        base: { start: Math.min(overlap.start, remoteEdit.start), end: Math.max(overlap.end, remoteEdit.end) },
        local: structuredClone(overlap),
        remote: structuredClone(remoteEdit),
      });
      continue;
    }
    mergedEdits.push(remoteEdit);
  }

  if (conflicts.some((conflict) => conflict.scope === 'body')) return null;
  const result = [...baseLines];
  mergedEdits.sort((left, right) => right.start - left.start || right.end - left.end);
  for (const edit of mergedEdits) result.splice(edit.start, edit.end - edit.start, ...edit.lines);
  return result.join('');
}

function countOccurrences(source, search) {
  if (!search) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(search, offset)) !== -1) {
    count++;
    offset += search.length;
  }
  return count;
}

function editsFallback(baseBody, changedBody, fallback) {
  if (baseBody === changedBody) return false;
  const baseLines = lines(baseBody);
  const changedLines = lines(changedBody);
  const baseIndex = baseLines.findIndex((line) => line.includes(fallback));
  const changedIndex = changedLines.findIndex((line) => line.includes(fallback));
  return baseIndex !== changedIndex || baseLines[baseIndex] !== changedLines[changedIndex];
}

function preserved(document) {
  return document.metadata.confluence?.preserved ?? [];
}

function validatePreserved(base, local, remote, conflicts) {
  const basePreserved = preserved(base);
  const localPreserved = preserved(local);
  const remotePreserved = preserved(remote);
  if (!Array.isArray(basePreserved) || !Array.isArray(localPreserved) || !Array.isArray(remotePreserved)) {
    conflicts.push({ scope: 'preserved', kind: 'invalid' });
    return;
  }
  if (!isDeepStrictEqual(localPreserved, basePreserved)) conflicts.push({ scope: 'preserved', kind: 'modified', side: 'local' });
  if (!isDeepStrictEqual(remotePreserved, basePreserved)) conflicts.push({ scope: 'preserved', kind: 'modified', side: 'remote' });

  const seen = new Set();
  for (const item of basePreserved) {
    const fallback = item?.markdown;
    if (typeof fallback !== 'string' || !fallback || typeof item.storage !== 'string' || seen.has(fallback)) {
      conflicts.push({ scope: 'preserved', kind: 'ambiguous', fallback: typeof fallback === 'string' ? fallback : null });
      continue;
    }
    seen.add(fallback);
    for (const [side, body] of [['base', base.body], ['local', local.body], ['remote', remote.body]]) {
      const count = countOccurrences(body, fallback);
      if (count !== 1) conflicts.push({ scope: 'preserved', kind: 'ambiguous', side, fallback, count });
    }
    if (editsFallback(base.body, local.body, fallback)) conflicts.push({ scope: 'preserved', kind: 'modified', side: 'local', fallback });
    if (editsFallback(base.body, remote.body, fallback)) conflicts.push({ scope: 'preserved', kind: 'modified', side: 'remote', fallback });
  }
}

export function mergeDocument(base, local, remote) {
  assertDocument('Base', base);
  assertDocument('Local', local);
  assertDocument('Remote', remote);

  const conflicts = [];
  validatePreserved(base, local, remote, conflicts);
  const metadata = mergeMetadata(base.metadata, local.metadata, remote.metadata, conflicts);
  if (conflicts.length) return { document: null, conflicts };

  if (local.body === base.body || remote.body === base.body || local.body === remote.body) {
    return { document: { metadata, body: mergeBody(base.body, local.body, remote.body, conflicts) }, conflicts };
  }

  const baseCount = lines(base.body).length;
  const oversizedSides = [['local', local.body], ['remote', remote.body]]
    .filter(([, body]) => !fitsLcsBudget(baseCount, lines(body).length))
    .map(([side]) => side);
  if (oversizedSides.length) {
    return { document: null, conflicts: [{ scope: 'body', kind: 'size-limit', sides: oversizedSides, maxLcsCells }] };
  }

  const body = mergeBody(base.body, local.body, remote.body, conflicts);
  if (conflicts.length) return { document: null, conflicts };
  return { document: { metadata, body }, conflicts };
}
