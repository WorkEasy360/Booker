// Run with: npm run test:unit. "Add to calendar" links carry the booking's real time in UTC, whatever the visitor's own
// time zone, including across daylight saving changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedTimeToUtc, googleCalendarUrl, outlookCalendarUrl } from '../../src/lib/calendarLinks.ts';

test('wall-clock time in the business time zone becomes the right instant', () => {
  assert.equal(new Date(zonedTimeToUtc('2026-11-03', '09:00', 'Asia/Kolkata')).toISOString(), '2026-11-03T03:30:00.000Z');
  assert.equal(new Date(zonedTimeToUtc('2026-07-01', '09:00', 'Europe/London')).toISOString(), '2026-07-01T08:00:00.000Z'); // BST
  assert.equal(new Date(zonedTimeToUtc('2026-12-01', '09:00', 'Europe/London')).toISOString(), '2026-12-01T09:00:00.000Z'); // GMT
  assert.equal(new Date(zonedTimeToUtc('2026-03-08', '03:30', 'America/New_York')).toISOString(), '2026-03-08T07:30:00.000Z'); // first hour of EDT
});

const event = { title: 'Massage — Glow Spa', details: 'Reference WE-ABC123', location: '12 MG Road, Pune', date: '2026-11-03', start: '09:00', end: '09:30', timeZone: 'Asia/Kolkata' };

test('Google Calendar link: a template with UTC dates, the title, details and location', () => {
  const u = new URL(googleCalendarUrl(event));
  assert.equal(u.origin + u.pathname, 'https://calendar.google.com/calendar/render');
  assert.equal(u.searchParams.get('action'), 'TEMPLATE');
  assert.equal(u.searchParams.get('dates'), '20261103T033000Z/20261103T040000Z');
  assert.equal(u.searchParams.get('text'), 'Massage — Glow Spa');
  assert.equal(u.searchParams.get('location'), '12 MG Road, Pune');
});

test('Outlook link: compose deeplink with ISO start and end; an end after midnight is the next day', () => {
  const u = new URL(outlookCalendarUrl({ ...event, start: '23:30', end: '00:30' }));
  assert.equal(u.searchParams.get('rru'), 'addevent');
  assert.equal(u.searchParams.get('startdt'), '2026-11-03T18:00:00.000Z');
  assert.equal(u.searchParams.get('enddt'), '2026-11-03T19:00:00.000Z');
});
