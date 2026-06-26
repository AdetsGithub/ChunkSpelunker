import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromCode } from '../src/analyze/ast-extractor.js';
import { regexFallback } from '../src/analyze/regex-fallback.js';

test('AST extracts fetch and axios', () => {
  const code = `
    fetch('/api/v1/items', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
    axios.get('/api/v1/users/' + id);
    api.post(\`/api/v1/users/\${userId}/profile\`);
  `;
  const { findings, engine } = extractFromCode(code, 'https://app.test/app.js');
  assert.equal(engine, 'ast');
  assert.ok(findings.some((f) => f.url.includes('/api/v1/items') && f.method === 'POST'));
  assert.ok(findings.some((f) => String(f.pathTemplate).includes('userId') || String(f.url).includes('userId')));
});

test('regexFallback chunks large input', () => {
  const pad = 'x'.repeat(300_000);
  const code = `${pad};fetch("/api/v2/health");${pad}`;
  const findings = regexFallback(code, 'https://app.test/big.js');
  assert.ok(findings.some((f) => f.url.includes('/api/v2/health')));
});
