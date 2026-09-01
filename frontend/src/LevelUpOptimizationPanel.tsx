import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  buildLevelUpOptimizationRequest,
  buildSteamMarketListingUrl,
  buildSteamProfileGamecardsUrl,
  formatAbsoluteTime,
  formatMinorUnits,
  formatRelativeTime,
  isLevelUpIsoTimestamp,
  isLevelUpResponseExpired,
  isInventorySnapshotFresh,
  levelUpSnapshotKey,
  LEVEL_UP_INVENTORY_MAX_AGE_MS,
  requestLevelUpOptimization,
  type LevelUpBadgeSnapshot,
  type LevelUpBooster,
  type LevelUpBuyRow,
  type LevelUpDestinationPlan,
  type LevelUpInventoryItem,
  type LevelUpMoneyMetadata,
  type LevelUpOptimizationResponse,
  type LevelUpReason,
  type LevelUpReadyResponse,
  type LevelUpState
} from "./levelUpOptimization";

export type LevelUpInventoryStatus = "public" | "private" | "unavailable";
export type LevelUpOptimizationPanelProps = {
  steamId: string | null;
  inventoryStatus: LevelUpInventoryStatus;
  items: readonly LevelUpInventoryItem[];
  boosters: readonly LevelUpBooster[];
  badges: LevelUpBadgeSnapshot;
  inventoryRefreshedAt: string | null;
  isInventoryLoading: boolean;
  isActive: boolean;
  onRefreshInventory: () => void;
  onRefreshBadges?: () => void;
};

export const LEVEL_UP_OPTIMIZATION_PANEL_ID = "level-up-optimization-panel";
const PANEL_ID = LEVEL_UP_OPTIMIZATION_PANEL_ID;
const PRICE_CATALOG_RETRY_MS = 5_000;
const REASON_COPY: Record<LevelUpReason, string> = {
  ready: "The current recommendation is ready for review.",
  currency_contract_missing:
    "Level-up estimates are disabled until the market currency and fee contract is configured.",
  steamapi_key_missing:
    "Level-up estimates are unavailable because the server has no SteamApis API key.",
  badge_data_unavailable:
    "Steam badge data could not be verified. Try refreshing the recommendation later.",
  inventory_snapshot_too_old:
    "This ownership snapshot is too old for a safe recommendation.",
  price_generation_unavailable:
    "Current market prices are unavailable. Try refreshing the recommendation later.",
  price_generation_refreshing:
    "Steam Optimizer is refreshing the shared market-price catalog. This recommendation will retry automatically.",
  price_generation_stale:
    "Current market prices are stale. Try refreshing the recommendation later.",
  quote_depth_unavailable:
    "Current market order-book depth is unavailable. Try refreshing the recommendation later.",
  no_sellable_card:
    "No sellable normal card with a usable current bid is available in this inventory snapshot.",
  no_positive_xp_swap:
    "No one-card sale funds a badge path with more XP than the immediate craft opportunity it gives up."
};

function formatXp(value: number): string {
  return `${new Intl.NumberFormat("en-US").format(value)} XP`;
}

function formatFeeRate(basisPoints: number): string {
  const wholePercent = Math.floor(basisPoints / 100);
  const fractionalBasisPoints = basisPoints % 100;
  if (fractionalBasisPoints === 0) {
    return `${wholePercent}%`;
  }
  return `${wholePercent}.${fractionalBasisPoints.toString().padStart(2, "0").replace(/0+$/, "")}%`;
}

function statusClass(status: string): string {
  return `level-up-optimization-status level-up-optimization-status-${status.replace(/_/g, "-")}`;
}

function StatusSurface({
  status,
  title,
  children,
  action
}: {
  status: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={statusClass(status)}>
      <h3>{title}</h3>
      <div>{children}</div>
      {action}
    </div>
  );
}

function RefreshButton({
  children,
  onClick,
  className = "secondary-action"
}: {
  children: ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button type="button" className={className} onClick={onClick}>
      {children}
    </button>
  );
}

