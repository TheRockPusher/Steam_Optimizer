# Project summary

## Product direction

Steam Optimizer is an open-source, read-only Steam Community inventory and badge optimizer. The
product will inspect a public inventory, calculate deterministic badge-completion suggestions,
and help a user decide what to do next. It is not an account operator or marketplace automation
tool.

The current stage includes a FastAPI health endpoint, Steam OpenID 2.0 login, an application-owned
signed session, backend profile checks, and server-only SteamApis v2 access through `STEAMAPI_KEY`.
For a public inventory, it retrieves the complete AppID 753/context 6 inventory through provider
pagination, joins current bulk AppID 753 prices to marketable items, and reports explicit price
coverage (`complete`, `partial`, or `unavailable`). The React interface exposes all retrieved items
and the separate price coverage result.

## Safety and identity boundary

All purchases, sales, trades, and other Steam actions remain manual. The application must not
automate transactions or require users to provide Steam credentials or secrets.

The identity flow uses Steam OpenID 2.0. OpenID identifies and proves ownership of a SteamID64,
but it does not grant access to a private inventory. SteamApis inventory access therefore still
requires the user's Steam Community inventory to be public. The application never receives Steam
passwords or Steam Guard codes.

## Data handling, compliance, and upstream limits

Profile visibility uses Valve's documented [Steam Web API](https://steamcommunity.com/dev) when its
optional `STEAM_WEB_API_KEY` is configured. Inventory retrieval and current bulk AppID 753 prices
use the third-party SteamApis v2 provider with the server-only `STEAMAPI_KEY`. The credential is
sent only by the backend and never exposed to the browser. The inventory request is paginated by
the provider; the backend follows its cursors and combines the pages into the complete public
AppID 753/context 6 result.

SteamApis is an independent provider and data source, not a Valve guarantee. Its availability,
response fields, pagination behavior, data freshness, and bulk price coverage can differ from
Steam Community at a given time. The bulk feed is filtered and joined to marketable inventory
items, so some items may have no current price and the result can be `partial` or `unavailable`
even when the inventory itself is public. SteamApis omits currency metadata from its bulk feed. Order-book
values are preserved exactly as provider-denominated decimals and displayed without a currency symbol.
Optimization must not treat them as monetary values until an authoritative currency contract or explicit
configuration exists.

