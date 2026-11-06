// Run with: npm run test:unit. When the appointment page offers Mark Complete and No-show (the API enforces the same
// rule: server/src/tests/appointment-status.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasStarted, canRecordOutcome } from '../../src/features/appointments/appointmentStatus.ts';

const at = (iso: string) => new Date(iso);
const appt = { date: '2026-10-24', startTime: '10:00', timezone: 'Asia/Kolkata', status: 'scheduled' };

test('started: from the start time on, in the appointment\'s own time zone', () => {
  assert.equal(hasStarted(appt, at('2026-10-24T04:29:59Z')), false); // 09:59 in India
  assert.equal(hasStarted(appt, at('2026-10-24T04:30:00Z')), true);  // 10:00 in India
  assert.equal(hasStarted({ ...appt, timezone: 'America/New_York' }, at('2026-10-24T04:30:00Z')), false); // 00:30 in New York
  assert.equal(hasStarted({ ...appt, date: '2026-10-23' }, at('2026-10-24T04:00:00Z')), true);
});

test('outcomes: only for scheduled or confirmed appointments that have started', () => {
  const later = at('2026-10-24T06:00:00Z');
  assert.equal(canRecordOutcome(appt, later), true);
  assert.equal(canRecordOutcome({ ...appt, status: 'confirmed' }, later), true);
  for (const status of ['completed', 'cancelled', 'no_show']) assert.equal(canRecordOutcome({ ...appt, status }, later), false, status);
  assert.equal(canRecordOutcome(appt, at('2026-10-24T04:00:00Z')), false); // future
});

test('a missing or unknown time zone falls back to India time instead of failing', () => {
  assert.equal(hasStarted({ ...appt, timezone: null }, at('2026-10-24T04:30:00Z')), true);
  assert.equal(hasStarted({ ...appt, timezone: 'Not/AZone' }, at('2026-10-24T04:30:00Z')), true);
});
