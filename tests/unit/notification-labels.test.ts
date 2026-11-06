// Run with: npm run test:unit. The delivery history never claims more than happened: "Sent" is the provider accepting a
// message, "Delivered"/"Read" only come from the provider's report, calendar sync only when the calendar API accepted
// it, and the development stand-in is always named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobStatusLabel, connectionLabel, canRetry, offsetLabel, isMockProvider } from '../../src/features/notifications/notificationLabels.ts';

test('sent is not delivered; the stand-in is always named', () => {
  assert.equal(jobStatusLabel({ status: 'sent', channel: 'sms', provider: 'twilio' }).label, 'Sent (accepted by provider)');
  assert.equal(jobStatusLabel({ status: 'sent', channel: 'sms', provider: 'mock' }).label, 'Sent (accepted by provider) (development stand-in)');
  assert.equal(jobStatusLabel({ status: 'delivered', channel: 'whatsapp', provider: 'whatsapp_cloud' }).label, 'Delivered');
  assert.equal(jobStatusLabel({ status: 'sent', channel: 'email', provider: 'smtp' }).label, 'Sent');
  for (const status of ['pending', 'sending', 'failed', 'skipped', 'cancelled', 'unknown', 'not_configured'] as const) {
    assert.doesNotMatch(jobStatusLabel({ status, channel: 'sms', provider: null }).label, /Sent|Delivered|Read|Synced/);
  }
});

test('a calendar event is "synced" only when the calendar accepted it; a cancellation says removed', () => {
  assert.equal(jobStatusLabel({ status: 'sent', channel: 'google_calendar', provider: 'mock-google', event: 'confirmed' }).label, 'Synced to calendar (development stand-in)');
  assert.equal(jobStatusLabel({ status: 'sent', channel: 'outlook_calendar', provider: 'outlook', event: 'cancelled' }).label, 'Removed from calendar');
  assert.equal(jobStatusLabel({ status: 'not_configured', channel: 'google_calendar', provider: null }).label, 'Not set up');
});

test('a future reminder is "scheduled"; a due one is waiting', () => {
  const now = Date.parse('2026-11-01T10:00:00Z');
  assert.equal(jobStatusLabel({ status: 'pending', channel: 'email', provider: null, scheduledFor: '2026-11-02T10:00:00Z' }, now).label, 'Scheduled');
  assert.equal(jobStatusLabel({ status: 'pending', channel: 'email', provider: null, scheduledFor: '2026-11-01T09:00:00Z' }, now).label, 'Waiting to send');
});

test('only failed, unknown and not-set-up messages can be retried', () => {
  assert.deepEqual((['pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped', 'cancelled', 'unknown', 'not_configured'] as const).filter(canRetry), ['failed', 'unknown', 'not_configured']);
});

test('a connection is "connected" only when verified, and the stand-in says so', () => {
  assert.equal(connectionLabel({ status: 'configured_unverified', mock: false }).label, 'Saved, not verified');
  assert.equal(connectionLabel({ status: 'connected', mock: true }).label, 'Connected (development stand-in)');
  assert.equal(connectionLabel({ status: 'error', mock: false }).tone, 'danger');
  assert.equal(isMockProvider('mock-outlook'), true);
  assert.equal(isMockProvider('twilio'), false);
});

test('reminder times read naturally', () => {
  assert.deepEqual([1440, 2880, 60, 120, 30].map(offsetLabel), ['1 day before', '2 days before', '1 hour before', '2 hours before', '30 minutes before']);
});
