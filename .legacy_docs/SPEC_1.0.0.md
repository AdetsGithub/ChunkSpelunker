# ChunkSpelunker — Technical Specification

**Version:** 1.0.0  
**Status:** Draft for implementation  
**Runtime:** Node.js ≥ 20  
**License:** MIT (intended)

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
7. Support authenticated sessions via cookies and custom headers.
8. Operate entirely via POSIX-style CLI flags.

### 2.2 Non-Goals (v1)

- Active exploitation, fuzzing, or authenticated attack chains.
- Solving interactive CAPTCHAs / Turnstile challenges (only basic UA / fingerprint spoofing).
- Full deobfuscation of heavily packed JS (beyond source maps + graceful AST/regex fallback).
- GraphQL schema introspection as a first-class feature (GraphQL URLs may still be captured).
- Secrets/credential hunting as a primary product surface (may appear incidentally in raw export).
- Interactive TUI or web UI.

---

## 3. Lessons From Reference Tools

These inform architecture; ChunkSpelunker does not vend or depend on them at runtime.

### 3.1 denandz/sourcemapper

- Parse Source Map **v3**; recreate source trees from `sources` / `sourcesContent`.
- Resolve map references from:
  - Direct `.map` URL
  - `//# sourceMappingURL=` on a JS file (absolute, relative, or `data:application/json;base64,...`)
