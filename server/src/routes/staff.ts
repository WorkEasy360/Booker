import express, { Router } from 'express';
import { z } from 'zod';
import { phoneField } from '../lib/phone';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { requireAuth, requireAdmin, requirePermission, type AuthRequest } from '../middleware/auth';
import { missingIds, syncStaffServices, syncStaffWorkspaces } from '../services/relations';
import { can } from '../auth/permissions';
import {
  accountSummaries, inviteStaff, listInvitations, revokeInvitation, revokeOpenInvitations, setStaffAccess, endStaffSessions,
  resetStaffTwoFactor,
} from '../services/staff-invitations';
import { RULES, consume, sendRateLimited } from '../middleware/rate-limit';
import { removeImage, saveImage, staffPhotoUrls } from '../services/media/media';
import { MAX_UPLOAD_BYTES } from '../services/media/image-check';

const router = Router();
router.use(requireAuth);

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const DaySchema = z.object({
  enabled: z.boolean(),
  start: z.string().regex(TIME, 'Use HH:MM (24-hour)'),
  end: z.string().regex(TIME, 'Use HH:MM (24-hour)'),
}).refine(d => !d.enabled || d.end > d.start, { message: 'End time must be after start time', path: ['end'] });

const WorkingHoursSchema = z.object(
  Object.fromEntries(DAYS.map(d => [d, DaySchema.optional()])) as Record<(typeof DAYS)[number], z.ZodOptional<typeof DaySchema>>,
).strict();

export const DEFAULT_WORKING_HOURS = Object.fromEntries(DAYS.map(d => [d, {
  enabled: !['saturday', 'sunday'].includes(d), start: '09:00', end: '17:00',
}]));

const StaffSchema = z.object({
  name: z.string()
    .trim()
    .min(1, 'Name is required')
    .max(100, 'Name must be 100 characters or fewer')
    .refine(s => !/[<>]/.test(s), 'Name must not contain HTML characters'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  phone: phoneField().optional(),
  role: z.enum(['admin', 'manager', 'staff']).default('staff'),
  title: z.string().trim().max(100).optional(),
  bio: z.string().max(1000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #00BF62').optional(),
  isActive: z.boolean().default(true),
  workspaceIds: z.array(z.string()).max(100).optional(),
  serviceIds: z.array(z.string()).max(200).optional(),
  workingHours: WorkingHoursSchema.optional(),
  bookingPageUrl: z.string().max(500).optional(),
});

function rowToStaff(row: Record<string, unknown>) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    email: row.email,
    phone: row.phone ?? null,
    role: row.role,
    title: row.title ?? null,
    bio: row.bio ?? null,
    color: row.color ?? '#00BF62',
    isActive: Boolean(row.is_active),
    workspaceIds: JSON.parse(row.workspace_ids as string ?? '[]'),
    serviceIds: JSON.parse(row.service_ids as string ?? '[]'),
    workingHours: JSON.parse(row.working_hours as string ?? '{}'),
    bookingPageUrl: row.booking_page_url ?? null,
    createdAt: row.created_at,
  };
}

function emailTaken(orgId: string, email: string, exceptId?: string): boolean {
  return !!db.prepare('SELECT 1 FROM staff WHERE organization_id = ? AND lower(email) = lower(?) AND id != ?')
    .get(orgId, email, exceptId ?? '');
}

/** Returns an error message when referenced services or workspaces are missing or belong to another organization. */
function invalidRefs(orgId: string, data: { serviceIds?: string[]; workspaceIds?: string[] }): string | null {
  const svc = missingIds('services', data.serviceIds ?? [], orgId);
  if (svc.length) return `Service not found: ${svc.join(', ')}`;
  const ws = missingIds('workspaces', data.workspaceIds ?? [], orgId);
  if (ws.length) return `Workspace not found: ${ws.join(', ')}`;
  return null;
}

