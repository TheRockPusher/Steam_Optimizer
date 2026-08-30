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
# The example includes the verified USD buyer-total fee group and active 900/3600
# quote/inventory freshness limits.
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

The current connection, inventory, and read-only recommendation stage provides:

- Browser-based Steam OpenID 2.0 authentication.
- An application-owned, signed, HTTP-only session.
- A profile-only server session check: `GET /api/auth/session` checks profile visibility and does
  not request inventory.
- Inventory is requested once on an authenticated client cache miss (including an account-change
  or invalid-schema miss) or when the user explicitly selects **Refresh inventory**. Session
  rechecks do not request inventory. Each request names the expected SteamID64, which the backend
  verifies against the signed session before fetching data. The authenticated inventory response
  is `Cache-Control: no-store`.
- Server-only SteamApis v2 access through `STEAMAPI_KEY`; this credential never reaches the browser.
  The backend follows provider pagination for complete public AppID 753/context 6 inventory
  retrieval and maintains a separate normalized AppID 753 market-price generation.
- Successful public or private inventory results persist only in browser IndexedDB records keyed to
  SteamID64, with a schema version and ISO refresh timestamp. The client renders a valid matching
  record without an inventory request; inventory is never stored in cookies or `localStorage`.
  Logout, account change, and invalid or incompatible cache schema clear the affected records.
  Cache-clearing operations also advance a shared IndexedDB epoch so older in-flight requests
  cannot repopulate deleted records. Transient `unavailable` inventory results are not persisted
  and do not replace a prior good result.
- A global normalized AppID 753 market-price generation persisted in a separate server-side SQLite
  cache. It is fresh for 24 hours for inventory display, refreshes lazily, has no scheduled refresh
  job, and keeps the last valid generation as a stale display fallback when refresh fails.
- Current cached AppID 753 prices are joined to marketable inventory items with explicit
  `complete`, `partial`, or `unavailable` price coverage.
- Canonical names and independent game, rarity, and card-border metadata for every Steam Community
  item class, with gem eligibility derived from Steam's validated conversion action rather than
  inferred from the class.
- A responsive inventory interface with separate Items and Boosters views, sortable and paginated
  item data, optional game grouping, selectable lowest-sell or highest-buy gem cash valuation, and
  filtering for marketable gem-convertible items whose selected gem cash value exceeds their
  current lowest-sell market price.
- A third, manually activated **Level-up optimization** tab in the **Inventory and level-up
  planning** section. Items remains the default tab, and the optimizer does not request anything
  until the user opens this tab. It requires a public inventory and an eligible ownership
  timestamp; otherwise it shows the existing recovery or **Refresh inventory** state.
- On activation, the frontend aggregates only normal trading-card rows from the current IndexedDB
  inventory record into a bounded transient snapshot: exact `market_hash_name`, `owned_quantity`,
  `sellable_quantity`, and the record's `inventory_refreshed_at`. It submits that snapshot to
  `POST /api/auth/level-up` with the signed session and matching `x-expected-steam-id` header.
  The endpoint never calls the inventory provider, logs holdings, or stores the submitted snapshot.
- The endpoint reads one bounded Valve `IPlayerService/GetBadges/v1` response on the server for
  the signed SteamID64. It uses `player_xp`, `player_level`, and normal game badges only
  (`border_color == 0`); foil and non-game badges are ignored. Badge response data is not
  persisted or exposed to the browser beyond the recommendation result.
- A complete `ready` response is one deterministic, fully funded advisory plan: sell one copy of
  every card in one owned normal set into current highest bids, buy up to five cheaper complete
  normal sets at current lowest asks, and compare the resulting badge XP. The response includes
  exact card rows, top-of-book depth and quote times, per-item Steam and publisher fees, estimated
  seller receipts, purchase totals, unspent swap proceeds, and player/level projections.
- Plans remain in React memory only while the account and ownership snapshot are unchanged. They
  are never written to IndexedDB, `localStorage`, cookies, or a server-side user cache. Account
  changes, logout, inventory refresh, and component unmount invalidate or discard the in-memory
  plan; quote expiry downgrades any retained rows to an expired, non-actionable state until the
  user refreshes the recommendation.
- Every Steam Market and gamecards link is fixed to the Steam Community origin and is ordinary
  manual navigation. The application does not accept provider-supplied URLs and never lists,
  orders, buys, sells, trades, or crafts on the user's behalf. Steam's live confirmation remains
  authoritative, and users must recheck prices and fills before acting.

SteamApis is a third-party provider: inventory availability, response fields, pagination, and
price snapshots depend on provider data and may differ from Steam Community at a given time. The
inventory display generation is fresh for 24 hours, refreshes lazily, and can use the last valid
generation as a stale fallback when a refresh fails. The optimizer has a stricter, independent
freshness contract: quote data must be within `LEVEL_UP_MAX_QUOTE_AGE_SECONDS` (the example is
900 seconds) and the submitted inventory snapshot must be within
`LEVEL_UP_MAX_INVENTORY_AGE_SECONDS` (the example is 3600 seconds). It never uses the 24-hour
stale fallback to produce a recommendation. Missing top-bid/top-ask depth, unresolved set
metadata, stale generations, or provider failures produce an unavailable or warming state rather
than a partial plan. The UI distinguishes `complete`, `partial`, and `unavailable` inventory
price coverage; those display states do not make provider-denominated decimals monetary values.
The raw provider feed is streamed and discarded after normalization. A generation becomes
optimizer-eligible only when its AppID 753 metadata declares an item count exactly equal to the
number of completely parsed item rows; mismatched or missing completeness metadata preserves the
prior generation instead. Raw feeds, API keys, and redirect URLs are not persisted.

