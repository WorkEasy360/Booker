// Demo business matching the product artwork: "Acme Wellness Clinic", owner Manoj Kumar, Dr. Priya and Dr. Rahul,
// 12 appointments today, 28 upcoming, 36 completed and 4 cancelled this week, 124 customers.
//
//   npm run seed && npm run demo        (from server/)
//
// It turns the default demo business (org-1, the one admin@workeasy360.com signs in to) into the artwork's clinic.
// Both demo sign-ins open it:
//   admin@workeasy360.com      / Admin123!   (or ADMIN_EMAIL / ADMIN_PASSWORD)
//   manoj@acmeclinic.example   / Acme@2026   (or DEMO_PASSWORD)
// Sign-ins and their sessions are kept. While the API runs in development the demo's appointment dates move forward
// with the calendar (services/demo-roll.ts), so "today" always shows the artwork's records.
import 'dotenv/config';
import './refuse-in-production';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import db from './init';
import { DEMO_STATE_TABLE } from '../services/demo-roll';

const ORG = 'org-1';
const OLD_DEMO_ORG = 'org-acme'; // an earlier version created a second business; it is merged into org-1
const OWNERS = [
  { id: null as string | null, email: (process.env.ADMIN_EMAIL ?? 'admin@workeasy360.com').toLowerCase(), password: process.env.ADMIN_PASSWORD ?? 'Admin123!' },
  { id: 'acme-owner', email: 'manoj@acmeclinic.example', password: process.env.DEMO_PASSWORD ?? 'Acme@2026' },
];
const OWNER_NAME = 'Manoj Kumar';
const TZ = 'Asia/Kolkata';
const LOCATION = '2nd floor, 14 MG Road, Pune';
/** Tables whose rows are sign-in state: kept, so whoever is signed in stays signed in. */
const KEEP_TABLES = new Set(['users', 'user_sessions']);

const HOURS = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    .map(d => [d, { enabled: d !== 'sunday', start: '09:00', end: '20:00' }]),
);

const SERVICES = [
  { id: 'acme-svc-consult', name: 'Consultation', duration: 30 },
  { id: 'acme-svc-therapy', name: 'Therapy Session', duration: 60 },
  { id: 'acme-svc-followup', name: 'Follow-up', duration: 30 },
] as const;
type ServiceId = typeof SERVICES[number]['id'];
const STAFF = [
  { id: 'acme-staff-priya', name: 'Dr. Priya', email: 'priya@acmeclinic.example', color: '#B45309' },
  { id: 'acme-staff-rahul', name: 'Dr. Rahul', email: 'rahul@acmeclinic.example', color: '#0F766E' },
] as const;
const [PRIYA, RAHUL] = [STAFF[0].id, STAFF[1].id];
const [CONSULT, THERAPY, FOLLOWUP] = [SERVICES[0].id, SERVICES[1].id, SERVICES[2].id];

const FIRST = ['Aarav', 'Ishita', 'Kabir', 'Meera', 'Rohit', 'Sneha', 'Aditya', 'Pooja', 'Karan', 'Divya', 'Nikhil', 'Riya', 'Siddharth', 'Kavya', 'Varun', 'Ananya', 'Rahul', 'Tanvi', 'Yash', 'Shreya'];
const LAST = ['Sharma', 'Verma', 'Iyer', 'Nair', 'Gupta', 'Joshi', 'Reddy', 'Patel', 'Mehta', 'Kulkarni', 'Bose', 'Chopra'];

const dateIn = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const plusDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function orgTables(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map(t => t.name)
    .filter(name => name !== 'organizations' && (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).some(c => c.name === 'organization_id'));
}

