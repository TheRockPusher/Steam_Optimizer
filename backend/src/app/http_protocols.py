from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Mapping
    from contextlib import AbstractAsyncContextManager


class HTTPResponse(Protocol):
    status_code: int

    @property
    def headers(self) -> Mapping[str, str]:
        """Return response headers with case-insensitive keys."""
        ...

    @property
    def text(self) -> str:
        """Return the decoded response body."""
        ...

    def json(self) -> object:
        """Decode the response body as JSON."""
        ...

    def aiter_bytes(self, chunk_size: int | None = None) -> AsyncIterator[bytes]:
        """Yield response bytes without materializing the body."""
        ...


class AsyncHTTPClient(Protocol):
    async def get(
        self,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        follow_redirects: bool = False,
        timeout: float | None = None,  # noqa: ASYNC109
    ) -> HTTPResponse:
        """Issue an asynchronous GET request."""
        ...

    def stream(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        follow_redirects: bool = False,
        timeout: float | None = None,
    ) -> AbstractAsyncContextManager[HTTPResponse]:
        """Open a response stream without loading its body."""
        ...

    async def post(
        self,
        url: str,
        *,
        data: Mapping[str, str],
    ) -> HTTPResponse:
        """Issue an asynchronous form POST request."""
        ...
