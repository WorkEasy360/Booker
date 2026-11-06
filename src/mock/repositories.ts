import type { Appointment, Customer, AppointmentStatus, Service, Staff, Workspace, Resource } from '@/types';
import {
  mockAppointments, mockCustomers, mockStaff, mockServices,
  mockWorkspaces, mockResources, mockBookingPages, mockNotificationTemplates, mockIntegrations,
} from './data';
import { generateId, generateBookingRef } from '@/lib/utils';

// ─── localStorage persistence helpers ────────────────────────────────────────

const LS_APTS      = 'we360_appointments';
const LS_CUSTS     = 'we360_customers';
const LS_SERVICES  = 'we360_services';

function loadLS<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function saveLS<T>(key: string, items: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // quota exceeded or private-mode — silently ignore
  }
}

// ─── In-memory mutable state (seeded from localStorage + mock) ───────────────

const storedApts  = loadLS<Appointment>(LS_APTS);
const storedCusts = loadLS<Customer>(LS_CUSTS);
const storedSvcs  = loadLS<Service>(LS_SERVICES);

const mockAptIds  = new Set(mockAppointments.map(a => a.id));
const mockCustIds = new Set(mockCustomers.map(c => c.id));
const mockSvcIds  = new Set(mockServices.map(s => s.id));

// Known test artifacts to exclude from the stored (localStorage) data
const TEST_BOOKING_REFS = new Set(['WE-XUKIS7LS']);
const TEST_CUSTOMER_NAMES = new Set(['QA Customer']);
const TEST_SERVICE_NAMES = new Set(['QA Test Service']);

let appointments: Appointment[] = [
  ...storedApts.filter(a => !mockAptIds.has(a.id) && !TEST_BOOKING_REFS.has(a.bookingRef)),
  ...mockAppointments,
];
let customers: Customer[] = [
  ...storedCusts.filter(c => !mockCustIds.has(c.id) && !TEST_CUSTOMER_NAMES.has(c.name)),
  ...mockCustomers,
];
let services: Service[] = [
  ...storedSvcs.filter(s => !mockSvcIds.has(s.id) && !TEST_SERVICE_NAMES.has(s.name)),
  ...mockServices,
];
// In-memory only for staff / workspaces / resources (no cross-refresh needed)
let staff      = [...mockStaff];
let workspaces = [...mockWorkspaces];
let resources  = [...mockResources];

// ─── Appointments ─────────────────────────────────────────────────────────────

export const appointmentRepo = {
  getAll: () => [...appointments],

  getById: (id: string) => appointments.find(a => a.id === id),

  getByDate: (date: string) => appointments.filter(a => a.date === date),

  getByStatus: (status: AppointmentStatus) => appointments.filter(a => a.status === status),

  getByStaff: (staffId: string) => appointments.filter(a => a.staffId === staffId),

  getByCustomer: (customerId: string) => appointments.filter(a => a.customerId === customerId),

  getUpcoming: () => {
    const today = new Date().toISOString().split('T')[0];
    return appointments.filter(
      a => a.date >= today && (a.status === 'scheduled' || a.status === 'confirmed'),
    );
  },

  create: (data: Omit<Appointment, 'id' | 'bookingRef' | 'createdAt' | 'updatedAt'>): Appointment => {
    const now = new Date().toISOString();
    const apt: Appointment = {
      ...data,
      id: `apt-${generateId()}`,
      bookingRef: generateBookingRef(),
      createdAt: now,
      updatedAt: now,
    };
    appointments = [apt, ...appointments];
    saveLS(LS_APTS, appointments.filter(a => !mockAptIds.has(a.id)));
    return apt;
  },

  update: (id: string, data: Partial<Appointment>): Appointment | null => {
    const idx = appointments.findIndex(a => a.id === id);
    if (idx === -1) return null;
    appointments[idx] = { ...appointments[idx], ...data, updatedAt: new Date().toISOString() };
    saveLS(LS_APTS, appointments.filter(a => !mockAptIds.has(a.id)));
    return appointments[idx];
  },

  cancel:   (id: string) => appointmentRepo.update(id, { status: 'cancelled' }),
  complete: (id: string) => appointmentRepo.update(id, { status: 'completed' }),
};

// ─── Customers ────────────────────────────────────────────────────────────────

export const customerRepo = {
  getAll: () => [...customers],

  getById: (id: string) => customers.find(c => c.id === id),

  search: (q: string) => {
    const lower = q.toLowerCase();
    return customers.filter(
      c =>
        c.name.toLowerCase().includes(lower) ||
        c.email.toLowerCase().includes(lower) ||
        (c.phone && c.phone.includes(lower)),
    );
  },

  create: (data: Omit<Customer, 'id' | 'organizationId' | 'totalBookings' | 'createdAt'>): Customer => {
    const c: Customer = {
      ...data,
      id: `cust-${generateId()}`,
      organizationId: 'org-1',
      totalBookings: 0,
      createdAt: new Date().toISOString(),
    };
    customers = [...customers, c];
    saveLS(LS_CUSTS, customers.filter(c => !mockCustIds.has(c.id)));
    return c;
  },

  update: (id: string, data: Partial<Customer>): Customer | null => {
    const idx = customers.findIndex(c => c.id === id);
    if (idx === -1) return null;
    customers[idx] = { ...customers[idx], ...data };
    saveLS(LS_CUSTS, customers.filter(c => !mockCustIds.has(c.id)));
    return customers[idx];
  },
};

// ─── Services ─────────────────────────────────────────────────────────────────

