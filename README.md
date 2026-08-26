[Steam Optimizer](https://github.com/TheRockPusher/Steam_Optimizer) is a read-only Steam
Community inventory adviser for Steam users, written in
[TypeScript](https://www.typescriptlang.org/) and [Python](https://www.python.org/) and
released under the [GNU AGPL v3.0](LICENSE).

[![Python 3.12](https://img.shields.io/badge/Python-3.12-informational)](https://docs.python.org/3.12/)
[![TypeScript 5.9](https://img.shields.io/badge/TypeScript-5.9-informational)](https://www.typescriptlang.org/docs/)
[![React 19.2](https://img.shields.io/badge/React-19.2-informational)](https://react.dev/)
[![FastAPI 0.115](https://img.shields.io/badge/FastAPI-0.115-informational)](https://fastapi.tiangolo.com/)

First released in 2026; current release: 0.1.0 (2026-08-26).
[TheRockPusher](https://github.com/TheRockPusher) maintains it to make Steam inventory and
badge decisions transparent without automating account actions.

## Getting Started

Prerequisites for a fresh Linux, macOS, or Windows development environment:

- [uv](https://docs.astral.sh/uv/)
- [Node.js](https://nodejs.org/) `^22.13` or `>=24`
- [pnpm](https://pnpm.io/installation) 10
- Optional: a server-only [Steam Web API key](https://steamcommunity.com/dev/apikey) for a
  conclusive profile-visibility result

Install and run the backend:

```sh
cd backend
uv sync
cp .env.example .env
# Set a random SIGNING_SECRET in .env. STEAM_WEB_API_KEY is optional locally.
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

The first connection stage provides:

- Browser-based Steam OpenID 2.0 authentication.
- An application-owned, signed, HTTP-only session.
- Independent backend checks for public Steam profile visibility and public AppID 753
  Community inventory visibility.
- A responsive interface that distinguishes public, private, and unavailable results.

Steam handles passwords and Steam Guard. Steam Optimizer receives only the verified SteamID64,
creates its own local session, and reads data Steam exposes publicly. It cannot access a private
inventory or buy, sell, trade, craft, or otherwise modify a Steam account.

## Why

Owned cards have an opportunity cost: crafting an expensive owned set can be worse than selling
it and buying a cheaper badge. Steam Optimizer is intended to make those trade-offs explicit,
showing cash outlay separately from foregone sale or gem value. The optimizer itself remains
deferred; the current authentication stage first establishes which public data can be read.

## Configuration and Deployment

Both development and production use same-origin browser requests. Keep
`VITE_API_BASE_URL` empty. Vite proxies `/api` locally; production Caddy proxies `/api` to the
backend using its runtime `API_UPSTREAM` variable. This avoids third-party-cookie dependence on
separate Railway-generated domains.

### Local and service configuration

For separate Railway frontend and backend services:

- Frontend: keep `VITE_API_BASE_URL` empty and set `API_UPSTREAM` to the public backend origin.
- Backend: set `ENVIRONMENT=production`, `ALLOWED_ORIGINS` to a JSON list containing the exact
  frontend origin, and `FRONTEND_URL` to that origin.
- Backend: set `PUBLIC_BACKEND_URL` to the frontend origin. Steam returns through the frontend
  `/api` proxy, so session cookies are issued on the same host used by the browser application.
- Backend: set `SIGNING_SECRET` to a random value of at least 32 characters,
  `COOKIE_SECURE=true`, and `COOKIE_SAMESITE=lax`.
- `STEAM_WEB_API_KEY` is optional and belongs only in the backend environment. It enables the
  profile-visibility check.

Each service has its own Dockerfile. Infrastructure is managed separately with the current
`.railway/railway.ts`; the release workflow deploys source code but does not apply infrastructure.

### Production release deployment

Production is the only deployed environment; there is no staging environment yet. A protected
`vMAJOR.MINOR.PATCH` tag is the only deployment trigger. The release workflow validates strict tag
syntax, verifies that the tag commit is on `origin/main`, and verifies that the tag matches the
backend `project.version`. Normal continuous integration still runs on pull requests and `main`;
the release invokes that reusable CI before deploying.

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
- Required centralized services and terms: authentication and visibility checks depend on
  [Steam Community](https://steamcommunity.com/), the
  [Steam Web API](https://steamcommunity.com/dev), and Valve's
  [API terms](https://steamcommunity.com/dev/apiterms).
- Off-device data transmission and privacy policy: the browser is redirected to Steam for login,
  and the backend sends the verified SteamID64 to Steam for visibility checks. No project-specific
  privacy policy is currently published.
