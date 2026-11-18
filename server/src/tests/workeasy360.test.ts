import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import path from 'path';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { FakeWorkeasy360, type ClientKeys } from './workeasy360-fake-provider';

// Like the other suites here: each test signs in for real (key generation, HTTP to the fake provider, token checks),
// which takes longer than Jest's 5 s default on a loaded machine.
jest.setTimeout(60_000);

// Sign-in with WorkEasy360 Accounts (docs/workeasy360-sso.md), against a fake WorkEasy360 provider served over real
// HTTP on 127.0.0.1 with keys generated at start. It checks private_key_jwt (aud = the token endpoint) and PKCE the
// way the platform does. Two app instances (A and B) are separate module graphs, each with its own connection to the
// same database file, as two server processes would be.

const APP = 'http://localhost:5173';
const CALLBACK = `${APP}/api/auth/workeasy360/callback`;
const CLIENT_ID = 'workeasy-booking-test';
const BACKCHANNEL = '/api/auth/workeasy360/backchannel-logout';

interface Instance {
  app: Express;
  db: Database.Database;
  store: typeof import('../workeasy360/store');
  notify: typeof import('../services/email/notify');
  tokens: typeof import('../services/account-tokens');
}

let fake: FakeWorkeasy360;
let keys: ClientKeys;
let A: Instance;
let B: Instance;
const savedEnv = { ...process.env };

function load(env: Record<string, string>): Instance {
  const before = { ...process.env };
  Object.assign(process.env, env);
  let instance!: Instance;
  jest.isolateModules(() => {
    instance = {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      app: require('../index').default,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      db: require('../db/init').default,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      store: require('../workeasy360/store'),
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      notify: require('../services/email/notify'),
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      tokens: require('../services/account-tokens'),
    };
  });
  process.env = before;
  return instance;
}

function w360Env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    WORKEASY360_ISSUER: fake.issuer,
    WORKEASY360_CLIENT_ID: CLIENT_ID,
    WORKEASY360_KEY_ID: keys.keyId,
    WORKEASY360_PRIVATE_KEY: keys.privateKeyPem.replace(/\n/g, '\\n'),
    WORKEASY360_REDIRECT_URI: CALLBACK,
    WORKEASY360_POST_LOGOUT_REDIRECT_URI: `${APP}/login`,
    ...extra,
  };
}

beforeAll(async () => {
  fake = await FakeWorkeasy360.start();
  keys = await fake.registerClient(CLIENT_ID, [CALLBACK]);
  A = load(w360Env());
  B = load(w360Env());
});

afterAll(async () => {
  for (const i of [A, B]) if (i?.db.open) i.db.close();
  await fake.stop();
  process.env = savedEnv;
});

beforeEach(() => {
  fake.tampering = {};
  fake.authorizeError = undefined;
  fake.entitlement = (organizationId) => ({
    status: 200,
    body: { decision: 'allow', reason: 'entitled', product_code: fake.productCode, organization_id: organizationId, write_allowed: true, revalidate_after: 900 },
  });
});

