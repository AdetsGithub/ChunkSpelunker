/**
 * Detect GraphQL request shape and extract operationName.
 * @param {string} url
 * @param {string} [body]
 */
export function extractGraphqlMeta(url, body) {
  let pathLooksGql = false;
  try {
    pathLooksGql = /\/(graphql|gql)\/?$/i.test(new URL(url).pathname);
  } catch {
    pathLooksGql = /\/(graphql|gql)/i.test(url);
  }

  if (!body) {
    return pathLooksGql ? { hasQuery: false, operationType: 'unknown' } : null;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    if (pathLooksGql) return { hasQuery: false, operationType: 'unknown' };
    return null;
  }

  const hasQuery = typeof parsed.query === 'string';
  const operationName =
    typeof parsed.operationName === 'string' && parsed.operationName
      ? parsed.operationName
      : hasQuery
        ? inferOperationName(parsed.query)
        : undefined;

  if (!pathLooksGql && !hasQuery && !parsed.operationName) return null;

  return {
    hasQuery: hasQuery || Boolean(parsed.operationName),
    operationName,
    operationType: hasQuery ? inferOperationType(parsed.query) : 'unknown',
  };
}

function inferOperationName(query) {
  const m = query.match(/(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return m?.[1];
}

function inferOperationType(query) {
  const m = query.match(/^\s*(query|mutation|subscription)/i);
  if (!m) return 'unknown';
  return /** @type {'query'|'mutation'|'subscription'} */ (m[1].toLowerCase());
}

/**
 * Lightweight query preview hash for anonymous ops.
 * @param {string} query
 * @param {number} len
 */
export function hashQueryPreview(query, len = 64) {
  const slice = (query || '').replace(/\s+/g, ' ').slice(0, len);
  let h = 0;
  for (let i = 0; i < slice.length; i++) h = (Math.imul(31, h) + slice.charCodeAt(i)) | 0;
  return `q${(h >>> 0).toString(16)}`;
}
