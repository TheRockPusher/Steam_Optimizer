const BADGE_ARTWORK_URL = `${(import.meta.env.VITE_API_BASE_URL ?? "").replace(
  /\/+$/,
  ""
)}/api/auth/badge-artwork/`;

export const MAX_BADGE_LEVEL = 5;
const MAX_IMAGE_URL_LENGTH = 512;

// Mirror the backend's fixed Steam image-origin allowlist.
const ALLOWED_IMAGE_HOSTS: Record<string, true> = {
  "shared.fastly.steamstatic.com": true,
  "community.fastly.steamstatic.com": true,
  "shared.akamai.steamstatic.com": true,
  "community.akamai.steamstatic.com": true,
  "shared.cloudflare.steamstatic.com": true,
  "community.cloudflare.steamstatic.com": true,
  "steamcdn-a.akamaihd.net": true
};

export const APP_ID_PATTERN = /^\d{1,10}$/;
const STEAM_ID_PATTERN = /^\d{17}$/;

type BadgeArtworkLevel = {
  level: number;
  name: string;
  image_url: string;
};

export type BadgeArtworkData = {
  app_id: string;
  status: "ready" | "unavailable";
  badges: BadgeArtworkLevel[];
  source_url: string | null;
};

export type BadgeArtworkFetcher = (
  appId: string,
  steamId: string,
  signal: AbortSignal
) => Promise<BadgeArtworkData>;

function isAllowlistedImageUrl(value: unknown, appId: string): value is string {
  if (typeof value !== "string" || value.length > MAX_IMAGE_URL_LENGTH) {
    return false;
  }
  if (!value.startsWith("https://")) {
    return false;
  }
  try {
    const url = new URL(value);
    if (
      !Object.hasOwn(ALLOWED_IMAGE_HOSTS, url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) {
      return false;
    }
    const path =
      /^\/(?:community_assets\/images\/items|steamcommunity\/public\/images\/items)\/(\d+)\/[0-9a-f]{32,64}\.(?:png|jpg|jpeg|webp)$/.exec(
        url.pathname
      );
    return path !== null && path[1] === appId;
  } catch {
    return false;
  }
}

function isBadgeArtworkLevel(
  value: unknown,
  appId: string
): value is BadgeArtworkLevel {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.level === "number" &&
    Number.isInteger(candidate.level) &&
    candidate.level >= 1 &&
    candidate.level <= MAX_BADGE_LEVEL &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    isAllowlistedImageUrl(candidate.image_url, appId)
  );
}

function isBadgeArtworkData(value: unknown): value is BadgeArtworkData {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.app_id !== "string" ||
    typeof candidate.status !== "string" ||
    !Array.isArray(candidate.badges) ||
    candidate.badges.length > MAX_BADGE_LEVEL ||
    (candidate.source_url !== null && typeof candidate.source_url !== "string")
  ) {
    return false;
  }
  if (candidate.status === "unavailable") {
    return candidate.badges.length === 0 && candidate.source_url === null;
  }
  if (candidate.status !== "ready" || candidate.badges.length === 0) {
    return false;
  }
  const source =
    typeof candidate.source_url === "string"
      ? /^https:\/\/steamcommunity\.com\/profiles\/\d{17}\/gamecards\/(\d+)\/$/.exec(
          candidate.source_url
        )
      : null;
  if (source === null || source[1] !== candidate.app_id) {
    return false;
  }
  let previousLevel = 0;
  for (const badge of candidate.badges) {
    if (
      !isBadgeArtworkLevel(badge, candidate.app_id) ||
      badge.level <= previousLevel
    ) {
      return false;
    }
    previousLevel = badge.level;
  }
  return true;
}
/** Authenticated read of public Steam artwork; no transaction access. */

export async function fetchBadgeArtwork(
  appId: string,
  steamId: string,
  signal: AbortSignal
): Promise<BadgeArtworkData> {
  if (!APP_ID_PATTERN.test(appId)) {
    throw new Error("The game id for badge artwork is invalid.");
  }
  if (!STEAM_ID_PATTERN.test(steamId)) {
    throw new Error("The SteamID for badge artwork is invalid.");
  }

  let response: Response;
  try {
    response = await fetch(`${BADGE_ARTWORK_URL}${appId}`, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "x-expected-steam-id": steamId
      },
      signal
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    throw new Error("Steam badge artwork is unavailable right now.", {
      cause: error
    });
  }

  if (response.status === 401) {
    throw new Error(
      "Your Steam session expired. Sign in again to view badge previews."
    );
  }
  if (!response.ok) {
    throw new Error("Steam badge artwork is unavailable right now.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Steam badge artwork returned unexpected data.");
  }
  if (!isBadgeArtworkData(payload) || payload.app_id !== appId) {
    throw new Error("Steam badge artwork returned unexpected data.");
  }
  return payload;
}
