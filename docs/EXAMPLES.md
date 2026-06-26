# Examples cookbook

Copy-paste recipes for common engagement workflows. Replace hostnames and paths with your authorized targets.

## 1. Cold recon (no auth)

```bash
npx chunkspelunker \
  -u https://app.example.com \
  -d 2 \
  -f postman \
  -o cold-recon.postman.json \
  --verbose
```

## 2. Authenticated dashboard (OIDC / localStorage)

```bash
npx playwright codegen --save-storage=auth.json https://app.example.com/login
npx chunkspelunker \
  -u https://app.example.com/dashboard \
  --state ./auth.json \
  -d 3 \
  -f openapi \
  -o dashboard.openapi.yaml \
  --verbose
```

## 3. Custom API key header scheme

```bash
npx chunkspelunker \
  -u https://app.example.com \
  --state ./auth.json \
  --hydrate-format "x-api-key: {token}" \
  -f raw \
  -o findings.json
```

## 4. Recover sources for manual code review

```bash
mkdir -p recovered-src
npx chunkspelunker \
  -u https://app.example.com \
  --state ./auth.json \
  --save-sources ./recovered-src \
  -f raw \
  -o findings.json \
  --verbose
```

## 5. External source maps (e.g. private CDN)

```bash
npx chunkspelunker \
  -u https://app.example.com \
  --state ./auth.json \
  --allow-external-maps \
  --map-origin https://static.internal.example \
  --map-header "Authorization: Bearer maps-cdn-token" \
  --save-sources ./recovered-src \
  -o out.json
```

## 6. Full traffic through Burp

```bash
npx chunkspelunker \
  -u https://app.example.com \
  --state ./auth.json \
  --proxy http://127.0.0.1:8080 \
  --insecure \
  -d 2 \
  -f postman \
  -o via-burp.postman.json
```

## 7. GraphQL-heavy SPA

```bash
npx chunkspelunker \
  -u https://app.example.com \
  --state ./auth.json \
  -d 3 \
  -f postman \
  -o gql.postman.json
```

Inspect items named `GQL query …` / `GQL mutation …`. For machine parsing of ops, also emit raw:

```bash
npx chunkspelunker -u https://app.example.com --state ./auth.json -f raw -o gql.raw.json
jq '.endpoints[] | select(.graphql) | {method, pathTemplate, graphql}' gql.raw.json
```

## 8. Staging with self-signed TLS

```bash
npx chunkspelunker \
  -u https://staging.example.internal \
  --insecure \
  --state ./auth-staging.json \
  -o staging.json
```

## 9. Minimize noise / vendor code

```bash
npx chunkspelunker \
  -u https://app.example.com \
  --state ./auth.json \
  --max-js 100 \
  --map-concurrency 2 \
  -o focused.json
# --include-vendor stays false by default
```

## 10. Local fixture (CI / smoke)

```bash
cd test/fixtures/spa && python3 -m http.server 8765 &
npx chunkspelunker -u http://127.0.0.1:8765/ -d 1 -f raw -o /tmp/fixture.json --verbose
kill %1
```

## 11. Deepen only a subsection of the UI

```bash
npx chunkspelunker \
  -u https://app.example.com/settings \
  --state ./auth.json \
  --click-selector 'nav a[href], [role="tab"]' \
  -d 2 \
  -o settings-only.json
```

## 12. Debug a hang

```bash
npx chunkspelunker \
  -u https://app.example.com \
  --state ./auth.json \
  --no-headless \
  --keep-tmpdir \
  --ast-timeout 15000 \
  --map-concurrency 1 \
  -d 1 \
  --verbose \
  -f raw -o debug.json
```

Then read [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
