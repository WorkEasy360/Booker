// Run with: npm run test:unit. What the sign-in page says after a WorkEasy360 sign-in that did not complete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workeasy360ErrorMessage, workeasy360StartUrl } from '../../src/lib/workeasy360.ts';

test('every code the server sends has its own message, and an unknown one a neutral message', () => {
  const codes = ['expired', 'unavailable', 'rate_limited', 'cancelled', 'refused', 'invalid_token', 'wrong_product', 'no_organization',
    'email_unverified', 'wrong_organization', 'not_entitled', 'membership_inactive', 'organization_inactive', 'integration_suspended',
    'access_policy_denied', 'access_unverified', 'account_conflict', 'other_organization', 'identity_conflict', 'account_disabled',
    'no_business', 'business_unavailable', 'session_ended'];
  const messages = new Set(codes.map(c => workeasy360ErrorMessage(c)));
  assert.equal(messages.size, codes.length);
  assert.equal(workeasy360ErrorMessage('<script>'), workeasy360ErrorMessage('refused'));
  assert.equal(workeasy360ErrorMessage(null), null);
});

test('a denial says why, with the reason the server passed on', () => {
  assert.match(workeasy360ErrorMessage('not_entitled', 'expired')!, /subscription has ended/);
  assert.match(workeasy360ErrorMessage('not_entitled', 'no_seat')!, /seat/);
  assert.equal(workeasy360ErrorMessage('not_entitled', 'made-up'), workeasy360ErrorMessage('not_entitled'));
});

test('the start address only carries a page of this app to return to', () => {
  const start = '/api/auth/workeasy360/start';
  assert.equal(workeasy360StartUrl(start, '/appointments'), `${start}?returnTo=%2Fappointments`);
  for (const bad of ['//evil.example', 'https://evil.example', '/api/auth/me', '/x?y=1', null, undefined]) {
    assert.equal(workeasy360StartUrl(start, bad), start);
  }
});
