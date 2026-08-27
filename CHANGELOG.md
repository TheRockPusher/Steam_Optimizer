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
  currency contract or explicit configuration exists. Market order-book snapshots are not persisted.
  Gem yields use the persistent cache described below.
- Add rate-limited, read-only gem-yield lookups once per game and normal/foil card rarity,
  persist validated results in a Railway-backed SQLite cache, and derive per-card gem cash
  estimates from the lowest-sell `753-Sack of Gems` price. Group trading cards by game and
  expose sortable gem and provider-denominated cash-value columns.
- Keep the optional Steam Web API profile key server-only.
- Configure all Railway services and future Railway processes in EU-West
  (`europe-west4-drams3a`).
- Add Steam OpenID login, signed local sessions, public profile checks, SteamApis inventory
  retrieval, and the first-stage connection interface.
