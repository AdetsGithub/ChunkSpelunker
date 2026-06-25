import { extractGraphqlMeta } from '../analyze/graphql-utils.js';

const STATIC_EXT =
  /\.(css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map|mp4|webm|mp3|pdf)(\?|$)/i;

export function isJsContentType(ct = '') {
  return /javascript|ecmascript|typescript/i.test(ct);
}

export function isEventStream(ct = '') {
  return /text\/event-stream/i.test(ct);
}

export function isJsUrl(url) {
  try {
    const u = new URL(url);
    return /\.(m?js|cjs)(\?|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

export function isStaticAsset(url) {
  try {
    return STATIC_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export class NetworkStore {
  /**
   * @param {{ maxBodyBytes: number }} opts
   */
  constructor(opts) {
    this.maxBodyBytes = opts.maxBodyBytes;
    /** @type {import('../models.js').NetworkCall[]} */
    this.calls = [];
    /** @type {Set<string>} */
    this.websockets = new Set();
    /** @type {Set<string>} */
    this.sseUrls = new Set();
  }

  /**
   * @param {import('playwright').Request} request
   * @param {string} pageUrl
   */
  recordRequest(request, pageUrl) {
    const resourceType = request.resourceType();
    if (!['xhr', 'fetch', 'websocket'].includes(resourceType) && resourceType !== 'other') {
      // still allow non-static document APIs later via response path
    }

    if (resourceType === 'websocket') {
      this.websockets.add(request.url());
      return;
    }

    const url = request.url();
    if (isStaticAsset(url) && !isJsUrl(url)) return;

    let postData = request.postData() || undefined;
    let bodyTruncated = false;
    if (postData && postData.length > this.maxBodyBytes) {
      postData = postData.slice(0, this.maxBodyBytes);
      bodyTruncated = true;
    }

    const headers = request.headers();
    const graphql = extractGraphqlMeta(url, postData);

    /** @type {import('../models.js').NetworkCall} */
    const call = {
      method: request.method(),
      url,
      resourceType,
      postData,
      bodyTruncated,
      requestContentType: headers['content-type'],
      pageUrl,
      graphql: graphql || undefined,
    };

    this.calls.push(call);
  }

  /**
   * @param {import('playwright').Response} response
   */
  async noteResponse(response) {
    const headers = await response.headers();
    const ct = headers['content-type'] || '';
    if (isEventStream(ct)) {
      this.sseUrls.add(response.url());
      const existing = this.calls.find((c) => c.url === response.url());
      if (existing) existing.sse = true;
      else {
        this.calls.push({
          method: response.request().method(),
          url: response.url(),
          resourceType: 'fetch',
          status: response.status(),
          sse: true,
        });
      }
      return { skipBody: true, contentType: ct, sse: true };
    }
    return { skipBody: false, contentType: ct, sse: false };
  }
}
