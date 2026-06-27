import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { AssetCache } from './asset-cache.js';
import {
  NetworkStore,
  isEventStream,
  isJsContentType,
  isJsUrl,
  isStaticAsset,
} from './network-store.js';
import { installHistoryObserver } from './history-observer.js';
import { stealthInitScript } from './stealth.js';
import {
  buildHydratedHeader,
  headersToObject,
  hydrateTokenFromState,
} from '../http/header-policy.js';
import { AuthedFetcher } from '../http/authed-fetch.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * @param {object} options
 * @param {ReturnType<import('../log.js').createLogger>} log
 */
export async function crawl(options, log) {
  const cache = new AssetCache(options.tmpdir, log);
  await cache.init();

  const network = new NetworkStore({ maxBodyBytes: options.maxBodyBytes });

  /** @type {object|undefined} */
  let storageState;
  if (options.state) {
    storageState = JSON.parse(await fs.readFile(options.state, 'utf8'));
    log.info(`Loaded storageState from ${options.state}`);
  }

  let hydratedHeader = null;
  if (storageState) {
    const tok = hydrateTokenFromState(storageState, options.baseUrl.origin);
    if (tok) {
      hydratedHeader = buildHydratedHeader(options.hydrateFormat, tok.value);
      log.debug(`hydrated header via --hydrate-format from storageState key=${tok.key}`);
    }
  }

  const extraHTTPHeaders = headersToObject(options.headers);

  const browser = await chromium.launch({
    headless: options.headless !== false,
    proxy: options.proxy ? { server: options.proxy } : undefined,
  });

  const context = await browser.newContext({
    storageState,
    extraHTTPHeaders: Object.keys(extraHTTPHeaders).length ? extraHTTPHeaders : undefined,
    userAgent: options.userAgent || DEFAULT_UA,
    ignoreHTTPSErrors: Boolean(options.insecure),
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });

  if (options.cookie) {
    await addCookieString(context, options.cookie, options.baseUrl);
  }

  await context.addInitScript(stealthInitScript());

  const page = await context.newPage();
  /** @type {string[]} */
  const historyNavs = [];
  await installHistoryObserver(page, (detail) => {
    historyNavs.push(detail.href);
    log.debug(`history ${detail.reason}: ${detail.href}`);
  });

  page.on('request', (request) => {
    try {
      const rt = request.resourceType();
      // Skip document/script/image noise for endpoint merge; still cache JS via response
      if (['document', 'stylesheet', 'image', 'font', 'media', 'manifest'].includes(rt)) {
        return;
      }
      if (rt === 'script') return;
      network.recordRequest(request, page.url());
    } catch {
      /* ignore */
    }
  });

  page.on('response', async (response) => {
    try {
      const url = response.url();
      const meta = await network.noteResponse(response);
      if (meta.sse || meta.skipBody) return;

      const ct = meta.contentType || '';
      if (!(isJsUrl(url) || isJsContentType(ct))) return;
      if (isEventStream(ct)) return;

      // Never body() on event-stream — already gated
      let body;
      try {
        body = await response.body();
      } catch {
        return;
      }
      await cache.writeJs(url, body, {
        contentType: ct,
        pageUrl: page.url(),
      });
      log.debug(`cached JS ${url} (${body.length} bytes)`);
    } catch (err) {
      log.debug(`response handler: ${err.message}`);
    }
  });

  page.on('websocket', (ws) => {
    network.websockets.add(ws.url());
  });

  log.info(`Navigating to ${options.url}`);
  try {
    await page.goto(options.url, {
      waitUntil: options.waitUntil || 'domcontentloaded',
      timeout: options.timeout,
    });
  } catch (err) {
    log.warn(`Navigation issue: ${err.message}`);
  }

  await settle(page, options.timeout);

  const visited = new Set([normalizeVisitUrl(page.url())]);
  /** @type {{ url: string, depth: number }[]} */
  const queue = [];
  if (options.depth > 0) {
    await enqueueFromPage(page, queue, options, visited, 1, log);
  }

  let navigations = 0;
  let clicks = 0;
  const maxNav = 100;
  const maxClicks = 250;

  while (queue.length && navigations < maxNav && clicks < maxClicks) {
    const item = queue.shift();
    if (!item) break;

    if (item.kind === 'goto') {
      if (visited.has(normalizeVisitUrl(item.url))) continue;
      if (
        options.sameOriginOnly !== false &&
        hasOutboundRedirectTarget(item.url, options.baseUrl.origin)
      ) {
        log.debug(`skip goto open-redirect ${item.url}`);
        visited.add(normalizeVisitUrl(item.url));
        continue;
      }
      visited.add(normalizeVisitUrl(item.url));
      navigations++;
      log.info(`Goto [${item.depth}] ${item.url}`);
      try {
        await page.goto(item.url, {
          waitUntil: options.waitUntil || 'domcontentloaded',
          timeout: options.timeout,
        });
        await settle(page, options.timeout);
      } catch (err) {
        log.debug(`goto failed: ${err.message}`);
        continue;
      }
      if (
        options.sameOriginOnly !== false &&
        isOffOrigin(page.url(), options.baseUrl.origin)
      ) {
        log.warn(`goto landed off-origin (${page.url()}); recovering`);
        await recoverToOrigin(page, options, options.url, log);
        continue;
      }
      if (item.depth < options.depth) {
        await enqueueFromPage(page, queue, options, visited, item.depth + 1, log);
      }
      continue;
    }

    // click
    clicks++;
    const before = page.url();

    // Re-check origin before clicking (page may have drifted)
    if (isOffOrigin(before, options.baseUrl.origin) && options.sameOriginOnly !== false) {
      log.warn(`off-origin page before click (${before}); returning to target`);
      await recoverToOrigin(page, options, before, log);
      continue;
    }

    try {
      const loc = page.locator(item.selector).nth(item.index);
      // Skip if this index now resolves to an external link (DOM may have shifted;
      // primary filter is at enqueue time)
      const external = await isExternalClickTarget(loc, options.baseUrl.origin).catch(() => false);
      if (external && options.sameOriginOnly !== false) {
        log.debug(`skip click index ${item.index} — external href`);
        continue;
      }
      await loc.click({
        force: options.forceClicks !== false,
        timeout: 3000,
      });
      await page.keyboard.press('Escape').catch(() => {});
      await settle(page, Math.min(options.timeout, 5000));
    } catch (err) {
      log.debug(`click failed: ${err.message}`);
      continue;
    }

    const after = page.url();
    if (options.sameOriginOnly !== false && isOffOrigin(after, options.baseUrl.origin)) {
      log.warn(`left origin via click (${before} -> ${after}); returning to target`);
      await recoverToOrigin(page, options, before, log);
      continue;
    }

    if (after !== before) {
      log.debug(`click navigated ${before} -> ${after}`);
      if (isSessionDeath(before, after) && (options.state || options.cookie || options.headers?.length)) {
        log.warn(`possible session end at ${after}; stopping crawl clicks`);
        break;
      }
      const norm = normalizeVisitUrl(after);
      if (!visited.has(norm) && item.depth < options.depth) {
        visited.add(norm);
        navigations++;
        await enqueueFromPage(page, queue, options, visited, item.depth + 1, log);
      }
    }
  }

  const fetcher = new AuthedFetcher({
    context,
    targetOrigin: options.baseUrl.origin,
    concurrency: options.mapConcurrency,
    log,
    policy: {
      appHeaders: options.headers,
      mapHeaders: options.mapHeaders,
      mapOrigins: options.mapOrigins,
      allowExternalMaps: options.allowExternalMaps,
      hydratedHeader,
    },
  });

  return {
    browser,
    context,
    page,
    cache,
    network,
    fetcher,
    hydratedHeader,
    visited: [...visited],
  };
}

