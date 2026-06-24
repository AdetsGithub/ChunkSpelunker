# ChunkSpelunker — Technical Specification

**Version:** 1.1.0  
**Status:** Draft for implementation  
**Runtime:** Node.js ≥ 20  
**License:** MIT (intended)

> **v1.1 revisions** address SPA click blindness, AST event-loop blocking, `localStorage` auth, GraphQL dedupe collapse, and source-map header leakage. See §21.

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
│  -u/-c/-H/--state  -d  -o/-f  --map-header  --ast-workers       │
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
│(Playwright│ │ Engine   │ │ Pool     │ │ Dedupe (+ GraphQL op) →  │
│+ History)│ │(scoped   │ │(Babel +  │ │ Parameterize → Export    │
│          │ │ headers) │ │ regex)   │ │                          │
└──────────┘ └──────────┘ └──────────┘ └──────────────────────────┘
```

### 4.1 Module Responsibilities

| Module | Path (proposed) | Responsibility |
|---|---|---|
| CLI | `src/cli.js` | Parse args, validate, invoke pipeline, exit codes |
| Orchestrator | `src/pipeline.js` | Ordered stages, shared context, progress logging |
| Browser / Crawler | `src/browser/crawler.js` | Playwright launch, auth/`storageState`, intercept, SPA crawl |
| History Observer | `src/browser/history-observer.js` | Hook `pushState`/`replaceState`/`hashchange` as navigations |
| Network Store | `src/browser/network-store.js` | Record requests/responses/WS frames, JS asset URLs |
| Source Map Engine | `src/sourcemap/discover.js`, `reconstruct.js` | Find maps, parse v3, reconstruct sources; scoped headers |
| Header Policy | `src/http/header-policy.js` | Decide which headers attach to which fetch origin |
| AST Analyzer | `src/analyze/ast-extractor.js` | Babel parse + traverse for HTTP client patterns (worker-safe) |
| AST Worker Pool | `src/analyze/ast-pool.js`, `ast-worker.js` | `worker_threads` pool; code in → findings JSON out |
| Regex Fallback | `src/analyze/regex-fallback.js` | Endpoint/path regex when AST fails |
| GraphQL Utils | `src/analyze/graphql-utils.js` | Detect GraphQL bodies; extract `operationName` |
| URL Normalizer | `src/analyze/url-utils.js` | Resolve relative URLs, template → `{{var}}`, path params |
| Merger | `src/merge/dedupe.js` | Merge static + dynamic, parameterize, GraphQL-aware dedupe |
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
| `--ast-workers <n>` | integer | `min(4, cpus-1)` | Size of the Babel worker pool |
| `--click-selector <css>` | string | see below | CSS selector for crawl click targets |
| `--save-sources <dir>` | string | — | If set, write reconstructed source tree to disk |
| `--verbose` | boolean | `false` | Debug logging to stderr |
| `--quiet` | boolean | `false` | Suppress non-error stderr |

**Default `--click-selector`:**

```text
a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"]
```

Operators may narrow (e.g. `nav a[href]`) or widen (e.g. add `[data-testid]`, `.MuiButton-root`) as needed.

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
   ├─ If --state: load Playwright storageState (cookies + origins' local/session storage)
   ├─ Else/also: parse -c cookies; note -H for browser context + same-origin Node fetches
   └─ Launch Chromium context (storageState | cookies, extraHTTPHeaders, UA, proxy)

2. INTERCEPT + LOAD
   ├─ Install History API hooks (pushState / replaceState / hashchange / popstate)
   ├─ page.on('request')  → record method, URL, headers, postData; classify asset type
   ├─ page.on('response') → for *.js / javascript MIME: store body URL + optional body buffer
   ├─ page.on('websocket') → record WS open URLs / frames (metadata)
   └─ page.goto(url, { waitUntil, timeout })

3. CRAWL (depth ≥ 1)
   ├─ Collect clickables via --click-selector (anchors, buttons, ARIA roles, …)
   ├─ For each candidate: click → wait for network idle OR history URL change
   ├─ Treat History API / hash changes as first-class navigations (enqueue new path)
   ├─ Also harvest same-origin a[href] for direct goto fallback
   ├─ BFS/queue up to --depth; skip mailto:, javascript:, external (if same-origin-only)
   └─ Continue intercepting JS + API traffic (lazy chunks)

4. SOURCE MAP DISCOVERY
   For each unique JS URL (capped by --max-js):
   ├─ Read body (from response buffer or re-fetch with header policy)
   ├─ Parse trailing sourceMappingURL comment
   ├─ If data: → decode base64/URI JSON
   ├─ Else if relative/absolute URL → fetch map with §8.4 header policy
   ├─ Else try `{jsUrl}.map` probe (if not already tried)
   └─ On 200 + valid JSON map → reconstruct sources via source-map / sourcesContent

5. AST EXTRACTION (worker pool — never on main thread for large files)
   ├─ Build work queue: minified bodies + reconstructed app sources
   ├─ Dispatch to --ast-workers pool (worker_threads)
   │    each job: { id, code, url } → parse → traverse → findings JSON → GC AST
   ├─ Files > --max-js-bytes: skip Babel; regex-fallback only
   ├─ On parse failure inside worker → regex-fallback for that file
   └─ Main thread merges finding batches; normalizes paths / {{vars}}

6. MERGE
   ├─ Union dynamic network endpoints + static AST endpoints
   ├─ Parse GraphQL bodies → attach operationName when present
   ├─ Filter static assets / telemetry noise heuristics
   ├─ Parameterize path segments (UUID, numeric, long hex)
   ├─ Deduplicate with GraphQL-aware key (§10.2)
   └─ Attach provenance: source = network | ast | both; jsAsset; confidence

7. EXPORT
   ├─ postman → Collection v2.1 JSON (GraphQL ops named distinctly)
   ├─ openapi → OpenAPI 3.0 JSON (or YAML if output ends in .yaml/.yml)
   └─ raw → Internal findings schema JSON
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
- Document in README: for SPAs that inject `Authorization` from `localStorage`, `--state` is required; `-H` alone often still hits `/login` because the app's own interceptor never sees the token.

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
| `websocket` | WS endpoint |
| Static extensions (css, png, woff2, …) | Ignore for endpoint merge |

### 7.4 Crawl Strategy (SPA-aware)

Modern SPAs rarely expose every route as `<a href>`. v1 crawl is **interaction + history** based:

1. **Seed:** target URL at depth 0; install History hooks before first navigation (§7.5).
2. **Discover clickables** after each settle using `--click-selector` (default includes `a[href]`, `button`, `[role="button"]`, `[role="link"]`, `[role="tab"]`, `[role="menuitem"]`).
3. **Click loop:** for each unique, visible, enabled element (cap per page, e.g. 40):
   - Record `location.href` before click
   - `element.click({ timeout })` with short try/catch (ignore overlays that throw)
   - Wait for either: network quiet window **or** History URL change **or** small timeout
   - If URL changed (path/query/hash) → count as navigation; enqueue at depth+1; harvest new clickables
4. **Href harvest:** additionally collect same-origin `a[href]` for `page.goto` fallback when click did not change location but href is novel.
5. **Dedup visits** by normalized URL (include hash for hash-routers; strip only empty `#`).
6. **Skip:** `mailto:`, `tel:`, `javascript:`, `blob:`, download attributes, external origins when `--same-origin-only`.
7. **Caps:** `min(discovered, depth_budget, hard_cap=100 navigations, hard_cap=250 clicks)`.

