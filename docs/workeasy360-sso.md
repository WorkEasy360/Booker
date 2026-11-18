# Sign-in with WorkEasy360 Accounts

WorkeasyBooking can sign people in with **WorkEasy360 Accounts**, the identity provider of the WorkEasy360 product
family. WorkeasyBooking never sees a WorkEasy360 password. It receives an ID token that names:

- the person (`sub`);
- the WorkEasy360 organization they chose (`organization_id`);
- this product (`product_code`, `workeasy_booking` by default).

It then keeps its own server-side session, maps the organization to one business here, asks WorkEasy360 whether the
organization (and the person) may still use WorkeasyBooking, and ends the session when WorkEasy360 says so
(back-channel logout).

It is **off** until `WORKEASY360_ISSUER` is set. Email and password sign-in keeps working unless
`WORKEASY360_SSO_ONLY=true` ([Password sign-in](#password-sign-in-and-sso-only)).

Who signs in this way: the people who run a business (administrators, managers, staff). Customers who book on the
public booking pages never sign in, and nothing changes for them.

## What happens, step by step

| Step | What WorkeasyBooking does | Where |
|---|---|---|
| Start | `GET /api/auth/workeasy360/start[?organization=<uuid>][&returnTo=/page]`. Generates state, nonce and a PKCE S256 verifier and stores them **in the database** (`workeasy360_login_flows`, 10 minutes). The browser holds only a random flow id in an httpOnly cookie (`__Host-we360_w360_flow` in production). The launcher's organization is forwarded as the `organization` hint; anything that is not a UUID is dropped. | `server/src/workeasy360/routes.ts`, `client.ts` |
| Callback | `GET /api/auth/workeasy360/callback`. **Takes** (deletes) the flow before anything else, so it is used once. Compares the state in constant time. | `routes.ts`, `store.ts` `takeLoginFlow` |
| Code exchange | openid-client 6 `authorizationCodeGrant` with the PKCE verifier. Client authentication is **`private_key_jwt`**: `iss = sub =` client id, `aud` = **the token endpoint** (not the issuer), a 60 s lifetime and a fresh `jti`, signed with the private key (`kid` = `WORKEASY360_KEY_ID`). There is no client secret. | `client.ts` |
| ID token | Verified by openid-client (with non-repudiation checks) and **again by WorkeasyBooking with jose** against `jwks_uri`: key by `kid`, algorithm from an allow-list (RS256, ES256), `iss` exactly `WORKEASY360_ISSUER`, `aud` exactly the client id, `azp`, `exp`/`iat` with 30 s skew, `typ` = `id_token`, `nonce` (constant time), `product_code` = `WORKEASY360_PRODUCT_CODE`, `organization_id` a UUID, `email_verified` = true. | `client.ts` `verifyIdToken` |
| Launcher check | If the sign-in started with `?organization=`, the token must name that organization (`wrong_organization`). | `routes.ts` |
| Ended sign-in | If a logout token already ended this WorkEasy360 sign-in (`sid`), the callback opens nothing (`session_ended`). | `store.ts` `providerSessionEnded` |
| Entitlement | Asks the entitlement endpoint from discovery (`workeasy360_entitlement_endpoint`) for the organization and the person, with a `private_key_jwt` assertion. A denial ends the sign-in with `not_entitled` and the reason. | `entitlements.ts` |
| Business | Maps the WorkEasy360 organization to a business here (`workeasy360_organizations`). The organization's first sign-in creates its business, with this person as administrator, unless `WORKEASY360_PROVISION_ORGANIZATIONS=false`. An existing business is linked with an operator command. | `store.ts` `provisionSignIn` |
| Person | Linked on **(issuer, sub)** (`workeasy360_identities`), never on email. A new person joins an existing business with `WORKEASY360_DEFAULT_ROLE` (`staff`). | `provisionSignIn` |
| Session | Any session the browser already held ends. A new server-side session (`user_sessions`) is opened for that one business, recording the issuer, `sub`, `sid` and WorkEasy360 organization. The cookie is httpOnly, SameSite=Lax, `__Host-we360_session` in production: Secure, host-only. There is never a `.workeasy360.com` cookie. | `auth/session.ts` `createSession` |

Every failure lands on `/login?sso_error=<code>` (plus `&reason=` for a denial). The codes are a fixed vocabulary
(`SsoErrorCode` in `routes.ts`); the sign-in page shows one message per code (`src/lib/workeasy360.ts`). Tokens,
codes, state and nonce are never logged.

## Authorization: organization and role, never `sub` alone

- **One business per account.** A WorkeasyBooking account belongs to exactly one business, so one WorkEasy360 person
  is one account in one business. A person already here for one WorkEasy360 organization who signs in naming another
  is refused (`other_organization`). A session is good only for the business its organization is linked to: if that
  link changes, the session is refused at once (401).
- **Every request** reads the session, the account and its business from the database (`resolveSession`), and every
  route scopes its queries to that business, as before. Another business's records answer 404.
- **Inside the business**, the role decides (`server/src/auth/permissions.ts`), as for password accounts.
- **Roles of people who join through WorkEasy360.** The first person of a business created by a sign-in is its
  administrator. Everyone after that joins as `WORKEASY360_DEFAULT_ROLE` (`staff`, the least privilege: read the
  catalog and their own appointments; set `manager` to give more). They are not tied to a staff record, so the Staff
  page does not list them; an operator changes a role with `npm run w360:set-role`.
- **Accounts linked to WorkEasy360 have no password.** Password sign-in, password reset links and two-factor setup
  never apply to them (`signInUser`, `SIGN_IN_CAPABLE`), so WorkEasy360 stays able to end their sessions.

## Entitlement, on WorkEasy360's schedule

Every authenticated API request to a business linked to a WorkEasy360 organization goes through the gate in
`server/src/workeasy360/access.ts` (called from `requireAuth`). That includes password sessions of a linked business:
they are asked about per organization.

- **Cache:** an answer is kept for `min(revalidate_after, 900)` seconds (at least 30) in the database table
  `workeasy360_entitlements`, shared by every process that opens the database file, plus each process's own copy.
  WorkEasy360 is never asked per request.
- **Denial:** re-asked after 60 s. Until then, and through any outage, it stands; a known denial is kept without
  expiry, so neither a restart nor an outage hands access back. The answer is 403 `WORKEASY360_ACCESS_ENDED` with
  `reason`.
- **Read-only:** while `write_allowed` is false, changes answer 403 `WORKEASY360_READ_ONLY`; reads still work. Changes
  to the person's own sign-in under `/api/auth/` are not blocked.
- **Outage:** a 5xx, a 429, a timeout or a network error is never a denial. The last answer stands; with none yet,
  access continues; WorkEasy360 is asked again after 60 s.
- **Refusal of this product's client:** a 400, 401 or 403 from the entitlement endpoint (a revoked credential, a
  suspended integration) fails **closed** for the whole client. For 60 s every question answers 403
  `WORKEASY360_ACCESS_UNVERIFIED` (other processes learn of it from the shared table), and a 429 within five minutes of
  the refusal counts as one. Then one question is asked again.
- `GET /api/auth/me` is always reachable and reports `workeasy360.access`, so the app can explain the refusal and offer
  sign-out.

## Back-channel logout, and the session check on every request

`POST /api/auth/workeasy360/backchannel-logout` with the form field `logout_token`. It is server to server: no
cookie, no Origin header and no CSRF token; the provider's signature is the authentication.

The logout token is verified with jose against the provider's key set: JOSE `typ` `logout+jwt` (and a `typ` claim, if
present, `logout_token`); signature by `kid` (RS256/ES256); `iss` exactly ours; `aud` our client id; `iat` not in the
future and at most 10 minutes old; `exp` not passed; the back-channel-logout event present; **no `nonce`**; `sub`
and/or `sid`; a `jti`.

