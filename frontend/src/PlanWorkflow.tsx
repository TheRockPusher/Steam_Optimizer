import { useMemo, useState } from "react";
import type {
  BadgeCollectorTarget,
  BadgePlan,
  BadgePlanningReadyResponse
} from "./badgePlanning";
import type { LevelUpInventoryItem } from "./levelUpOptimization";
import {
  buildPlanChecklist,
  checklistToText,
  describeChecklistRow,
  downloadChecklist,
  formatChecklistMoney,
  PLAN_CHECKLIST_RENDER_LIMIT,
  readChecklistMarks,
  persistChecklistMarks,
  toggleChecklistAnnotation
} from "./planWorkflow";
import type { PlanChecklist, PlanChecklistRow } from "./planWorkflow";
import "./PlanWorkflow.css";

/**
 * Reference checklist for the selected plan: one consolidated list covering
 * crafts, purchases, remaining wants, and surplus, downloadable as text,
 * CSV, or JSON. Manual checkbox annotations are scoped to the current
 * account, plan, and snapshot; nothing here performs a transaction.
 */

export type PlanWorkflowProps = {
  steamId: string;
  response: BadgePlanningReadyResponse;
  plan: BadgePlan;
  items: readonly LevelUpInventoryItem[];
  canAct: boolean;
  onRefresh: () => void;
  /** Full requested collector goal; extends wants beyond the plan's crafts. */
  collectorTargets?: readonly BadgeCollectorTarget[];
};

const COUNT_FORMATTER = new Intl.NumberFormat("en-US");

const STRATEGY_LABELS: Record<BadgePlan["strategy"], string> = {
  cheapest: "Cheapest",
  fewest_purchases: "Fewest purchases",
  preserve_cards: "Preserve owned cards"
};

const STATUS_LABELS: Record<BadgePlan["status"], string> = {
  ready: "Ready",
  partial: "Partial",
  no_opportunity: "No opportunity"
};

const SECTION_LABELS: Record<PlanChecklistRow["kind"], string> = {
  craft: "Planned crafts",
  purchase: "Planned purchases",
  want: "Still wanted",
  surplus: "Surplus after commitments"
};

const EMPTY_ANNOTATIONS: ReadonlySet<string> = new Set();
const ROW_KINDS = ["purchase", "craft", "want", "surplus"] as const;

function ChecklistRow({
  row,
  checklist,
  checked,
  onToggle
}: {
  row: PlanChecklistRow;
  checklist: PlanChecklist;
  checked: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <label className="plan-workflow-row">
      <input
        type="checkbox"
        className="plan-workflow-row-checkbox"
        checked={checked}
        onChange={() => onToggle(row.id)}
      />
      <span
        className={`plan-workflow-row-kind plan-workflow-row-kind-${row.kind}`}
      >
        {row.kind}
      </span>
      <span className="plan-workflow-row-text">
        {describeChecklistRow(row, checklist)}
      </span>
    </label>
  );
}

