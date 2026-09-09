"""Read-only normal badge artwork resolution from first-party Steam data.

The artwork endpoint serves genuine normal badge (level 1-5) names and
images for one game.  Valve publishes badge artwork only inside
authenticated Web API methods (``IPlayerService/GetBadges`` and
``IQuestService/GetCommunityItemDefinitions`` both require a Web API key,
which this deployment does not hold) and on Steam Community game-card
pages.  The public, key-free, cookie-free source is therefore the
community game-card page of a public Steam profile that owns the badge:
``https://steamcommunity.com/profiles/<public id>/gamecards/<app_id>/``.

The service requests only URLs it builds itself from validated integers
against the fixed ``steamcommunity.com`` origin, parses the badge row
strictly, validates every image URL against a fixed allowlist, serializes
all upstream requests through :class:`SteamCommunityLimiter`, and caches
bounded results in process memory.  A page exposes the one badge level its
viewer currently owns, so responses carry only the levels verifiably
published upstream: one level on a hit, and an explicit ``unavailable``
status when no public page shows the game's normal badge.  Nothing is ever
fabricated: no level, name, or image appears unless the allowlisted page
contained it.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from html import unescape
from typing import TYPE_CHECKING, Literal

import httpx2
from pydantic import BaseModel, ConfigDict, Field

from app.gem_pricing import (
    SteamCommunityLimiter,
    _CommunityRateLimitedError,
)
from app.level_up_optimizer import MAX_APP_ID, MAX_GAME_NAME_LENGTH

if TYPE_CHECKING:
    from collections.abc import Sequence

    from app.http_protocols import AsyncHTTPClient, HTTPResponse
    from app.settings import Settings

STEAM_COMMUNITY_BASE_URL = "https://steamcommunity.com"
"""The only upstream origin the artwork provider is allowed to contact."""

GAMECARDS_URL_TEMPLATE = (
    f"{STEAM_COMMUNITY_BASE_URL}/profiles/{{steam_id}}/gamecards/{{app_id}}/"
)
"""Public game-card page template; ``steam_id`` and ``app_id`` are digits."""

STEAM_OPTIMIZER_USER_AGENT = (
    "SteamOptimizer/0.1.1 (+https://github.com/TheRockPusher/Steam_Optimizer)"
)

MAX_BADGE_LEVEL = 5
"""Normal badges carry exactly five levels (plus a separate foil badge)."""

MAX_DONOR_STEAM_IDS = 16
"""Upper bound on configured public donor profiles."""

MAX_ARTWORK_PAGE_BYTES = 512_000
"""Largest page text admitted to the badge parser.

The HTTP client materializes the full response body before this check
runs, so the bound caps parse and cache work per response, not the
transfer or allocation size.
"""

MAX_IMAGE_URL_LENGTH = 512

BADGE_ARTWORK_POSITIVE_TTL_SECONDS = 6 * 3_600
BADGE_ARTWORK_NEGATIVE_TTL_SECONDS = 600
MAX_BADGE_ARTWORK_CACHE_ENTRIES = 512
BADGE_ARTWORK_COOLDOWN_SECONDS = 60.0
"""In-process cooldown after Steam signals rate limiting."""

DEFAULT_DONOR_STEAM_IDS: tuple[str, ...] = (
    "76561197960297143",
    "76561198021144472",
    "76561198834686512",
)
"""Public profiles whose game-card pages are used as read-only sources.