Then, in **one SQLite transaction** (`endSessionsForLogoutToken`): the `jti` is recorded once per issuer
(`workeasy360_logout_tokens`); with `sid`, the sessions that WorkEasy360 sign-in opened are revoked (narrowed to `sub`
when both are given) and the `sid` is remembered as ended; with `sub` alone, every session of that person is revoked.

| Answer | When |
|---|---|
| 200 | The token verified. A token whose `jti` was already used also gets 200 and ends nothing (delivery is at least once). |
| 400 `invalid_request` | The token does not verify, or there is no `logout_token`. |
| 503 `temporarily_unavailable` | The key set or the database could not be read; WorkEasy360 delivers again. Nothing was recorded. |

**The per-request check:** every authenticated request resolves its cookie against `user_sessions` in the database
and nothing is cached in a process. A session revoked by a logout token delivered to *any* process is refused (401)
by *every* process that opens the same database file, on its next request.

## Signing out

- **Sign out** (`POST /api/auth/logout`) ends the WorkeasyBooking session only. WorkEasy360 and other products stay
  signed in.
- **Sign out of WorkEasy360 too** (shown in the profile menu only for a WorkEasy360 session) calls
  `POST /api/auth/logout?workeasy360=1`. It ends the WorkeasyBooking session, then returns WorkEasy360's
  `end_session_endpoint` with `id_token_hint`, `client_id` and the registered `WORKEASY360_POST_LOGOUT_REDIRECT_URI`;
  the app sends the browser there and WorkEasy360 asks the person to confirm.

