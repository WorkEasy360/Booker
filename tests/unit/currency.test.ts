// Run with: npm run test:unit (Node's built-in test runner; Node 22.6+ strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, currencySymbol, SUPPORTED_CURRENCIES } from '../../src/lib/currency.ts';

const nbsp = (s: string) => s.replace(/\u00A0/g, ' ');

test('INR uses Indian digit grouping and the rupee sign', () => {
  assert.equal(formatMoney(1234567.5, 'INR'), '₹12,34,567.50');
  assert.equal(formatMoney(999, 'INR'), '₹999.00');
  assert.equal(formatMoney(100000, 'inr'), '₹1,00,000.00');
});

test('existing currencies keep their formats', () => {
  assert.equal(formatMoney(1234567.5, 'USD'), '$1,234,567.50');
  assert.equal(formatMoney(1234567.5, 'GBP'), '£1,234,567.50');
  assert.equal(formatMoney(1234567.5, 'EUR'), '€1,234,567.50');
  assert.equal(formatMoney(12, 'CAD'), '$12.00');
  assert.equal(formatMoney(12, 'AUD'), '$12.00');
  assert.equal(formatMoney(0, 'USD'), '$0.00');
});

test('invalid currency codes fall back instead of throwing', () => {
  assert.equal(nbsp(formatMoney(12, 'ZZ')), 'ZZ 12.00');
  assert.equal(nbsp(formatMoney(12, '')), '? 12.00');
});

test('symbols', () => {
  assert.equal(currencySymbol('INR'), '₹');
  assert.equal(currencySymbol('GBP'), '£');
  assert.equal(currencySymbol('USD'), '$');
});

test('supported list matches the server', () => {
  assert.deepEqual(SUPPORTED_CURRENCIES.map(c => c.code), ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD']);
});