async function enqueueFromPage(page, queue, options, visited, depth, log) {
  const origin = options.baseUrl.origin;

  if (options.sameOriginOnly !== false && isOffOrigin(page.url(), origin)) {
    log.warn(`skip enqueue — off-origin page ${page.url()}`);
    return;
  }

  // Href harvest
  const hrefs = await page.$$eval('a[href]', (els) =>
    els.map((a) => a.getAttribute('href')).filter(Boolean),
  );
  for (const href of hrefs) {
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
      continue;
    }
    let abs;
    try {
      abs = new URL(href, page.url()).href;
    } catch {
      continue;
    }
    if (options.sameOriginOnly !== false) {
      if (new URL(abs).origin !== origin) continue;
      if (hasOutboundRedirectTarget(abs, origin)) {
        log.debug(`skip href open-redirect ${abs}`);
        continue;
      }
    }
    const norm = normalizeVisitUrl(abs);
    if (visited.has(norm)) continue;
    // exclude-selector check approximate via URL
    if (/logout|sign-?out|signout/i.test(abs)) continue;
    queue.push({ kind: 'goto', url: abs, depth });
  }

  // Click targets — exclude via text/href/id/class heuristics (Playwright :has-text
  // is not valid in Element.matches / querySelector)
  const count = await page.locator(options.clickSelector).count().catch(() => 0);
  const maxPerPage = 40;
  for (let i = 0; i < Math.min(count, maxPerPage); i++) {
    const el = page.locator(options.clickSelector).nth(i);
    try {
      if (options.sameOriginOnly !== false) {
        const external = await isExternalClickTarget(el, origin).catch(() => false);
        if (external) continue;
      }
      const excluded = await el.evaluate((node) => {
        const text = (node.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const href = (node.getAttribute?.('href') || '').toLowerCase();
        const id = (node.id || '').toLowerCase();
        const cls = String(node.className || '').toLowerCase();
        const aria = (node.getAttribute?.('aria-label') || '').toLowerCase();
        const testId = (node.getAttribute?.('data-testid') || '').toLowerCase();
        const blob = `${text} ${href} ${id} ${cls} ${aria} ${testId}`;
        if (/log\s*out|sign\s*out|signout|sign-out/.test(blob)) return true;
        if (/\bdelete\b.*\baccount\b|\bremove\b.*\baccount\b/.test(blob)) return true;
        if (/^delete$/i.test(text)) return true;
        return false;
      }).catch(() => false);
      if (excluded) continue;
      queue.push({
        kind: 'click',
        selector: options.clickSelector,
        index: i,
        depth,
      });
    } catch {
      /* ignore */
    }
  }
  log.debug(`enqueued clicks/hrefs from ${page.url()} (depth ${depth})`);
}

