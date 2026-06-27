# ChunkSpelunker

**Headless SPA reconnaissance for authorized application security testing.**

ChunkSpelunker drives a modern Single Page Application in Playwright, intercepts JavaScript chunks and API traffic, recovers original sources from exposed source maps when available, statically extracts HTTP endpoints with Babel AST analysis (regex fallback), and exports a deduplicated collection for **Postman** or **Burp Suite** (OpenAPI 3).

```text
browse → intercept → source maps → AST workers → merge → Postman / OpenAPI / raw
```

> **Authorized testing only.** Only use this tool against systems you own or have explicit written permission to test. Misuse may violate law and policy.

| Document | Contents |
|---|---|
| **[SPEC.md](./SPEC.md)** | Normative architecture, edge cases, design revisions (v1.3.1) |
| **[docs/CLI.md](./docs/CLI.md)** | Complete flag reference and examples |
| **[docs/AUTHENTICATION.md](./docs/AUTHENTICATION.md)** | Cookies, headers, `storageState`, token hydration |
| **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** | Pipeline stages, modules, data flow |
| **[docs/EXPORTS.md](./docs/EXPORTS.md)** | Postman, OpenAPI, and raw output schemas |
| **[docs/EXAMPLES.md](./docs/EXAMPLES.md)** | Copy-paste engagement recipes |
| **[docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)** | Common failures and mitigations |
| **[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)** | Setup, tests, fixtures, contribution notes |
| **[docs/SECURITY.md](./docs/SECURITY.md)** | Threat model, secrets handling, safe defaults |

---

## Why ChunkSpelunker?

Modern frontends hide a large portion of their attack surface in minified Webpack/Vite chunks, lazy-loaded routes, and source maps that should never have shipped to production. Existing tools solve pieces of this problem:

| Capability | Existing tools | Gap |
|---|---|---|
| Source map tree extraction | sourcemapper, unwebpack-sourcemap, JS Miner | Not wired to live SPA crawl + export |
| Static JS endpoint mining | jsluice, jshunter | No dynamic chunk triggering / network merge |
| Traffic → OpenAPI | mitmproxy2swagger, Unbrowse | No JS chunk / source map / AST pipeline |
| Burp passive JS recon | JS Miner | Requires Burp Pro; not a standalone CLI |

ChunkSpelunker is the end-to-end pipeline: **dynamic crawl + static analysis + structured export**.

---

## Requirements

- **Node.js ≥ 20**
- Network access to the target (and optional proxy such as Burp)
- ~200–400 MB disk for Playwright Chromium (installed on `npm install`)

---

## Install

```bash
git clone <repo-url> ChunkSpelunker
cd ChunkSpelunker
npm install
```

`postinstall` runs `npx playwright install chromium`. If that fails (air-gapped / CI), install browsers manually:

```bash
npx playwright install chromium
```

Link the CLI globally (optional):

```bash
npm link
chunkspelunker --help
```

Or run without linking:

```bash
npx chunkspelunker --help
node bin/chunkspelunker.js --help
```

---

## Quick start

```bash
# Unauthenticated shallow crawl → Postman collection
npx chunkspelunker -u https://app.example.com -o collection.json

# Authenticated OAuth/OIDC SPA (localStorage JWT) → OpenAPI YAML
npx chunkspelunker -u https://app.example.com/dashboard \
  --state ./auth.json \
  -d 3 \
  -f openapi \
  -o api.yaml

# Session cookie + custom hydrate format for map re-fetches
npx chunkspelunker -u https://app.example.com \
  --state ./auth.json \
  --hydrate-format "x-api-key: {token}" \
  -f raw -o findings.json --verbose

# Through Burp
npx chunkspelunker -u https://app.example.com \
  --proxy http://127.0.0.1:8080 \
  --insecure \
  -o burp-import.json
```

Import `collection.json` into Postman, or import OpenAPI into Burp’s OpenAPI parser / Postman’s import.

---

## How it works (short)

1. **Init** — Parse CLI; create scratch dir; load `--state` / cookies / headers; hydrate auth for same-origin re-fetches.
2. **Intercept** — Playwright loads the target; JS bodies are written to disk (not kept in a giant in-memory Map); XHR/Fetch/WS/SSE URLs are recorded (SSE bodies are never buffered).
3. **Crawl** — Clicks buttons/ARIA roles (not only `<a href>`), observes `history.pushState`, skips logout/destructive controls, depth-limited BFS.
4. **Source maps** — Parse `sourceMappingURL`, including inline `data:` maps; speculative `.map` GETs are concurrency-limited and auth-synced.
5. **AST** — Worker pool parses JS with Babel; `RangeError` / timeout / oversized files fall back to chunked, ReDoS-aware regex.
6. **Merge** — Network + static findings; GraphQL keyed by `operationName`; **AST semantic path templates win** over network `{id}` guesses.
7. **Export** — Postman v2.1, OpenAPI 3.0, or raw JSON; scratch dir cleaned unless `--keep-tmpdir`.

For normative detail, see [SPEC.md](./SPEC.md) and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## CLI overview