function run() {
  const today = dateIn(new Date());
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const weekStart = plusDays(today, -weekday);

  for (const o of OWNERS) {
    const other = db.prepare('SELECT organization_id FROM users WHERE email = ?').get(o.email) as { organization_id: string } | undefined;
    if (other && other.organization_id !== ORG && other.organization_id !== OLD_DEMO_ORG) throw new Error(`${o.email} already belongs to another business`);
  }
  const slugOwner = db.prepare("SELECT organization_id FROM booking_pages WHERE slug = 'acmeclinic'").get() as { organization_id: string } | undefined;
  if (slugOwner && slugOwner.organization_id !== ORG && slugOwner.organization_id !== OLD_DEMO_ORG) {
    throw new Error('The booking address "acmeclinic" is already used by another business');
  }

  const tables = orgTables();
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      // The earlier separate demo business: its owner moves to org-1, everything else goes.
      db.prepare('UPDATE users SET organization_id = ? WHERE organization_id = ? AND email = ?').run(ORG, OLD_DEMO_ORG, OWNERS[1].email);
      db.prepare('UPDATE user_sessions SET organization_id = ? WHERE organization_id = ?').run(ORG, OLD_DEMO_ORG);
      for (const table of tables) db.prepare(`DELETE FROM ${table} WHERE organization_id = ?`).run(OLD_DEMO_ORG);
      db.prepare('DELETE FROM organizations WHERE id = ?').run(OLD_DEMO_ORG);

      // org-1's business data is rebuilt; sign-ins and sessions stay.
      for (const table of tables) if (!KEEP_TABLES.has(table)) db.prepare(`DELETE FROM ${table} WHERE organization_id = ?`).run(ORG);
      const orgValues = ['Acme Wellness Clinic', 'hello@acmeclinic.example', '+91 98000 11000', TZ, JSON.stringify(HOURS),
        JSON.stringify({ customerChangeCutoffHours: 24 }), LOCATION] as const;
      if (db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(ORG)) {
        db.prepare(
          `UPDATE organizations SET name = ?, email = ?, phone = ?, website = NULL, address = NULL, city = NULL, timezone = ?, country = 'IN',
             currency = 'INR', date_format = 'DD/MM/YYYY', time_format = '12h', logo = NULL, working_hours = ?, booking_rules = ?,
             cancellation_policy = '', appointment_location = ? WHERE id = ?`
        ).run(...orgValues, ORG);
      } else {
        db.prepare(
          `INSERT INTO organizations (name, email, phone, timezone, working_hours, booking_rules, appointment_location, id, country, currency, date_format, time_format)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'IN', 'INR', 'DD/MM/YYYY', '12h')`
        ).run(...orgValues, ORG);
      }

      // Both demo sign-ins are the owner, Manoj Kumar.
      for (const o of OWNERS) {
        const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(o.email) as { id: string } | undefined;
        if (existing) {
          db.prepare("UPDATE users SET name = ?, role = 'admin', organization_id = ?, is_active = 1 WHERE id = ?").run(OWNER_NAME, ORG, existing.id);
        } else {
          db.prepare(`INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, 'admin')`)
            .run(o.id ?? `user-${nanoid(8)}`, ORG, o.email, bcrypt.hashSync(o.password, 12), OWNER_NAME);
        }
      }

      const allServices = SERVICES.map(s => s.id);
      for (const s of STAFF) {
        db.prepare(
          `INSERT INTO staff (id, organization_id, name, email, phone, role, title, bio, color, is_active, workspace_ids, service_ids, working_hours)
           VALUES (?, ?, ?, ?, NULL, 'staff', '', '', ?, 1, '[]', ?, ?)`
        ).run(s.id, ORG, s.name, s.email, s.color, JSON.stringify(allServices), JSON.stringify(HOURS));
      }
      for (const s of SERVICES) {
        db.prepare(
          `INSERT INTO services (id, organization_id, name, description, category, duration, price, currency, location, is_active,
             buffer_before, buffer_after, min_notice, max_advance, color, workspace_ids, staff_ids, resource_ids, custom_fields)
           VALUES (?, ?, ?, '', 'consultation', ?, 0, 'INR', '', 1, 0, 0, 0, 60, '#16A34A', '[]', ?, '[]', '[]')`
        ).run(s.id, ORG, s.name, s.duration, JSON.stringify(STAFF.map(x => x.id)));
      }
      db.prepare(
        `INSERT INTO booking_pages (id, organization_id, type, title, slug, is_published, is_default, service_ids, theme, form_fields)
         VALUES ('acme-page', ?, 'business', 'Acme Wellness Clinic', 'acmeclinic', 1, 1, ?, '{}', '[]')`
      ).run(ORG, JSON.stringify(allServices));

      // ── Customers: the five from the artwork, then enough to make 124 ──
      const insertCustomer = db.prepare(`INSERT INTO customers (id, organization_id, name, email, phone, tags, total_bookings) VALUES (?, ?, ?, ?, ?, '[]', 0)`);
      const named: Array<[string, string | null, string | null]> = [
        ['Rohan Mehta', '+91 98765 43210', null], ['Anita Sharma', '+91 98123 45678', null], ['Vikram Desai', null, 'vikram@email.com'],
        ['Neha Kapoor', '+91 98234 56789', null], ['Arjun Rao', '+91 98760 12345', null],
      ];
      const customers: string[] = [];
      named.forEach(([name, phone, email], i) => { const id = `acme-cust-${i + 1}`; insertCustomer.run(id, ORG, name, email ?? '', phone); customers.push(id); });
      for (let i = customers.length; i < 124; i++) {
        const name = `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`;
        const id = `acme-cust-${i + 1}`;
        insertCustomer.run(id, ORG, name, '', `+91 9${String(8100000000 + i * 7919).slice(1, 5)} ${String(10000 + i * 37).slice(-5)}`);
        customers.push(id);
      }

      // ── Appointments ──
      const insertAppt = db.prepare(
        `INSERT INTO appointments (id, booking_ref, organization_id, service_id, staff_id, customer_id, resource_ids, status, date,
           start_time, end_time, duration, timezone, price, currency, location, notes, internal_notes, customer_answers)
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, 0, 'INR', ?, '', '', '[]')`
      );
      const duration = (s: ServiceId) => SERVICES.find(x => x.id === s)!.duration;
      const add = (date: string, start: string, service: ServiceId, staff: string, customer: string, status: string) => {
        const end = hhmm(toMin(start) + duration(service));
        insertAppt.run(`acme-apt-${nanoid(8)}`, `AC-${nanoid(8).toUpperCase()}`, ORG, service, staff, customer, status, date, start, end, duration(service), TZ, LOCATION);
      };
      // Next free time per date and provider, so no provider is ever double-booked.
      const nextFree = new Map<string, number>();
      const place = (date: string, service: ServiceId, staff: string, customer: string, status: string) => {
        const key = `${date}|${staff}`;
        const start = nextFree.get(key) ?? toMin('09:00');
        add(date, hhmm(start), service, staff, customer, status);
        nextFree.set(key, start + duration(service) + 30);
      };
      let c = 5;
      const nextCustomer = () => customers[(c++ % (customers.length - 5)) + 5];

      // Today: the five rows of the artwork first, then seven later in the day (12 in all).
      add(today, '09:00', CONSULT, PRIYA, customers[0], 'scheduled');
      add(today, '10:00', THERAPY, RAHUL, customers[1], 'scheduled');
      add(today, '11:30', FOLLOWUP, PRIYA, customers[2], 'scheduled');
      add(today, '14:00', CONSULT, RAHUL, customers[3], 'completed');
      add(today, '15:00', THERAPY, PRIYA, customers[4], 'scheduled');
      ['16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30'].forEach((t, i) =>
        add(today, t, i % 2 ? FOLLOWUP : CONSULT, i % 2 ? PRIYA : RAHUL, nextCustomer(), 'scheduled'));

      // Upcoming: 28 over the next nine days.
      for (let i = 0; i < 28; i++) place(plusDays(today, 1 + (i % 9)), [CONSULT, THERAPY, FOLLOWUP][i % 3], i % 2 ? RAHUL : PRIYA, nextCustomer(), 'scheduled');

      // This week before today: 35 completed (36 with today's) and 4 cancelled.
      const earlier = Array.from({ length: weekday }, (_, i) => plusDays(weekStart, i));
      if (earlier.length) {
        for (let i = 0; i < 35; i++) place(earlier[i % earlier.length], i % 3 === 1 ? THERAPY : CONSULT, i % 2 ? RAHUL : PRIYA, nextCustomer(), 'completed');
        for (let i = 0; i < 4; i++) add(earlier[i % earlier.length], '19:30', FOLLOWUP, PRIYA, nextCustomer(), 'cancelled');
      }

      // Same day last week: 10, so today's 12 shows +20%.
      for (let i = 0; i < 10; i++) place(plusDays(today, -7), CONSULT, i % 2 ? RAHUL : PRIYA, nextCustomer(), 'completed');

      // Dates of this demo move forward with the calendar while the API runs in development.
      db.exec(`CREATE TABLE IF NOT EXISTS ${DEMO_STATE_TABLE} (organization_id TEXT PRIMARY KEY, anchor_date TEXT NOT NULL)`);
      db.prepare(`INSERT INTO ${DEMO_STATE_TABLE} (organization_id, anchor_date) VALUES (?, ?)
                  ON CONFLICT(organization_id) DO UPDATE SET anchor_date = excluded.anchor_date`).run(ORG, today);
      db.prepare(`DELETE FROM ${DEMO_STATE_TABLE} WHERE organization_id = ?`).run(OLD_DEMO_ORG);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  console.log('✔ Demo business "Acme Wellness Clinic" is ready (owner Manoj Kumar).');
  for (const o of OWNERS) console.log(`  Sign in as ${o.email}${o.email === 'admin@workeasy360.com' && !process.env.ADMIN_PASSWORD ? ' / Admin123!' : o.id ? ` / ${o.password}` : ''}`);
  if (weekday === 0) console.log('  (Today is Monday, so "completed this week" only counts today.)');
}

run();
