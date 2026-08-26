from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from collections.abc import Mapping


class HTTPResponse(Protocol):
    status_code: int

    @property
    def text(self) -> str:
        """Return the decoded response body."""
        ...

    def json(self) -> object:
        """Decode the response body as JSON."""
        ...


class AsyncHTTPClient(Protocol):
    async def get(
        self,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
    ) -> HTTPResponse:
        """Issue an asynchronous GET request."""
        ...

    async def post(
        self,
        url: str,
        *,
        data: Mapping[str, str],
    ) -> HTTPResponse:
        """Issue an asynchronous form POST request."""
        ...
