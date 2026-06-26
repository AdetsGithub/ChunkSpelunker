# Development

Guide for contributors and maintainers working on ChunkSpelunker itself.

## Prerequisites

- Node.js ≥ 20  
- npm  
- Git  
- Network for first Playwright Chromium download  

## Setup

```bash
git clone <repo-url> ChunkSpelunker
cd ChunkSpelunker
npm install
npx chunkspelunker --help
npm test
```

## Scripts

| Script | Command | Purpose |
|---|---|---|
| Start | `npm start -- -u https://…` | Run CLI via package script |
| Test | `npm test` | `node --test test/**/*.test.js` |
| Postinstall | (automatic) | `npx playwright install chromium` |

## Repository layout

See [ARCHITECTURE.md](./ARCHITECTURE.md) for module responsibilities.

```text
src/           implementation
test/          unit tests + fixtures
docs/          operator & developer docs (this tree)
SPEC.md        normative design
bin/           CLI entry
.legacy_docs/  historical SPEC/critique snapshots (reference only)
```

## Coding conventions

- **ESM only** (`"type": "module"`).  
- Match existing style: early returns, minimal comments, JSDoc on non-obvious public functions.  
- Do not hold full JS corpora in `PipelineContext` Maps — use `AssetCache` disk paths.  
- Never call `response.body()` without an SSE / content-type gate.  
- Same-origin vs map-origin credential rules live in `http/header-policy.js` — keep them centralized.  
- Prefer extending tests when changing merge, hydration, or URL normalization.

## Tests

### Unit tests

| File | Coverage |
|---|---|
| `test/url-utils.test.js` | Parameterization, templates, relative resolve-then-dedupe |
| `test/graphql-utils.test.js` | operationName / type inference |
| `test/header-policy.test.js` | Hydration + no Bearer leak to map origins |
| `test/ast-extractor.test.js` | fetch/axios AST + chunked regex |
| `test/dedupe.test.js` | AST path precedence + GraphQL distinctness |

Run:

```bash
npm test
node --test test/url-utils.test.js   # single file
```

### Fixture SPA

`test/fixtures/spa/` is a tiny static app:

| File | Role |
|---|---|
| `index.html` | Seed page with Reports + Log out buttons |
| `app.js` | Initial fetches + `sourceMappingURL` |
| `app.js.map` | Map with `sourcesContent` for `/api/v1/users/${userId}/profile` |
| `chunk-reports.js` | Lazy chunk: reports API + GraphQL `GetReports` |

Serve and scan:

```bash
cd test/fixtures/spa && python3 -m http.server 8765
# other terminal
npx chunkspelunker -u http://127.0.0.1:8765/ -d 1 -f raw -o /tmp/cs.json --verbose
```

**Expect:**

- JS assets for `app.js` and `chunk-reports.js` after clicking Reports  
- Log out **not** clicked (no forced trip to `/login`)  
- Source map reconstruction ≥ 1 file  
- Endpoint `/api/v1/users/{{userId}}/profile`  
- GraphQL `GetReports`  

## Debugging tips

```bash
# Keep intercepted JS on disk
npx chunkspelunker -u … --keep-tmpdir --verbose

# Show browser
npx chunkspelunker -u … --no-headless -d 1

# Save reconstructed sources
npx chunkspelunker -u … --save-sources ./recovered-src
```

AST workers log timeouts as:

```text
[!] AST timeout for https://…
```

## Spec vs code

| Change type | Update |
|---|---|
| New flag / default | `src/cli.js`, `docs/CLI.md`, `README.md`, SPEC §5 if normative |
| Edge-case behavior | SPEC (§14 / revision section) + implementation + test |
| Export schema | `docs/EXPORTS.md` + exporter module |

Historical SPEC drafts and critiques live under `.legacy_docs/` for archaeology; **do not** treat them as current.

## Pull request checklist

- [ ] `npm test` passes  
- [ ] Manual fixture smoke if crawl/network/map code changed  
- [ ] Docs updated (CLI / AUTH / EXPORTS / TROUBLESHOOTING as relevant)  
- [ ] No secrets committed (`auth.json`, live JWTs, customer maps)  
- [ ] SPEC bumped only when behavior is normative  

## License

MIT. Contributions should keep the authorized-testing posture clear in user-facing docs.
