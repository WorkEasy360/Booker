import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Plus, Trash2, AlertTriangle, CalendarX2, CalendarClock, Building2, ChevronRight, Lock } from 'lucide-react';
import { PageTitle, Modal, useToast, Spinner } from '@/components/ui';
import {
  settingsApi, staffApi, availabilityApi,
  type TimeOffPeriod, type DateHours, type ScheduleBreak, type AffectedAppointment,
} from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { usePageTitle } from '@/hooks/usePageTitle';
import { cn, formatDate, localDateISO } from '@/lib/utils';
import {
  WEEKDAYS, WEEKDAY_LABEL, TIME_STEPS, fmt, weekFromStored, storedFromWeek, weekProblems,
  type WeekEdit, type Weekday, type StoredHours,
} from './hours';

interface ApiStaff { id: string; name: string; isActive: boolean; workingHours: StoredHours; color?: string }
interface OrgSettings { workingHours?: StoredHours; timezone?: string }

/** null = the whole business; otherwise a provider (staff record) id. */
type Target = string | null;

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

// ─── Small building blocks ──────────────────────────────────────────────────

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed',
        checked ? 'bg-primary' : 'bg-gray-300',
      )}
    >
      <span className={cn('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

function TimeSelect({ value, onChange, disabled, label }: { value: string; onChange: (v: string) => void; disabled?: boolean; label: string }) {
  const options = TIME_STEPS.includes(value) ? TIME_STEPS : [...TIME_STEPS, value].sort();
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      className="h-11 rounded-lg border border-border bg-white px-3 text-[15px] text-text-primary focus:outline-none focus:ring-2 focus:ring-primary disabled:bg-gray-50 disabled:text-text-secondary"
    >
      {options.map(t => <option key={t} value={t}>{fmt(t)}</option>)}
    </select>
  );
}

function PanelHeader({ icon: Icon, title, description, action }: { icon: React.ElementType; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 sm:px-6 pt-5 sm:pt-6 pb-4">
      <div className="flex items-start gap-3 min-w-0">
        <span className="icon-tile w-10 h-10 bg-primary-light text-primary"><Icon className="w-5 h-5" aria-hidden="true" /></span>
        <div className="min-w-0">
          <h2 className="text-lg sm:text-xl font-semibold text-text-primary">{title}</h2>
          {description && <p className="text-sm text-text-secondary mt-0.5">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

function Segmented<T extends string>({ options, value, onChange, label }: { options: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-xl border border-border bg-white p-1 shadow-card">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'min-h-[40px] px-4 rounded-lg text-[15px] font-medium transition-colors',
            value === o.value ? 'bg-brand-active text-white shadow-sm' : 'text-text-primary hover:bg-gray-50',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function AvailabilityPage() {
  usePageTitle('Availability');
  const { user, can } = useAuth();
  const canBusiness = can('settings:write');
  const canStaff = can('staff:manage');
  const manager = canBusiness || canStaff;
  const ownStaffId = user?.staffId ?? null;

  const [staff, setStaff] = useState<ApiStaff[]>([]);
  const [org, setOrg] = useState<OrgSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target>(manager ? null : ownStaffId);
  const [affected, setAffected] = useState<AffectedAppointment[] | null>(null);
  const [affectedError, setAffectedError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([
        settingsApi.get() as Promise<OrgSettings>,
        staffApi.list() as Promise<ApiStaff[]>,
      ]);
      setOrg(s);
      setStaff(list.filter(x => x.isActive !== false));
      setLoadError(null);
    } catch (e) {
      setLoadError(errMsg(e, 'Could not load availability.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const checkAffected = useCallback(async (t: Target) => {
    try {
      const rows = await availabilityApi.affected(t ?? undefined);
      setAffected(rows);
      setAffectedError(null);
    } catch (e) {
      setAffected(null);
      setAffectedError(errMsg(e, 'Could not check existing appointments.'));
    }
  }, []);

  useEffect(() => { if (manager || ownStaffId) void checkAffected(target); }, [target, manager, ownStaffId, checkAffected]);

  const visibleStaff = manager ? staff : staff.filter(s => s.id === ownStaffId);
  const selected = target ? staff.find(s => s.id === target) ?? null : null;
  const canEdit = target === null ? canBusiness : canStaff;

  const businessWeek = useMemo<WeekEdit | null>(() => {
    if (!org?.workingHours || !Object.keys(org.workingHours).length) return null;
    return weekFromStored(org.workingHours, []);
  }, [org]);

  async function afterChange() {
    await reload();
    await checkAffected(target);
  }

  if (loading) {
    return <div className="page-container"><PageTitle icon={Clock} title="Availability" /><div className="flex justify-center py-16"><Spinner /></div></div>;
  }

  return (
    <div className="page-container space-y-6">
      <PageTitle
        icon={Clock}
        title="Availability"
        description={manager ? 'Set working hours and block dates for your business and staff.' : 'Your working hours and blocked dates.'}
      />

      {loadError && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</div>}

      {!manager && !ownStaffId && (
        <div className="panel p-6 text-sm text-text-secondary">Your sign-in is not linked to a provider, so there are no working hours to show. Ask the business owner if you need access.</div>
      )}

      {(manager || ownStaffId) && (
        <>
          {/* Whose availability: shown only when there is more than one schedule to choose from. */}
          {manager && visibleStaff.length > 0 && (
            visibleStaff.length === 1 ? (
              <Segmented
                label="Whose availability"
                value={target ?? '__business'}
                onChange={v => setTarget(v === '__business' ? null : v)}
                options={[{ value: '__business', label: 'Business hours' }, { value: visibleStaff[0].id, label: visibleStaff[0].name }]}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <label htmlFor="availability-target" className="text-[15px] font-medium text-text-primary">Showing</label>
                <select
                  id="availability-target"
                  value={target ?? ''}
                  onChange={e => setTarget(e.target.value || null)}
                  className="h-11 min-w-[14rem] rounded-lg border border-border bg-white px-3 text-[15px] font-medium text-text-primary shadow-card focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">Business hours</option>
                  {visibleStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )
          )}

          {affected && affected.length > 0 && <AffectedPanel rows={affected} />}
          {affectedError && <p className="text-sm text-text-secondary">{affectedError}</p>}

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-6 items-start">
            <WeeklyHours
              key={`hours-${target ?? 'business'}`}
              target={target}
              targetName={selected?.name ?? 'Business'}
              stored={target === null ? org?.workingHours ?? {} : selected?.workingHours ?? {}}
              business={target === null ? null : businessWeek}
              canEdit={canEdit}
              onSaved={afterChange}
            />
            <DateExceptions
              key={`ex-${target ?? 'business'}`}
              target={target}
              targetName={selected?.name ?? 'the business'}
              canEditOwn={canEdit}
              onChanged={afterChange}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ─── Affected appointments ─────────────────────────────────────────────────

function AffectedPanel({ rows }: { rows: AffectedAppointment[] }) {
  return (
    <section aria-labelledby="affected-title" className="rounded-2xl border border-amber-200 bg-amber-50 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-6 h-6 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="affected-title" className="text-lg font-semibold text-amber-900">
            {rows.length} future appointment{rows.length === 1 ? '' : 's'} outside the current availability
          </h2>
          <p className="text-sm text-amber-800 mt-0.5">These were not changed automatically. Open each one to reschedule or cancel it, and let the customer know.</p>
          <ul className="mt-4 divide-y divide-amber-200 rounded-xl bg-white/70 border border-amber-200">
            {rows.map(a => (
              <li key={a.id}>
                <Link to={`/appointments/${a.id}`} className="flex items-center gap-3 px-4 py-3 min-h-[56px] hover:bg-white transition-colors">
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-medium text-text-primary truncate">
                      {formatDate(a.date, 'EEE, d MMM yyyy')} · {fmt(a.startTime)} – {fmt(a.endTime)} · {a.customerName}
                    </p>
                    <p className="text-sm text-text-secondary truncate">{a.serviceName} with {a.staffName} — {a.problem}</p>
                  </div>
                  <ChevronRight className="w-5 h-5 text-text-muted shrink-0" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// ─── Weekly working hours ──────────────────────────────────────────────────

function WeeklyHours({ target, targetName, stored, business, canEdit, onSaved }: {
  target: Target; targetName: string; stored: StoredHours; business: WeekEdit | null; canEdit: boolean; onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [week, setWeek] = useState<WeekEdit | null>(null);
  const [breaks, setBreaks] = useState<ScheduleBreak[]>([]);
  const [breaksError, setBreaksError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const notSaved = !stored || Object.keys(stored).length === 0;

  useEffect(() => {
    let alive = true;
    availabilityApi.breaks(target ?? undefined)
      .then(all => {
        if (!alive) return;
        const own = all.filter(b => (target === null ? b.staffId === null : b.staffId === target));
        setBreaks(own);
        setWeek(weekFromStored(stored, own, notSaved));
      })
      .catch(e => {
        if (!alive) return;
        // Without the breaks the ranges are shown as one window per day; saving would drop breaks, so editing is blocked.
        setBreaksError(errMsg(e, 'Could not load breaks.'));
        setWeek(weekFromStored(stored, [], notSaved));
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const problems = useMemo(() => (week ? weekProblems(week, business) : {}), [week, business]);
  const hasProblems = Object.keys(problems).length > 0;
  const editable = canEdit && !breaksError;

  function update(day: Weekday, fn: (d: WeekEdit[Weekday]) => WeekEdit[Weekday]) {
    setWeek(w => (w ? { ...w, [day]: fn(w[day]) } : w));
    setDirty(true);
  }

  async function save() {
    if (!week) return;
    setShowErrors(true);
    if (hasProblems) { toast.error('Check the highlighted days', 'Some working hours need fixing before saving.'); return; }
    setSaving(true);
    try {
      const { hours, breaks: nextBreaks } = storedFromWeek(week);
      if (target === null) await settingsApi.update({ workingHours: hours });
      else await staffApi.update(target, { workingHours: hours });
      // Replace this schedule's weekly breaks with the gaps between the ranges.
      const key = (b: { weekday: string; startTime: string; endTime: string }) => `${b.weekday}|${b.startTime}|${b.endTime}`;
      const wanted = new Set(nextBreaks.map(key));
      const existing = new Set(breaks.map(key));
      for (const b of breaks) if (!wanted.has(key(b))) await availabilityApi.removeBreak(b.id);
      const added: ScheduleBreak[] = [];
      for (const b of nextBreaks) {
        if (!existing.has(key(b))) added.push(await availabilityApi.addBreak({ staffId: target, weekday: b.weekday, startTime: b.startTime, endTime: b.endTime }));
      }
      setBreaks([...breaks.filter(b => wanted.has(key(b))), ...added]);
      setDirty(false);
      setShowErrors(false);
      toast.success('Working hours saved', `${targetName}'s weekly hours were updated.`);
      await onSaved();
    } catch (e) {
      toast.error('Working hours not saved', errMsg(e, 'Please try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="weekly-hours-title">
      <PanelHeader
        icon={Clock}
        title={target === null ? 'Business Working Hours' : `${targetName}'s Working Hours`}
        description={target === null
          ? 'Opening days and times. Staff hours must fall within these.'
          : 'When this provider takes appointments, within business hours.'}
        action={!canEdit ? <span className="inline-flex items-center gap-1.5 text-sm text-text-secondary"><Lock className="w-4 h-4" aria-hidden="true" />View only</span> : undefined}
      />
      <h2 id="weekly-hours-title" className="sr-only">Weekly working hours</h2>

      {notSaved && (
        <p className="mx-5 sm:mx-6 mb-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">
          {target === null ? 'No business hours are saved yet — staff hours alone apply until you save these.' : 'No hours are saved yet for this provider.'}
        </p>
      )}
      {breaksError && canEdit && <p role="alert" className="mx-5 sm:mx-6 mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{breaksError} Editing is turned off so breaks are not lost.</p>}

      {!week ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {WEEKDAYS.map(day => {
            const d = week[day];
            const problem = showErrors || dirty ? problems[day] : undefined;
            return (
              <li key={day} className="px-5 sm:px-6 py-4">
                <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-5">
                  <div className="flex items-center justify-between sm:justify-start gap-3 sm:w-44 shrink-0 sm:pt-2">
                    <span className="text-[15px] font-semibold text-text-primary w-24">{WEEKDAY_LABEL[day]}</span>
                    <div className="flex items-center gap-2">
                      <Switch checked={d.open} disabled={!editable} label={`${WEEKDAY_LABEL[day]} open`} onChange={v => update(day, x => ({ ...x, open: v }))} />
                      <span className={cn('text-sm w-12', d.open ? 'text-primary font-medium' : 'text-text-muted')}>{d.open ? 'Open' : 'Closed'}</span>
                    </div>
                  </div>
                  {d.open && (
                    <div className="flex-1 min-w-0 space-y-2">
                      {d.ranges.map((r, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                          <TimeSelect label={`${WEEKDAY_LABEL[day]} range ${i + 1} start`} value={r.start} disabled={!editable}
                            onChange={v => update(day, x => ({ ...x, ranges: x.ranges.map((y, j) => (j === i ? { ...y, start: v } : y)) }))} />
                          <span className="text-text-muted">to</span>
                          <TimeSelect label={`${WEEKDAY_LABEL[day]} range ${i + 1} end`} value={r.end} disabled={!editable}
                            onChange={v => update(day, x => ({ ...x, ranges: x.ranges.map((y, j) => (j === i ? { ...y, end: v } : y)) }))} />
                          {editable && d.ranges.length > 1 && (
                            <button type="button" aria-label={`Remove ${WEEKDAY_LABEL[day]} range ${i + 1}`}
                              onClick={() => update(day, x => ({ ...x, ranges: x.ranges.filter((_, j) => j !== i) }))}
                              className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-text-muted hover:text-red-600 hover:bg-red-50">
                              <Trash2 className="w-4 h-4" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      ))}
                      {editable && (
                        <button type="button"
                          onClick={() => update(day, x => {
                            const last = [...x.ranges].sort((a, b) => a.end.localeCompare(b.end)).pop();
                            const start = last ? last.end : '09:00';
                            const idx = TIME_STEPS.indexOf(start);
                            const end = idx >= 0 && idx + 4 < TIME_STEPS.length ? TIME_STEPS[idx + 4] : '23:59';
                            return { ...x, ranges: [...x.ranges, { start, end }] };
                          })}
                          className="inline-flex items-center gap-1.5 min-h-[40px] text-sm font-medium text-primary hover:text-primary-dark">
                          <Plus className="w-4 h-4" aria-hidden="true" />Add time range
                        </button>
                      )}
                      {d.ranges.length > 1 && <p className="text-xs text-text-muted">Gaps between ranges are breaks and cannot be booked.</p>}
                    </div>
                  )}
                </div>
                {problem && <p role="alert" className="mt-2 sm:ml-[13.25rem] text-sm text-red-600">{problem}</p>}
              </li>
            );
          })}
        </ul>
      )}

      {editable && (
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-5 sm:px-6 py-4">
          {dirty && <span className="text-sm text-text-secondary mr-auto">Unsaved changes</span>}
          <button type="button" className="btn-primary min-h-[44px] px-5" disabled={saving || !dirty} onClick={save}>
            {saving ? 'Saving…' : 'Save Working Hours'}
          </button>
        </div>
      )}
    </section>
  );
}

// ─── Date exceptions ───────────────────────────────────────────────────────

type ExceptionKind = 'day' | 'period' | 'hours';
type ExceptionRow =
  | { kind: 'off'; sortDate: string; item: TimeOffPeriod }
  | { kind: 'hours'; sortDate: string; item: DateHours };

function DateExceptions({ target, targetName, canEditOwn, onChanged }: { target: Target; targetName: string; canEditOwn: boolean; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const today = localDateISO();
  const [off, setOff] = useState<TimeOffPeriod[] | null>(null);
  const [hours, setHours] = useState<DateHours[] | null>(null);
  const [offError, setOffError] = useState<string | null>(null);
  const [hoursError, setHoursError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = { staffId: target ?? undefined, from: today };
    availabilityApi.timeOff(params)
      .then(rows => { setOff(rows); setOffError(null); })
      .catch(e => { setOff([]); setOffError(errMsg(e, 'Could not load blocked dates.')); });
    availabilityApi.dateHours(params)
      .then(rows => { setHours(rows); setHoursError(null); })
      .catch(e => { setHours([]); setHoursError(errMsg(e, 'Could not load special hours.')); });
  }, [target, today]);

  useEffect(() => { load(); }, [load]);

  // The business view lists closures of the whole business; a provider's view lists their own exceptions and,
  // for information, business-wide closures that also apply to them.
  const rows: ExceptionRow[] = useMemo(() => {
    const keep = (staffId: string | null) => (target === null ? staffId === null : staffId === target || staffId === null);
    return [
      ...(off ?? []).filter(o => keep(o.staffId)).map(item => ({ kind: 'off' as const, sortDate: `${item.startDate} ${item.startTime ?? ''}`, item })),
      ...(hours ?? []).filter(h => keep(h.staffId)).map(item => ({ kind: 'hours' as const, sortDate: `${item.date} ${item.startTime}`, item })),
    ].sort((a, b) => a.sortDate.localeCompare(b.sortDate));
  }, [off, hours, target]);

  async function remove(row: ExceptionRow) {
    const id = row.item.id;
    setRemoving(id);
    try {
      if (row.kind === 'off') await availabilityApi.removeTimeOff(id);
      else await availabilityApi.removeDateHours(id);
      toast.success('Exception removed');
      load();
      await onChanged();
    } catch (e) {
      toast.error('Could not remove', errMsg(e, 'Please try again.'));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="exceptions-title">
      <PanelHeader
        icon={CalendarX2}
        title="Date Exceptions"
        description={target === null ? 'Holidays, closures and special hours for the business.' : `Time off and special hours for ${targetName}.`}
        action={canEditOwn ? (
          <button type="button" className="btn-primary min-h-[44px]" onClick={() => setAdding(true)}>
            <Plus className="w-4 h-4" aria-hidden="true" />Add Exception
          </button>
        ) : undefined}
      />
      <h2 id="exceptions-title" className="sr-only">Date exceptions</h2>

      {(offError || hoursError) && (
        <p role="alert" className="mx-5 sm:mx-6 mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{[offError, hoursError].filter(Boolean).join(' ')}</p>
      )}

      {off === null || hours === null ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : rows.length === 0 ? (
        <div className="border-t border-border px-6 py-10 text-center">
          <CalendarClock className="w-10 h-10 text-text-muted mx-auto mb-2" aria-hidden="true" />
          <p className="text-[15px] font-medium text-text-primary">No upcoming exceptions</p>
          <p className="text-sm text-text-secondary mt-1">Block a day, a time period, or set different hours for a specific date.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map(row => {
            const businessWide = row.item.staffId === null;
            const removable = canEditOwn && (target === null || !businessWide);
            const { title, detail, tone } = describe(row);
            return (
              <li key={`${row.kind}-${row.item.id}`} className="flex items-start gap-3 px-5 sm:px-6 py-4">
                <span className={cn('mt-0.5 inline-flex items-center rounded-md px-2.5 py-1 text-xs font-semibold whitespace-nowrap', tone)}>
                  {row.kind === 'hours' ? 'Special hours' : (row.item as TimeOffPeriod).wholeDay ? 'Closed' : 'Blocked'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-medium text-text-primary">{title}</p>
                  <p className="text-sm text-text-secondary">
                    {detail}
                    {target !== null && businessWide && <span className="inline-flex items-center gap-1 ml-1"><Building2 className="w-3.5 h-3.5" aria-hidden="true" />Applies to the whole business</span>}
                  </p>
                  {row.item.reason && <p className="text-sm text-text-muted mt-0.5">{row.item.reason}</p>}
                </div>
                {removable && (
                  <button type="button" onClick={() => remove(row)} disabled={removing === row.item.id}
                    aria-label={`Remove exception on ${title}`}
                    className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-text-muted hover:text-red-600 hover:bg-red-50 disabled:opacity-50 shrink-0">
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AddExceptionModal
        open={adding}
        target={target}
        targetName={targetName}
        onClose={() => setAdding(false)}
        onAdded={async () => { setAdding(false); load(); await onChanged(); }}
      />
    </section>
  );
}

function describe(row: ExceptionRow): { title: string; detail: string; tone: string } {
  const d = (iso: string) => formatDate(iso, 'EEE, d MMM yyyy');
  if (row.kind === 'hours') {
    const h = row.item;
    return { title: d(h.date), detail: `Open ${fmt(h.startTime)} – ${fmt(h.endTime)} instead of the usual hours.`, tone: 'bg-[#E3EEFF] text-[#2563EB]' };
  }
  const o = row.item;
  const dates = o.startDate === o.endDate ? d(o.startDate) : `${d(o.startDate)} – ${d(o.endDate)}`;
  if (o.wholeDay) return { title: dates, detail: o.startDate === o.endDate ? 'Closed all day.' : 'Closed all day on each date.', tone: 'bg-[#FDE4E4] text-[#DC2626]' };
  return { title: dates, detail: `Not bookable ${fmt(o.startTime ?? '')} – ${fmt(o.endTime ?? '')}.`, tone: 'bg-amber-50 text-amber-700' };
}

function AddExceptionModal({ open, target, targetName, onClose, onAdded }: {
  open: boolean; target: Target; targetName: string; onClose: () => void; onAdded: () => Promise<void>;
}) {
  const toast = useToast();
  const today = localDateISO();
  const [kind, setKind] = useState<ExceptionKind>('day');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [startTime, setStartTime] = useState('12:00');
  const [endTime, setEndTime] = useState('14:00');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setKind('day'); setStartDate(today); setEndDate(today); setStartTime('12:00');
      setEndTime('14:00'); setReason(''); setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function validate(): string | null {
    if (!startDate) return 'Choose a date.';
    if (startDate < today) return 'Choose today or a later date.';
    if (kind === 'day' && endDate < startDate) return 'The end date must be on or after the start date.';
    if (kind !== 'day' && endTime <= startTime) return 'The end time must be after the start time.';
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = validate();
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const r = reason.trim() || undefined;
      if (kind === 'day') await availabilityApi.addTimeOff({ staffId: target, startDate, endDate, reason: r });
      else if (kind === 'period') await availabilityApi.addTimeOff({ staffId: target, startDate, endDate: startDate, startTime, endTime, reason: r });
      else await availabilityApi.addDateHours({ staffId: target, date: startDate, startTime, endTime, reason: r });
      toast.success('Exception added', 'Existing appointments were not changed.');
      await onAdded();
    } catch (err) {
      setError(errMsg(err, 'Could not add the exception.'));
    } finally {
      setBusy(false);
    }
  }

  const label = 'block text-sm font-medium text-text-primary mb-1.5';
  const input = 'w-full h-11 rounded-lg border border-border bg-white px-3 text-[15px] focus:outline-none focus:ring-2 focus:ring-primary';

  return (
    <Modal isOpen={open} onClose={onClose} title="Add Date Exception" description={`For ${target === null ? 'the whole business' : targetName}. Existing appointments are never cancelled automatically.`}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Segmented
          label="Exception type"
          value={kind}
          onChange={setKind}
          options={[{ value: 'day', label: 'Block full day' }, { value: 'period', label: 'Block time period' }, { value: 'hours', label: 'Different hours' }]}
        />
        <div className={cn('grid gap-3', kind === 'day' ? 'sm:grid-cols-2' : 'grid-cols-1')}>
          <div>
            <label htmlFor="ex-start" className={label}>{kind === 'day' ? 'From date' : 'Date'}</label>
            <input id="ex-start" type="date" min={today} className={input} value={startDate}
              onChange={e => { setStartDate(e.target.value); if (endDate < e.target.value) setEndDate(e.target.value); }} />
          </div>
          {kind === 'day' && (
            <div>
              <label htmlFor="ex-end" className={label}>To date</label>
              <input id="ex-end" type="date" min={startDate || today} className={input} value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          )}
        </div>
        {kind !== 'day' && (
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <span className={label}>{kind === 'hours' ? 'Open from' : 'Blocked from'}</span>
              <TimeSelect label="Start time" value={startTime} onChange={setStartTime} />
            </div>
            <div>
              <span className={label}>to</span>
              <TimeSelect label="End time" value={endTime} onChange={setEndTime} />
            </div>
          </div>
        )}
        {kind === 'hours' && <p className="text-sm text-text-secondary">These hours replace the usual weekly hours on this date only.</p>}
        <div>
          <label htmlFor="ex-reason" className={label}>Reason <span className="font-normal text-text-muted">(optional)</span></label>
          <input id="ex-reason" className={input} maxLength={200} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Public holiday" />
        </div>
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" className="btn-secondary min-h-[44px]" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary min-h-[44px]" disabled={busy}>{busy ? 'Saving…' : 'Add Exception'}</button>
        </div>
      </form>
    </Modal>
  );
}