The optimizer is fail-closed behind one explicit, verified money contract. The checked-in service
configuration uses USD with two minor digits, the `buyer_total` price basis, a 5% Steam fee, a
10% publisher fee, and a one-cent minimum for each per-item fee component. Settings validate the
contract as one atomic group: clearing a field disables recommendations, while an invalid complete
group prevents startup. Operators must review and replace every monetary value together.
Each item is converted exactly to integer minor units, and fees are calculated per item under the
returned contract, with taxes, holds, and an existing wallet balance excluded.

Known unavailable and warming states are explicit: `currency_contract_missing`,
`steam_web_api_key_missing`, `badge_data_unavailable`, `inventory_snapshot_too_old`,
`price_generation_unavailable`, `price_generation_stale`, `quote_depth_unavailable`, and
`catalog_warming`. Valid inputs with no qualifying source or positive-XP swap return
`no_complete_sellable_set` or `no_positive_xp_swap`; they do not render a zero-valued
recommendation. No response is treated as actionable when any contract, identity, badge, price,
depth, catalog, or freshness gate is unresolved.

The browser inventory cache and server market cache have separate retention boundaries. Ordinary
browser sessions reuse valid matching public/private records until logout, account change,
invalid schema, or explicit refresh; the displayed timestamp identifies when that record was
refreshed. Only validated semantic gem-yield rows and normalized global market-price rows persist
server-side in separate SQLite caches on the attached `backend-data` Railway volume. Railway
services run in exact EU-West region `europe-west4-drams3a`.

## Why

Owned cards have an opportunity cost: crafting an expensive owned set can be worse than selling it
and buying cheaper badges. The shipped optimizer makes that trade-off explicit with exact
configured-currency arithmetic and a clearly labeled estimate. It remains an advisory read-only
comparison: sale proceeds are estimated rather than received, destination purchases and badge
crafts remain manual, and Steam's final confirmation is authoritative.

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
- `STEAM_WEB_API_KEY` is optional for profile visibility but is required by the level-up endpoint
  to verify authenticated badge state; it belongs only in the backend environment.
- `STEAMAPI_KEY` belongs only in the backend environment and is never exposed to the browser. It
  enables SteamApis v2 inventory retrieval and the global normalized AppID 753 price cache.
