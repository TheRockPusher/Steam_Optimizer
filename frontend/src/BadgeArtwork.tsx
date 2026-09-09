import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import "./BadgeArtwork.css";
import {
  APP_ID_PATTERN,
  MAX_BADGE_LEVEL,
  fetchBadgeArtwork,
  type BadgeArtworkData,
  type BadgeArtworkFetcher
} from "./badgeArtwork";

export type BadgeArtworkProps = {
  appId: string;
  steamId: string | null;
  gameName: string | null;
  targetLevel: number | null;
  // Keep this stable to avoid refetching on every render.
  fetchBadgeArtwork?: BadgeArtworkFetcher;
  className?: string;
};

type BadgeArtworkState =
  | { kind: "loading" }
  | { kind: "ready"; data: BadgeArtworkData }
  | { kind: "unavailable"; data: BadgeArtworkData }
  | { kind: "error"; message: string };

// Never paint artwork from another account, game, or data source.
type BadgeArtworkResult = {
  appId: string;
  steamId: string;
  fetcher: BadgeArtworkFetcher;
  attempt: number;
  state: BadgeArtworkState;
};

const LOADING: BadgeArtworkState = { kind: "loading" };

export default function BadgeArtwork({
  appId,
  steamId,
  gameName,
  targetLevel,
  fetchBadgeArtwork: injectedFetcher,
  className
}: BadgeArtworkProps): ReactElement | null {
  const fetcher = injectedFetcher ?? fetchBadgeArtwork;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<BadgeArtworkResult | null>(null);

  const validTargetLevel =
    targetLevel !== null &&
    Number.isInteger(targetLevel) &&
    targetLevel >= 1 &&
    targetLevel <= MAX_BADGE_LEVEL
      ? targetLevel
      : null;

  useEffect(() => {
    if (steamId === null || !APP_ID_PATTERN.test(appId)) {
      return;
    }
    const controller = new AbortController();
    let active = true;
    fetcher(appId, steamId, controller.signal)
      .then((data) => {
        if (!active) {
          return;
        }
        setResult({
          appId,
          steamId,
          fetcher,
          attempt,
          state:
            data.status === "ready"
              ? { kind: "ready", data }
              : { kind: "unavailable", data }
        });
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) {
          return;
        }
        setResult({
          appId,
          steamId,
          fetcher,
          attempt,
          state: {
            kind: "error",
            message:
              error instanceof Error && error.message
                ? error.message
                : "Steam badge artwork is unavailable right now."
          }
        });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [appId, steamId, fetcher, attempt]);

  if (steamId === null || !APP_ID_PATTERN.test(appId)) {
    return null;
  }

  const state =
    result !== null &&
    result.appId === appId &&
    result.steamId === steamId &&
    result.fetcher === fetcher &&
    result.attempt === attempt
      ? result.state
      : LOADING;

  const subject = gameName ?? `App ${appId}`;
  const targetMissing =
    state.kind === "ready" &&
    validTargetLevel !== null &&
    !state.data.badges.some((badge) => badge.level === validTargetLevel);

  return (
    <section
      className={
        className === undefined ? "badge-artwork" : `badge-artwork ${className}`
      }
      aria-label={`Badge previews for ${subject}`}
    >
      <div className="badge-artwork-heading">
        <p className="badge-artwork-title">Badge previews</p>
        <p className="badge-artwork-subject">{subject}</p>
      </div>
      {state.kind === "loading" ? (
        <p className="badge-artwork-note" role="status" aria-live="polite">
          Loading badge artwork…
        </p>
      ) : null}
      {state.kind === "error" ? (
        <>
          <p
            className="badge-artwork-note badge-artwork-note--error"
            role="alert"
          >
            {state.message}
          </p>
          <button
            type="button"
            className="badge-artwork-retry"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        </>
      ) : null}
      {state.kind === "unavailable" ? (
        <>
          <p
            className="badge-artwork-note badge-artwork-note--unavailable"
            role="status"
          >
            Verified normal-badge artwork is unavailable from the public pages
            checked.
          </p>
          <button
            type="button"
            className="badge-artwork-retry"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Check again
          </button>
        </>
      ) : null}
      {state.kind === "ready" ? (
        <>
          <ul className="badge-artwork-levels">
            {state.data.badges.map((badge) => {
              const isTarget = validTargetLevel === badge.level;
              return (
                <li
                  key={badge.level}
                  className={
                    isTarget
                      ? "badge-artwork-level badge-artwork-level--target"
                      : "badge-artwork-level"
                  }
                  aria-current={isTarget ? "true" : undefined}
                >
                  <img
                    className="badge-artwork-image"
                    src={badge.image_url}
                    alt={`${subject} level ${badge.level} badge: ${badge.name}`}
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                  />
                  <span className="badge-artwork-level-tag">
                    Level {badge.level}
                  </span>
                  <span className="badge-artwork-level-name">{badge.name}</span>
                  {isTarget ? (
                    <span className="badge-artwork-target-tag">Target</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {state.data.badges.length < MAX_BADGE_LEVEL || targetMissing ? (
            <p className="badge-artwork-note">
              Verified artwork covers {state.data.badges.length} of{" "}
              {MAX_BADGE_LEVEL} normal levels.
              {targetMissing
                ? ` Level ${validTargetLevel} has not been verified.`
                : ""}
            </p>
          ) : null}
          {state.data.source_url !== null ? (
            <a
              className="badge-artwork-source"
              href={state.data.source_url}
              target="_blank"
              rel="noreferrer noopener"
            >
              Source: Steam Community game cards
            </a>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
