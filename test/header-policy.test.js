import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHydratedHeader,
  hydrateTokenFromState,
  resolveFetchCredentials,
} from '../src/http/header-policy.js';

test('hydrateTokenFromState finds access_token', () => {
  const state = {
    origins: [
      {
        origin: 'https://app.test',
        localStorage: [{ name: 'access_token', value: 'eyJhbGciOiJ.test.sig' }],
      },
    ],
  };
  const tok = hydrateTokenFromState(state, 'https://app.test');
  assert.equal(tok.key, 'access_token');
  assert.ok(tok.value.startsWith('eyJ'));
});

test('buildHydratedHeader supports custom format', () => {
  const h = buildHydratedHeader('x-api-key: {token}', 'secret123');
  assert.equal(h.name, 'x-api-key');
  assert.equal(h.value, 'secret123');
});

test('resolveFetchCredentials never sends hydrated Bearer to map-origin', () => {
  const hydrated = buildHydratedHeader('Authorization: Bearer {token}', 'app-jwt');
  const same = resolveFetchCredentials({
    destUrl: 'https://app.test/app.js.map',
    targetOrigin: 'https://app.test',
    appHeaders: [],
    mapHeaders: [],
    mapOrigins: [],
    allowExternalMaps: false,
    hydratedHeader: hydrated,
  });
  assert.equal(same.allowed, true);
  assert.equal(same.headers.Authorization, 'Bearer app-jwt');

  const ext = resolveFetchCredentials({
    destUrl: 'https://sentry.io/map',
    targetOrigin: 'https://app.test',
    appHeaders: [{ name: 'Authorization', value: 'Bearer app-jwt' }],
    mapHeaders: [{ name: 'Authorization', value: 'Bearer sentry' }],
    mapOrigins: ['https://sentry.io'],
    allowExternalMaps: true,
    hydratedHeader: hydrated,
  });
  assert.equal(ext.headers.Authorization, 'Bearer sentry');
});
