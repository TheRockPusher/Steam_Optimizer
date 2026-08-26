# Project summary

## Product direction

Steam Optimizer is an open-source, read-only Steam Community inventory and badge optimizer. The
product will inspect a public inventory, calculate deterministic badge-completion suggestions,
and help a user decide what to do next. It is not an account operator or marketplace automation
tool.

The current stage includes a FastAPI health endpoint, Steam OpenID 2.0 login, an application-owned
signed session, backend checks for public profile and AppID 753 Community inventory visibility,
and a React interface that presents both results independently. Full inventory retrieval,
normalization, and optimization remain deferred.

## Safety and identity boundary

All purchases, sales, trades, and other Steam actions remain manual. The application must not
automate transactions or require users to provide Steam credentials or secrets.

The identity flow uses Steam OpenID 2.0. OpenID identifies and proves ownership of a SteamID64,
but it does not grant access to a private inventory. Inventory access therefore still requires
the user's Steam Community inventory to be public. The application never receives Steam passwords
or Steam Guard codes.

## Data handling, compliance, and upstream limits

The profile-visibility check uses Valve's documented [Steam Web API](https://steamcommunity.com/dev)
when its optional key is configured. The inventory check calls Steam Community's
`/inventory/{steamid}/753/6` route, which is not listed in that Web API reference. The key remains
server-only and does not fix that separate Community route. The 100,000-call daily term in
[Valve's API terms](https://steamcommunity.com/dev/apiterms) is stated for the Web API; this
project does not present it as a quota for the Community route.

The project is designed around relevant boundaries in those terms: it retrieves Steam data only for
a user-requested check, never receives or stores Steam passwords or Steam Guard codes, presents data
as-is, and does not automate transactions or degrade Steam. It does not imply Valve or Steam
endorsement. The [official button artwork](https://steamcommunity.com/dev) requested on Steam's
developer page is local and does not imply affiliation. The signed HTTP-only session cookie contains
the SteamID64 on the user's device for up to 24 hours by default, is sent to the Railway-hosted
backend on session requests, and is cleared by logout or expiry. The public
[privacy policy and Steam Data disclaimer](../README.md#privacy-and-steam-data-policy) disclose
storage, deletion, warranty, and liability terms.

The process-local state in Railway's configured US region treats only the SteamID64 and definitive
public inventory-visibility result as reusable for five minutes. During an enforced cooldown it
also retains the last public, private, unavailable, or rate-limited result for up to 900 seconds.
No inventory payload persists. Expired entries are removed by later inventory traffic or process
restart; until then they can remain in process memory but are never reused after their deadlines.
State is bounded to 1,024 SteamIDs. HTTP 429 responses and bodies are never cached; session responses
use `Cache-Control: no-store`.

The Community route has no published `Retry-After` guarantee. Following [RFC 6585
§4](https://www.rfc-editor.org/rfc/rfc6585#section-4), the app never stores 429 responses and
honors valid nonnegative-second or HTTP-date
[`Retry-After`](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3) values. A per-SteamID
30-second cooldown prevents duplicate checks; each check makes at most three upstream attempts,
with 1- and 2-second fallback delays and at most five seconds of retry-sleep time in addition to
upstream request time. Hints beyond that inline bound are not slept, and the user cooldown is
capped at 900 seconds. Only 429, 5xx, and network transients are retried; private or other 4xx
responses, malformed 200 responses, and decoding failures are not. Concurrent checks for one
SteamID coalesce.
The terminal message is "Steam is temporarily limiting inventory checks. Try again in N seconds."
It is shown as temporary limiting, not private; only rechecks are disabled while it counts down, and
logout remains available.

A static outbound IP may isolate network reputation but cannot guarantee no 429 response; it is not
a cure for rate limiting.

## Technical direction

- **Backend:** Python, FastAPI, and Pydantic, managed with uv; Ruff, Pyrefly, and pytest provide
  quality checks.
- **Frontend:** React and TypeScript with Vite, managed with pnpm; ESLint and Vitest provide
  quality checks.
- **Architecture:** Keep the backend API, Steam integration, inventory model, and optimizer as
  separable modules. The future optimizer will be a deterministic, pure Python package, and
  money values will use integer minor units. The frontend and backend remain independently
  deployable services.
- **Hosting:** Railway project `steam-optimizer`
  (`a6d0c0d3-2a41-486b-9f3b-1de0db5da949`) has a production environment with separate backend
  and frontend services. The browser uses the frontend origin for both UI and `/api`; Caddy
  proxies API traffic to the backend service.
- **License:** GNU Affero General Public License v3.0, preserving source availability for
  modified hosted versions.

## Production deployment

Production is the only deployed environment; no staging environment exists yet. A protected
`vMAJOR.MINOR.PATCH` tag is the only deployment trigger. The release workflow validates strict tag
syntax, verifies that the tag commit is on `origin/main`, and verifies that the tag matches the
backend `project.version`. Normal continuous integration still runs on pull requests and `main`;
the release invokes that reusable CI before deploying.

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
  `STEAM_WEB_API_KEY` is optional and belongs only in the backend environment.

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

- Full Steam Community inventory retrieval and normalization
- Deterministic badge optimization and recommendation planning
- PostgreSQL persistence and Redis-backed services
- Marketplace, purchase, sale, trade, or any other transaction automation
- A staging environment and staging deployment automation