**Deferred (not v1):** walking `getEventListeners`-style maps or CDP DOMDebugger listener introspection. History observation + broadened selectors cover the majority of React/Vue/Angular router apps without brittle listener scraping.

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

### 7.6 Request Body Capture

- Capture `postData` for XHR/Fetch when available.
- Attempt to parse JSON bodies to extract key names for parameter inference.
- **GraphQL detection:** if path matches `/graphql` / `/gql` (case-insensitive suffix) **or** JSON body has `query` / `operationName` / `variables`:
  - Extract `operationName` when present
  - If only a raw `query` string, best-effort parse the first operation name via lightweight regex (`(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)`)
  - Store on the network call for dedupe (§10.2) and export naming
- Do not log or export Authorization header values into collection auth unless user-supplied via `-H`/`-c`/`--state` metadata (echo only what user provided as collection variables).

---

## 8. Source Map Engine

### 8.1 Discovery Order (per JS file)

1. Inline `//# sourceMappingURL=data:application/json;...` or `//@ sourceMappingURL=...`
2. External URL from `sourceMappingURL` (resolve relative to JS URL)
3. Speculative `{jsUrl}.map` GET
4. Optional: HTML `<script>` scan already covered via network intercept of those scripts

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

Node-side `fetch` (maps, missing JS bodies) **must not** blindly attach browser `-H` headers to arbitrary hosts.

