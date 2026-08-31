# Project summary

## Product direction

Steam Optimizer is an open-source, read-only Steam Community inventory and badge optimizer. The
shipped product inspects a public inventory, calculates one deterministic badge-completion
comparison, and helps a user decide what to do next. It is not an account operator or marketplace
automation tool.

The current stage includes a FastAPI health endpoint, Steam OpenID 2.0 login, an application-owned
signed session, concurrent profile and badge-progress session checks, and server-only SteamApis v2
access through `STEAMAPI_KEY`. `GET /api/auth/session` returns profile visibility plus a validated
badge snapshot containing current XP, level, `checked_at`, and bounded normal badge levels; it does
not request inventory. After authentication, the client reads one SteamID64-keyed IndexedDB record
and requests `POST /api/auth/inventory` only when that record is missing or invalid, or when the user
explicitly refreshes inventory. A valid public/private record is rendered without an inventory call;
transient unavailable results are not persisted.

For a public inventory, the inventory endpoint retrieves the complete AppID 753/context 6 inventory
through provider pagination, joins the global normalized AppID 753 market-price generation to
marketable items, and reports explicit price coverage (`complete`, `partial`, or `unavailable`).
It names every defined Steam Community item class, preserves independent game, rarity, and
card-border metadata, and values any item carrying Steam's validated gem-conversion action. Gem
cache and refresh identity uses the exact application ID, numeric item type, and border color from
that action. For each identified trading-card game, it also looks up the canonical booster market
item and reports its provider-denominated order-book values plus Steam's fixed three-card
booster-pack size. The React interface has two top-level pages: **Inventory** and **Level-up**.
Inventory is selected by default and starts with quantity-aware highest-buy and lowest-sell
top-quote estimates plus per-side item-type coverage. Each owned copy is marked at the current top
quote; order-book depth is not included. The existing item browser and booster details follow.

The **Level-up** page shows current total XP and level from the latest in-memory session badge
snapshot. The authenticated session check performs one bounded badge-provider read when it runs; the
optimizer reuses that snapshot without contacting the badge provider during planning. A bounded
target-level input derives the exact Steam XP threshold delta and rounds the result up to whole
100-XP badge crafts. The existing swap optimizer remains manual-activation and read-only: it reuses
the current browser inventory record and its loaded game metadata, sends one bounded request to
`POST /api/auth/level-up` with the signed session and matching `x-expected-steam-id` header, and
returns a complete advisory plan or an explicit no-opportunity or unavailable state. The endpoint
does not fetch inventory or badges, never resolves booster/card-set metadata, and does not store the
submitted snapshot.

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
session and concurrently checks profile visibility plus one bounded badge response. Badge failure is
isolated from the profile and session; only the validated XP, level, `checked_at`, and normal badge
levels reach React memory. Inventory retrieval uses the third-party SteamApis v2 provider with the
server-only `STEAMAPI_KEY`; the key is never exposed to the browser. `POST /api/auth/inventory` is
called once after an authenticated client cache miss (including an account or schema invalidation)
or after an explicit user refresh.
The request
includes the expected SteamID64, and the backend rejects it unless it matches the signed session
before inventory retrieval. A session recheck does not call the inventory endpoint. The
authenticated inventory response is `Cache-Control: no-store`; successful public/private data is
retained only in the browser cache described below. The inventory request is paginated by the
provider; the backend follows its cursors and combines the pages into the complete public AppID
753/context 6 result.

SteamApis is an independent provider and data source, not a Valve guarantee. Its availability,
response fields, pagination behavior, data freshness, top-of-book depth, and bulk price coverage
can differ from Steam Community at a given time. The global AppID 753 market cache stores
normalized fields in a separate server-side SQLite file, is fresh for 24 hours for inventory
display, and refreshes lazily when a request finds it stale; there is no scheduled refresh job. If
a refresh fails, the last valid generation is retained as a stale fallback for inventory display.
The optimizer uses an independent strict freshness gate and never uses that stale fallback for a
recommendation. A generation becomes optimizer-eligible only when the AppID 753 bulk metadata's
declared item count equals the number of completely parsed item rows. Missing or mismatched
completeness metadata aborts the refresh and preserves the prior generation. The bulk feed is
streamed and discarded after normalization rather than materialized or retained. Raw feed data,
API keys, and redirect URLs are not persisted.

