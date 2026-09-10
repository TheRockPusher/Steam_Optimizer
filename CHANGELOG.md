# Changelog

All notable changes to Steam Optimizer are documented here.

## Unreleased

### Features
- Export badge plans as clipboard checklists, CSV, or JSON with quote and snapshot provenance.
- Save account-scoped planning intent and optionally resume checklist marks on the same device.
- Derive goal-aware wanted and surplus cards after reservations and repeated crafts.
- Discover eligible normal badges across inventory, selected games, or the supported catalog.
- Set per-game collector targets and preview genuine, explicitly partial Steam badge artwork.
- Compare crafting one complete owned set with selling it to fund other badges, net of exact fees.

### Safety
- Preserve complete normal-badge levels for unowned games and retain unsupported inventory rows.
- Reconfirm remaining Wallet funds after refreshed holdings; saved marks never imply execution.
- Bind comparisons to fresh bids, sellable quantities, reservations, and an independent zero-spend baseline.

## v1.1.0


### Documentation
- Update changelog for v1.0.1


### Features
- Redesign website with focused dark interface


### Maintenance
- Prepare release v1.1.0

## v1.0.1


### Bug Fixes
- Restore normal card badge eligibility


### Documentation
- Update changelog for v1.0.0


### Maintenance
- Prepare release v1.0.1

## v1.0.0


### Documentation
- Update changelog for v0.12.0


### Features
- Add badge dashboard and goal-based planning


### Maintenance
- Integrate upstream exchange alternatives
- Prepare release v1.0.0

## v0.12.0


### Documentation
- Update changelog for v0.11.0


### Features
- Show top-ten exchange alternatives when no plan exists


### Maintenance
- Prepare release v0.12.0

## v0.11.0


### Documentation
- Update changelog for v0.10.2
- Document caching, runtime, and recovery behavior


### Maintenance
- Require Python 3.14 across tooling and container
- Prepare release v0.11.0


### Performance
- Keep cache reads responsive during refreshes
- Defer the optimizer bundle and cut render work
- Cache immutable assets and revalidate HTML

## v0.10.2


### Bug Fixes
- Retry during catalog refresh


### Documentation
- Update changelog for v0.10.1


### Maintenance
- Prepare release v0.10.2

## v0.10.1


### Bug Fixes
- Compute plans from cached snapshots


### Documentation
- Update changelog for v0.10.0


### Maintenance
- Prepare release v0.10.1

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


### Features
- Generalize Steam inventory item metadata
- Cache Steam inventory and market prices
- Compact inventory results layout


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
