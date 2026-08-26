# Project summary

## Product direction

Steam Optimizer is an open-source, read-only Steam Community inventory and badge optimizer. The product will inspect a public inventory, calculate deterministic badge-completion suggestions, and help a user decide what to do next. It is not an account operator or marketplace automation tool.

The initial scope is deliberately small: a FastAPI health endpoint and a React/Vite shell that can show the product title, the read-only/manual-actions boundary, and API health. Steam data retrieval, authentication, and optimization are not part of this scaffold.

## Safety and identity boundary

All purchases, sales, trades, and other Steam actions remain manual. The application must not automate transactions or require users to provide Steam credentials or secrets.

The planned identity flow is Steam OpenID 2.0. OpenID can identify and prove ownership of a SteamID64, but it does not grant access to a private inventory. Inventory access therefore still requires the user's Steam Community inventory to be public. Login is intentionally deferred.

## Technical direction

- **Backend:** Python, FastAPI, and Pydantic, managed with uv; Ruff, Pyrefly, and pytest provide quality checks.
- **Frontend:** React and TypeScript with Vite, managed with pnpm; ESLint and Vitest provide quality checks.
- **Architecture:** Keep the backend API, Steam integration, inventory model, and optimizer as separable modules. The future optimizer will be a deterministic, pure Python package, and money values will use integer minor units. The frontend and backend remain independently deployable services.
- **Hosting:** Railway is the planned host, with separate backend and frontend services. Each service has a Dockerfile; deployment will set the frontend's public API URL at image build time and the backend's allowed frontend origin at runtime.
- **License:** GNU Affero General Public License v3.0, preserving source availability for modified hosted versions.

## Deliberately deferred

The following are planned later, not missing pieces of the initial scaffold:

- Steam OpenID login and Steam Community inventory fetching
- Inventory normalization and the deterministic badge optimizer
- PostgreSQL persistence and Redis-backed services
- Marketplace, purchase, sale, trade, or any other transaction automation
- Production credentials, Railway configuration, and operational integrations
