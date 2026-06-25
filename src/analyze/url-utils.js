/**
 * Convert template literal / concat path to Postman-style {{var}}.
 * @param {string} raw
 */
export function toPostmanTemplate(raw) {
  return raw
    .replace(/\$\{([^}]+)\}/g, (_, expr) => {
      const name = expr.trim().split('.').pop() || 'param';
      return `{{${sanitizeIdent(name)}}}`;
    })
    .replace(/\{\{EXPR\}\}/g, '{{param}}');
}

function sanitizeIdent(name) {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '');
  return cleaned || 'param';
}

/**
 * OpenAPI {var} from Postman {{var}}
 */
export function toOpenApiPath(pathTemplate) {
  return pathTemplate.replace(/\{\{([^}]+)\}\}/g, '{$1}');
}

/**
 * Parameterize concrete path segments (network-observed).
 * @param {string} pathname
 */
export function parameterizePath(pathname) {
  const parts = pathname.split('/');
  let idCount = 0;
  const out = parts.map((seg) => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg)) {
      const name = idCount === 0 ? 'id' : `id${idCount}`;
      idCount++;
      return `{${name}}`;
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(seg)) {
      return '{uuid}';
    }
    if (/^[0-9a-f]{16,}$/i.test(seg)) {
      return '{hexId}';
    }
    return seg;
  });
  return out.join('/');
}

/**
 * Structural key for dedupe: normalize {{userId}} and {id} to segment shapes.
 */
export function structuralPathKey(pathTemplate) {
  return pathTemplate
    .replace(/\{\{[^}]+\}\}/g, '{var}')
    .replace(/\{[^}]+\}/g, '{var}');
}

/**
 * Resolve relative rawPath against all pageUrls; dedupe; then cap.
 * @param {string} rawPath
 * @param {Iterable<string>} pageUrls
 * @param {string} fallbackBase
 * @param {number} cap
 */
export function resolveRelativePermutations(rawPath, pageUrls, fallbackBase, cap = 20) {
  const bases = [...pageUrls];
  if (!bases.length) bases.push(fallbackBase);

  /** @type {Map<string, string>} */
  const unique = new Map();
  for (const base of bases) {
    try {
      const resolved = new URL(rawPath, base).href;
      if (!unique.has(resolved)) unique.set(resolved, base);
    } catch {
      /* ignore */
    }
  }

  let entries = [...unique.entries()];
  let capped = false;
  if (entries.length > cap) {
    entries = entries.sort((a, b) => a[0].localeCompare(b[0])).slice(0, cap);
    capped = true;
  }
  return {
    results: entries.map(([resolvedUrl, resolvedFromPage]) => ({
      resolvedUrl,
      resolvedFromPage,
    })),
    capped,
    totalUnique: unique.size,
  };
}

export function isAbsoluteUrl(s) {
  return /^https?:\/\//i.test(s) || s.startsWith('//');
}

export function isPathLike(s) {
  if (!s || typeof s !== 'string') return false;
  if (s.length < 2 || s.length > 512) return false;
  if (s === '//' || s === '/' || /^\/[a-z]$/i.test(s)) return false;
  if (/\.(js|css|png|jpe?g|gif|svg|woff2?|map|ico)(\?|$)/i.test(s)) return false;
  if (s.startsWith('/') && !s.startsWith('//')) return true;
  if (isAbsoluteUrl(s)) return true;
  if (/^(\.\/|\.\.\/)/.test(s)) return true;
  return /\/(api|v\d+|graphql|rest|oauth|auth)\b/i.test(s);
}

export function pathAndQuery(urlOrPath, baseOrigin) {
  try {
    const u = urlOrPath.startsWith('http')
      ? new URL(urlOrPath)
      : new URL(urlOrPath, baseOrigin);
    return {
      origin: u.origin,
      pathname: u.pathname,
      searchParams: [...u.searchParams.keys()],
      href: u.href,
    };
  } catch {
    return { origin: baseOrigin, pathname: urlOrPath, searchParams: [], href: urlOrPath };
  }
}
