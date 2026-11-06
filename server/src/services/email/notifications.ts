import db from '../../db/init';
import { registerAppointmentEventHook, registerWorkerTask } from './notify';
import { processNotificationJobs, recoverInterruptedJobs } from '../notifications/worker';

// Reminders and staff alerts used to have their own queue (notification_queue, migration 014). They are now jobs of the
// notification platform (services/notifications, migration 017), planned from every appointment change. This module
// only wires the platform into the email worker's loop and recovers rows the old queue may still hold; the old rows
// stay readable in each appointment's delivery history.

/** At startup: anything cut off mid-send (old queue or new jobs) has an unknown outcome and is not resent on its own. */
export function recoverInterruptedNotifications(): number {
  const old = db.prepare(
    `UPDATE notification_queue SET status = 'unknown', last_error = 'The server stopped while sending; not resent automatically',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status = 'sending'`
  ).run().changes;
  // Old pending rows will not be processed any more: the same messages are planned as jobs now.
  db.prepare(`UPDATE notification_queue SET status = 'skipped', last_error = 'Superseded by the notification platform' WHERE status = 'pending'`).run();
  return old + recoverInterruptedJobs();
}

// Staff alerts are planned from the appointment history now, not from customer email events.
registerAppointmentEventHook(null);
registerWorkerTask(async now => { await processNotificationJobs(now); });