const DUPLICATE = 'A staff member with this email already exists in your organization';

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/** Adds sign-in status for people who manage staff; others just see the staff record. */
function withAccounts(req: AuthRequest, rows: Record<string, unknown>[]) {
  const photos = staffPhotoUrls(req.user!.orgId);
  const withPhoto = (r: Record<string, unknown>) => ({ ...rowToStaff(r), photoUrl: photos.get(r.id as string) ?? null });
  if (!can(req.user!.role, 'staff:manage')) return rows.map(withPhoto);
  const accounts = accountSummaries(req.user!.orgId);
  return rows.map(r => ({ ...withPhoto(r), account: accounts.get(r.id as string) ?? { status: 'none' } }));
}

router.get('/', requirePermission('catalog:read'), (req: AuthRequest, res, next) => {
  try {
    const rows = db
      .prepare('SELECT * FROM staff WHERE organization_id = ? ORDER BY name')
      .all(req.user!.orgId) as Record<string, unknown>[];
    res.json({ data: withAccounts(req, rows) });
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('catalog:read'), (req: AuthRequest, res, next) => {
  try {
    const row = db
      .prepare('SELECT * FROM staff WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId) as Record<string, unknown> | undefined;
    if (!row) { res.status(404).json({ error: 'Staff member not found' }); return; }
    res.json({ data: withAccounts(req, [row])[0] });
  } catch (err) { next(err); }
});

router.post('/', requireAdmin, (req: AuthRequest, res, next) => {
  try {
    const data = StaffSchema.parse(req.body);
    const orgId = req.user!.orgId;
    const refError = invalidRefs(orgId, data);
    if (refError) { res.status(400).json({ error: refError }); return; }
    if (emailTaken(orgId, data.email)) { res.status(409).json({ error: DUPLICATE }); return; }

    const id = `staff-${nanoid(8)}`;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO staff (id, organization_id, name, email, phone, role, title, bio, color,
          is_active, workspace_ids, service_ids, working_hours, booking_page_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, orgId, data.name, data.email,
        data.phone || null, data.role, data.title || null, data.bio || null,
        data.color ?? '#00BF62', data.isActive ? 1 : 0,
        JSON.stringify(data.workspaceIds ?? []), JSON.stringify(data.serviceIds ?? []),
        JSON.stringify(data.workingHours ?? DEFAULT_WORKING_HOURS), data.bookingPageUrl ?? null
      );
      syncStaffServices(orgId, id, data.serviceIds ?? []);
      syncStaffWorkspaces(orgId, id, data.workspaceIds ?? []);
    })();
    const row = db.prepare('SELECT * FROM staff WHERE id = ?').get(id) as Record<string, unknown>;
    res.status(201).json({ data: rowToStaff(row) });
  } catch (err) {
    if (isUniqueViolation(err)) { res.status(409).json({ error: DUPLICATE }); return; }
    next(err);
  }
});

router.put('/:id', requireAdmin, (req: AuthRequest, res, next) => {
  try {
    const orgId = req.user!.orgId;
    const existing = db
      .prepare('SELECT id, email FROM staff WHERE id = ? AND organization_id = ?')
      .get(req.params.id, orgId) as { id: string; email: string | null } | undefined;
    if (!existing) { res.status(404).json({ error: 'Staff member not found' }); return; }

    const data = StaffSchema.partial().parse(req.body);
    const refError = invalidRefs(orgId, data);
    if (refError) { res.status(400).json({ error: refError }); return; }
    if (data.email !== undefined && emailTaken(orgId, data.email, req.params.id)) {
      res.status(409).json({ error: DUPLICATE });
      return;
    }
    const emailChanged = data.email !== undefined && data.email !== (existing.email ?? '').trim().toLowerCase();
    // A sign-in is tied to the address it was proven for; changing it here would hand the login to a new address.
    if (emailChanged && db.prepare('SELECT 1 FROM users WHERE staff_id = ?').get(req.params.id)) {
      res.status(409).json({ error: 'This staff member signs in with their current email address, so it cannot be changed here. Turn off their sign-in first.', code: 'EMAIL_LINKED_TO_SIGN_IN' });
      return;
    }

    const sets: string[] = [];
    const vals: unknown[] = [];

    if (data.name !== undefined) { sets.push('name = ?'); vals.push(data.name); }
    if (data.email !== undefined) { sets.push('email = ?'); vals.push(data.email); }
    if (data.phone !== undefined) { sets.push('phone = ?'); vals.push(data.phone || null); }
    if (data.role !== undefined) { sets.push('role = ?'); vals.push(data.role); }
    if (data.title !== undefined) { sets.push('title = ?'); vals.push(data.title || null); }
    if (data.bio !== undefined) { sets.push('bio = ?'); vals.push(data.bio || null); }
    if (data.color !== undefined) { sets.push('color = ?'); vals.push(data.color); }
    if (data.isActive !== undefined) { sets.push('is_active = ?'); vals.push(data.isActive ? 1 : 0); }
    if (data.workspaceIds !== undefined) { sets.push('workspace_ids = ?'); vals.push(JSON.stringify(data.workspaceIds)); }
    if (data.serviceIds !== undefined) { sets.push('service_ids = ?'); vals.push(JSON.stringify(data.serviceIds)); }
    if (data.workingHours !== undefined) { sets.push('working_hours = ?'); vals.push(JSON.stringify(data.workingHours)); }
    if (data.bookingPageUrl !== undefined) { sets.push('booking_page_url = ?'); vals.push(data.bookingPageUrl); }

    db.transaction(() => {
      if (sets.length) {
        db.prepare(`UPDATE staff SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
      }
      if (data.serviceIds !== undefined) syncStaffServices(orgId, req.params.id, data.serviceIds);
      if (data.workspaceIds !== undefined) syncStaffWorkspaces(orgId, req.params.id, data.workspaceIds);
      // Invitations were sent to the old address; deactivation ends any signed-in sessions.
      if (emailChanged) revokeOpenInvitations(req.params.id);
      if (data.isActive === false) { revokeOpenInvitations(req.params.id); endStaffSessions(req.params.id); }
    })();

    const row = db.prepare('SELECT * FROM staff WHERE id = ?').get(req.params.id) as Record<string, unknown>;
    res.json({ data: rowToStaff(row) });
  } catch (err) {
    if (isUniqueViolation(err)) { res.status(409).json({ error: DUPLICATE }); return; }
    next(err);
  }
});

router.delete('/:id', requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const result = db.transaction(() => {
      // Deleting a staff record also turns off their sign-in (all or nothing).
      if (db.prepare('SELECT 1 FROM staff WHERE id = ? AND organization_id = ?').get(req.params.id, req.user!.orgId)) {
        setStaffAccess(req.user!.orgId, req.params.id, false);
      }
      const r = db
        .prepare('DELETE FROM staff WHERE id = ? AND organization_id = ?')
        .run(req.params.id, req.user!.orgId);
      if (r.changes > 0) { syncStaffServices(req.user!.orgId, req.params.id, []); syncStaffWorkspaces(req.user!.orgId, req.params.id, []); }
      return r;
    })();
    if (result.changes === 0) { res.status(404).json({ error: 'Staff member not found' }); return; }
    await removeImage(req.user!.orgId, 'staff_photo', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

// ─── Photo ────────────────────────────────────────────────────────────────────

const staffExists = (req: AuthRequest) => !!db.prepare('SELECT 1 FROM staff WHERE id = ? AND organization_id = ?').get(req.params.id, req.user!.orgId);

// Sent as the request body itself (PNG, JPEG or WebP, checked from its bytes). Replaces the previous photo.
router.put('/:id/photo', requireAdmin, express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES + 1024 }), async (req: AuthRequest, res, next) => {
  try {
    if (!staffExists(req)) { res.status(404).json({ error: 'Staff member not found' }); return; }
    const limit = consume([{ rule: RULES.uploadOrg, key: req.user!.orgId }]);
    if (!limit.allowed) { sendRateLimited(res, limit.retryAfterMs); return; }
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await saveImage(req.user!.orgId, 'staff_photo', req.params.id, bytes, req.user!.sub);
    if (!result.ok) { res.status(result.status).json({ error: result.error, code: result.code }); return; }
    res.json({ data: result.media });
  } catch (err) { next(err); }
});

router.delete('/:id/photo', requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    if (!staffExists(req)) { res.status(404).json({ error: 'Staff member not found' }); return; }
    if (!(await removeImage(req.user!.orgId, 'staff_photo', req.params.id))) { res.status(404).json({ error: 'This staff member has no photo' }); return; }
    res.json({ data: { removed: true } });
  } catch (err) { next(err); }
});

// ─── Sign-in access ───────────────────────────────────────────────────────────

const InviteSchema = z.object({ role: z.enum(['staff', 'manager']).default('staff') });

router.post('/:id/invitations', requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const { role } = InviteSchema.parse(req.body ?? {});
    const limit = consume([{ rule: RULES.inviteSendOrg, key: req.user!.orgId }]);
    if (!limit.allowed) { sendRateLimited(res, limit.retryAfterMs); return; }
    const inviter = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user!.sub) as { name: string };
    const result = await inviteStaff(req.user!.orgId, req.params.id, role, { id: req.user!.sub, name: inviter.name });
    if (!result.ok) { res.status(result.status).json({ error: result.error, code: result.code }); return; }
    if (result.email.status !== 'sent') {
      res.status(502).json({
        error: `The invitation email could not be sent${result.email.error ? `: ${result.email.error}` : ''}. No invitation is open; try again.`,
        code: 'INVITE_NOT_DELIVERED', data: result,
      });
      return;
    }
    res.status(201).json({ data: result });
  } catch (err) { next(err); }
});

router.get('/:id/invitations', requireAdmin, (req: AuthRequest, res, next) => {
  try {
    if (!db.prepare('SELECT 1 FROM staff WHERE id = ? AND organization_id = ?').get(req.params.id, req.user!.orgId)) {
      res.status(404).json({ error: 'Staff member not found' });
      return;
    }
    res.json({ data: listInvitations(req.user!.orgId, req.params.id) });
  } catch (err) { next(err); }
});

router.delete('/:id/invitations/:invitationId', requireAdmin, (req: AuthRequest, res, next) => {
  try {
    if (!revokeInvitation(req.user!.orgId, req.params.id, req.params.invitationId)) {
      res.status(404).json({ error: 'No open invitation found' });
      return;
    }
    res.json({ data: { revoked: true } });
  } catch (err) { next(err); }
});

const AccessSchema = z.object({ enabled: z.boolean() });

// For a staff member who lost both their authenticator and recovery codes: they sign in with their password again
// and can set up two-factor sign-in anew. Their open sessions end.
router.post('/:id/two-factor/reset', requireAdmin, (req: AuthRequest, res, next) => {
  try {
    if (!db.prepare('SELECT 1 FROM staff WHERE id = ? AND organization_id = ?').get(req.params.id, req.user!.orgId)) {
      res.status(404).json({ error: 'Staff member not found' });
      return;
    }
    const outcome = resetStaffTwoFactor(req.user!.orgId, req.params.id);
    if (outcome === 'no_account') { res.status(404).json({ error: 'This staff member has no sign-in.' }); return; }
    if (outcome === 'not_enabled') { res.status(409).json({ error: 'Two-factor sign-in is not on for this staff member.' }); return; }
    res.json({ data: { reset: true } });
  } catch (err) { next(err); }
});

router.put('/:id/access', requireAdmin, (req: AuthRequest, res, next) => {
  try {
    const { enabled } = AccessSchema.parse(req.body);
    const staff = db.prepare('SELECT is_active FROM staff WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId) as { is_active: number } | undefined;
    if (!staff) { res.status(404).json({ error: 'Staff member not found' }); return; }
    if (enabled && !staff.is_active) { res.status(409).json({ error: 'Activate this staff member before turning their sign-in back on.' }); return; }
    if (setStaffAccess(req.user!.orgId, req.params.id, enabled) === 'no_account') {
      res.status(404).json({ error: 'This staff member has no sign-in yet. Send an invitation instead.' });
      return;
    }
    res.json({ data: { enabled } });
  } catch (err) { next(err); }
});

export default router;
