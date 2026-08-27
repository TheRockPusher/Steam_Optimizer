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
  retrieval and current bulk AppID 753 prices.

Install and run the backend:

```sh
cd backend
uv sync
cp .env.example .env
# Set a random SIGNING_SECRET in .env. STEAM_WEB_API_KEY is optional for profile visibility;
# STEAMAPI_KEY enables SteamApis inventory retrieval and bulk prices.
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
- Server-only SteamApis v2 access through `STEAMAPI_KEY`; this credential never reaches the browser.
- Complete public AppID 753/context 6 inventory retrieval, following provider pagination and combining
  all pages.
- Current bulk AppID 753 prices joined to marketable inventory items, with explicit `complete`,
  `partial`, or `unavailable` price coverage: `complete` when all priceable rows are priced,
  `partial` when some but not all priceable rows are priced, and `unavailable` when zero
  priceable rows are priced or the provider is unavailable.
- A responsive interface that exposes all retrieved items without rendering the entire inventory at
  once.

SteamApis is a third-party provider: inventory availability, response fields, and price snapshots
depend on provider data and availability and may differ from Steam Community at a given time. The
UI classifies price coverage as `complete` when all priceable rows are priced, `partial` when some
but not all priceable rows are priced, and `unavailable` when zero priceable rows are priced or
the provider is unavailable. Unavailable prices remain unpriced. SteamApis omits currency metadata from
its bulk feed. Order-book values are preserved exactly as provider-denominated decimals and displayed
without a currency symbol. Optimization must not treat them as monetary values until an authoritative
currency contract or explicit configuration exists. Inventory and prices are fetched on request; the
current deployment has no inventory/price cache or database. Railway services run in
EU-West (`europe-west4-drams3a`).

Steam handles passwords and Steam Guard. Steam Optimizer receives only the verified SteamID64,
creates its own local session, and sends that identifier to upstream providers for requested data.
It cannot retrieve a private inventory or buy, sell, trade, craft, or otherwise modify a Steam
account.

## Why

Owned cards have an opportunity cost: crafting an expensive owned set can be worse than selling
it and buying a cheaper badge. Steam Optimizer is intended to make those trade-offs explicit,
showing cash outlay separately from foregone sale or gem value only after an authoritative currency
contract or explicit configuration exists. The optimizer itself remains deferred; this stage now reads
the complete public inventory and current bulk order-book values before future optimization work.

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
  enables SteamApis v2 inventory retrieval and current bulk AppID 753 prices.

Each service has its own Dockerfile. Infrastructure is managed separately with the current
`.railway/railway.ts`; the release workflow deploys source code but does not apply infrastructure.

### Production release deployment

Production is the only deployed environment; there is no staging environment yet. The release
workflow accepts either a protected `vMAJOR.MINOR.PATCH` tag push or an explicit GitHub UI
dispatch. It validates strict tag syntax, verifies that the release commit is on `origin/main`,
and verifies that the tag matches the backend `project.version`. Normal continuous integration
still runs on pull requests and `main`; the release invokes that reusable CI before deploying.

### Run a release from the GitHub UI

After code changes have been merged to `main`, open **Actions → Release → Run workflow**. Keep the
branch set to `main`, choose `patch`, `minor`, or `major` in the **Version increment** dropdown, and
run the workflow. It derives the next semantic version from the latest release tag, validates the
prospective tag and commit, runs the existing continuous-integration, deployment, and smoke-check
jobs, then commits the calculated backend version, creates the tag, and publishes release notes in
that same run. A tag created with `GITHUB_TOKEN` does not start a second workflow.

The workflow changes only `backend/pyproject.toml` for the calculated version and uses a conventional
`chore: prepare release vX.Y.Z` commit. It will not overwrite an existing tag that points to another
commit. The active release-tag ruleset must permit the GitHub Actions actor to create protected `v*`
tags. If it does not, the manual run stops before the tag and GitHub release are published, after
the deployment checks have completed; use **Releases → Draft a new release**, create the same tag on
`main`, and publish it to trigger the tag-based path.

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
  current AppID 753 bulk pricing use the third-party SteamApis v2 provider. Profile visibility uses
  Valve's documented [Steam Web API](https://steamcommunity.com/dev) when `STEAM_WEB_API_KEY` is
  configured. `STEAMAPI_KEY` is server-only; neither credential is sent to the browser. SteamApis
  response availability, fields, and price snapshots are provider/data-source caveats rather than
  Valve guarantees. Price coverage is `complete` when all priceable rows are priced, `partial` when
  some but not all priceable rows are priced, and `unavailable` when zero priceable rows are priced
  or the provider is unavailable. SteamApis omits currency metadata from its bulk feed: order-book values
  are preserved exactly as provider-denominated decimals and displayed without a currency symbol.
  Optimization must not treat them as monetary values until an authoritative currency contract or explicit
  configuration exists. The
  100,000-call daily term in
  [Valve's API terms](https://steamcommunity.com/dev/apiterms) describes the Web API, not a
  documented quota for SteamApis.
- Deployment caveat: both Railway services run in EU-West (`europe-west4-drams3a`), and all future
  Railway processes must use that same region. The current implementation has no inventory/price
  cache or database.

### Privacy and Steam Data Policy

This section is Steam Optimizer's published privacy policy. It applies to the deployed service and
was last updated on 2026-08-27.

- Data handling and privacy policy: the browser redirects to Steam for login, and the backend sends
  the verified SteamID64 to Steam and SteamApis only for the user's requested checks. Steam data is
  presented as-is; the app does not automate transactions or degrade Steam. No Steam password or
  Steam Guard code is received or stored. The signed, HTTP-only session cookie contains the
  SteamID64 on the user's device for up to 24 hours by default; it is sent to the Railway-hosted
  backend on session requests and cleared by logout or expiry.
- SteamApis inventory and price state: each requested check retrieves the complete public AppID
  753/context 6 inventory through provider pagination and reads a current bulk AppID 753 price
  snapshot. Results are joined in process memory for the response; no inventory or price payload is
  cached or persisted in a database. Price coverage is `complete` when all priceable rows are
  priced, `partial` when some but not all priceable rows are priced, and `unavailable` when zero
  priceable rows are priced or the provider is unavailable. Null prices remain visible as such. The
  SteamApis omits currency metadata from its bulk feed. Order-book values are preserved exactly as
  provider-denominated decimals and displayed without a currency symbol. Optimization must not treat
  them as monetary values until an authoritative currency contract or explicit configuration exists.
- SteamApis provider caveat: the provider controls upstream availability, pagination behavior,
  response fields, and the currentness of bulk prices. A public Steam inventory remains required;
  provider failures can leave the inventory unavailable or price coverage unavailable without
  implying that the account is private.
- Sign-in branding: the local button uses the [Steam-requested sign-in
  artwork](https://steamcommunity.com/dev); it does not imply Valve or Steam endorsement or
  affiliation.

Users can clear the local session through **Sign out on this device** or by deleting the browser
cookie. Questions or deletion requests can be filed through the repository's
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
