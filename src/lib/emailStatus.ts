// Wording for the server's real email outcome. Never claim delivery unless the server says "sent".

export type EmailStatus = 'sent' | 'failed' | 'not_configured' | 'retrying';
export interface EmailOutcome { status: EmailStatus; error?: string; nextAttemptAt?: string }
type Kind = 'confirmation' | 'reschedule' | 'cancellation';

const NOUN: Record<Kind, string> = {
  confirmation: 'confirmation email',
  reschedule: 'email with the new time',
  cancellation: 'cancellation email',
};

/** Message for the customer on public pages. */
export function customerEmailMessage(kind: Kind, status: EmailStatus | undefined, address?: string): { tone: 'success' | 'warning'; text: string } | null {
  if (!status) return null;
  if (status === 'sent') return { tone: 'success', text: `We sent a ${NOUN[kind]}${address ? ` to ${address}` : ''}.` };
  if (status === 'failed') return { tone: 'warning', text: `We could not send a ${NOUN[kind]}. Please keep your booking reference.` };
  if (status === 'retrying') return { tone: 'warning', text: `We could not send the ${NOUN[kind]} yet and will keep trying for about 20 minutes. Please keep your booking reference.` };
  return { tone: 'warning', text: `This business has not set up email, so no ${NOUN[kind]} was sent. Please keep your booking reference.` };
}

/** One-line note for admin toasts after a change that notifies the customer. */
export function adminEmailNote(kind: Kind, outcome: EmailOutcome | undefined): { ok: boolean; text: string } | null {
  if (!outcome) return null;
  if (outcome.status === 'sent') return { ok: true, text: `The customer was sent a ${NOUN[kind]}.` };
  if (outcome.status === 'failed') {
    return { ok: false, text: `The ${NOUN[kind]} to the customer failed${outcome.error ? ` (${outcome.error})` : ''}. You can resend it from the appointment page.` };
  }
  if (outcome.status === 'retrying') {
    return { ok: false, text: `The ${NOUN[kind]} could not be sent yet${outcome.error ? ` (${outcome.error})` : ''}. It will be retried automatically; check the appointment's email history.` };
  }
  return { ok: false, text: `No ${NOUN[kind]} was sent because email delivery is not configured.` };
}

interface ToastLike { success: (t: string, m?: string) => void; warning: (t: string, m?: string) => void }

/** Success toast for the change itself, plus a warning when the customer was not emailed. */
export function toastWithEmailOutcome(toast: ToastLike, title: string, detail: string, kind: Kind, outcome: EmailOutcome | undefined) {
  const note = adminEmailNote(kind, outcome);
  toast.success(title, note?.ok ? `${detail} ${note.text}` : detail);
  if (note && !note.ok) toast.warning('Customer not emailed', note.text);
}
