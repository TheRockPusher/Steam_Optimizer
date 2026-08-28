# Changelog

All notable changes to Steam Optimizer are documented here. Release notes are generated from
Conventional Commits with [git-cliff](https://git-cliff.org/).

## Unreleased

- Establish the initial backend, frontend, repository tooling, and documentation scaffold.
- Make Harbor Signal the default frontend colour system with dark navy surfaces, Steam-blue highlights, and accessible semantic states.
- Add official Steam sign-in artwork and clarify that it does not imply Valve or Steam affiliation.
- Move Steam sign-in to the top-right header and add accessible ascending and descending
  sorting controls for every inventory table column.
- Add SteamApis v2 inventory and pricing: complete public AppID 753/context 6 retrieval with
  provider pagination, current bulk AppID 753 prices, server-only `STEAMAPI_KEY`, provider and
  data-source caveats, and explicit partial price coverage. SteamApis omits currency metadata from its
  bulk feed; its order-book values are preserved and displayed as provider-denominated decimals without
  a currency symbol. Optimization must not treat these values as monetary until an authoritative
  currency contract or explicit configuration exists. Market order-book snapshots remain request-only;
  only validated semantic gem-yield cache rows persist.
- Add rate-limited, read-only gem-yield lookups once per game and normal/foil card rarity. Uncached or
  expired groups warm asynchronously in one background worker, while cached positive values return
  immediately. Persist validated results in a versioned Railway-backed SQLite cache on the
  `backend-data` volume in exact EU-West region `europe-west4-drams3a`, mounted at `/data` with
  literal `GEM_PRICE_CACHE_PATH=/data/gem_prices.sqlite3`. Ordinary restarts and redeploys preserve
  cache rows; reset only for explicit `CACHE_SCHEMA_VERSION` changes or incompatible/corrupt databases.
  Source-only Railway `railway up` releases preserve the attached volume without applying
  infrastructure or creating, deleting, or replacing it. Derive per-card gem cash estimates from the
  lowest-sell `753-Sack of Gems` price. Let users switch game grouping on or off, and expose sortable
  gem and provider-denominated cash-value columns.
- Keep the optional Steam Web API profile key server-only.
- Configure all Railway services and future Railway processes in EU-West
  (`europe-west4-drams3a`).
- Add Steam OpenID login, signed local sessions, public profile checks, SteamApis inventory
  retrieval, and the first-stage connection interface.
