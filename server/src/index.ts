import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { errorHandler } from './middleware/error';
import { seedKnowledge } from './services/ai-knowledge';
import { indexKnowledgeDirectory } from './services/knowledge-indexer';
import { initEmail, recoverInterruptedEmails, startEmailWorker, stopEmailWorker } from './services/email/notify';
import { recoverInterruptedNotifications } from './services/email/notifications';
import { smtpTlsDescription, recipientAllowlistDescription } from './services/email/config';
import { initSecurityConfig } from './config/security';
import db from './db/init';
import { originGuard, trustedOrigins } from './middleware/origin';
import { createShutdown } from './shutdown';
import { mountWebApp } from './web-app';
import { agentConfig } from './services/ai-agent';

import authRoutes from './routes/auth';
import aiRoutes from './routes/ai';
import customerRoutes from './routes/customers';
import serviceRoutes from './routes/services';
import staffRoutes from './routes/staff';
import appointmentRoutes from './routes/appointments';
import workspaceRoutes from './routes/workspaces';
import resourceRoutes from './routes/resources';
import bookingPageRoutes from './routes/booking-pages';
import settingsRoutes from './routes/settings';
import timeOffRoutes from './routes/time-off';
import reportRoutes from './routes/reports';
import publicRoutes from './routes/public';
import paymentWebhookRoutes from './routes/payment-webhooks';
import messagingWebhookRoutes from './routes/messaging-webhooks';
import notificationRoutes from './routes/notifications';
import integrationRoutes from './routes/integrations';
import { processWebhookDeliveries, recoverInterruptedWebhooks } from './services/integrations/webhooks';

// Fails fast on unsafe security settings (production) and invalid email settings, before any request is served.
const security = initSecurityConfig();
const emailConfig = initEmail();
// GEMINI_API_KEY (+ optional GEMINI_MODEL) turns on the model-backed assistant; an invalid GEMINI_MODEL stops startup.
const assistant = agentConfig();

const app = express();
// Client addresses for rate limits come from the socket unless TRUST_PROXY names the proxy in front of the API.
app.set('trust proxy', security.trustProxy);

// ─── Security & parsing ───────────────────────────────────────────────────────
app.use(helmet());

const allowedOrigins = trustedOrigins();
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
  credentials: true,
}));

app.use(cookieParser());
// Payment provider webhooks read the raw body (signatures cover the exact bytes), so they come before the JSON parser;
// they are server-to-server calls without cookies, verified by signature instead of origin.
app.use('/api/webhooks/payments', paymentWebhookRoutes);
// SMS / WhatsApp delivery reports and replies: verified by provider signature, before the JSON parser for the same reason.
app.use('/api/webhooks/messaging', messagingWebhookRoutes);
app.use(express.json({ limit: '100kb' }));
// State-changing requests sent by a browser from another website are refused before reaching any route.
app.use('/api', originGuard);

// ─── Health ───────────────────────────────────────────────────────────────────
// For load balancers and uptime checks: "ok" only while the database answers. No details are exposed.
app.get('/api/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unavailable', ts: new Date().toISOString() });
  }
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);

// ─── Admin CRUD (all require JWT) ─────────────────────────────────────────────
app.use('/api/customers', customerRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/resources', resourceRoutes);
app.use('/api/booking-pages', bookingPageRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/time-off', timeOffRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/notifications', notificationRoutes);

// ─── AI Operator ──────────────────────────────────────────────────────────────
app.use('/api/ai', aiRoutes);

// ─── Public booking (no auth) ─────────────────────────────────────────────────
app.use('/api/public', publicRoutes);

// Unknown API paths get a JSON 404 rather than Express's HTML page.
app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });

// ─── Web app (optional) ───────────────────────────────────────────────────────
// WEB_DIST_DIR: serve the built web app from this process on the same origin (src/web-app.ts). Unset: API only.
const webAppDir = mountWebApp(app, process.env.WEB_DIST_DIR);

// ─── Error handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────
export function initKnowledge(): void {
  seedKnowledge();
  // Index comprehensive knowledge docs from server/knowledge/*.md
  try { indexKnowledgeDirectory(); } catch (e) { console.warn('[startup] Knowledge indexing failed:', e); }
}

// Tests drive the app through supertest; a real listener would leak an open handle.
if (process.env.NODE_ENV !== 'test') {
  const PORT = Number(process.env.PORT ?? 3001);
  let webhookTimer: NodeJS.Timeout | undefined;
  const server = app.listen(PORT, () => {
    console.log(`WorkEasy360 API running on http://localhost:${PORT}`);
    console.log(`Allowed app origins: ${security.allowedOrigins.join(', ')}`);
    console.log(webAppDir ? `Web app: served from ${webAppDir}` : 'Web app: not served by this process (WEB_DIST_DIR is not set)');
    for (const w of security.warnings) console.warn(`[security] ${w}`);
    console.log(`Email transport: ${emailConfig.transport}${emailConfig.transport === 'disabled' ? ' (booking emails will NOT be sent)'
      : emailConfig.transport === 'smtp' ? ` (${smtpTlsDescription(emailConfig)})` : ''}`);
    console.log(`Email recipients: ${recipientAllowlistDescription(emailConfig.allowedRecipients)}`);
    console.log(assistant ? `Assistant: Gemini (${assistant.model})` : 'Assistant: local knowledge search (GEMINI_API_KEY is not set)');
    if (emailConfig.transport === 'disabled') {
      console.warn('[email] New sign-ups (email verification) and password reset need email: they answer "email is not set up" until EMAIL_TRANSPORT=smtp is configured');
    }
    // Emails cut off by a previous stop are not resent blindly; due retries continue in the background.
    recoverInterruptedEmails();
    const notes = recoverInterruptedNotifications();
    if (notes) console.warn(`[email] ${notes} reminder(s) or staff alert(s) were interrupted by a restart; marked "unknown" and not resent`);
    startEmailWorker();
    // Outgoing webhooks: deliveries cut off by a restart are not resent blindly; due ones go out every 30 seconds.
    const hooks = recoverInterruptedWebhooks();
    if (hooks) console.warn(`[webhooks] ${hooks} delivery(ies) were interrupted by a restart; marked "unknown" and not resent`);
    webhookTimer = setInterval(() => { processWebhookDeliveries().catch(e => console.error('[webhooks] delivery worker failed:', e instanceof Error ? e.message : e)); }, 30_000);
    webhookTimer.unref();
    initKnowledge();
  });
  // A stop (systemd, a redeploy, Ctrl+C) lets requests in progress finish and closes the database (src/shutdown.ts).
  const shutdown = createShutdown({
    server,
    stopWorkers: () => { stopEmailWorker(); if (webhookTimer) clearInterval(webhookTimer); },
    closeDatabase: () => db.close(),
    exit: code => process.exit(code),
  });
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

export default app;