Each entry was verified public with card badges owned at the time this
module was authored.  Deployments may replace this list wholesale via the
``donor_steam_ids`` constructor argument; the provider degrades to an
explicit ``unavailable`` status whenever every donor is private or lacks
the game's badge.
"""

_BADGE_ARTWORK_APP_ID_ERROR = "badge_artwork_app_id_invalid"
_BADGE_ARTWORK_STEAM_ID_ERROR = "badge_artwork_steam_id_invalid"
_BADGE_ARTWORK_DONOR_ERROR = "badge_artwork_donor_ids_invalid"

_STEAM_ID_PATTERN = re.compile(r"^[0-9]{17}$")

_ALLOWED_IMAGE_HOSTS = frozenset(
    {
        "shared.fastly.steamstatic.com",
        "community.fastly.steamstatic.com",
        "shared.akamai.steamstatic.com",
        "community.akamai.steamstatic.com",
        "shared.cloudflare.steamstatic.com",
        "community.cloudflare.steamstatic.com",
        "steamcdn-a.akamaihd.net",
    }
)

_IMAGE_URL_PATTERN = re.compile(
    r"^https://(?P<host>[a-z0-9.-]+)/"
    r"(?P<kind>community_assets/images/items"
    r"|steamcommunity/public/images/items)/"
    r"(?P<appid>[0-9]+)/(?P<digest>[0-9a-f]{32,64})"
    r"\.(?P<ext>png|jpg|jpeg|webp)$"
)

_BADGE_CURRENT_PATTERN = re.compile(r'<div class="badge_current"')
_IMG_TAG_PATTERN = re.compile(r"<img\s[^>]*>")
_IMG_CLASS_PATTERN = re.compile(r'\bclass="([^"]*)"')
_IMG_SRC_PATTERN = re.compile(r'\bsrc="([^"]+)"')
_BADGE_INFO_TITLE_PATTERN = re.compile(r'<div class="badge_info_title">([^<]*)</div>')
_BADGE_TITLE_PATTERN = re.compile(r'<div class="badge_title">(.*?)</div>', re.DOTALL)
_BADGE_LEVEL_XP_PATTERN = re.compile(r"Level\s+([0-9]+)\s*,\s*([0-9,]+)\s*XP")

_BADGE_CURRENT_WINDOW_CHARS = 4_000
_BADGE_TITLE_WINDOW_CHARS = 3_000

_MIN_RETRY_AFTER_SECONDS = 1
_MAX_RETRY_AFTER_SECONDS = 3_600


class BadgeArtworkBadge(BaseModel):
    """One verified normal badge level: real name and real image URL."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    level: int = Field(ge=1, le=MAX_BADGE_LEVEL)
    name: str = Field(min_length=1, max_length=MAX_GAME_NAME_LENGTH)
    image_url: str = Field(min_length=1, max_length=MAX_IMAGE_URL_LENGTH)


class BadgeArtworkResponse(BaseModel):
    """Wire schema of ``GET /api/auth/badge-artwork/{app_id}``.

    ``ready`` carries the level verifiably published on the allowlisted
    public page; ``unavailable`` carries no badges and no source.
    ``source_url`` is the exact public page the level was read from, or
    ``None``.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    app_id: str = Field(pattern=r"^[0-9]+$", max_length=10)
    status: Literal["ready", "unavailable"]
    badges: list[BadgeArtworkBadge] = Field(max_length=MAX_BADGE_LEVEL)
    source_url: str | None = Field(
        default=None, min_length=1, max_length=MAX_IMAGE_URL_LENGTH
    )


def validate_artwork_app_id(app_id: int) -> None:
    """Reject anything outside the planner's AppID range."""

    if (
        not isinstance(app_id, int)
        or isinstance(app_id, bool)
        or not 1 <= app_id <= MAX_APP_ID
    ):
        raise ValueError(_BADGE_ARTWORK_APP_ID_ERROR)


def validate_artwork_steam_id(steam_id: str) -> None:
    """Reject non-canonical SteamIDs; artwork never uses the account."""

    if not isinstance(steam_id, str) or _STEAM_ID_PATTERN.fullmatch(steam_id) is None:
        raise ValueError(_BADGE_ARTWORK_STEAM_ID_ERROR)


def _validated_image_url(candidate: str, app_id: int) -> str | None:
    """Return ``candidate`` only when it is an allowlisted badge image."""

    if not isinstance(candidate, str) or not 1 <= len(candidate) <= (
        MAX_IMAGE_URL_LENGTH
    ):
        return None
    match = _IMAGE_URL_PATTERN.fullmatch(candidate)
    if match is None or match.group("host") not in _ALLOWED_IMAGE_HOSTS:
        return None
    if int(match.group("appid")) != app_id:
        return None
    return candidate


def _clean_text(candidate: str) -> str:
    return " ".join(unescape(candidate).split())