## Register in Super Admin

The platform catalog has **no `workeasy_booking` product yet**: create it first (Products → Add product), or set
`WORKEASY360_PRODUCT_CODE` to whatever code it gets. Then, under Product → Integration (the production host is
`booking.workeasy360.com`, which is not in DNS yet):

| Field | Value |
|---|---|
| Launch URL | `https://booking.workeasy360.com/api/auth/workeasy360/start` (the launcher appends `?organization=<uuid>`) |
| Redirect URI | `https://booking.workeasy360.com/api/auth/workeasy360/callback`, exactly |
| Back-channel logout URI | `https://booking.workeasy360.com/api/auth/workeasy360/backchannel-logout` (same origin as the redirect URI) |
| Post-logout redirect URI | `https://booking.workeasy360.com/login`, exactly what `WORKEASY360_POST_LOGOUT_REDIRECT_URI` says |
| Scopes | `openid email profile organization`. `email` is required (`email_verified` comes with it); `organization` names the business a first sign-in creates. |
| Token endpoint auth method | `private_key_jwt` |
| Sign-in mode | `sso_optional` with login URL `https://booking.workeasy360.com/login` while password sign-in is on; `sso_only` once `WORKEASY360_SSO_ONLY=true` |
| Credential | The **public** key below. Its credential id is `WORKEASY360_KEY_ID`. |