| Flag | Description |
|---|---|
| `-u, --url <url>` | **Required.** Target application URL |
| `-c, --cookie <string>` | Cookie header value for authenticated crawling |
| `-H, --header <string>` | Repeatable `Name: Value` (same-origin for Node re-fetches) |
| `-d, --depth <int>` | Crawl depth (default `1`) |
| `-o, --output <file>` | Output path (default `chunkspelunker-output.json`) |
| `-f, --format <type>` | `postman` \| `openapi` \| `raw` (default `postman`) |
| `--state <file>` | Playwright `storageState` JSON |
| `--hydrate-format <tpl>` | Template for hydrated tokens (default `Authorization: Bearer {token}`) |
| `--map-header` / `--map-origin` | Credentials / allowlist for cross-origin source maps |
| `--exclude-selector` | Never click these (logout/delete defaults) |
| `--ast-workers` / `--ast-timeout` | AST pool size and per-file timeout |
| `--map-concurrency` | Max parallel `.map` fetches (default `4`) |
| `--verbose` / `--quiet` | Logging controls |

**Full reference:** [docs/CLI.md](./docs/CLI.md)

---

## Authentication cheatsheet

| Scenario | Recommended approach |
|---|---|
| Simple cookie session | `-c "session=…; csrf=…"` |
| Static Bearer on every browser request | `-H "Authorization: Bearer …"` |
| JWT / OIDC token in `localStorage` | Export Playwright `--state`, pass `--state auth.json` |
| API expects `x-api-key` instead of Bearer | `--state … --hydrate-format "x-api-key: {token}"` |
| Source maps on Sentry/CDN | `--allow-external-maps --map-origin … --map-header …` (never reuse app JWT) |

**Details:** [docs/AUTHENTICATION.md](./docs/AUTHENTICATION.md)

### Exporting `storageState`

```bash
# Interactive login, then save state
npx playwright open --save-storage=auth.json https://app.example.com/login
# or
npx playwright codegen --save-storage=auth.json https://app.example.com/login
```

Treat `auth.json` as a **secret**. Do not commit it. It is listed in `.gitignore` patterns such as `auth.json` and `*.storage.json`.

---

## Output formats

| Format | Flag | Typical use |
|---|---|---|
| Postman Collection v2.1 | `-f postman` | Import into Postman / Newman; Intruder-ready `{{var}}` paths |
| OpenAPI 3.0 | `-f openapi` | Burp OpenAPI import; `.yaml`/`.yml` extension writes YAML |
| Raw findings | `-f raw` | Full stats, JS asset metadata, endpoints with provenance |

**Schemas and examples:** [docs/EXPORTS.md](./docs/EXPORTS.md)

---

## Project layout

```text
ChunkSpelunker/
├── SPEC.md                 # Normative specification (v1.3.1)
├── README.md               # This file
├── docs/                   # Operator & developer guides
├── bin/chunkspelunker.js   # CLI entrypoint
├── src/
│   ├── cli.js              # Commander argument parsing
│   ├── pipeline.js         # Orchestrator
│   ├── browser/            # Playwright crawl, cache, network, stealth
│   ├── http/               # Header policy, authed map fetcher
│   ├── sourcemap/          # Discovery & reconstruction
│   ├── analyze/            # AST pool/worker, regex, URL/GraphQL utils
│   ├── merge/              # Dedupe & path precedence
│   └── export/             # Postman / OpenAPI / raw
└── test/                   # Unit tests + fixture SPA
```

---

## Testing

```bash
npm test
```

Runs Node’s built-in test runner against `test/**/*.test.js` (URL utils, GraphQL, header policy, AST/regex, merge/dedupe).

**Local fixture SPA** (optional manual check):

```bash
# Terminal 1 — serve fixture
cd test/fixtures/spa && python3 -m http.server 8765

# Terminal 2
npx chunkspelunker -u http://127.0.0.1:8765/ -d 1 -f raw -o /tmp/cs.json --verbose
```

See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (including empty collections) |
| `1` | Invalid arguments / usage |
| `2` | Navigation / browser failure |
| `3` | Critical stage failure (e.g. unexpected crash) |

---

## Operational safety defaults

ChunkSpelunker is built to survive real-world SPA chaos:

- **Disk-backed JS cache** — avoids OOM from hundreds of multi-MB bundles
- **SSE-aware interception** — never calls `response.body()` on `text/event-stream`
- **Force clicks** — modal backdrops do not abort the click budget
- **Logout exclusion** — default heuristics skip Log out / Sign out / Delete account
- **AST worker timeouts** — hung Babel/regex jobs are terminated and replaced
- **Map fetch concurrency limits** — reduces WAF 429 / accidental DoS
- **Scoped map credentials** — app tokens are not sent to third-party map hosts

If something fails silently or hangs, start with [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md).

---

## Security & ethics

- Use only with authorization.
- `--state` and reconstructed sources under `--save-sources` / `--keep-tmpdir` may contain secrets — handle accordingly.
- `--map-header` values are broadcast to **all** `--map-origin` hosts; do not mix unrelated third-party credentials in one run.

Full guidance: [docs/SECURITY.md](./docs/SECURITY.md).

---

## Versioning

| Artifact | Version |
|---|---|
| npm package | see `package.json` |
| Specification | **1.3.1** in `SPEC.md` |

Design history (v1.0 → v1.3.1) is recorded in SPEC §21–§24.

---

## License

MIT — see package metadata. Use responsibly.
