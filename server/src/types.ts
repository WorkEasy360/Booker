export type AppointmentStatus = 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export type ServiceCategory = 'consultation' | 'class' | 'workshop' | 'session' | 'tour' | 'rental' | 'other';
export type ResourceType = 'room' | 'equipment' | 'vehicle' | 'table' | 'other';
export type StaffRole = 'admin' | 'manager' | 'staff';
export type BookingPageType = 'business' | 'service' | 'staff';

export interface Organization {
  id: string;
  name: string;
  email: string;
  phone?: string;
  website?: string;
  address?: string;
  city?: string;
  country: string;
  timezone: string;
  currency: string;
  dateFormat: string;
  timeFormat: string;
  logo?: string;
  workingHours: Record<string, WorkingHours>;
  bookingRules: BookingRules;
  cancellationPolicy: string;
  createdAt: string;
}

export interface WorkingHours {
  enabled: boolean;
  start: string;
  end: string;
}

export interface BookingRules {
  minNotice?: number;
  maxAdvance?: number;
  bufferBefore?: number;
  bufferAfter?: number;
}

export interface User {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: StaffRole;
  isActive: boolean;
  createdAt: string;
}

export interface Workspace {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  color: string;
  timezone: string;
  address?: string;
  phone?: string;
  email?: string;
  isActive: boolean;
  serviceIds: string[];
  staffIds: string[];
  workingHours: Record<string, WorkingHours>;
  createdAt: string;
}

export interface Service {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  category: ServiceCategory;
  duration: number;
  price: number;
  currency: string;
  location: string;
  isActive: boolean;
  bufferBefore: number;
  bufferAfter: number;
  minNotice: number;
  maxAdvance: number;
  cancellationPolicy: string;
  reschedulingPolicy: string;
  color: string;
  workspaceIds: string[];
  staffIds: string[];
  resourceIds: string[];
  customFields: CustomField[];
  createdAt: string;
}

export interface CustomField {
  id: string;
  label: string;
  type: 'text' | 'select' | 'checkbox' | 'number';
  required: boolean;
  options?: string[];
}

export interface Staff {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  phone?: string;
  role: StaffRole;
  title?: string;
  bio?: string;
  color: string;
  isActive: boolean;
  workspaceIds: string[];
  serviceIds: string[];
  workingHours: Record<string, WorkingHours>;
  bookingPageUrl?: string;
  createdAt: string;
}

export interface Resource {
  id: string;
  organizationId: string;
  name: string;
  type: ResourceType;
  description: string;
  capacity: number;
  isActive: boolean;
  workspaceIds: string[];
  serviceIds: string[];
  availabilityRules: Record<string, WorkingHours>;
  createdAt: string;
}

export interface Customer {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  phone?: string;
  timezone?: string;
  notes: string;
  tags: string[];
  totalBookings: number;
  lastBookingDate?: string;
  createdAt: string;
}

export interface CustomerAnswer {
  fieldId: string;
  label: string;
  value: string;
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
  notes: string;
  internalNotes: string;
  customerAnswers: CustomerAnswer[];
  createdAt: string;
  updatedAt: string;
}

export interface BookingPage {
  id: string;
  organizationId: string;
  workspaceId?: string;
  serviceId?: string;
  staffId?: string;
  type: BookingPageType;
  title: string;
  description: string;
  slug: string;
  isPublished: boolean;
  theme: Record<string, unknown>;
  formFields: CustomField[];
  serviceIds: string[];
  createdAt: string;
}

export interface TimeSlot {
  start: string;
  end: string;
  available: boolean;
}

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuthPayload {
  sub: string;
  email: string;
  orgId: string;
  role: StaffRole;
  /** Server-side session id; absent only for users built directly in tests or internal calls. */
  sid?: string;
  /** Staff record linked to this sign-in, for staff accounts. */
  staffId?: string | null;
}
