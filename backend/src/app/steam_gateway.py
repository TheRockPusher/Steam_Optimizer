from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Literal, Protocol
from urllib.parse import quote

import httpx2
from pydantic import BaseModel

if TYPE_CHECKING:
    from app.http_protocols import AsyncHTTPClient
    from app.settings import Settings

PROFILE_ENDPOINT = "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/"
INVENTORY_ENDPOINT = "https://steamcommunity.com/inventory"
_PRIVATE_INVENTORY_ERRORS = frozenset(
    {
        "This inventory is private",
        "This inventory is private.",
        "This profile is private",
        "This profile is private.",
    }
)

CheckStatus = Literal["public", "private", "unavailable"]


class CheckResult(BaseModel):
    status: CheckStatus
    message: str


class ProfileCheck(CheckResult):
    display_name: str | None = None
    avatar_url: str | None = None


class InventoryCheck(CheckResult):
    pass


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


class SteamGateway:
    """Read-only boundary for Steam profile and inventory visibility checks."""

    def __init__(self, settings: Settings, *, http_client: AsyncHTTPClient) -> None:
        self.settings = settings
        self.http_client = http_client

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
        url = f"{INVENTORY_ENDPOINT}/{quote(steam_id, safe='')}/753/6"
        try:
            response = await self.http_client.get(
                url,
                params={"l": "english", "count": "1"},
            )
        except httpx2.HTTPError:
            return InventoryCheck(
                status="unavailable",
                message="Steam inventory is unavailable.",
            )

        status_code = response.status_code
        if status_code == 403:
            return InventoryCheck(
                status="private",
                message="Steam inventory is private.",
            )
        if status_code != 200:
            if 400 <= status_code < 500 and status_code != 429:
                try:
                    payload = response.json()
                except ValueError:
                    payload = None
                if isinstance(payload, Mapping) and _is_private_inventory_error(
                    payload
                ):
                    return InventoryCheck(
                        status="private",
                        message="Steam inventory is private.",
                    )
            return InventoryCheck(
                status="unavailable",
                message="Steam inventory is unavailable.",
            )

        try:
            payload = response.json()
        except ValueError:
            return InventoryCheck(
                status="unavailable",
                message="Steam inventory data is unavailable.",
            )
        if not isinstance(payload, Mapping):
            return InventoryCheck(
                status="unavailable",
                message="Steam inventory data is unavailable.",
            )
        if _is_integer(payload.get("success")) and payload.get("success") == 1:
            return InventoryCheck(
                status="public",
                message="Steam inventory is public.",
            )
        if _is_private_inventory_error(payload):
            return InventoryCheck(
                status="private",
                message="Steam inventory is private.",
            )
        return InventoryCheck(
            status="unavailable",
            message="Steam inventory data is unavailable.",
        )
