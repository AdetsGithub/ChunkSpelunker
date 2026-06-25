import { resolveFetchCredentials } from './header-policy.js';

/**
 * Concurrency-limited authenticated fetcher for maps / missing JS.
 */
export class AuthedFetcher {
  /**
   * @param {object} opts
   * @param {import('playwright').BrowserContext} [opts.context]
   * @param {string} opts.targetOrigin
   * @param {object} opts.policy
   * @param {number} opts.concurrency
   * @param {{ debug?: Function, warn?: Function }} opts.log
   */
  constructor({ context, targetOrigin, policy, concurrency = 4, log }) {
    this.context = context;
    this.targetOrigin = targetOrigin;
    this.policy = policy;
    this.concurrency = concurrency;
    this.log = log;
    this.active = 0;
    /** @type {Array<() => void>} */
    this.queue = [];
    /** @type {Map<string, number>} */
    this.hostBackoffUntil = new Map();
  }

  async #withSlot(fn) {
    if (this.active >= this.concurrency) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /**
   * @param {string} url
   * @returns {Promise<{ ok: boolean, status: number, body?: Buffer, contentType?: string }>}
   */
  async fetch(url) {
    return this.#withSlot(() => this.#doFetch(url));
  }

  async #doFetch(url) {
    const host = new URL(url).host;
    const until = this.hostBackoffUntil.get(host) || 0;
    if (Date.now() < until) {
      this.log.warn?.(`Skipping fetch (backoff): ${url}`);
      return { ok: false, status: 429 };
    }

    const creds = resolveFetchCredentials({
      destUrl: url,
      targetOrigin: this.targetOrigin,
      ...this.policy,
    });

    if (!creds.allowed) {
      this.log.debug?.(`Map fetch blocked by policy: ${url}`);
      return { ok: false, status: 0 };
    }

    let attempt = 0;
    while (attempt < 3) {
      attempt++;
      try {
        let status;
        let body;
        let contentType;

        if (creds.useApiRequest && this.context) {
          const res = await this.context.request.get(url, {
            headers: creds.headers,
            timeout: 30_000,
            failOnStatusCode: false,
          });
          status = res.status();
          contentType = res.headers()['content-type'];
          if (status === 429) {
            const delay = 1000 * 2 ** (attempt - 1);
            this.hostBackoffUntil.set(host, Date.now() + delay);
            this.log.warn?.(`429 from ${host}; backoff ${delay}ms`);
            await sleep(delay);
            continue;
          }
          if (status >= 200 && status < 300) {
            body = Buffer.from(await res.body());
          }
          return { ok: status >= 200 && status < 300, status, body, contentType };
        }

        const res = await fetch(url, {
          headers: creds.headers,
          redirect: 'follow',
        });
        status = res.status;
        contentType = res.headers.get('content-type') || undefined;
        if (status === 429) {
          const delay = 1000 * 2 ** (attempt - 1);
          this.hostBackoffUntil.set(host, Date.now() + delay);
          this.log.warn?.(`429 from ${host}; backoff ${delay}ms`);
          await sleep(delay);
          continue;
        }
        if (status >= 200 && status < 300) {
          body = Buffer.from(await res.arrayBuffer());
        }
        return { ok: status >= 200 && status < 300, status, body, contentType };
      } catch (err) {
        this.log.debug?.(`Fetch error ${url}: ${err.message}`);
        return { ok: false, status: 0 };
      }
    }
    return { ok: false, status: 429 };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