export default function PlanWorkflow({
  steamId,
  response,
  plan,
  items,
  canAct,
  onRefresh,
  collectorTargets
}: PlanWorkflowProps) {
  const checklist = useMemo(
    () =>
      buildPlanChecklist({ steamId, response, plan, items, collectorTargets }),
    [steamId, response, plan, items, collectorTargets]
  );

  const [marked, setMarked] = useState(() => ({
    key: checklist.planKey,
    ...readChecklistMarks(steamId, checklist)
  }));
  if (marked.key !== checklist.planKey) {
    setMarked({
      key: checklist.planKey,
      ...readChecklistMarks(steamId, checklist)
    });
  }
  const annotations =
    marked.key === checklist.planKey ? marked.ids : EMPTY_ANNOTATIONS;
  const updateMarks = (
    ids: ReadonlySet<string>,
    remember = marked.remember
  ) => {
    const error =
      remember || marked.remember
        ? persistChecklistMarks(steamId, checklist, remember, ids)
        : null;
    setMarked({ key: checklist.planKey, ids, remember, error });
  };
  const toggleAnnotation = (id: string) => {
    updateMarks(toggleChecklistAnnotation(annotations, id));
  };

  const [notice, setNotice] = useState<string | null>(null);
  const money = (amountMinor: number) =>
    formatChecklistMoney(
      amountMinor,
      checklist.reference.currencyCode,
      checklist.reference.minorDigits
    );

  const copyChecklist = async () => {
    try {
      if (
        typeof navigator === "undefined" ||
        navigator.clipboard === undefined
      ) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(
        checklistToText(checklist, annotations)
      );
      setNotice("Checklist copied to the clipboard as plain text.");
    } catch {
      setNotice("The clipboard refused the copy. Use a download instead.");
    }
  };

  const download = (format: "csv" | "json") => {
    setNotice(
      downloadChecklist(checklist, format, annotations)
        ? `Checklist downloaded as ${format.toUpperCase()} with your current marks included.`
        : "The browser blocked the download. Use Copy checklist instead."
    );
  };

  const gameNameById = useMemo(
    () => new Map(response.games.map((game) => [game.app_id, game.game_name])),
    [response.games]
  );
  const goalText =
    collectorTargets === undefined || collectorTargets.length === 0
      ? null
      : collectorTargets
          .map(
            (target) =>
              `${gameNameById.get(target.app_id) ?? `game ${target.app_id}`} → level ${target.target_level}`
          )
          .join(", ");
  const visibleRows = checklist.rows.slice(0, PLAN_CHECKLIST_RENDER_LIMIT);

  return (
    <section className="plan-workflow" aria-labelledby="plan-workflow-heading">
      <div className="plan-workflow-heading">
        <h2 id="plan-workflow-heading">Plan checklist</h2>
        <p className="plan-workflow-scope">
          Reference only. Nothing is bought, sold, or crafted automatically —
          tick rows to track your own progress.
        </p>
      </div>

      <div className="plan-workflow-overview">
        <span className="plan-workflow-chip plan-workflow-chip-strategy">
          {STRATEGY_LABELS[plan.strategy]}
        </span>
        <span
          className={`plan-workflow-chip plan-workflow-chip-${plan.status}`}
        >
          {STATUS_LABELS[plan.status]}
        </span>
        <dl className="plan-workflow-reference">
          <div className="plan-workflow-reference-item">
            <dt>Plan generated</dt>
            <dd>{checklist.reference.generatedAt}</dd>
          </div>
          <div className="plan-workflow-reference-item">
            <dt>Valid until</dt>
            <dd>{checklist.reference.validUntil}</dd>
          </div>
          <div className="plan-workflow-reference-item">
            <dt>Inventory snapshot</dt>
            <dd>{checklist.reference.inventoryRefreshedAt}</dd>
          </div>
          <div className="plan-workflow-reference-item">
            <dt>Badge snapshot</dt>
            <dd>{checklist.reference.badgeRefreshedAt}</dd>
          </div>
          <div className="plan-workflow-reference-item">
            <dt>Currency</dt>
            <dd>
              {checklist.reference.currencyCode === null ||
              checklist.reference.minorDigits === null
                ? "Not confirmed (amounts are minor units)"
                : `${checklist.reference.currencyCode} (${checklist.reference.minorDigits} minor digit(s))`}
            </dd>
          </div>
          <div className="plan-workflow-reference-item">
            <dt>Spend</dt>
            <dd>
              {money(checklist.summary.spendMinor)}
              {` (budget left ${money(checklist.summary.remainingBudgetMinor)})`}
            </dd>
          </div>
          <div className="plan-workflow-reference-item">
            <dt>Crafts</dt>
            <dd>
              {COUNT_FORMATTER.format(checklist.summary.craftCount)}
              {` (+${COUNT_FORMATTER.format(checklist.summary.xpGain)} XP → level ${COUNT_FORMATTER.format(checklist.reference.projectedLevel)})`}
            </dd>
          </div>
          {checklist.reference.targetLevel !== null && (
            <div className="plan-workflow-reference-item">
              <dt>Target</dt>
              <dd>{`Level ${COUNT_FORMATTER.format(checklist.reference.targetLevel)}`}</dd>
            </div>
          )}
          {checklist.reference.shortfallXp > 0 && (
            <div className="plan-workflow-reference-item">
              <dt>Shortfall</dt>
              <dd>{`${COUNT_FORMATTER.format(checklist.reference.shortfallXp)} XP`}</dd>
            </div>
          )}
          {goalText !== null && (
            <div className="plan-workflow-reference-item">
              <dt>Collector goals</dt>
              <dd>{goalText}</dd>
            </div>
          )}
        </dl>
      </div>

      {checklist.reference.stale && (
        <div className="plan-workflow-expiry" role="status">
          <p>
            This plan snapshot is stale: it expired or its inventory and badge
            data aged out. Treat every price and quantity as out of date.
          </p>
          <button
            type="button"
            className="plan-workflow-secondary"
            onClick={onRefresh}
          >
            Refresh plan
          </button>
        </div>
      )}
      {!canAct && (
        <p className="plan-workflow-note">
          Paid market actions are disabled for this snapshot (stale data or no
          confirmed currency). The checklist stays reference-only.
        </p>
      )}
      {checklist.warnings.length > 0 && (
        <ul className="plan-workflow-warnings">
          {checklist.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <div className="plan-workflow-export">
        <label className="plan-workflow-remember">
          <input
            type="checkbox"
            checked={marked.remember}
            onChange={(event) => updateMarks(annotations, event.target.checked)}
          />
          Remember checklist marks on this device
        </label>
        <p className="plan-workflow-session-note">
          Marks are notes, not proof of a Steam action. Saved marks return only
          for the same plan and inventory; refreshed holdings reset them.
        </p>
        {marked.error !== null && <p role="alert">{marked.error}</p>}
        <button
          type="button"
          className="plan-workflow-secondary"
          onClick={() => {
            void copyChecklist();
          }}
        >
          Copy checklist
        </button>
        <button
          type="button"
          className="plan-workflow-secondary"
          onClick={() => download("csv")}
        >
          Download CSV
        </button>
        <button
          type="button"
          className="plan-workflow-secondary"
          onClick={() => download("json")}
        >
          Download JSON
        </button>
        <span className="plan-workflow-export-count">
          {COUNT_FORMATTER.format(annotations.size)} of{" "}
          {COUNT_FORMATTER.format(checklist.rows.length)} rows marked
        </span>
        <button
          type="button"
          className="plan-workflow-clear"
          onClick={() => updateMarks(EMPTY_ANNOTATIONS)}
          disabled={annotations.size === 0}
        >
          Clear marks
        </button>
        <p className="plan-workflow-notice" role="status">
          {notice}
        </p>
      </div>

      <div className="plan-workflow-sections">
        {ROW_KINDS.map((kind) => {
          const rows = visibleRows.filter((row) => row.kind === kind);
          if (rows.length === 0) {
            return null;
          }
          return (
            <fieldset key={kind} className="plan-workflow-section">
              <legend>{SECTION_LABELS[kind]}</legend>
              <div className="plan-workflow-rows">
                {rows.map((row) => (
                  <ChecklistRow
                    key={row.id}
                    row={row}
                    checklist={checklist}
                    checked={annotations.has(row.id)}
                    onToggle={toggleAnnotation}
                  />
                ))}
              </div>
            </fieldset>
          );
        })}
        {checklist.rows.length === 0 && (
          <p className="plan-workflow-empty">
            This plan has no craft steps. Surplus and wants are listed only when
            your inventory or requested goals produce them.
          </p>
        )}
        {checklist.rows.length > visibleRows.length && (
          <p className="plan-workflow-note">
            Showing the first {COUNT_FORMATTER.format(visibleRows.length)} of{" "}
            {COUNT_FORMATTER.format(checklist.rows.length)} rows. Use the
            downloads for the complete list.
          </p>
        )}
      </div>
    </section>
  );
}
