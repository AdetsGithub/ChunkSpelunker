# ChunkSpelunker — Technical Specification

**Version:** 1.3.1  
**Status:** Implemented — see [`README.md`](./README.md) and [`docs/`](./docs/) for operator guides  
**Runtime:** Node.js ≥ 20  
**License:** MIT (intended)

> **v1.1–v1.3** — See §21–§23.  
> **v1.3.1** — SSE non-buffering, ReDoS-safe regex fallback, `--hydrate-format` for custom auth headers. See §24.  
> **Operator documentation:** [`docs/README.md`](./docs/README.md) (CLI, auth, exports, troubleshooting, security).  
> This SPEC remains the normative design reference; `docs/` explains how to run and extend the implementation.

---

## 1. Purpose

ChunkSpelunker is a headless CLI for authorized web application testing. It drives a modern SPA in Playwright, captures JavaScript chunks and live API traffic, recovers original sources from exposed source maps when available, statically extracts HTTP endpoints via Babel AST analysis (with regex fallback), and exports a deduplicated collection suitable for Postman or Burp Suite (via OpenAPI / Postman Collection v2.1).

It exists to close the gap between:

| Capability | Existing tools | Gap ChunkSpelunker fills |
|---|---|---|
| Source map tree extraction | `sourcemapper`, `unwebpack-sourcemap`, JS Miner | Not wired to live SPA crawl + export |
| Static JS endpoint mining | `jsluice`, `jshunter` | No dynamic chunk triggering / network merge |
| Traffic → OpenAPI | `mitmproxy2swagger`, Unbrowse | No JS chunk / source map / AST pipeline |
| Burp passive JS recon | JS Miner | Not a standalone CLI; requires Burp Pro |

ChunkSpelunker is the end-to-end pipeline: **browse → intercept → map → parse → merge → export**.

---

## 2. Goals & Non-Goals

### 2.1 Goals

1. Discover JS assets (including lazy-loaded Webpack/Vite/Rollup chunks) by exercising the SPA.
2. Discover and reconstruct source maps (external `.map`, `sourceMappingURL` comments, inline `data:` maps).
3. Extract API routes, HTTP methods, query/body parameter names from minified and reconstructed JS.
4. Capture live XHR/Fetch/WebSocket traffic during the session.
5. Merge static + dynamic findings, deduplicate, parameterize paths.
6. Export Postman Collection v2.1, OpenAPI 3.0, or raw JSON.
7. Support authenticated sessions via cookies, custom headers, and Playwright `storageState` (cookies + local/session storage).
8. Operate entirely via POSIX-style CLI flags.
9. Keep the CLI responsive under large JS corpora by offloading Babel parse/traverse to a worker pool.

### 2.2 Non-Goals (v1)

- Active exploitation, fuzzing, or authenticated attack chains.
- Solving interactive CAPTCHAs / Turnstile challenges (only basic UA / fingerprint spoofing).
- Full deobfuscation of heavily packed JS (beyond source maps + graceful AST/regex fallback).
- Full GraphQL schema introspection / SDL generation (out of scope). GraphQL traffic **is** captured, and `operationName` **is** used for deduplication and export naming (§10.2).
- Secrets/credential hunting as a primary product surface (may appear incidentally in raw export).
- Interactive TUI or web UI.
- Exhaustive discovery of every `addEventListener` click target (v1 uses broadened selectors + History API observation; full listener introspection is deferred).

---

## 3. Lessons From Reference Tools

These inform architecture; ChunkSpelunker does not vend or depend on them at runtime.

### 3.1 denandz/sourcemapper

- Parse Source Map **v3**; recreate source trees from `sources` / `sourcesContent`.
- Resolve map references from:
  - Direct `.map` URL
  - `//# sourceMappingURL=` on a JS file (absolute, relative, or `data:application/json;base64,...`)
- Support auth when fetching maps — but **do not** blindly reuse application `-H` headers against third-party map hosts (Sentry, internal CDN, etc.). Use dedicated `--map-header` for map fetches; attach `-H` only to same-origin (or explicitly allowlisted) destinations. See §8.4.
- **Security note:** following arbitrary `sourceMappingURL` values can cause SSRF-like fetches — restrict fetches to same-origin / allowlisted hosts by default, with an opt-in `--allow-external-maps`.

### 3.2 rarecoil/unwebpack-sourcemap

- Webpack prefixes (`webpack://`, `webpack://~/`, `(webpack)/`) must be normalized when writing reconstructed sources.
- Prefer `sourcesContent[]` when present; do not require fetching original `sources` URLs.
- Strip or de-prioritize Webpack runtime / bootstrap / `node_modules` noise for endpoint analysis (still keep app sources).
- HTML `detect` mode (scan `<script>` tags for `sourceMappingURL`) is a useful secondary discovery path after Playwright navigation.

### 3.3 BishopFox/jsluice

- Prefer **AST context** over regex: look for URLs in known call sites (`fetch`, `axios.*`, `XMLHttpRequest.open`, `$.ajax` / `$.get` / `$.post`, `window.open`, location assignments).
- Capture method/headers/body shape from surrounding AST nodes when present.
- For concatenations / template expressions, emit placeholders (`EXPR` in jsluice; ChunkSpelunker uses Postman-style `{{varName}}` when the identifier is known, else `{{param}}`).
- Custom matchers by node type (`CallExpression`, `StringLiteral`, `TemplateLiteral`, `AssignmentExpression`) map cleanly onto Babel traverse visitors.

### 3.4 cc1a2b/JShunter

- Regex endpoint extraction is a **required fallback** when Babel parse fails (obfuscated / truncated / non-JS MIME mislabeled as JS).
- Support cookies (`-c`), repeatable headers (`-H`), proxy, TLS skip — mirror these ergonomics where relevant.
- Graceful degradation: always analyze minified JS even when maps are absent (JS Miner lesson reinforced).

### 3.5 mitmproxy2swagger / Unbrowse

- Parameterize numeric / UUID path segments → `{id}`, `{id1}`, … when merging observed traffic.
- Deduplicate by normalized method + path template.
- Infer query parameter names and JSON body keys from observed requests.
- For CLI automation (unlike mitmproxy2swagger’s manual `ignore:` curation pass), ChunkSpelunker auto-includes all discovered API-like paths and filters obvious static assets (`.js`, `.css`, images, fonts, sourcemaps).

### 3.6 JS Miner (Dana Epp)

- Lazy loading / code splitting: crawling depth matters; walk the app to force chunk downloads.
- Never abort analysis if maps are missing — dump and parse minified bundles.
- Post-auth starting point is critical; cookies/headers must be applied before first navigation.

---

## 4. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI (Commander)                          │
│  -u/-c/-H/--state  -d  -o/-f  --map-header  --exclude-selector  │
│  --ast-workers/--ast-timeout  --map-concurrency                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Orchestrator (Pipeline)                     │
└──┬──────────────┬──────────────┬──────────────┬─────────────────┘
   │              │              │              │
   ▼              ▼              ▼              ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────────────┐
