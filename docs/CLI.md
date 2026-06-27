# CLI reference

Complete command-line reference for ChunkSpelunker. For architecture and edge-case rationale, see [../SPEC.md](../SPEC.md).

## Invocation

```bash
chunkspelunker [options]
node bin/chunkspelunker.js [options]
npx chunkspelunker [options]
```

Show help:

```bash
chunkspelunker --help
```

---

## Required

| Flag | Type | Description |
|---|---|---|
| `-u, --url <url>` | URL | Target application URL. Must be a valid absolute URL (`http` or `https`). |

---

## Core output & crawl

| Flag | Type | Default | Description |
|---|---|---|---|
| `-d, --depth <int>` | integer | `1` | How deep to exercise internal routes (click / History navigations). `0` loads the seed URL only (still intercepts JS/API on that page). |
| `-o, --output <file>` | path | `chunkspelunker-output.json` | Output file path. |
| `-f, --format <type>` | enum | `postman` | Export format: `postman`, `openapi`, or `raw`. If `openapi` and the path ends in `.yml` / `.yaml`, YAML is written; otherwise JSON. |

---

## Authentication & headers

| Flag | Type | Default | Description |
|---|---|---|---|
| `-c, --cookie <string>` | string | — | Cookie header value, e.g. `session=abc; csrf=xyz`. Parsed into Playwright cookies for the target host. |
| `-H, --header <string>` | string (repeatable) | — | Extra header `Name: Value`. Applied as Playwright `extraHTTPHeaders`. For Node/Playwright API re-fetches of **same-origin** maps/JS, these headers are included. **Not** sent to third-party map hosts. |
| `--state <file>` | path | — | Playwright [`storageState`](https://playwright.dev/docs/auth) JSON (cookies + `localStorage` / `sessionStorage` per origin). Preferred for OAuth/OIDC SPAs. |
| `--hydrate-format <template>` | string | `Authorization: Bearer {token}` | How a token discovered in `storageState` is attached for **same-origin** map/JS re-fetches. Must contain `{token}`. Examples below. |

### `--hydrate-format` examples

```bash
--hydrate-format "Authorization: Bearer {token}"   # default
--hydrate-format "Authorization: Token {token}"
--hydrate-format "x-api-key: {token}"
--hydrate-format "X-CSRF-Token: {token}"
```

Explicit `-H` for the same header name **wins** over hydration.

See [AUTHENTICATION.md](./AUTHENTICATION.md).

---

## Source maps

| Flag | Type | Default | Description |
|---|---|---|---|
| `--map-header <string>` | string (repeatable) | — | Headers used **only** when fetching source maps (and only for allowed map origins). |
| `--map-origin <origin>` | URL (repeatable) | — | Extra origins allowed to receive `--map-header` and eligible under `--allow-external-maps`. |
| `--allow-external-maps` | boolean | `false` | Permit fetching maps from non-target origins. Still will not send app `-H` / hydrated tokens off-origin. |
| `--map-concurrency <n>` | integer | `4` | Max concurrent speculative / remote map fetches. Protects against WAF 429 and accidental DoS. |
| `--include-vendor` | boolean | `false` | Analyze reconstructed `node_modules` / vendor sources (noisier, slower). |
| `--save-sources <dir>` | path | — | Write reconstructed source trees to disk for offline review. |

### Map header broadcasting

All `--map-header` values are sent to **every** `--map-origin`. Do not pass a Sentry token together with a Datadog origin in the same run unless that credential is safe for both. Prefer separate invocations.

```bash
npx chunkspelunker -u https://app.example.com \
  --allow-external-maps \
  --map-origin https://sentry.io \
  --map-header "Authorization: Bearer sentry-only-token" \
  --save-sources ./recovered-src
```

---

## Crawl behavior

| Flag | Type | Default | Description |
|---|---|---|---|
| `--click-selector <css>` | CSS | see below | Elements considered clickable during crawl. |
| `--exclude-selector <css>` | CSS | see below | Documented default list (logout/delete). Runtime exclusion also uses text/href/id/class heuristics because Playwright-only selectors like `:has-text()` are not valid in `Element.matches`. |
| `--force-clicks` | boolean | `true` | Use Playwright `{ force: true }` to bypass actionability (modals/backdrops). |
| `--no-force-clicks` | — | — | Disable force clicks. |
| `--same-origin-only` | boolean | `true` | Only enqueue same-origin navigations **and** skip click targets whose `href` resolves off-origin. If a click still leaves the origin, the crawler returns to the target and does not enqueue off-site pages. Cross-origin **API** calls are still recorded. |
| `--no-same-origin-only` | — | — | Allow cross-origin crawl links and off-site clicks. |

### Default `--click-selector`

```text
a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"]
```

### Default `--exclude-selector` (documented)

```text
[href*="logout" i], [href*="signout" i], [href*="sign-out" i],
[id*="logout" i], [class*="logout" i], [data-testid*="logout" i],
[aria-label*="log out" i], [aria-label*="sign out" i],
button:has-text("Log out"), button:has-text("Logout"), button:has-text("Sign out"),
button:has-text("Delete"), button:has-text("Delete account"), button:has-text("Remove account"),
a:has-text("Log out"), a:has-text("Sign out")
```

Extend for app-specific danger controls:

```bash
--exclude-selector 'button:has-text("Revoke"), [data-action="wipe"], #danger-zone *'
```

Note: custom Playwright-engine selectors work for *locating* if you change crawl code paths; the built-in exclude filter primarily uses **text / href / id / class / aria / testid** heuristics for reliability across Chromium DOM APIs.

---

## Browser & network

| Flag | Type | Default | Description |
|---|---|---|---|
| `--timeout <ms>` | integer | `30000` | Navigation / related timeouts. |
| `--wait-until <event>` | enum | `domcontentloaded` | Playwright `waitUntil`: `load`, `domcontentloaded`, `networkidle`, `commit`. Prefer **not** `networkidle` on apps with SSE (open streams never idle). |
| `--headless` | boolean | `true` | Headless Chromium. |
| `--no-headless` | — | — | Show the browser (debug bot blocks / auth flows). |
| `--user-agent <ua>` | string | realistic Chrome UA | Override User-Agent. |
| `--proxy <url>` | URL | — | HTTP(S) proxy, e.g. Burp `http://127.0.0.1:8080`. |
| `--insecure` | boolean | `false` | Ignore TLS certificate errors (common with Burp MITM). |

---

## Analysis limits & performance

| Flag | Type | Default | Description |
|---|---|---|---|
| `--max-js <n>` | integer | `500` | Max JS assets analyzed. |
| `--max-js-bytes <n>` | integer | `5242880` (5 MiB) | Files larger than this skip Babel and use chunked regex only. |
| `--max-body-bytes <n>` | integer | `262144` (256 KiB) | Truncate captured XHR/Fetch bodies used for parameter shape inference. |
| `--ast-workers <n>` | integer | `min(4, cpus-1)` | Babel worker pool size. |
| `--ast-timeout <ms>` | integer | `30000` | Per-file worker timeout; on expiry the worker is terminated and replaced. |
| `--tmpdir <dir>` | path | `os.tmpdir()/chunkspelunker-<pid>` | Scratch directory for intercepted JS / reconstructed sources. |
| `--keep-tmpdir` | boolean | `false` | Retain scratch dir after run (debug). |

---

## Logging

| Flag | Description |
|---|---|
| `--verbose` | Debug lines on stderr (`[.]`). |
| `--quiet` | Suppress non-error stderr. |

Log prefixes:

| Prefix | Meaning |
|---|---|
| `[+]` | Progress / success |
| `[.]` | Debug (verbose) |
| `[!]` | Warning or error |

JSON/YAML collections are written **only** to `-o` (not stdout).

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (empty collections still count as success) |
| `1` | Invalid arguments |
| `2` | Browser / navigation failure |
| `3` | Unexpected critical failure |

---

## Example recipes

### 1. Post-login dashboard with depth

```bash
npx playwright codegen --save-storage=auth.json https://app.example.com/login
npx chunkspelunker -u https://app.example.com/dashboard \
  --state auth.json \
  -d 3 \
  -f postman \
  -o dashboard.postman.json \
  --verbose
```

### 2. OpenAPI for Burp

```bash
npx chunkspelunker -u https://app.example.com \
  --state auth.json \
  -f openapi \
  -o api.yaml
```

### 3. Raw evidence pack for a report

```bash
npx chunkspelunker -u https://app.example.com \
  --state auth.json \
  --save-sources ./recovered-src \
  --keep-tmpdir \
  -f raw \
  -o findings.raw.json \
  --verbose
```

### 4. Proxy through Burp with TLS interception

```bash
npx chunkspelunker -u https://app.example.com \
  --proxy http://127.0.0.1:8080 \
  --insecure \
  -o via-burp.json
```

### 5. Custom auth header scheme

```bash
npx chunkspelunker -u https://app.example.com \
  --state auth.json \
  --hydrate-format "X-Api-Key: {token}" \
  -o out.json
```