def _parse_gamecards_badge(page_text: str, app_id: int) -> BadgeArtworkBadge | None:
    """Extract the one normal badge level a game-card page displays.

    The page structure is the public one served by Steam Community for a
    profile that owns the badge: a ``badge_current`` block holding the
    badge icon, the level-specific title, and the ``Level N, M XP`` line.
    Event badges (levels above five), foil variants (never requested),
    non-badge imagery, and cross-app content all fail the strict checks
    and yield ``None``.
    """

    if not isinstance(page_text, str):
        return None
    current = _BADGE_CURRENT_PATTERN.search(page_text)
    if current is None:
        return None
    start = current.start()
    window = page_text[start : start + _BADGE_CURRENT_WINDOW_CHARS]

    image_url: str | None = None
    for tag_match in _IMG_TAG_PATTERN.finditer(window):
        tag = tag_match.group(0)
        class_match = _IMG_CLASS_PATTERN.search(tag)
        if class_match is None or "badge_icon" not in class_match.group(1).split():
            continue
        src_match = _IMG_SRC_PATTERN.search(tag)
        if src_match is not None:
            image_url = src_match.group(1)
        break

    level_match = _BADGE_LEVEL_XP_PATTERN.search(window)
    if image_url is None or level_match is None:
        return None
    level = int(level_match.group(1))
    if not 1 <= level <= MAX_BADGE_LEVEL:
        return None

    name = ""
    title_match = _BADGE_INFO_TITLE_PATTERN.search(window)
    if title_match is not None:
        name = _clean_text(title_match.group(1))
    if not name:
        head = page_text[max(0, start - _BADGE_TITLE_WINDOW_CHARS) : start]
        badge_title_match = _BADGE_TITLE_PATTERN.search(head)
        if badge_title_match is not None:
            raw_title = badge_title_match.group(1)
            name = _clean_text(re.sub(r"<[^>]+>", " ", raw_title))
    if not name or len(name) > MAX_GAME_NAME_LENGTH:
        return None

    safe_url = _validated_image_url(image_url, app_id)
    if safe_url is None:
        return None
    return BadgeArtworkBadge(level=level, name=name, image_url=safe_url)


@dataclass(frozen=True, slots=True)
class _CacheEntry:
    response: BadgeArtworkResponse
    expires_at: float


def _normalize_donor_ids(
    donor_steam_ids: Sequence[str] | None,
) -> tuple[str, ...]:
    """Validate, deduplicate and bound the configured donor profiles."""

    candidates = DEFAULT_DONOR_STEAM_IDS if donor_steam_ids is None else donor_steam_ids
    seen: dict[str, None] = {}
    for candidate in candidates:
        if (
            not isinstance(candidate, str)
            or _STEAM_ID_PATTERN.fullmatch(candidate) is None
            or candidate in seen
        ):
            raise ValueError(_BADGE_ARTWORK_DONOR_ERROR)
        seen[candidate] = None
        if len(seen) > MAX_DONOR_STEAM_IDS:
            raise ValueError(_BADGE_ARTWORK_DONOR_ERROR)
    if not seen:
        raise ValueError(_BADGE_ARTWORK_DONOR_ERROR)
    return tuple(seen)


def _unavailable_response(app_id: int) -> BadgeArtworkResponse:
    return BadgeArtworkResponse(
        app_id=str(app_id),
        status="unavailable",
        badges=[],
        source_url=None,
    )


def _page_within_bound(response: HTTPResponse) -> bool:
    """Refuse oversized page text so parsing stays bounded per response.

    The transport has already buffered the whole body when this runs;
    the bound caps parser and cache work, not download allocation.
    """

    raw_length = response.headers.get("content-length")
    if raw_length is not None and (
        not raw_length.isdigit() or int(raw_length) > MAX_ARTWORK_PAGE_BYTES
    ):
        return False
    return len(response.text) <= MAX_ARTWORK_PAGE_BYTES


def _bounded_retry_after(response: HTTPResponse) -> int:
    """Clamp Steam's ``Retry-After`` hint to a bounded positive value."""

    raw = response.headers.get("retry-after")
    if raw is None or not raw.isdigit():
        return _MIN_RETRY_AFTER_SECONDS
    return min(max(int(raw), _MIN_RETRY_AFTER_SECONDS), _MAX_RETRY_AFTER_SECONDS)


