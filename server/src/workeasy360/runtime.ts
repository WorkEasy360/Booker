import { Workeasy360Client } from './client';
import { EntitlementCache } from './entitlements';
import { initWorkeasy360Config, workeasy360Config, type Workeasy360Settings } from './config';
import { sqliteAnswerStore } from './store';
import { log } from './log';

export interface Workeasy360Runtime {
  client: Workeasy360Client;
  entitlements: EntitlementCache;
  settings: Workeasy360Settings;
}

let runtime: Workeasy360Runtime | null | undefined;

function build(settings: Workeasy360Settings | null): Workeasy360Runtime | null {
  if (!settings) return null;
  const client = new Workeasy360Client({
    issuer: settings.issuer,
    clientId: settings.clientId,
    productCode: settings.productCode,
    redirectUri: settings.redirectUri,
    keyId: settings.keyId,
    privateKeyPem: settings.privateKeyPem,
    scopes: settings.scopes,
    allowInsecureRequests: settings.allowInsecureRequests,
  });
  return { client, entitlements: new EntitlementCache(client, sqliteAnswerStore, log), settings };
}

/** Reads and validates the WorkEasy360 settings at startup (throws on an unusable configuration). */
export function initWorkeasy360(env: NodeJS.ProcessEnv = process.env): Workeasy360Runtime | null {
  runtime = build(initWorkeasy360Config(env));
  return runtime;
}

/** This process's WorkEasy360 sign-in, or null when it is off. */
export function workeasy360(): Workeasy360Runtime | null {
  if (runtime === undefined) runtime = build(workeasy360Config());
  return runtime;
}