The project retrieves Steam data only for a user-requested check, never receives or stores Steam
passwords or Steam Guard codes, presents data as-is, and does not automate transactions or degrade
Steam. It does not imply Valve or Steam endorsement. The [official button artwork](https://steamcommunity.com/dev)
requested on Steam's developer page is local and does not imply affiliation. The signed HTTP-only
session cookie contains the SteamID64 on the user's device for up to 24 hours by default, is sent
to the Railway-hosted backend on session requests, and is cleared by logout or expiry. The public
[privacy policy and Steam Data disclaimer](../README.md#privacy-and-steam-data-policy) disclose
storage, deletion, warranty, and liability terms.

No inventory or price payload is currently cached or persisted in a database. Results are joined in
process memory for the requested response only. Railway's backend and frontend services run in
EU-West, exact region `europe-west4-drams3a`; all future Railway processes must use that region.

## Technical direction

- **Backend:** Python, FastAPI, and Pydantic, managed with uv; Ruff, Pyrefly, and pytest provide
  quality checks.
- **Frontend:** React and TypeScript with Vite, managed with pnpm; ESLint and Vitest provide
  quality checks.
- **Architecture:** Keep the backend API, Steam integration, inventory model, and optimizer as
  separable modules. The future optimizer will be a deterministic, pure Python package, but it
  must not treat SteamApis order-book decimals as monetary values until an authoritative currency
  contract or explicit configuration exists. The frontend and backend remain independently
  deployable services.
- **Hosting:** Railway project `steam-optimizer`
  (`a6d0c0d3-2a41-486b-9f3b-1de0db5da949`) has a production environment with separate backend
  and frontend services in EU-West (`europe-west4-drams3a`). All future Railway processes must use
  the same region. The browser uses the frontend origin for both UI and `/api`; Caddy
  proxies API traffic to the backend service.
- **License:** GNU Affero General Public License v3.0, preserving source availability for
  modified hosted versions.

## Production deployment

Production is the only deployed environment; no staging environment exists yet. The release
workflow accepts either a protected `vMAJOR.MINOR.PATCH` tag push or an explicit GitHub UI
dispatch. It validates strict tag syntax, verifies that the release commit is on `origin/main`,
and verifies that the tag matches the backend `project.version`. Normal continuous integration
still runs on pull requests and `main`; the release invokes that reusable CI before deploying.

To start a release from the GitHub UI, merge code changes to `main`, open **Actions → Release →
Run workflow**, keep `main` selected, and choose `patch`, `minor`, or `major` in the **Version
increment** dropdown. The dispatched run derives the next semantic version from the latest release
tag and first commits the synchronized backend project and lockfile version. CI and both Railway
deployments use that exact commit SHA, ensuring the tested, deployed, and tagged source is
identical. The version tag and GitHub release are created only after smoke checks pass; the run
does not rely on a second tag event. The active release-tag ruleset must permit the GitHub Actions
actor to create protected `v*`
tags. Otherwise, the manual run stops before publishing the tag and release; use **Releases →
Draft a new release** and create the protected tag on `main` to use the tag-triggered path.

The workflow uses Railway CLI 5.44.1 to upload `./backend` and then `./frontend` with
`--path-as-root`, explicitly selecting the project, `production` environment, and service. It
does not use Railway native branch autodeploy, `--detach`, or deprecated `railway.toml` or
`railway.json` configuration. Infrastructure is managed separately with the current
`.railway/railway.ts`; release automation deploys source code but does not apply infrastructure.

Configure the following before a production release:

- GitHub repository variable `RAILWAY_PROJECT_ID` must contain
  `a6d0c0d3-2a41-486b-9f3b-1de0db5da949`.
- GitHub `production` environment secret `RAILWAY_TOKEN` must be a Railway project token scoped
  to this project, not an account- or workspace-wide token. Never commit or print this secret.
- GitHub `production` environment variables `BACKEND_URL` and `FRONTEND_URL` must contain the
  actual public URLs of the deployed services. Their values are intentionally not documented
  here.
- The Railway backend service requires `ENVIRONMENT=production`, an exact frontend-origin JSON
  list in `ALLOWED_ORIGINS`, `FRONTEND_URL` and `PUBLIC_BACKEND_URL` set to the frontend origin,
  a random `SIGNING_SECRET` of at least 32 characters, `COOKIE_SECURE=true`, and
  `COOKIE_SAMESITE=lax`.
- The Railway frontend service keeps `VITE_API_BASE_URL` empty and sets runtime `API_UPSTREAM` to
  the public backend origin. Caddy proxies `/api` so authentication uses same-origin cookies.
- `STEAM_WEB_API_KEY` is optional and belongs only in the backend environment for profile checks.
- `STEAMAPI_KEY` belongs only in the backend environment for SteamApis v2 inventory retrieval and
  bulk prices; it is never exposed to the browser.
- Both Railway services and all future Railway processes must run in EU-West, exact region
  `europe-west4-drams3a`.

After deployment, the backend smoke check requests `${{ vars.BACKEND_URL }}/api/health`. Frontend
smoke checks verify the root document, proxied session endpoint, Steam login redirect, callback
origin, and secure state-cookie attributes before release notes are published. The release notes
job is the only job that needs `contents: write`; deployment jobs need only `contents: read`.

There is no backwards-compatibility layer. An incompatible backend/frontend release requires an
explicit maintenance window and a coordinated clean cutover of both services, backend first and
frontend second; do not deploy one service while expecting the previous version of the other to
remain compatible.

## Deliberately deferred

The following are planned later, not missing pieces of the current stage:

- Deterministic badge optimization and recommendation planning
- PostgreSQL persistence and Redis-backed services
- Marketplace, purchase, sale, trade, or any other transaction automation
- A staging environment and staging deployment automation
