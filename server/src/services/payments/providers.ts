// Payment provider accounts (sandbox or live) are configured only through environment variables; none is configured
// in this project, so no payment is ever started and every webhook endpoint answers "not configured".
//  STRIPE_WEBHOOK_SECRET                          Stripe webhook signing secret (whsec_…)
//  RAZORPAY_WEBHOOK_SECRET                        Razorpay webhook secret
//  PAYPAL_WEBHOOK_ID, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_API_BASE (sandbox: https://api-m.sandbox.paypal.com)
// Secrets are read when needed and never logged or returned.

import type { Provider } from './events';

export interface PaypalConfig { webhookId: string; clientId: string; clientSecret: string; apiBase: string }

export function stripeWebhookSecret(env = process.env): string | null {
  return env.STRIPE_WEBHOOK_SECRET?.trim() || null;
}

export function razorpayWebhookSecret(env = process.env): string | null {
  return env.RAZORPAY_WEBHOOK_SECRET?.trim() || null;
}

export function paypalConfig(env = process.env): PaypalConfig | null {
  const webhookId = env.PAYPAL_WEBHOOK_ID?.trim();
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  const apiBase = env.PAYPAL_API_BASE?.trim() || 'https://api-m.sandbox.paypal.com';
  if (!webhookId || !clientId || !clientSecret) return null;
  if (!/^https:\/\//.test(apiBase)) return null;
  return { webhookId, clientId, clientSecret, apiBase };
}

/** Which providers can receive webhooks on this server (for the Integrations page; never the secrets). */
export function configuredProviders(env = process.env): Record<Provider, boolean> {
  return { stripe: !!stripeWebhookSecret(env), razorpay: !!razorpayWebhookSecret(env), paypal: !!paypalConfig(env) };
}

/** HTTP client used for PayPal; tests replace it so nothing reaches PayPal. */
export type HttpClient = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json: () => Promise<unknown> }>;
let http: HttpClient = (url, init) => fetch(url, init);
export function setPaymentHttpClient(client: HttpClient | null): void {
  http = client ?? ((url, init) => fetch(url, init));
}

/**
 * Asks PayPal whether a webhook event is genuine (POST /v1/notifications/verify-webhook-signature). Never verified
 * against PayPal in this project: no PayPal account is configured.
 */
export async function verifyPaypalWebhook(cfg: PaypalConfig, headers: Record<string, string | undefined>, event: unknown): Promise<boolean> {
  const needed = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  if (needed.some(h => !headers[h])) return false;
  const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const token = await http(`${cfg.apiBase}/v1/oauth2/token`, {
    method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials',
  });
  if (token.status !== 200) return false;
  const accessToken = (await token.json() as { access_token?: string }).access_token;
  if (!accessToken) return false;
  const res = await http(`${cfg.apiBase}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'],
      webhook_id: cfg.webhookId, webhook_event: event,
    }),
  });
  if (res.status !== 200) return false;
  return (await res.json() as { verification_status?: string }).verification_status === 'SUCCESS';
}
