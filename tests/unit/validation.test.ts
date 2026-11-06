// Run with: npm run test:unit. The web app's email and phone checks (immediate feedback in the forms); the API applies
// the same rules (server/src/tests/validation.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailError, phoneError, PHONE_PLACEHOLDER } from '../../src/lib/validation.ts';

test('the phone placeholder is an Indian example and is itself valid', () => {
  assert.equal(PHONE_PLACEHOLDER, '+91 98765 43210');
  assert.equal(phoneError(PHONE_PLACEHOLDER), '');
});

test('valid phone numbers: Indian with or without +91, and other countries with their code', () => {
  for (const v of ['9876543210', '+91 98765 43210', '+919876543210', '+44 20 7946 0958', '+1 212 555 0123', '  98765 43210 ']) {
    assert.equal(phoneError(v), '', v);
  }
});

test('invalid phone numbers: letters, too short, too long, fictional, lists', () => {
  for (const v of ['12', 'abc', '12345678901234567890', '98765 4321O', '+1 (555) 000-0000', 'call me', '+91 98765 43210, +91 98765 43211']) {
    assert.notEqual(phoneError(v), '', v);
  }
  assert.match(phoneError('abc'), /digits, spaces, dashes or brackets/);
  assert.match(phoneError('12'), /valid phone number/);
});

test('empty values are left to the form (required or optional)', () => {
  assert.equal(phoneError(''), '');
  assert.equal(phoneError('   '), '');
  assert.equal(emailError(''), '');
});

test('emails: "notanemail" and other malformed addresses are refused, real ones are kept', () => {
  for (const v of ['notanemail', 'name@', '@example.com', 'name@example', 'two words@example.com']) assert.notEqual(emailError(v), '', v);
  for (const v of ['jane@example.com', 'first.last+tag@sub.example.co.in', ' Jane@Example.COM ']) assert.equal(emailError(v), '', v);
});
