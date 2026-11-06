// A customer's bookings are counted from the appointments themselves. The stored customers.total_bookings and
// last_booking_date were only ever increased when a booking was made: deleting a booking or moving it to another
// customer never lowered them, and demo data set them to invented values, so they drifted from the real bookings (the
// Reports "Top Customers" list disagreed with the Dashboard). Those columns are left as they are and no longer read.

const OWN = 'a.customer_id = customers.id AND a.organization_id = customers.organization_id';

/** Every booking of the customer, any status (as the Dashboard's "Total Bookings" and the customer page count them). */
export const CUSTOMER_BOOKING_COUNT = `(SELECT COUNT(*) FROM appointments a WHERE ${OWN})`;
/** The date of the customer's latest appointment. */
export const CUSTOMER_LAST_BOOKING = `(SELECT MAX(a.date) FROM appointments a WHERE ${OWN})`;
/** For SELECT … FROM customers: every column plus booking_count and last_booking. */
export const CUSTOMER_COLUMNS = `customers.*, ${CUSTOMER_BOOKING_COUNT} AS booking_count, ${CUSTOMER_LAST_BOOKING} AS last_booking`;