│ Browser  │ │ Source   │ │ AST      │ │ Merger & Exporter        │
│ Crawler  │ │ Map      │ │ Worker   │ │                          │
│+ History │ │ Engine   │ │ Pool     │ │ Dedupe (+ GraphQL op) →  │
│+ force   │ │+ disk    │ │(filePath │ │ AST path wins → Export   │
│  clicks  │ │  cache   │ │ → regex) │ │ + pageUrl permutations   │
└──────────┘ └──────────┘ └──────────┘ └──────────────────────────┘
```

### 4.1 Module Responsibilities

| Module | Path (proposed) | Responsibility |
|---|---|---|
| CLI | `src/cli.js` | Parse args, validate, invoke pipeline, exit codes |
| Orchestrator | `src/pipeline.js` | Ordered stages, shared context, progress logging |
| Browser / Crawler | `src/browser/crawler.js` | Playwright launch, auth/`storageState`, intercept, SPA crawl |
| History Observer | `src/browser/history-observer.js` | Hook `pushState`/`replaceState`/`hashchange` as navigations |
| Network Store | `src/browser/network-store.js` | Record requests/WS; disk-backed JS assets; `jsUrl → pageUrls` map; payload caps |
| Asset Cache | `src/browser/asset-cache.js` | Write intercepted JS/maps to `os.tmpdir()`; path handles only in memory; dedupe in-flight writes by hash |
| Source Map Engine | `src/sourcemap/discover.js`, `reconstruct.js` | Find maps, parse v3, reconstruct sources to disk; scoped headers |
| Header Policy | `src/http/header-policy.js` | Decide which headers attach to which fetch origin; hydrate Bearer from `storageState` |
| Authed Fetcher | `src/http/authed-fetch.js` | Same-origin map/JS re-fetch via Playwright `APIRequestContext` + hydrated headers; concurrency-limited |
| AST Analyzer | `src/analyze/ast-extractor.js` | Babel parse + traverse for HTTP client patterns (worker-safe) |
| AST Worker Pool | `src/analyze/ast-pool.js`, `ast-worker.js` | `worker_threads` pool; **file path** in → findings JSON out; `RangeError` → regex |
| Regex Fallback | `src/analyze/regex-fallback.js` | Endpoint/path regex when AST fails |
| GraphQL Utils | `src/analyze/graphql-utils.js` | Detect GraphQL bodies; extract `operationName` |
| URL Normalizer | `src/analyze/url-utils.js` | Resolve relative URLs against **each** known page context; template → `{{var}}` |
| Merger | `src/merge/dedupe.js` | Merge static + dynamic; AST path precedence; page-context permutations; GraphQL dedupe |
| Exporters | `src/export/{postman,openapi,raw}.js` | Format writers |
| Types / Models | `src/models.js` | Shared endpoint / finding shapes |
| Stealth | `src/browser/stealth.js` | UA, init scripts for basic bot evasion |

---

## 5. CLI Interface

### 5.1 Required / Core Flags (PRD)

| Flag | Type | Default | Description |
|---|---|---|---|
| `-u, --url <url>` | string | *(required)* | Target application URL |
| `-c, --cookie <string>` | string | — | Cookie header value for authenticated crawling |
| `-H, --header <string>` | string (repeatable) | — | App headers `Name: Value` — **same-origin only** for Node-side fetches (§8.4); Playwright context applies them to browser navigations |
| `-d, --depth <int>` | integer | `1` | How deep the crawler should exercise internal routes (Default: 1) |
| `-o, --output <file>` | string | `chunkspelunker-output.json` | Output path |
| `-f, --format <type>` | enum | `postman` | `postman` \| `openapi` \| `raw` |

### 5.2 Extended Flags (v1 recommended)

| Flag | Type | Default | Description |
|---|---|---|---|
| `--state <file>` | path | — | Playwright `storageState` JSON (cookies + `localStorage` / `sessionStorage` origins). Preferred for OAuth/OIDC SPAs that store JWTs in web storage |
| `--map-header <string>` | string (repeatable) | — | Headers used **only** when fetching source maps (e.g. Sentry/CDN credentials). Never mixed into browser app requests |
| `--map-origin <origin>` | string (repeatable) | — | Extra origins allowed to receive `--map-header` (and eligible for `--allow-external-maps`) |
| `--timeout <ms>` | integer | `30000` | Navigation / network idle timeout |
| `--wait-until <event>` | enum | `networkidle` | Playwright waitUntil: `load` \| `domcontentloaded` \| `networkidle` \| `commit` |
| `--headless` | boolean | `true` | Run headless; `--no-headless` for debug |
| `--user-agent <ua>` | string | realistic Chrome UA | Override User-Agent |
| `--proxy <url>` | string | — | HTTP(S) proxy (e.g. Burp `http://127.0.0.1:8080`) |
| `--insecure` | boolean | `false` | Ignore TLS errors |
| `--same-origin-only` | boolean | `true` | Only crawl same-origin routes; still record cross-origin API calls |
| `--allow-external-maps` | boolean | `false` | Permit fetching source maps from other origins (still without leaking `-H`) |
| `--include-vendor` | boolean | `false` | Analyze reconstructed `node_modules` / vendor sources |
| `--max-js <n>` | integer | `500` | Cap number of JS assets analyzed |
| `--max-js-bytes <n>` | integer | `5242880` (5 MiB) | Skip AST for individual files larger than this; regex-only fallback |
| `--max-body-bytes <n>` | integer | `262144` (256 KiB) | Truncate captured network `postData` / response bodies used for shape inference |
| `--tmpdir <dir>` | path | `os.tmpdir()/chunkspelunker-<pid>` | Scratch dir for intercepted JS / reconstructed sources (deleted on exit unless `--keep-tmpdir`) |
| `--keep-tmpdir` | boolean | `false` | Retain scratch directory after run (debug) |
| `--ast-workers <n>` | integer | `min(4, cpus-1)` | Size of the Babel worker pool |
| `--ast-timeout <ms>` | integer | `30000` | Per-file worker job timeout; on expiry terminate worker, replace in pool, `degradedReason: 'timeout'` |
| `--map-concurrency <n>` | integer | `4` | Max concurrent Node/Playwright map (and speculative `.map`) fetches |
| `--click-selector <css>` | string | see below | CSS selector for crawl click targets |
| `--exclude-selector <css>` | string | see below | Clickables matching this selector are **never** clicked (logout / destructive actions) |
| `--force-clicks` | boolean | `true` | Use Playwright `{ force: true }` on crawl clicks (bypass actionability / modal backdrops) |
| `--hydrate-format <template>` | string | `Authorization: Bearer {token}` | How hydrated storage tokens are attached for same-origin re-fetches. `{token}` is replaced with the discovered value. Examples: `x-api-key: {token}`, `Authorization: Token {token}`, `X-CSRF-Token: {token}` |
| `--save-sources <dir>` | string | — | If set, write reconstructed source tree to disk |
| `--verbose` | boolean | `false` | Debug logging to stderr |
| `--quiet` | boolean | `false` | Suppress non-error stderr |

**Default `--click-selector`:**

```text
a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"]
```

Operators may narrow (e.g. `nav a[href]`) or widen (e.g. add `[data-testid]`, `.MuiButton-root`) as needed.

**Default `--exclude-selector`:**

```text
[href*="logout" i], [href*="signout" i], [href*="sign-out" i],
[id*="logout" i], [class*="logout" i], [data-testid*="logout" i],
[aria-label*="log out" i], [aria-label*="sign out" i],
button:has-text("Log out"), button:has-text("Logout"), button:has-text("Sign out"),
button:has-text("Delete"), button:has-text("Delete account"), button:has-text("Remove account"),
a:has-text("Log out"), a:has-text("Sign out")
```

Notes:

- Playwright supports `:has-text()` and case-insensitive `i` attribute selectors in recent versions; if a selector fragment is unsupported in the pinned Playwright version, drop that fragment rather than failing the crawl.
- Defaults are best-effort session preservation — not a full destructive-action classifier. Operators should extend `--exclude-selector` for app-specific danger controls (`Revoke`, `Wipe`, `Clear cache`, etc.).
- Exclusion is applied **before** the click loop: candidates matching exclude are removed from the click set.

### 5.3 Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success (even if zero endpoints — empty collection written) |
| `1` | Invalid arguments / usage |
| `2` | Navigation / browser failure |
| `3` | Partial success with critical stage failure (e.g. export write failed) |

### 5.4 Example Invocations

```bash
# Unauthenticated shallow crawl → Postman
npx chunkspelunker -u https://app.example.com -o collection.json

# Cookie + header auth (simple session apps)
npx chunkspelunker -u https://app.example.com/dashboard \
  -c "session=abc; csrf=xyz" \
  -H "Authorization: Bearer eyJ..." \
  -d 3 \
  -f openapi \
  -o api.yaml

# OAuth/OIDC SPA: authenticate manually, export storageState, then crawl
#   playwright codegen --save-storage=auth.json https://app.example.com
npx chunkspelunker -u https://app.example.com/dashboard \
  --state ./auth.json \
  -d 3 -o collection.json

# Cross-origin maps (e.g. Sentry) without leaking app Bearer token
npx chunkspelunker -u https://app.example.com \
  -H "Authorization: Bearer app-token" \
  --allow-external-maps \
  --map-origin https://sentry.io \
  --map-header "Authorization: Bearer sentry-token" \
  --save-sources ./recovered-src \
  -f raw -o findings.json

# Through Burp
npx chunkspelunker -u https://app.example.com \
  --proxy http://127.0.0.1:8080 \
  -f postman -o collection.json
```

---

## 6. Execution Flow (Detailed)

