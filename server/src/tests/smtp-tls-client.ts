// Test helper, run by smtp-tls.test.ts in its own Node process: only a new process can trust the test certificate
// (NODE_EXTRA_CA_CERTS is read at startup). Sends one message to a local test SMTP server with exactly the options the
// server would use for the email settings in this process's environment, and prints the outcome as one JSON line.
// It prints no settings, credentials or message contents.
import nodemailer from 'nodemailer';
import { readEmailConfig, smtpTransportOptions, type SmtpConfig } from '../services/email/config';

async function main(): Promise<void> {
  const cfg = readEmailConfig(process.env) as SmtpConfig;
  const transport = nodemailer.createTransport(smtpTransportOptions(cfg));
  try {
    const info = await transport.sendMail({ from: cfg.from, to: 'tls-check@example.test', subject: 'TLS check', text: 'TLS check' });
    console.log(JSON.stringify({ ok: true, accepted: info.accepted.length }));
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.log(JSON.stringify({ ok: false, code: err.code ?? null, message: String(err.message ?? e).slice(0, 200) }));
  } finally {
    transport.close();
  }
}

void main();
