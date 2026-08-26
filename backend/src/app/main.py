from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

import httpx2
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth_routes import Clock, create_auth_router
from app.settings import Settings, get_settings
from app.steam_gateway import SteamGateway, SteamGatewayProtocol
from app.steam_openid import SteamOpenIDClient, SteamOpenIDVerifier


def create_app(
    settings: Settings | None = None,
    *,
    steam_gateway: SteamGatewayProtocol | None = None,
    openid_verifier: SteamOpenIDVerifier | None = None,
    clock: Clock | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    shared_client: httpx2.AsyncClient | None = None
    if steam_gateway is None or openid_verifier is None:
        shared_client = httpx2.AsyncClient(
            timeout=settings.steam_request_timeout_seconds
        )

    gateway: SteamGatewayProtocol
    if steam_gateway is None:
        if shared_client is None:
            raise RuntimeError
        gateway = SteamGateway(settings, http_client=shared_client)
    else:
        gateway = steam_gateway

    verifier: SteamOpenIDVerifier
    if openid_verifier is None:
        if shared_client is None:
            raise RuntimeError
        verifier = SteamOpenIDClient(http_client=shared_client)
    else:
        verifier = openid_verifier

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
        try:
            yield
        finally:
            if shared_client is not None:
                await shared_client.aclose()

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
