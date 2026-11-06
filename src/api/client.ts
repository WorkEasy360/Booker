const BASE = '/api';

export const SESSION_EXPIRED_EVENT = 'we360:session-expired';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// The session itself lives in an HttpOnly cookie that scripts cannot read. Changes (POST/PUT/DELETE) must also
// carry the per-session CSRF token the server returns from sign-in and /auth/me; it is kept in memory only.
let csrfToken: string | null = null;

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface RequestOptions {
  headers?: Record<string, string>;
  /** Internal: set on the single automatic retry after refreshing the CSRF token. */
  retried?: boolean;
  /** How long to wait for the whole response; defaults to REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** A file sent as the body itself (uploads), with its own content type, instead of JSON. */
  raw?: Blob;
}

/**
 * No request waits forever. A server that accepts a request and never answers (for example a development API caught
 * mid-restart) used to leave pages loading indefinitely; after this long the request fails like any network error.
 */
export const REQUEST_TIMEOUT_MS = 30_000;
/** The session check at start-up decides between the app, the sign-in page and the connection error screen. */
export const SESSION_CHECK_TIMEOUT_MS = 15_000;

async function refreshCsrfToken(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/auth/me`, { credentials: 'include' });
    if (!res.ok) return false;
    const json = await res.json() as { data?: { csrfToken?: string } };
    csrfToken = json.data?.csrfToken ?? null;
    return !!csrfToken;
  } catch {
    return false;
  }
}

export async function apiRequest<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': opts.raw ? (opts.raw.type || 'application/octet-stream') : 'application/json', ...opts.headers };
  if (UNSAFE.has(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let json: unknown;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      // Sends the HttpOnly session cookie; nothing about the session is stored in localStorage.
      credentials: 'include',
      headers,
      body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: controller.signal,
    });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    if (controller.signal.aborted) throw new Error(`The server did not answer within ${Math.round(timeoutMs / 1000)} seconds`, { cause: e });
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const err = json as { error?: string; code?: string; details?: Array<{ path: string; message: string }> };
    // The token can be missing after a reload or stale after signing in elsewhere: fetch a fresh one and retry once.
    if (res.status === 403 && err.code === 'CSRF_FAILED' && !opts.retried && await refreshCsrfToken()) {
      return apiRequest<T>(method, path, body, { ...opts, retried: true });
    }
    let message = err.error ?? `Request failed (HTTP ${res.status})`;
    if (err.details?.length) {
      message += ': ' + err.details.map(d => (d.path ? `${d.path} — ${d.message}` : d.message)).join('; ');
    }
    if (res.status === 401 && !path.startsWith('/auth/') && !path.startsWith('/public/')) {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    throw new ApiError(message, res.status, err.code);
  }

  const data = (json as { data: T }).data;
  if (path.startsWith('/auth/') && data && typeof data === 'object' && 'csrfToken' in data) {
    csrfToken = (data as { csrfToken?: string }).csrfToken ?? null;
  }
  return data;
}

const request = apiRequest;

export const api = {
  get:    <T>(path: string)              => request<T>('GET',    path),
  post:   <T>(path: string, body: unknown) => request<T>('POST',   path, body),
  put:    <T>(path: string, body: unknown) => request<T>('PUT',    path, body),
  delete: <T>(path: string)              => request<T>('DELETE', path),
};

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  /** What this account may do, as decided by the server (e.g. "customers:write"). */
  permissions?: string[];
  /** Staff record this sign-in belongs to (staff and manager accounts created by invitation). */
  staffId?: string | null;
}

export interface InvitationPreview { businessName: string; staffName: string; email: string; role: 'staff' | 'manager'; expiresAt: string }
export interface VerificationPreview { email: string; businessName: string; expiresAt: string }
export interface RoleDescription { role: string; label: string; permissions: string[] }
export interface SessionInfo { id: string; createdAt: string; expiresAt: string; current: boolean }

export const authApi = {
  inspectInvitation: (token: string) => request<InvitationPreview>('POST', '/auth/invitations/inspect', { token }),
  acceptInvitation: (token: string, password: string, confirmPassword: string) =>
    request<{ user: AuthUser; csrfToken: string }>('POST', '/auth/invitations/accept', { token, password, confirmPassword }),
  roles: () => request<{ permissions: string[]; roles: RoleDescription[] }>('GET', '/auth/roles'),
  sessions: () => request<SessionInfo[]>('GET', '/auth/sessions'),
  endOtherSessions: () => request<{ ended: number }>('POST', '/auth/sessions/revoke-others', {}),
  // Email links (sign-up confirmation, password reset) carry a token; none of these calls signs anyone in.
  inspectVerification: (token: string) => request<VerificationPreview>('POST', '/auth/verify-email/inspect', { token }),
  verifyEmail: (token: string) => request<{ message: string }>('POST', '/auth/verify-email', { token }),
  resendVerification: (email: string) => request<{ message: string }>('POST', '/auth/verify-email/resend', { email }),
  forgotPassword: (email: string) => request<{ message: string }>('POST', '/auth/password/forgot', { email }),
  inspectPasswordReset: (token: string) => request<{ expiresAt: string }>('POST', '/auth/password/reset/inspect', { token }),
  resetPassword: (token: string, password: string, confirmPassword: string) =>
    request<{ message: string }>('POST', '/auth/password/reset', { token, password, confirmPassword }),
  // Two-factor sign-in for the signed-in user. The secret is shown only during setup; recovery codes only once.
  twoFactorStatus: () => request<TwoFactorStatus>('GET', '/auth/2fa'),
  twoFactorSetup: (password: string) => request<TwoFactorSetup>('POST', '/auth/2fa/setup', { password }),
  twoFactorEnable: (code: string) => request<{ recoveryCodes: string[]; otherSessionsEnded: number }>('POST', '/auth/2fa/enable', { code }),
  twoFactorDisable: (password: string, factor: SecondFactor) =>
    request<{ enabled: false; otherSessionsEnded: number }>('POST', '/auth/2fa/disable', { password, ...factor }),
  twoFactorRecoveryCodes: (password: string, factor: SecondFactor) =>
    request<{ recoveryCodes: string[] }>('POST', '/auth/2fa/recovery-codes', { password, ...factor }),
};

export interface TwoFactorStatus { enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number }
export interface TwoFactorSetup { secret: string; otpauthUrl: string; expiresAt: string }

/** Signed in, or (two-factor sign-in on) a short-lived challenge for the second step. */
export type LoginResponse =
  | { user: AuthUser; csrfToken: string; twoFactorRequired?: undefined }
  | { twoFactorRequired: true; challenge: string; expiresAt: string };

export type SecondFactor = { code: string } | { recoveryCode: string };

export function login(email: string, password: string) {
  return request<LoginResponse>('POST', '/auth/login', { email, password });
}

/** The second sign-in step: a code from the authenticator app or a recovery code. */
export function loginSecondStep(challenge: string, factor: SecondFactor) {
  return request<{ user: AuthUser; csrfToken: string }>('POST', '/auth/login/2fa', { challenge, ...factor });
}

/** The browser's IANA time zone, if it reports one. */
function browserTimeZone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

export function signup(data: {
  name: string;
  email: string;
  company: string;
  password: string;
  confirmPassword: string;
}) {
  // A new business starts in the time zone of the browser that creates it (India: Asia/Kolkata); changeable in Settings.
  // The account is created only when the emailed link is confirmed; the answer is the same for every address.
  return request<{ message: string }>('POST', '/auth/signup', { ...data, timezone: browserTimeZone() });
}

export function getMe() {
  return request<AuthUser & { csrfToken?: string }>('GET', '/auth/me', undefined, { timeoutMs: SESSION_CHECK_TIMEOUT_MS });
}

export async function logout() {
  try {
    return await request<{ message: string }>('POST', '/auth/logout', {});
  } finally {
    csrfToken = null;
  }
}

// ── Services ─────────────────────────────────────────────────────────────────

export const servicesApi = {
  list:   ()             => api.get<unknown[]>('/services'),
  get:    (id: string)   => api.get<unknown>(`/services/${id}`),
  create: (data: unknown) => api.post<unknown>('/services', data),
  update: (id: string, data: unknown) => api.put<unknown>(`/services/${id}`, data),
  delete: (id: string)   => api.delete<unknown>(`/services/${id}`),
};

// ── Staff ────────────────────────────────────────────────────────────────────

export const staffApi = {
  list:   ()             => api.get<unknown[]>('/staff'),
  get:    (id: string)   => api.get<unknown>(`/staff/${id}`),
  create: (data: unknown) => api.post<unknown>('/staff', data),
  update: (id: string, data: unknown) => api.put<unknown>(`/staff/${id}`, data),
  delete: (id: string)   => api.delete<unknown>(`/staff/${id}`),
  /** Emails a single-use sign-in invitation to the staff member's address. The token is never returned. */
  invite: (id: string, role: 'staff' | 'manager') =>
    api.post<{ invitation: StaffInvitation; email: { status: string; error?: string } }>(`/staff/${id}/invitations`, { role }),
  invitations: (id: string) => api.get<StaffInvitation[]>(`/staff/${id}/invitations`),
  revokeInvitation: (id: string, invitationId: string) => api.delete<{ revoked: boolean }>(`/staff/${id}/invitations/${invitationId}`),
  setAccess: (id: string, enabled: boolean) => api.put<{ enabled: boolean }>(`/staff/${id}/access`, { enabled }),
  /** For a staff member who lost their authenticator and recovery codes; signs them out everywhere. */
  resetTwoFactor: (id: string) => api.post<{ reset: boolean }>(`/staff/${id}/two-factor/reset`, {}),
};

// ── Notifications: reminders, staff alerts, language, email texts ────────────

export interface NotificationPreferences {
  bookingLanguage: 'en' | 'hi';
  remindersEnabled: boolean;
  reminderHoursBefore: number;
  staffAlertsEnabled: boolean;
}
export type EmailTemplateKind = 'confirmation' | 'reschedule' | 'cancellation' | 'reminder';
export interface EmailTemplate { kind: EmailTemplateKind; custom: boolean; subject: string; intro: string; updatedAt?: string }

export const notificationsApi = {
  preferences: () => request<NotificationPreferences>('GET', '/settings/notifications'),
  savePreferences: (changes: Partial<NotificationPreferences>) => request<NotificationPreferences>('PUT', '/settings/notifications', changes),
  templates: () => request<{ placeholders: string[]; templates: EmailTemplate[] }>('GET', '/settings/email-templates'),
  saveTemplate: (kind: EmailTemplateKind, subject: string, intro: string) => request<EmailTemplate>('PUT', `/settings/email-templates/${kind}`, { subject, intro }),
  resetTemplate: (kind: EmailTemplateKind) => request<{ reset: boolean }>('DELETE', `/settings/email-templates/${kind}`),
  preview: (kind: EmailTemplateKind, subject: string, intro: string) =>
    request<{ subject: string; text: string }>('POST', '/settings/email-templates/preview', { kind, subject, intro }),
};

// ── Notification platform: who gets what, on which channel; delivery history ──

export type NotificationEventName = 'confirmed' | 'rescheduled' | 'cancelled' | 'reminder' | 'status_changed';
export type MessageChannel = 'email' | 'sms' | 'whatsapp';
export type DeliveryChannel = MessageChannel | 'google_calendar' | 'outlook_calendar';
export interface NotificationRule { event: NotificationEventName; role: 'customer' | 'staff'; channel: MessageChannel; enabled: boolean; locked: boolean }
export type ConnectionState = 'not_configured' | 'configured_unverified' | 'connected' | 'error';
export interface MessagingConnection {
  channel: 'sms' | 'whatsapp';
  status: ConnectionState;
  provider: 'twilio' | 'whatsapp_cloud' | 'mock' | null;
  /** True when messages go to the development stand-in (nothing is sent). */
  mock: boolean;
  verifiedAt: string | null;
  lastError: string | null;
  /** Identifiers in full, secrets as their last four characters only. */
  hints: Record<string, string>;
  settings: { templates?: Record<string, string> };
}
export interface CalendarLinkStatus { connected: boolean; mock: boolean; connectedAt: string | null }
export interface ChannelSummary { lastSentAt: string | null; lastError: string | null; lastErrorAt: string | null }
export interface NotificationPlatformSettings {
  providerMode: 'mock' | 'live';
  rules: NotificationRule[];
  reminderOffsets: number[];
  businessCalendar: 'google' | 'outlook' | null;
  inviteStaffToCalendar: boolean;
  connections: { sms: MessagingConnection; whatsapp: MessagingConnection };
  calendars: { google: CalendarLinkStatus; outlook: CalendarLinkStatus };
  summary: Record<DeliveryChannel, ChannelSummary>;
  /** Addresses to enter in the provider's console for delivery reports and replies. */
  callbacks: { publicApiUrl: string | null; twilioStatus: string; twilioInbound: string; whatsapp: string };
}
export interface BusinessRecipient { id: string; name: string; email: string | null; phone: string | null; channels: MessageChannel[]; events: NotificationEventName[]; active: boolean }
export type BusinessRecipientInput = Omit<BusinessRecipient, 'id' | 'email' | 'phone'> & { email?: string; phone?: string };
export interface StaffNotificationSettings { channels: MessageChannel[]; events: NotificationEventName[] }
export interface ConsentState { status: 'granted' | 'revoked' | 'none'; source?: string; recordedAt?: string }
export type JobStatus = 'pending' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped' | 'cancelled' | 'unknown' | 'not_configured';
export interface NotificationJob {
  id: string;
  event: NotificationEventName;
  role: 'customer' | 'staff' | 'business' | 'business_calendar';
  recipient: string;
  channel: DeliveryChannel;
  status: JobStatus;
  reason: string | null;
  attempts: number;
  maxAttempts: number;
  scheduledFor: string | null;
  nextAttemptAt: string | null;
  provider: string | null;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  history: Array<{ attempt: number; outcome: string; provider: string | null; error: string | null; at: string | null }>;
}
export interface ConnectionTestResult { mock: boolean; outcome: 'accepted' | 'transient' | 'permanent' | 'timeout'; providerMessageId: string | null; error: string | null }

export const notificationPlatformApi = {
  settings: () => request<NotificationPlatformSettings>('GET', '/notifications/settings'),
  saveRules: (rules: Array<Pick<NotificationRule, 'event' | 'role' | 'channel' | 'enabled'>>) => request<NotificationRule[]>('PUT', '/notifications/settings/rules', { rules }),
  saveSchedule: (changes: { reminderOffsets?: number[]; businessCalendar?: 'google' | 'outlook' | null; inviteStaffToCalendar?: boolean }) =>
    request<{ reminderOffsets: number[]; businessCalendar: 'google' | 'outlook' | null; inviteStaffToCalendar: boolean }>('PUT', '/notifications/settings/schedule', changes),
  recipients: () => request<BusinessRecipient[]>('GET', '/notifications/recipients'),
  addRecipient: (r: BusinessRecipientInput) => request<BusinessRecipient>('POST', '/notifications/recipients', r),
  updateRecipient: (id: string, r: BusinessRecipientInput) => request<BusinessRecipient>('PUT', `/notifications/recipients/${id}`, r),
  deleteRecipient: (id: string) => request<{ deleted: boolean }>('DELETE', `/notifications/recipients/${id}`),
  staffSettings: (staffId: string) => request<StaffNotificationSettings>('GET', `/notifications/staff/${staffId}`),
  saveStaffSettings: (staffId: string, s: StaffNotificationSettings) => request<StaffNotificationSettings>('PUT', `/notifications/staff/${staffId}`, s),
  consent: (customerId: string) => request<Record<'sms' | 'whatsapp', ConsentState>>('GET', `/notifications/customers/${customerId}/consent`),
  saveConsent: (customerId: string, changes: Partial<Record<'sms' | 'whatsapp', 'granted' | 'revoked'>>) =>
    request<Record<'sms' | 'whatsapp', ConsentState>>('PUT', `/notifications/customers/${customerId}/consent`, changes),
  saveConnection: (channel: 'sms' | 'whatsapp', provider: 'twilio' | 'whatsapp_cloud' | 'mock', config: Record<string, string>, templates?: Record<string, string>) =>
    request<MessagingConnection>('PUT', `/notifications/connections/${channel}`, { provider, config, templates }),
  deleteConnection: (channel: 'sms' | 'whatsapp') => request<{ deleted: boolean }>('DELETE', `/notifications/connections/${channel}`),
  verifyConnection: (channel: 'sms' | 'whatsapp') => request<MessagingConnection>('POST', `/notifications/connections/${channel}/verify`, {}),
  testConnection: (channel: 'sms' | 'whatsapp', to: string) => request<ConnectionTestResult>('POST', `/notifications/connections/${channel}/test`, { to }),
  mockConnectCalendar: (provider: 'google' | 'outlook') => request<{ google: CalendarLinkStatus; outlook: CalendarLinkStatus }>('POST', `/notifications/calendars/${provider}/mock-connect`, {}),
  appointmentJobs: (appointmentId: string) => request<NotificationJob[]>('GET', `/notifications/appointments/${appointmentId}`),
  retryJob: (jobId: string) => request<{ id: string; status: JobStatus; maxAttempts: number }>('POST', `/notifications/jobs/${jobId}/retry`, {}),
};

// ── Integrations ─────────────────────────────────────────────────────────────

export interface IntegrationStatus {
  payments: { stripe: boolean; razorpay: boolean; paypal: boolean };
  accounts: Record<'google' | 'microsoft' | 'zoom' | 'mailchimp', { name: string; configured: boolean; connected: boolean; connectedAt?: string; scopes: string[] }>;
  sms: { twilio: boolean };
  webhooks: { endpoints: number };
}
export interface WebhookEndpoint { id: string; url: string; events: string[]; description: string; active: boolean; createdAt: string }
export interface WebhookDelivery { id: string; eventType: string; status: string; attempts: number; responseStatus: number | null; error: string | null; createdAt: string; deliveredAt: string | null }

export const integrationsApi = {
  status: () => request<IntegrationStatus>('GET', '/integrations/status'),
  webhooks: () => request<{ events: string[]; endpoints: WebhookEndpoint[] }>('GET', '/integrations/webhooks'),
  addWebhook: (url: string, events: string[], description: string) =>
    request<{ endpoint: WebhookEndpoint; secret: string }>('POST', '/integrations/webhooks', { url, events, description }),
  deleteWebhook: (id: string) => request<{ deleted: boolean }>('DELETE', `/integrations/webhooks/${id}`),
  testWebhook: (id: string) => request<WebhookDelivery>('POST', `/integrations/webhooks/${id}/test`, {}),
  deliveries: (id: string) => request<WebhookDelivery[]>('GET', `/integrations/webhooks/${id}/deliveries`),
  connectUrl: (provider: string) => request<{ url: string }>('GET', `/integrations/${provider}/connect`),
  disconnect: (provider: string) => request<{ disconnected: boolean }>('DELETE', `/integrations/${provider}`),
};

/** An uploaded image, served publicly at `url` (business logo, staff photo). */
export interface UploadedImage { id: string; url: string; contentType: string; width: number; height: number; byteSize: number }

const UPLOAD_TIMEOUT_MS = 60_000;

export const mediaApi = {
  uploadLogo: (file: Blob) => request<UploadedImage>('PUT', '/settings/logo', undefined, { raw: file, timeoutMs: UPLOAD_TIMEOUT_MS }),
  removeLogo: () => request<{ removed: boolean }>('DELETE', '/settings/logo'),
  uploadStaffPhoto: (staffId: string, file: Blob) =>
    request<UploadedImage>('PUT', `/staff/${staffId}/photo`, undefined, { raw: file, timeoutMs: UPLOAD_TIMEOUT_MS }),
  removeStaffPhoto: (staffId: string) => request<{ removed: boolean }>('DELETE', `/staff/${staffId}/photo`),
};

export interface StaffInvitation {
  id: string;
  email: string;
  role: 'staff' | 'manager';
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  delivery: { status: string; error: string | null } | null;
}

/** Sign-in state of a staff member, included in staff records for people who manage staff. */
export interface StaffAccount { status: 'none' | 'invited' | 'active' | 'disabled'; role?: string; expiresAt?: string; twoFactor?: boolean }

// ── Customers ────────────────────────────────────────────────────────────────

export const customersApi = {
  list:   (q?: string)   => api.get<unknown[]>(q ? `/customers?q=${encodeURIComponent(q)}` : '/customers'),
  /** Total customers and active ones (at least one appointment that was not cancelled): one definition for every page. */
  summary: () => api.get<{ total: number; active: number }>('/customers/summary'),
  get:    (id: string)   => api.get<unknown>(`/customers/${id}`),
  create: (data: unknown) => api.post<unknown>('/customers', data),
  update: (id: string, data: unknown) => api.put<unknown>(`/customers/${id}`, data),
  delete: (id: string)   => api.delete<unknown>(`/customers/${id}`),
};

// ── Appointments ─────────────────────────────────────────────────────────────

export const appointmentsApi = {
  list:         (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return api.get<unknown[]>(`/appointments${qs}`);
  },
  get:          (id: string)   => api.get<unknown>(`/appointments/${id}`),
  availability: (params: Record<string, string>) =>
    api.get<unknown[]>('/appointments/availability?' + new URLSearchParams(params).toString()),
  create: (data: unknown) => api.post<unknown>('/appointments', data),
  update: (id: string, data: unknown) => api.put<unknown>(`/appointments/${id}`, data),
  delete: (id: string)   => api.delete<unknown>(`/appointments/${id}`),
  emails: (id: string)   => api.get<EmailDelivery[]>(`/appointments/${id}/emails`),
  history: (id: string)  => api.get<AppointmentHistoryEntry[]>(`/appointments/${id}/history`),
  resendEmail: (id: string, kind: 'confirmation' | 'cancellation') =>
    api.post<{ status: 'sent' | 'failed' | 'not_configured' | 'retrying'; error?: string; nextAttemptAt?: string }>(`/appointments/${id}/emails`, { kind }),
};

/** One change to an appointment, oldest first. Entries cannot be edited or removed. */
export interface AppointmentHistoryEntry {
  id: string;
  action: 'created' | 'status_changed' | 'rescheduled' | 'reassigned' | 'deleted';
  fromStatus: string | null; toStatus: string | null;
  fromDate: string | null; fromStartTime: string | null; toDate: string | null; toStartTime: string | null;
  fromStaff: { id: string; name: string | null } | null;
  toStaff: { id: string; name: string | null } | null;
  actor: { type: 'user' | 'customer' | 'system'; name: string | null; source: 'dashboard' | 'assistant' | 'booking_page' | 'manage_link' | 'system' };
  createdAt: string;
}

export interface EmailDelivery {
  id: string;
  kind: 'confirmation' | 'reschedule' | 'cancellation' | 'reminder' | 'staff_new' | 'staff_cancelled' | 'staff_rescheduled';
  /** One attempt (sent / failed / not_configured), or an email still queued for a retry, or interrupted by a restart. */
  status: 'sent' | 'failed' | 'not_configured' | 'retrying' | 'unknown';
  transport: string;
  error: string | null;
  createdAt: string;
  nextAttemptAt?: string;
}

// ── Workspaces ───────────────────────────────────────────────────────────────

export const workspacesApi = {
  list:   ()             => api.get<unknown[]>('/workspaces'),
  get:    (id: string)   => api.get<unknown>(`/workspaces/${id}`),
  create: (data: unknown) => api.post<unknown>('/workspaces', data),
  update: (id: string, data: unknown) => api.put<unknown>(`/workspaces/${id}`, data),
  delete: (id: string)   => api.delete<unknown>(`/workspaces/${id}`),
};

// ── Resources ────────────────────────────────────────────────────────────────

export const resourcesApi = {
  list:   ()             => api.get<unknown[]>('/resources'),
  get:    (id: string)   => api.get<unknown>(`/resources/${id}`),
  create: (data: unknown) => api.post<unknown>('/resources', data),
  update: (id: string, data: unknown) => api.put<unknown>(`/resources/${id}`, data),
  delete: (id: string)   => api.delete<unknown>(`/resources/${id}`),
};

// ── Booking Pages ────────────────────────────────────────────────────────────

export const bookingPagesApi = {
  list:    ()             => api.get<unknown[]>('/booking-pages'),
  get:     (id: string)   => api.get<unknown>(`/booking-pages/${id}`),
  create:  (data: unknown) => api.post<unknown>('/booking-pages', data),
  update:  (id: string, data: unknown) => api.put<unknown>(`/booking-pages/${id}`, data),
  publish: (id: string)   => api.post<unknown>(`/booking-pages/${id}/publish`, {}),
  delete:  (id: string)   => api.delete<unknown>(`/booking-pages/${id}`),
};

// ── Settings ─────────────────────────────────────────────────────────────────

export const settingsApi = {
  get:    () => api.get<unknown>('/settings'),
  emailStatus: () => api.get<{ transport: 'disabled' | 'smtp' | 'memory'; sending: boolean }>('/settings/email-status'),
  update: (data: unknown) => api.put<unknown>('/settings', data),
};

// ── Reports ──────────────────────────────────────────────────────────────────

export const reportsApi = {
  summary:      (range = '30d') => api.get<unknown>(`/reports/summary?range=${range}`),
  byService:    (range = '30d') => api.get<unknown[]>(`/reports/by-service?range=${range}`),
  byStaff:      (range = '30d') => api.get<unknown[]>(`/reports/by-staff?range=${range}`),
  topCustomers: ()              => api.get<unknown[]>('/reports/top-customers'),
};

// ── Public (no auth) ─────────────────────────────────────────────────────────

/** A customer's own booking as shown after they proved they own it. */
export interface ManagedBooking {
  bookingRef: string;
  serviceId: string;
  staffId: string;
  status: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: number;
  timezone?: string;
  price: number;
  currency: string;
  location: string;
  serviceName: string;
  staffName: string;
  maskedEmail: string;
  business: { name: string; phone: string | null; website: string | null };
  tokenExpiresAt?: string;
}

const bookingTokenHeader = (token?: string): RequestOptions => (token ? { headers: { 'X-Booking-Token': token } } : {});

export const publicApi = {
  getPage:         (slug: string)  => api.get<unknown>(`/public/pages/${slug}`),
  getServiceStaff: (id: string)    => api.get<unknown[]>(`/public/services/${id}/staff`),
  /** `manageToken` is sent while rescheduling so the booking's own slot is not counted as taken. */
  availability:    (params: Record<string, string>, manageToken?: string) =>
    request<unknown[]>('GET', '/public/availability?' + new URLSearchParams(params).toString(), undefined, bookingTokenHeader(manageToken)),
  availabilityDays: (params: { serviceId: string; staffId: string; from: string; to: string }, manageToken?: string) =>
    request<Array<{ date: string; available: boolean }>>('GET', '/public/availability/days?' + new URLSearchParams(params).toString(), undefined, bookingTokenHeader(manageToken)),
  book:            (data: unknown) => api.post<unknown>('/public/book', data),
  /** Booking reference + the email it was made with → a short-lived manage token. */
  lookup:          (ref: string, email: string) =>
    api.post<{ token: string; expiresAt: string; appointment: ManagedBooking }>('/public/appointments/lookup', { ref, email }),
  getManaged:      (token: string) => request<ManagedBooking>('GET', '/public/appointments/manage', undefined, bookingTokenHeader(token)),
  /** Emails the manage link to the address on the booking. The answer is the same whether or not the details match. */
  sendManageLink:  (ref: string, email: string) =>
    api.post<{ message: string }>('/public/appointments/manage-link', { ref, email }),
  cancel:          (token: string) => request<unknown>('POST', '/public/appointments/manage/cancel', {}, bookingTokenHeader(token)),
  reschedule:      (token: string, data: { date: string; startTime: string }) =>
    request<unknown>('POST', '/public/appointments/manage/reschedule', data, bookingTokenHeader(token)),
  /** The booking as a calendar file (.ics) for Apple Calendar and others; needs the manage token. */
  calendarFile:    async (token: string): Promise<{ filename: string; content: string }> => {
    const res = await fetch(`${BASE}/public/appointments/manage/ics`, { headers: { 'X-Booking-Token': token }, credentials: 'omit' });
    if (!res.ok) throw new ApiError(`Request failed (HTTP ${res.status})`, res.status);
    const filename = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'booking.ics';
    return { filename, content: await res.text() };
  },
};
