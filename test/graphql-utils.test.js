import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractGraphqlMeta, hashQueryPreview } from '../src/analyze/graphql-utils.js';

test('extracts operationName from JSON body', () => {
  const meta = extractGraphqlMeta('https://x/graphql', JSON.stringify({
    operationName: 'GetUser',
    query: 'query GetUser { user { id } }',
  }));
  assert.equal(meta.operationName, 'GetUser');
  assert.equal(meta.operationType, 'query');
});

test('infers name from query when operationName missing', () => {
  const meta = extractGraphqlMeta('https://x/gql', JSON.stringify({
    query: 'mutation CreateUser { createUser { id } }',
  }));
  assert.equal(meta.operationName, 'CreateUser');
  assert.equal(meta.operationType, 'mutation');
});

test('hashQueryPreview is stable', () => {
  assert.equal(hashQueryPreview('query A { x }'), hashQueryPreview('query A { x }'));
});
