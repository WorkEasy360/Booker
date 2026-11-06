// Reports (and optionally repairs) one-sided staff↔service links.
// Default is a read-only dry run. Repair strategy: "union" — add the missing side, never remove a link.
//
//   node scripts/reconcile-staff-services.mjs                 # dry run against DB_PATH or ./data/workeasy360.db
//   node scripts/reconcile-staff-services.mjs --apply         # writes; back up the DB file first
//   node scripts/reconcile-staff-services.mjs --db ./data/copy.db --apply
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : (process.env.DB_PATH ?? './data/workeasy360.db');

const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
const services = db.prepare('SELECT id, name, organization_id AS org, staff_ids FROM services').all();
const staff = db.prepare('SELECT id, name, organization_id AS org, is_active, service_ids FROM staff').all();
const svcById = new Map(services.map(s => [s.id, { ...s, ids: JSON.parse(s.staff_ids || '[]') }]));
const staffById = new Map(staff.map(s => [s.id, { ...s, ids: JSON.parse(s.service_ids || '[]') }]));

const fixes = [];
for (const st of staffById.values()) {
  for (const sid of st.ids) {
    const svc = svcById.get(sid);
    if (!svc) { fixes.push({ kind: 'dangling', note: `staff ${st.id} (${st.name}) lists missing service ${sid} — left untouched` }); continue; }
    if (svc.org !== st.org) { fixes.push({ kind: 'cross-org', note: `staff ${st.id} lists service ${sid} from another org — left untouched` }); continue; }
    if (!svc.ids.includes(st.id)) fixes.push({ kind: 'add-to-service', staffId: st.id, serviceId: sid, note: `add ${st.name} (${st.id}${st.is_active ? '' : ', inactive'}) to service "${svc.name}" (${sid})` });
  }
}
for (const svc of svcById.values()) {
  for (const tid of svc.ids) {
    const st = staffById.get(tid);
    if (!st) { fixes.push({ kind: 'dangling', note: `service ${svc.id} (${svc.name}) lists missing staff ${tid} — left untouched` }); continue; }
    if (st.org !== svc.org) { fixes.push({ kind: 'cross-org', note: `service ${svc.id} lists staff ${tid} from another org — left untouched` }); continue; }
    if (!st.ids.includes(svc.id)) fixes.push({ kind: 'add-to-staff', staffId: tid, serviceId: svc.id, note: `add service "${svc.name}" (${svc.id}) to ${st.name} (${tid})` });
  }
}

console.log(`${apply ? 'APPLY' : 'DRY RUN'} on ${dbPath}: ${fixes.length} finding(s)`);
for (const f of fixes) console.log(` - [${f.kind}] ${f.note}`);

if (apply) {
  const run = db.transaction(() => {
    for (const f of fixes) {
      if (f.kind === 'add-to-service') {
        const s = svcById.get(f.serviceId); s.ids.push(f.staffId);
        db.prepare('UPDATE services SET staff_ids = ? WHERE id = ?').run(JSON.stringify(s.ids), s.id);
      } else if (f.kind === 'add-to-staff') {
        const t = staffById.get(f.staffId); t.ids.push(f.serviceId);
        db.prepare('UPDATE staff SET service_ids = ? WHERE id = ?').run(JSON.stringify(t.ids), t.id);
      }
    }
  });
  run();
  console.log('Applied.');
}
db.close();