Generate the key pair on the server. The private key goes only into the server's protected settings, never into the
repository or an image:

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out workeasy360-booking.pem   # private: never commit
openssl pkey -in workeasy360-booking.pem -pubout -out workeasy360-booking.pub.pem              # public: paste into Super Admin
```

RSA keys (RS256) work too. Rotating: register the new public key (WorkEasy360 keeps the old credential), switch
`WORKEASY360_KEY_ID` and the key file, restart, then revoke the old credential.

**Hostnames:** WorkEasy360 activates an integration only once every hostname in it is proven by a DNS TXT record
(`_w360-product-verify.booking.workeasy360.com`, ADR-070), or attested by a platform operator for a first-party host.
A dedicated install for one client on `book.<client-domain>` needs its own registration (its own redirect URIs and
proof for that domain), or stays on password sign-in.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `WORKEASY360_ISSUER` | (empty: off) | Exactly the issuer WorkEasy360's discovery document names, **no trailing slash**. https; plain http only for a loopback issuer (`127.0.0.1`, `localhost`) outside production. |
| `WORKEASY360_CLIENT_ID` | | The client id from the registration. |
| `WORKEASY360_KEY_ID` | | The credential id (`kid` of the client assertion). |
| `WORKEASY360_PRIVATE_KEY_FILE` | | PEM file, RSA or EC P-256. Or `WORKEASY360_PRIVATE_KEY` with literal `\n`. |
| `WORKEASY360_PRODUCT_CODE` | `workeasy_booking` | Must equal the ID token's `product_code`. |
| `WORKEASY360_REDIRECT_URI` | `PUBLIC_APP_URL` + `/api/auth/workeasy360/callback` | Must be exactly that path; registered exactly. |
| `WORKEASY360_POST_LOGOUT_REDIRECT_URI` | `PUBLIC_APP_URL` + `/login` | Registered exactly. |
| `WORKEASY360_SCOPES` | `openid email profile organization` | Must include `openid` and `email`. |
| `WORKEASY360_SSO_ONLY` | `false` | `true`: WorkEasy360 is the only way in. |
| `WORKEASY360_DEFAULT_ROLE` | `staff` | `staff` or `manager`, for someone joining an existing business. |
| `WORKEASY360_PROVISION_ORGANIZATIONS` | `true` | `false`: only businesses linked by an operator can be signed in to (`no_business` otherwise). |
| `WORKEASY360_PURCHASE_URL` | the issuer | Where "get WorkeasyBooking" points. |

`ISSUER`, `CLIENT_ID`, `KEY_ID` and the private key must all be set, or none. The server refuses to start otherwise,
or with a trailing slash, a non-https issuer in production, a redirect URI on another path, an unreadable key, scopes
without `openid` and `email`, or `WORKEASY360_SSO_ONLY=true` without the rest. The startup log says whether WorkEasy360
sign-in is on, which issuer it trusts, and whether password sign-in is kept.

The API must sit behind the same origin as the web app (as `DEPLOYMENT.md` already requires), because the callback sets
the session cookie for that origin.

## Password sign-in and SSO-only

**Password sign-in keeps working** while `WORKEASY360_SSO_ONLY` is false, which is the default. Nobody is locked out by
this change. A password account in a business an operator links to WorkEasy360 is then subject to that organization's
entitlement.

**With `WORKEASY360_SSO_ONLY=true`:**

- sign-in, the two-factor step, sign-up and its confirmation, forgot/reset password and accepting a staff invitation
  answer 403 `PASSWORD_SIGN_IN_DISABLED`;
- every session not opened by WorkEasy360 is refused at once (401 `WORKEASY360_SIGN_IN_REQUIRED`);
- the sign-in page shows only "Continue with WorkEasy360".

Switch it on only after every business's administrators can sign in with WorkEasy360: link their businesses and
accounts first (below). Staff are then added in WorkEasy360, not by invitation.

**Existing accounts.** People are keyed on `(issuer, sub)`; nothing is merged by email.

| Existing account | On the person's first WorkEasy360 sign-in |
|---|---|
| Password account with the same email | Refused with `account_conflict`, never merged silently. Run `w360:link-user` first to carry the account (business, role, staff record) over; its password is retired and its sessions end. |
| WorkEasy360 account under a **previous issuer name** (the move from `auth.` to `accounts.workeasy360.com`, ADR-067) | Refused with `identity_conflict` instead of creating a second account. Run `w360:move-issuer` in the same release that changes `WORKEASY360_ISSUER`. |

## Operator commands

Run from `server/`, on the server, against the database file (there is no default, so the wrong file cannot be picked
by accident). Each command runs in one transaction and is recorded in the `workeasy360_audit` table.

| Command | What it does |
|---|---|
| `npm run w360:link-org -- --db <file> --business <org-id> --organization <workeasy360-org-uuid> --actor <you> [--replace-empty]` | Sign-ins from that WorkEasy360 organization land in this existing business. A business already linked to another organization is never re-pointed. If a first sign-in already created a business for the organization, it refuses; with `--replace-empty` it deletes that business instead, but only if it is still empty (no customers, appointments, services, staff, workspaces, resources or booking pages), with its accounts and sessions. |
| `npm run w360:link-user -- --db <file> --user <user-id> --subject <workeasy360-sub> --actor <you> [--issuer <issuer>]` | You vouch that an existing account is this WorkEasy360 person. It keeps its business, role and staff record, signs in with WorkEasy360 only from now on (password retired, sessions ended). Refused when that identity already has its own account. `--issuer` defaults to `WORKEASY360_ISSUER`. |
| `npm run w360:set-role -- --db <file> --user <user-id> --role admin\|manager\|staff --actor <you>` | Changes the role of someone who joined through WorkEasy360 (they have no staff record for the Staff page). |
| `npm run w360:move-issuer -- --db <file> --from <old> --to <new> --actor <you> [--apply]` | The identity move of an issuer change: every `(old, sub)` becomes `(new, sub)`, with open sessions. Without `--apply` it only reports. It refuses, listing them, when a subject already has an account under the new issuer: two accounts are never merged. |
| `npm run w360:identities -- --db <file>` | Accounts and open sessions per issuer, and how many businesses are linked. |

## Run it locally against a WorkEasy360 provider on `http://127.0.0.1:8031`

1. Run a WorkEasy360 platform locally with issuer `http://127.0.0.1:8031`.
2. In its Super Admin, create the catalog product `workeasy_booking` and register the integration with:
   - redirect URI `http://localhost:5173/api/auth/workeasy360/callback`;
   - back-channel logout URI `http://localhost:5173/api/auth/workeasy360/backchannel-logout`;
   - post-logout URI `http://localhost:5173/login`;
   - scopes `openid email profile organization`; `private_key_jwt`; sign-in mode `sso_optional`, login URL
     `http://localhost:5173/login`.
3. Generate a key pair (above), add the public key, activate, and grant the product to a test organization. Loopback
   hosts need no DNS proof, and http redirect URIs are accepted outside production.
4. In `server/.env`:

   ```dotenv
   PUBLIC_APP_URL=http://localhost:5173
   WORKEASY360_ISSUER=http://127.0.0.1:8031
   WORKEASY360_CLIENT_ID=<client id>
   WORKEASY360_KEY_ID=<credential id>
   WORKEASY360_PRIVATE_KEY_FILE=../secrets/workeasy360-booking.pem
   ```

5. `npm run dev:all` in the project root (API on 3001, web app on 5173; Vite forwards `/api` to the API, so the
   callback and the cookie are on `localhost:5173`).
