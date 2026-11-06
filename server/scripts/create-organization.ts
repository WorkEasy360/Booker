// Creates a business and its first administrator directly in a database: the way to onboard a client on a server where
// public sign-up is closed (SIGNUP_MODE=closed), and one that works before email is set up. Nothing else is created:
// no demo services, staff, customers, workspaces or bookings. The administrator signs in with the email and password
// given here and sets up the business from there.
//
//   npm run org:create -- --db /var/lib/workeasy360/workeasy360.db --company "Acme Clinic" --name "Asha Rao" \
//     --email asha@acme.example [--timezone Asia/Kolkata] [--country India]
//
// --db is required (there is no default, so the wrong database cannot be picked by accident); a missing file is
// created with the full schema. The password is asked for twice at a hidden prompt, or read from ORG_ADMIN_PASSWORD
// for automation. It is never printed or logged. server/.env is not read.
import path from 'node:path';
import readline from 'node:readline';
import { z } from 'zod';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(message: string): never {
  console.error(`Not created: ${message}`);
  process.exit(1);
}

/** Reads a line without echoing it (the terminal shows nothing while typing). */
function hiddenPrompt(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) { reject(new Error('no terminal to ask for the password: set ORG_ADMIN_PASSWORD instead')); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    process.stdout.write(question);
    out._writeToOutput = s => { if (s.includes('\n') || s.includes('\r')) out.output.write('\n'); };
    rl.question('', answer => { rl.close(); resolve(answer); });
  });
}

const Input = z.object({
  company: z.string().trim().min(1, 'Company name is required').max(100, 'Company name must be 100 characters or fewer'),
  name: z.string().trim().min(1, 'Administrator name is required').max(100, 'Name must be 100 characters or fewer'),
  email: z.string().trim().max(254).email('A valid email address is required'),
});

async function main() {
  const dbArg = arg('--db');
  if (!dbArg) fail('--db is required (the path of the production database file)');
  const parsed = Input.safeParse({ company: arg('--company'), name: arg('--name'), email: arg('--email') });
  if (!parsed.success) fail(parsed.error.errors.map(e => e.message).join('; '));
  const { company, name } = parsed.data;
  const email = parsed.data.email.toLowerCase();

  // The database is chosen before any app module opens one.
  process.env.DB_PATH = path.resolve(dbArg);
  const { default: db } = await import('../src/db/init');
  const { BCRYPT_COST, PasswordRule } = await import('../src/auth/password-rules');
  const { newBusinessLocale, DEFAULT_COUNTRY, DEFAULT_CURRENCY, DEFAULT_DATE_FORMAT } = await import('../src/services/business-locale');
  const { default: bcrypt } = await import('bcryptjs');
  const { nanoid } = await import('nanoid');

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail('an account with this email address already exists');

  let password = process.env.ORG_ADMIN_PASSWORD;
  if (!password) {
    password = await hiddenPrompt('Password for the administrator (hidden): ');
    const again = await hiddenPrompt('Type it again: ');
    if (password !== again) fail('the two passwords are different');
  }
  const rule = PasswordRule.safeParse(password);
  if (!rule.success) fail(rule.error.errors.map(e => e.message).join('; '));

  const locale = newBusinessLocale({ timezone: arg('--timezone'), country: arg('--country') });
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const orgId = `org-${nanoid(8)}`;
  const userId = `user-${nanoid(8)}`;
  // The same rows a confirmed web sign-up creates (services/account-tokens.ts, verifySignup), and nothing more.
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new Error('an account with this email address already exists');
    db.prepare(
      `INSERT INTO organizations (id, name, email, timezone, country, currency, date_format, time_format, working_hours, booking_rules)
       VALUES (?, ?, ?, ?, COALESCE(?, ?), ?, ?, '12h', '{}', '{}')`
    ).run(orgId, company, email, locale.timezone, locale.country, DEFAULT_COUNTRY, DEFAULT_CURRENCY, DEFAULT_DATE_FORMAT);
    db.prepare(`INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, 'admin')`)
      .run(userId, orgId, email, passwordHash, name);
  }).immediate();
  db.close();
  console.log(`Created the business "${company}" (${orgId}) with its administrator (${userId}), time zone ${locale.timezone}.`);
  console.log('The administrator can now sign in at <your app address>/login.');
}

main().catch(e => fail(e instanceof Error ? e.message : String(e)));
