// Checks the SMTP settings in server/.env (or the process environment) against the real mail provider, so a staging
// server can prove delivery (and SPF/DKIM/DMARC) before any customer is emailed. It uses the same settings, validation
// and TLS options as the server, never prints credentials, does not open the database, and sends at most ONE message.
//
//   cd server
//   npm run email:test -- --verify-only               # connect, TLS and sign in; sends nothing
//   npm run email:test -- --to you@yourdomain.com     # the same, then one test message to an inbox you control
//
// With EMAIL_ALLOWED_RECIPIENTS set, the --to address must be allowed by it, exactly as for the server; otherwise
// nothing connects and nothing is sent.
//
// Exit codes: 0 OK, 1 the mail server or network refused (the message names the setting to check), 2 usage or settings.
import 'dotenv/config';
import os from 'os';
import nodemailer from 'nodemailer';
import {
  readEmailConfig, smtpTransportOptions, smtpTlsDescription, redactSmtpMessage, isRecipientAllowed, recipientAllowlistDescription,
  type EmailConfig,
} from '../src/services/email/config';

const MAILBOX = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]{2,}$/;
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

/** Which setting to look at for a failed attempt. Names settings only, never their values. */
function whatToCheck(err: { code?: string; responseCode?: number; message?: string }): string {
  const message = err.message ?? '';
  if (err.code === 'EAUTH' || [530, 534, 535].includes(err.responseCode ?? 0)) {
    return 'Sign-in was refused: check SMTP_USER and SMTP_PASS, and that the provider allows SMTP sign-in for that account.';
  }
  if (err.code === 'ETLS' || /certificate|self[- ]signed|unable to verify|altnames|wrong version number|ssl|tls/i.test(message)) {
    return 'TLS failed: check that SMTP_HOST is the exact host name the provider documents, and that SMTP_PORT and SMTP_SECURE '
      + 'match (465 with SMTP_SECURE=true, 587 with SMTP_SECURE=false). Certificates are always verified; there is no fallback to plaintext.';
  }
  if (['ECONNECTION', 'ECONNREFUSED', 'ETIMEDOUT', 'EDNS', 'ENOTFOUND', 'EAI_AGAIN', 'ESOCKET', 'ECONNRESET'].includes(err.code ?? '')) {
    return 'Could not connect: check SMTP_HOST and SMTP_PORT, and that this server may make outgoing connections to that port.';
  }
  if (err.code === 'EENVELOPE') {
    return 'The mail server refused the sender or the recipient: check that EMAIL_FROM is a sender the provider has verified, and the --to address.';
  }
  if (err.code === 'EMESSAGE') return 'The mail server refused the message itself: see its reply above and the provider\'s log.';
  return 'See the mail server\'s reply above.';
}

async function main(): Promise<number> {
  const verifyOnly = process.argv.includes('--verify-only');
  const to = arg('--to')?.trim();
  if (!verifyOnly && (!to || !MAILBOX.test(to))) {
    console.error('Usage: npm run email:test -- --verify-only              (connect, TLS, sign in; sends nothing)');
    console.error('       npm run email:test -- --to you@yourdomain.com    (then one test message to an inbox you control)');
    return 2;
  }
  let cfg: EmailConfig;
  try { cfg = readEmailConfig(process.env); } catch (e) { console.error((e as Error).message); return 2; }
  if (cfg.transport !== 'smtp') {
    console.error(`EMAIL_TRANSPORT is "${cfg.transport}". Set EMAIL_TRANSPORT=smtp and the SMTP settings in server/.env first.`);
    return 2;
  }
  const secrets = [cfg.user, cfg.pass];
  // The server's own recipient rule, checked before anything connects: this script cannot send where the server may not.
  if (!verifyOnly && !isRecipientAllowed(cfg.allowedRecipients, to)) {
    console.error('Not sent: the --to address is not allowed by EMAIL_ALLOWED_RECIPIENTS on this server. No connection was made.');
    return 2;
  }

  // The same transport options as the server, so this proves exactly what the server will do (TLS included).
  const transport = nodemailer.createTransport(smtpTransportOptions(cfg));
  console.log(`Mail server ${cfg.host}:${cfg.port} (${smtpTlsDescription(cfg)}), sign-in: ${cfg.user ? 'yes' : 'none'}, from ${cfg.from}`);
  console.log(`Recipients: ${recipientAllowlistDescription(cfg.allowedRecipients)}`);
  let stage = 'connect, TLS and sign-in';
  try {
    await transport.verify();
    console.log(`Connection, TLS and sign-in: OK${cfg.tls === 'local-plaintext' ? ' (local mail catcher, no TLS)' : ''}`);
    if (verifyOnly) {
      console.log('No email was sent (--verify-only).');
      return 0;
    }
    stage = 'sending the test message';
    const sentAt = new Date().toISOString();
    const info = await transport.sendMail({
      from: cfg.from,
      to,
      subject: `WorkeasyBooking email test ${sentAt}`,
      text: [
        'This is a test message from a WorkeasyBooking server, sent with npm run email:test.',
        '',
        `Sent at: ${sentAt}`,
        `Server host: ${os.hostname()}`,
        `App address used in links: ${cfg.appUrl}`,
        '',
        'Check that it arrived in the inbox (not spam), and in the message headers that SPF, DKIM and DMARC pass for the',
        'sending domain. No customer data is included.',
      ].join('\n'),
    });
    console.log(`Accepted by the mail server: ${info.accepted.length ? 'yes' : 'no'}${info.rejected.length ? ` (rejected: ${info.rejected.length})` : ''}`);
    console.log(`Message-ID: ${info.messageId}`);
    console.log(`Mail server reply: ${redactSmtpMessage(String(info.response ?? ''), secrets)}`);
    console.log('Accepted is not delivered: open the inbox (and spam folder) of the --to address, find the message by its subject or');
    console.log('Message-ID, and confirm in its headers that spf=pass, dkim=pass and dmarc=pass. Run this once; do not repeat it in a loop.');
    return 0;
  } catch (e) {
    const err = e as { code?: string; responseCode?: number; message?: string };
    console.error(`Not OK at: ${stage}`);
    console.error(`Mail server or network said: ${[err.code, err.responseCode].filter(Boolean).join(' ')} ${redactSmtpMessage(err.message ?? String(e), secrets)}`.trim());
    console.error(`What to check: ${whatToCheck(err)}`);
    console.error(stage === 'connect, TLS and sign-in' ? 'No email was sent.' : 'The test message was not accepted.');
    return 1;
  } finally {
    transport.close();
  }
}

main().then(code => process.exit(code));
