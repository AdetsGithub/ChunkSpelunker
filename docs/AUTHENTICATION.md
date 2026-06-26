# Authentication

ChunkSpelunker supports three complementary auth mechanisms. Understanding which layer applies where is critical for authenticated SPAs and source-map recovery.

## Layers at a glance

| Mechanism | Browser page JS | Browser navigations / XHR from page | Same-origin `.map` / JS re-fetch | Cross-origin map hosts |
|---|---|---|---|---|
| `-c` cookies | Via cookie jar | Yes | Yes (cookie jar) | Only if cookie domain matches (rare) |
| `-H` headers | As `extraHTTPHeaders` | Yes | Yes (same-origin policy) | **No** |
| `--state` cookies | Yes | Yes | Yes | Domain-dependent |
| `--state` localStorage | Yes (SPA reads it) | Indirect (SPA interceptors) | Via **hydration** + `--hydrate-format` | **No** |
| `--map-header` | No | No | No | Yes (for `--map-origin`) |

---

## 1. Cookies (`-c`)

Pass a Cookie header string:

```bash
npx chunkspelunker -u https://app.example.com/app \
  -c "session=abc123; csrf=xyz789"
```

Cookies are added with:

- `domain` = target hostname  
- `path` = `/`  
- `secure` = true when the target is `https`

Use this for classic session-cookie apps.

---

## 2. Static headers (`-H`)

Repeatable `Name: Value` pairs:

```bash
npx chunkspelunker -u https://app.example.com \
  -H "Authorization: Bearer eyJhbGciOi..." \
  -H "X-Org-Id: 42"
```

These become Playwright `extraHTTPHeaders` (sent on browser navigations and subresource requests according to Playwright rules) and are attached to **same-origin** APIRequest/map re-fetches.

They are **never** attached to third-party map origins. Use `--map-header` for those.

---

## 3. Playwright `storageState` (`--state`)

Modern SPAs often store JWTs in `localStorage` / `sessionStorage`. Cookies alone will not satisfy the app’s Axios/fetch interceptors, and the UI redirects to `/login`.

### Export state after a manual login

```bash
npx playwright codegen --save-storage=auth.json https://app.example.com/login
# Complete login in the browser, then stop codegen / close when prompted to save
```

Or:

```bash
npx playwright open --save-storage=auth.json https://app.example.com/login
```

### Use with ChunkSpelunker

```bash
npx chunkspelunker -u https://app.example.com/dashboard \
  --state ./auth.json \
  -d 3 \
  -o collection.json
```

### What `storageState` contains

```json
{
  "cookies": [ /* ... */ ],
  "origins": [
    {
      "origin": "https://app.example.com",
      "localStorage": [
        { "name": "access_token", "value": "eyJ..." }
      ]
    }
  ]
}
```

- **Cookies** → Playwright context cookie jar  
- **localStorage / sessionStorage** → available to page JS; also scanned for hydration (below)

Treat `auth.json` as a **credential**. Do not commit it. Rotate tokens after engagements.

---

## 4. Token hydration (`--hydrate-format`)

### The auth desync problem

Even with `--state`, same-origin `.map` downloads historically used a Node `fetch` that could not see `localStorage`. The SPA loaded fine; map discovery returned **401**.

### The fix

1. Same-origin re-fetches use Playwright `APIRequestContext` (cookie jar included).  
2. On INIT, ChunkSpelunker scans `storageState` origins for well-known keys:

   ```text
   access_token, id_token, token, authToken, auth_token, jwt,
   accessToken, idToken, bearer, authorization
   ```

   Plus light parsing of common Okta/Auth0 JSON blobs.

3. If a token is found and you did not already set the same header via `-H`, it synthesizes a header using `--hydrate-format`.

### Default

```text
Authorization: Bearer {token}
```

### Custom schemes

```bash
# API key header
--hydrate-format "x-api-key: {token}"

# Django-style Token
--hydrate-format "Authorization: Token {token}"

# CSRF-style
--hydrate-format "X-CSRF-Token: {token}"
```

Rules:

- Template **must** include `{token}` exactly once as the value placeholder.  
- Format is `Header-Name: value-template-with-{token}`.  
- Explicit `-H` for the same header name overrides hydration.  
- Hydrated headers are **same-origin only** — never sent to `--map-origin` hosts.

Verbose log (token value redacted):

```text
[.] hydrated header via --hydrate-format from storageState key=access_token
```

### Exotic storage keys

If your token lives under a non-standard key and is not auto-detected:

1. Pass it explicitly: `-H "Authorization: Bearer <paste>"`, or  
2. Re-export storage after writing a known key, or  
3. Use cookies if the API also accepts session cookies.

---

## 5. Combining mechanisms

| Goal | Example |
|---|---|
| Cookie session + CSRF header | `-c "session=…" -H "X-CSRF-Token: …"` |
| storageState + deepen crawl | `--state auth.json -d 3` |
| storageState + custom API key header for maps | `--state auth.json --hydrate-format "x-api-key: {token}"` |
| App auth + separate Sentry map auth | `--state auth.json --allow-external-maps --map-origin https://sentry.io --map-header "Authorization: Bearer sentry-tok"` |

---

## 6. Session death during crawl

The crawler skips controls that look like logout / sign-out / delete-account (see [CLI.md](./CLI.md)).

If a click still lands on `/login`, `/signin`, `/sign-in`, or `/logout` while you supplied auth, ChunkSpelunker logs a possible session end and stops further clicks.

Mitigations:

- Widen `--exclude-selector` / rely on built-in text heuristics  
- Start from a deeper post-login URL (`-u …/dashboard`)  
- Lower `-d` while validating auth  
- Use `--no-headless` to watch what gets clicked  

---

## 7. Checklist for authenticated recon

1. [ ] Log in manually; save `--state auth.json`  
2. [ ] Confirm `auth.json` contains cookies and/or localStorage tokens  
3. [ ] Choose `--hydrate-format` if the API is not Bearer  
4. [ ] Run with `-d 1` first; verify maps return 200 under `--verbose`  
5. [ ] Increase depth; extend excludes for destructive UI  
6. [ ] Keep `auth.json` out of git; delete after the engagement  
