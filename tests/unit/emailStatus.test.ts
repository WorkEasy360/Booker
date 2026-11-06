// Run with: npm run test:unit. The wording must never claim an email was delivered unless the server said "sent".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerEmailMessage, adminEmailNote } from '../../src/lib/emailStatus.ts';

test('only "sent" is described as sent', () => {
  for (const status of ['failed', 'not_configured', 'retrying'] as const) {
    const customer = customerEmailMessage('confirmation', status, 'p•••@example.com');
    assert.equal(customer?.tone, 'warning');
    assert.doesNotMatch(customer!.text, /We sent/);
    assert.equal(adminEmailNote('confirmation', { status })?.ok, false);
  }
  assert.match(customerEmailMessage('confirmation', 'sent', 'p•••@example.com')!.text, /^We sent a confirmation email to p•••@example\.com\.$/);
  assert.equal(adminEmailNote('cancellation', { status: 'sent' })?.ok, true);
});

test('a temporary failure says it will be retried', () => {
  assert.match(customerEmailMessage('reschedule', 'retrying')!.text, /will keep trying/);
  assert.match(adminEmailNote('confirmation', { status: 'retrying', error: 'Try again later' })!.text, /retried automatically/);
  assert.match(adminEmailNote('confirmation', { status: 'retrying', error: 'Try again later' })!.text, /Try again later/);
});

test('no status means nothing is said', () => {
  assert.equal(customerEmailMessage('confirmation', undefined), null);
  assert.equal(adminEmailNote('confirmation', undefined), null);
});
