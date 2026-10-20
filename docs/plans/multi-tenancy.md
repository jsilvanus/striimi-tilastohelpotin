# Multi-tenancy plan

Status: plan only, nothing implemented. Decided 2026-10-20 (Juha).

## Decisions

- A **tenant is one parish**. No hierarchy (no deanery view).
- Tenants are **created by a superadmin**. No self-sign-up.
- Each tenant has its **own YouTube Data API key, OAuth client and Google sign-in, and its own Brevo key**. Nothing is shared in quota or consent screen.
- The install type is set by one environment variable, `INSTALL_MODE=single|multi` (default `single`).
- **Open, leave as is:** whether tenants are addressed by path (`/t/<slug>/...`) or by subdomain. The plan below keeps the tenant lookup in one place so either works.
- **Open:** the database for multi mode (see "Storage"). Recommendation: Postgres.

## Install types

| | `single` (today) | `multi` |
| --- | --- | --- |
| Data | JSON file (`DATA_FILE`) | database |
| Admin login | `ADMIN_PASSWORD` (Basic) | users with sessions: superadmin and tenant admins |
| Credentials | env or the credentials page, one set | per tenant on the credentials page, encrypted |
| Channels, settings, report recipient | one set | per tenant |
| Tenants | implicit, exactly one | created by the superadmin |

`single` must keep working exactly as now, with no new required settings. Existing installs change nothing and cannot be switched to `multi` by accident: switching is a deliberate migration (below).

## What is global today and must become per tenant

From the code at `2d7acb1`:

- `config.youtubeChannelIds`, `config.youtubeApiKey`, `config.oauth`, `config.brevoApiKey`, `config.publicBaseUrl`, `config.adminPassword` (`src/config.js`)
- settings: parish name and logo, live model, report recipient, sender, email template (`store.getSettings`)
- events, forms, analytics, snapshots (`store.listEvents`)
- the credentials file `secrets.enc.json` (`src/secrets.js`) and the `credentials` resolver (`src/credentials.js`)
- the tracker loop (`src/tracker.js`): discovery, hourly YouTube read, due reports, form deletion
- the OAuth `state` map and the single redirect URI (`src/server.js`)

## Design

### Tenant context
Every request and every tracker run gets a `tenant` object: `{ id, slug, name, settings, channelIds }`. Code below the routing layer never reads global config for tenant data. In `single` mode a fixed tenant with id `default` is built from env and the JSON file, so one code path serves both modes.

### Storage
- Introduce a store interface (`getEvent`, `putEvent`, `listEvents`, `getSettings`, `updateSettings`, plus tenant and user methods) with two implementations: the existing JSON store (single only) and a database store (multi).
- Tables: `tenants`, `users`, `sessions`, `tenant_settings`, `tenant_secrets`, `events` (tenant_id, id unique per tenant), `submissions` (tenant_id, event_id, with contact email), `audit` (login, credential changes, tenant create/delete).
- Event ids: a YouTube video id can be followed by two tenants, so the key is `(tenant_id, id)`. Public form URLs must resolve the tenant: either from the path or from a random per-event public token. Decide together with the path/subdomain question; the tracker and report code do not depend on it.
- Database: Postgres is the recommendation (other projects here use it, and several processes can share it). SQLite is acceptable for one host. Choose the access layer (plain SQL or Prisma) before PR 1; this repo has no runtime dependencies today, so adding one is a visible decision.

### Secrets
- Same AES-256-GCM scheme and `SECRETS_KEY`, but entries are stored per tenant (`tenant_secrets`, ciphertext in the row, a unique IV per write). Consider a per-tenant data key wrapped by `SECRETS_KEY` so that a tenant can be wiped or re-keyed independently.
- The credentials page, the Google sign-in and the identity display work per tenant. The OAuth redirect URI stays a single URL; the tenant is carried in `state` (random value mapped to tenant and user, single use, 10 minutes, as now).
- Each tenant registers the redirect URI on its own OAuth client. The deploy guide gets a per-tenant checklist.

### Users and login
- Roles: `superadmin` (creates and deletes tenants, creates tenant admins, sees no form data unless it is also a member) and `tenant_admin` (full admin of one tenant).
- Password hashing with scrypt (node:crypto), a session cookie (HttpOnly, SameSite=Lax, Secure behind TLS), CSRF via the existing same-origin check, login rate limiting, and a first-superadmin bootstrap from env (`SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD`, used only when no superadmin exists).
- A password reset by email through the tenant's Brevo key is out of scope for v1; the superadmin sets a new password.

### Routing
- A single `resolveTenant(req)` function (path prefix or host) is the only place that knows the addressing scheme. Admin pages, the credentials page, OAuth start and callback, and the public form all call it.
- Public pages show the tenant's parish name and logo (already in settings).

### Tracker
- One loop over tenants. Per tenant: discover and read YouTube with that tenant's key, send due reports with its Brevo key, delete forms. Hourly YouTube reads and the one read before a report stay as they are, per tenant.
- A failure in one tenant (bad key, quota) is logged with the tenant slug and never stops the others.
- Spread tenants over the hour (offset by tenant id) so they do not all call YouTube in the same minute.

### Isolation and privacy
- Every query takes the tenant id from the context, never from user input. A test suite creates two tenants and asserts that events, forms, settings, credentials and reports of one are never visible or reachable (including by guessed ids) from the other.
- Each parish is its own controller of the form data; deleting a tenant deletes all its rows and secrets, and the 7-day form deletion applies per tenant.
- Credentials never appear in logs, pages or errors (as today).

## Migration

`single` to `multi`: a one-off command `npm run migrate:to-multi` reads the JSON store and the encrypted secrets file and creates tenant #1 (slug asked for), copies events, forms, settings and credentials, and creates the first superadmin. It refuses to run against a non-empty database. The JSON files are left untouched.

## Deployment

- `docs/DEPLOY.md` gets a multi section: `INSTALL_MODE=multi`, `DATABASE_URL`, `SECRETS_KEY`, `SUPERADMIN_*`, and the database service in `compose.yml` (a second compose file or profile; the single-mode compose file stays as is).
- The Traefik overlay needs no change for path addressing; subdomain addressing needs a wildcard host rule.

## Delivery in four PRs

1. **Storage and tenant context.** Store interface, database store, tenant object threaded through domain, tracker and server; `single` mode runs on the same path with the JSON store and a fixed tenant. All current tests pass unchanged.
2. **Users and login.** Users, sessions, roles, bootstrap, rate limiting; `single` keeps `ADMIN_PASSWORD`.
3. **Tenant routing and credentials.** `resolveTenant`, superadmin screens (create and delete tenants, create admins), per-tenant credentials page and Google sign-in.
4. **Tracker per tenant, migration and deploy.** Multi-tenant loop, quota spreading, `migrate:to-multi`, multi section in the deploy guide, isolation test suite completed.

Each PR keeps `single` mode green; the isolation tests start in PR 1 and grow with each PR.

## Not in scope

Parent organisations or cross-parish views, self-sign-up, billing, per-tenant branding beyond name and logo, email-based password reset, single sign-on.

## Unverified

Nothing in the app has run against real YouTube, Google OAuth or Brevo yet (see the README). Multi-tenancy multiplies those integrations by the number of parishes, so a first real single-tenant run should come before PR 4.