- Support auth headers when fetching maps (maps are often behind the same session).
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
│  -u url  -c cookie  -H header  -d depth  -o out  -f format      │
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
│ Crawler  │ │ Map      │ │ Analyzer │ │                          │
│(Playwright│ │ Engine   │ │ (Babel + │ │ Dedupe → Parameterize →  │
│ intercept)│ │(source-map│ │ regex)  │ │ Postman / OpenAPI / raw  │
└──────────┘ └──────────┘ └──────────┘ └──────────────────────────┘
```

### 4.1 Module Responsibilities

| Module | Path (proposed) | Responsibility |
|---|---|---|
| CLI | `src/cli.js` | Parse args, validate, invoke pipeline, exit codes |
| Orchestrator | `src/pipeline.js` | Ordered stages, shared context, progress logging |
| Browser / Crawler | `src/browser/crawler.js` | Playwright launch, auth, intercept, link crawl |
| Network Store | `src/browser/network-store.js` | Record requests/responses/WS frames, JS asset URLs |
| Source Map Engine | `src/sourcemap/discover.js`, `reconstruct.js` | Find maps, parse v3, reconstruct sources |
| AST Analyzer | `src/analyze/ast-extractor.js` | Babel parse + traverse for HTTP client patterns |
| Regex Fallback | `src/analyze/regex-fallback.js` | Endpoint/path regex when AST fails |
| URL Normalizer | `src/analyze/url-utils.js` | Resolve relative URLs, template → `{{var}}`, path params |
| Merger | `src/merge/dedupe.js` | Merge static + dynamic, parameterize, filter noise |
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
| `-H, --header <string>` | string (repeatable) | — | Custom header `Name: Value` |
| `-d, --depth <int>` | integer | `1` | Max depth for clicking internal same-origin links |
| `-o, --output <file>` | string | `chunkspelunker-output.json` | Output path |
| `-f, --format <type>` | enum | `postman` | `postman` \| `openapi` \| `raw` |

### 5.2 Extended Flags (v1 recommended)

| Flag | Type | Default | Description |
|---|---|---|---|
| `--timeout <ms>` | integer | `30000` | Navigation / network idle timeout |
| `--wait-until <event>` | enum | `networkidle` | Playwright waitUntil: `load` \| `domcontentloaded` \| `networkidle` \| `commit` |
| `--headless` | boolean | `true` | Run headless; `--no-headless` for debug |
| `--user-agent <ua>` | string | realistic Chrome UA | Override User-Agent |
| `--proxy <url>` | string | — | HTTP(S) proxy (e.g. Burp `http://127.0.0.1:8080`) |
| `--insecure` | boolean | `false` | Ignore TLS errors |
| `--same-origin-only` | boolean | `true` | Only crawl same-origin links; still record cross-origin API calls |
| `--allow-external-maps` | boolean | `false` | Permit fetching source maps from other origins |
| `--include-vendor` | boolean | `false` | Analyze reconstructed `node_modules` / vendor sources |
| `--max-js <n>` | integer | `500` | Cap number of JS assets analyzed |
| `--click-selector <css>` | string | `a[href]` | Selector used during crawl |
| `--save-sources <dir>` | string | — | If set, write reconstructed source tree to disk |
| `--verbose` | boolean | `false` | Debug logging to stderr |
| `--quiet` | boolean | `false` | Suppress non-error stderr |

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

# Authenticated deep crawl → OpenAPI
npx chunkspelunker -u https://app.example.com/dashboard \
  -c "session=abc; csrf=xyz" \
  -H "Authorization: Bearer eyJ..." \
  -d 3 \
  -f openapi \
  -o api.yaml

# Through Burp + save reconstructed sources
npx chunkspelunker -u https://app.example.com \
  --proxy http://127.0.0.1:8080 \
  --save-sources ./recovered-src \
  -f raw -o findings.json
```

---

## 6. Execution Flow (Detailed)

```
1. INIT
   ├─ Parse & validate CLI
   ├─ Normalize base URL (origin + pathname)
   ├─ Parse cookies into Playwright cookie objects (domain/path from URL)
   └─ Launch Chromium context with headers, UA, proxy, ignoreHTTPSErrors

2. INTERCEPT + LOAD
   ├─ page.on('request')  → record method, URL, headers, postData; classify asset type
   ├─ page.on('response') → for *.js / javascript MIME: store body URL + optional body buffer
   ├─ page.on('websocket') → record WS open URLs / frames (metadata)
   └─ page.goto(url, { waitUntil, timeout })

3. CRAWL (depth ≥ 1)
   ├─ Collect same-origin <a href> (and click-selector matches)
   ├─ BFS/queue up to --depth; skip mailto:, javascript:, #only, external (if same-origin-only)
   ├─ After each navigation, wait briefly for network idle / chunk loads
   └─ Continue intercepting JS + API traffic

4. SOURCE MAP DISCOVERY
   For each unique JS URL (capped by --max-js):
   ├─ Read body (from response buffer or re-fetch with session)
   ├─ Parse trailing sourceMappingURL comment
   ├─ If data: → decode base64/URI JSON
   ├─ Else if relative/absolute URL → fetch map (auth headers attached)
   ├─ Else try `{jsUrl}.map` probe (if not already tried)
   └─ On 200 + valid JSON map → reconstruct sources via source-map / sourcesContent

5. AST EXTRACTION
   For each JS body + each reconstructed original source (non-vendor unless included):
   ├─ Try @babel/parser (module + plugins for modern syntax)
   ├─ Traverse with visitors for HTTP client patterns (see §8)
   ├─ On parse failure → regex-fallback
   └─ Normalize paths against base URL; convert template vars → {{name}}

6. MERGE
   ├─ Union dynamic network endpoints + static AST endpoints
   ├─ Filter static assets / telemetry noise heuristics
   ├─ Parameterize path segments (UUID, numeric, long hex)
   ├─ Deduplicate by method + templated path + query param name set
   └─ Attach provenance: source = network | ast | both; jsAsset; confidence

7. EXPORT
   ├─ postman → Collection v2.1 JSON
   ├─ openapi → OpenAPI 3.0 JSON (or YAML if output ends in .yaml/.yml)
   └─ raw → Internal findings schema JSON
```

---

## 7. Browser Automation & Network Interception

### 7.1 Playwright Context

- Browser: Chromium (bundled with `playwright`).
- Extra HTTP headers from `-H` applied at context level.
- Cookies from `-c` parsed as `name=value` pairs (`;`-separated) and added via `context.addCookies` with domain/path derived from target URL (`path: '/'`, `secure` if https).
- Default viewport and locale set to common desktop values.

### 7.2 Stealth / Anti-Bot (Basic)

Inspired by common Playwright evasion needs (not a full undetected-chromedriver replacement):

- Realistic Chrome User-Agent (overridable).
- Init script to harden trivial checks:
  - `navigator.webdriver` → `undefined` / false
  - Reasonable `navigator.languages`, `plugins` length stubs
- Do **not** claim to bypass Cloudflare Turnstile or similar; document limitation. If blocked, exit with clear error and suggest `--no-headless` / proxy / manual cookie export.

### 7.3 Asset Classification

| Signal | Classification |
|---|---|
| URL ends with `.js` / `.mjs` / `.cjs` | JS asset |
| `content-type` contains `javascript` / `ecmascript` | JS asset |
| URL ends with `.map` | Source map (store; don't AST) |
| Request resource type `xhr` / `fetch` | API candidate |
| `websocket` | WS endpoint |
| Static extensions (css, png, woff2, …) | Ignore for endpoint merge |

### 7.4 Crawl Strategy

- Seed: target URL at depth 0.
- Discover links after each page settles.
- Normalize URLs (strip hash; optional strip tracking query keys later).
- Visit unique URLs only; depth = link distance from seed.
- Prefer `page.click` on in-DOM anchors when safe; fallback to `page.goto(href)` for reliability.
- Cap total navigations: `min(discovered, depth_budget, hard_cap=100)`.

### 7.5 Request Body Capture

- Capture `postData` for XHR/Fetch when available.
- Attempt to parse JSON bodies to extract key names for parameter inference.
- Do not log or export Authorization header values into collection auth unless user-supplied via `-H`/`-c` (echo only what user provided as collection variables).

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

---

## 9. AST Pattern Matching

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
}
```

### 10.2 Dedup Key

```text
normalize(method) + " " + normalize(pathTemplate) + " " + sortedQueryNames
```

When merging network + ast: prefer network for method certainty; union param names; set `source: both`; bump confidence.

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
- If user passed `-H` / `-c`, add collection-level header/cookie (values as variables where sensible).

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
| Runtime | Node.js ≥ 20 | Native ESM/CJS, fetch, matches PRD |
| CLI | `commander` | POSIX flags, `--help`, repeatable `-H` |
| Browser | `playwright` | Network interception, modern SPA support |
| AST | `@babel/parser`, `@babel/traverse`, `@babel/types` | JS/TS/JSX tolerant parsing |
| Source maps | `source-map` | Spec-compliant consumer |
| HTTP (map re-fetch) | native `fetch` or `undici` | Session header forwarding |
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
│   │   ├── network-store.js
│   │   └── stealth.js
│   ├── sourcemap/
│   │   ├── discover.js
│   │   └── reconstruct.js
│   ├── analyze/
│   │   ├── ast-extractor.js
│   │   ├── regex-fallback.js
│   │   └── url-utils.js
│   ├── merge/
│   │   └── dedupe.js
│   └── export/
│       ├── postman.js
│       ├── openapi.js
│       └── raw.js
├── test/
│   ├── fixtures/                  # mini SPA / sample maps / JS snippets
│   ├── ast-extractor.test.js
│   ├── url-utils.test.js
│   ├── dedupe.test.js
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
| CORS | Browser context handles naturally; map/JS re-fetch uses Node fetch with cookies/headers |
| WAF / bot block | Stealth basics; on challenge page, warn and continue with whatever JS loaded |
| Relative API paths | Resolve against target origin |
| Template URLs | `{{var}}` in Postman; `{var}` in OpenAPI |
| No source maps | Analyze minified JS only; continue |
| Invalid map JSON | Log skip; continue |
| Babel parse fail | Regex fallback |
| Duplicate endpoints | Merge by dedup key |
| Cross-origin APIs | Record in findings; don't crawl cross-origin HTML unless flag added later |
| Huge bundles | Enforce `--max-js`; truncate body read at e.g. 32 MiB |
| Embedded base64 maps | Decode per sourcemapper / Source Map spec linking rules |
| Path traversal in map `sources` | Sanitize when writing `--save-sources` |
| WebSockets | Capture URL; export as raw + OpenAPI extension; Postman item with description note |
| Empty findings | Write valid empty collection; exit 0 |

---

## 15. Security & Ethics Constraints

- Tool is for **authorized** testing only; README must state this clearly.
- Default same-origin restriction for source map fetches (`--allow-external-maps` to override).
- Do not execute reconstructed source as code — parse only.
- Avoid writing secrets discovered in JS into exports beyond what is needed for route params; raw format may include more detail under `--verbose` evidence only.
- Proxy support enables routing through Burp for operator visibility.

---

## 16. Testing Strategy

### 16.1 Unit Tests

- `url-utils`: relative resolve, template conversion, path parameterization
- `ast-extractor`: fixtures for fetch, axios, XHR, template literals, Angular `$http`
- `regex-fallback`: minified one-liners
- `reconstruct`: fixture `.map` with `sourcesContent`, inline `data:` map in JS
- `dedupe`: network+ast merge, UUID collapse

### 16.2 Integration Tests

- Local static fixture server (small Vite/Webpack-like fake SPA) with:
  - Lazy chunk
  - Exposed `.map`
  - `fetch('/api/v1/items')` in source
- Run CLI against `http://127.0.0.1:<port>` and assert Postman/OpenAPI output contains expected route.

### 16.3 Manual Acceptance (from PRD)

1. `-u` required validation works.
2. Cookie/header authenticated page loads extra chunks vs anonymous.
3. Depth 2 discovers more JS than depth 0.
4. Export imports cleanly into Postman and Burp (OpenAPI).

---

## 17. Implementation Phases

| Phase | Deliverable |
|---|---|
| **P0** | SPEC.md (this document), package scaffold, CLI stub with `--help` |
| **P1** | Playwright load + network intercept + JS capture + raw dump of network endpoints |
| **P2** | Crawl depth + cookie/header auth |
| **P3** | Source map discovery + reconstruction + optional `--save-sources` |
| **P4** | Babel AST extractors + regex fallback + URL normalization |
| **P5** | Merge/dedupe/parameterize |
| **P6** | Postman + OpenAPI + raw exporters |
| **P7** | Stealth basics, proxy, tests, README usage |

---

## 18. Success Criteria

ChunkSpelunker v1 is complete when:

1. `npx chunkspelunker --help` documents all PRD flags.
2. Against a fixture SPA with an exposed source map, the tool recovers original sources and extracts at least the known `/api/...` routes from AST.
3. Live `fetch`/`XHR` calls during crawl appear in the export even if absent from static analysis.
4. Template literal routes appear as Postman-ready `{{var}}` paths.
5. `-f postman` and `-f openapi` produce schema-valid outputs importable by Postman and Burp.
6. Missing source maps do not prevent minified AST/regex analysis.

---

## 19. Open Questions (Resolved for v1)

| Question | Decision |
|---|---|
| Commander vs Yargs | **Commander** (lighter, excellent repeatable options) |
| ESM vs CJS | **ESM** (`"type": "module"`) |
| OpenAPI YAML vs JSON | JSON by default; YAML if `-o` ends with `.yml`/`.yaml` |
| Crawl SPA router links without `<a href>` | v1: `<a href>` + configurable selector only; hash-router clicking deferred |
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
