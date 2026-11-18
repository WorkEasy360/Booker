// Operator commands for sign-in with WorkEasy360 Accounts (docs/workeasy360-sso.md). Each one works directly on a
// database file, in one transaction, and records what it did in the workeasy360_audit table.
//
//   npm run w360:link-org     -- --db <file> --business <org-id> --organization <workeasy360-org-uuid> [--replace-empty] --actor <you>
//   npm run w360:link-user    -- --db <file> --user <user-id> --subject <workeasy360-sub> [--issuer <issuer>] --actor <you>
//   npm run w360:set-role     -- --db <file> --user <user-id> --role admin|manager|staff --actor <you>
//   npm run w360:move-issuer  -- --db <file> --from <old issuer> --to <new issuer> [--apply] --actor <you>
//   npm run w360:identities   -- --db <file>
//
// --db is required (there is no default, so the wrong database cannot be picked by accident). server/.env is not read;
// --issuer defaults to WORKEASY360_ISSUER from the environment.
import path from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);
function fail(message: string): never {
  console.error(`Not done: ${message}`);
  process.exit(1);
}
function need(name: string): string {
  const value = arg(name);
  if (!value) fail(`${name} is required`);
  return value;
}

async function main() {
  const command = process.argv[2];
  const dbArg = arg('--db');
  if (!dbArg) fail('--db is required (the path of the database file)');
  // The database is chosen before any app module opens one.
  process.env.DB_PATH = path.resolve(dbArg);
  const store = await import('../src/workeasy360/store');
  const { default: db } = await import('../src/db/init');
  const actor = () => need('--actor');
  let result: { ok: boolean; message: string };
  switch (command) {
    case 'link-org':
      result = store.linkOrganization(need('--business'), need('--organization'), { replaceEmpty: flag('--replace-empty'), actor: actor() });
      break;
    case 'link-user': {
      const issuer = arg('--issuer') ?? process.env.WORKEASY360_ISSUER;
      if (!issuer) fail('--issuer is required when WORKEASY360_ISSUER is not set');
      result = store.linkUser(need('--user'), need('--subject'), { issuer, actor: actor() });
      break;
    }
    case 'set-role':
      result = store.setRole(need('--user'), need('--role'), actor());
      break;
    case 'move-issuer':
      result = store.moveIssuer(need('--from'), need('--to'), { apply: flag('--apply'), actor: actor() });
      break;
    case 'identities': {
      const report = store.identityReport();
      for (const row of report.issuers) console.log(`${row.issuer}\t${row.users} user(s)\t${row.openSessions} open session(s)`);
      if (!report.issuers.length) console.log('No WorkEasy360 identities yet.');
      console.log(`${report.linkedBusinesses} business(es) linked to a WorkEasy360 organization.`);
      result = { ok: true, message: '' };
      break;
    }
    default:
      fail('the command must be link-org, link-user, set-role, move-issuer or identities');
  }
  db.close();
  if (!result.ok) fail(result.message);
  if (result.message) console.log(result.message);
}

main().catch(e => fail(e instanceof Error ? e.message : String(e)));
