[Steam Optimizer](https://github.com/TheRockPusher/Steam_Optimizer) is a read-only Steam
Community inventory adviser for Steam users, written in
[TypeScript](https://www.typescriptlang.org/) and [Python](https://www.python.org/) and
released under the [GNU AGPL v3.0](LICENSE).

[![Python 3.12](https://img.shields.io/badge/Python-3.12-informational)](https://docs.python.org/3.12/)
[![TypeScript 5.9](https://img.shields.io/badge/TypeScript-5.9-informational)](https://www.typescriptlang.org/docs/)
[![React 19.2](https://img.shields.io/badge/React-19.2-informational)](https://react.dev/)
[![FastAPI 0.115](https://img.shields.io/badge/FastAPI-0.115-informational)](https://fastapi.tiangolo.com/)

First released in 2026; current release: 0.1.1 (2026-08-27).
[TheRockPusher](https://github.com/TheRockPusher) maintains it to make Steam inventory and
badge decisions transparent without automating account actions.

## Getting Started

Prerequisites for a fresh Linux, macOS, or Windows development environment:

- [uv](https://docs.astral.sh/uv/)
- [Node.js](https://nodejs.org/) `^22.13` or `>=24`
- [pnpm](https://pnpm.io/installation) 10
- Optional: a server-only [Steam Web API key](https://steamcommunity.com/dev/apikey) for a
  conclusive profile-visibility result.
- A server-only SteamApis v2 key in `STEAMAPI_KEY` for complete public AppID 753/context 6 inventory
  retrieval and the lazily refreshed global normalized AppID 753 market-price cache.

Install and run the backend:

```sh
cd backend
uv sync
cp .env.example .env
# Set a random SIGNING_SECRET in .env. STEAM_WEB_API_KEY is optional for profile visibility;
# STEAMAPI_KEY enables SteamApis inventory retrieval and the global normalized price cache.
uv run uvicorn app.main:app --reload
```

In a second terminal, install and run the frontend:

```sh
cd frontend
corepack pnpm install
corepack pnpm dev
```

The frontend normally opens at <http://localhost:5173> and proxies `/api` to the backend at
<http://localhost:8000>. A representative backend request returns:

```text
GET http://localhost:8000/api/health

{"status":"ok"}
```

Full product boundaries and deferred work are in
[`docs/PROJECT_SUMMARY.md`](docs/PROJECT_SUMMARY.md).

## Current Stage

The current connection and inventory stage provides:

- Browser-based Steam OpenID 2.0 authentication.
- An application-owned, signed, HTTP-only session.
- A profile-only server session check: `GET /api/auth/session` checks profile visibility and does
  not request inventory.
- Inventory is requested once on an authenticated client cache miss (including an account-change or
  invalid-schema miss) or when the user explicitly selects **Refresh inventory**; session rechecks
  do not request inventory. Each request names the expected SteamID64, which the backend verifies
  against the signed session before fetching data. The authenticated inventory response is
  `Cache-Control: no-store`; successful public/private data is retained only in the browser cache
  described below.
- Server-only SteamApis v2 access through `STEAMAPI_KEY`; this credential never reaches the browser.
- Complete public AppID 753/context 6 inventory retrieval, following provider pagination and combining
  all pages.
- Successful public or private inventory results persist in browser IndexedDB records keyed to
  SteamID64, with a schema version and ISO refresh timestamp. The client renders a valid matching
  record without an inventory request; inventory is never stored in cookies or `localStorage`.
  Logout, account change, and invalid or incompatible cache schema clear the affected records.
  Cache-clearing operations also advance a shared IndexedDB epoch so older in-flight requests cannot
  repopulate deleted records. Transient `unavailable` inventory results are not persisted and do not
  replace a prior good result.
- A global normalized AppID 753 market-price generation persisted in a separate server-side SQLite
  cache. It is fresh for 24 hours, refreshes lazily when a request finds it stale, has no scheduled
  refresh job, and serves the last valid generation as a stale fallback when a provider refresh fails.
- Current cached AppID 753 prices are joined to marketable inventory items, with explicit `complete`,
  `partial`, or `unavailable` price coverage: `complete` when all priceable rows are priced,
  `partial` when some but not all priceable rows are priced, and `unavailable` when zero
  priceable rows are priced or no usable provider generation exists.
- Canonical names and independent game, rarity, and card-border metadata for every Steam
  Community item class, with gem eligibility derived from Steam's validated conversion action
  rather than inferred from the class.
- A responsive, sortable inventory interface that paginates all retrieved items, lets users switch
  game grouping on or off, choose lowest-sell or highest-buy gem cash valuation, and filters
  marketable gem-convertible items whose selected per-item gem cash value exceeds their current
  lowest-sell market price.

SteamApis is a third-party provider: inventory availability, response fields, and price snapshots
depend on provider data and availability and may differ from Steam Community at a given time. A
market-price generation can therefore be up to 24 hours old, and a previous valid generation can
remain in use when a lazy refresh fails. The UI classifies price coverage as `complete` when all
priceable rows are priced, `partial` when some but not all priceable rows are priced, and
`unavailable` when zero priceable rows are priced or no usable provider generation exists. SteamApis
omits currency metadata from its bulk feed. Order-book values are preserved exactly as
provider-denominated decimals and displayed without a currency symbol. Optimization must not treat
them as monetary values until an authoritative currency contract or explicit configuration exists.
The provider feed is streamed and discarded after normalization; the raw feed, API key, and redirect
URL are not persisted.

The browser inventory cache and server market cache have separate retention boundaries. Ordinary
browser sessions reuse valid matching public/private records until logout, account change, invalid
schema, or explicit refresh; the displayed timestamp identifies when that record was refreshed.
Only validated semantic gem-yield rows and normalized global market-price rows persist server-side in
separate SQLite caches on the attached `backend-data` Railway volume. Gem cache rows use Steam's
exact conversion identity—application ID, numeric item type, and border color—so cards, profile
backgrounds, emoticons, and other action-bearing classes cannot collide. Ordinary restarts and
redeploys preserve those rows; incompatible or corrupt cache data is reset according to its cache
schema. Railway services run in exact EU-West region `europe-west4-drams3a`.


## Why

Owned cards have an opportunity cost: crafting an expensive owned set can be worse than selling
it and buying a cheaper badge. Steam Optimizer is intended to make those trade-offs explicit,
showing cash outlay separately from foregone sale or gem value only after an authoritative currency
contract or explicit configuration exists. The optimizer itself remains deferred; this stage now reads
the complete public inventory and normalized cached AppID 753 order-book values (normally no more than
24 hours old, with stale fallback on refresh failure) before future optimization work.

## Configuration and Deployment

Both development and production use same-origin browser requests. Keep
`VITE_API_BASE_URL` empty. Vite proxies `/api` locally; production Caddy proxies `/api` to the
backend using its runtime `API_UPSTREAM` variable. This avoids third-party-cookie dependence on
separate Railway-generated domains.

### Local and service configuration

For separate Railway frontend and backend services in EU-West (`europe-west4-drams3a`):

- Frontend: keep `VITE_API_BASE_URL` empty and set `API_UPSTREAM` to the public backend origin.
- Backend: set `ENVIRONMENT=production`, `ALLOWED_ORIGINS` to a JSON list containing the exact
  frontend origin, and `FRONTEND_URL` to that origin.
- Backend: set `PUBLIC_BACKEND_URL` to the frontend origin. Steam returns through the frontend
  `/api` proxy, so session cookies are issued on the same host used by the browser application.
- Backend: set `SIGNING_SECRET` to a random value of at least 32 characters,
  `COOKIE_SECURE=true`, and `COOKIE_SAMESITE=lax`.
- `STEAM_WEB_API_KEY` is optional and belongs only in the backend environment. It enables the
  profile-visibility check.
- `STEAMAPI_KEY` belongs only in the backend environment and is never exposed to the browser. It
  enables SteamApis v2 inventory retrieval and the global normalized AppID 753 price cache.

Each service has its own Dockerfile. Infrastructure is managed separately with the current
`.railway/railway.ts`, which retains one backend replica and attaches the `backend-data` volume in
exact EU-West region `europe-west4-drams3a` at `/data`. It intentionally leaves volume size
unspecified so an existing manually-created volume is not resized or replaced. The cache paths are
`GEM_PRICE_CACHE_PATH=/data/gem_prices.sqlite3` and
`STEAMAPIS_PRICE_CACHE_PATH=/data/steamapis_prices.sqlite3`. The release workflow deploys source
code with `railway up` and does not apply infrastructure or create, delete, or replace the attached
volume. Market-price refresh is lazy and request-triggered; there is no scheduled refresh job.

### Production release deployment

Production is the only deployed environment; there is no staging environment yet. The release
workflow accepts either a protected `vMAJOR.MINOR.PATCH` tag push or an explicit GitHub UI
dispatch. It validates strict tag syntax, verifies that the release commit is on `origin/main`,
and verifies that the tag matches the backend `project.version`. Normal continuous integration
still runs on pull requests and `main`; the release invokes that reusable CI before deploying.

### Run a release from the GitHub UI

After code changes have been merged to `main`, open **Actions → Release → Run workflow**. Keep the
branch set to `main`, choose `patch`, `minor`, or `major` in the **Version increment** dropdown, and
run the workflow. It derives the next semantic version from the latest release tag and creates a
conventional `chore: prepare release vX.Y.Z` commit that updates
`backend/pyproject.toml` and `backend/uv.lock`. That commit SHA is then used by CI and every
Railway deployment, so the tested, deployed, and eventually tagged source is identical.

The version tag and GitHub release are created only after deployment smoke checks pass. A tag
created with `GITHUB_TOKEN` does not start a second workflow. The workflow will not overwrite an
existing tag that points to another commit. The active release-tag ruleset permits new `v*` tags
but prevents their update or deletion; adding a tag-creation restriction would block the
repository-scoped `GITHUB_TOKEN`.

Configure these values before the first production release:

- GitHub repository variable `RAILWAY_PROJECT_ID`: `a6d0c0d3-2a41-486b-9f3b-1de0db5da949`.
- GitHub `production` environment secret `RAILWAY_TOKEN`: a Railway project token scoped to this
  project, not an account- or workspace-wide token. Never commit or print this secret.
- GitHub `production` environment variables `BACKEND_URL` and `FRONTEND_URL`: the actual public
  URLs of the deployed services. Their values are intentionally not documented here.

The release job uses Railway CLI 5.44.1 and uploads `./backend` before `./frontend`, with
`--path-as-root` and explicit project, `production` environment, and service selection. Do not
enable Railway native branch autodeploy, use `--detach`, or add deprecated `railway.toml` or
`railway.json` configuration.

After deployment, the backend smoke check requests `${{ vars.BACKEND_URL }}/api/health`. The
frontend checks request `${{ vars.FRONTEND_URL }}/`, the proxied unauthenticated session endpoint,
and the Steam login redirect. They verify the frontend callback URL and secure login-state cookie
before GitHub release notes are published.

There is no backwards-compatibility layer. An incompatible backend/frontend release requires an
explicit maintenance window and a coordinated clean cutover of both services, backend first and
frontend second; do not deploy one service while expecting the previous version of the other to
remain compatible.

## Checks

Run backend checks:

```sh
cd backend
uv run ruff check .
uv run pyrefly check
uv run pytest
```

Run frontend checks:

```sh
cd frontend
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

## Versioning

The project is pre-1.0 and makes clean breaking changes while it is in rapid development.
Commits follow [Conventional Commits](https://www.conventionalcommits.org/); `git-cliff` derives
release notes in [`CHANGELOG.md`](CHANGELOG.md).

## Participation

- Bug reports: open a focused [GitHub issue](https://github.com/TheRockPusher/Steam_Optimizer/issues).
- Contributions: short-lived branches and focused changes are welcome; follow
  [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Pull requests: describe behavior, scope, verification, and documentation changes; required
  continuous integration checks must pass before review and merge.
- Required checks: Ruff, Pyrefly, and pytest for the backend; ESLint, Vitest, and the Vite build
  for the frontend.
- Legal: no Contributor License Agreement, copyright assignment, or Developer Certificate of
  Origin is currently specified.
- Community venues: GitHub issues and pull requests are the documented collaboration venues.
- Conduct: no separate code of conduct is currently published.

## Authors

- [TheRockPusher](https://github.com/TheRockPusher) —
  [TheRockPusher@users.noreply.github.com](mailto:TheRockPusher@users.noreply.github.com)

## Operational Transparency

- Commercial role or open-core model: none is documented; the repository is GNU AGPL v3.0.
- Non-free components: Steam is a proprietary external service; no non-free component is bundled
  in this repository.
- Centralized services and terms: authentication uses Steam Community/OpenID. Inventory retrieval and
  lazy global AppID 753 market-price refreshes use the third-party SteamApis v2 provider. Profile
  visibility uses Valve's documented [Steam Web API](https://steamcommunity.com/dev) when
  `STEAM_WEB_API_KEY` is configured. `STEAMAPI_KEY` is server-only; neither credential is sent to
  the browser or persisted in the caches. SteamApis response availability, fields, pagination, and
  price snapshots are provider/data-source caveats rather than Valve guarantees. Price coverage is
  `complete` when all priceable rows are priced, `partial` when some but not all priceable rows are
  priced, and `unavailable` when zero priceable rows are priced or no usable provider generation
  exists. SteamApis omits currency metadata from its bulk feed: order-book values are preserved
  exactly as provider-denominated decimals and displayed without a currency symbol. Optimization
  must not treat them as monetary values until an authoritative currency contract or explicit
  configuration exists. The 100,000-call daily term in [Valve's API terms](https://steamcommunity.com/dev/apiterms)
  describes the Web API, not a documented quota for SteamApis.
- Deployment caveat: both Railway services run in exact EU-West region `europe-west4-drams3a`. The
  backend attaches the `backend-data` volume at `/data` and uses the literal
  `GEM_PRICE_CACHE_PATH=/data/gem_prices.sqlite3` and
  `STEAMAPIS_PRICE_CACHE_PATH=/data/steamapis_prices.sqlite3`; source-only `railway up` releases
  preserve that volume rather than creating, deleting, or replacing it. The global market cache
  persists only normalized AppID 753 fields in its separate SQLite file, refreshes lazily for a
  24-hour freshness window, and uses the last valid generation on refresh failure. Raw provider
  feeds, API keys, and redirect URLs are not persisted. Successful public/private inventory
  results persist only in browser IndexedDB keyed to SteamID64, never in cookies or `localStorage`;
  logout, account change, and invalid schema clear them, while transient unavailable results are not
  persisted. There is no scheduled refresh job.

### Privacy and Steam Data Policy

This section is Steam Optimizer's published privacy policy. It applies to the deployed service and
was last updated on 2026-08-28.

- Data handling and privacy policy: the browser redirects to Steam for login, and the backend
  receives the verified SteamID64. The signed, HTTP-only session cookie contains that identifier
  on the user's device for up to 24 hours by default; it is sent to the Railway-hosted backend for
  authenticated requests and cleared by logout or expiry. The session endpoint checks profile
  visibility only. It does not request inventory, and inventory data is never placed in a cookie.
  Steam handles passwords and Steam Guard; Steam Optimizer never receives or stores either.
- Inventory retention and refresh: after authentication, the client reads one current-user browser
  IndexedDB record keyed to SteamID64. A valid matching public/private record is rendered without
  an inventory API call. A missing, mismatched, corrupt, or incompatible-schema record triggers one
  inventory request; thereafter only an explicit **Refresh inventory** requests it again. Each
  successful public/private result replaces the record and stores its schema version, SteamID64, and
  ISO refresh timestamp, which the UI displays. Logout and account change clear old inventory
  records, and invalid schema data is removed. Transient `unavailable` responses are not persisted
  and do not overwrite a prior successful record. Inventory is not persisted server-side, in
  cookies, or in `localStorage`.
- Market-price retention and provider freshness: market prices are a global AppID 753 generation,
  not user-specific inventory data. The backend stores normalized fields only in a separate SQLite
  cache, fresh for 24 hours. It refreshes lazily when a request finds the generation stale, has no
  scheduled job, and serves the last valid generation as a stale fallback when refresh fails.
  The provider feed is streamed rather than materialized or retained. The raw feed, `STEAMAPI_KEY`,
  and redirect URL are not persisted. The separate cache survives ordinary restarts and redeploys
  on the Railway `backend-data` volume at `/data/steamapis_prices.sqlite3`; it is not cleared by a
  user's logout because it contains no SteamID linkage. Price coverage is `complete` when all
  priceable rows are priced, `partial` when some but not all priceable rows are priced, and
  `unavailable` when zero priceable rows are priced or no usable provider generation exists. Null
  prices remain visible as such.
- Currency and upstream caveats: SteamApis omits currency metadata from its bulk feed. Order-book
  values are preserved exactly as provider-denominated decimals and displayed without a currency
  symbol. Optimization must not treat them as monetary values until an authoritative currency
  contract or explicit configuration exists. SteamApis controls upstream availability, pagination,
  response fields, and price freshness; a cached generation may be stale after a failed refresh.
  A public Steam inventory remains required, and provider failures can leave inventory or price
  coverage unavailable without implying that the account is private.
- Sign-in branding: the local button uses the [Steam-requested sign-in
  artwork](https://steamcommunity.com/dev); it does not imply Valve or Steam endorsement or
  affiliation.

Users can clear the local session through **Sign out on this device**; signing out also clears the
browser's IndexedDB inventory records. Deleting browser site data clears the local session and
inventory cache, and an account change invalidates the prior account's records. The global
server-side market and gem caches are not keyed to a user's SteamID and therefore are not part of
logout deletion. Questions or deletion requests can be filed through the repository's
[GitHub issues](https://github.com/TheRockPusher/Steam_Optimizer/issues).

### Steam Data Disclaimer

The Steam Web API, Steam Data, and Valve Brand and Links are provided **as is**, **with all faults**,
and **as available**. To the maximum extent permitted by law, Valve and its suppliers disclaim
express, implied, and statutory warranties, including merchantability, fitness for a particular
purpose, title, non-infringement, and uninterrupted or error-free availability. To the maximum
extent permitted by law, Valve and its suppliers are not liable for any damages—including indirect,
consequential, special, incidental, or punitive damages—arising from these terms or use of the Steam
Web API, Steam Data, or Valve Brand and Links, even if advised that damages were possible. These
exclusions apply regardless of breach of contract, warranty, negligence, or another cause of action.
If you disagree with these conditions, your sole and exclusive remedy is to discontinue use. See
Valve's [Steam Web API Terms of Use](https://steamcommunity.com/dev/apiterms) for the controlling
terms and limitations under applicable law.
