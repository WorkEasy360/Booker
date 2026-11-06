// Run with: npm run test:unit. How appointment history entries read on the appointment page: what happened, the
// before → after detail, and who did it (including removed users and staff, whose entries still read correctly).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeActor, describeEntry, type HistoryEntryView } from '../../src/features/appointments/appointmentHistory.ts';

const f = { date: (d: string) => `<${d}>`, time: (t: string) => `[${t}]` };
const base: HistoryEntryView = {
  action: 'created', fromStatus: null, toStatus: null, fromDate: null, fromStartTime: null, toDate: null, toStartTime: null,
  fromStaff: null, toStaff: null, actor: { type: 'user', name: 'Asha', source: 'dashboard' },
};
const entry = (over: Partial<HistoryEntryView>): HistoryEntryView => ({ ...base, ...over });

test('creation shows the booked time, staff and starting status', () => {
  assert.deepEqual(describeEntry(entry({ toStatus: 'scheduled', toDate: '2026-11-02', toStartTime: '10:00', toStaff: { id: 's1', name: 'Bilal' } }), f),
    { title: 'Booked', detail: '<2026-11-02>, [10:00] with Bilal · Scheduled' });
});

test('status changes are named by what they mean', () => {
  const titles = [
    ['scheduled', 'completed', 'Marked completed'],
    ['confirmed', 'no_show', 'Marked as a no-show'],
    ['scheduled', 'cancelled', 'Cancelled'],
    ['cancelled', 'scheduled', 'Restored'],
    ['scheduled', 'confirmed', 'Confirmed'],
    ['confirmed', 'scheduled', 'Status set to Scheduled'],
    ['completed', 'no_show', 'Marked as a no-show'],
  ];
  for (const [from, to, title] of titles) {
    const d = describeEntry(entry({ action: 'status_changed', fromStatus: from, toStatus: to }), f);
    assert.equal(d.title, title, `${from} → ${to}`);
  }
  assert.equal(describeEntry(entry({ action: 'status_changed', fromStatus: 'no_show', toStatus: 'completed' }), f).detail, 'No-show → Completed');
});

test('moves and staff changes show before and after; a removed staff member is still named as such', () => {
  assert.deepEqual(describeEntry(entry({ action: 'rescheduled', fromDate: '2026-11-02', fromStartTime: '10:00', toDate: '2026-11-03', toStartTime: '11:30' }), f),
    { title: 'Rescheduled', detail: '<2026-11-02>, [10:00] → <2026-11-03>, [11:30]' });
  assert.deepEqual(describeEntry(entry({ action: 'reassigned', fromStaff: { id: 's1', name: null }, toStaff: { id: 's2', name: 'Bilal' } }), f),
    { title: 'Staff changed', detail: 'a removed staff member → Bilal' });
  assert.equal(describeEntry(entry({ action: 'deleted', fromStatus: 'cancelled', fromDate: '2026-11-02', fromStartTime: '10:00' }), f).detail,
    'Was Cancelled, <2026-11-02>, [10:00]');
});

test('who did it: the user by name (or a removed user), through the assistant, or the customer and where', () => {
  assert.equal(describeActor({ type: 'user', name: 'Asha', source: 'dashboard' }), 'Asha');
  assert.equal(describeActor({ type: 'user', name: 'Asha', source: 'assistant' }), 'Asha, through the assistant');
  assert.equal(describeActor({ type: 'user', name: null, source: 'dashboard' }), 'A removed user');
  assert.equal(describeActor({ type: 'customer', name: null, source: 'booking_page' }), 'The customer, on the booking page');
  assert.equal(describeActor({ type: 'customer', name: null, source: 'manage_link' }), 'The customer, with their booking link');
});
