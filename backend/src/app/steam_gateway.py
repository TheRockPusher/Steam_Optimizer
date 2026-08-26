from __future__ import annotations

import asyncio
import math
import re
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import TYPE_CHECKING, Literal, Protocol
from urllib.parse import quote

import httpx2
from pydantic import BaseModel

if TYPE_CHECKING:
    from app.http_protocols import AsyncHTTPClient, HTTPResponse
    from app.settings import Settings

PROFILE_ENDPOINT = "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/"
INVENTORY_ENDPOINT = "https://steamcommunity.com/inventory"

# These are deliberately process-local policy values. They are not deployment
# settings: changing them changes the behavior of every inventory check in a
# process.
INVENTORY_SUCCESS_CACHE_TTL_SECONDS = 300
INVENTORY_CHECK_COOLDOWN_SECONDS = 30
INVENTORY_MAX_UPSTREAM_ATTEMPTS = 3
INVENTORY_FALLBACK_RETRY_DELAYS_SECONDS = (1.0, 2.0)
INVENTORY_MAX_INLINE_SLEEP_SECONDS = 5.0
INVENTORY_MAX_INLINE_RETRY_BUDGET_SECONDS = 5.0
INVENTORY_MAX_USER_COOLDOWN_SECONDS = 900
INVENTORY_MAX_STEAM_IDS = 1024
INVENTORY_LOCK_STRIPES = 64

_ASCII_DIGITS = re.compile(r"^[0-9]+$")
_RFC850_DATE = re.compile(
    r"^[A-Za-z]+,\s+\d{2}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+GMT$"
)
_PRIVATE_INVENTORY_ERRORS = frozenset(
    {
        "This inventory is private",
        "This inventory is private.",
        "This profile is private",
        "This profile is private.",
    }
)

CheckStatus = Literal["public", "private", "unavailable"]
UTCClock = Callable[[], datetime]
MonotonicClock = Callable[[], float]
AsyncSleep = Callable[[float], Awaitable[None]]


class CheckResult(BaseModel):
    status: CheckStatus
    message: str


class ProfileCheck(CheckResult):
    display_name: str | None = None
    avatar_url: str | None = None


class InventoryCheck(CheckResult):
    retry_after_seconds: int | None = None
    rate_limited: bool = False


class SteamGatewayProtocol(Protocol):
    async def check_profile(self, steam_id: str) -> ProfileCheck:
        """Check whether a Steam profile is publicly visible."""
        ...

    async def check_inventory(self, steam_id: str) -> InventoryCheck:
        """Check whether a Steam inventory is publicly visible."""
        ...


def _text_or_none(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _is_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_private_inventory_error(value: Mapping[str, object]) -> bool:
    """Recognize Steam's documented top-level private-inventory response."""

    error = value.get("Error")
    return isinstance(error, str) and error in _PRIVATE_INVENTORY_ERRORS


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def parse_retry_after(value: str | None, *, now: datetime) -> float | None:
    """Parse an RFC 9110 Retry-After value into seconds from ``now``."""

    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if not candidate:
        return None
    if _ASCII_DIGITS.fullmatch(candidate):
        try:
            return float(int(candidate))
        except (OverflowError, ValueError):
            return math.inf
    try:
        retry_at = parsedate_to_datetime(candidate)
    except (TypeError, ValueError, OverflowError):
        return None
    now_utc = _as_utc(now)
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=UTC)
    else:
        retry_at = retry_at.astimezone(UTC)
    if _RFC850_DATE.fullmatch(candidate):
        try:
            fifty_year_cutoff = now_utc.replace(year=now_utc.year - 50)
        except ValueError:
            fifty_year_cutoff = now_utc.replace(
                year=now_utc.year - 50,
                day=28,
            )
        if retry_at < fifty_year_cutoff:
            retry_at = retry_at.replace(year=retry_at.year + 100)
    delay = (retry_at - now_utc).total_seconds()
    return max(0.0, delay)


@dataclass(frozen=True, slots=True)
class _InventoryOutcome:
    result: InventoryCheck
    cooldown_seconds: float | None = None
    rate_limited: bool = False
    cacheable: bool = False


@dataclass(slots=True)
class _InventoryState:
    cooldown_deadline: float
    cooldown_result: InventoryCheck
    rate_limited: bool
    pending: bool = False
    cache_result: InventoryCheck | None = None
    cache_deadline: float | None = None