- Level-up recommendations use the complete verified monetary group:
  `LEVEL_UP_CURRENCY_CODE=USD`, `LEVEL_UP_CURRENCY_MINOR_DIGITS=2`,
  `LEVEL_UP_PRICE_BASIS=buyer_total`, `LEVEL_UP_STEAM_FEE_BPS=500`,
  `LEVEL_UP_PUBLISHER_FEE_BPS=1000`, and `LEVEL_UP_MIN_FEE_MINOR=1`.
  `LEVEL_UP_MAX_QUOTE_AGE_SECONDS=900` and
  `LEVEL_UP_MAX_INVENTORY_AGE_SECONDS=3600` bound freshness. Operators must review and replace
  the complete group together; clearing one member disables recommendations.

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
- Centralized services and terms: authentication uses Steam Community/OpenID. Inventory retrieval
  and lazy global AppID 753 market-price refreshes use the third-party SteamApis v2 provider.
  Profile visibility and authenticated badge-state reads use Valve's documented
  [Steam Web API](https://steamcommunity.com/dev) when `STEAM_WEB_API_KEY` is configured.
  `STEAMAPI_KEY` and `STEAM_WEB_API_KEY` are server-only; neither credential is sent to the
  browser or persisted in caches. The level-up endpoint reads one bounded
  `IPlayerService/GetBadges/v1` response for the signed SteamID64, uses only player XP/level and
  normal (`border_color == 0`) game badges, and does not retain that response. Foil and non-game
  badges are ignored.
- Provider caveat: SteamApis response availability, fields, pagination, price snapshots, and
  top-of-book depth are provider/data-source facts rather than Valve guarantees. Price coverage is
  `complete` when all priceable rows are priced, `partial` when some but not all priceable rows are
  priced, and `unavailable` when zero priceable rows are priced or no usable provider generation
  exists. The 100,000-call daily term in [Valve's API terms](https://steamcommunity.com/dev/apiterms)
  describes the Web API, not a documented quota for SteamApis. The inventory display cache may
  retain a stale 24-hour generation after a failed lazy refresh; the optimizer independently
  rejects stale generations and quotes beyond its configured age limits.
- Money and recommendation caveat: SteamApis omits currency metadata from its bulk feed, so
  ordinary order-book values remain exact provider-denominated decimals and display without a
  currency symbol. The optimizer is enabled only by a complete, verified `LEVEL_UP_*` contract
  with an uppercase currency code, integer minor digits, the exact `buyer_total` basis, fee rates,
  per-item minimum, and freshness windows. It converts prices exactly to integer minor units and
  applies fees per item. An absent or cleared contract member fails closed as
  `currency_contract_missing`; an invalid complete group prevents backend startup. Missing badge
  data, stale/unavailable price generations, missing quote depth, old ownership snapshots, and
  unresolved catalog metadata likewise return explicit unavailable or warming states, never a
  partial plan.
- Deployment caveat: both Railway services run in exact EU-West region `europe-west4-drams3a`. The
  level-up endpoint runs inside the existing backend service; it adds no service, process,
  scheduler, region, or volume. The backend attaches the `backend-data` volume at `/data` and
  uses the literal `GEM_PRICE_CACHE_PATH=/data/gem_prices.sqlite3` and
  `STEAMAPIS_PRICE_CACHE_PATH=/data/steamapis_prices.sqlite3`; source-only `railway up` releases
  preserve that volume rather than creating, deleting, or replacing it. The global market cache
  persists only normalized AppID 753 fields in its separate SQLite file, refreshes lazily for a
  24-hour freshness window, and uses the last valid generation on refresh failure. Raw provider
  feeds, API keys, redirect URLs, submitted ownership snapshots, and recommendation plans are
  not persisted. Successful public/private inventory results persist only in browser IndexedDB
  keyed to SteamID64, never in cookies or `localStorage`; there is no scheduled refresh job.

### Privacy and Steam Data Policy

This section is Steam Optimizer's published privacy policy. It applies to the deployed service and
was last updated on 2026-08-29.

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
- Level-up snapshot and plan handling: opening the manually activated tab aggregates only normal
  trading-card ownership from that current IndexedDB record and submits a bounded transient
  snapshot containing exact market hashes, owned/sellable quantities, and
  `inventory_refreshed_at` to the authenticated `POST /api/auth/level-up` endpoint. The snapshot
  is used only for that request: it is not logged, linked to a persistent server row, or stored by
  the backend, and the endpoint never calls the inventory provider. The returned advisory plan is
  held in React memory only while the account and snapshot remain unchanged; it is never written to
  IndexedDB, `localStorage`, cookies, or a server-side user cache. Account changes, logout,
  inventory refresh, and unmount discard it. Quote expiry retains the rows only in React memory as
  non-actionable audit information until refresh or another lifecycle invalidation.
- Badge-state handling: the backend makes one bounded server-only
  `IPlayerService/GetBadges/v1` request for the signed SteamID64 when calculating a recommendation.
  It reads player XP, player level, and normal game badges (`border_color == 0`), ignoring foil and
  non-game badges. The Web API key and raw badge response remain server-side and are not persisted;
  only validated badge-derived fields needed in the response can reach the browser.
- Market-price retention and provider freshness: market prices are a global AppID 753 generation,
  not user-specific inventory data. The backend stores normalized fields only in a separate SQLite
  cache, fresh for 24 hours for inventory display. It refreshes lazily when a request finds the
  generation stale, has no scheduled job, and serves the last valid generation as a stale fallback
  when refresh fails. The optimizer uses a separate stricter freshness check and fails closed on a
  stale generation, stale quote, or missing quote depth. The provider feed is streamed rather than
  materialized or retained. The raw feed, `STEAMAPI_KEY`, and redirect URL are not persisted. The
  separate cache survives ordinary restarts and redeploys on the Railway `backend-data` volume at
  `/data/steamapis_prices.sqlite3`; it is not cleared by a user's logout because it contains no
  SteamID linkage. Price coverage is `complete` when all priceable rows are priced, `partial`
  when some but not all priceable rows are priced, and `unavailable` when zero priceable rows are
  priced or no usable provider generation exists. Null prices remain visible as such.
- Currency and recommendation caveats: SteamApis omits currency metadata from its bulk feed.
  Ordinary order-book values are preserved exactly as provider-denominated decimals and displayed
  without a currency symbol. The optimizer displays money only after the complete verified
  `LEVEL_UP_*` contract supplies the currency code, minor digits, exact `buyer_total` basis, fee
  rates, per-item minimum, and freshness windows. It converts values exactly to integer minor
  units and applies fees per item. An absent or cleared contract member returns an unavailable
  state; an invalid complete group prevents backend startup. Unverified badge data, prices, depth,
  catalog metadata, or freshness return an explicit unavailable or warming state and no partial
  plan. `estimated seller receipt` and `unspent swap proceeds` are estimates, not received funds;
  taxes, holds, and the current wallet balance are excluded.
- Manual Steam navigation: Market listing and gamecards links are constructed from fixed
  `steamcommunity.com` origins. They are ordinary navigation only; Steam Optimizer never lists,
  orders, buys, sells, trades, or crafts on the user's behalf, and it never accepts provider URLs.
  Users must recheck live Steam prices, fills, and confirmations before taking any manual action.
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
