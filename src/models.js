/**
 * @typedef {Object} GraphqlMeta
 * @property {string} [operationName]
 * @property {'query'|'mutation'|'subscription'|'unknown'} [operationType]
 * @property {boolean} hasQuery
 */

/**
 * @typedef {Object} EndpointFinding
 * @property {string} method
 * @property {string} url
 * @property {string} pathTemplate
 * @property {string[]} queryParams
 * @property {string[]} bodyParams
 * @property {Record<string, string>} headers
 * @property {'network'|'ast'|'regex'|'both'} source
 * @property {'high'|'medium'|'low'} confidence
 * @property {Object} evidence
 * @property {string[]} [evidence.jsUrls]
 * @property {string[]} [evidence.mapUrls]
 * @property {{url: string, status?: number}} [evidence.sampleRequest]
 * @property {string} [evidence.resolvedFromPage]
 * @property {string} [evidence.rawPath]
 * @property {boolean} [websocket]
 * @property {boolean} [sse]
 * @property {GraphqlMeta} [graphql]
 */

/**
 * @typedef {Object} JsAssetMeta
 * @property {string} url
 * @property {string} diskPath
 * @property {string} [contentType]
 * @property {number} byteLength
 * @property {Set<string>} pageUrls
 */

/**
 * @typedef {Object} NetworkCall
 * @property {string} method
 * @property {string} url
 * @property {string} [resourceType]
 * @property {string} [postData]
 * @property {boolean} [bodyTruncated]
 * @property {string} [requestContentType]
 * @property {number} [status]
 * @property {string} [pageUrl]
 * @property {boolean} [sse]
 * @property {GraphqlMeta} [graphql]
 */

/**
 * @param {Partial<EndpointFinding>} partial
 * @returns {EndpointFinding}
 */
export function createFinding(partial) {
  return {
    method: (partial.method || 'GET').toUpperCase(),
    url: partial.url || '',
    pathTemplate: partial.pathTemplate || '',
    queryParams: partial.queryParams || [],
    bodyParams: partial.bodyParams || [],
    headers: partial.headers || {},
    source: partial.source || 'network',
    confidence: partial.confidence || 'medium',
    evidence: partial.evidence || {},
    websocket: partial.websocket,
    sse: partial.sse,
    graphql: partial.graphql,
  };
}

export const DEFAULT_CLICK_SELECTOR =
  'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"]';

export const DEFAULT_EXCLUDE_SELECTOR = [
  '[href*="logout" i]',
  '[href*="signout" i]',
  '[href*="sign-out" i]',
  '[id*="logout" i]',
  '[class*="logout" i]',
  '[data-testid*="logout" i]',
  '[aria-label*="log out" i]',
  '[aria-label*="sign out" i]',
  'button:has-text("Log out")',
  'button:has-text("Logout")',
  'button:has-text("Sign out")',
  'button:has-text("Delete")',
  'button:has-text("Delete account")',
  'button:has-text("Remove account")',
  'a:has-text("Log out")',
  'a:has-text("Sign out")',
].join(', ');

export const DEFAULT_HYDRATE_FORMAT = 'Authorization: Bearer {token}';

export const TOKEN_STORAGE_KEYS = [
  'access_token',
  'id_token',
  'token',
  'authtoken',
  'auth_token',
  'jwt',
  'accesstoken',
  'idtoken',
  'bearer',
  'authorization',
];