/**
 * True when url's origin differs from targetOrigin.
 * @param {string} url
 * @param {string} targetOrigin
 */
export function isOffOrigin(url, targetOrigin) {
  try {
    return new URL(url).origin !== targetOrigin;
  } catch {
    return true;
  }
}

/**
 * Same-origin open-redirect style links (e.g. /redirect?to=https://github.com/...).
 * Scans query values and the full URL string for embedded absolute http(s) origins
 * that differ from targetOrigin.
 * @param {string} url
 * @param {string} targetOrigin
 */
export function hasOutboundRedirectTarget(url, targetOrigin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== targetOrigin) return true;

  for (const value of parsed.searchParams.values()) {
    if (embeddedOffOrigin(value, targetOrigin)) return true;
  }
  // Catch encoded destinations that never became discrete searchParams values
  if (embeddedOffOrigin(parsed.href, targetOrigin)) return true;
  return false;
}

/**
 * @param {string} text
 * @param {string} targetOrigin
 */
function embeddedOffOrigin(text, targetOrigin) {
  if (!text || !/https?:\/\//i.test(text)) return false;
  const re = /https?:\/\/[^\s"'<>\\]+/gi;
  let m;
  while ((m = re.exec(text))) {
    try {
      const candidate = new URL(m[0].replace(/[),.;]+$/, ''));
      if (candidate.origin !== targetOrigin) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Whether a locator points at (or wraps) an anchor whose href leaves targetOrigin.
 * Hash-only and same-origin relative links are allowed.
 * Same-origin open redirects that embed an external URL are treated as external.
 * @param {import('playwright').Locator} loc
 * @param {string} targetOrigin
 */
async function isExternalClickTarget(loc, targetOrigin) {
  return loc.evaluate((node, origin) => {
    /** @type {Element | null} */
    let el = node;
    if (el && el.nodeType !== 1) el = el.parentElement;
    const anchor =
      el && typeof el.closest === 'function'
        ? el.closest('a[href]')
        : el?.tagName === 'A'
          ? el
          : null;
    if (!anchor) return false;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
      return false;
    }
    // In-app hash routes (#/login) stay on origin
    if (href.startsWith('#')) return false;
    try {
      const abs = new URL(href, location.href);
      if (abs.origin !== origin) return true;
      // Open-redirect pattern: ?to=https://other...
      for (const value of abs.searchParams.values()) {
        if (/https?:\/\//i.test(value)) {
          try {
            if (new URL(value).origin !== origin) return true;
          } catch {
            /* ignore */
          }
        }
      }
      const re = /https?:\/\/[^\s"'<>\\]+/gi;
      let m;
      while ((m = re.exec(abs.href))) {
        try {
          if (new URL(m[0].replace(/[),.;]+$/, '')).origin !== origin) return true;
        } catch {
          /* ignore */
        }
      }
      return false;
    } catch {
      return false;
    }
  }, targetOrigin);
}

async function recoverToOrigin(page, options, preferredUrl, log) {
  const candidates = [preferredUrl, options.url, options.baseUrl.href].filter(Boolean);
  for (const url of candidates) {
    try {
      if (isOffOrigin(url, options.baseUrl.origin)) continue;
      await page.goto(url, {
        waitUntil: options.waitUntil || 'domcontentloaded',
        timeout: options.timeout,
      });
      await settle(page, Math.min(options.timeout, 5000));
      if (!isOffOrigin(page.url(), options.baseUrl.origin)) return;
    } catch (err) {
      log.debug(`recover navigation failed (${url}): ${err.message}`);
    }
  }
}

async function settle(page, timeout) {
  // Prefer short quiet window — avoid networkidle (SSE deadlock)
  await sleep(Math.min(800, timeout));
  await Promise.race([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    sleep(1500),
  ]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeVisitUrl(url) {
  try {
    const u = new URL(url);
    if (u.hash === '#') u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

function isSessionDeath(before, after) {
  try {
    const path = new URL(after).pathname.toLowerCase();
    return /\/(login|signin|sign-in|logout|signout)(\/|$)/i.test(path);
  } catch {
    return false;
  }
}

async function addCookieString(context, cookieStr, baseUrl) {
  const cookies = cookieStr.split(';').map((p) => p.trim()).filter(Boolean);
  const list = [];
  for (const part of cookies) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    list.push({
      name: part.slice(0, eq).trim(),
      value: part.slice(eq + 1).trim(),
      domain: baseUrl.hostname,
      path: '/',
      secure: baseUrl.protocol === 'https:',
    });
  }
  if (list.length) await context.addCookies(list);
}

export { isStaticAsset, isJsUrl };
