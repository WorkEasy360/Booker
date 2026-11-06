// Which staff id the public booking wizard asks the server about. No imports, so the Node unit tests can load it.

/** The server picks whichever assigned staff member is free. */
export const ANY_STAFF = 'any';

/**
 * A named provider, the only provider, or "any". Never empty: an empty staff id made the availability request fail
 * with "serviceId, staffId, from and to are required" when a service's staff list was empty or still loading.
 */
export function availabilityStaffId(selected: { id: string } | undefined, serviceStaff: Array<{ id: string }>): string {
  if (selected) return selected.id;
  if (serviceStaff.length === 1) return serviceStaff[0].id;
  return ANY_STAFF;
}