The bulk feed is filtered and joined to marketable inventory items, so some items may have no
current price and the result can be `partial` or `unavailable` even when the inventory itself is
public. SteamApis omits currency metadata from its bulk feed. Ordinary order-book values are
preserved exactly as provider-denominated decimals and displayed without a currency symbol; they
are not money until the provider contract has been verified and configured.

### Level-up recommendation boundary

The **Level-up** page is manually activated beside **Inventory**, which remains selected by
default. Its swap optimizer is available only for a public inventory with a fresh ownership
timestamp. On activation, the frontend reuses already-loaded inventory items, game metadata,
badges, and boosters. It joins every normal-card AppID to the inventory game name and card-set size
and to the in-memory session badge snapshot in linear maps. All normal-card games are included,
including games with no sellable source card:

```json
{
  "inventory_refreshed_at": "2026-08-28T12:00:00Z",
  "badge_refreshed_at": "2026-08-28T12:01:00Z",
  "player_xp": 1200,
  "player_level": 12,
  "games": [
    {
      "app_id": "440",
      "game_name": "Team Fortress 2",
      "card_set_size": 8,
      "badge_level": 1
    }
  ],
  "cards": [
    {
      "market_hash_name": "440-Test Card (Trading Card)",
      "owned_quantity": 2,
      "sellable_quantity": 1
    }
  ]
}
```

The client sends that complete snapshot once to `POST /api/auth/level-up` with the signed session
and matching `x-expected-steam-id` header. `sellable_quantity` follows `marketable`; `tradable` is
unrelated to Steam Market eligibility. The endpoint never calls `check_inventory`, never contacts
the badge or inventory providers during planning, never resolves booster/card-set metadata, never
logs holdings, and never stores the submitted snapshot. The recommendation plan remains in React
memory only while the account and snapshot are unchanged. It is never written to IndexedDB,
`localStorage`, cookies, or a server-side user cache. Logout, account changes, inventory refresh,
and unmount invalidate it; quote expiry downgrades any retained rows to an expired, non-actionable
state until the user refreshes.

For that request, the backend validates that the `games` IDs exactly match AppIDs parsed from normal
card hashes and reads the current price-catalog generation only for those submitted AppIDs through
the `(generation, normal_card_app_id)` index. It never waits for the global SteamApis bulk download:
a missing or stale generation queues one shared background refresh and immediately returns a
non-actionable unavailable state. Unrelated catalog groups are not loaded. Complete named catalog
sets are built from the request's game names and filtered groups; an optional `card_set_size` only
cross-checks the group length. Missing, invalid, or set-size-mismatched groups are excluded from
candidacy; if none remain, the result is `no_sellable_card`. Every held sellable normal card is
evaluated as a one-copy source candidate, including cards from maxed badges; destinations must
remain below normal badge level five. Foil and non-game records are ignored, as are syntactically
valid records outside the normal badge shape, including unrelated event and collection badges. A
recognized normal record with missing or non-integer level metadata fails closed. The in-memory
session badge snapshot is the sole badge-state input for this calculation.

The endpoint returns exactly one of these read-only states:

- `ready`: one complete deterministic, fully funded plan that sells one selected card, reuses
  retained destination cards, buys only missing cards, and reports per-item fees, quote depth/times,
  foregone versus funded XP, and configured currency metadata.
- `no_opportunity`: valid complete inputs but no card with a usable current bid or no strictly
  better fee-funded badge route; no zero-valued action cards are rendered.
- `unavailable`: a required contract, badge snapshot, price, depth, catalog, identity, or freshness
  gate is unresolved.

