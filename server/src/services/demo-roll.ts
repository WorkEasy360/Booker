// Development only: the demo business (server/src/db/demo-clinic.ts) keeps showing a live-looking day. Its appointment
// dates were written relative to the day the demo was created; each day after that, every one of its appointments moves
// forward by the same number of days, so "today" always has the artwork's records. Only businesses listed in the
// demo_state table (created by the demo script) are touched, and never in production or tests.
import db from '../db/init';

export const DEMO_STATE_TABLE = 'demo_state';

const todayIn = (timeZone: string) => {
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
const shiftDate = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Moves each demo business forward to today. Returns how many appointments moved. */
export function rollDemoDates(): number {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(DEMO_STATE_TABLE)) return 0;
  const demos = db.prepare(
    `SELECT d.organization_id, d.anchor_date, o.timezone FROM ${DEMO_STATE_TABLE} d JOIN organizations o ON o.id = d.organization_id`
  ).all() as Array<{ organization_id: string; anchor_date: string; timezone: string | null }>;
  let moved = 0;
  for (const demo of demos) {
    const today = todayIn(demo.timezone || 'Asia/Kolkata');
    const days = daysBetween(demo.anchor_date, today);
    if (days <= 0) continue;
    db.transaction(() => {
      // Latest first, so a moved appointment never lands on one that has not moved yet (the overlap guard stays happy).
      const rows = db.prepare('SELECT id, date FROM appointments WHERE organization_id = ? ORDER BY date DESC, start_time DESC')
        .all(demo.organization_id) as Array<{ id: string; date: string }>;
      const update = db.prepare('UPDATE appointments SET date = ? WHERE id = ?');
      for (const r of rows) update.run(shiftDate(r.date, days), r.id);
      db.prepare(`UPDATE ${DEMO_STATE_TABLE} SET anchor_date = ? WHERE organization_id = ?`).run(today, demo.organization_id);
      moved += rows.length;
    })();
  }
  return moved;
}

/** Runs now and then every hour (development only). */
export function startDemoRolling(): void {
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test') return;
  const run = () => {
    try {
      const moved = rollDemoDates();
      if (moved) console.log(`[demo] moved ${moved} demo appointments forward to today`);
    } catch (e) {
      console.warn('[demo] could not move demo appointments:', (e as Error).message);
    }
  };
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}