6. Open `http://localhost:5173/login` and choose **Continue with WorkEasy360**, or open
   `http://localhost:5173/api/auth/workeasy360/start?organization=<organization uuid>` as the launcher would.

The platform must be able to reach `http://localhost:5173/api/auth/workeasy360/backchannel-logout` (or the API on
`http://localhost:3001` directly) for back-channel logout.

### Proving 200 vs 401 from a script

The protected endpoint is **`GET /api/auth/me`**. The credential is the session cookie the callback sets:
`we360_session` over http, `__Host-we360_session` in production.

```bash
# after signing in in a browser, copy the cookie value from the browser's developer tools
curl -s -o /dev/null -w '%{http_code}\n' -H 'Cookie: we360_session=<value>' http://localhost:5173/api/auth/me   # 200
# sign out everywhere in WorkEasy360 (it delivers a logout token), then the same call:
curl -s -o /dev/null -w '%{http_code}\n' -H 'Cookie: we360_session=<value>' http://localhost:5173/api/auth/me   # 401
```

In production: `Cookie: __Host-we360_session=<value>` against `https://booking.workeasy360.com/api/auth/me`. The body
of the 200 also says `"workeasy360": {"signedIn": true, "access": {...}}`; any other organization-scoped call (for
example `GET /api/customers`) answers 403 `WORKEASY360_ACCESS_ENDED` once the organization is no longer entitled.

## Tests

`server/src/tests/workeasy360.test.ts` runs against a fake WorkEasy360 provider (`workeasy360-fake-provider.ts`)
served over real HTTP on 127.0.0.1 with keys generated at start. It serves discovery, the key set, authorize, token
(checking `private_key_jwt` with `aud` = the token endpoint, and PKCE, as the platform does), entitlement and
end-session. Two app instances run side by side, each its own module graph with its own connection to the same
database file. The tests cover: the happy path; a wrong issuer, audience, signature, nonce or `typ`; a missing or used
flow and a wrong state; a wrong product; a missing organization; an unverified email; another organization than the
launcher asked for; an organization that is not entitled; WorkEasy360's own refusal; cross-organization access; an
unlinked account with the same email; entitlement denial, read-only, outage and refusal of the client (fail closed,
shared with another instance); logout tokens valid (by `sid` and by `sub`), forged (bad signature, other issuer,
other audience, wrong `typ`, no event, a nonce, expired, neither `sub` nor `sid`, not a JWT), a replayed `jti`, a
sign-in in flight after its `sid` was ended; a logout delivered to one instance refused at once on both; both
sign-outs; password sign-in kept, and refused for linked accounts; SSO-only; the operator commands, including the
command line; the configuration rules. `workeasy360-entitlements.test.ts` covers the cache's timing rules with a
clock the test moves. `tests/unit/workeasy360.test.ts` covers the sign-in page's messages.

Jest runs the suite as CommonJS, and openid-client and jose are ES modules only, so `jest.global-setup.cjs` builds a
CommonJS bundle of each once (`scripts/jest-esm-deps.cjs`, with esbuild) and `moduleNameMapper` points the tests at it.
The compiled server loads the real packages with Node's `require()` of ES modules (Node 22.13+ / 24).

## Not covered yet (before go-live)

- **Not registered and not deployed.** There is no `workeasy_booking` product in the platform catalog, no
  integration, no key, and `booking.workeasy360.com` has no DNS record or TXT proof. Nothing here has run against the
  real WorkEasy360 Accounts; only the fake provider.
- **One business per account.** A person who belongs to several WorkEasy360 organizations can use WorkeasyBooking in
  one of them (`other_organization` for the others), because a WorkeasyBooking account has exactly one business.
- **Roles of WorkEasy360 joiners** are set with an operator command, not on the Staff page, and joiners are not linked
  to a staff record (so they are not bookable staff). Linking a joiner to a staff record from the app is not built.
- **Automatic start** for SSO-only products (integration guide 6b): someone who opens WorkeasyBooking with no session
  sees the sign-in page with "Continue with WorkEasy360"; the app does not start the sign-in by itself.
- `prompt=login` ("confirm it's you") for sensitive actions is not used.
- **One process.** The deployment documents run exactly one API process on one SQLite file. The shared tables make a
  logout or a refusal seen by one process hold for every process on the same file (tested with two instances), but
  several machines would need a shared database, which this product does not support.
- The per-client "one client on one server" install (`PRODUCTION_LAUNCH.md`) and a multi-business
  `booking.workeasy360.com` are both possible; which one WorkEasy360 sells is a product decision.
