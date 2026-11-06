// Run with: npm run test:unit. The Dashboard and the Reports page count the same days as the server's report windows
// (server/src/tests/counts-reports.test.ts checks the server with the same dates): N calendar days, today included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDaysISO, windowBounds, dayLabel } from '../../src/lib/reportWindow.ts';

test('a window of N days ends today and has exactly N days', () => {
  assert.deepEqual(windowBounds('2026-10-25', 7), { from: '2026-10-19', to: '2026-10-25' });   // = server "7d"
  assert.deepEqual(windowBounds('2026-10-25', 30), { from: '2026-09-26', to: '2026-10-25' });  // = server "30d"
  assert.deepEqual(windowBounds('2026-10-25', 365), { from: '2025-10-26', to: '2026-10-25' }); // = server "1y"
  assert.deepEqual(windowBounds('2026-10-25', 1), { from: '2026-10-25', to: '2026-10-25' });
  for (const n of [1, 7, 14, 30, 91, 365]) {
    const { from, to } = windowBounds('2026-03-31', n);
    assert.equal((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1, n, `${n} days`);
  }
});

test('day arithmetic crosses months, years and daylight-saving dates without drifting', () => {
  assert.equal(addDaysISO('2026-03-01', -1), '2026-02-28');
  assert.equal(addDaysISO('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysISO('2026-03-29', 1), '2026-03-30'); // Europe moves the clocks that night
  assert.equal(addDaysISO('2026-11-01', -1), '2026-10-31'); // and the US on this one
});

test('a date is shown as that date in any browser time zone', () => {
  assert.equal(dayLabel('2026-10-25', 'en-IN', { month: 'short', day: 'numeric' }), '25 Oct');
  assert.equal(dayLabel('2026-01-01', 'en-US', { month: 'long', day: 'numeric', year: 'numeric' }), 'January 1, 2026');
});