Initial unavailable reasons are `currency_contract_missing`, `steamapi_key_missing`,
`badge_data_unavailable`, `inventory_snapshot_too_old`, `price_generation_unavailable`,
`price_generation_stale`, and `quote_depth_unavailable`. Missing submitted game metadata fails
closed as `unavailable`; missing or invalid scoped catalog candidates are excluded, and an
all-excluded catalog returns `no_sellable_card`. No-opportunity also uses
`no_positive_xp_swap`. Every success response uses
`Cache-Control: no-store`.

Money is fail-closed behind one explicit, verified contract. The checked-in service group defines
`USD`, two minor digits, the exact `buyer_total` price basis, 500 Steam fee basis points, 1,000
publisher fee basis points, a one-cent per-component minimum, and freshness limits. Settings
validate the contract as one atomic group: clearing a field returns `currency_contract_missing`,
while an invalid complete group prevents startup. Operators must review and replace every monetary
value together. The optimizer converts decimal quotes exactly to integer minor units, calculates
Steam and publisher fees per item, and inverts the proposed sale to an exact seller receipt. Source
rows must exactly invert the quoted buyer total, and fee gaps reject the candidate. That receipt—not
the buyer's gross bid—is the missing-card purchase budget. Any gross comparison is derived with
`calculate_item_fees(required_receipt, contract)`; gross is never compared directly with a purchase
subtotal.

The fast algorithm constructs each eligible destination completion once and sorts once by the
deterministic key `(cost, oldest quote age, missing row count, app_id, row hashes)`. It scans valid
sellable source cards once and derives at most six ordered candidates per source (five outputs plus
a scope sentinel). Only a same-game destination changes when selling its sole copy; with two or
more copies its base option is unchanged. The minimum required crafts are
`foregone_craft_xp / 100 + 1`; the algorithm derives the cumulative cheapest-receipt threshold,
skips a source whose exact receipt is below it, and funds the maximum prefix of five. This keeps
destination construction/sorting at `O(G*C + G log G)` and the source scan at `O(H * small
constant/set-size)`, rather than sorting or rebuilding destinations per source.
The optimizer example limits are `LEVEL_UP_MAX_QUOTE_AGE_SECONDS=900` (15 minutes) and
`LEVEL_UP_MAX_INVENTORY_AGE_SECONDS=3600` (one hour). Quotes, generation, ownership, and the
session badge snapshot must all meet their configured limits. Missing submitted game metadata,
incomplete scoped catalog groups, global catalog, freshness, provider, or badge failures fail closed
as unavailable. Missing, stale, or depthless candidate quotes are excluded locally; the endpoint
never substitutes an underfunded partial plan.

All market listing and gamecards links are constructed from fixed Steam Community origins and are
ordinary manual navigation. The application does not accept provider-supplied URLs and never
lists, orders, buys, sells, trades, or crafts on the user's behalf. Estimates are not received
funds or completed actions; users must recheck live Steam prices, fills, and confirmations.