export const serviceRepo = {
  getAll:         () => [...services],
  getById:        (id: string) => services.find(s => s.id === id),
  getByWorkspace: (wsId: string) => services.filter(s => s.workspaceIds.includes(wsId)),

  create: (data: Omit<Service, 'id' | 'createdAt'>): Service => {
    const svc: Service = {
      ...data,
      id: `svc-${generateId()}`,
      createdAt: new Date().toISOString(),
    };
    services = [svc, ...services];
    saveLS(LS_SERVICES, services.filter(s => !mockSvcIds.has(s.id)));
    return svc;
  },

  update: (id: string, data: Partial<Service>): Service | null => {
    const idx = services.findIndex(s => s.id === id);
    if (idx === -1) return null;
    services[idx] = { ...services[idx], ...data };
    saveLS(LS_SERVICES, services.filter(s => !mockSvcIds.has(s.id)));
    return services[idx];
  },
};

// ─── Staff ────────────────────────────────────────────────────────────────────

export const staffRepo = {
  getAll:          () => [...staff],
  getById:         (id: string) => staff.find(s => s.id === id),
  getByWorkspace:  (wsId: string) => staff.filter(s => s.workspaceIds.includes(wsId)),
  getByService:    (svcId: string) => staff.filter(s => s.serviceIds.includes(svcId)),

  create: (data: Omit<Staff, 'id' | 'createdAt'>): Staff => {
    const member: Staff = {
      ...data,
      id: `staff-${generateId()}`,
      createdAt: new Date().toISOString(),
    };
    staff = [member, ...staff];
    return member;
  },

  update: (id: string, data: Partial<Staff>): Staff | null => {
    const idx = staff.findIndex(s => s.id === id);
    if (idx === -1) return null;
    staff[idx] = { ...staff[idx], ...data };
    return staff[idx];
  },
};

// ─── Workspaces ───────────────────────────────────────────────────────────────

export const workspaceRepo = {
  getAll:  () => [...workspaces],
  getById: (id: string) => workspaces.find(w => w.id === id),

  create: (data: Omit<Workspace, 'id' | 'createdAt'>): Workspace => {
    const ws: Workspace = {
      ...data,
      id: `ws-${generateId()}`,
      createdAt: new Date().toISOString(),
    };
    workspaces = [ws, ...workspaces];
    return ws;
  },

  update: (id: string, data: Partial<Workspace>): Workspace | null => {
    const idx = workspaces.findIndex(w => w.id === id);
    if (idx === -1) return null;
    workspaces[idx] = { ...workspaces[idx], ...data };
    return workspaces[idx];
  },
};

// ─── Resources ────────────────────────────────────────────────────────────────

export const resourceRepo = {
  getAll:  () => [...resources],
  getById: (id: string) => resources.find(r => r.id === id),

  create: (data: Omit<Resource, 'id' | 'createdAt'>): Resource => {
    const res: Resource = {
      ...data,
      id: `res-${generateId()}`,
      createdAt: new Date().toISOString(),
    };
    resources = [res, ...resources];
    return res;
  },

  update: (id: string, data: Partial<Resource>): Resource | null => {
    const idx = resources.findIndex(r => r.id === id);
    if (idx === -1) return null;
    resources[idx] = { ...resources[idx], ...data };
    return resources[idx];
  },
};

// ─── Booking Pages ────────────────────────────────────────────────────────────

export const bookingPageRepo = {
  getAll:  () => mockBookingPages,
  getById: (id: string) => mockBookingPages.find(bp => bp.id === id),
};

// ─── Notifications ────────────────────────────────────────────────────────────

export const notificationRepo = {
  getAll:  () => mockNotificationTemplates,
  getById: (id: string) => mockNotificationTemplates.find(n => n.id === id),
};

// ─── Integrations ─────────────────────────────────────────────────────────────

export const integrationRepo = {
  getAll:      () => mockIntegrations,
  getById:     (id: string) => mockIntegrations.find(i => i.id === id),
  getByType:   (type: string) => mockIntegrations.filter(i => i.type === type),
};

// ─── Mock availability slots ──────────────────────────────────────────────────

const ALL_SLOTS = [
  '08:00','08:30','09:00','09:30','10:00','10:30','11:00','11:30',
  '12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30',
];

export function getMockAvailableSlots(date: string, staffId?: string) {
  const booked = appointments
    .filter(a => a.date === date && (staffId ? a.staffId === staffId : true) && a.status !== 'cancelled')
    .map(a => a.startTime);

  const seed = date.split('-').reduce((n, s) => n + parseInt(s, 10), 0);
  return ALL_SLOTS.map((time, i) => ({
    time,
    available: !booked.includes(time) && ((seed + i) % 5 !== 0),
  }));
}

// ─── Dashboard stats ──────────────────────────────────────────────────────────

export function getDashboardStats() {
  const today = new Date().toISOString().split('T')[0];
  const todayApts    = appointments.filter(a => a.date === today);
  const upcoming     = appointments.filter(a => a.date > today && (a.status === 'scheduled' || a.status === 'confirmed'));
  const completed    = appointments.filter(a => a.status === 'completed');
  const denominator  = appointments.filter(a => !['scheduled','confirmed'].includes(a.status)).length;

  return {
    todayAppointments:   todayApts.length,
    upcomingAppointments: upcoming.length,
    totalBookings:        appointments.length,
    cancelledToday:       todayApts.filter(a => a.status === 'cancelled').length,
    newCustomers:         customers.filter(c => c.totalBookings <= 1).length,
    completionRate:       denominator > 0 ? Math.round((completed.length / denominator) * 100) : 0,
  };
}