```
1. INIT
   ├─ Parse & validate CLI
   ├─ Normalize base URL (origin + pathname)
   ├─ Create scratch dir (--tmpdir); register cleanup on exit
   ├─ If --state: load Playwright storageState; hydrate same-origin Authorization (§7.1.1)
   ├─ Else/also: parse -c cookies; note -H for browser context + same-origin authed fetches
   └─ Launch Chromium context (storageState | cookies, extraHTTPHeaders, UA, proxy)

2. INTERCEPT + LOAD
   ├─ Install History API hooks (pushState / replaceState / hashchange / popstate)
   ├─ page.on('request')  → record method, URL, headers; capture postData truncated to --max-body-bytes
   ├─ page.on('response') → for *.js: stream body to scratch file; record disk path + pageUrl association
   ├─ page.on('websocket') → record WS open URLs / frames (metadata)
   └─ page.goto(url, { waitUntil, timeout })

3. CRAWL (depth ≥ 1)
   ├─ Collect clickables via --click-selector; drop --exclude-selector matches
   ├─ For each candidate: click({ force: true }) → wait for network idle OR history URL change
   ├─ Treat History API / hash changes as first-class navigations (enqueue new path)
   ├─ Also harvest same-origin a[href] for direct goto fallback (still excluded)
   ├─ BFS/queue up to --depth; skip mailto:, javascript:, external (if same-origin-only)
   └─ Continue intercepting JS + API traffic (lazy chunks); update jsUrl→pageUrls map

4. SOURCE MAP DISCOVERY
   For each unique JS URL (capped by --max-js):
   ├─ Read from scratch path (or re-fetch via authed fetcher §7.1.1 / §8.4 → scratch)
   ├─ Parse trailing sourceMappingURL comment
   ├─ If data: → decode base64/URI JSON
   ├─ Else enqueue map fetch on --map-concurrency limiter
   ├─ Else try `{jsUrl}.map` probe via same limiter (if not already tried)
   └─ On 200 + valid JSON map → reconstruct sources to scratch

5. AST EXTRACTION (worker pool — never on main thread for large files)
   ├─ Build work queue: scratch file paths for minified + reconstructed app sources
   ├─ Dispatch to --ast-workers pool (worker_threads)
   │    each job: { id, filePath, url } → read → parse (≤ --ast-timeout) → findings
   ├─ Files > --max-js-bytes: skip Babel; regex-fallback only
   ├─ On SyntaxError OR RangeError OR timeout → degrade (regex / empty + degradedReason)
   └─ Main thread merges finding batches; relative paths left unresolved until MERGE

6. MERGE
   ├─ Expand relative AST paths: resolve all pageUrls → dedupe uniques → cap (§9.4)
   ├─ Union dynamic network endpoints + static AST endpoints
   ├─ Parse GraphQL bodies → attach operationName when present
   ├─ Filter static assets / telemetry noise heuristics
   ├─ Parameterize path segments; on merge **AST pathTemplate wins** (§10.3)
   ├─ Deduplicate with GraphQL-aware key (§10.2)
   └─ Attach provenance: source = network | ast | both; jsAsset; confidence

7. EXPORT
   ├─ postman → Collection v2.1 JSON (GraphQL ops named distinctly)
   ├─ openapi → OpenAPI 3.0 JSON (or YAML if output ends in .yaml/.yml)
   └─ raw → Internal findings schema JSON

8. CLEANUP
   └─ Delete scratch dir unless --keep-tmpdir
```

---

## 7. Browser Automation & Network Interception

### 7.1 Playwright Context

- Browser: Chromium (bundled with `playwright`).
- **Auth precedence:**
  1. `--state <file>` → `browser.newContext({ storageState })` (cookies + web storage per origin)
  2. `-c` cookies added via `context.addCookies` (merged on top if both provided)
  3. `-H` → `extraHTTPHeaders` on the context (browser will send these on navigations/XHR)
- Default viewport and locale set to common desktop values.
- Document in README: for SPAs that inject `Authorization` from `localStorage`, `--state` is required for the **browser** crawl; map/JS re-fetches must also be auth-synced (§7.1.1 / §8.4) or they 401 independently of a successful SPA session.

### 7.1.1 Auth Sync: Browser vs Map Fetcher

**Problem:** Playwright applies `storageState` (including `localStorage`) inside the page. Same-origin `.map` discovery historically used Node `fetch` with only `-c` / `-H`. Tokens that exist solely in `localStorage` never reach Node → authenticated maps return **401** while the crawl itself succeeds.

**v1.3 rule — same-origin re-fetches must share browser auth:**

1. **Transport:** Prefer Playwright `APIRequestContext` (`browserContext.request.get/…`) for same-origin map and missing-JS re-fetches. This automatically sends the context cookie jar (including cookies from `--state` / `-c`).
2. **Header hydration from `storageState`:** On INIT, parse `--state` JSON. For each `origins[]` entry whose origin matches the target (or is listed for same-origin policy), scan `localStorage` / `sessionStorage` entries for well-known token keys (case-insensitive):

   ```text
   access_token, id_token, token, authToken, auth_token, jwt, accessToken, idToken, bearer, authorization
   ```

   If the value looks like a JWT (`eyJ…`) or a non-empty opaque token, and the operator did **not** already pass a conflicting `-H` for the same header name, synthesize using `--hydrate-format` (default `Authorization: Bearer {token}`):

   ```text
   # default
   Authorization: Bearer <value>

   # --hydrate-format "x-api-key: {token}"
   x-api-key: <value>

   # --hydrate-format "Authorization: Token {token}"
   Authorization: Token <value>
   ```

   Parse `--hydrate-format` as `Header-Name: prefix-or-template-with-{token}`. Exactly one `{token}` placeholder is required. Attach the resulting header to **same-origin** `APIRequestContext` / policy-approved fetches only (never to third-party `--map-origin` hosts — those still use `--map-header` exclusively).

3. **Explicit `-H` wins** over hydration when the same header name is already set.
4. **Exotic key names** (e.g. `okta-token-storage` JSON blobs): best-effort parse common Okta/Auth0 shapes; otherwise document that operators must pass `-H`. Do not fail INIT if hydration finds nothing.
5. **Cross-origin maps:** unchanged — `--map-header` / `--map-origin` only; never send hydrated app tokens off-origin.

Log at `--verbose`: `[.] hydrated header via --hydrate-format from storageState key=access_token` (do not print the token value).

### 7.2 Stealth / Anti-Bot (Basic)

Inspired by common Playwright evasion needs (not a full undetected-chromedriver replacement):

- Realistic Chrome User-Agent (overridable).
- Init script to harden trivial checks:
  - `navigator.webdriver` → `undefined` / false
  - Reasonable `navigator.languages`, `plugins` length stubs
- Do **not** claim to bypass Cloudflare Turnstile or similar; document limitation. If blocked, exit with clear error and suggest `--no-headless` / proxy / `--state` from a manual session.

### 7.3 Asset Classification

