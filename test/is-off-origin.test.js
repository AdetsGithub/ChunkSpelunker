import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOffOrigin, hasOutboundRedirectTarget } from '../src/browser/crawler.js';

test('isOffOrigin detects cross-origin URLs', () => {
  const origin = 'https://juice-shop.herokuapp.com';
  assert.equal(isOffOrigin('https://juice-shop.herokuapp.com/#/login', origin), false);
  assert.equal(isOffOrigin('https://juice-shop.herokuapp.com/api/Products', origin), false);
  assert.equal(isOffOrigin('https://github.com/juice-shop/juice-shop', origin), true);
  assert.equal(isOffOrigin('https://www.google.com/', origin), true);
});

test('hasOutboundRedirectTarget catches same-origin open redirects', () => {
  const origin = 'https://juice-shop.herokuapp.com';
  assert.equal(
    hasOutboundRedirectTarget(
      'https://juice-shop.herokuapp.com/redirect?to=https://github.com/juice-shop/juice-shop',
      origin,
    ),
    true,
  );
  assert.equal(
    hasOutboundRedirectTarget('https://juice-shop.herokuapp.com/#/score-board', origin),
    false,
  );
  assert.equal(
    hasOutboundRedirectTarget('https://juice-shop.herokuapp.com/api/Products', origin),
    false,
  );
});
