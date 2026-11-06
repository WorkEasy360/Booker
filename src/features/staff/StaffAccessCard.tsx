import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Mail } from 'lucide-react';
import { Badge, Button, ConfirmModal, Select, useToast } from '@/components/ui';
import { settingsApi, staffApi, type StaffAccount, type StaffInvitation } from '@/api/client';
import { formatDate } from '@/lib/utils';

interface Props {
  staff: { id: string; name: string; email: string; isActive: boolean; account?: StaffAccount };
  /** Called after any change so the page can reload the staff record. */
  onChanged: () => void;
}

const ROLE_OPTIONS = [
  { value: 'staff', label: 'Staff — sees only their own schedule' },
  { value: 'manager', label: 'Manager — runs appointments, customers, services and reports' },
];

const STATUS_BADGE: Record<StaffInvitation['status'], 'default' | 'success' | 'warning' | 'info'> = {
  pending: 'info', accepted: 'success', expired: 'warning', revoked: 'default',
};

/**
 * Sign-in access for one staff member. Invitations are emailed to the staff member's own address; the link is never
 * shown here, so accepting it proves they control that inbox.
 */
export function StaffAccessCard({ staff, onChanged }: Props) {
  const toast = useToast();
  const [role, setRole] = useState<'staff' | 'manager'>('staff');
  const [sending, setSending] = useState<boolean | null>(null);
  const [invitations, setInvitations] = useState<StaffInvitation[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const status = staff.account?.status ?? 'none';

  const load = useCallback(() => {
    settingsApi.emailStatus().then(s => setSending(s.sending)).catch(() => setSending(null));
    staffApi.invitations(staff.id).then(setInvitations).catch(() => setInvitations([]));
  }, [staff.id]);
  useEffect(load, [load]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      onChanged();
      load();
    } catch (e) {
      toast.error('Sign-in access was not changed', (e as Error).message);
    } finally {
      setBusy(false);
      setConfirmOff(false);
      setConfirmReset(false);
    }
  }

  const pending = invitations.find(i => i.status === 'pending');
  const canInvite = staff.isActive && sending === true;

  return (
    <div className="card p-5" aria-labelledby="staff-access-title">
      <div className="flex items-center gap-2 mb-3">
        <KeyRound className="w-4 h-4 text-text-muted" aria-hidden="true" />
        <h3 id="staff-access-title" className="text-sm font-semibold text-text-primary">Sign-in access</h3>
      </div>

      {status === 'active' && (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            {staff.name} can sign in with <strong className="text-text-primary">{staff.email}</strong> as {staff.account?.role === 'manager' ? 'a manager' : 'staff'}.
          </p>
          <p className="text-xs text-text-muted" data-two-factor={staff.account?.twoFactor ? 'on' : 'off'}>
            Two-factor sign-in: {staff.account?.twoFactor ? 'on' : 'off'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmOff(true)}>Turn off sign-in</Button>
            {staff.account?.twoFactor && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmReset(true)}>Reset two-factor sign-in</Button>
            )}
          </div>
        </div>
      )}

      {status === 'disabled' && (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">Sign-in is turned off. {staff.name} cannot sign in until it is turned back on.</p>
          <Button variant="secondary" size="sm" disabled={busy || !staff.isActive}
            onClick={() => run(() => staffApi.setAccess(staff.id, true), `${staff.name} can sign in again`)}>
            Turn sign-in back on
          </Button>
          {!staff.isActive && <p className="text-xs text-text-muted">Activate this staff member first.</p>}
        </div>
      )}

      {(status === 'none' || status === 'invited') && (
        <div className="space-y-3">
          {pending ? (
            <p className="text-sm text-text-secondary" data-invite-status="pending">
              <Mail className="inline w-3.5 h-3.5 mr-1 -mt-0.5" aria-hidden="true" />
              Invitation emailed to <strong className="text-text-primary">{pending.email}</strong> as {pending.role}; it expires {formatDate(pending.expiresAt, 'MMM d, h:mm a')}.
            </p>
          ) : (
            <p className="text-sm text-text-secondary">
              {staff.name} cannot sign in yet. Send an invitation to <strong className="text-text-primary">{staff.email}</strong>; they choose their own password from the email.
            </p>
          )}
          <Select label="Sign-in role" value={role} onChange={e => setRole(e.target.value as 'staff' | 'manager')} options={ROLE_OPTIONS} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || !canInvite}
              onClick={() => run(() => staffApi.invite(staff.id, role), `Invitation emailed to ${staff.email}`)}>
              {pending ? 'Send a new invitation' : 'Send invitation'}
            </Button>
            {pending && (
              <Button variant="secondary" size="sm" disabled={busy}
                onClick={() => run(() => staffApi.revokeInvitation(staff.id, pending.id), 'Invitation cancelled')}>
                Cancel invitation
              </Button>
            )}
          </div>
          {!staff.isActive && <p className="text-xs text-text-muted">Activate this staff member before inviting them.</p>}
          {staff.isActive && sending === false && (
            <p className="text-xs text-amber-700">Email sending is not set up, so invitations cannot be delivered. See Notifications for the settings.</p>
          )}
          {staff.isActive && sending === null && <p className="text-xs text-text-muted">Checking email setup…</p>}
        </div>
      )}

      {invitations.length > 0 && (
        <div className="mt-4 pt-3 border-t border-border">
          <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Invitation history</p>
          <ul className="space-y-1.5">
            {invitations.slice(0, 5).map(inv => (
              <li key={inv.id} className="flex items-center justify-between gap-2 text-xs text-text-secondary">
                <span className="truncate">{formatDate(inv.createdAt, 'MMM d, h:mm a')} · {inv.role}</span>
                <Badge size="sm" variant={STATUS_BADGE[inv.status]}>{inv.status}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmModal
        isOpen={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => run(() => staffApi.resetTwoFactor(staff.id), `Two-factor sign-in reset for ${staff.name}`)}
        title={`Reset two-factor sign-in for ${staff.name}`}
        message={`Only do this if ${staff.name} has lost both their authenticator app and their recovery codes. They will be signed out everywhere, can then sign in with their password alone, and should set up two-factor sign-in again.`}
        confirmLabel="Reset two-factor sign-in"
        variant="warning"
        loading={busy}
      />

      <ConfirmModal
        isOpen={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={() => run(() => staffApi.setAccess(staff.id, false), `${staff.name} can no longer sign in`)}
        title={`Turn off sign-in for ${staff.name}`}
        message={`${staff.name} will be signed out everywhere and cannot sign in until you turn it back on. Their staff record and appointments are not changed.`}
        confirmLabel="Turn off sign-in"
        variant="warning"
        loading={busy}
      />
    </div>
  );
}
