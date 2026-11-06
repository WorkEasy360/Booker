// Run with: npm run test:unit. The Dashboard's "Today" and "Upcoming" lists never show the same appointment (or the
// same customer for the same booking) twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todaysAppointments, upcomingAppointments } from '../../src/features/dashboard/dashboardLists.ts';

const today = '2026-10-24';
const apts = [
  { id: 'later-today', date: today, startTime: '15:00', status: 'scheduled', customerName: 'Asha' },
  { id: 'earlier-today', date: today, startTime: '09:00', status: 'confirmed', customerName: 'Ravi' },
  { id: 'tomorrow', date: '2026-10-25', startTime: '10:00', status: 'scheduled', customerName: 'Asha' },
  { id: 'next-week', date: '2026-10-31', startTime: '08:00', status: 'confirmed', customerName: 'Meera' },
  { id: 'cancelled', date: '2026-10-26', startTime: '10:00', status: 'cancelled', customerName: 'Kiran' },
  { id: 'yesterday', date: '2026-10-23', startTime: '10:00', status: 'completed', customerName: 'Dev' },
];

test('today and upcoming are disjoint, and each booking appears once', () => {
  const t = todaysAppointments(apts, today).map(a => a.id);
  const u = upcomingAppointments(apts, today).map(a => a.id);
  assert.deepEqual(t, ['earlier-today', 'later-today']);
  assert.deepEqual(u, ['tomorrow', 'next-week']);
  assert.equal(t.filter(id => u.includes(id)).length, 0);
});

test('upcoming leaves out cancelled and past appointments', () => {
  const u = upcomingAppointments(apts, today).map(a => a.id);
  assert.ok(!u.includes('cancelled'));
  assert.ok(!u.includes('yesterday'));
});

test('with no appointments both lists are empty', () => {
  assert.deepEqual(todaysAppointments([], today), []);
  assert.deepEqual(upcomingAppointments([], today), []);
});
