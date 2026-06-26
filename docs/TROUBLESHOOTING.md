# Troubleshooting

Symptoms, likely causes, and fixes. Enable `--verbose` first.

## Browser & navigation

### `Navigation issue` / timeout / blank page

**Causes:** slow app, bot challenge, wrong `--wait-until`, TLS interception without `--insecure`.

**Fixes:**

```bash
--timeout 60000
--wait-until domcontentloaded   # avoid networkidle with SSE
--no-headless                   # watch what happens
--insecure                      # if using Burp HTTPS proxy
--proxy http://127.0.0.1:8080
```

### Cloudflare / WAF challenge page

ChunkSpelunker only applies light stealth (`navigator.webdriver`, etc.). It does **not** solve Turnstile/CAPTCHA.

**Fixes:** export cookies/`storageState` from a real browser session after you pass the challenge; pass `--state`. Or run through an already-authenticated proxy session.

### Exit code 2

Browser launch or navigation failed hard. Check Chromium install:

```bash
npx playwright install chromium
```

---

## Authentication

### Immediately redirected to `/login`

**Cause:** SPA expects a JWT in `localStorage`, but you only passed `-c` / `-H`.

**Fix:**

```bash
npx playwright codegen --save-storage=auth.json https://app.example.com/login
npx chunkspelunker -u https://app.example.com/dashboard --state auth.json
```

### Source maps return 401 while the SPA works

**Cause:** Auth desync — page has localStorage token; map re-fetch lacked hydration / wrong header scheme.

**Fixes:**

```bash
--state auth.json
--hydrate-format "Authorization: Bearer {token}"   # or x-api-key / Token …
--verbose   # look for "hydrated header via --hydrate-format"
```

Confirm same-origin maps; for external map CDNs use `--map-header` + `--map-origin` + `--allow-external-maps`.

### Hydration finds nothing

**Cause:** token key is non-standard.

**Fix:** pass `-H "Authorization: Bearer …"` explicitly, or rename/copy the token into a known key before exporting storageState.

---

## Crawl coverage

### Few JS chunks / missing lazy routes

**Causes:** depth 0; click selector too narrow; SPA uses divs without roles; logout killed the session early.

**Fixes:**

```bash
-d 3
--click-selector 'a[href], button, [role="button"], [role="tab"], .nav-item'
--verbose
```

Watch for History `pushState` debug lines.

### Crawl dies after a few clicks; lands on login

**Cause:** clicked Log out / Revoke / similar.

**Fixes:** built-in logout heuristics; extend excludes; start deeper in the app; lower depth while validating.

### Modals block everything (without force)

Force clicks are **on by default**. If you passed `--no-force-clicks`, re-enable `--force-clicks`.

### `networkidle` hangs forever

Open SSE / long-poll connections never go idle.

**Fix:** use default `domcontentloaded` (or `load`). Do not use `networkidle` on SSE apps.

---

## Source maps

### No maps found

**Normal** for hardened production. Tool still analyzes minified JS.

Check manually:

```bash
curl -I https://app.example.com/static/app.js.map
```

Look for `//# sourceMappingURL=` at the end of JS files (`--keep-tmpdir` and inspect scratch, or DevTools).

### 429 Too Many Requests during map probing

**Fix:**

```bash
--map-concurrency 2
```

The fetcher also backs off per host on 429.

### External maps blocked

```bash
--allow-external-maps \
--map-origin https://maps.example-cdn.com \
--map-header "Authorization: Bearer maps-only"
```

Remember: `--map-header` is broadcast to **all** map origins in the run.

---

## Analysis / workers

### `[!] AST timeout for <url>`

Pathological / huge / obfuscated file. Worker is killed and replaced; file may yield zero or regex-only findings.

**Mitigations:** `--ast-timeout 60000`, `--max-js-bytes` lower to force regex sooner, `--include-vendor false` (default).

### High memory use

Bodies should be on disk. If RSS is still high:

- Lower `--max-js` and `--ast-workers`
- Ensure you are on a build that uses `AssetCache` (not an old prototype)
- Avoid `--keep-tmpdir` growth across many runs

### Zero static findings

Minified code may not parse; regex should still catch `/api/...` strings. Verify with `-f raw` and `stats.staticEndpoints`. Try `--save-sources` when maps exist and re-run analysis mentally on recovered `src/`.

---

## Exports

### Postman import rejects file

Ensure `-f postman` (default) and valid JSON. Open the file — if you accidentally used `-f raw`, the schema differs.

### OpenAPI missing GraphQL operations

Check `x-graphql-operations` on the GraphQL path. Prefer Postman for GraphQL-heavy targets.

### Duplicate `/graphql` with and without operation names

Network calls with bodies produce named ops. Bare string matches without GraphQL meta no longer get a separate GraphQL dedupe key (post-fix). Re-run on latest code; open a raw dump to inspect `source` / `graphql` fields.

---

## Proxy / TLS

### CERT errors with Burp

```bash
--proxy http://127.0.0.1:8080 --insecure
```

### Traffic not appearing in Burp

Confirm proxy URL, that Chromium is launched by ChunkSpelunker (not a system browser), and upstream DNS.

---

## Still stuck?

1. Run with `--verbose --keep-tmpdir`  
2. Inspect scratch JS under the printed tmpdir  
3. Reproduce against `test/fixtures/spa` (see [DEVELOPMENT.md](./DEVELOPMENT.md))  
4. Compare behavior to SPEC edge-case tables (§14)  
