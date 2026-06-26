# Architecture

This document describes the **implemented** pipeline. The normative design (including rationale and revision history) lives in [../SPEC.md](../SPEC.md) **v1.3.1**.

## Pipeline overview

```text
┌──────────────────────────────┐
│  CLI (commander)             │
│  src/cli.js                  │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Orchestrator                │
│  src/pipeline.js             │
└──┬─────────┬─────────┬───────┘
   │         │         │
   ▼         ▼         ▼
 Browser   Source    AST pool
 crawl     maps      + merge
   │         │         │
   └─────────┴────┬────┘
                  ▼
               Exporters
```

### Stages (runtime order)

| # | Stage | Primary modules |
|---|---|---|
| 1 | Init / scratch dir | `pipeline.js`, `cli.js` |
| 2 | Browser launch + auth | `browser/crawler.js`, `http/header-policy.js` |
| 3 | Intercept + disk cache | `browser/network-store.js`, `browser/asset-cache.js` |
| 4 | SPA crawl | `browser/crawler.js`, `browser/history-observer.js`, `browser/stealth.js` |
| 5 | Source map discovery | `sourcemap/discover.js`, `http/authed-fetch.js` |
| 6 | AST / regex analysis | `analyze/ast-pool.js`, `ast-worker.js`, `ast-extractor.js`, `regex-fallback.js` |
| 7 | Merge / dedupe | `merge/dedupe.js`, `analyze/url-utils.js`, `graphql-utils.js` |
| 8 | Export | `export/postman.js`, `openapi.js`, `raw.js` |
| 9 | Cleanup | asset cache `tmpdir` removal |

---

## Module map

| Path | Responsibility |
|---|---|
| `bin/chunkspelunker.js` | Shebang entry; delegates to `runCli` |
| `src/cli.js` | Flag parsing, validation, exit codes |
| `src/pipeline.js` | Stage orchestration |
| `src/models.js` | Shared defaults (selectors, hydrate format, token keys) |
| `src/log.js` | stderr logging helpers |
| `src/browser/crawler.js` | Playwright session, crawl loop, wiring |
| `src/browser/asset-cache.js` | Disk-backed JS writes; in-flight write dedupe |
| `src/browser/network-store.js` | XHR/Fetch/WS/SSE recording; body caps; SSE skip |
| `src/browser/history-observer.js` | `pushState` / `replaceState` / hash hooks |
| `src/browser/stealth.js` | Basic `navigator.webdriver` hardening |
| `src/http/header-policy.js` | Same-origin vs map-origin credentials; hydration |
| `src/http/authed-fetch.js` | Concurrency-limited map/JS re-fetch |
| `src/sourcemap/discover.js` | `sourceMappingURL`, `data:` maps, reconstruct to disk |
| `src/analyze/ast-extractor.js` | Babel parse + HTTP client visitors |
| `src/analyze/ast-worker.js` | Worker thread entry |
| `src/analyze/ast-pool.js` | Pool, timeouts, respawn |
| `src/analyze/regex-fallback.js` | Chunked, linear regex extraction |
| `src/analyze/url-utils.js` | Templates, parameterization, relative permutations |
| `src/analyze/graphql-utils.js` | `operationName` / operation type |
| `src/merge/dedupe.js` | Merge rules, GraphQL keys, AST path precedence |
| `src/export/*` | Format writers |

---

## Data flow contracts

### Disk-backed assets (not in RAM)

```ts
JsAssetMeta {
  url: string
  diskPath: string      // under tmpdir/js/
  contentType?: string
  byteLength: number
  pageUrls: Set<string> // pages that loaded this chunk
}
```

Playwright’s `response.body()` still materializes a Buffer briefly; it is written to disk immediately and not retained on the context Map. See SPEC §7.7.

### Network calls

- `postData` truncated to `--max-body-bytes`  
- `text/event-stream` → record URL only; **never** `body()`  
- GraphQL metadata attached when detectable  

### Findings

Canonical fields (see SPEC §10.1): method, url, pathTemplate, query/body params, source (`network` \| `ast` \| `regex` \| `both`), confidence, evidence, optional `graphql` / `websocket` / `sse`.

### Merge precedence

| Field | Winner |
|---|---|
| `method` | Network |
| `pathTemplate` | AST semantic `{{userId}}` over network `{id}` |
| query/body param names | Union |
| GraphQL | Prefer named `operationName` |

Relative paths: resolve against **all** `pageUrls` → unique absolute URLs → cap uniques (default 20).

---

## Concurrency & isolation

| Concern | Mechanism |
|---|---|
| AST CPU | `worker_threads` pool (`--ast-workers`) |
| AST hang | `--ast-timeout` → `worker.terminate()` + replace |
| Babel stack overflow | catch `RangeError` → regex |
| ReDoS on huge files | chunk input; linear patterns; per-chunk caps |
| Map fetch stampede | `--map-concurrency` + 429 backoff |
| Concurrent JS writes | in-flight hash map in `AssetCache` |

---

## Auth sync (same-origin maps)

```text
storageState
   ├─ cookies ──────────► APIRequestContext cookie jar
   └─ localStorage ─────► hydrateTokenFromState()
                              └─ --hydrate-format
                                   └─ same-origin map GET headers only
```

Cross-origin maps use `--map-header` exclusively. Details: [AUTHENTICATION.md](./AUTHENTICATION.md), SPEC §7.1.1 / §8.4.

---

## Crawl model

1. Seed URL at depth 0  
2. Install History hooks before/with navigation  
3. Discover clickables via `--click-selector`  
4. Exclude logout/destructive via heuristics (+ documented exclude list)  
5. `click({ force: true })` by default; Escape between clicks  
6. Treat History URL changes as navigations  
7. Caps: navigations ≤ 100, clicks ≤ 250, ~40 click candidates per page  

Avoid `--wait-until networkidle` on SSE-heavy apps.

---

## Design revision index

| Spec section | Topic |
|---|---|
| §21 | v1.0 → v1.1 (SPA crawl, workers, storageState, GraphQL, map headers) |
| §22 | v1.1 → v1.2 (disk cache, force clicks, path precedence, RangeError, pageUrls) |
| §23 | v1.2 → v1.3 (auth sync, excludes, AST timeout, map concurrency, resolve-then-dedupe) |
| §24 | v1.3 → v1.3.1 (SSE, ReDoS-safe regex, `--hydrate-format`) |

---

## Extension points (for contributors)

| Goal | Start here |
|---|---|
| New HTTP client AST pattern | `ast-extractor.js` `fromCallExpression` |
| New export format | `src/export/` + branch in `pipeline.js` / CLI enum |
| Smarter destructive-click ML | `crawler.js` enqueue filter |
| Per-origin map headers | `header-policy.js` + CLI (not in v1) |