function newPerson(organizationId: string = randomUUID(), extra: Partial<FakeWorkeasy360['person']> = {}) {
  const sub = randomUUID();
  fake.person = { sub, email: `p-${sub.slice(0, 8)}@example.test`, emailVerified: true, name: 'Asha Rao', organizationId, organizationName: 'Asha Clinic', sid: randomUUID(), ...extra };
  return fake.person;
}

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw as string[] : raw ? [raw as string] : [];
  const hit = list.find(c => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`));
  return hit ? hit.split(';')[0] : undefined;
}

/** Runs the whole browser flow on `app`; returns the callback response and the session cookie, if one was set. */
async function signIn(app: Express, options: { organization?: string; existingCookie?: string } = {}) {
  const start = await request(app).get('/api/auth/workeasy360/start').query(options.organization ? { organization: options.organization } : {});
  expect(start.status).toBe(302);
  const flow = cookieFrom(start, 'we360_w360_flow');
  expect(flow).toBeDefined();
  const authorize = new URL(start.headers.location as string);
  const back = await fetch(authorize, { redirect: 'manual' });
  const location = new URL(back.headers.get('location') ?? '');
  const callback = await request(app).get(`/api/auth/workeasy360/callback${location.search}`)
    .set('Cookie', [flow!, ...(options.existingCookie ? [options.existingCookie] : [])].join('; '));
  return { start, authorize, location, callback, flow: flow!, session: cookieFrom(callback, 'we360_session') };
}

function ssoError(res: { headers: Record<string, unknown> }): string | null {
  const location = res.headers.location as string | undefined;
  return location ? new URL(location).searchParams.get('sso_error') : null;
}

const me = (app: Express, cookie: string) => request(app).get('/api/auth/me').set('Cookie', cookie);

/** A password business the way a person makes one (sign up, confirm the emailed link, sign in), on one instance. */
async function passwordSignUp(i: Instance, body: { name: string; email: string; company: string; password: string }) {
  const signup = await request(i.app).post('/api/auth/signup').set('Origin', APP).send({ ...body, confirmPassword: body.password });
  expect(signup.status).toBe(202);
  await i.notify.accountEmailsSettled();
  const mail = [...i.notify.testOutbox.messages].reverse().find(m => m.to === body.email.toLowerCase() && /\/verify-email#token=/.test(m.text));
  const token = decodeURIComponent(/\/verify-email#token=([A-Za-z0-9_%-]+)/.exec(mail!.text)![1]);
  expect((await request(i.app).post('/api/auth/verify-email').set('Origin', APP).send({ token })).status).toBe(201);
  return request(i.app).post('/api/auth/login').set('Origin', APP).send({ email: body.email, password: body.password });
}

describe('WorkEasy360 sign-in: the happy path', () => {
  it('signs in with PKCE S256 and private_key_jwt, creates the organization\'s business and binds the session to it', async () => {
    const person = newPerson();
    const { authorize, callback, session } = await signIn(A.app, { organization: person.organizationId });

    // The authorization request: S256, state, nonce, the organization the launcher named, the registered callback.
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get('state')).toBeTruthy();
    expect(authorize.searchParams.get('nonce')).toBeTruthy();
    expect(authorize.searchParams.get('organization')).toBe(person.organizationId);
    expect(authorize.searchParams.get('redirect_uri')).toBe(CALLBACK);

    // The code exchange authenticated with private_key_jwt: iss = sub = client id, aud = the token endpoint, <= 60 s.
    const exchange = fake.seen.token.at(-1)!;
    expect(exchange.form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(exchange.form.get('client_secret')).toBeNull();
    expect(exchange.assertion.iss).toBe(CLIENT_ID);
    expect(exchange.assertion.sub).toBe(CLIENT_ID);
    expect(exchange.assertion.aud).toBe(fake.tokenEndpoint);
    expect((exchange.assertion.exp as number) - (exchange.assertion.iat as number)).toBeLessThanOrEqual(60);
    expect(exchange.form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    // The entitlement question: the organization and the person, with a client assertion for the token endpoint.
    const asked = fake.seen.entitlement.at(-1)!;
    expect(asked.form.get('organization_id')).toBe(person.organizationId);
    expect(asked.form.get('subject')).toBe(person.sub);
    expect(asked.assertion.aud).toBe(fake.tokenEndpoint);

    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe(`${APP}/`);
    expect(session).toBeDefined();
    const setCookie = (callback.headers['set-cookie'] as unknown as string[]).find(c => c.startsWith('we360_session='))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).not.toMatch(/Domain=/i);

    const res = await me(A.app, session!);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(person.email);
    expect(res.body.data.role).toBe('admin');
    expect(res.body.data.workeasy360).toMatchObject({ signedIn: true, access: { allowed: true } });
    const link = A.db.prepare('SELECT organization_id FROM workeasy360_organizations WHERE w360_organization_id = ?').get(person.organizationId) as { organization_id: string };
    expect(res.body.data.organization_id).toBe(link.organization_id);
    const identity = A.db.prepare('SELECT issuer, subject FROM workeasy360_identities WHERE user_id = ?').get(res.body.data.id);
    expect(identity).toEqual({ issuer: fake.issuer, subject: person.sub });
  });

  it('puts the next person of the same organization in the same business with the default role, keyed on (issuer, sub)', async () => {
    const owner = newPerson();
    const first = await signIn(A.app);
    const ownerMe = await me(A.app, first.session!);
    newPerson(owner.organizationId!);
    const second = await signIn(A.app);
    const res = await me(A.app, second.session!);
    expect(res.body.data.organization_id).toBe(ownerMe.body.data.organization_id);
    expect(res.body.data.role).toBe('staff');
    expect(res.body.data.id).not.toBe(ownerMe.body.data.id);
  });

  it('signs the same person in again as the same user, and ends the session the browser already held', async () => {
    newPerson();
    const first = await signIn(A.app);
    const userId = (await me(A.app, first.session!)).body.data.id;
    const again = await signIn(A.app, { existingCookie: first.session });
    expect((await me(A.app, again.session!)).body.data.id).toBe(userId);
    expect(again.session).not.toBe(first.session);
    expect((await me(A.app, first.session!)).status).toBe(401);
  });

  it('serves the sign-in page its settings', async () => {
    const res = await request(A.app).get('/api/auth/workeasy360/config');
    expect(res.body.data).toEqual({ enabled: true, ssoOnly: false, startUrl: '/api/auth/workeasy360/start' });
  });
});

describe('WorkEasy360 sign-in: what is refused', () => {
  async function refused(tamper: () => void): Promise<{ code: string | null; session?: string }> {
    newPerson();
    tamper();
    const { callback, session } = await signIn(A.app);
    expect(callback.status).toBe(303);
    return { code: ssoError(callback), session };
  }

  it('refuses an ID token from another issuer', async () => {
    expect(await refused(() => { fake.tampering = { issuer: 'https://evil.example.test' }; })).toEqual({ code: 'invalid_token', session: undefined });
  });

  it('refuses an ID token for another audience', async () => {
    expect(await refused(() => { fake.tampering = { audience: 'another-product' }; })).toEqual({ code: 'invalid_token', session: undefined });
  });

  it('refuses an ID token whose signature does not verify against the key set', async () => {
    expect(await refused(() => { fake.tampering = { foreignKey: true }; })).toEqual({ code: 'invalid_token', session: undefined });
  });

  it('refuses an ID token with another nonce', async () => {
    expect(await refused(() => { fake.tampering = { nonce: 'not-the-one-we-sent' }; })).toEqual({ code: 'invalid_token', session: undefined });
  });

  it('refuses an access token presented as an ID token (typ)', async () => {
    expect(await refused(() => { fake.tampering = { typ: 'access_token' }; })).toEqual({ code: 'invalid_token', session: undefined });
  });

  it('refuses a token for another product', async () => {
    expect(await refused(() => { fake.tampering = { productCode: 'easy_crm' }; })).toEqual({ code: 'wrong_product', session: undefined });
  });

  it('refuses a token that names no organization', async () => {
    expect(await refused(() => { fake.person.organizationId = undefined; })).toEqual({ code: 'no_organization', session: undefined });
  });

  it('refuses an address WorkEasy360 has not verified', async () => {
    expect(await refused(() => { fake.person.emailVerified = false; })).toEqual({ code: 'email_unverified', session: undefined });
  });

  it('refuses a token for another organization than the launcher asked for', async () => {
    const person = newPerson();
    fake.tampering = { claims: { organization_id: randomUUID() } };
    const { callback, session } = await signIn(A.app, { organization: person.organizationId });
    expect(ssoError(callback)).toBe('wrong_organization');
    expect(session).toBeUndefined();
  });

  it('refuses an organization that is not entitled, with the reason and no session', async () => {
    const person = newPerson();
    fake.entitlement = () => ({ status: 200, body: { decision: 'deny', reason: 'expired', write_allowed: false, revalidate_after: 900 } });
    const { callback, session } = await signIn(A.app);
    expect(ssoError(callback)).toBe('not_entitled');
    expect(new URL(callback.headers.location as string).searchParams.get('reason')).toBe('expired');
    expect(session).toBeUndefined();
    expect(A.db.prepare('SELECT 1 FROM workeasy360_organizations WHERE w360_organization_id = ?').get(person.organizationId)).toBeUndefined();
  });

  it('shows WorkEasy360\'s own refusal (product_not_entitled) as the same page', async () => {
    newPerson();
    fake.authorizeError = 'product_not_entitled';
    const { callback } = await signIn(A.app);
    expect(ssoError(callback)).toBe('not_entitled');
  });

  it('refuses a callback with no pending flow, another state, and a flow used twice', async () => {
    newPerson();
    const first = await signIn(A.app);
    expect(first.session).toBeDefined();
    // The same callback again (same cookie, code and state): the flow was taken the first time.
    const replay = await request(A.app).get(`/api/auth/workeasy360/callback${first.location.search}`).set('Cookie', first.flow);
    expect(ssoError(replay)).toBe('expired');
    expect(cookieFrom(replay, 'we360_session')).toBeUndefined();
    // No flow cookie at all.
    const none = await request(A.app).get(`/api/auth/workeasy360/callback${first.location.search}`);
    expect(ssoError(none)).toBe('expired');
    // A fresh flow, but the state in the URL is someone else's.
    const start = await request(A.app).get('/api/auth/workeasy360/start');
    const flow = cookieFrom(start, 'we360_w360_flow')!;
    const wrongState = await request(A.app).get('/api/auth/workeasy360/callback').query({ code: 'x', state: 'not-this-browser' }).set('Cookie', flow);
    expect(ssoError(wrongState)).toBe('expired');
  });

  it('refuses a client authenticated any other way than private_key_jwt for the token endpoint (the fake platform checks aud)', async () => {
    // The fake provider only accepts assertions whose aud is exactly the token endpoint, signed by the registered key.
    newPerson();
    const ok = await signIn(A.app);
    expect(ok.session).toBeDefined();
    expect(fake.seen.token.at(-1)!.assertion.aud).toBe(fake.tokenEndpoint);
    expect(fake.seen.token.at(-1)!.assertion.aud).not.toBe(fake.issuer);
  });
});

describe('WorkEasy360 tenancy: never across organizations', () => {
  it('refuses the same person signing in for a second organization, and keeps each business\'s data to itself', async () => {
    const person = newPerson();
    const first = await signIn(A.app);
    const created = await request(A.app).post('/api/customers').set('Cookie', first.session!).set('Origin', APP)
      .set('X-CSRF-Token', (await me(A.app, first.session!)).body.data.csrfToken)
      .send({ name: 'Private Customer', email: 'private@example.test', phone: '+919876543210' });
    expect(created.status).toBe(201);

    // The same person, now naming another organization: one user belongs to one business here.
    fake.person = { ...person, organizationId: randomUUID(), sid: randomUUID() };
    const other = await signIn(A.app);
    expect(ssoError(other.callback)).toBe('other_organization');
    expect(other.session).toBeUndefined();

    // Someone else's business cannot read this customer.
    newPerson();
    const stranger = await signIn(A.app);
    expect((await request(A.app).get(`/api/customers/${created.body.data.id}`).set('Cookie', stranger.session!)).status).toBe(404);
    const list = await request(A.app).get('/api/customers').set('Cookie', stranger.session!);
    expect(JSON.stringify(list.body)).not.toContain('Private Customer');
  });

  it('refuses a session whose business is no longer linked to its organization', async () => {
    const person = newPerson();
    const { session } = await signIn(A.app);
    A.db.prepare('UPDATE workeasy360_organizations SET w360_organization_id = ? WHERE w360_organization_id = ?').run(randomUUID(), person.organizationId);
    expect((await me(A.app, session!)).status).toBe(401);
  });

  it('never links an existing account by email: an unlinked account with the address is a conflict', async () => {
    const person = newPerson();
    const signup = await signIn(A.app);
    const owner = await me(A.app, signup.session!);
    // A password account with the next person's address, created the ordinary way in that business.
    const email = `existing-${randomUUID().slice(0, 6)}@example.test`;
    A.db.prepare(`INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?, ?, ?, 'x', 'Existing', 'staff')`)
      .run(`user-${randomUUID().slice(0, 8)}`, owner.body.data.organization_id, email);
    newPerson(person.organizationId!, { email });
    const res = await signIn(A.app);
    expect(ssoError(res.callback)).toBe('account_conflict');
  });
});

describe('WorkEasy360 entitlement on its schedule', () => {
  it('ends access on a denial, makes a read-only organization read-only, and fails closed when the client is refused', async () => {
    newPerson();
    const { session } = await signIn(A.app);
    const csrf = (await me(A.app, session!)).body.data.csrfToken as string;
    const store = A.db;
    const clear = () => store.prepare('DELETE FROM workeasy360_entitlements').run();
    // Each scenario starts on a fresh app instance's own copy, so the shared answer is what is read and re-asked.
    const fresh = () => load(w360Env());

    // Denied: every organization request answers 403 with the reason; /me still answers and says so.
    clear();
    fake.entitlement = () => ({ status: 200, body: { decision: 'deny', reason: 'suspended', write_allowed: false, revalidate_after: 900 } });
    const denied = fresh();
    const res = await request(denied.app).get('/api/customers').set('Cookie', session!);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WORKEASY360_ACCESS_ENDED', reason: 'suspended' });
    const meDenied = await me(denied.app, session!);
    expect(meDenied.status).toBe(200);
    expect(meDenied.body.data.workeasy360.access).toEqual({ allowed: false, writeAllowed: false, reason: 'suspended' });
    denied.db.close();

    // Read-only: reads work, changes are refused.
    clear();
    fake.entitlement = () => ({ status: 200, body: { decision: 'allow', reason: 'entitled', write_allowed: false, revalidate_after: 900 } });
    const readOnly = fresh();
    expect((await request(readOnly.app).get('/api/customers').set('Cookie', session!)).status).toBe(200);
    const write = await request(readOnly.app).post('/api/customers').set('Cookie', session!).set('Origin', APP).set('X-CSRF-Token', csrf)
      .send({ name: 'Blocked', email: 'blocked@example.test', phone: '+919876543211' });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('WORKEASY360_READ_ONLY');
    readOnly.db.close();

    // The platform refuses this product's own client (a revoked credential): fail closed for everyone.
    clear();
    fake.entitlement = () => ({ status: 401, body: { error: 'invalid_client' } });
    const refused = fresh();
    const r = await request(refused.app).get('/api/customers').set('Cookie', session!);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('WORKEASY360_ACCESS_UNVERIFIED');
    // ...including through another instance, which learns of the refusal from the shared store.
    const other = fresh();
    expect((await request(other.app).get('/api/customers').set('Cookie', session!)).body.code).toBe('WORKEASY360_ACCESS_UNVERIFIED');
    refused.db.close();
    other.db.close();
    store.prepare('DELETE FROM workeasy360_entitlements').run();
  });

  it('keeps an outage from locking anyone out (a 503 is never a denial)', async () => {
    newPerson();
    const { session } = await signIn(A.app);
    A.db.prepare('DELETE FROM workeasy360_entitlements').run();
    fake.entitlement = () => ({ status: 503, body: { error: 'temporarily_unavailable' } });
    const outage = load(w360Env());
    expect((await request(outage.app).get('/api/customers').set('Cookie', session!)).status).toBe(200);
    outage.db.close();
  });

  it('keeps an outage at arrival from locking anyone out', async () => {
    newPerson();
    fake.entitlement = () => ({ status: 503, body: { error: 'temporarily_unavailable' } });
    const fresh = load(w360Env());
    const { session } = await signIn(fresh.app);
    expect(session).toBeDefined();
    fresh.db.close();
  });
});

describe('WorkEasy360 back-channel logout', () => {
  async function deliver(app: Express, token: string) {
    return request(app).post(BACKCHANNEL).type('form').send({ logout_token: token });
  }

  it('ends the session a sid names at once on both instances, and answers a duplicate with 200', async () => {
    const person = newPerson();
    const { session } = await signIn(A.app);
    expect((await me(A.app, session!)).status).toBe(200);
    expect((await me(B.app, session!)).status).toBe(200);
    const token = await fake.logoutToken(CLIENT_ID, { sub: person.sub, sid: person.sid });
    // Delivered to instance B; instance A refuses the session on its next request.
    expect((await deliver(B.app, token)).status).toBe(200);
    expect((await me(A.app, session!)).status).toBe(401);
    expect((await me(B.app, session!)).status).toBe(401);
    expect((await deliver(A.app, token)).status).toBe(200);
  });

  it('ends every session of the person when the token names sub only, and leaves other people alone', async () => {
    const person = newPerson();
    const one = await signIn(A.app);
    fake.person = { ...person, sid: randomUUID() };
    const two = await signIn(B.app);
    newPerson(person.organizationId!);
    const bystander = await signIn(A.app);
    expect((await deliver(A.app, await fake.logoutToken(CLIENT_ID, { sub: person.sub }))).status).toBe(200);
    expect((await me(B.app, one.session!)).status).toBe(401);
    expect((await me(A.app, two.session!)).status).toBe(401);
    expect((await me(B.app, bystander.session!)).status).toBe(200);
  });

  it('refuses forged and malformed logout tokens with 400 and ends nothing', async () => {
    const person = newPerson();
    const { session } = await signIn(A.app);
    const forged = [
      await fake.logoutToken(CLIENT_ID, { sub: person.sub, foreignKey: true }),                 // bad signature
      await fake.logoutToken(CLIENT_ID, { sub: person.sub, issuer: 'https://evil.example.test' }), // another issuer
      await fake.logoutToken('another-product', { sub: person.sub }),                            // another audience
      await fake.logoutToken(CLIENT_ID, { sub: person.sub, typ: 'JWT' }),                        // not typ logout+jwt
      await fake.logoutToken(CLIENT_ID, { sub: person.sub, withoutEvent: true }),                // no back-channel event
      await fake.logoutToken(CLIENT_ID, { sub: person.sub, nonce: 'n' }),                        // carries a nonce (an ID token)
      await fake.logoutToken(CLIENT_ID, { sub: person.sub, issuedAt: Math.floor(Date.now() / 1000) - 3600 }), // too old / expired
      await fake.logoutToken(CLIENT_ID, {}),                                                     // neither sub nor sid
      'not-a-jwt',
    ];
    for (const token of forged) expect((await deliver(A.app, token)).status).toBe(400);
    expect((await request(A.app).post(BACKCHANNEL).type('form').send({})).status).toBe(400);
    expect((await me(A.app, session!)).status).toBe(200);
  });

  it('accepts each jti once: a replayed jti ends nothing, even for a newer session', async () => {
    const person = newPerson();
    const first = await signIn(A.app);
    const jti = randomUUID();
    const token = await fake.logoutToken(CLIENT_ID, { sub: person.sub, jti });
    expect((await deliver(A.app, token)).status).toBe(200);
    expect((await me(A.app, first.session!)).status).toBe(401);
    fake.person = { ...person, sid: randomUUID() };
    const second = await signIn(A.app);
    // The same jti again (another token), on the other instance: answered, but nothing ends.
    expect((await deliver(B.app, await fake.logoutToken(CLIENT_ID, { sub: person.sub, jti }))).status).toBe(200);
    expect((await me(A.app, second.session!)).status).toBe(200);
  });

  it('refuses a sign-in still in flight whose WorkEasy360 sign-in was already ended', async () => {
    const person = newPerson();
    expect((await deliver(A.app, await fake.logoutToken(CLIENT_ID, { sub: person.sub, sid: person.sid }))).status).toBe(200);
    const { callback, session } = await signIn(A.app);
    expect(ssoError(callback)).toBe('session_ended');
    expect(session).toBeUndefined();
  });
});

describe('signing out', () => {
  it('ends only the WorkeasyBooking session, or also returns WorkEasy360\'s end_session_endpoint', async () => {
    newPerson();
    const plain = await signIn(A.app);
    const out = await request(A.app).post('/api/auth/logout').set('Cookie', plain.session!).set('Origin', APP);
    expect(out.status).toBe(200);
    expect(out.body.data.endSessionUrl).toBeUndefined();
    expect((await me(A.app, plain.session!)).status).toBe(401);

    const both = await signIn(A.app);
    const res = await request(A.app).post('/api/auth/logout?workeasy360=1').set('Cookie', both.session!).set('Origin', APP);
    const url = new URL(res.body.data.endSessionUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${fake.issuer}/api/v1/integrations/oauth/logout`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${APP}/login`);
    expect(url.searchParams.get('id_token_hint')).toBeTruthy();
    expect((await me(A.app, both.session!)).status).toBe(401);
  });
});

describe('password sign-in alongside WorkEasy360', () => {
  it('keeps password sign-in working when not SSO-only, but never for an account linked to WorkEasy360', async () => {
    const email = `owner-${randomUUID().slice(0, 6)}@example.test`;
    const signedIn = await passwordSignUp(A, { name: 'Owner', email, company: 'Password Co', password: 'StrongPass123' });
    expect(signedIn.status).toBe(200);

    // A WorkEasy360 account has no password: the password form and a reset link both refuse it.
    const person = newPerson();
    await signIn(A.app);
    expect((await request(A.app).post('/api/auth/login').set('Origin', APP).send({ email: person.email, password: '!workeasy360-no-password' })).status).toBe(401);
    const user = A.db.prepare('SELECT u.id FROM users u WHERE u.email = ?').get(person.email) as { id: string };
    A.tokens.requestPasswordReset(person.email);
    expect(A.db.prepare('SELECT COUNT(*) AS c FROM password_resets WHERE user_id = ?').get(user.id)).toEqual({ c: 0 });
  });

  it('when SSO-only, refuses every password route and every session not opened by WorkEasy360', async () => {
    const email = `legacy-${randomUUID().slice(0, 6)}@example.test`;
    const legacy = await passwordSignUp(A, { name: 'Legacy', email, company: 'Legacy Co', password: 'StrongPass123' });
    const legacyCookie = cookieFrom(legacy, 'we360_session')!;

    const ssoOnly = load(w360Env({ WORKEASY360_SSO_ONLY: 'true' }));
    expect((await request(ssoOnly.app).get('/api/auth/workeasy360/config')).body.data.ssoOnly).toBe(true);
    for (const [route, body] of [
      ['/api/auth/login', { email, password: 'StrongPass123' }],
      ['/api/auth/login/2fa', { challenge: 'x', code: '123456' }],
      ['/api/auth/signup', { name: 'N', email: 'n@example.test', company: 'C', password: 'StrongPass123', confirmPassword: 'StrongPass123' }],
      ['/api/auth/password/forgot', { email }],
      ['/api/auth/password/reset', { token: 'x'.repeat(30), password: 'StrongPass123', confirmPassword: 'StrongPass123' }],
      ['/api/auth/invitations/accept', { token: 'x'.repeat(30), password: 'StrongPass123', confirmPassword: 'StrongPass123' }],
    ] as const) {
      const res = await request(ssoOnly.app).post(route).set('Origin', APP).send(body);
      expect([route, res.status, res.body.code]).toEqual([route, 403, 'PASSWORD_SIGN_IN_DISABLED']);
    }
    // The password session opened before the switch is refused at once.
    const refused = await me(ssoOnly.app, legacyCookie);
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('WORKEASY360_SIGN_IN_REQUIRED');
    // A WorkEasy360 session works.
    newPerson();
    const { session } = await signIn(ssoOnly.app);
    expect((await me(ssoOnly.app, session!)).status).toBe(200);
    ssoOnly.db.close();
  });
});

describe('operator commands', () => {
  it('links an existing business to an organization, never re-points it, and replaces only an empty first-sign-in business', async () => {
    const email = `clinic-${randomUUID().slice(0, 6)}@example.test`;
    const owner = await passwordSignUp(A, { name: 'Clinic Owner', email, company: 'Existing Clinic', password: 'StrongPass123' });
    const businessId = owner.body.data.user.organization_id as string;

    // A first sign-in already created a business for this organization.
    const person = newPerson();
    const early = await signIn(A.app);
    const earlyBusiness = (await me(A.app, early.session!)).body.data.organization_id as string;

    expect(A.store.linkOrganization(businessId, person.organizationId!, { actor: 'ops@example.test' }).ok).toBe(false);
    const replaced = A.store.linkOrganization(businessId, person.organizationId!, { actor: 'ops@example.test', replaceEmpty: true });
    expect(replaced).toEqual({ ok: true, message: expect.stringContaining(businessId) });
    // The empty business is gone with its sign-ins and sessions; the organization now lands in the clinic.
    expect((await me(A.app, early.session!)).status).toBe(401);
    expect(A.db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(earlyBusiness)).toBeUndefined();
    expect(A.store.linkOrganization(businessId, randomUUID(), { actor: 'ops@example.test' })).toEqual({ ok: false, message: expect.stringContaining('never re-pointed') });

    newPerson(person.organizationId!);
    const joiner = await signIn(B.app);
    const joined = await me(B.app, joiner.session!);
    expect(joined.body.data.organization_id).toBe(businessId);
    expect(joined.body.data.role).toBe('staff');
    expect(earlyBusiness).not.toBe(businessId);
    // The person whose first sign-in made the replaced business joins the clinic like anyone else.
    fake.person = { ...person, sid: randomUUID() };
    const returning = await signIn(A.app);
    expect((await me(A.app, returning.session!)).body.data).toMatchObject({ organization_id: businessId, role: 'staff' });

    // The clinic's password owner keeps working (not SSO-only), now subject to the organization's entitlement.
    const ownerCookie = cookieFrom(owner, 'we360_session')!;
    expect((await me(A.app, ownerCookie)).body.data.workeasy360).toEqual({ signedIn: false, access: { allowed: true, writeAllowed: true, reason: 'entitled' } });
  });

  it('re-keys an existing account to a WorkEasy360 identity when an operator vouches for it, retiring its password', async () => {
    const email = `vouched-${randomUUID().slice(0, 6)}@example.test`;
    const owner = await passwordSignUp(A, { name: 'Vouched', email, company: 'Vouched Co', password: 'StrongPass123' });
    const userId = owner.body.data.user.id as string;
    const businessId = owner.body.data.user.organization_id as string;
    const person = newPerson(randomUUID(), { email });
    expect(A.store.linkOrganization(businessId, person.organizationId!, { actor: 'ops' }).ok).toBe(true);
    expect(A.store.linkUser(userId, person.sub, { issuer: fake.issuer, actor: 'ops' }).ok).toBe(true);
    // Its password session ended and the password no longer works.
    expect((await me(A.app, cookieFrom(owner, 'we360_session')!)).status).toBe(401);
    expect((await request(A.app).post('/api/auth/login').set('Origin', APP).send({ email, password: 'StrongPass123' })).status).toBe(401);
    const { session } = await signIn(A.app);
    const res = await me(A.app, session!);
    expect([res.body.data.id, res.body.data.role]).toEqual([userId, 'admin']);
    expect(A.store.linkUser(userId, randomUUID(), { issuer: fake.issuer, actor: 'ops' }).ok).toBe(false);
  });

  it('refuses to split a person whose subject is linked under another issuer, until the identity move runs', async () => {
    const person = newPerson();
    const { session } = await signIn(A.app);
    const userId = (await me(A.app, session!)).body.data.id as string;
    const old = 'https://auth.workeasy360.example';
    A.db.prepare('UPDATE workeasy360_identities SET issuer = ? WHERE user_id = ?').run(old, userId);
    expect(ssoError((await signIn(A.app)).callback)).toBe('identity_conflict');
    expect(A.store.moveIssuer(old, fake.issuer, { apply: false, actor: 'ops' }).message).toContain('dry run');
    expect(A.store.moveIssuer(old, fake.issuer, { apply: true, actor: 'ops' }).ok).toBe(true);
    fake.person = { ...person, sid: randomUUID() };
    const again = await signIn(A.app);
    expect((await me(A.app, again.session!)).body.data.id).toBe(userId);
  });

  it('runs from the command line (npm run w360:identities) against a database file', () => {
    const file = (A.db as unknown as { name: string }).name;
    const run = spawnSync(process.execPath, ['--import', 'tsx', path.join('scripts', 'workeasy360.ts'), 'identities', '--db', file], {
      cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'development' }, timeout: 60_000,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(fake.issuer);
  });
});

describe('configuration', () => {
  it('refuses WorkEasy360 sessions once WorkEasy360 sign-in is turned off (nothing could end them any more)', async () => {
    newPerson();
    const { session } = await signIn(A.app);
    const off = load({});
    expect((await request(off.app).get('/api/auth/workeasy360/config')).body.data).toEqual({ enabled: false, ssoOnly: false, startUrl: null });
    expect((await request(off.app).get('/api/auth/workeasy360/start')).status).toBe(404);
    expect((await me(off.app, session!)).status).toBe(401);
    off.db.close();
  });

  it('validates the settings at startup and is off without an issuer', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readWorkeasy360Config } = require('../workeasy360/config') as typeof import('../workeasy360/config');
    expect(readWorkeasy360Config({})).toBeNull();
    const base = { ...w360Env(), NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    expect(readWorkeasy360Config(base)?.productCode).toBe('workeasy_booking');
    const bad = (env: Record<string, string | undefined>) => () => readWorkeasy360Config({ ...base, ...env });
    expect(bad({ WORKEASY360_CLIENT_ID: '' })).toThrow(/set all of the WorkEasy360 sign-in settings or none/);
    expect(bad({ WORKEASY360_ISSUER: `${fake.issuer}/` })).toThrow(/must not end with a slash/);
    expect(bad({ WORKEASY360_ISSUER: 'http://accounts.example.test' })).toThrow(/must use https/);
    expect(bad({ NODE_ENV: 'production' })).toThrow(/must use https/);
    expect(bad({ WORKEASY360_REDIRECT_URI: `${APP}/elsewhere` })).toThrow(/must point at \/api\/auth\/workeasy360\/callback/);
    expect(bad({ WORKEASY360_SCOPES: 'openid profile' })).toThrow(/must include openid and email/);
    expect(bad({ WORKEASY360_PRIVATE_KEY: 'not a key' })).toThrow(/not a readable PEM/);
    expect(() => readWorkeasy360Config({ WORKEASY360_SSO_ONLY: 'true' })).toThrow(/SSO_ONLY=true needs/);
    // Loopback is 127.0.0.0/8, localhost and ::1, as the platform defines it: a local run may give the app 127.0.0.33.
    const alias = 'http://127.0.0.33:8333';
    const local = readWorkeasy360Config({ ...base, WORKEASY360_REDIRECT_URI: `${alias}/api/auth/workeasy360/callback`, WORKEASY360_POST_LOGOUT_REDIRECT_URI: `${alias}/login` });
    expect(local?.redirectUri).toBe(`${alias}/api/auth/workeasy360/callback`);
    expect(local?.postLogoutRedirectUri).toBe(`${alias}/login`);
    expect(readWorkeasy360Config({ ...base, WORKEASY360_POST_LOGOUT_REDIRECT_URI: 'http://[::1]:5173/login' })?.postLogoutRedirectUri).toBe('http://[::1]:5173/login');
    for (const host of ['128.0.0.1', '10.0.0.1', '127.0.0.1.example.com']) {
      expect(bad({ WORKEASY360_POST_LOGOUT_REDIRECT_URI: `http://${host}/login` })).toThrow(/must use https/);
    }
    expect(bad({ NODE_ENV: 'production', WORKEASY360_ISSUER: 'https://accounts.workeasy360.com', WORKEASY360_REDIRECT_URI: `${alias}/api/auth/workeasy360/callback` })).toThrow(/WORKEASY360_REDIRECT_URI must use https/);
  });
});
