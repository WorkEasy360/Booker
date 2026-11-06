import 'dotenv/config';
import './refuse-in-production';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import db from './init';

const DEFAULT_HOURS = {
  monday:    { enabled: true,  start: '09:00', end: '17:00' },
  tuesday:   { enabled: true,  start: '09:00', end: '17:00' },
  wednesday: { enabled: true,  start: '09:00', end: '17:00' },
  thursday:  { enabled: true,  start: '09:00', end: '17:00' },
  friday:    { enabled: true,  start: '09:00', end: '17:00' },
  saturday:  { enabled: false, start: '10:00', end: '14:00' },
  sunday:    { enabled: false, start: '10:00', end: '14:00' },
};

function run() {
  // ── Organization ────────────────────────────────────────────────────────────
  const orgExists = db.prepare('SELECT id FROM organizations WHERE id = ?').get('org-1');
  if (!orgExists) {
    db.prepare(`
      INSERT INTO organizations (id, name, email, phone, website, address, city, timezone, currency, date_format, time_format, working_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'org-1', 'Apex Wellness Group', 'hello@apexwellness.com',
      '+91 98765 22400', 'https://apexwellness.com',
      '100 Park Ave, Suite 800', 'New York',
      'America/New_York', 'USD', 'MM/DD/YYYY', '12h',
      JSON.stringify(DEFAULT_HOURS)
    );
    console.log('✔ Organization seeded');
  }

  // ── Admin user ──────────────────────────────────────────────────────────────
  const adminEmail = (process.env.ADMIN_EMAIL ?? 'admin@workeasy360.com').toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'Admin123!';
  const userExists = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (!userExists) {
    const hash = bcrypt.hashSync(adminPassword, 12);
    db.prepare(`
      INSERT INTO users (id, organization_id, email, password_hash, name, role)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`user-${nanoid(8)}`, 'org-1', adminEmail, hash, 'Admin', 'admin');
    console.log(`✔ Admin user created: ${adminEmail}`);
  }

  // ── Workspaces ──────────────────────────────────────────────────────────────
  const workspaces = [
    {
      id: 'ws-1', name: 'Downtown Clinic',
      description: 'Our flagship location in Midtown Manhattan',
      color: '#00BF62', address: '100 Park Ave, Suite 800, New York, NY 10017',
      phone: '+91 98765 22401', email: 'downtown@apexwellness.com',
      serviceIds: ['svc-1', 'svc-2', 'svc-3', 'svc-4'],
      staffIds: ['staff-1', 'staff-2', 'staff-3'],
      workingHours: DEFAULT_HOURS,
    },
    {
      id: 'ws-2', name: 'Brooklyn Branch',
      description: 'Serving Brooklyn and surrounding areas',
      color: '#3B82F6', address: '450 Court St, Brooklyn, NY 11231',
      phone: '+91 98765 22402', email: 'brooklyn@apexwellness.com',
      serviceIds: ['svc-1', 'svc-2', 'svc-5'],
      staffIds: ['staff-4', 'staff-5'],
      workingHours: { ...DEFAULT_HOURS, saturday: { enabled: true, start: '10:00', end: '15:00' } },
    },
    {
      id: 'ws-3', name: 'Virtual Consultations',
      description: 'Online appointments via video call',
      color: '#8B5CF6', address: null, phone: null, email: null,
      serviceIds: ['svc-3', 'svc-6'],
      staffIds: ['staff-1', 'staff-3', 'staff-4'],
      workingHours: DEFAULT_HOURS,
    },
  ];

  for (const ws of workspaces) {
    if (!db.prepare('SELECT id FROM workspaces WHERE id = ?').get(ws.id)) {
      db.prepare(`
        INSERT INTO workspaces (id, organization_id, name, description, color, timezone,
          address, phone, email, is_active, service_ids, staff_ids, working_hours)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ws.id, 'org-1', ws.name, ws.description, ws.color,
        'America/New_York', ws.address ?? null, ws.phone ?? null, ws.email ?? null, 1,
        JSON.stringify(ws.serviceIds), JSON.stringify(ws.staffIds),
        JSON.stringify(ws.workingHours)
      );
    }
  }
  console.log('✔ Workspaces seeded');

  // ── Staff ───────────────────────────────────────────────────────────────────
  const staffList = [
    {
      id: 'staff-1', name: 'Dr. Sarah Mitchell', email: 'sarah@apexwellness.com',
      phone: '+91 98765 20011', role: 'admin', title: 'Lead Therapist & Founder',
      bio: 'Board-certified therapist with 15 years of experience in holistic wellness.',
      color: '#00BF62', isActive: true,
      workspaceIds: ['ws-1', 'ws-3'], serviceIds: ['svc-1', 'svc-2', 'svc-3'],
      workingHours: DEFAULT_HOURS,
    },
    {
      id: 'staff-2', name: 'James Chen', email: 'james@apexwellness.com',
      phone: '+91 98765 20012', role: 'staff', title: 'Senior Wellness Coach',
      bio: 'Certified wellness coach specializing in nutrition and fitness programs.',
      color: '#3B82F6', isActive: true,
      workspaceIds: ['ws-1'], serviceIds: ['svc-2', 'svc-4'],
      workingHours: { ...DEFAULT_HOURS, saturday: { enabled: true, start: '09:00', end: '13:00' } },
    },
    {
      id: 'staff-3', name: 'Priya Sharma', email: 'priya@apexwellness.com',
      phone: '+91 98765 20013', role: 'staff', title: 'Physiotherapist',
      bio: 'Licensed physiotherapist with specialization in sports injuries.',
      color: '#F59E0B', isActive: true,
      workspaceIds: ['ws-1', 'ws-3'], serviceIds: ['svc-1', 'svc-3', 'svc-6'],
      workingHours: {
        monday: { enabled: true, start: '10:00', end: '18:00' },
        tuesday: { enabled: true, start: '10:00', end: '18:00' },
        wednesday: { enabled: false, start: '09:00', end: '17:00' },
        thursday: { enabled: true, start: '10:00', end: '18:00' },
        friday: { enabled: true, start: '10:00', end: '18:00' },
        saturday: { enabled: false, start: '10:00', end: '14:00' },
        sunday: { enabled: false, start: '10:00', end: '14:00' },
      },
    },
    {
      id: 'staff-4', name: 'Marcus Williams', email: 'marcus@apexwellness.com',
      phone: '+91 98765 20014', role: 'admin', title: 'Branch Manager & Therapist',
      bio: 'Managing the Brooklyn branch while providing therapeutic services.',
      color: '#EF4444', isActive: true,
      workspaceIds: ['ws-2', 'ws-3'], serviceIds: ['svc-1', 'svc-2', 'svc-5'],
      workingHours: DEFAULT_HOURS,
    },
    {
      id: 'staff-5', name: 'Elena Rodriguez', email: 'elena@apexwellness.com',
      phone: '+91 98765 20015', role: 'staff', title: 'Massage Therapist',
      bio: 'Certified massage therapist specializing in deep tissue and Swedish massage.',
      color: '#8B5CF6', isActive: false,
      workspaceIds: ['ws-2'], serviceIds: ['svc-2', 'svc-5'],
      workingHours: { ...DEFAULT_HOURS, monday: { enabled: false, start: '09:00', end: '17:00' }, sunday: { enabled: true, start: '11:00', end: '16:00' } },
    },
  ];

  for (const s of staffList) {
    if (!db.prepare('SELECT id FROM staff WHERE id = ?').get(s.id)) {
      db.prepare(`
        INSERT INTO staff (id, organization_id, name, email, phone, role, title, bio, color,
          is_active, workspace_ids, service_ids, working_hours)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        s.id, 'org-1', s.name, s.email, s.phone, s.role, s.title, s.bio, s.color,
        s.isActive ? 1 : 0,
        JSON.stringify(s.workspaceIds), JSON.stringify(s.serviceIds),
        JSON.stringify(s.workingHours)
      );
    }
  }
  console.log('✔ Staff seeded');

  // ── Services ─────────────────────────────────────────────────────────────────
  const services = [
    {
      id: 'svc-1', name: 'Initial Consultation', category: 'consultation',
      description: 'A comprehensive first-time assessment to understand your wellness goals.',
      duration: 60, price: 120, currency: 'USD', location: 'In-person',
      bufferBefore: 10, bufferAfter: 10, minNotice: 24, maxAdvance: 60,
      color: '#00BF62', workspaceIds: ['ws-1', 'ws-2'],
      staffIds: ['staff-1', 'staff-3', 'staff-4'], resourceIds: ['res-1'],
    },
    {
      id: 'svc-2', name: 'Wellness Coaching Session', category: 'consultation',
      description: 'One-on-one coaching session focused on nutrition, lifestyle, and fitness.',
      duration: 45, price: 85, currency: 'USD', location: 'In-person',
      bufferBefore: 5, bufferAfter: 5, minNotice: 12, maxAdvance: 90,
      color: '#3B82F6', workspaceIds: ['ws-1', 'ws-2'],
      staffIds: ['staff-1', 'staff-2', 'staff-4'], resourceIds: ['res-1'],
    },
    {
      id: 'svc-3', name: 'Physiotherapy Treatment', category: 'session',
      description: 'Targeted physiotherapy for pain management and injury rehabilitation.',
      duration: 90, price: 150, currency: 'USD', location: 'In-person',
      bufferBefore: 15, bufferAfter: 15, minNotice: 24, maxAdvance: 30,
      color: '#F59E0B', workspaceIds: ['ws-1', 'ws-3'],
      staffIds: ['staff-1', 'staff-3'], resourceIds: ['res-2'],
    },
    {
      id: 'svc-4', name: 'Group Fitness Class', category: 'class',
      description: 'High-energy group fitness session for up to 10 participants.',
      duration: 60, price: 35, currency: 'USD', location: 'In-person',
      bufferBefore: 15, bufferAfter: 15, minNotice: 4, maxAdvance: 14,
      color: '#EF4444', workspaceIds: ['ws-1'],
      staffIds: ['staff-2'], resourceIds: ['res-3'],
    },
    {
      id: 'svc-5', name: 'Deep Tissue Massage', category: 'session',
      description: 'Therapeutic deep tissue massage targeting chronic muscle tension.',
      duration: 60, price: 110, currency: 'USD', location: 'In-person',
      bufferBefore: 10, bufferAfter: 10, minNotice: 12, maxAdvance: 60,
      color: '#8B5CF6', workspaceIds: ['ws-2'],
      staffIds: ['staff-4', 'staff-5'], resourceIds: ['res-4'],
    },
    {
      id: 'svc-6', name: 'Virtual Wellness Check-in', category: 'consultation',
      description: 'Remote video consultation for progress reviews and wellness advice.',
      duration: 30, price: 60, currency: 'USD', location: 'Virtual',
      bufferBefore: 5, bufferAfter: 5, minNotice: 2, maxAdvance: 30,
      color: '#10B981', workspaceIds: ['ws-3'],
      staffIds: ['staff-1', 'staff-3', 'staff-4'], resourceIds: [],
    },
  ];

  for (const svc of services) {
    if (!db.prepare('SELECT id FROM services WHERE id = ?').get(svc.id)) {
      db.prepare(`
        INSERT INTO services (id, organization_id, name, description, category, duration, price, currency,
          location, is_active, buffer_before, buffer_after, min_notice, max_advance,
          color, workspace_ids, staff_ids, resource_ids, custom_fields)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        svc.id, 'org-1', svc.name, svc.description, svc.category,
        svc.duration, svc.price, svc.currency, svc.location, 1,
        svc.bufferBefore, svc.bufferAfter, svc.minNotice, svc.maxAdvance,
        svc.color, JSON.stringify(svc.workspaceIds), JSON.stringify(svc.staffIds),
        JSON.stringify(svc.resourceIds), '[]'
      );
    }
  }
  console.log('✔ Services seeded');

  // ── Resources ────────────────────────────────────────────────────────────────
  const resources = [
    { id: 'res-1', name: 'Consultation Room A', type: 'room', description: 'Private consultation room on the 8th floor.', capacity: 2, workspaceIds: ['ws-1'] },
    { id: 'res-2', name: 'Physio Suite', type: 'room', description: 'Fully equipped physiotherapy treatment suite.', capacity: 1, workspaceIds: ['ws-1'] },
    { id: 'res-3', name: 'Group Studio', type: 'room', description: 'Large open studio for group classes (max 15).', capacity: 15, workspaceIds: ['ws-1'] },
    { id: 'res-4', name: 'Massage Room 1', type: 'room', description: 'Dedicated massage therapy room.', capacity: 1, workspaceIds: ['ws-2'] },
  ];

  for (const r of resources) {
    if (!db.prepare('SELECT id FROM resources WHERE id = ?').get(r.id)) {
      db.prepare(`
        INSERT INTO resources (id, organization_id, name, type, description, capacity, is_active, workspace_ids, service_ids, availability_rules)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(r.id, 'org-1', r.name, r.type, r.description, r.capacity, 1, JSON.stringify(r.workspaceIds), '[]', '{}');
    }
  }
  console.log('✔ Resources seeded');

  // ── Sample customers ──────────────────────────────────────────────────────────
  const customers = [
    { id: 'cust-1', name: 'Alex Johnson', email: 'alex.johnson@email.com', phone: '+91 98765 30011', totalBookings: 8 },
    { id: 'cust-2', name: 'Maria Garcia', email: 'maria.garcia@email.com', phone: '+91 98765 30012', totalBookings: 5 },
    { id: 'cust-3', name: 'David Kim',    email: 'david.kim@email.com',    phone: '+91 98765 30013', totalBookings: 3 },
    { id: 'cust-4', name: 'Sarah Lee',    email: 'sarah.lee@email.com',    phone: '+91 98765 30014', totalBookings: 12 },
    { id: 'cust-5', name: 'Michael Brown', email: 'michael.brown@email.com', phone: '+91 98765 30015', totalBookings: 2 },
  ];

  for (const c of customers) {
    if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(c.id)) {
      db.prepare(`
        INSERT INTO customers (id, organization_id, name, email, phone, tags, total_bookings)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(c.id, 'org-1', c.name, c.email, c.phone, '[]', c.totalBookings);
    }
  }
  console.log('✔ Customers seeded');

  // ── Booking pages ─────────────────────────────────────────────────────────────
  const pages = [
    { id: 'bp-1', title: 'Apex Wellness – Downtown', slug: 'downtown', type: 'business', workspaceId: 'ws-1', serviceIds: ['svc-1','svc-2','svc-3','svc-4'], isPublished: true },
    { id: 'bp-2', title: 'Apex Wellness – Brooklyn', slug: 'brooklyn',  type: 'business', workspaceId: 'ws-2', serviceIds: ['svc-1','svc-2','svc-5'], isPublished: true },
    { id: 'bp-3', title: 'Virtual Appointments',     slug: 'virtual',   type: 'business', workspaceId: 'ws-3', serviceIds: ['svc-3','svc-6'], isPublished: false },
  ];

  for (const p of pages) {
    if (!db.prepare('SELECT id FROM booking_pages WHERE id = ?').get(p.id)) {
      db.prepare(`
        INSERT INTO booking_pages (id, organization_id, workspace_id, type, title, slug, is_published, service_ids, theme, form_fields)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(p.id, 'org-1', p.workspaceId, p.type, p.title, p.slug, p.isPublished ? 1 : 0, JSON.stringify(p.serviceIds), '{}', '[]');
    }
  }
  console.log('✔ Booking pages seeded');

  // ── Sample appointments ───────────────────────────────────────────────────────
  const today = new Date().toISOString().split('T')[0];
  const apptExists = db.prepare('SELECT id FROM appointments LIMIT 1').get();
  if (!apptExists) {
    const appts = [
      { id: 'appt-1', ref: 'WE-SEED0001', serviceId: 'svc-1', staffId: 'staff-1', customerId: 'cust-1', date: today, start: '09:00', end: '10:00', duration: 60, status: 'scheduled' },
      { id: 'appt-2', ref: 'WE-SEED0002', serviceId: 'svc-2', staffId: 'staff-2', customerId: 'cust-2', date: today, start: '10:00', end: '10:45', duration: 45, status: 'confirmed' },
      { id: 'appt-3', ref: 'WE-SEED0003', serviceId: 'svc-3', staffId: 'staff-3', customerId: 'cust-3', date: today, start: '11:00', end: '12:30', duration: 90, status: 'scheduled' },
    ];
    for (const a of appts) {
      db.prepare(`
        INSERT INTO appointments (id, booking_ref, organization_id, service_id, staff_id, customer_id,
          resource_ids, status, date, start_time, end_time, duration, timezone, price, currency, location,
          notes, internal_notes, customer_answers)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        a.id, a.ref, 'org-1', a.serviceId, a.staffId, a.customerId,
        '[]', a.status, a.date, a.start, a.end, a.duration,
        'America/New_York', 120, 'USD', 'In-person', '', '', '[]'
      );
    }
    console.log('✔ Sample appointments seeded');
  }

  console.log('\n✅ Seed complete');
}

run();
