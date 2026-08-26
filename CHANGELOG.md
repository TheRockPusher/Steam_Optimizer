# Changelog

All notable changes to Steam Optimizer are documented here. Release notes are generated from
Conventional Commits with [git-cliff](https://git-cliff.org/).

## Unreleased

- Establish the initial backend, frontend, repository tooling, and documentation scaffold.
- Add official Steam sign-in artwork and clarify that it does not imply Valve or Steam affiliation.
- Document the separate, undocumented Community inventory route, server-only Web API key handling,
  and the relevant Valve API terms.
- Document bounded inventory rate-limit handling: a five-minute process-local positive cache in
  Railway's configured US region holding only SteamID64 plus the public visibility result, no
  inventory-payload persistence, restart clearing, per-ID cooldown, bounded retries, `Retry-After`
  handling, and `Cache-Control: no-store` responses.
- Document that a static outbound IP may isolate network reputation but cannot guarantee avoiding
  HTTP 429 responses.
- Add Steam OpenID login, signed local sessions, public profile and inventory
  visibility checks, and the first-stage connection interface.