| Destination | Headers sent |
|---|---|
| Same origin as `-u` | Cookie jar from context/`-c` **and** `-H` app headers |
| Origin listed in `--map-origin` | `--map-header` only (plus cookies if cookie domain matches — usually none) |
| Other origin + `--allow-external-maps` | **No** `-H`; only `--map-header` if that origin is also in `--map-origin`, else unauthenticated GET |
| Other origin without `--allow-external-maps` | **Do not fetch** (log skip) |

Rationale: app `Authorization: Bearer <user-jwt>` must never be sent to `sentry.io` or a corporate asset CDN. Map hosts get explicit `--map-header` credentials instead.

Playwright browser traffic is unaffected: the page's own JS decides which headers go to which API; context `extraHTTPHeaders` apply as Playwright documents.

---

## 9. AST Pattern Matching

### 9.0 Worker Pool (event-loop safety)

Babel parse + traverse of multi-megabyte minified vendor chunks **must not** run on the main thread.

**Design:**

- Module `src/analyze/ast-pool.js` owns a fixed pool of `worker_threads` (`--ast-workers`, default `min(4, cpus-1)`, minimum 1).
- Worker entry `src/analyze/ast-worker.js` imports extractor + regex fallback only (no Playwright).
- Job protocol (structured clone / JSON):

```ts
// main → worker
{ jobId: string, url: string, code: string, mode: 'ast' | 'regex-only' }

// worker → main
{ jobId: string, ok: true, findings: EndpointFinding[], engine: 'ast' | 'regex' }
// or
{ jobId: string, ok: false, error: string, findings: EndpointFinding[] } // findings may still hold regex fallback
```

**Lifecycle per job:**

1. Receive code string
2. If `mode === 'regex-only'` OR `code.length > maxJsBytes` → regex only
3. Else `babel.parse` → traverse → collect findings
4. Drop all references to AST; return serializable findings only
5. Main thread never retains ASTs — only findings arrays

**Backpressure:** queue jobs; at most `ast-workers` in flight; stream progress (`[.] analyzed 42/180`).

**Failure isolation:** a worker OOM/crash is restarted; that job falls back to regex on main or a fresh worker.

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

Use `errorRecovery: true` to salvage partial trees from broken/minified input when possible.

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

### 9.4 Relative Path Resolution

| Found | Resolution |
|---|---|
| `/users/me` | `{origin}/users/me` |
| `./users` | resolve against current page URL or JS asset URL (prefer page URL for network; asset URL for static when known) |
| `https://api.other.com/v1/x` | keep absolute |
| `//cdn.example.com/...` | apply page protocol |

Store both `rawPath` and `resolvedUrl` on each finding.

### 9.5 Regex Fallback (JShunter-inspired)

