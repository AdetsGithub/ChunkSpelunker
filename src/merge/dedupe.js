import { createFinding } from '../models.js';
import { hashQueryPreview } from '../analyze/graphql-utils.js';
import {
  parameterizePath,
  pathAndQuery,
  resolveRelativePermutations,
  structuralPathKey,
  toOpenApiPath,
  toPostmanTemplate,
  isAbsoluteUrl,
} from '../analyze/url-utils.js';

/**
 * Merge network + static findings with GraphQL-aware dedupe and AST path precedence.
 */
export function mergeFindings({
  networkCalls,
  staticFindings,
  websockets,
  sseUrls,
  baseUrl,
  cache,
  log,
}) {
  /** @type {Map<string, import('../models.js').EndpointFinding>} */
  const map = new Map();

  const add = (finding) => {
    const key = dedupeKey(finding);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, finding);
      return;
    }
    map.set(key, mergePair(existing, finding));
  };

  for (const call of networkCalls) {
    if (shouldSkipNetworkUrl(call.url)) continue;
    const parsed = pathAndQuery(call.url, baseUrl.origin);
    const pathTemplate = parameterizePath(parsed.pathname);
    add(
      createFinding({
        method: call.method,
        url: call.url,
        pathTemplate,
        queryParams: parsed.searchParams,
        bodyParams: inferBodyKeys(call.postData),
        source: 'network',
        confidence: 'high',
        evidence: {
          sampleRequest: { url: call.url, status: call.status },
        },
        sse: call.sse,
        graphql: call.graphql,
      }),
    );
  }

  for (const url of websockets) {
    add(
      createFinding({
        method: 'GET',
        url,
        pathTemplate: pathAndQuery(url, baseUrl.origin).pathname,
        source: 'network',
        confidence: 'high',
        websocket: true,
      }),
    );
  }

  for (const url of sseUrls) {
    add(
      createFinding({
        method: 'GET',
        url,
        pathTemplate: pathAndQuery(url, baseUrl.origin).pathname,
        source: 'network',
        confidence: 'high',
        sse: true,
      }),
    );
  }

  for (const draft of staticFindings) {
    const raw = draft.rawPath || draft.url || draft.pathTemplate;
    if (!raw) continue;

    const jsUrl = draft.evidence?.jsUrls?.[0];
    const pageUrls = jsUrl ? cache.pageUrlsFor(jsUrl) : new Set();

    if (isRelative(raw)) {
      const { results, capped, totalUnique } = resolveRelativePermutations(
        raw,
        pageUrls,
        baseUrl.href,
        20,
      );
      if (capped) {
        log.warn(
          `relative path ${raw} produced ${totalUnique} unique resolutions; capped to 20`,
        );
      }
      for (const { resolvedUrl, resolvedFromPage } of results) {
        const parsed = pathAndQuery(resolvedUrl, baseUrl.origin);
        add(
          createFinding({
            ...draft,
            method: draft.method || 'GET',
            url: resolvedUrl,
            pathTemplate: toPostmanTemplate(parsed.pathname),
            queryParams: parsed.searchParams,
            evidence: {
              ...draft.evidence,
              rawPath: raw,
              resolvedFromPage,
            },
          }),
        );
      }
    } else {
      const href = isAbsoluteUrl(raw)
        ? raw.startsWith('//')
          ? `${baseUrl.protocol}${raw}`
          : raw
        : new URL(raw, baseUrl.origin).href;
      const parsed = pathAndQuery(href, baseUrl.origin);
      const template = draft.pathTemplate?.includes('{{')
        ? draft.pathTemplate.startsWith('http')
          ? toPostmanTemplate(parsed.pathname)
          : draft.pathTemplate
        : toPostmanTemplate(parsed.pathname);
      add(
        createFinding({
          ...draft,
          method: draft.method || 'GET',
          url: href,
          pathTemplate: template.includes('{') && !template.includes('{{')
            ? template
            : template,
          queryParams: [...new Set([...(draft.queryParams || []), ...parsed.searchParams])],
          evidence: { ...draft.evidence, rawPath: raw },
        }),
      );
    }
  }

  return [...map.values()].sort((a, b) =>
    `${a.method} ${a.pathTemplate}`.localeCompare(`${b.method} ${b.pathTemplate}`),
  );
}

function mergePair(a, b) {
  const networkFirst = a.source === 'network' || a.source === 'both' ? a : b;
  const other = networkFirst === a ? b : a;
  const astSide =
    a.source === 'ast' || a.source === 'regex'
      ? a
      : b.source === 'ast' || b.source === 'regex'
        ? b
        : null;

  // AST path template wins when semantic
  let pathTemplate = networkFirst.pathTemplate;
  if (astSide && hasSemanticVars(astSide.pathTemplate)) {
    pathTemplate = astSide.pathTemplate;
  } else if (astSide && !hasSemanticVars(networkFirst.pathTemplate) && astSide.pathTemplate) {
    pathTemplate = astSide.pathTemplate;
  }

  return createFinding({
    method: networkFirst.method,
    url: networkFirst.url,
    pathTemplate,
    queryParams: uniq([...(a.queryParams || []), ...(b.queryParams || [])]),
    bodyParams: uniq([...(a.bodyParams || []), ...(b.bodyParams || [])]),
    headers: { ...a.headers, ...b.headers },
    source: 'both',
    confidence: 'high',
    evidence: {
      ...a.evidence,
      ...b.evidence,
      jsUrls: uniq([...(a.evidence?.jsUrls || []), ...(b.evidence?.jsUrls || [])]),
    },
    websocket: a.websocket || b.websocket,
    sse: a.sse || b.sse,
    graphql: a.graphql?.operationName ? a.graphql : b.graphql || a.graphql,
  });
}

function hasSemanticVars(pathTemplate = '') {
  return /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/.test(pathTemplate);
}

function dedupeKey(f) {
  const pathKey = structuralPathKey(toOpenApiPath(f.pathTemplate || ''));
  const q = [...(f.queryParams || [])].sort().join(',');
  let key = `${(f.method || 'GET').toUpperCase()} ${pathKey} ${q}`;
  if (f.graphql) {
    const op =
      f.graphql.operationName ||
      (f.graphql.hasQuery ? 'anonymous' : 'graphql');
    key += ` GQL:${op}`;
  }
  if (f.websocket) key += ' WS';
  if (f.sse) key += ' SSE';
  return key;
}

function shouldSkipNetworkUrl(url) {
  try {
    const u = new URL(url);
    if (/\.(js|css|map|png|jpe?g|gif|svg|woff2?|ico)(\?|$)/i.test(u.pathname)) return true;
    if (u.protocol.startsWith('data')) return true;
    return false;
  } catch {
    return true;
  }
}

function isRelative(p) {
  return p.startsWith('./') || p.startsWith('../') || (!p.startsWith('/') && !isAbsoluteUrl(p) && !p.includes(':'));
}

function inferBodyKeys(postData) {
  if (!postData) return [];
  try {
    const obj = JSON.parse(postData);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return Object.keys(obj);
  } catch {
    /* ignore */
  }
  return [];
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

// re-export for tests / openapi
export { toOpenApiPath, hashQueryPreview };
