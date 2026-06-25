import { TOKEN_STORAGE_KEYS } from '../models.js';

/**
 * @param {{ name: string, value: string }[]} headers
 * @returns {Record<string, string>}
 */
export function headersToObject(headers = []) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const h of headers) out[h.name] = h.value;
  return out;
}

/**
 * Parse --hydrate-format into { name, valueTemplate }.
 * @param {string} format
 */
export function parseHydrateFormat(format) {
  const idx = format.indexOf(':');
  if (idx === -1) throw new Error(`Invalid --hydrate-format: ${format}`);
  const name = format.slice(0, idx).trim();
  const rest = format.slice(idx + 1).trim();
  if (!name || !rest.includes('{token}')) {
    throw new Error('--hydrate-format must look like "Header: …{token}…"');
  }
  return { name, valueTemplate: rest };
}

/**
 * Extract a token from Playwright storageState JSON.
 * @param {object} storageState
 * @param {string} targetOrigin
 */
export function hydrateTokenFromState(storageState, targetOrigin) {
  if (!storageState?.origins) return null;
  const origins = storageState.origins.filter((o) => o.origin === targetOrigin);
  const list = origins.length ? origins : storageState.origins;

  for (const origin of list) {
    for (const store of [origin.localStorage, origin.sessionStorage]) {
      if (!Array.isArray(store)) continue;
      for (const entry of store) {
        const key = String(entry.name || '').toLowerCase();
        const value = String(entry.value || '');
        if (!value) continue;
        if (TOKEN_STORAGE_KEYS.includes(key) && looksLikeToken(value)) {
          return { key: entry.name, value: stripQuotes(value) };
        }
        // Best-effort Okta / Auth0 JSON blobs
        if (/token|okta|auth0|oidc/i.test(key) && value.startsWith('{')) {
          const nested = extractFromJsonBlob(value);
          if (nested) return { key: entry.name, value: nested };
        }
      }
    }
  }
  return null;
}

function looksLikeToken(value) {
  const v = stripQuotes(value);
  if (v.startsWith('eyJ') && v.includes('.')) return true;
  return v.length >= 16 && !/\s/.test(v);
}

function stripQuotes(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function extractFromJsonBlob(raw) {
  try {
    const obj = JSON.parse(raw);
    const candidates = [
      obj.accessToken,
      obj.access_token,
      obj.idToken,
      obj.id_token,
      obj.token,
      obj?.accessToken?.accessToken,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && looksLikeToken(c)) return c;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Build header policy decision for a fetch destination.
 */
export function resolveFetchCredentials({
  destUrl,
  targetOrigin,
  appHeaders,
  mapHeaders,
  mapOrigins,
  allowExternalMaps,
  hydratedHeader,
}) {
  const dest = new URL(destUrl);
  const sameOrigin = dest.origin === targetOrigin;
  const mapOriginSet = new Set(mapOrigins.map((o) => new URL(o).origin));
  const isMapOrigin = mapOriginSet.has(dest.origin);

  if (sameOrigin) {
    const headers = { ...headersToObject(appHeaders) };
    if (hydratedHeader && !headerNameExists(headers, hydratedHeader.name)) {
      headers[hydratedHeader.name] = hydratedHeader.value;
    }
    return { allowed: true, headers, useApiRequest: true };
  }

  if (isMapOrigin) {
    return {
      allowed: true,
      headers: headersToObject(mapHeaders),
      useApiRequest: false,
    };
  }

  if (allowExternalMaps) {
    return {
      allowed: true,
      headers: isMapOrigin ? headersToObject(mapHeaders) : {},
      useApiRequest: false,
    };
  }

  return { allowed: false, headers: {}, useApiRequest: false };
}

function headerNameExists(obj, name) {
  const lower = name.toLowerCase();
  return Object.keys(obj).some((k) => k.toLowerCase() === lower);
}

/**
 * Apply hydrate format to a token value.
 */
export function buildHydratedHeader(format, tokenValue) {
  const { name, valueTemplate } = parseHydrateFormat(format);
  return {
    name,
    value: valueTemplate.replace('{token}', tokenValue),
  };
}
