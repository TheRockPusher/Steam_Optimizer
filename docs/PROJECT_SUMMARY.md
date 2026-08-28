# Project summary

## Product direction

Steam Optimizer is an open-source, read-only Steam Community inventory and badge optimizer. The
product will inspect a public inventory, calculate deterministic badge-completion suggestions,
and help a user decide what to do next. It is not an account operator or marketplace automation
tool.

The current stage includes a FastAPI health endpoint, Steam OpenID 2.0 login, an application-owned
signed session, a profile-only server session check, and server-only SteamApis v2 access through
`STEAMAPI_KEY`. `GET /api/auth/session` checks profile visibility only; it does not request
inventory. After authentication, the client reads one SteamID64-keyed IndexedDB record and requests
`POST /api/auth/inventory` once only when that record is missing or invalid, or when the user
explicitly refreshes inventory. A valid public/private record is rendered without an inventory call;
transient unavailable results are not persisted.

For a public inventory, the inventory endpoint retrieves the complete AppID 753/context 6 inventory
through provider pagination, joins the global normalized AppID 753 market-price generation to
marketable items, and reports explicit price coverage (`complete`, `partial`, or `unavailable`). It
names every defined Steam Community item class, preserves independent game, rarity, and card-border
metadata, and values any item carrying Steam's validated gem-conversion action. Gem cache and refresh
identity uses the exact application ID, numeric item type, and border color from that action. For each
identified trading-card game, it also looks up the canonical booster market item and reports its
provider-denominated order-book values plus Steam's fixed three-card booster-pack size. The React
interface exposes all retrieved items, booster details, separate price and gem coverage, and the
inventory cache refresh timestamp.

## Safety and identity boundary

All purchases, sales, trades, and other Steam actions remain manual. The application must not
automate transactions or require users to provide Steam credentials or secrets.

The identity flow uses Steam OpenID 2.0. OpenID identifies and proves ownership of a SteamID64,
but it does not grant access to a private inventory. SteamApis inventory access therefore still
requires the user's Steam Community inventory to be public. The application never receives Steam
passwords or Steam Guard codes.

## Data handling, compliance, and upstream limits

Profile visibility uses Valve's documented [Steam Web API](https://steamcommunity.com/dev) when its
optional `STEAM_WEB_API_KEY` is configured. The server session endpoint authenticates the signed
session and checks profile visibility only. Inventory retrieval uses the third-party SteamApis v2
provider with the server-only `STEAMAPI_KEY`; the credential is sent only by the backend and never
exposed to the browser. `POST /api/auth/inventory` is called once after an authenticated client
cache miss (including an account or schema invalidation) or after an explicit user refresh. The
request includes the expected SteamID64, and the backend rejects it unless it matches the signed
session before inventory retrieval. A session recheck does not call the inventory endpoint. The
authenticated inventory response is `Cache-Control: no-store`; successful public/private data is
retained only in the browser cache described below. The inventory request is paginated by the
provider; the backend follows its cursors and combines the pages into the complete public AppID
753/context 6 result.

SteamApis is an independent provider and data source, not a Valve guarantee. Its availability,
response fields, pagination behavior, data freshness, and bulk price coverage can differ from Steam
Community at a given time. The global AppID 753 market cache stores normalized fields in a separate
server-side SQLite file, is fresh for 24 hours, and refreshes lazily when a request finds it stale;
there is no scheduled refresh job. If a refresh fails, the last valid generation is retained and
served as a stale fallback. The bulk feed is streamed and discarded after normalization rather than
materialized or retained. Raw feed data, API keys, and redirect URLs are not persisted.

The bulk feed is filtered and joined to marketable inventory items, so some items may have no current
price and the result can be `partial` or `unavailable` even when the inventory itself is public.
SteamApis omits currency metadata from its bulk feed. Order-book values are preserved exactly as
provider-denominated decimals and displayed without a currency symbol. Optimization must not treat
them as monetary values until an authoritative currency contract or explicit configuration exists.

