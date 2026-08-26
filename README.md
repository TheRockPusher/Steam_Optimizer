# Steam Optimizer

Steam Optimizer is an open-source, read-only tool for inspecting a public Steam Community inventory and planning badge-completion actions. It does not buy, sell, trade, or otherwise automate Steam transactions; users perform any resulting actions manually.

## Status

This repository contains the initial scaffold. The current product surface is a health endpoint and a small frontend shell. Steam authentication, inventory retrieval, and optimization are intentionally not implemented yet.

## Stack

- **Backend:** Python, FastAPI, Pydantic, and uv
- **Frontend:** React, TypeScript, Vite, and pnpm
- **Quality:** Ruff, Pyrefly, pytest, ESLint, Vitest, and Vite
- **License:** GNU Affero General Public License v3.0

## Local development

Install [uv](https://docs.astral.sh/uv/), [Node.js](https://nodejs.org/) `^22.13` or `>=24`, and [pnpm](https://pnpm.io/installation) first. Run the backend and frontend in separate terminals from the repository root.

### Backend

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload
```

The backend is available at <http://localhost:8000>. The health check is <http://localhost:8000/api/health>.

### Frontend

```bash
cd frontend
pnpm install
pnpm dev
```

The Vite development server is normally available at <http://localhost:5173> and proxies `/api` requests to the local backend. Set `VITE_API_BASE_URL` when the frontend must call a different API origin.

## Railway deployment

Create separate Railway services with `backend` and `frontend` as their root
directories; each service has its own Dockerfile.

- Set the frontend build variable `VITE_API_BASE_URL` to the public backend URL.
  Vite embeds it during the image build, so changes require a frontend rebuild.
- Set backend `ALLOWED_ORIGINS` to a JSON list containing the public frontend
  origin, for example `["https://example.up.railway.app"]`.

No Steam credentials or Railway secrets are part of this scaffold.

## Checks

Run the backend checks with:

```bash
cd backend
uv run ruff check .
uv run pyrefly check
uv run pytest
```

Run the frontend checks with:

```bash
cd frontend
pnpm lint
pnpm test
pnpm build
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow and commit conventions. The project direction and deliberate non-goals are recorded in [`docs/PROJECT_SUMMARY.md`](docs/PROJECT_SUMMARY.md).
