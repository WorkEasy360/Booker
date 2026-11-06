import { Router } from 'express';
import { z } from 'zod';
import db from '../db/init';
import { requireAuth, requirePermission, type AuthRequest } from '../middleware/auth';
import { configuredProviders } from '../services/payments/providers';
import {
  WEBHOOK_EVENTS, createEndpoint, deleteEndpoint, endpointUrlProblem, listDeliveriesFor, listEndpoints, processWebhookDeliveries, queueWebhookEvent,
} from '../services/integrations/webhooks';
import {
  OAUTH_PROVIDERS, authorizeUrl, clientCredentials, completeConnection, connectionStatus, disconnect, isOAuthProvider, readState,
} from '../services/integrations/oauth';

// What is connected and what is not, outgoing webhooks (and Zapier), and connecting accounts at other services.
// Nothing here reports a connection that has not really been made.

const router = Router();
router.use(requireAuth);
const canManage = requirePermission('settings:write');

router.get('/status', requirePermission('catalog:read'), (req: AuthRequest, res) => {
  res.json({
    data: {
      payments: configuredProviders(),
      accounts: Object.fromEntries(Object.entries(OAUTH_PROVIDERS).map(([p, spec]) => [p, {
        name: spec.name, configured: !!clientCredentials(p as keyof typeof OAUTH_PROVIDERS), scopes: spec.scopes,
        ...connectionStatus(req.user!.orgId, p as keyof typeof OAUTH_PROVIDERS),
      }])),
      sms: { twilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) },
      webhooks: { endpoints: listEndpoints(req.user!.orgId).length },
    },
  });
});

// ─── Outgoing webhooks (also used for Zapier "Catch Hook" addresses) ─────────

const EndpointSchema = z.object({
  url: z.string().trim().min(8).max(2048),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Choose at least one event').max(WEBHOOK_EVENTS.length),
  description: z.string().trim().max(200).optional(),
});

router.get('/webhooks', canManage, (req: AuthRequest, res) => {
  res.json({ data: { events: WEBHOOK_EVENTS, endpoints: listEndpoints(req.user!.orgId) } });
});

router.post('/webhooks', canManage, (req: AuthRequest, res, next) => {
  try {
    const parsed = EndpointSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' }); return; }
    const problem = endpointUrlProblem(parsed.data.url);
    if (problem) { res.status(400).json({ error: problem }); return; }
    if (listEndpoints(req.user!.orgId).length >= 10) { res.status(409).json({ error: 'A business can have at most 10 webhook addresses' }); return; }
    // The signing secret is shown once, here, and stored only encrypted.
    res.status(201).json({ data: createEndpoint(req.user!.orgId, parsed.data, req.user!.sub) });
  } catch (err) { next(err); }
});

router.delete('/webhooks/:id', canManage, (req: AuthRequest, res) => {
  if (!deleteEndpoint(req.user!.orgId, req.params.id)) { res.status(404).json({ error: 'Webhook not found' }); return; }
  res.json({ data: { deleted: true } });
});

router.get('/webhooks/:id/deliveries', canManage, (req: AuthRequest, res) => {
  if (!db.prepare('SELECT 1 FROM webhook_endpoints WHERE id = ? AND organization_id = ?').get(req.params.id, req.user!.orgId)) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  res.json({ data: listDeliveriesFor(req.user!.orgId, req.params.id) });
});

/** Sends a "ping" event to one endpoint now and reports what happened. */
router.post('/webhooks/:id/test', canManage, async (req: AuthRequest, res, next) => {
  try {
    if (!db.prepare('SELECT 1 FROM webhook_endpoints WHERE id = ? AND organization_id = ?').get(req.params.id, req.user!.orgId)) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }
    if (!queueWebhookEvent(req.user!.orgId, 'ping', { message: 'Test event from WorkEasy360' }, req.params.id)) {
      res.status(409).json({ error: 'This webhook is turned off' });
      return;
    }
    await processWebhookDeliveries();
    res.json({ data: (listDeliveriesFor(req.user!.orgId, req.params.id) as unknown[])[0] });
  } catch (err) { next(err); }
});

// ─── Connected accounts (OAuth) ──────────────────────────────────────────────

router.get('/:provider/connect', canManage, (req: AuthRequest, res) => {
  const p = req.params.provider;
  if (!isOAuthProvider(p)) { res.status(404).json({ error: 'Unknown integration' }); return; }
  const url = authorizeUrl(p, req.user!.orgId, req.user!.sub);
  if (!url) {
    res.status(503).json({ error: `${OAUTH_PROVIDERS[p].name} is not set up on this server. An administrator must add its client id and secret.`, code: 'INTEGRATION_NOT_CONFIGURED' });
    return;
  }
  res.json({ data: { url } });
});

/** Where the provider sends the browser back. The same signed-in user must arrive with an unaltered, unexpired state. */
router.get('/:provider/callback', canManage, async (req: AuthRequest, res, next) => {
  try {
    const p = req.params.provider;
    const back = (q: string) => res.redirect(`${(process.env.PUBLIC_APP_URL ?? '').replace(/\/$/, '')}/integrations?${q}`);
    if (!isOAuthProvider(p)) { res.status(404).json({ error: 'Unknown integration' }); return; }
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) { back(`error=${encodeURIComponent('The connection was not allowed')}`); return; }
    const s = state ? readState(p, state) : null;
    if (!s || s.userId !== req.user!.sub || s.orgId !== req.user!.orgId || !code) {
      res.status(400).json({ error: 'This connection link is not valid or has expired. Start again from Integrations.', code: 'INVALID_OAUTH_STATE' });
      return;
    }
    const done = await completeConnection(p, s.orgId, s.userId, code, s.verifier);
    back(done.ok ? `connected=${p}` : `error=${encodeURIComponent(done.error)}`);
  } catch (err) { next(err); }
});

router.delete('/:provider', canManage, async (req: AuthRequest, res, next) => {
  try {
    const p = req.params.provider;
    if (!isOAuthProvider(p)) { res.status(404).json({ error: 'Unknown integration' }); return; }
    if (!(await disconnect(req.user!.orgId, p))) { res.status(404).json({ error: 'Not connected' }); return; }
    res.json({ data: { disconnected: true } });
  } catch (err) { next(err); }
});

export default router;
