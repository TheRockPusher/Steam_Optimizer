from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable

    import pytest

from fastapi.testclient import TestClient

from app import main as main_module
from app.booster_pricing import BoosterScanResult
from app.gem_pricing import GemKey, GemScanResult
from app.level_up_optimizer import LevelUpOptimizationResponse
from app.main import app, create_app
from app.settings import Settings
from app.steam_gateway import BadgeCheck, InventoryCheck, ProfileCheck


class LifecycleGateway:
    def __init__(self, events: list[str]) -> None:
        self.events = events

    async def start(self) -> None:
        self.events.append("gateway-start")

    async def stop(self) -> None:
        self.events.append("gateway-stop")

    async def check_profile(self, steam_id: str) -> ProfileCheck:
        del steam_id
        return ProfileCheck(status="unavailable", message="unused")

    async def check_badges(self, steam_id: str) -> BadgeCheck:
        del steam_id
        return BadgeCheck(
            status="unavailable",
            message="unused",
        )

    async def check_inventory(self, steam_id: str) -> InventoryCheck:
        del steam_id
        return InventoryCheck(status="unavailable", message="unused")

    async def check_level_up(
        self,
        holdings: object,
        game_metadata: object,
        badge_state: object,
        inventory_refreshed_at: object,
        badge_refreshed_at: object,
        *,
        now: object = None,
    ) -> LevelUpOptimizationResponse:
        del holdings
        del game_metadata
        del badge_state
        del inventory_refreshed_at
        del badge_refreshed_at
        del now
        return LevelUpOptimizationResponse(
            status="unavailable",
            reason="badge_data_unavailable",
            generated_at=datetime.now(UTC),
            inventory_refreshed_at=datetime.now(UTC),
        )

    async def refresh_gems(
        self,
        keys: Iterable[GemKey],
    ) -> GemScanResult:
        del keys
        return GemScanResult(values={})

    async def refresh_boosters(
        self,
        game_app_ids: Iterable[str],
    ) -> BoosterScanResult:
        del game_app_ids
        return BoosterScanResult(values={})


class LifecycleHttpClient:
    def __init__(self, events: list[str], **kwargs: object) -> None:
        del kwargs
        self.events = events

    async def aclose(self) -> None:
        self.events.append("client-close")


def test_health_endpoint_returns_ok() -> None:
    with TestClient(app) as client:
        response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_lifespan_stops_gateway_before_clients_close(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    gateway = LifecycleGateway(events)
    monkeypatch.setattr(
        main_module.httpx2,
        "AsyncClient",
        lambda **kwargs: LifecycleHttpClient(events, **kwargs),
    )
    development_signing_value = "test-signing-secret"
    settings = Settings(
        environment="development",
        signing_secret=development_signing_value,
    )
    application = create_app(settings, steam_gateway=gateway)

    with TestClient(application) as client:
        assert client.get("/api/health").json() == {"status": "ok"}

    assert events == ["gateway-start", "gateway-stop", "client-close"]
