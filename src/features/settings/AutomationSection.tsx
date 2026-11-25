import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarCheck, CalendarClock, CalendarX, BellRing, ArrowRight } from 'lucide-react';
import { notificationPlatformApi, type MessageChannel } from '@/api/client';
import { Section, Pill, Loading } from './ui';
import { CHANNEL_NAME, deriveNotifications, type SimpleNotifications } from './notificationState';

/**
 * 4.6 Internal Automation: the built-in booking rules, shown read-only. They are switched in Notifications (the one
 * place they are configured); there is no rule editor or workflow builder. External automation belongs to WorkEasy
 * Connect (Integrations).
 */
export function AutomationSection() {
  const [state, setState] = useState<SimpleNotifications | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    notificationPlatformApi.settings().then(s => setState(deriveNotifications(s))).catch((e: Error) => setError(e.message || 'Could not load'));
  }, []);

  const channels = state ? (Object.keys(state.channels) as MessageChannel[]).filter(c => state.channels[c] && (c === 'email' || state.connected[c])) : [];
  const via = channels.length ? `Sent by ${channels.map(c => CHANNEL_NAME[c]).join(', ')}` : 'No channel is on';
  const rules = [
    { icon: CalendarCheck, name: 'Booking confirmation', when: 'When an appointment is booked', on: channels.length > 0 },
    { icon: CalendarClock, name: 'Reschedule update', when: 'When an appointment moves; its pending reminder is replaced', on: channels.length > 0 },
    { icon: CalendarX, name: 'Cancellation update', when: 'When an appointment is cancelled; its pending reminder stops', on: channels.length > 0 },
    { icon: BellRing, name: 'Reminder (optional)', when: '24 hours before the appointment, skipped when booked later than that', on: !!state?.reminder && channels.length > 0 },
  ];

  return (
    <Section id="automation" title="Internal Automation" description="Built-in rules that run on every booking. Appointments are always saved first; a failed message never undoes one."
      action={<Link to="/settings/notifications" className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline">Manage in Notifications<ArrowRight className="w-4 h-4" aria-hidden="true" /></Link>}>
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : !state ? <Loading /> : (
        <ul className="divide-y divide-border border border-border rounded-xl">
          {rules.map(r => (
            <li key={r.name} className="flex items-start gap-3 px-4 py-3.5">
              <span className="icon-tile w-9 h-9 bg-primary-light text-primary"><r.icon className="w-[18px] h-[18px]" aria-hidden="true" /></span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-text-primary">{r.name}</p>
                <p className="text-sm text-text-secondary">{r.when}</p>
                {r.on && <p className="text-xs text-text-muted mt-0.5">{via}</p>}
              </div>
              <Pill tone={r.on ? 'green' : 'gray'}>{r.on ? 'On' : 'Off'}</Pill>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