class SteamGateway:
    """Read-only boundary for Steam profile and inventory visibility checks."""

    def __init__(
        self,
        settings: Settings,
        *,
        http_client: AsyncHTTPClient,
        monotonic_clock: MonotonicClock | None = None,
        utc_clock: UTCClock | None = None,
        sleep: AsyncSleep | None = None,
    ) -> None:
        self.settings = settings
        self.http_client = http_client
        self._monotonic_clock = monotonic_clock or time.monotonic
        self._utc_clock = utc_clock or _utc_now
        self._sleep = sleep or asyncio.sleep
        self._inventory_states: OrderedDict[str, _InventoryState] = OrderedDict()
        self._inventory_admission_deadline = 0.0
        self._inventory_lock_stripes = tuple(
            asyncio.Lock() for _ in range(INVENTORY_LOCK_STRIPES)
        )

    async def check_profile(self, steam_id: str) -> ProfileCheck:
        api_key = self.settings.steam_web_api_key
        if not api_key or not api_key.strip():
            return ProfileCheck(
                status="unavailable",
                message=(
                    "Steam profile API is unavailable because no API key is configured."
                ),
            )
        try:
            response = await self.http_client.get(
                PROFILE_ENDPOINT,
                params={
                    "key": api_key,
                    "steamids": steam_id,
                },
            )
        except httpx2.HTTPError:
            return ProfileCheck(
                status="unavailable",
                message="Steam profile API is unavailable.",
            )
        if not 200 <= response.status_code < 300:
            return ProfileCheck(
                status="unavailable",
                message="Steam profile API returned an unavailable response.",
            )
        try:
            payload = response.json()
        except ValueError:
            return ProfileCheck(
                status="unavailable",
                message="Steam profile data is unavailable.",
            )
        response_data = (
            payload.get("response") if isinstance(payload, Mapping) else None
        )
        players = (
            response_data.get("players") if isinstance(response_data, Mapping) else None
        )
        if (
            not isinstance(players, list)
            or not players
            or not isinstance(players[0], Mapping)
        ):
            return ProfileCheck(
                status="unavailable",
                message="Steam profile data is unavailable.",
            )
        player = players[0]
        display_name = _text_or_none(player.get("personaname"))
        avatar_url = _text_or_none(player.get("avatarfull"))
        visibility = player.get("communityvisibilitystate")
        if not _is_integer(visibility):
            return ProfileCheck(
                status="unavailable",
                message="Steam profile visibility data is unavailable.",
                display_name=display_name,
                avatar_url=avatar_url,
            )
        if visibility == 3:
            return ProfileCheck(
                status="public",
                message="Steam profile is public.",
                display_name=display_name,
                avatar_url=avatar_url,
            )
        if visibility in (1, 2):
            return ProfileCheck(
                status="private",
                message="Steam profile is not public.",
                display_name=display_name,
                avatar_url=avatar_url,
            )
        return ProfileCheck(
            status="unavailable",
            message="Steam profile visibility data is unavailable.",
            display_name=display_name,
            avatar_url=avatar_url,
        )

    async def check_inventory(self, steam_id: str) -> InventoryCheck:
        lock = self._inventory_lock_stripes[
            hash(steam_id) % len(self._inventory_lock_stripes)
        ]
        async with lock:
            now = self._monotonic_clock()
            self._prune_inventory_states(now)
            state = self._inventory_states.get(steam_id)
            if state is not None:
                self._inventory_states.move_to_end(steam_id)
                if now < state.cooldown_deadline:
                    return self._during_cooldown(state, now)
                if (
                    state.cache_result is not None
                    and state.cache_deadline is not None
                    and now < state.cache_deadline
                ):
                    return state.cache_result.model_copy(
                        update={"retry_after_seconds": None}
                    )
                state.cache_result = None
                state.cache_deadline = None
            if state is None and now < self._inventory_admission_deadline:
                return self._busy_inventory_result(
                    self._remaining_seconds(
                        self._inventory_admission_deadline,
                        now,
                    )
                )
            if state is None and len(self._inventory_states) >= INVENTORY_MAX_STEAM_IDS:
                self._inventory_admission_deadline = (
                    now + INVENTORY_CHECK_COOLDOWN_SECONDS
                )
                return self._busy_inventory_result(INVENTORY_CHECK_COOLDOWN_SECONDS)

            reservation: _InventoryState | None = None
            if state is None:
                reservation_result = self._busy_inventory_result(
                    INVENTORY_CHECK_COOLDOWN_SECONDS
                ).model_copy(update={"retry_after_seconds": None})
                reservation = _InventoryState(
                    cooldown_deadline=(now + INVENTORY_CHECK_COOLDOWN_SECONDS),
                    cooldown_result=reservation_result,
                    rate_limited=False,
                    pending=True,
                )
                self._remember_inventory_state(steam_id, reservation)

            try:
                outcome = await self._fetch_inventory(steam_id)
            except BaseException:
                if (
                    reservation is not None
                    and self._inventory_states.get(steam_id) is reservation
                ):
                    del self._inventory_states[steam_id]
                raise
            completed_at = self._monotonic_clock()
            cooldown_seconds = self._bounded_cooldown_seconds(outcome.cooldown_seconds)
            cooldown_deadline = completed_at + cooldown_seconds
            stored_result = outcome.result.model_copy(
                update={
                    "retry_after_seconds": None,
                    "rate_limited": outcome.rate_limited,
                }
            )
            state = _InventoryState(
                cooldown_deadline=cooldown_deadline,
                cooldown_result=stored_result,
                rate_limited=outcome.rate_limited,
                cache_result=(stored_result if outcome.cacheable else None),
                cache_deadline=(
                    completed_at + INVENTORY_SUCCESS_CACHE_TTL_SECONDS
                    if outcome.cacheable
                    else None
                ),
            )
            self._prune_inventory_states(completed_at)
            self._remember_inventory_state(steam_id, state)
            retry_after_seconds = self._remaining_seconds(
                cooldown_deadline,
                completed_at,
            )
            return self._format_result(
                stored_result,
                retry_after_seconds,
                rate_limited=outcome.rate_limited,
            )

    async def _fetch_inventory(self, steam_id: str) -> _InventoryOutcome:
        url = f"{INVENTORY_ENDPOINT}/{quote(steam_id, safe='')}/753/6"
        retry_budget = 0.0
        for attempt in range(INVENTORY_MAX_UPSTREAM_ATTEMPTS):
            try:
                response = await self.http_client.get(
                    url,
                    params={"l": "english", "count": "1"},
                )
            except httpx2.DecodingError:
                return _InventoryOutcome(self._unavailable_inventory_result())
            except httpx2.RequestError:
                if attempt + 1 >= INVENTORY_MAX_UPSTREAM_ATTEMPTS:
                    return _InventoryOutcome(self._unavailable_inventory_result())
                delay = INVENTORY_FALLBACK_RETRY_DELAYS_SECONDS[attempt]
                if not self._can_sleep(delay, retry_budget):
                    return _InventoryOutcome(self._unavailable_inventory_result())
                retry_budget += delay
                await self._sleep_if_needed(delay)
                continue

            status_code = response.status_code
            if status_code == 200:
                return self._parse_inventory_success(response)
            if status_code == 403:
                return _InventoryOutcome(
                    InventoryCheck(
                        status="private",
                        message="Steam inventory is private.",
                    )
                )
            if status_code == 429 or 500 <= status_code <= 599:
                retry_after = self._retry_after_delay(response)
                if attempt + 1 < INVENTORY_MAX_UPSTREAM_ATTEMPTS:
                    delay = (
                        retry_after
                        if retry_after is not None
                        else INVENTORY_FALLBACK_RETRY_DELAYS_SECONDS[attempt]
                    )
                    if self._can_sleep(delay, retry_budget):
                        retry_budget += delay
                        await self._sleep_if_needed(delay)
                        continue
                cooldown_seconds = self._bounded_cooldown_seconds(retry_after)
                if status_code == 429:
                    return _InventoryOutcome(
                        self._rate_limited_inventory_result(cooldown_seconds),
                        cooldown_seconds=cooldown_seconds,
                        rate_limited=True,
                    )
                return _InventoryOutcome(
                    self._unavailable_inventory_result(
                        retry_after_seconds=cooldown_seconds
                    ),
                    cooldown_seconds=cooldown_seconds,
                )
            if 400 <= status_code < 500:
                try:
                    payload = response.json()
                except ValueError:
                    payload = None
                if isinstance(payload, Mapping) and _is_private_inventory_error(
                    payload
                ):
                    return _InventoryOutcome(
                        InventoryCheck(
                            status="private",
                            message="Steam inventory is private.",
                        )
                    )
            return _InventoryOutcome(self._unavailable_inventory_result())

        raise AssertionError

    def _parse_inventory_success(self, response: HTTPResponse) -> _InventoryOutcome:
        try:
            payload = response.json()
        except ValueError:
            return _InventoryOutcome(self._unavailable_inventory_result())
        if not isinstance(payload, Mapping):
            return _InventoryOutcome(self._unavailable_inventory_result())
        if _is_integer(payload.get("success")) and payload.get("success") == 1:
            return _InventoryOutcome(
                InventoryCheck(
                    status="public",
                    message="Steam inventory is public.",
                ),
                cacheable=True,
            )
        if _is_private_inventory_error(payload):
            return _InventoryOutcome(
                InventoryCheck(
                    status="private",
                    message="Steam inventory is private.",
                )
            )
        return _InventoryOutcome(self._unavailable_inventory_result())

    def _retry_after_delay(self, response: HTTPResponse) -> float | None:
        headers = getattr(response, "headers", None)
        if not isinstance(headers, Mapping):
            return None
        value: object = None
        for key, candidate in headers.items():
            if isinstance(key, str) and key.lower() == "retry-after":
                value = candidate
                break
        if not isinstance(value, str):
            return None
        return parse_retry_after(value, now=self._utc_clock())

    @staticmethod
    def _can_sleep(delay: float, retry_budget: float) -> bool:
        return (
            math.isfinite(delay)
            and 0 <= delay <= INVENTORY_MAX_INLINE_SLEEP_SECONDS
            and retry_budget + delay <= INVENTORY_MAX_INLINE_RETRY_BUDGET_SECONDS
        )

    async def _sleep_if_needed(self, delay: float) -> None:
        if delay > 0:
            await self._sleep(delay)

    @staticmethod
    def _bounded_cooldown_seconds(delay: float | None) -> int:
        if delay is None:
            return INVENTORY_CHECK_COOLDOWN_SECONDS
        if not math.isfinite(delay):
            return INVENTORY_MAX_USER_COOLDOWN_SECONDS
        return min(
            INVENTORY_MAX_USER_COOLDOWN_SECONDS,
            max(INVENTORY_CHECK_COOLDOWN_SECONDS, math.ceil(delay)),
        )

    @staticmethod
    def _remaining_seconds(deadline: float, now: float) -> int:
        return max(0, math.ceil(max(0.0, deadline - now)))

    @staticmethod
    def _format_result(
        result: InventoryCheck,
        retry_after_seconds: int,
        *,
        rate_limited: bool,
    ) -> InventoryCheck:
        updates: dict[str, object] = {
            "retry_after_seconds": retry_after_seconds,
            "rate_limited": rate_limited,
        }
        if rate_limited:
            updates["message"] = (
                "Steam is temporarily limiting inventory checks. "
                f"Try again in {retry_after_seconds} seconds."
            )
        return result.model_copy(update=updates)

    def _during_cooldown(self, state: _InventoryState, now: float) -> InventoryCheck:
        retry_after_seconds = self._remaining_seconds(state.cooldown_deadline, now)
        return self._format_result(
            state.cooldown_result,
            retry_after_seconds,
            rate_limited=state.rate_limited,
        )

    def _remember_inventory_state(self, steam_id: str, state: _InventoryState) -> None:
        if (
            steam_id not in self._inventory_states
            and len(self._inventory_states) >= INVENTORY_MAX_STEAM_IDS
        ):
            return
        self._inventory_states[steam_id] = state
        self._inventory_states.move_to_end(steam_id)

    def _prune_inventory_states(self, now: float) -> None:
        expired_ids = [
            steam_id
            for steam_id, state in self._inventory_states.items()
            if not state.pending
            and now
            >= max(
                state.cooldown_deadline,
                state.cache_deadline or state.cooldown_deadline,
            )
        ]
        for steam_id in expired_ids:
            del self._inventory_states[steam_id]

    @staticmethod
    def _unavailable_inventory_result(
        *, retry_after_seconds: int | None = None
    ) -> InventoryCheck:
        return InventoryCheck(
            status="unavailable",
            message="Steam inventory is unavailable.",
            retry_after_seconds=retry_after_seconds,
        )

    @staticmethod
    def _busy_inventory_result(retry_after_seconds: int) -> InventoryCheck:
        return InventoryCheck(
            status="unavailable",
            message=(
                "Inventory checks are temporarily busy. "
                f"Try again in {retry_after_seconds} seconds."
            ),
            retry_after_seconds=retry_after_seconds,
        )

    @staticmethod
    def _rate_limited_inventory_result(
        retry_after_seconds: int,
    ) -> InventoryCheck:
        return InventoryCheck(
            status="unavailable",
            message=(
                "Steam is temporarily limiting inventory checks. "
                f"Try again in {retry_after_seconds} seconds."
            ),
            retry_after_seconds=retry_after_seconds,
            rate_limited=True,
        )