Successful public/private inventory results persist on the client in browser IndexedDB, keyed by
SteamID64, with a schema version and ISO refresh timestamp. A valid matching record avoids another
inventory request until an explicit refresh. Invalid or incompatible records are removed; logout and
account change clear prior-account records and advance a shared cache epoch that prevents older
in-flight requests from repopulating them. Ordinary session expiry does not delete saved inventory.
Inventory is never stored in cookies or `localStorage`, and transient unavailable results do not
overwrite a prior successful record. The project never
receives or stores Steam passwords or Steam Guard codes, presents data as-is, and does not automate
transactions or degrade Steam. It does not imply Valve or Steam endorsement. The [official button
artwork](https://steamcommunity.com/dev) requested on Steam's developer page is local and does not
imply affiliation.

The signed HTTP-only session cookie contains the SteamID64 on the user's device for up to 24 hours
by default and is sent to the Railway-hosted backend for authenticated requests. It is cleared by
logout or expiry; it is an authentication mechanism, not inventory storage. Only validated semantic
gem-yield rows and normalized global market-price rows persist server-side in separate SQLite caches
on the attached `backend-data` volume mounted at `/data`, using the literal
`GEM_PRICE_CACHE_PATH=/data/gem_prices.sqlite3` and
`STEAMAPIS_PRICE_CACHE_PATH=/data/steamapis_prices.sqlite3`. Ordinary restarts and redeploys
preserve those rows; incompatible or corrupt cache data is reset according to its cache schema.
The global caches are not keyed to a SteamID and are not part of logout deletion. The public
[privacy policy and Steam Data disclaimer](../README.md#privacy-and-steam-data-policy) disclose
storage, deletion, warranty, and liability terms.


## Technical direction

- **Backend:** Python, FastAPI, and Pydantic, managed with uv; Ruff, Pyrefly, and pytest provide
  quality checks.
- **Frontend:** React and TypeScript with Vite, managed with pnpm; ESLint and Vitest provide
  quality checks.
- **Architecture:** Keep the backend API, Steam integration, inventory model, and optimizer as
  separable modules. The client owns per-SteamID64 inventory retention in IndexedDB, while the
  backend owns one global normalized AppID 753 market-price generation and the separate gem cache.
  The market generation has a 24-hour freshness window, refreshes lazily with stale-on-failure
  fallback, and has no scheduled job. The future optimizer will be deterministic and pure Python,
  but it must not treat SteamApis order-book decimals as monetary values until an authoritative
  currency contract or explicit configuration exists. The frontend and backend remain independently
  deployable services.
- **Hosting:** Railway project `steam-optimizer`
  (`a6d0c0d3-2a41-486b-9f3b-1de0db5da949`) has a production environment with separate backend
  and frontend services in EU-West (`europe-west4-drams3a`). The browser uses the frontend origin
  for both UI and `/api`; Caddy proxies API traffic to the backend. The attached `backend-data`
  volume is mounted at `/data`; the global market cache uses
  `/data/steamapis_prices.sqlite3`, separate from `/data/gem_prices.sqlite3`.
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
does not rely on a second tag event. The active release-tag ruleset permits new `v*` tags while
preventing their update or deletion, allowing the repository-scoped `GITHUB_TOKEN` to publish the
validated release tag.

The workflow uses Railway CLI 5.44.1 to upload `./backend` and then `./frontend` with
`--path-as-root`, explicitly selecting the project, `production` environment, and service. It
does not use Railway native branch autodeploy, `--detach`, or deprecated `railway.toml` or
`railway.json` configuration. Infrastructure is managed separately with the current
`.railway/railway.ts`, which
omits a volume size so an existing manually-created `backend-data` volume is not resized or
replaced. Release automation uses source-only `railway up` commands and does not apply infrastructure
or create, delete, or replace the attached volume.

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
  lazy global normalized AppID 753 market-price refreshes; it is never exposed to the browser.
- The backend uses `/data/gem_prices.sqlite3` for gem rows and
  `/data/steamapis_prices.sqlite3` for the separate global normalized market-price cache. The
  latter is fresh for 24 hours, refreshes lazily on requests, uses stale-on-failure fallback, and
  has no scheduled refresh process.
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
- General-purpose PostgreSQL application persistence and Redis-backed services
- Marketplace, purchase, sale, trade, or any other transaction automation
- A staging environment and staging deployment automation