function QuoteTime({ timestamp }: { timestamp: string }) {
  return (
    <time dateTime={timestamp} title={formatAbsoluteTime(timestamp)}>
      {formatRelativeTime(timestamp)}
      <span className="level-up-quote-time-absolute"> ({formatAbsoluteTime(timestamp)})</span>
    </time>
  );
}

function MarketLink({ marketHashName }: { marketHashName: string }) {
  return (
    <a
      href={buildSteamMarketListingUrl(marketHashName)}
      target="_blank"
      rel="noreferrer"
    >
      Open Steam Market listing
    </a>
  );
}

function Metric({
  label,
  value,
  className = ""
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className={`level-up-metric ${className}`.trim()}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function responseMoney(response: LevelUpReadyResponse): LevelUpMoneyMetadata {
  return {
    currency_code: response.currency_code,
    minor_digits: response.minor_digits,
    price_basis: response.price_basis,
    steam_fee_bps: response.steam_fee_bps,
    publisher_fee_bps: response.publisher_fee_bps,
    min_fee_minor: response.min_fee_minor,
    taxes_included: response.taxes_included
  };
}

function formatAmount(
  amount: number,
  money: LevelUpMoneyMetadata
): string {
  return formatMinorUnits(amount, money.currency_code, money.minor_digits);
}

function SellTable({
  response,
  sourceIcons
}: {
  response: LevelUpReadyResponse;
  sourceIcons: ReadonlyMap<string, string>;
}) {
  const source = response.source;
  const money = responseMoney(response);
  return (
    <div className="level-up-sell-section">
      <h4>Sell one {source.game_name} card</h4>
      <p>
        Normal badge level {source.badge_level}; one card from a {source.set_size}-card
        set.
      </p>
      <p>
        Sell this single card into the current highest bid. This is an estimate and
        manual Steam navigation, not an action performed by this application.
      </p>
      <div className="level-up-table-wrapper">
        <table className="level-up-card-table">
          <caption>Card to sell</caption>
          <thead>
            <tr>
              <th scope="col">Card</th>
              <th scope="col">Quantity</th>
              <th scope="col">Buyer pays</th>
              <th scope="col">Steam fee</th>
              <th scope="col">Publisher fee</th>
              <th scope="col">Estimated seller receipt</th>
              <th scope="col">Top-bid depth</th>
              <th scope="col">Quote time</th>
              <th scope="col">Navigation</th>
            </tr>
          </thead>
          <tbody>
            {source.rows.map((row) => (
              <tr key={row.market_hash_name}>
                <th scope="row">
                  <span className="level-up-sell-card-identity">
                    {sourceIcons.has(row.market_hash_name) && (
                      <img
                        src={sourceIcons.get(row.market_hash_name)}
                        alt=""
                        className="level-up-sell-card-icon"
                        loading="lazy"
                      />
                    )}
                    <span>
                      <span>{row.card_name}</span>
                      <span className="level-up-market-hash">
                        {row.market_hash_name}
                      </span>
                    </span>
                  </span>
                </th>
                <td>{row.quantity}</td>
                <td>{formatAmount(row.buyer_total, money)}</td>
                <td>{formatAmount(row.steam_fee, money)}</td>
                <td>{formatAmount(row.publisher_fee, money)}</td>
                <td>{formatAmount(row.seller_receipt, money)}</td>
                <td>{row.top_bid_quantity}</td>
                <td><QuoteTime timestamp={row.quote_timestamp} /></td>
                <td><MarketLink marketHashName={row.market_hash_name} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BuyCard({
  row,
  money
}: {
  row: LevelUpBuyRow;
  money: LevelUpMoneyMetadata;
}) {
  return (
    <li className="level-up-buy-card">
      <div className="level-up-buy-card-heading">
        <strong>{row.card_name}</strong>
        <span className="level-up-market-hash">{row.market_hash_name}</span>
      </div>
      <dl className="level-up-buy-card-details">
        <Metric label="Lowest ask" value={formatAmount(row.buyer_total, money)} />
        <Metric label="Top-ask depth" value={row.top_ask_quantity} />
        <Metric label="Quote time" value={<QuoteTime timestamp={row.quote_timestamp} />} />
      </dl>
      <MarketLink marketHashName={row.market_hash_name} />
    </li>
  );
}

function DestinationGroup({
  destination,
  steamId,
  money
}: {
  destination: LevelUpDestinationPlan;
  steamId: string;
  money: LevelUpMoneyMetadata;
}) {
  const craftLink = buildSteamProfileGamecardsUrl(steamId, destination.app_id);
  return (
    <article className="level-up-destination-group">
      <header>
        <h5>{destination.game_name}</h5>
        <p>
          Normal badge level {destination.badge_level_before} → {destination.badge_level_after}; +{formatXp(destination.craft_xp)}
        </p>
        <p>
          {destination.owned_card_count} of {destination.set_size} cards already
          owned; buy {destination.rows.length} missing{" "}
          {destination.rows.length === 1 ? "card" : "cards"}.
        </p>
      </header>
      <p className="level-up-destination-subtotal">
        Missing-card total: {formatAmount(destination.missing_cards_total, money)}
      </p>
      <ul className="level-up-buy-cards">
        {destination.rows.map((row) => (
          <BuyCard key={row.market_hash_name} row={row} money={money} />
        ))}
      </ul>
      <p>
        <a href={craftLink} target="_blank" rel="noreferrer">
          Open Steam gamecards navigation
        </a>
      </p>
    </article>
  );
}

function ReadyContent({
  response,
  steamId,
  expired,
  onRefresh,
  refreshLabel,
  sourceIcons
}: {
  response: LevelUpReadyResponse;
  steamId: string;
  expired: boolean;
  onRefresh: () => void;
  refreshLabel: "Refresh recommendation" | "Refresh inventory";
  sourceIcons: ReadonlyMap<string, string>;
}) {
  const money = responseMoney(response);
  const player = response.player;
  const source = response.source;
  const totals = response.totals;
  const firstQuote = source.rows[0]?.quote_timestamp ?? response.generated_at;
  return (
    <div className={expired ? "level-up-ready level-up-ready-expired" : "level-up-ready"}>
      {expired && (
        <div className="level-up-expired-banner">
          <strong>Quote expired.</strong> Live Steam values can differ. Refresh before treating this plan as actionable.
          <RefreshButton onClick={onRefresh}>{refreshLabel}</RefreshButton>
        </div>
      )}
      <div className="level-up-freshness-banner">
        <div>
          <strong>Instant top-of-book estimate.</strong>
          <span> Prices can move before any manual Steam navigation.</span>
        </div>
        <dl className="level-up-fee-contract" aria-label="Quote and fee contract">
          <Metric label="Currency" value={money.currency_code} />
          <Metric label="Quote time" value={<QuoteTime timestamp={firstQuote} />} />
          <Metric
            label="Valid until"
            value={
              <time dateTime={response.valid_until} title={formatAbsoluteTime(response.valid_until)}>
                {expired ? "Expired" : formatRelativeTime(response.valid_until)}
              </time>
            }
          />
          <Metric label="Price basis" value="Buyer total at instant top of book" />
          <Metric label="Steam fee rate" value={formatFeeRate(money.steam_fee_bps)} />
          <Metric
            label="Game-publisher fee rate"
            value={formatFeeRate(money.publisher_fee_bps)}
          />
          <Metric
            label="Minimum per fee component"
            value={formatAmount(money.min_fee_minor, money)}
          />
        </dl>
        {response.scope_limited && (
          <p className="level-up-scope-note">
            Best within the five-badge recommendation cap; more affordable badges may exist.
          </p>
        )}
        {!expired && (
          <RefreshButton onClick={onRefresh}>{refreshLabel}</RefreshButton>
        )}
      </div>

      <dl className="level-up-comparison-metrics">
        <Metric label="Foregone craft XP" value={formatXp(totals.foregone_craft_xp)} />
        <Metric label="Funded badge XP" value={formatXp(totals.funded_craft_xp)} />
        <Metric label="XP advantage" value={`+${formatXp(totals.xp_advantage)}`} />
        <Metric label="Projected level" value={`${player.current_level} → ${player.projected_level}`} />
      </dl>

      <dl className="level-up-money-metrics">
        <Metric label="Estimated seller receipt" value={formatAmount(totals.seller_receipt_total, money)} />
        <Metric label="Steam fee" value={formatAmount(totals.steam_fee_total, money)} />
        <Metric label="Game-publisher fee" value={formatAmount(totals.publisher_fee_total, money)} />
        <Metric label="Missing-card purchase total" value={formatAmount(totals.purchase_total, money)} />
        <Metric label="Unspent sale proceeds" value={formatAmount(totals.unspent_swap_proceeds, money)} />
      </dl>

      <div className="level-up-action-rail">
        <section className="level-up-action-step">
          <span className="level-up-action-number" aria-hidden="true">1</span>
          <SellTable response={response} sourceIcons={sourceIcons} />
        </section>
        <section className="level-up-action-step">
          <span className="level-up-action-number" aria-hidden="true">2</span>
          <div>
            <h4>Wait and verify the fill</h4>
            <p>
              Proceeds are not available until the sale fills. Recheck the price and
              Steam confirmation before continuing.
            </p>
          </div>
        </section>
        <section className="level-up-action-step">
          <span className="level-up-action-number" aria-hidden="true">3</span>
          <div>
            <h4>
              Buy missing cards for {response.destinations.length}{" "}
              {response.destinations.length === 1 ? "badge" : "badges"}
            </h4>
            <div className="level-up-destination-groups">
              {response.destinations.map((destination) => (
                <DestinationGroup
                  key={destination.app_id}
                  destination={destination}
                  steamId={steamId}
                  money={money}
                />
              ))}
            </div>
          </div>
        </section>
        <section className="level-up-action-step">
          <span className="level-up-action-number" aria-hidden="true">4</span>
          <div>
            <h4>Craft the badges</h4>
            <p>
              Manually open each destination game's Steam gamecards page and review
              the normal badge craft. Each funded badge contributes exactly 100 XP.
            </p>
            <ul className="level-up-craft-links">
              {response.destinations.map((destination) => (
                <li key={destination.app_id}>
                  <a
                    href={buildSteamProfileGamecardsUrl(steamId, destination.app_id)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open {destination.game_name} Steam gamecards navigation
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <section className="level-up-action-step">
          <span className="level-up-action-number" aria-hidden="true">5</span>
          <div>
            <h4>Projected result</h4>
            <p>
              {formatXp(player.projected_xp)} · level {player.projected_level} · +
              {formatXp(totals.funded_craft_xp)} from funded badges, with{" "}
              {formatXp(totals.foregone_craft_xp)} in foregone craft XP shown
              separately.
            </p>
          </div>
        </section>
      </div>

      <aside className="level-up-assumptions">
        <h4>Assumptions</h4>
        <ul>
          <li>Prices can move, and final Steam confirmation is authoritative.</li>
          <li>Estimated proceeds are unavailable until the single sale fills.</li>
          <li>Owned destination cards are reused; only missing cards are purchased.</li>
          <li>Taxes, market holds, and the current wallet balance are excluded.</li>
          <li>Rewards other than the normal badge XP are excluded.</li>
        </ul>
      </aside>
    </div>
  );
}

function ResponseSurface({
  response,
  steamId,
  onRefresh,
  onRefreshInventory,
  onRefreshBadges,
  sourceIcons
}: {
  response: LevelUpOptimizationResponse;
  steamId: string | null;
  onRefresh: () => void;
  onRefreshInventory: () => void;
  onRefreshBadges: () => void;
  sourceIcons: ReadonlyMap<string, string>;
}) {
  switch (response.status) {
    case "ready":
      return steamId === null ? (
        <StatusSurface status="unavailable" title="Level-up optimization unavailable">
          <p>Your Steam session is no longer available. Sign in again to view a plan.</p>
        </StatusSurface>
      ) : (
        <ReadyContent
          response={response}
          steamId={steamId}
          expired={false}
          onRefresh={onRefresh}
          refreshLabel="Refresh recommendation"
          sourceIcons={sourceIcons}
        />
      );
    case "no_opportunity":
      return (
        <StatusSurface status="no-opportunity" title="No one-card level-up opportunity">
          <p>{REASON_COPY[response.reason]}</p>
          <p>No manual action plan is shown because there is no strictly positive XP advantage to recommend.</p>
        </StatusSurface>
      );
    case "unavailable":
      if (response.reason === "price_generation_refreshing") {
        return (
          <StatusSurface status="loading" title="Loading current market prices…">
            <p>{REASON_COPY[response.reason]}</p>
          </StatusSurface>
        );
      }
      return (
        <StatusSurface
          status="unavailable"
          title="Level-up optimization unavailable"
          action={
            response.reason === "inventory_snapshot_too_old" ? (
              <RefreshButton onClick={onRefreshInventory}>Refresh inventory</RefreshButton>
            ) : response.reason === "badge_data_unavailable" ? (
              <RefreshButton onClick={onRefreshBadges}>Refresh badge data</RefreshButton>
            ) : response.reason === "price_generation_stale" ||
              response.reason === "price_generation_unavailable" ||
              response.reason === "quote_depth_unavailable" ? (
              <RefreshButton onClick={onRefresh}>Refresh recommendation</RefreshButton>
            ) : undefined
          }
        >
          <p>{REASON_COPY[response.reason]}</p>
          {(response.reason === "currency_contract_missing" ||
            response.reason === "steamapi_key_missing") && (
              <p>This is an operator configuration issue; no partial monetary estimate is displayed.</p>
            )}
        </StatusSurface>
      );
  }
}

function InventoryUnavailableSurface({
  inventoryStatus,
  onRefreshInventory
}: {
  inventoryStatus: LevelUpInventoryStatus;
  onRefreshInventory: () => void;
}) {
  return (
    <StatusSurface
      status="unavailable"
      title="Level-up optimization unavailable"
      action={<RefreshButton onClick={onRefreshInventory}>Refresh inventory</RefreshButton>}
    >
      <p>
        {inventoryStatus === "private"
          ? "Make your Steam inventory public before requesting a level-up recommendation."
          : "Inventory ownership is unavailable. Refresh inventory to calculate a plan."}
      </p>
    </StatusSurface>
  );
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}
export function LevelUpOptimizationPanel({
  steamId,
  inventoryStatus,
  items,
  boosters,
  badges,
  inventoryRefreshedAt,
  isInventoryLoading,
  isActive,
  onRefreshInventory,
  onRefreshBadges = onRefreshInventory
}: LevelUpOptimizationPanelProps) {
  const [state, setState] = useState<LevelUpState>({ kind: "idle", key: null });
  const cacheRef = useRef(new Map<string, LevelUpOptimizationResponse>());
  const requestRef = useRef<{
    key: string;
    controller: AbortController;
    token: number;
  } | null>(null);
  const tokenRef = useRef(0);
  const mountedRef = useRef(true);
  const [inventoryClock, setInventoryClock] = useState(Date.now);
  const requestInput = useMemo(() => {
    try {
      return {
        request: buildLevelUpOptimizationRequest(
          items,
          boosters,
          badges,
          inventoryRefreshedAt ?? ""
        ),
        message: null
      };
    } catch {
      return {
        request: null,
        message:
          "Steam badge or game identity data is unavailable. Refresh inventory and try again."
      };
    }
  }, [badges, boosters, inventoryRefreshedAt, items]);
  const inputRef = useRef({
    steamId,
    items,
    boosters,
    badges,
    inventoryRefreshedAt,
    request: requestInput.request
  });
  useEffect(() => {
    inputRef.current = {
      steamId,
      items,
      boosters,
      badges,
      inventoryRefreshedAt,
      request: requestInput.request
    };
  }, [
    badges,
    boosters,
    inventoryRefreshedAt,
    items,
    requestInput.request,
    steamId
  ]);

  const snapshotKey = levelUpSnapshotKey(
    steamId,
    inventoryRefreshedAt,
    badges.checked_at,
    requestInput.request
  );
  useEffect(() => {
    const timestamps = [inventoryRefreshedAt, badges.checked_at].filter(
      (timestamp): timestamp is string => isLevelUpIsoTimestamp(timestamp)
    );
    if (timestamps.length === 0) {
      return;
    }
    const now = Date.now();
    const transitionTimes = timestamps.flatMap((timestamp) => {
      const startsAt = Date.parse(timestamp);
      return [startsAt, startsAt + LEVEL_UP_INVENTORY_MAX_AGE_MS];
    });
    const nextTransition = Math.min(
      ...transitionTimes.filter((timestamp) => timestamp > now)
    );
    if (!Number.isFinite(nextTransition)) {
      return;
    }
    const freshnessTimer = window.setTimeout(() => {
      setInventoryClock(Date.now());
    }, nextTransition - now + 1);
    return () => window.clearTimeout(freshnessTimer);
  }, [badges.checked_at, inventoryClock, inventoryRefreshedAt]);
  useEffect(() => {
    let current = true;
    queueMicrotask(() => {
      if (current) {
        setInventoryClock(Date.now());
      }
    });
    return () => {
      current = false;
    };
  }, [badges.checked_at, inventoryRefreshedAt, isActive]);
  const inventoryIsFresh = isInventorySnapshotFresh(
    inventoryRefreshedAt,
    inventoryClock
  );
  const badgeIsFresh = isInventorySnapshotFresh(
    badges.checked_at,
    inventoryClock
  );

  const abortCurrent = useCallback(() => {
    requestRef.current?.controller.abort();
    requestRef.current = null;
  }, []);

  const requestForKey = useCallback((key: string, force = false) => {
    const current = inputRef.current;
    if (
      current.steamId === null ||
      current.inventoryRefreshedAt === null ||
      !isLevelUpIsoTimestamp(current.inventoryRefreshedAt) ||
      !isInventorySnapshotFresh(current.inventoryRefreshedAt, Date.now()) ||
      !isInventorySnapshotFresh(current.badges.checked_at, Date.now()) ||
      current.request === null
    ) {
      return;
    }
    const request = current.request;
    if (request === null) {
      return;
    }
    const existingRequest = requestRef.current;
    if (existingRequest?.key === key && !force) {
      return;
    }
    if (existingRequest !== null) {
      existingRequest.controller.abort();
      requestRef.current = null;
    }
    if (!force) {
      const cached = cacheRef.current.get(key);
      if (cached !== undefined) {
        if (cached.status === "ready" && isLevelUpResponseExpired(cached)) {
          setState({ kind: "expired", key, response: cached });
        } else {
          setState({ kind: "response", key, response: cached });
        }
        return;
      }
    } else {
      cacheRef.current.delete(key);
    }
    const controller = new AbortController();
    const token = ++tokenRef.current;
    requestRef.current = { key, controller, token };
    setState({ kind: "loading", key });
    void requestLevelUpOptimization(current.steamId, request, controller.signal)
      .then((response) => {
        if (
          !mountedRef.current ||
          requestRef.current?.key !== key ||
          requestRef.current.token !== token
        ) {
          return;
        }
        requestRef.current = null;
        cacheRef.current.set(key, response);
        if (response.status === "ready" && isLevelUpResponseExpired(response)) {
          setState({ kind: "expired", key, response });
        } else {
          setState({ kind: "response", key, response });
        }
      })
      .catch((error: unknown) => {
        if (
          !mountedRef.current ||
          requestRef.current?.key !== key ||
          requestRef.current.token !== token
        ) {
          return;
        }
        requestRef.current = null;
        if (isAbortError(error)) {
          return;
        }
        setState({
          kind: "error",
          key,
          message: "The recommendation service could not be reached. Try again later."
        });
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (!mountedRef.current) {
          abortCurrent();
        }
      });
    };
  }, [abortCurrent]);

  useEffect(() => {
    const lifecycleValid =
      inventoryStatus === "public" &&
      !isInventoryLoading &&
      snapshotKey !== null &&
      inventoryIsFresh &&
      badgeIsFresh &&
      requestInput.request !== null;
    if (
      requestRef.current !== null &&
      (!lifecycleValid || requestRef.current.key !== snapshotKey)
    ) {
      abortCurrent();
    }
    if (!isActive || !lifecycleValid) {
      return;
    }
    requestForKey(snapshotKey);
  }, [
    abortCurrent,
    badgeIsFresh,
    inventoryIsFresh,
    inventoryStatus,
    isActive,
    isInventoryLoading,
    requestForKey,
    requestInput.request,
    snapshotKey
  ]);

  useEffect(() => {
    if (
      !isActive ||
      state.kind !== "response" ||
      state.response.status !== "unavailable" ||
      state.response.reason !== "price_generation_refreshing"
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      requestForKey(state.key, true);
    }, PRICE_CATALOG_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [isActive, requestForKey, state]);

  useEffect(() => {
    if (state.kind !== "response" || state.response.status !== "ready") {
      return;
    }
    const delay = Math.max(0, Date.parse(state.response.valid_until) - Date.now());
    const timer = window.setTimeout(() => {
      setState((current) => {
        if (
          current.kind === "response" &&
          current.key === state.key &&
          current.response.status === "ready"
        ) {
          return { kind: "expired", key: current.key, response: current.response };
        }
        return current;
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [state]);

  const refreshRecommendation = useCallback(() => {
    if (
      snapshotKey !== null &&
      inventoryStatus === "public" &&
      !isInventoryLoading
    ) {
      if (
        isInventorySnapshotFresh(inventoryRefreshedAt, Date.now()) &&
        isInventorySnapshotFresh(badges.checked_at, Date.now()) &&
        requestInput.request !== null
      ) {
        requestForKey(snapshotKey, true);
      } else {
        setInventoryClock(Date.now());
      }
    }
  }, [
    badges.checked_at,
    inventoryRefreshedAt,
    inventoryStatus,
    isInventoryLoading,
    requestForKey,
    requestInput.request,
    snapshotKey
  ]);

  const refreshInventory = useCallback(() => {
    abortCurrent();
    if (snapshotKey !== null) {
      cacheRef.current.delete(snapshotKey);
    }
    setState({ kind: "idle", key: null });
    onRefreshInventory();
  }, [abortCurrent, onRefreshInventory, snapshotKey]);
  const sourceIcons = new Map<string, string>();
  for (const item of items) {
    if (
      typeof item.market_hash_name === "string" &&
      typeof item.icon_url === "string" &&
      item.icon_url.length > 0
    ) {
      sourceIcons.set(item.market_hash_name, item.icon_url);
    }
  }

  const activeState: LevelUpState = state.key === snapshotKey
    ? state
    : { kind: "idle", key: snapshotKey };
  const expiredResponse =
    activeState.kind === "expired"
      ? activeState.response
      : activeState.kind === "response" &&
        activeState.response.status === "ready" &&
        (!inventoryIsFresh || !badgeIsFresh)
        ? activeState.response
        : null;
  const badgeUnavailable = badges.status !== "public" || !badgeIsFresh;
  let content: ReactNode;
  if (!isActive) {
    content = null;
  } else if (isInventoryLoading) {
    content = (
      <StatusSurface status="loading" title="Calculating a one-card level-up plan…">
        <p>Checking current ownership, prices, fees, and badge data.</p>
      </StatusSurface>
    );
  } else if (inventoryStatus !== "public") {
    content = (
      <InventoryUnavailableSurface
        inventoryStatus={inventoryStatus}
        onRefreshInventory={refreshInventory}
      />
    );
  } else if (badgeUnavailable) {
    content = (
      <StatusSurface
        status="unavailable"
        title="Refresh badge data to calculate a plan"
        action={<RefreshButton onClick={onRefreshBadges}>Refresh badge data</RefreshButton>}
      >
        <p>
          {badges.status === "public"
            ? "Steam badge data is missing or too old for a safe recommendation."
            : badges.message}
        </p>
      </StatusSurface>
    );
  } else if (
    requestInput.request === null &&
    snapshotKey !== null &&
    inventoryIsFresh
  ) {
    content = (
      <StatusSurface
        status="unavailable"
        title="Game metadata unavailable"
        action={<RefreshButton onClick={refreshInventory}>Refresh inventory</RefreshButton>}
      >
        <p>{requestInput.message ?? "Refresh inventory to load game identity data."}</p>
      </StatusSurface>
    );
  } else if (expiredResponse !== null) {
    content = steamId === null ? (
      <StatusSurface status="unavailable" title="Level-up optimization unavailable">
        <p>Your Steam session is no longer available. Sign in again to view a plan.</p>
      </StatusSurface>
    ) : (
      <ReadyContent
        response={expiredResponse}
        steamId={steamId}
        expired
        onRefresh={inventoryIsFresh && badgeIsFresh ? refreshRecommendation : refreshInventory}
        refreshLabel={
          inventoryIsFresh && badgeIsFresh
            ? "Refresh recommendation"
            : "Refresh inventory"
        }
        sourceIcons={sourceIcons}
      />
    );
  } else if (snapshotKey === null || !inventoryIsFresh) {
    content = (
      <StatusSurface
        status="unavailable"
        title="Refresh inventory to calculate a plan"
        action={<RefreshButton onClick={refreshInventory}>Refresh inventory</RefreshButton>}
      >
        <p>The current ownership snapshot is missing or too old for a safe recommendation.</p>
      </StatusSurface>
    );
  } else if (activeState.kind === "loading") {
    content = (
      <StatusSurface status="loading" title="Calculating a one-card level-up plan…">
        <p>Checking current ownership, prices, fees, and badge data.</p>
      </StatusSurface>
    );
  } else if (activeState.kind === "error") {
    content = (
      <StatusSurface
        status="unavailable"
        title="Level-up optimization unavailable"
        action={<RefreshButton onClick={refreshRecommendation}>Refresh recommendation</RefreshButton>}
      >
        <p>{activeState.message}</p>
      </StatusSurface>
    );
  } else if (activeState.kind === "response") {
    content = (
      <ResponseSurface
        response={activeState.response}
        steamId={steamId}
        onRefresh={refreshRecommendation}
        onRefreshInventory={refreshInventory}
        onRefreshBadges={onRefreshBadges}
        sourceIcons={sourceIcons}
      />
    );
  } else {
    content = (
      <StatusSurface status="loading" title="Calculating a one-card level-up plan…">
        <p>Checking current ownership, prices, fees, and badge data.</p>
      </StatusSurface>
    );
  }

  let announcement = "";
  if (isActive) {
    if (isInventoryLoading) {
      announcement = "Calculating a one-card level-up plan…";
    } else if (inventoryStatus !== "public") {
      announcement = "Level-up optimization unavailable.";
    } else if (badgeUnavailable) {
      announcement = "Refresh badge data to calculate a plan.";
    } else if (
      requestInput.request === null &&
      snapshotKey !== null &&
      inventoryIsFresh
    ) {
      announcement = "Game metadata is unavailable.";
    } else if (expiredResponse !== null) {
      announcement = inventoryIsFresh && badgeIsFresh
        ? "Quote expired."
        : "Quote and snapshot expired.";
    } else if (snapshotKey === null || !inventoryIsFresh) {
      announcement = "Refresh inventory to calculate a plan.";
    } else if (activeState.kind === "loading") {
      announcement = "Calculating a one-card level-up plan…";
    } else if (activeState.kind === "error") {
      announcement = "Level-up optimization unavailable.";
    } else if (activeState.kind === "response") {
      announcement =
        activeState.response.status === "ready"
          ? "One-card level-up recommendation ready."
          : activeState.response.status === "no_opportunity"
            ? "No one-card level-up opportunity."
            : "Level-up optimization unavailable.";
    }
  }

  return (
    <section id={PANEL_ID} className="level-up-optimization-panel">
      <h2>Level-up optimization</h2>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="level-up-optimization-live-region"
      >
        {announcement}
      </div>
      <div className="level-up-optimization-content">{content}</div>
    </section>
  );
}

export default LevelUpOptimizationPanel;
