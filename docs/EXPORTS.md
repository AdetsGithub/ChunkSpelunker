# Export formats

ChunkSpelunker writes a single file via `-o` / `--output`. Choose the shape with `-f` / `--format`.

| Format | Flag | File type | Primary consumers |
|---|---|---|---|
| Postman Collection v2.1 | `-f postman` | JSON | Postman, Newman, some Burp workflows |
| OpenAPI 3.0.3 | `-f openapi` | JSON or YAML | Burp OpenAPI import, Swagger UI, Postman import |
| Raw findings | `-f raw` | JSON | Diffing, custom tooling, engagement notes |

---

## Postman (`-f postman`)

### Shape

- Schema: `https://schema.getpostman.com/json/collection/v2.1.0/collection.json`
- Collection variable: `baseUrl` = target origin
- One item per merged endpoint
- Path variables use Postman `{{var}}` when AST provided semantic names (e.g. `{{userId}}`)
- Query parameter names included with empty values (ready for Runner / Intruder-style fuzzing)
- GraphQL items named `GQL {operationType} {operationName}` with a JSON body stub (`operationName`, `query`, `variables`)
- WebSocket / SSE called out in the item description

### Example item (illustrative)

```json
{
  "name": "GET /api/v1/users/{{userId}}/profile",
  "request": {
    "method": "GET",
    "header": [],
    "url": {
      "raw": "{{baseUrl}}/api/v1/users/{{userId}}/profile",
      "host": ["{{baseUrl}}"],
      "path": ["api", "v1", "users", "{{userId}}", "profile"],
      "query": []
    }
  }
}
```

### Import

1. Postman → Import → select the JSON file  
2. Set collection variable `baseUrl` if the target differs from discovery  
3. Add collection-level auth as needed (tokens are not auto-dumped from `storageState` into the collection for safety)

---

## OpenAPI (`-f openapi`)

### Shape

- `openapi: 3.0.3`
- `servers[0].url` = target origin
- Paths use `{param}` style (converted from `{{param}}`)
- Path/query parameters declared when known
- JSON body property names inferred when observed
- GraphQL: operations listed under `x-graphql-operations` on the GraphQL path’s `post` operation
- WebSockets: top-level `x-websockets` array
- SSE: operation vendor extension `x-sse: true`

### YAML vs JSON

```bash
# JSON
npx chunkspelunker -u https://app.example.com -f openapi -o api.json

# YAML (extension triggers YAML serializer)
npx chunkspelunker -u https://app.example.com -f openapi -o api.yaml
```

### Burp Suite

1. Run ChunkSpelunker with `-f openapi`  
2. Burp → Extender / OpenAPI parser (or “Import API definition” depending on edition/extension)  
3. Review generated paths before active scanning  

OpenAPI cannot express multiple GraphQL operations as distinct paths elegantly; prefer **Postman** or **raw** when GraphQL coverage matters most.

---

## Raw (`-f raw`)

Full internal snapshot for auditors and tooling.

### Top-level fields

| Field | Description |
|---|---|
| `target` | Seed URL |
| `generatedAt` | ISO-8601 timestamp |
| `stats` | Counts: jsAssets, sourceMaps, reconstructedFiles, networkEndpoints, staticEndpoints, mergedEndpoints |
| `jsAssets` | Metadata only (url, diskPath at run time, byteLength, pageUrls) — bodies not embedded |
| `sourceMaps` | Count of maps processed |
| `reconstructedFiles` | Count of reconstructed source files |
| `endpoints` | Array of `EndpointFinding` objects |
| `websockets` | WS URLs |
| `sse` | SSE URLs |

### Endpoint object (fields)

| Field | Description |
|---|---|
| `method` | HTTP method (uppercase) |
| `url` | Resolved absolute URL when known |
| `pathTemplate` | Templated path (`{{userId}}` or `{id}`) |
| `queryParams` | Parameter names |
| `bodyParams` | JSON body key names |
| `headers` | Non-sensitive inferred headers |
| `source` | `network` \| `ast` \| `regex` \| `both` |
| `confidence` | `high` \| `medium` \| `low` |
| `evidence` | jsUrls, sampleRequest, rawPath, resolvedFromPage, … |
| `graphql` | optional `{ operationName, operationType, hasQuery }` |
| `websocket` / `sse` | booleans |

### Example

```bash
npx chunkspelunker -u https://app.example.com -f raw -o findings.json --verbose
jq '.stats, .endpoints[].pathTemplate' findings.json
```

---

## Path template conventions

| Source | Example | Notes |
|---|---|---|
| AST template literal | `/api/users/{{userId}}` | Preferred on merge |
| Network observation | `/api/users/{id}` | Numeric/UUID/hex parameterization |
| Relative resolution | `/dashboard/reports/data` | From `./data` + page context |

Postman keeps `{{var}}`. OpenAPI converts to `{var}`.

---

## What is intentionally not exported

- Full `localStorage` dumps  
- Raw JWTs from `--state` (unless you also passed them via `-H` into browser headers that somehow appear in evidence — avoid putting secrets in tickets)  
- Complete JS file bodies (use `--save-sources` / `--keep-tmpdir` instead)  
- Response bodies beyond truncated shape inference  

See [SECURITY.md](./SECURITY.md).
