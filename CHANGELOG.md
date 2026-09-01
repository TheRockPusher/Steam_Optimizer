# Changelog

All notable changes to Steam Optimizer are documented here.

## Unreleased

### Bug Fixes
- Fix the live Steam market-search fallback for listings whose `asset_description.type` is present
  while `tags` is absent, so the game name is still derived correctly. Level-up planning also uses
  loaded inventory game metadata rather than depending on that provider response.
- Preserve exact per-item fee inversion and seller-receipt thresholds: a required receipt of 14
  rejects gross 15 (receipt 13), accepts gross 16 (receipt 14), accepts receipt 20 at gross 23,
  and rejects invalid gross 22.

### Features
- Reuse the validated in-memory session badge snapshot (`player_xp`, `player_level`, server-stamped
  `checked_at`, submitted as `badge_refreshed_at`, and normal badge levels) and already-loaded
  inventory game metadata in level-up requests. Include every normal-card game, not only sellable
  source games, and make no badge or booster-metadata provider request during planning.
- Keep level-up recommendations advisory and manual: Steam listing, buying, selling, trading, and
  crafting actions are never automated.

### Performance
- Read the normalized catalog only for submitted AppIDs through the
  `(generation, normal_card_app_id)` index, excluding unrelated catalog groups.
- Keep optimizer requests off the bulk catalog download path: missing or stale generations queue
  one shared background refresh and return an immediate non-actionable freshness response.
- Construct each eligible destination once, sort once by the deterministic plan key, and scan
  source cards with the cumulative receipt threshold and at most five funded outputs plus the
  scope sentinel.

### Documentation
- Document scoped catalog reads, session snapshot and inventory metadata reuse, exact integer fee
  handling, and the one-sort threshold algorithm.

## v0.10.0


### Documentation
- Update changelog for v0.9.0


### Features
- Optimize level-up plans per card


### Maintenance
- Prepare release v0.10.0

## v0.9.0


### Documentation
- Update changelog for v0.8.3


### Features
- Add inventory and level-up tabs


### Maintenance
- Prepare release v0.9.0

## v0.8.3


### Bug Fixes
- Scope badge state to card catalog


### Documentation
- Update changelog for v0.8.2


### Maintenance
- Prepare release v0.8.3

## v0.8.2


### Bug Fixes
- Load badge state from SteamApis


### Documentation
- Update changelog for v0.8.1


### Maintenance
- Prepare release v0.8.2

## v0.8.1


### Bug Fixes
- Restore market pricing and level-up optimization


### Documentation
- Update changelog for v0.8.0


### Maintenance
- Prepare release v0.8.1

## v0.8.0


### Bug Fixes
- Resolve gem valuation merge conflict


### Documentation
- Update changelog for v0.7.2


### Features
- Add level-up swap recommendations
- Support selectable gem cash valuation basis
- Label SteamApis prices as USD


### Maintenance
- Merge main and resolve conflicts
- Prepare release v0.8.0


### Testing
- Satisfy backend type checks

## v0.7.2


### Bug Fixes
- Derive gem keys from SteamApis market buckets
- Reject malformed gem bucket metadata


### Documentation
- Update changelog for v0.7.1


### Maintenance
- Prepare release v0.7.2

## v0.7.1


### Bug Fixes
- Restore gem values from Steam inventory


### Documentation
- Update changelog for v0.7.0


### Maintenance
- Prepare release v0.7.1

## v0.7.0


### Documentation
- Update changelog for v0.6.0


### Maintenance
- Resolve main merge conflicts
- Merge main into cache branch
- Merge main and preserve item metadata
- Prepare release v0.7.0


### Testing
- Satisfy merged HTTP client contracts

## v0.6.0


### Documentation
- Update changelog for v0.5.0


### Features
- Generalize Steam inventory item metadata
- Cache Steam inventory and market prices
- Compact inventory results layout
- Streamline inventory workspace design
- Derive booster gem costs


### Maintenance
- Prepare release v0.6.0


### Testing
- Satisfy booster HTTP client protocol

## v0.5.0


### Documentation
- Update changelog for v0.4.0


### Features
- Add inventory result tabs


### Maintenance
- Prepare release v0.5.0

## v0.4.0


### Bug Fixes
- Exclude terminal gem misses from pending count
- Treat expired gem misses as terminal on refresh


### Features
- Add cache-only gem refresh control
- Add gem value comparison tab
- Add game booster pricing details


### Maintenance
- Persist generated changelog
- Make changelog update idempotent
- Prepare release v0.4.0


### Performance
- Request resized inventory images

## v0.3.0


### Bug Fixes
- Warm and persist all gem price groups
- Validate gem cache during startup


### Features
- Make game grouping optional


### Maintenance
- Prepare release v0.3.0

## v0.2.0


### Features
- Add sortable inventory table
- Adopt Harbor Signal dark theme
- Add cached gem pricing for trading cards


### Maintenance
- Prepare release v0.2.0

## v0.1.2


### Bug Fixes
- Defer manual release tag creation
- Deploy tested release commit
- Synchronize release lockfile
- Allow Actions release tag creation


### Features
- Integrate SteamApis inventory pricing


### Maintenance
- Add manual GitHub release dispatch
- Add semantic release bump selector
- Prepare release v0.1.2

## v0.1.1


### Features
- Handle Steam inventory rate limits

## v0.1.0


### Features
- Add Steam authentication and release deployment


### Maintenance
- Scaffold Steam Optimizer
- Configure language servers and ruff

Generated by [git-cliff](https://git-cliff.org/).
