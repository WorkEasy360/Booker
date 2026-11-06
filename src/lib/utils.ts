import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format, formatDistanceToNow, parseISO, isToday, isTomorrow, isYesterday } from 'date-fns';
import type { AppointmentStatus } from '@/types';
import { formatMoney } from './currency';
import { dateDisplayPattern } from './regional';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** A date for display: in the business's date format (Settings > Language & Region) unless a pattern is given. */
export function formatDate(dateStr: string, fmt?: string): string {
  try {
    return format(parseISO(dateStr), fmt ?? dateDisplayPattern());
  } catch {
    return dateStr;
  }
}

export function formatTime(timeStr: string, use24h = false): string {
  try {
    const [h, m] = timeStr.split(':').map(Number);
    if (use24h) return timeStr;
    const period = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    return `${hour}:${m.toString().padStart(2, '0')} ${period}`;
  } catch {
    return timeStr;
  }
}

export function formatDateTime(dateStr: string, timeStr: string): string {
  return `${formatDate(dateStr)}, ${formatTime(timeStr)}`;
}

export function formatRelative(dateStr: string): string {
  try {
    const d = parseISO(dateStr);
    if (isToday(d)) return 'Today';
    if (isTomorrow(d)) return 'Tomorrow';
    if (isYesterday(d)) return 'Yesterday';
    return formatDistanceToNow(d, { addSuffix: true });
  } catch {
    return dateStr;
  }
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Currency is required so amounts are never silently shown in the wrong currency. */
export function formatCurrency(amount: number, currency: string): string {
  return formatMoney(amount, currency);
}

/** YYYY-MM-DD for "now" in an IANA time zone, e.g. the business's; falls back to the browser's date. */
export function todayInTimeZone(timeZone?: string): string {
  if (!timeZone) return localDateISO();
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return localDateISO();
  }
}

/** YYYY-MM-DD in the browser's local timezone (toISOString() would give the UTC date). */
export function localDateISO(d: Date = new Date()): string {
  return format(d, 'yyyy-MM-dd');
}

export function getStatusColor(status: AppointmentStatus | string): string {
  const map: Record<AppointmentStatus, string> = {
    scheduled: 'text-blue-700 bg-blue-50',
    confirmed: 'text-primary bg-primary-light',
    completed: 'text-emerald-700 bg-emerald-50',
    cancelled: 'text-red-700 bg-red-50',
    no_show: 'text-purple-700 bg-purple-50',
  };
  return map[status as AppointmentStatus] ?? 'text-gray-700 bg-gray-50';
}

export function getStatusDot(status: AppointmentStatus | string): string {
  const map: Record<AppointmentStatus, string> = {
    scheduled: 'bg-blue-500',
    confirmed: 'bg-primary',
    completed: 'bg-emerald-500',
    cancelled: 'bg-red-500',
    no_show: 'bg-purple-500',
  };
  return map[status as AppointmentStatus] ?? 'bg-gray-400';
}

export function generateId(): string {
  return Math.random().toString(36).slice(2, 11);
}

export function generateBookingRef(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let ref = 'WE-';
  for (let i = 0; i < 8; i++) ref += chars[Math.floor(Math.random() * chars.length)];
  return ref;
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function truncate(str: string, max = 50): string {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

export function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

export const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export const DAY_LABELS: Record<string, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed',
  thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

export { TIMEZONES, timeZoneOptions } from './timezones';