class BadgeArtworkService:
    """Bounded, cached resolver for one game's public badge artwork."""

    def __init__(
        self,
        settings: Settings,
        *,
        http_client: AsyncHTTPClient,
        limiter: SteamCommunityLimiter | None = None,
        donor_steam_ids: Sequence[str] | None = None,
    ) -> None:
        self.settings = settings
        self.http_client = http_client
        self.limiter = limiter or SteamCommunityLimiter()
        self.donor_steam_ids = _normalize_donor_ids(donor_steam_ids)
        self._cache: dict[int, _CacheEntry] = {}
        self._rate_limited_until = 0.0

    @staticmethod
    def _clock() -> float:
        return time.monotonic()

    async def check_badge_artwork(
        self, app_id: int, steam_id: str
    ) -> BadgeArtworkResponse:
        """Resolve artwork for ``app_id``; never uses account access.

        ``steam_id`` is validated for interface symmetry with the
        authenticated gateway boundary; the resolved artwork is public
        data and identical for every account.  Invalid input raises
        :class:`ValueError` with a stable reason; upstream trouble is
        reported as an explicit ``unavailable`` response, never raised.
        """

        validate_artwork_app_id(app_id)
        validate_artwork_steam_id(steam_id)

        now = self._clock()
        cached = self._cache.get(app_id)
        if cached is not None:
            if cached.expires_at > now:
                return cached.response
            del self._cache[app_id]
        if now < self._rate_limited_until:
            return _unavailable_response(app_id)

        response, transient = await self._resolve(app_id)
        if not transient:
            self._store(app_id, response)
        return response

    async def _resolve(self, app_id: int) -> tuple[BadgeArtworkResponse, bool]:
        """Walk donors in order; stop at the first published level.

        Returns the response and whether the failure was transient (a
        rate-limited or otherwise sick provider).  Transient results are
        never cached: the next call retries upstream after the cooldown.
        """

        for donor_steam_id in self.donor_steam_ids:
            page, transient = await self._fetch_gamecards_page(app_id, donor_steam_id)
            if transient:
                return _unavailable_response(app_id), True
            if page is None:
                continue
            badge = _parse_gamecards_badge(page, app_id)
            if badge is None:
                continue
            return (
                BadgeArtworkResponse(
                    app_id=str(app_id),
                    status="ready",
                    badges=[badge],
                    source_url=self._gamecards_url(app_id, donor_steam_id),
                ),
                False,
            )
        return _unavailable_response(app_id), False

    def _gamecards_url(self, app_id: int, steam_id: str) -> str:
        return GAMECARDS_URL_TEMPLATE.format(steam_id=steam_id, app_id=app_id)

    async def _fetch_gamecards_page(
        self, app_id: int, steam_id: str
    ) -> tuple[str | None, bool]:
        """Fetch one public game-card page through the shared limiter."""

        url = self._gamecards_url(app_id, steam_id)

        async def operation() -> HTTPResponse:
            try:
                response = await self.http_client.get(
                    url,
                    params={"l": "english"},
                    headers={
                        "User-Agent": STEAM_OPTIMIZER_USER_AGENT,
                        "Accept": "text/html,application/xhtml+xml",
                    },
                    follow_redirects=False,
                    timeout=self.settings.steam_request_timeout_seconds,
                )
            except (
                httpx2.HTTPError,
                OSError,
                TimeoutError,
                RuntimeError,
            ) as error:
                raise ValueError from error
            if response.status_code == 429:
                self._rate_limited_until = (
                    self._clock() + BADGE_ARTWORK_COOLDOWN_SECONDS
                )
                raise _CommunityRateLimitedError(_bounded_retry_after(response))
            return response

        try:
            response = await self.limiter.run(operation)
        except Exception:  # noqa: BLE001 - artwork fails closed, isolated
            return None, True

        if response.status_code != 200:
            # A redirect means the donor hides the badge or does not own
            # it; other client errors are the same honest miss for this
            # donor.  Only server-side sickness is treated as transient.
            return None, 500 <= response.status_code <= 599
        if not _page_within_bound(response):
            return None, False
        return response.text, False

    def _store(self, app_id: int, response: BadgeArtworkResponse) -> None:
        ttl = (
            BADGE_ARTWORK_POSITIVE_TTL_SECONDS
            if response.status == "ready"
            else BADGE_ARTWORK_NEGATIVE_TTL_SECONDS
        )
        self._cache[app_id] = _CacheEntry(
            response=response, expires_at=self._clock() + ttl
        )
        while len(self._cache) > MAX_BADGE_ARTWORK_CACHE_ENTRIES:
            del self._cache[next(iter(self._cache))]
