// Run with: npm run test:unit. Regression tests for the public booking staff choice and the time-zone options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityStaffId, ANY_STAFF } from '../../src/features/public-booking/staffChoice.ts';
import { TIMEZONES, timeZoneOptions } from '../../src/lib/timezones.ts';

test('"Any available staff" never sends an empty staff id', () => {
  // The reported bug: a service whose staff list was empty (or still loading) produced staffId "" and the server
  // answered "serviceId, staffId, from and to are required".
  assert.equal(availabilityStaffId(undefined, []), ANY_STAFF);
  assert.equal(availabilityStaffId(undefined, [{ id: 'staff-a' }, { id: 'staff-b' }]), ANY_STAFF);
  assert.equal(availabilityStaffId(undefined, [{ id: 'staff-a' }]), 'staff-a');
  assert.equal(availabilityStaffId({ id: 'staff-b' }, [{ id: 'staff-a' }, { id: 'staff-b' }]), 'staff-b');
});

test('time-zone options cover any business, keep the saved zone and use current names', () => {
  const values = timeZoneOptions('America/Argentina/Buenos_Aires').map(o => o.value);
  for (const tz of TIMEZONES) assert.ok(values.includes(tz), `${tz} missing`);
  assert.ok(values.includes('Asia/Kolkata'));
  assert.ok(!values.includes('Asia/Calcutta'), 'legacy name listed');
  assert.ok(values.includes('America/Argentina/Buenos_Aires'));
  assert.ok(values.includes('Africa/Nairobi') && values.includes('America/Sao_Paulo'), 'zones outside the common list are missing');
  assert.deepEqual(values, [...values].sort());
  assert.equal(new Set(values).size, values.length);
  // A saved zone the browser does not list is still shown, so saving other settings cannot silently change it.
  assert.ok(timeZoneOptions('Etc/GMT-14').some(o => o.value === 'Etc/GMT-14'));
});
