import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFindings } from '../src/merge/dedupe.js';
import { createFinding } from '../src/models.js';

const baseUrl = new URL('https://app.test/');
const log = { warn() {}, debug() {}, info() {} };

test('AST path template wins over network {id}', () => {
  const cache = { pageUrlsFor: () => new Set() };
  const findings = mergeFindings({
    networkCalls: [
      { method: 'GET', url: 'https://app.test/api/users/42/profile', postData: undefined },
    ],
    staticFindings: [
      createFinding({
        method: 'GET',
        url: '/api/users/{{userId}}/profile',
        pathTemplate: '/api/users/{{userId}}/profile',
        rawPath: '/api/users/{{userId}}/profile',
        source: 'ast',
        evidence: { jsUrls: ['https://app.test/app.js'], rawPath: '/api/users/${userId}/profile' },
      }),
    ],
    websockets: new Set(),
    sseUrls: new Set(),
    baseUrl,
    cache,
    log,
  });

  const hit = findings.find((f) => f.pathTemplate.includes('user'));
  assert.ok(hit);
  assert.match(hit.pathTemplate, /userId|users/);
  // Prefer semantic AST name when merged
  assert.ok(
    hit.pathTemplate.includes('{{userId}}') || hit.pathTemplate.includes('{userId}'),
    hit.pathTemplate,
  );
});

test('GraphQL ops stay distinct', () => {
  const cache = { pageUrlsFor: () => new Set() };
  const findings = mergeFindings({
    networkCalls: [
      {
        method: 'POST',
        url: 'https://app.test/graphql',
        postData: JSON.stringify({ operationName: 'GetUser', query: 'query GetUser { x }' }),
        graphql: { operationName: 'GetUser', operationType: 'query', hasQuery: true },
      },
      {
        method: 'POST',
        url: 'https://app.test/graphql',
        postData: JSON.stringify({ operationName: 'CreateUser', query: 'mutation CreateUser { x }' }),
        graphql: { operationName: 'CreateUser', operationType: 'mutation', hasQuery: true },
      },
    ],
    staticFindings: [],
    websockets: new Set(),
    sseUrls: new Set(),
    baseUrl,
    cache,
    log,
  });
  const gql = findings.filter((f) => f.graphql);
  assert.equal(gql.length, 2);
});
