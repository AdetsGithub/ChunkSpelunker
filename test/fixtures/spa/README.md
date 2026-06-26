# Fixture SPA

Minimal static application used for manual smoke tests and local demos.

## Files

| File | Purpose |
|---|---|
| `index.html` | Seed page with **Reports** and **Log out** buttons |
| `app.js` | Initial API calls; ends with `sourceMappingURL=app.js.map` |
| `app.js.map` | Source Map v3 with `sourcesContent` exposing `` `/api/v1/users/${userId}/profile` `` |
| `chunk-reports.js` | Lazy-loaded on Reports click: `/api/v1/reports` + GraphQL `GetReports` |

## Serve

```bash
cd test/fixtures/spa
python3 -m http.server 8765
```

## Scan

```bash
npx chunkspelunker -u http://127.0.0.1:8765/ -d 1 -f raw -o /tmp/fixture.json --verbose
```

## Expected behaviors

- Caches `app.js` and, after clicking Reports, `chunk-reports.js`  
- Does **not** follow Log out to `/login`  
- Reconstructs at least one source from `app.js.map`  
- Emits `/api/v1/users/{{userId}}/profile` from AST of reconstructed source  
- Emits GraphQL operation `GetReports`  

See [../../docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md).