| Signal | Classification |
|---|---|
| URL ends with `.js` / `.mjs` / `.cjs` | JS asset |
| `content-type` contains `javascript` / `ecmascript` | JS asset |
| URL ends with `.map` | Source map (store; don't AST) |
| Request resource type `xhr` / `fetch` | API candidate |
| `content-type` contains `text/event-stream` | **SSE** — record URL/method only; never call `response.body()` |
| `websocket` | WS endpoint |
| Static extensions (css, png, woff2, …) | Ignore for endpoint merge |

### 7.4 Crawl Strategy (SPA-aware)

Modern SPAs rarely expose every route as `<a href>`. v1 crawl is **interaction + history** based:

1. **Seed:** target URL at depth 0; install History hooks before first navigation (§7.5).
2. **Discover clickables** after each settle using `--click-selector` (default includes `a[href]`, `button`, `[role="button"]`, `[role="link"]`, `[role="tab"]`, `[role="menuitem"]`).
3. **Filter exclusions:** drop any candidate matching `--exclude-selector` (default logout / sign-out / delete patterns — §5.2). This is the primary defense against “Log Out” / “Delete Account” killing the session on click #4.
4. **Click loop:** for each remaining unique element (cap per page, e.g. 40):
   - Record `location.href` before click
   - `element.click({ force: true, timeout })` when `--force-clicks` (default **true**) — bypasses Playwright actionability checks so modal backdrops / z-index overlays do not abort the remaining click budget
   - Optional cheap recovery (best-effort, non-blocking): after each click, `page.keyboard.press('Escape')` once to dismiss simple dialogs (does not replace `force: true`)
   - Wait for either: network quiet window **or** History URL change **or** small timeout
   - If URL changed (path/query/hash) → count as navigation; enqueue at depth+1; harvest new clickables
   - **Session-death heuristic (soft):** if after a click the page lands on a URL matching `/login|/signin|/sign-in|/logout` (configurable later) and previously was authenticated, log `[!] possible session end` and stop further clicks on this page (continue other queued URLs only if still authenticated — v1: stop crawl early with warning)
5. **Href harvest:** additionally collect same-origin `a[href]` for `page.goto` fallback when click did not change location but href is novel — still apply `--exclude-selector`.
6. **Dedup visits** by normalized URL (include hash for hash-routers; strip only empty `#`).
7. **Skip:** `mailto:`, `tel:`, `javascript:`, `blob:`, download attributes, external origins when `--same-origin-only`.
8. **Caps:** `min(discovered, depth_budget, hard_cap=100 navigations, hard_cap=250 clicks)`.

**Why `force: true` (v1):** Full modal-detection / “click the close button” DOM-reset loops are expensive and brittle. Forced clicks keep the crawl moving when click #3 opens a “Confirm Settings” backdrop that would otherwise fail clicks #4–#40 on actionability. Operators may set `--no-force-clicks` for stricter, human-like interaction when debugging.

**Deferred (not v1):** walking `getEventListeners`-style maps, CDP DOMDebugger listener introspection, or robust modal-close heuristics. History observation + broadened selectors + forced clicks + exclude lists cover the majority of React/Vue/Angular router apps.

### 7.5 History API Observation

Install via `page.addInitScript` (runs before app code):

```js
(() => {
  const emit = (reason) => {
    window.dispatchEvent(new CustomEvent('__cs_nav__', {
      detail: { href: location.href, reason },
    }));
  };
  const wrap = (fn) => function (...args) {
    const ret = fn.apply(this, args);
    emit(fn.name);
    return ret;
  };
  history.pushState = wrap(history.pushState);
  history.replaceState = wrap(history.replaceState);
  window.addEventListener('popstate', () => emit('popstate'));
  window.addEventListener('hashchange', () => emit('hashchange'));
})();
```

Playwright side: `page.evaluate` subscription or `page.exposeFunction('__cs_reportNav', …)` bridged from the custom event so the crawler queue learns about client-side route changes that never triggered a full document load (and thus never fired `framenavigated` alone in some setups). Always also listen to `page.on('framenavigated')` as a belt-and-suspenders signal.

### 7.6 Request Body Capture (shape only)

- Capture `postData` for XHR/Fetch when available, **truncated to `--max-body-bytes` (default 256 KiB)**.
- If truncated, set `bodyTruncated: true` on the network record; still attempt JSON parse on the retained prefix for key-name inference (best-effort).
- Do **not** buffer full response bodies for API calls by default. If response shape is desired later, sample at most `--max-body-bytes` and discard.
- File uploads / bulk telemetry / multipart bodies over the cap are recorded as method+URL+content-type only (no payload retention).
- **SSE / never-ending responses (critical):** Before any `response.body()` / buffer read, inspect `content-type`. If it includes `text/event-stream` (or other intentionally open streams):
  - Record method + URL (+ optional `Accept` / event-stream hint) as an endpoint finding (`source: network`, note `sse: true`)
  - **Never** call `response.body()`, never write to the asset cache, never wait on the body promise
  - Do **not** rely on `networkidle` alone for crawl settle when SSE is detected on the page — prefer short quiet-window / History-change waits (§7.4) so open streams cannot deadlock the pipeline
- **GraphQL detection:** if path matches `/graphql` / `/gql` (case-insensitive suffix) **or** JSON body (within the truncated window) has `query` / `operationName` / `variables`:
  - Extract `operationName` when present
  - If only a raw `query` string, best-effort parse the first operation name via lightweight regex (`(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)`)
  - Store on the network call for dedupe (§10.2) and export naming
- Do not log or export Authorization header values into collection auth unless user-supplied via `-H`/`-c`/`--state` metadata (echo only what user provided as collection variables).

### 7.7 Disk-Backed JS Asset Cache

**Never** hold up to `--max-js` full source strings in `PipelineContext`.

On each JS response (and on Node re-fetch):

1. **Gate on content-type / resource type first.** Skip `response.body()` entirely for `text/event-stream` and non-JS types (§7.3 / §7.6).
2. Only then obtain the body Buffer (Playwright resolves a full Buffer — see notes below) and write to `{tmpdir}/js/{sha256(url).slice(0,16)}.js`.
3. Store only metadata in memory:

```ts
interface JsAssetMeta {
  url: string;
  diskPath: string;
  contentType?: string;
  byteLength: number;
  pageUrls: Set<string>;  // every page location.href observed when this asset loaded
}
```

4. When a JS response is seen, add **current** `page.url()` (post-History-normalized) to `pageUrls`.
5. Reconstructed source-map files likewise land under `{tmpdir}/src/...` with path handles in a metadata map — not a `Map<string, string>` of full sources.
6. AST workers receive `diskPath` (+ `pageUrls` snapshot as `string[]`); they `fs.readFile` locally. OS page cache handles repeated reads; main thread stays lean.
7. On process exit: `fs.rm(tmpdir, { recursive: true })` unless `--keep-tmpdir`.

Rationale: 500 × ~2 MB strings ≈ 1 GB+ before V8 overhead. Disk-backed handles keep RAM proportional to metadata + in-flight worker reads.

**Implementation notes (non-normative):**

- **Playwright is not a true stream source.** `response.body()` resolves a full `Buffer` in memory; there is no public Node `ReadableStream` from the network layer without raw CDP. Write that Buffer to disk immediately (`fs.promises.writeFile` or a write-stream fed once), drop all references, and let GC reclaim it. The OOM win is still realized because bodies are **not retained** in `PipelineContext` — only transient during the write. **Never invoke `body()` on SSE.**
- **Concurrent write collisions.** The same chunk URL may fire multiple overlapping `response` events (main frame + worker, rapid navigations). `AssetCache` must track an in-memory `Set` (or `Map<hash, Promise<void>>`) of in-flight writes keyed by content/url hash. If a second response arrives for a hash already being written (or already present on disk), **drop the duplicate payload** and await the first write’s promise instead of opening a second writer to the same path.

---

## 8. Source Map Engine

### 8.1 Discovery Order (per JS file)

1. Inline `//# sourceMappingURL=data:application/json;...` or `//@ sourceMappingURL=...`
2. External URL from `sourceMappingURL` (resolve relative to JS URL)
3. Speculative `{jsUrl}.map` GET
4. Optional: HTML `<script>` scan already covered via network intercept of those scripts

### 8.1.1 Fetch Concurrency (no thundering herd)

Map discovery over hundreds of lazy chunks **must not** fire unbounded parallel GETs (WAF 429 / accidental DoS).

- All speculative `.map` probes and external `sourceMappingURL` downloads share a global concurrency limiter (`--map-concurrency`, default **4**).
- Implement with a small semaphore / `p-limit`-style queue (dependency optional — a hand-rolled pool is fine).
- Prefer: process JS assets sequentially for “parse comment → maybe enqueue fetch”, with at most N fetches in flight.
- On HTTP 429: exponential backoff for that host (e.g. 1s, 2s, 4s; max 3 retries) then skip remaining speculative probes for that host with a warning.
- `data:` maps never consume the fetch limiter.

### 8.2 Reconstruction

Using Mozilla `source-map` (and/or direct `sources` + `sourcesContent` extraction for speed):

- Validate `version === 3`.
- Prefer `sourcesContent[i]` for each `sources[i]`.
- Normalize paths:
  - Strip `webpack://`, `webpack:///`, `webpack://./`, `webpack://~/`, `(webpack)/`
  - Collapse `../` safely under an output root when `--save-sources` is set
  - Reject path traversal outside output root
- Skip empty / `"null"` contents.
- Tag each reconstructed file with originating map URL and JS URL.

### 8.3 Analysis Priority

1. Reconstructed **application** sources (paths under `src/`, `app/`, `pages/`, etc., or anything not clearly vendor)
2. Minified bundle itself (always)
3. Vendor / `node_modules` only if `--include-vendor`

### 8.4 Header Policy for Map / Asset Re-fetches

Same-origin and cross-origin fetches use different transports and credential sets. **Do not** use a bare Node `fetch` with only `-c`/`-H` when `--state` supplied the real session.

| Destination | Transport | Headers / credentials |
|---|---|---|
| Same origin as `-u` | Playwright `APIRequestContext` (preferred) | Cookie jar from context/`storageState`/`-c` **+** explicit `-H` **+** hydrated Bearer from `storageState` localStorage (§7.1.1) when `-H Authorization` absent |
| Origin listed in `--map-origin` | Node `fetch` or `APIRequestContext` | `--map-header` only (never hydrated app Bearer; cookies only if domain matches — usually none) |
| Other origin + `--allow-external-maps` | Node `fetch` | **No** `-H` / no hydration; only `--map-header` if origin ∈ `--map-origin`, else unauthenticated GET |
| Other origin without `--allow-external-maps` | — | **Do not fetch** (log skip) |

Rationale:

- App JWTs in `localStorage` must still authenticate same-origin `.map` GETs without forcing the operator to duplicate the token as `-H`.
- App `Authorization` must never be sent to `sentry.io` / Datadog / random CDNs — those use `--map-header`.

Playwright **page** traffic is unaffected: the SPA’s own interceptors read `localStorage` as usual.

**Implementation note (non-normative):** All `--map-header` values are broadcast to **every** `--map-origin`. v1 does **not** support per-origin header binding. Document in README.

---

## 9. AST Pattern Matching

### 9.0 Worker Pool (event-loop safety)

Babel parse + traverse of multi-megabyte minified vendor chunks **must not** run on the main thread.

**Design:**

- Module `src/analyze/ast-pool.js` owns a fixed pool of `worker_threads` (`--ast-workers`, default `min(4, cpus-1)`, minimum 1).
- Worker entry `src/analyze/ast-worker.js` imports extractor + regex fallback only (no Playwright).
- Job protocol (structured clone / JSON) — **pass paths, not multi-MB strings, across IPC:**

```ts
// main → worker
{
  jobId: string,
  url: string,
  filePath: string,           // absolute path under tmpdir
  pageUrls: string[],         // contexts that loaded this asset (for merger; optional here)
  mode: 'ast' | 'regex-only',
  maxJsBytes: number,
}

// worker → main
{
  jobId: string,
  ok: true,
  findings: EndpointFindingDraft[],  // may contain unresolved relative rawPath
  engine: 'ast' | 'regex',
  degradedReason?: 'max-bytes' | 'syntax' | 'range-error' | 'read-error' | 'timeout',
}
// or
{
  jobId: string,
  ok: false,
  error: string,
  findings: EndpointFindingDraft[],  // regex fallback results if any
  degradedReason?: string,
}
```

**Lifecycle per job:**

1. `fs.readFile(filePath, 'utf8')` inside the worker (not preloaded on main)
2. If `mode === 'regex-only'` OR `code.length > maxJsBytes` → regex only
3. Else attempt Babel:

```js
try {
  const ast = parser.parse(code, { /* §9.1 */ });
  findings = extractFromAst(ast, url);
} catch (err) {
  // errorRecovery does NOT catch V8 stack overflows on pathological nests
  if (err instanceof RangeError || err instanceof SyntaxError || err?.code === 'BABEL_PARSE_ERROR') {
    findings = regexFallback(code, url);
    return { ok: true, findings, engine: 'regex', degradedReason: err instanceof RangeError ? 'range-error' : 'syntax' };
  }
  throw err; // unexpected — let pool restart worker
}
```

4. Drop all references to AST and `code`; return serializable findings only
5. Main thread never retains ASTs or full source strings — only findings + asset metadata

**Backpressure:** queue jobs; at most `ast-workers` in flight; stream progress (`[.] analyzed 42/180`).

**Per-job timeout (hang protection):**

- Each job is raced against `--ast-timeout` (default **30000** ms).
- On timeout: `worker.terminate()`, remove from pool, spawn a replacement worker, return `{ ok: true, findings: [], engine: 'none', degradedReason: 'timeout' }` (optionally attempt a quick regex-only pass in a **fresh** worker with a shorter timeout, e.g. `min(ast-timeout, 10000)` — if that also times out, empty findings).
- Rationale: obfuscated bundles / giant literal arrays may not throw `RangeError`; they spin forever and permanently shrink the pool if only crash-based recovery exists.

**Failure isolation:** a worker OOM/crash/timeout is restarted; that job does not block the queue.

### 9.1 Parser Config

```js
@babel/parser.parse(code, {
  sourceType: 'unambiguous',
  errorRecovery: true,
  plugins: [
    'jsx', 'typescript', 'classProperties', 'dynamicImport',
    'optionalChaining', 'nullishCoalescingOperator',
    'objectRestSpread', 'topLevelAwait',
  ],
})
```

Use `errorRecovery: true` to salvage partial trees from broken/minified input when possible. **Note:** `errorRecovery` does not prevent V8 `RangeError: Maximum call stack size exceeded` on deeply nested bundles — that path is handled in §9.0 via explicit `catch`.

### 9.2 Primary Visitors (jsluice-inspired)

#### A. `fetch(url, init?)`

- Arg0: string / template literal → URL
- Arg1 object: `method`, `headers`, `body`
- Infer method default `GET`

#### B. Axios-style

- `axios(config)` / `axios.request(config)` — `url`, `method`, `params`, `data`
- `axios.get|post|put|patch|delete|head|options(url, …)`
- `axios.create(...).get(...)` — best-effort via MemberExpression chain ending in HTTP verb
- Identifiers aliased to axios (`api.get`) — optional heuristic: callee property name ∈ REST verbs AND first arg looks like path

#### C. `XMLHttpRequest`

- `xhr.open(method, url)`
- Track object binding best-effort within same function scope (v1: same contiguous statement sequence)

#### D. jQuery / Angular-ish

- `$.ajax({ url, type/method, data })`
- `$.get` / `$.post`
- `$http.get|post|put|delete|patch` (AngularJS)
- `HttpClient` patterns (`this.http.get`) — MemberExpression `.get|.post|...` with path-like first arg

#### E. Generic string / template harvesting (lower confidence)

- StringLiteral / TemplateLiteral matching:
  - starts with `/` and contains API-like segment (`/api/`, `/v1/`, `/graphql`, `/rest/`, …), OR
  - absolute `http(s)://`
- Exclude obvious static file paths (`.js`, `.css`, `.png`, …)
- Confidence: `low` unless found inside a known client call

### 9.3 Template Literal Handling

Input:

```js
`/api/v1/users/${userId}/profile`
```

Output path:

```text
/api/v1/users/{{userId}}/profile
```

Rules:

- Named `Identifier` / `MemberExpression` property → `{{identifier}}` (last property name for `user.id` → `{{id}}` or `{{userId}}` if simple id; prefer raw identifier name when Identifier).
- Complex expressions → `{{param}}` or indexed `{{paramN}}`.
- Binary `+` concatenations: join literal parts; replace non-literals with `{{EXPR}}` (jsluice-compatible) then map `EXPR` → `param` for Postman if unnamed.

### 9.4 Relative Path Resolution (page-context aware)

Absolute paths (`/users/me`) and absolute URLs resolve against the target **origin** once.

**Relative** paths (`./data`, `../users`, `data.json`) are ambiguous under code-splitting: the same chunk may load on multiple routes.

| Found | Resolution |
|---|---|
| `/users/me` | `{origin}/users/me` |
| `https://api.other.com/v1/x` | keep absolute |
| `//cdn.example.com/...` | apply page protocol |
| `./data` / `../x` / `data` | **permute** against every `pageUrl` in `jsAsset.pageUrls` (§7.7) |

**Algorithm (Merger, not worker):**

1. AST/regex extractor emits `rawPath` as found (e.g. `./data`) plus `jsUrl`.
2. Look up `pageUrls = networkStore.pageUrlsFor(jsUrl)`.
3. If `pageUrls` is empty, fall back to `[baseUrl.href]` and/or the JS asset URL’s directory as a last resort.
4. Resolve against **all** `pageUrls`: `resolvedUrl = new URL(rawPath, pageUrl).href` (WHATWG).
5. **Normalize + deduplicate** the resolved absolute URLs first (Set). Many item-detail pages (`/items/1` … `/items/50`) often collapse `../data` to a single absolute URL — do not discard “extra” page contexts before resolving.
6. Only if the count of **unique** resolved URLs exceeds the cap (default **20**), truncate the unique set (stable sort, keep first 20) and log `[!] relative path {{rawPath}} produced N unique resolutions; capped to 20`.
7. Emit one finding per remaining unique `resolvedUrl`.

Example: `chunk.123.js` contains `fetch('./data')` and was observed on `/dashboard/reports` and `/dashboard/settings` → two unique URLs → both exported. Same chunk on `/items/1`…`/items/50` resolving to one URL → single export (not 50, not capped away).

Store `rawPath`, `resolvedUrl`, and `resolvedFromPage` (one representative pageUrl) on each finding for provenance.

### 9.5 Regex Fallback (JShunter-inspired)

Applied when Babel throws (`SyntaxError`, **`RangeError`**, or other parse failures), when `errorRecovery` still yields an unusable tree, or when a file exceeds `--max-js-bytes`:

**ReDoS hard requirement:** Never run path-matching regex against a multi-megabyte **single contiguous** string. Catastrophic backtracking on a 5 MiB one-liner will hang the worker until `--ast-timeout` and yield nothing.

Before regex extraction:

1. If `code.length > 256_000` (or always for `--max-js-bytes` bypass path), **chunk** the input first:
   - Prefer splits on `\n`, `;`, `,`, `` ` ``, and string-boundary-ish sequences
   - Process chunks of at most ~64–128 KiB independently
   - Cap total chunks scanned (e.g. 2000) to bound worst-case work
2. Use **strictly linear** patterns only (no nested quantifiers on overlapping classes). Prefer anchored / possessive-style constructs where possible; reject patterns known to be vulnerable.
3. Per-chunk match budget: stop scanning a chunk after N matches (e.g. 50) and move on.

Extraction targets (per chunk):

- Path-like strings: `/[a-zA-Z0-9_\-./{}]+` (applied to bounded windows, not the whole file at once)
- Absolute URLs
- Common API prefixes
- Deduplicate and run through same normalizer / confidence tagging (`source: regex`)
- Relative matches follow the same page-context permutation rules in the Merger (§9.4)

---

## 10. Merge, Deduplication & Path Parameterization

### 10.1 Endpoint Record (canonical)

```ts
interface EndpointFinding {
  method: string;              // UPPERCASE; default GET
  url: string;                 // resolved absolute URL or path template
  pathTemplate: string;        // path with {{var}} or {id}
  queryParams: string[];       // names only
  bodyParams: string[];        // JSON keys if inferred
  headers: Record<string, string>; // non-sensitive observed/inferred
  source: 'network' | 'ast' | 'regex' | 'both';
  confidence: 'high' | 'medium' | 'low';
  evidence: {
    jsUrls?: string[];
    mapUrls?: string[];
    sampleRequest?: { url: string; status?: number };
    resolvedFromPage?: string; // page context used for relative resolution
    rawPath?: string;          // unresolved path as extracted
  };
  websocket?: boolean;
  /** Set when request is GraphQL; used in dedupe + export names */
  graphql?: {
    operationName?: string;
    operationType?: 'query' | 'mutation' | 'subscription' | 'unknown';
    hasQuery: boolean;
  };
}
```

### 10.2 Dedup Key

**Default (REST):**

```text
normalize(method) + " " + normalize(pathTemplate) + " " + sortedQueryNames
```

For dedupe comparison, normalize Postman `{{userId}}` and OpenAPI/network `{id}` forms to a comparable structural template (segment shapes), but **retain** the preferred display `pathTemplate` per §10.3 precedence when emitting.

**GraphQL-aware:** when `isGraphQL(finding)` is true — path ends with `/graphql` or `/gql`, **or** `graphql.hasQuery` / body keys indicate GraphQL — extend the key:

```text
normalize(method) + " " + normalize(pathTemplate)
  + " " + sortedQueryNames
  + " GQL:" + (operationName || hashQueryPreview(query, 64) || "anonymous")
```

Examples:

| Observed | Dedup identity |
|---|---|
| `POST /graphql` op `GetUser` | distinct from `CreateUser` |
| `POST /graphql` op `GetUser` (again) | merged |
| `POST /graphql` anonymous query A vs B | distinct via query preview hash |
| `GET /api/users/{id}` | REST key only |

Without this rule, GraphQL-heavy SPAs collapse to a single useless `POST /graphql` item in Postman.

### 10.2.1 Field Precedence on Merge

When network + static findings collapse to the same dedup identity:

| Field | Winner | Rationale |
|---|---|---|
| `method` | **Network** (else AST) | Observed traffic is ground truth |
| `pathTemplate` | **AST / regex semantic template** over network-inferred `{id}`/`{uuid}` | Developer names (`{{userId}}`) beat generic guesses |
| `queryParams` / `bodyParams` | **Union** | Max coverage |
| `graphql.operationName` | Prefer non-empty | — |
| `confidence` | Max / bump to high if both | — |
| `source` | `both` | — |

Example:

- Network: `/api/v1/users/{id}/profile`
- AST: `/api/v1/users/{{userId}}/profile`
- Merged export path: `/api/v1/users/{{userId}}/profile` (Postman) / `/api/v1/users/{userId}` (OpenAPI)

If only network exists, keep network parameterization. If only AST exists, keep AST.

### 10.3 Path Parameterization (mitmproxy2swagger-inspired)

Replace path segments matching:

| Pattern | Placeholder |
|---|---|
| All digits | `{id}` / `{id1}` … |
| UUID (v4-ish) | `{uuid}` |
| Long hex (≥ 16) | `{hexId}` |
| Already `{{name}}` from AST | keep Postman form; OpenAPI maps `{{name}}` → `{name}` |

Static vs templated:

- Network examples `/users/1`, `/users/2` → `/users/{id}`
- AST template `/users/{{userId}}` → Postman `/users/{{userId}}`; OpenAPI `/users/{userId}`
- On merge with both: **AST template wins** (§10.2.1)

### 10.4 Noise Filtering

Drop or demote:

- Static asset URLs
- Source map URLs
- Data URIs
- Extremely long paths (> 512 chars)
- Known analytics hosts (optional small denylist: google-analytics, segment, etc.) — configurable later

---

## 11. Collection Generation

### 11.1 Postman Collection v2.1 (`-f postman`)

```json
{
  "info": {
    "name": "ChunkSpelunker — {hostname}",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    "description": "Auto-generated by ChunkSpelunker"
  },
  "variable": [
    { "key": "baseUrl", "value": "https://target.origin" }
  ],
  "item": [
    {
      "name": "GET /api/v1/users/{{userId}}",
      "request": {
        "method": "GET",
        "header": [],
        "url": "{{baseUrl}}/api/v1/users/{{userId}}"
      }
    }
  ]
}
```

- Group by first path segment or flat list (v1: flat sorted list).
- Include query params as Postman `query` array with empty values for fuzzing.
- If user passed `-H` / `-c` / `--state`, add collection-level header/cookie variables where sensible (do not dump full `localStorage`).
- **GraphQL items:** name as `GQL {operationType} {operationName}` (e.g. `GQL query GetUser`); body mode `graphql` when Postman supports it, else raw JSON with `query` / `variables` / `operationName` placeholders.

### 11.2 OpenAPI 3.0 (`-f openapi`)

```yaml
openapi: 3.0.3
info:
  title: ChunkSpelunker — {hostname}
  version: "1.0.0"
servers:
  - url: https://target.origin
paths:
  /api/v1/users/{userId}:
    get:
      parameters:
        - name: userId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Observed or inferred
```

- Convert `{{var}}` → `{var}`.
- Infer body schemas as `type: object` with known property names when bodyParams present.
- WebSockets: document under `paths` with a vendor extension `x-websocket: true` or list in `x-websockets` (v1).
- GraphQL: single path entry `/graphql` (or observed path) with `x-graphql-operations: [{ operationName, operationType, … }]` listing distinct ops — OpenAPI cannot natively express multi-op POST collapse; Postman/`raw` remain the preferred GraphQL testing exports.

### 11.3 Raw (`-f raw`)

Emit internal pipeline result:

```json
{
  "target": "https://...",
  "generatedAt": "ISO-8601",
  "stats": {
    "jsAssets": 0,
    "sourceMaps": 0,
    "reconstructedFiles": 0,
    "networkEndpoints": 0,
    "staticEndpoints": 0,
    "mergedEndpoints": 0
  },
  "jsAssets": [],
  "sourceMaps": [],
  "endpoints": [],
  "websockets": []
}
```

---

## 12. Data Flow Contracts

### 12.1 Pipeline Context

```ts
interface PipelineContext {
  options: CliOptions;
  baseUrl: URL;
  tmpdir: string; // scratch root; cleaned on exit unless --keep-tmpdir
  /** Metadata only — bodies live on disk at diskPath */
  jsAssets: Map<string, JsAssetMeta>;
  /** Reconstructed sources: logicalPath -> diskPath (not file contents) */
  reconstructed: Map<string, { diskPath: string; fromMapUrl: string; fromJsUrl: string }>;
  networkCalls: NetworkCall[]; // postData truncated to max-body-bytes
  websockets: string[];
  findings: EndpointFinding[];
}

interface JsAssetMeta {
  url: string;
  diskPath: string;
  contentType?: string;
  byteLength: number;
  pageUrls: Set<string>;
}

interface NetworkCall {
  method: string;
  url: string;
  resourceType?: string;
  postData?: string;          // truncated
  bodyTruncated?: boolean;
  requestContentType?: string;
  status?: number;
  pageUrl?: string;           // location when request fired
  graphql?: EndpointFinding['graphql'];
}
```

**Memory invariant:** peak RSS should scale with (metadata + worker count × largest single file read), not with `Σ jsAsset bytes`.

### 12.2 Logging

- Info progress on stderr: `[+]`, `[.]`, `[!]` style (sourcemapper-like).
- JSON output **only** to the `-o` file (stdout unused unless `-o -` later).
- `--verbose` prints per-asset analysis decisions.

---

## 13. Technical Stack

| Concern | Library | Why |
|---|---|---|
| Runtime | Node.js ≥ 20 | Native ESM, `fetch`, `worker_threads`, matches PRD |
| CLI | `commander` | POSIX flags, `--help`, repeatable `-H` / `--map-header` |
| Browser | `playwright` | Network interception, `storageState`, modern SPA support |
| AST | `@babel/parser`, `@babel/traverse`, `@babel/types` | JS/TS/JSX tolerant parsing (inside workers) |
| Concurrency | `node:worker_threads` | Isolate Babel CPU work from CLI event loop |
| Source maps | `source-map` | Spec-compliant consumer |
| HTTP (map re-fetch) | native `fetch` | Header-policy-aware map/JS fetches |
| YAML (optional OpenAPI) | `yaml` | If output extension is `.yaml`/`.yml` |

### 13.1 Package Layout

```text
ChunkSpelunker/
├── SPEC.md
├── README.md
├── package.json
├── bin/
│   └── chunkspelunker.js          # shebang entry
├── src/
│   ├── cli.js
│   ├── pipeline.js
│   ├── models.js
│   ├── browser/
│   │   ├── crawler.js
│   │   ├── history-observer.js
│   │   ├── network-store.js
│   │   ├── asset-cache.js
│   │   └── stealth.js
│   ├── http/
│   │   ├── header-policy.js
│   │   └── authed-fetch.js
│   ├── sourcemap/
│   │   ├── discover.js
│   │   └── reconstruct.js
│   ├── analyze/
│   │   ├── ast-extractor.js
│   │   ├── ast-pool.js
│   │   ├── ast-worker.js
│   │   ├── regex-fallback.js
│   │   ├── graphql-utils.js
│   │   └── url-utils.js
│   ├── merge/
│   │   └── dedupe.js
│   └── export/
│       ├── postman.js
│       ├── openapi.js
│       └── raw.js
├── test/
│   ├── fixtures/
│   ├── ast-extractor.test.js
│   ├── url-utils.test.js
│   ├── dedupe.test.js
│   ├── graphql-utils.test.js
│   ├── header-policy.test.js
│   └── sourcemap.test.js
└── examples/
    └── sample-output.postman.json
```

### 13.2 npm Scripts

- `npm start` / `node bin/chunkspelunker.js`
- `npm test` — Node test runner or Vitest/Jest (prefer node:test for zero config)
- `npm run lint` — optional ESLint later

---

## 14. Edge Cases & Explicit Behaviors

| Edge case | Behavior |
|---|---|
| CORS | Browser context handles naturally; map/JS re-fetch uses Node fetch with **header policy** (§8.4) |
| WAF / bot block | Stealth basics; on challenge page, warn and continue with whatever JS loaded |
| Relative API paths | Absolute → origin; relative → resolve all pageUrls, **dedupe uniques, then cap** (§9.4) |
| Template URLs | `{{var}}` in Postman; `{var}` in OpenAPI |
| AST vs network path names | **AST semantic template wins** on merge (§10.2.1) |
| Auth desync (`--state` vs map GET) | Same-origin maps via `APIRequestContext` + hydrated Bearer from storageState (§7.1.1) |
| No source maps | Analyze minified JS only; continue |
| Invalid map JSON | Log skip; continue |
| Babel `SyntaxError` | Regex fallback (in worker) |
| Babel `RangeError` (stack overflow) | Catch explicitly → regex fallback; do not rely on `errorRecovery` alone |
| AST worker hang / spin | `--ast-timeout` → terminate worker, replace, `degradedReason: 'timeout'` |
| Speculative `.map` storm | `--map-concurrency` queue; 429 backoff |
| Logout / destructive click | Default `--exclude-selector`; soft session-death heuristic |
| Large JS (> `--max-js-bytes`) | Skip Babel; regex-only in worker |
| Main-thread freeze / OOM from JS corpus | Disk-backed asset cache (§7.7); workers read files; no full-body Map |
| Huge XHR upload / telemetry | Truncate at `--max-body-bytes`; record URL+method only beyond cap |
| Modal / z-index blocking clicks | Default `{ force: true }`; optional Escape between clicks |
| Duplicate REST endpoints | Merge by REST dedup key |
| Duplicate GraphQL ops | Merge only when same path + same `operationName` (or query hash) |
| Cross-origin APIs | Record in findings; don't crawl cross-origin HTML unless flag added later |
| Cross-origin maps | Require `--allow-external-maps`; auth via `--map-header`, never leak `-H` |
| OAuth token in localStorage | Use `--state`; document that `-c`/`-H` alone are insufficient |
| SPA button routing | Click broadened selectors; observe History API |
| Huge corpora | Enforce `--max-js` + worker pool + byte cap + disk cache |
| Embedded base64 maps | Decode per sourcemapper / Source Map spec linking rules |
| Path traversal in map `sources` | Sanitize when writing reconstructed / `--save-sources` |
| WebSockets | Capture URL; export as raw + OpenAPI extension; Postman item with description note |
| Empty findings | Write valid empty collection; exit 0 |
| Scratch dir leftovers | Always attempt cleanup; `--keep-tmpdir` for debug |

---

## 15. Security & Ethics Constraints

- Tool is for **authorized** testing only; README must state this clearly.
- Default same-origin restriction for source map fetches (`--allow-external-maps` to override).
- **Never** send `-H` or hydrated `storageState` Bearer tokens to third-party map hosts; use `--map-header` / `--map-origin`.
- Do not execute reconstructed source as code — parse only.
- Avoid writing secrets discovered in JS into exports beyond what is needed for route params; raw format may include more detail under `--verbose` evidence only.
- `--state` files contain session secrets — warn operators not to commit them; gitignore recommendation in README.
- Scratch/`tmpdir` may contain reconstructed proprietary source — clean up by default; warn if `--keep-tmpdir`.
- Proxy support enables routing through Burp for operator visibility.

---

## 16. Testing Strategy

### 16.1 Unit Tests

- `url-utils`: relative resolve, template conversion, path parameterization, **multi-pageUrl permutations**
- `ast-extractor`: fixtures for fetch, axios, XHR, template literals, Angular `$http`
- `regex-fallback`: minified one-liners; invoked on simulated `RangeError`
- `reconstruct`: fixture `.map` with `sourcesContent`, inline `data:` map in JS
- `dedupe`: network+ast merge, UUID collapse, **GraphQL operationName separation**, **AST pathTemplate precedence over `{id}`**
- `graphql-utils`: body detection, operationName extraction, anonymous query hash
- `header-policy` / `authed-fetch`: same-origin gets hydrated Bearer from fixture `storageState`; external map host never does; deny without allow
- `asset-cache`: writes file, metadata has no body string; truncate helpers honor `--max-body-bytes`
- Crawl exclude: logout button matching default `--exclude-selector` is not clicked
- Worker timeout: simulated hung worker is terminated and replaced within `--ast-timeout`
- Map concurrency: never more than N speculative fetches in flight
- Relative resolve: 50 pageUrls collapsing to 1 absolute URL → 1 finding (not capped to loss)

### 16.2 Integration Tests

- Local static fixture server (small Vite/Webpack-like fake SPA) with:
  - Lazy chunk triggered by **button** click (no `href`) + `history.pushState`
  - Modal/backdrop after first click (assert remaining clicks still fire with `force: true`)
  - Same relative `fetch('./data')` chunk loaded from two routes → two resolved endpoints
  - Token read from `localStorage` (prove `--state` works)
  - Exposed `.map` on a second origin mock (prove header non-leakage)
  - `fetch('/api/v1/items')` plus two `POST /graphql` ops with different `operationName`
  - Oversized XHR body (>256KiB) asserting truncation / no OOM
- Run CLI and assert: both GraphQL ops present; REST route present; map fetch headers correct; scratch dir cleaned.

### 16.3 Manual Acceptance (from PRD)

1. `-u` required validation works.
2. Cookie/header **and** `--state` authenticated pages load post-login chunks.
3. Depth 2 discovers more JS than depth 0 on a button-routed SPA.
4. Export imports cleanly into Postman and Burp (OpenAPI).
5. CLI remains responsive (progress logs) while analyzing large fixtures via workers.
6. RSS stays well below “all bodies in RAM” for a 100+ chunk fixture.

---

## 17. Implementation Phases

| Phase | Deliverable |
|---|---|
| **P0** | SPEC.md (this document), package scaffold, CLI stub with `--help` |
| **P1** | Playwright load + network intercept + **disk-backed** JS capture + raw dump of network endpoints (payload caps) |
| **P2** | SPA crawl (broad selectors + History + **force clicks** + **exclude-selector**) + `-c`/`-H` + `--state` |
| **P3** | Source maps + **authed fetcher** (§7.1.1) + header policy + **`--map-concurrency`** + `--save-sources` |
| **P4** | Babel AST worker pool (file-path jobs, `RangeError`→regex, **`--ast-timeout`**) + URL normalization |
| **P5** | Merge/dedupe + GraphQL keys + AST path precedence + **resolve-all→dedupe→cap** permutations |
| **P6** | Postman + OpenAPI + raw exporters (GraphQL naming) |
| **P7** | Stealth basics, proxy, tmpdir cleanup, tests, README usage |

---

## 18. Success Criteria

ChunkSpelunker v1 is complete when:

1. `npx chunkspelunker --help` documents all PRD flags plus `--state`, `--map-header`, `--ast-workers`, `--ast-timeout`, `--map-concurrency`, `--exclude-selector`, `--max-body-bytes`, `--force-clicks`.
2. Against a fixture SPA with an exposed source map, the tool recovers original sources and extracts at least the known `/api/...` routes from AST.
3. Live `fetch`/`XHR` calls during crawl appear in the export even if absent from static analysis.
4. Template literal routes appear as Postman-ready `{{var}}` paths.
5. `-f postman` and `-f openapi` produce schema-valid outputs importable by Postman and Burp.
6. Missing source maps do not prevent minified AST/regex analysis.
7. Button/`pushState` routes trigger lazy chunks without requiring `<a href>`.
8. Two GraphQL operations to `POST /graphql` export as two distinct collection items.
9. `-H` app tokens are not attached to cross-origin map requests; `--map-header` is.
10. AST phase does not block stderr progress logging (workers).
11. JS bodies are not retained as in-memory Map values; scratch dir is used and cleaned.
12. Modal backdrop after an early click does not prevent later forced clicks from firing.
13. Merged AST+network routes prefer `{{userId}}` (AST) over `{id}` (network).
14. Worker catching `RangeError` still returns regex findings for that file.
15. Relative `./data` in a multi-page chunk emits one endpoint per **unique** resolved URL.
16. `--state` alone is sufficient for same-origin authenticated `.map` fetches (hydration / `APIRequestContext`); no mandatory duplicate `-H`.
17. Default exclude list prevents clicking a labeled Log out control in the fixture.
18. A hung AST worker is terminated within `--ast-timeout` and the pool recovers.
19. Speculative map probes never exceed `--map-concurrency` in flight.

---

## 19. Open Questions (Resolved for v1)

| Question | Decision |
|---|---|
| Commander vs Yargs | **Commander** (lighter, excellent repeatable options) |
| ESM vs CJS | **ESM** (`"type": "module"`) |
| OpenAPI YAML vs JSON | JSON by default; YAML if `-o` ends with `.yml`/`.yaml` |
| Crawl SPA router links without `<a href>` | **v1.1:** broadened `--click-selector` + History API observation; listener introspection deferred |
| Auth via localStorage JWT | **`--state`** for browser; **§7.1.1** hydrates Bearer + `APIRequestContext` for same-origin maps |
| AST on main thread | **No** — `worker_threads` pool; byte cap → regex-only |
| GraphQL dedupe | Include `operationName` (or query hash) in key; no schema introspection |
| Map auth vs app auth | Separate `--map-header` / `--map-origin`; never leak hydrated Bearer cross-origin |
| JS bodies in RAM | **v1.2:** disk-backed asset cache; workers read `filePath`; `--max-body-bytes` for XHR |
| Modal blocks click loop | **v1.2:** default `{ force: true }`; optional Escape; no full modal solver |
| Path template on merge | **v1.2:** AST semantic names beat network `{id}` guesses |
| Babel stack overflow | **v1.2:** catch `RangeError` → regex fallback |
| Relative path context | **v1.2/1.3:** `jsUrl → Set<pageUrls>`; resolve all → dedupe uniques → then cap |
| Destructive crawl clicks | **v1.3:** default `--exclude-selector` (logout/delete); soft session-death heuristic |
| AST worker hang | **v1.3:** `--ast-timeout`; terminate + replace worker |
| Map fetch stampede | **v1.3:** `--map-concurrency` + 429 backoff |
| Secrets scanning | Out of scope for v1 export focus |

---

## 20. References

1. [denandz/sourcemapper](https://github.com/denandz/sourcemapper) — Source Map v3 extraction, `data:` maps, header-authenticated fetches  
2. [rarecoil/unwebpack-sourcemap](https://github.com/rarecoil/unwebpack-sourcemap) — Webpack source tree recovery, `sourceMappingURL` detection  
3. [BishopFox/jsluice](https://github.com/BishopFox/jsluice) — AST-first URL/method extraction, concatenation placeholders  
4. [cc1a2b/JShunter](https://github.com/cc1a2b/JShunter) — Regex fallback, CLI auth ergonomics, minified analysis  
5. [alufers/mitmproxy2swagger](https://github.com/alufers/mitmproxy2swagger) — Path templating / `{id}` parameterization  
6. [Unbrowse](https://www.unbrowse.ai/) — Passive XHR/fetch capture conceptual model  
7. [Dana Epp — JS Miner](https://danaepp.com/detecting-api-endpoints-and-source-code-with-js-miner) — Lazy chunks, map optional, always parse minified JS  
8. [TC39 Source Map specification](https://tc39.es/source-map-spec/) — Linking generated code via `sourceMappingURL`  
9. [Postman Collection Format v2.1](https://schema.getpostman.com/json/collection/v2.1.0/docs/index.html)  
10. [OpenAPI Specification 3.0](https://swagger.io/specification/)  
11. [Playwright storageState](https://playwright.dev/docs/auth) — cookies + localStorage session reuse  
12. [Playwright force click](https://playwright.dev/docs/input#forcing-the-click) — bypass actionability for crawl resilience  

---

## 21. Design Revisions (v1.0 → v1.1)

Responses to first implementation-friction review:

| # | Friction | Spec change |
|---|---|---|
| 1 | `<a href>`-only crawl misses SPA chunks | §5.2 / §7.4–7.5: default click selector includes buttons & ARIA roles; History `pushState`/`replaceState`/`hashchange` observed as navigations |
| 2 | Sync Babel blocks event loop on large bundles | §9.0: `worker_threads` pool; findings-only IPC; `--max-js-bytes` forces regex-only; `--ast-workers` |
| 3 | Cookie/header auth insufficient for localStorage JWT SPAs | §5.2 / §7.1: `--state <storageState.json>` |
| 4 | All GraphQL collapses to one `POST /graphql` | §7.6 / §10.1–10.2 / §11: `operationName` (or query hash) in dedupe key + distinct Postman names |
| 5 | `-H` leaked to third-party map hosts | §3.1 / §8.4 / §5.2: `--map-header`, `--map-origin`; `-H` same-origin-only for Node fetches |

---

## 22. Design Revisions (v1.1 → v1.2)

Responses to operational-reality review (pre-implementation):

| # | Friction | Spec change |
|---|---|---|
| 1 | Holding 500× multi-MB JS strings (+ unbounded XHR bodies) → OOM | §7.6–7.7 / §12.1: disk-backed `JsAssetMeta.diskPath`; `--max-body-bytes` (256 KiB); workers receive file paths; tmpdir cleanup |
| 2 | Modal backdrop fails Playwright actionability on later clicks | §7.4: default `click({ force: true })`; `--force-clicks`; cheap Escape between clicks |
| 3 | Ambiguous path template on AST↔network merge | §10.2.1 / §10.3: **AST semantic `pathTemplate` wins**; network wins `method`; union params |
| 4 | Babel `RangeError: Maximum call stack size exceeded` despite `errorRecovery` | §9.0 / §9.5: catch `RangeError` + `SyntaxError` → regex fallback with `degradedReason` |
| 5 | Relative URLs lack page context under code splitting | §7.7 / §9.4: `jsUrl → Set<pageUrls>`; Merger emits permutations per observed page |

---

## 23. Design Revisions (v1.2 → v1.3)

Responses to wild-pipeline blind-spot review:

| # | Friction | Spec change |
|---|---|---|
| 1 | `--state` auths browser but Node map GETs 401 (localStorage JWT desync) | §7.1.1 / §8.4: Playwright `APIRequestContext` for same-origin re-fetches; hydrate `Authorization` from `storageState` localStorage keys; never send hydrated Bearer to `--map-origin` |
| 2 | Blind clicks hit Log out / Delete and kill the session | §5.2 / §7.4: `--exclude-selector` with logout/delete defaults; soft session-death heuristic |
| 3 | Obfuscated chunks hang Babel/regex without throwing | §9.0: `--ast-timeout`; `worker.terminate()` + pool replace; `degradedReason: 'timeout'` |
| 4 | Hundreds of speculative `.map` GETs → WAF 429 / DoS | §8.1.1: `--map-concurrency` (default 4); 429 backoff |
| 5 | Cap-before-dedupe drops correct relative resolutions | §9.4: resolve against all `pageUrls` → unique absolute URLs → cap uniques only |

---

## 24. Design Revisions (v1.3 → v1.3.1)

Final pre-code edge cases:

| # | Friction | Spec change |
|---|---|---|
| 1 | SSE (`text/event-stream`) never closes → `response.body()` / `networkidle` deadlock | §7.3 / §7.6 / §7.7: detect event-stream; record URL only; never buffer body; avoid idle waits dominated by open streams |
| 2 | Regex on 5 MiB one-liners → ReDoS hang despite AST timeout | §9.5: chunk oversized input; linear patterns only; per-chunk match caps |
| 3 | Hydration always emits `Authorization: Bearer` | §5.2 / §7.1.1: `--hydrate-format` template (default Bearer; supports `x-api-key`, `Token`, CSRF, etc.) |