Successful public/private inventory results persist on the client in browser IndexedDB, keyed by
SteamID64, with a schema version and ISO refresh timestamp. A valid matching record avoids another
inventory request until an explicit refresh. Invalid or incompatible records are removed; logout
and account change clear prior-account records and advance a shared cache epoch that prevents older
in-flight requests from repopulating them. Ordinary session expiry does not delete saved inventory.
Inventory is never stored in cookies or `localStorage`, and transient unavailable results do not
overwrite a prior successful record. The project never receives or stores Steam passwords or Steam
Guard codes, presents data as-is, and does not automate transactions or degrade Steam. It does not
imply Valve or Steam endorsement. The [official button artwork](https://steamcommunity.com/dev)
requested on Steam's developer page is local and does not imply affiliation.

The signed HTTP-only session cookie contains the SteamID64 on the user's device for up to 24 hours
by default and is sent to the Railway-hosted backend for authenticated requests. It is cleared by
logout or expiry; it is an authentication mechanism, not inventory storage. Only validated semantic
gem-yield rows and normalized global market-price rows persist server-side in separate SQLite
caches on the attached `backend-data` volume mounted at `/data`, using the literal
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
  separable modules. The client owns per-SteamID64 inventory retention in IndexedDB and the
  validated in-memory session badge snapshot plus transient recommendation plans, while the backend
  owns one global normalized AppID 753 market-price generation and the separate gem cache. The
  market generation has a 24-hour freshness window for inventory display, refreshes lazily with
  stale-on-failure fallback, and has no scheduled job. The level-up boundary accepts already-loaded
  inventory game metadata and reads the global catalog only for submitted AppIDs through its
  `(generation, normal_card_app_id)` index. The optimizer constructs and sorts destination options
  once, then performs a single small-candidate source scan with exact integer fee arithmetic. The
  frontend and backend remain independently deployable services.
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
- `STEAM_WEB_API_KEY` belongs only in the backend environment and optionally supports the profile
  visibility check.
- `STEAMAPI_KEY` belongs only in the backend environment for SteamApis v2 inventory retrieval,
  authenticated badge-state reads, and lazy global normalized AppID 753 market-price refreshes; it
  is never exposed to the browser.
- Level-up recommendations use the complete verified monetary group:
  `LEVEL_UP_CURRENCY_CODE=USD`, `LEVEL_UP_CURRENCY_MINOR_DIGITS=2`,
  `LEVEL_UP_PRICE_BASIS=buyer_total`, `LEVEL_UP_STEAM_FEE_BPS=500`,
  `LEVEL_UP_PUBLISHER_FEE_BPS=1000`, and `LEVEL_UP_MIN_FEE_MINOR=1`.
  `LEVEL_UP_MAX_QUOTE_AGE_SECONDS=900` and
  `LEVEL_UP_MAX_INVENTORY_AGE_SECONDS=3600` bound freshness. Operators must review and replace
  the complete group together; clearing one member keeps the endpoint unavailable.
- The backend uses `/data/gem_prices.sqlite3` for gem rows and
  `/data/steamapis_prices.sqlite3` for the separate global normalized market-price cache. The
  latter is fresh for 24 hours for inventory display, refreshes lazily on requests, uses
  stale-on-failure fallback only for that display, and has no scheduled refresh process.
- The level-up endpoint runs in the existing backend service and adds no Railway service, process,
  scheduler, region, or volume. Both Railway services and all future Railway processes must run in
  EU-West, exact region `europe-west4-drams3a`.

After deployment, the backend smoke check requests `${{ vars.BACKEND_URL }}/api/health`. Frontend
smoke checks verify the root document, proxied session endpoint, Steam login redirect, callback
origin, and secure state-cookie attributes before release notes are published. The release notes
job is the only job that needs `contents: write`; deployment jobs need only `contents: read`.

There is no backwards-compatibility layer. An incompatible backend/frontend release requires an
explicit maintenance window and a coordinated clean cutover of both services, backend first and
frontend second; do not deploy one service while expecting the previous version of the other to
remain compatible.

## Deliberately deferred

The deterministic optimizer and its read-only advisory endpoint are part of the current stage.
The following follow-on scope is planned later, not missing pieces of that implementation:

- Marketplace, purchase, sale, trade, or any other transaction automation.
- A persisted transaction checklist, saved plans, or automatic repricing after source sales.
- Multiple source cards in one plan, more than five destination badges, or additional levels of one
  game badge in the same recommendation.
- Selling multiple copies of one source card, leftover-portfolio optimization, or a claim of
  global maximum XP.
- User-entered wallet balance, cash budget, raw XP target, locks, preferences, or exclusions.
- Patient listings, buy orders, order-book walking, fill-probability models, taxes, regional
  pricing, market holds, or account-specific restrictions.
- Foil, seasonal/event, sale, or non-game badges; booster drops; random craft rewards; coupons;
  emoticons; backgrounds; gems; or reward expected value.
- General-purpose PostgreSQL application persistence, Redis-backed services, a staging environment,
  or staging deployment automation.
