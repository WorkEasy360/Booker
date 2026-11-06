// Run with: npm run test:unit. Regional defaults (India) and the business's date format for default date display.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { format, parseISO } from 'date-fns';
import { DEFAULT_TIMEZONE, DEFAULT_CURRENCY, DEFAULT_DATE_FORMAT, setDateDisplayFormat, dateDisplayPattern } from '../../src/lib/regional.ts';

// formatDate in src/lib/utils.ts is format(parseISO(date), pattern ?? dateDisplayPattern()); utils.ts itself uses
// extensionless imports that only the bundler resolves, so the same expression is applied here.
const formatDate = (d: string, fmt?: string) => { try { return format(parseISO(d), fmt ?? dateDisplayPattern()); } catch { return d; } };

test('the deployment defaults are Indian', () => {
  assert.equal(DEFAULT_TIMEZONE, 'Asia/Kolkata');
  assert.equal(DEFAULT_CURRENCY, 'INR');
  assert.equal(DEFAULT_DATE_FORMAT, 'DD/MM/YYYY');
});

test('dates show in the business format, DD/MM/YYYY until the business chooses another', () => {
  assert.equal(formatDate('2026-10-24'), '24/10/2026');
  setDateDisplayFormat('MM/DD/YYYY');
  assert.equal(formatDate('2026-10-24'), '10/24/2026');
  setDateDisplayFormat('YYYY-MM-DD');
  assert.equal(formatDate('2026-10-24'), '2026-10-24');
  setDateDisplayFormat('not-a-format'); // ignored: the last valid choice stays
  assert.equal(formatDate('2026-10-24'), '2026-10-24');
  setDateDisplayFormat(DEFAULT_DATE_FORMAT);
});

test('an explicit pattern still wins, and an unreadable date is shown as it is', () => {
  assert.equal(formatDate('2026-10-24', 'MMM d, yyyy'), 'Oct 24, 2026');
  assert.equal(formatDate('soon'), 'soon');
});
