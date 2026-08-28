from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, cast

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator, Awaitable, Callable

import httpx2
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth_routes import Clock, create_auth_router
from app.settings import Settings, get_settings
from app.steam_gateway import SteamGateway, SteamGatewayProtocol
from app.steam_openid import SteamOpenIDClient, SteamOpenIDVerifier


def _lifecycle_method(
    gateway: object, name: str
) -> Callable[[], Awaitable[None]] | None:
    method = getattr(gateway, name, None)
    if not callable(method):
        return None
    return cast("Callable[[], Awaitable[None]]", method)


def create_app(
    settings: Settings | None = None,
    *,
    steam_gateway: SteamGatewayProtocol | None = None,
    openid_verifier: SteamOpenIDVerifier | None = None,
    clock: Clock | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    normal_client: httpx2.AsyncClient | None = None
    bulk_client: httpx2.AsyncClient | None = None
    if steam_gateway is None or openid_verifier is None:
        normal_client = httpx2.AsyncClient(
            timeout=settings.steam_request_timeout_seconds,
        )
    if steam_gateway is None:
        bulk_client = httpx2.AsyncClient(
            timeout=settings.steam_bulk_timeout_seconds,
        )

    gateway: SteamGatewayProtocol
    if steam_gateway is None:
        if normal_client is None:
            raise RuntimeError
        gateway = SteamGateway(
            settings,
            http_client=normal_client,
            bulk_http_client=bulk_client,
            bulk_timeout_seconds=settings.steam_bulk_timeout_seconds,
        )
    else:
        gateway = steam_gateway

    verifier: SteamOpenIDVerifier
    if openid_verifier is None:
        if normal_client is None:
            raise RuntimeError
        verifier = SteamOpenIDClient(http_client=normal_client)
    else:
        verifier = openid_verifier

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
        start = _lifecycle_method(gateway, "start")
        stop = _lifecycle_method(gateway, "stop")
        try:
            if start is not None:
                await start()
            yield
        finally:
            try:
                if stop is not None:
                    await stop()
            finally:
                try:
                    if bulk_client is not None:
                        await bulk_client.aclose()
                finally:
                    if normal_client is not None:
                        await normal_client.aclose()

    application = FastAPI(title=settings.app, lifespan=lifespan)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @application.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    application.include_router(
        create_auth_router(
            settings,
            steam_gateway=gateway,
            openid_verifier=verifier,
            clock=clock,
        )
    )
    return application


app = create_app()
