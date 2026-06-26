import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parameterizePath,
  resolveRelativePermutations,
  toPostmanTemplate,
  toOpenApiPath,
  structuralPathKey,
} from '../src/analyze/url-utils.js';

test('parameterizePath replaces ids and uuids', () => {
  assert.equal(parameterizePath('/api/users/42/profile'), '/api/users/{id}/profile');
  assert.equal(
    parameterizePath('/x/550e8400-e29b-41d4-a716-446655440000'),
    '/x/{uuid}',
  );
});

test('toPostmanTemplate converts ${var}', () => {
  assert.equal(
    toPostmanTemplate('/api/users/${userId}/profile'),
    '/api/users/{{userId}}/profile',
  );
});

test('toOpenApiPath converts postman vars', () => {
  assert.equal(toOpenApiPath('/api/users/{{userId}}'), '/api/users/{userId}');
});

test('resolveRelativePermutations dedupes before cap', () => {
  const pages = Array.from({ length: 50 }, (_, i) => `https://app.test/items/${i + 1}`);
  const { results, totalUnique } = resolveRelativePermutations('../data', pages, 'https://app.test/', 20);
  assert.equal(totalUnique, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].resolvedUrl, 'https://app.test/data');
});

test('structuralPathKey normalizes templates', () => {
  assert.equal(
    structuralPathKey('/users/{{userId}}'),
    structuralPathKey('/users/{id}'),
  );
});
