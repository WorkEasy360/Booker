// ─── Core domain types for WorkEasy360 ───────────────────────────────────────

// Must match the backend enum in server/src/routes/appointments.ts
export type AppointmentStatus = 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export type UserRole = 'owner' | 'admin' | 'staff' | 'viewer';
export type ServiceCategory = 'consultation' | 'class' | 'workshop' | 'session' | 'tour' | 'rental' | 'other';
export type ResourceType = 'room' | 'equipment' | 'vehicle' | 'table' | 'other';
export type IntegrationStatus = 'connected' | 'disconnected' | 'pending' | 'error';
export type NotificationChannel = 'email' | 'sms' | 'both';
export type NotificationTrigger = 'confirmation' | 'reminder' | 'cancellation' | 'reschedule' | 'followup';
export type BookingPageLayout = 'classic' | 'modern' | 'minimal';

export interface Organization {
  id: string;
  name: string;
  email: string;
  phone: string;
  website?: string;
  logo?: string;
  address: string;
  city: string;
  country: string;
  timezone: string;
  currency: string;
  dateFormat: string;
  timeFormat: '12h' | '24h';
  workingHours: WorkingHours;
  createdAt: string;
}

export interface WorkingHours {
  [day: string]: DaySchedule;
}

export interface DaySchedule {
  enabled: boolean;
  start: string;
  end: string;
  breaks?: TimeSlot[];
}

export interface TimeSlot {
  start: string;
  end: string;
}

export interface Workspace {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  logo?: string;
  color: string;
  timezone: string;
  address?: string;
  phone?: string;
  email?: string;
  isActive: boolean;
  serviceIds: string[];
  staffIds: string[];
  workingHours: WorkingHours;
  bookingPageId?: string;
  createdAt: string;
}

export interface Staff {
  id: string;
  organizationId: string;
  workspaceIds: string[];
  name: string;
  email: string;
  phone?: string;
  avatar?: string;
  role: UserRole;
  title?: string;
  bio?: string;
  serviceIds: string[];
  workingHours: WorkingHours;
  isActive: boolean;
  bookingPageUrl?: string;
  color: string;
  createdAt: string;
}

export interface Service {
  id: string;
  organizationId: string;
  workspaceIds: string[];
  name: string;
  description: string;
  category: ServiceCategory;
  duration: number;
  price: number;
  currency: string;
  location: string;
  staffIds: string[];
  resourceIds: string[];
  isActive: boolean;
  bufferBefore: number;
  bufferAfter: number;
  minNotice: number;
  maxAdvance: number;
  cancellationPolicy: string;
  reschedulingPolicy: string;
  color: string;
  bookingPageUrl?: string;
  customFields: CustomField[];
  createdAt: string;
}

export interface Resource {
  id: string;
  organizationId: string;
  workspaceIds: string[];
  name: string;
  type: ResourceType;
  description: string;
  capacity: number;
  isActive: boolean;
  serviceIds: string[];
  availabilityRules: WorkingHours;
  createdAt: string;
}

export interface Customer {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  phone?: string;
  timezone?: string;
  notes?: string;
  tags: string[];
  totalBookings: number;
  lastBookingDate?: string;
  createdAt: string;
}

export interface Appointment {
  id: string;
  bookingRef: string;
  organizationId: string;
  workspaceId?: string;
  serviceId: string;
  staffId: string;
  customerId: string;
  resourceIds: string[];
  status: AppointmentStatus;
  date: string;
  startTime: string;
  endTime: string;
  duration: number;
  timezone: string;
  price: number;
  currency: string;
  location: string;
  notes?: string;
  internalNotes?: string;
  customerAnswers: CustomerAnswer[];
  createdAt: string;
  updatedAt: string;
}

export interface CustomerAnswer {
  questionId: string;
  question: string;
  answer: string;
}

export interface CustomField {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'checkbox' | 'phone' | 'email';
  required: boolean;
  options?: string[];
  placeholder?: string;
}

export interface BookingPage {
  id: string;
  organizationId: string;
  workspaceId?: string;
  serviceId?: string;
  staffId?: string;
  type: 'business' | 'workspace' | 'service' | 'staff';
  title: string;
  description: string;
  slug: string;
  isPublished: boolean;
  theme: {
    layout: BookingPageLayout;
    primaryColor: string;
    backgroundColor: string;
    fontFamily: string;
    buttonText: string;
    headerText?: string;
    footerText?: string;
    showLogo: boolean;
    showStaffPhoto: boolean;
  };
  formFields: CustomField[];
  serviceIds: string[];
  createdAt: string;
}

export interface NotificationTemplate {
  id: string;
  organizationId: string;
  trigger: NotificationTrigger;
  channel: NotificationChannel;
  name: string;
  subject: string;
  body: string;
  isEnabled: boolean;
  recipientType: 'customer' | 'staff' | 'both';
  timing?: number;
  createdAt: string;
}

export interface Integration {
  id: string;
  organizationId: string;
  provider: string;
  type: 'calendar' | 'video' | 'email' | 'sms' | 'payment' | 'automation';
  status: IntegrationStatus;
  label: string;
  description: string;
  icon: string;
  config?: Record<string, string>;
  connectedAt?: string;
  connectedBy?: string;
}

export interface AvailabilitySlot {
  time: string;
  available: boolean;
  staffId?: string;
}

export interface BookingWizardState {
  step: number;
  selectedService?: Service;
  selectedStaff?: Staff;
  selectedDate?: string;
  selectedSlot?: string;
  customerInfo?: {
    name: string;
    email: string;
    phone: string;
    [key: string]: string;
  };
  answers: Record<string, string>;
  bookingRef?: string;
}

export interface DashboardStats {
  todayAppointments: number;
  upcomingAppointments: number;
  totalBookings: number;
  cancelledToday: number;
  newCustomers: number;
  completionRate: number;
}

export interface ChartDataPoint {
  label: string;
  value: number;
  secondaryValue?: number;
}