Applied when Babel throws or yields zero high-confidence hits for a file:

- Path-like strings: `/[a-zA-Z0-9_\-./{}]+`
- Absolute URLs
- Common API prefixes
- Deduplicate and run through same normalizer / confidence tagging (`source: regex`)

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

When merging network + ast: prefer network for method certainty; union param names; set `source: both`; bump confidence; prefer non-empty `graphql.operationName`.

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
  jsAssets: Map<string, { url: string; body?: string; contentType?: string }>;
  networkCalls: NetworkCall[];
  websockets: string[];
  reconstructed: Map<string, string>; // path -> source
  findings: EndpointFinding[];
}
```

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
│   │   └── stealth.js
│   ├── http/
│   │   └── header-policy.js
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
| Relative API paths | Resolve against target origin |
| Template URLs | `{{var}}` in Postman; `{var}` in OpenAPI |
| No source maps | Analyze minified JS only; continue |
| Invalid map JSON | Log skip; continue |
| Babel parse fail | Regex fallback (in worker) |
| Large JS (> `--max-js-bytes`) | Skip Babel; regex-only in worker |
| Main-thread freeze risk | AST only in `worker_threads` pool |
| Duplicate REST endpoints | Merge by REST dedup key |
| Duplicate GraphQL ops | Merge only when same path + same `operationName` (or query hash) |
| Cross-origin APIs | Record in findings; don't crawl cross-origin HTML unless flag added later |
| Cross-origin maps | Require `--allow-external-maps`; auth via `--map-header`, never leak `-H` |
| OAuth token in localStorage | Use `--state`; document that `-c`/`-H` alone are insufficient |
| SPA button routing | Click broadened selectors; observe History API |
| Huge corpora | Enforce `--max-js` + worker pool + byte cap |
| Embedded base64 maps | Decode per sourcemapper / Source Map spec linking rules |
| Path traversal in map `sources` | Sanitize when writing `--save-sources` |
| WebSockets | Capture URL; export as raw + OpenAPI extension; Postman item with description note |
| Empty findings | Write valid empty collection; exit 0 |

---

## 15. Security & Ethics Constraints

- Tool is for **authorized** testing only; README must state this clearly.
- Default same-origin restriction for source map fetches (`--allow-external-maps` to override).
- **Never** send `-H` application headers to third-party map hosts; use `--map-header` / `--map-origin`.
- Do not execute reconstructed source as code — parse only.
- Avoid writing secrets discovered in JS into exports beyond what is needed for route params; raw format may include more detail under `--verbose` evidence only.
- `--state` files contain session secrets — warn operators not to commit them; gitignore recommendation in README.
- Proxy support enables routing through Burp for operator visibility.

---

## 16. Testing Strategy

### 16.1 Unit Tests

- `url-utils`: relative resolve, template conversion, path parameterization
- `ast-extractor`: fixtures for fetch, axios, XHR, template literals, Angular `$http`
- `regex-fallback`: minified one-liners
- `reconstruct`: fixture `.map` with `sourcesContent`, inline `data:` map in JS
- `dedupe`: network+ast merge, UUID collapse, **GraphQL operationName separation**
- `graphql-utils`: body detection, operationName extraction, anonymous query hash
- `header-policy`: same-origin gets `-H`; external map host gets only `--map-header`; deny without allow

### 16.2 Integration Tests

- Local static fixture server (small Vite/Webpack-like fake SPA) with:
  - Lazy chunk triggered by **button** click (no `href`) + `history.pushState`
  - Token read from `localStorage` (prove `--state` works)
  - Exposed `.map` on a second origin mock (prove header non-leakage)
  - `fetch('/api/v1/items')` plus two `POST /graphql` ops with different `operationName`
- Run CLI and assert: both GraphQL ops present; REST route present; map fetch headers correct.

### 16.3 Manual Acceptance (from PRD)

1. `-u` required validation works.
2. Cookie/header **and** `--state` authenticated pages load post-login chunks.
3. Depth 2 discovers more JS than depth 0 on a button-routed SPA.
4. Export imports cleanly into Postman and Burp (OpenAPI).
5. CLI remains responsive (progress logs) while analyzing large fixtures via workers.

---

## 17. Implementation Phases

| Phase | Deliverable |
|---|---|
| **P0** | SPEC.md (this document), package scaffold, CLI stub with `--help` |
| **P1** | Playwright load + network intercept + JS capture + raw dump of network endpoints |
| **P2** | SPA crawl (broad selectors + History observer) + `-c`/`-H` + `--state` |
| **P3** | Source map discovery + reconstruction + header policy + `--map-header` / `--save-sources` |
| **P4** | Babel AST extractors in **worker pool** + regex fallback + URL normalization |
| **P5** | Merge/dedupe/parameterize + GraphQL `operationName` keys |
| **P6** | Postman + OpenAPI + raw exporters (GraphQL naming) |
| **P7** | Stealth basics, proxy, tests, README usage |

---

## 18. Success Criteria

ChunkSpelunker v1 is complete when:

1. `npx chunkspelunker --help` documents all PRD flags plus `--state`, `--map-header`, `--ast-workers`.
2. Against a fixture SPA with an exposed source map, the tool recovers original sources and extracts at least the known `/api/...` routes from AST.
3. Live `fetch`/`XHR` calls during crawl appear in the export even if absent from static analysis.
4. Template literal routes appear as Postman-ready `{{var}}` paths.
5. `-f postman` and `-f openapi` produce schema-valid outputs importable by Postman and Burp.
6. Missing source maps do not prevent minified AST/regex analysis.
7. Button/`pushState` routes trigger lazy chunks without requiring `<a href>`.
8. Two GraphQL operations to `POST /graphql` export as two distinct collection items.
9. `-H` app tokens are not attached to cross-origin map requests; `--map-header` is.
10. AST phase does not block stderr progress logging (workers).

---

## 19. Open Questions (Resolved for v1)

| Question | Decision |
|---|---|
| Commander vs Yargs | **Commander** (lighter, excellent repeatable options) |
| ESM vs CJS | **ESM** (`"type": "module"`) |
| OpenAPI YAML vs JSON | JSON by default; YAML if `-o` ends with `.yml`/`.yaml` |
| Crawl SPA router links without `<a href>` | **v1.1:** broadened `--click-selector` + History API observation; listener introspection deferred |
| Auth via localStorage JWT | **`--state`** Playwright storageState; `-c`/`-H` remain for simpler apps |
| AST on main thread | **No** — `worker_threads` pool; byte cap → regex-only |
| GraphQL dedupe | Include `operationName` (or query hash) in key; no schema introspection |
| Map auth vs app auth | Separate `--map-header` / `--map-origin`; never leak `-H` cross-origin |
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

---

## 21. Design Revisions (v1.0 → v1.1)

Responses to implementation-friction review:

| # | Friction | Spec change |
|---|---|---|
| 1 | `<a href>`-only crawl misses SPA chunks | §5.2 / §7.4–7.5: default click selector includes buttons & ARIA roles; History `pushState`/`replaceState`/`hashchange` observed as navigations |
| 2 | Sync Babel blocks event loop on large bundles | §9.0: `worker_threads` pool; findings-only IPC; `--max-js-bytes` forces regex-only; `--ast-workers` |
| 3 | Cookie/header auth insufficient for localStorage JWT SPAs | §5.2 / §7.1: `--state <storageState.json>` |
| 4 | All GraphQL collapses to one `POST /graphql` | §7.6 / §10.1–10.2 / §11: `operationName` (or query hash) in dedupe key + distinct Postman names |
| 5 | `-H` leaked to third-party map hosts | §3.1 / §8.4 / §5.2: `--map-header`, `--map-origin`; `-H` same-origin-only for Node fetches |
