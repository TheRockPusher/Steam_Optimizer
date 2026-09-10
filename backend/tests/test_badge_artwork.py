"""Behavioral tests for the first-party public badge artwork provider.

Every upstream fixture below is a verbatim fragment of a real public
Steam Community game-card page recorded while researching this feature
(RUSSIAPHOBIA app 1184160 at level 1, LYNE app 266010 at level 5, and
the Steam Awards event page for app 1195670 whose badge level lies above
the normal 1-5 range and must be rejected).  Synthesized variants are
limited to surgical edits of those real fragments.  The tests pin the
provider's honest semantics: only allowlisted origins, only verified
levels, bounded requests, explicit unavailability, and caching.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

import pytest
from httpx2 import Response

from app.badge_artwork import (
    GAMECARDS_URL_TEMPLATE,
    MAX_ARTWORK_PAGE_BYTES,
    STEAM_OPTIMIZER_USER_AGENT,
    BadgeArtworkService,
)
from app.gem_pricing import SteamCommunityLimiter
from app.settings import Settings

if TYPE_CHECKING:
    from collections.abc import (
        Awaitable,
        Callable,
        Coroutine,
        Mapping,
        Sequence,
    )
    from contextlib import AbstractAsyncContextManager


DONOR_ONE = "76561197960297143"
DONOR_TWO = "76561198021144472"
DONOR_THREE = "76561198834686512"
DEFAULT_DONORS = (DONOR_ONE, DONOR_TWO, DONOR_THREE)
APP_ID = 1184160
LYNE_APP_ID = 266010
EVENT_APP_ID = 1195670
STEAM_ID = "76561198000000001"

RUSSIAPHOBIA_IMAGE_URL = (
    "https://shared.fastly.steamstatic.com/community_assets/images/items/"
    "1184160/9e20a4b3a3afbdab1e13e3dbb368bac73c6ca656.png"
)
LYNE_IMAGE_URL = (
    "https://shared.fastly.steamstatic.com/community_assets/images/items/"
    "266010/a0ab14dbd41c3a19148c797690aa10979eaa91c6.png"
)

STEAM_AWARDS_IMAGE_URL = (
    "https://shared.fastly.steamstatic.com/community_assets/images/items/"
    "1195670/f2b1a247f7ddb712967eceedb370c48eb56d01c1.png"
)

# Verbatim public game-card page regions recorded 2026-09-08.  The img
# src attributes are interpolated from the recorded URL constants, so
# the rendered strings stay byte-identical to the captured pages.
RUSSIAPHOBIA_LEVEL_ONE_PAGE = f"""
<div class="badge_title_row">
    <div class="badge_title_stats">
        <div class="badge_title_stats_playtime">
            &nbsp;
            0.5 hrs on record
        </div>
        <div class="badge_title_stats_drops">
        </div>
    </div>
    <div class="badge_title">
        RUSSIAPHOBIA Badge
    </div>
</div>
<div class="badge_title_rule"></div>
<div class="badge_content gamecard_details">
    <div class="badge_current">
        <div class="badge_info">
            <div class="badge_info_image">
                <img src="{RUSSIAPHOBIA_IMAGE_URL}" class="badge_icon">
            </div>
            <div class="badge_info_description">
                <div class="badge_info_title">Hype Girl</div>
                <div>
                    Level 1, 100 XP
                </div>
                <div class="badge_info_unlocked">
                    Unlocked 2 Jan @ 2:28am
                </div>
"""

LYNE_LEVEL_FIVE_PAGE = f"""
<div class="badge_title_row">
    <div class="badge_title_stats">
        <div class="badge_title_stats_playtime">
            &nbsp;
            3.3 hrs on record
        </div>
        <div class="badge_title_stats_drops">
        </div>
    </div>
    <div class="badge_title">
        LYNE Badge
    </div>
</div>
<div class="badge_title_rule"></div>
<div class="badge_content gamecard_details">
    <div class="badge_current">
        <div class="badge_info">
            <div class="badge_info_image">
                <img src="{LYNE_IMAGE_URL}" class="badge_icon">
            </div>
            <div class="badge_info_description">
                <div class="badge_info_title">Intersect</div>
                <div>
                    Level 5, 500 XP
                </div>
                <div class="badge_info_unlocked">
                    Unlocked 29 Dec, 2022 @ 12:18pm
                </div>
"""

STEAM_AWARDS_EVENT_PAGE = f"""
<div class="badge_title_row">
    <div class="badge_title_stats">
        <div class="badge_title_stats_playtime">
            &nbsp;
        </div>
        <div class="badge_title_stats_drops">
        </div>
    </div>
    <div class="badge_title">
        The Steam Awards - 2019 Badge
    </div>
</div>
<div class="badge_title_rule"></div>
<div class="badge_content gamecard_details">
    <div class="badge_current">
        <div class="badge_info">
            <div class="badge_info_image">
                <img src="{STEAM_AWARDS_IMAGE_URL}" class="badge_icon">
            </div>
            <div class="badge_info_description">
                <div class="badge_info_title">Steam Awards 2019 - 25+</div>
                <div>
                    Level 26, 2,600 XP
                </div>
                <div class="badge_info_unlocked">
                    Unlocked 2 Jan, 2020 @ 8:32am
                </div>
"""

PAGE_WITHOUT_LEVEL_TITLE = RUSSIAPHOBIA_LEVEL_ONE_PAGE.replace(
    '<div class="badge_info_title">Hype Girl</div>', ""
)
PAGE_WITH_ENTITIES = RUSSIAPHOBIA_LEVEL_ONE_PAGE.replace("Hype Girl", "Hype &amp; Girl")


def with_image_url(page: str, image_url: str) -> str:
    return page.replace(RUSSIAPHOBIA_IMAGE_URL, image_url)


class FakeHTTPClient:
    def __init__(self, responses: Sequence[Response | BaseException]) -> None:
        self.responses = list(responses)
        self.get_calls: list[dict[str, object]] = []

    async def get(
        self,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        follow_redirects: bool = False,
        timeout: float | None = None,  # noqa: ASYNC109
    ) -> Response:
        self.get_calls.append(
            {
                "url": url,
                "params": params,
                "headers": headers,
                "follow_redirects": follow_redirects,
                "timeout": timeout,
            }
        )
        if not self.responses:
            raise AssertionError
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response

    async def post(self, url: str, *, data: Mapping[str, str]) -> Response:
        del url, data
        raise AssertionError

    def stream(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        follow_redirects: bool = False,
        timeout: float | None = None,
    ) -> AbstractAsyncContextManager[Response]:
        del method, url, params, headers, follow_redirects, timeout
        raise AssertionError


class FakeLimiter(SteamCommunityLimiter):
    """Runs provider operations immediately with no pacing."""

    def __init__(self) -> None:
        super().__init__()
        self.started = 0

    async def run[T](self, operation: Callable[[], Awaitable[T]]) -> T:
        self.started += 1
        return await operation()


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "development",
        "signing_secret": "test-signing-secret",
    }
    values.update(overrides)
    return Settings.model_validate(values)


def make_service(
    client: FakeHTTPClient,
    *,
    donors: Sequence[str] = DEFAULT_DONORS,
    limiter: FakeLimiter | None = None,
) -> BadgeArtworkService:
    return BadgeArtworkService(
        settings(),
        http_client=client,
        limiter=limiter if limiter is not None else FakeLimiter(),
        donor_steam_ids=donors,
    )


def run[T](awaitable: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(awaitable)


def redirect() -> Response:
    return Response(302, headers={"location": "https://steamcommunity.com"})


def test_parses_the_real_level_one_page() -> None:
    client = FakeHTTPClient([Response(200, text=RUSSIAPHOBIA_LEVEL_ONE_PAGE)])
    response = run(
        make_service(client, donors=[DONOR_ONE]).check_badge_artwork(APP_ID, STEAM_ID)
    )

    assert response.model_dump() == {
        "app_id": "1184160",
        "status": "ready",
        "badges": [
            {
                "level": 1,
                "name": "Hype Girl",
                "image_url": RUSSIAPHOBIA_IMAGE_URL,
            }
        ],
        "source_url": GAMECARDS_URL_TEMPLATE.format(steam_id=DONOR_ONE, app_id=APP_ID),
    }


def test_parses_the_real_level_five_page() -> None:
    client = FakeHTTPClient([Response(200, text=LYNE_LEVEL_FIVE_PAGE)])
    response = run(
        make_service(client, donors=[DONOR_ONE]).check_badge_artwork(
            LYNE_APP_ID, STEAM_ID
        )
    )

    assert response.status == "ready"
    assert [
        (badge.level, badge.name, badge.image_url) for badge in response.badges
    ] == [(5, "Intersect", LYNE_IMAGE_URL)]


def test_walks_donors_until_one_publishes_the_badge() -> None:
    client = FakeHTTPClient(
        [
            redirect(),
            Response(200, text=LYNE_LEVEL_FIVE_PAGE),
        ]
    )
    response = run(
        make_service(client, donors=[DONOR_ONE, DONOR_TWO]).check_badge_artwork(
            LYNE_APP_ID, STEAM_ID
        )
    )

    assert response.status == "ready"
    assert response.source_url == GAMECARDS_URL_TEMPLATE.format(
        steam_id=DONOR_TWO, app_id=LYNE_APP_ID
    )
    assert [call["url"] for call in client.get_calls] == [
        GAMECARDS_URL_TEMPLATE.format(steam_id=DONOR_ONE, app_id=LYNE_APP_ID),
        GAMECARDS_URL_TEMPLATE.format(steam_id=DONOR_TWO, app_id=LYNE_APP_ID),
    ]


def test_unavailable_when_no_donor_publishes_the_badge() -> None:
    client = FakeHTTPClient([redirect() for _ in DEFAULT_DONORS])
    response = run(make_service(client).check_badge_artwork(APP_ID, STEAM_ID))

    assert response.model_dump() == {
        "app_id": "1184160",
        "status": "unavailable",
        "badges": [],
        "source_url": None,
    }
    assert len(client.get_calls) == len(DEFAULT_DONORS)


def test_unavailable_result_is_negatively_cached() -> None:
    client = FakeHTTPClient([redirect() for _ in DEFAULT_DONORS])
    service = make_service(client)
    first = run(service.check_badge_artwork(APP_ID, STEAM_ID))
    second = run(service.check_badge_artwork(APP_ID, STEAM_ID))

    assert first.status == "unavailable"
    assert second.status == "unavailable"
    assert len(client.get_calls) == len(DEFAULT_DONORS)


def test_event_badge_levels_above_five_are_rejected() -> None:
    client = FakeHTTPClient([Response(200, text=STEAM_AWARDS_EVENT_PAGE)])
    response = run(
        make_service(client, donors=[DONOR_ONE]).check_badge_artwork(
            EVENT_APP_ID, STEAM_ID
        )
    )

    assert response.status == "unavailable"
    assert response.badges == []


def test_foreign_image_hosts_are_rejected() -> None:
    client = FakeHTTPClient(
        [
            Response(
                200,
                text=with_image_url(
                    RUSSIAPHOBIA_LEVEL_ONE_PAGE,
                    "https://evil.example/community_assets/images/items/"
                    "1184160/9e20a4b3a3afbdab1e13e3dbb368bac73c6ca656.png",
                ),
            )
        ]
    )
    response = run(
        make_service(client, donors=[DONOR_ONE]).check_badge_artwork(APP_ID, STEAM_ID)
    )

    assert response.status == "unavailable"


def test_image_urls_for_other_apps_are_rejected() -> None:
    client = FakeHTTPClient(
        [
            Response(
                200,
                text=with_image_url(
                    RUSSIAPHOBIA_LEVEL_ONE_PAGE,
                    "https://shared.fastly.steamstatic.com/community_assets/"
                    "images/items/999999/"
                    "9e20a4b3a3afbdab1e13e3dbb368bac73c6ca656.png",
                ),
            )
        ]
    )
    response = run(
        make_service(client, donors=[DONOR_ONE]).check_badge_artwork(APP_ID, STEAM_ID)
    )

    assert response.status == "unavailable"


def test_card_art_image_forms_are_rejected() -> None:
    client = FakeHTTPClient(
        [
            Response(
                200,
                text=with_image_url(
                    RUSSIAPHOBIA_LEVEL_ONE_PAGE,
                    "https://community.cloudflare.steamstatic.com/economy/"
                    "image/IzMF03bk9WpSBq-S-ekoE33L-iLqGFHVaU25ZzQNQcXdA3g5gM",
                ),
            )
        ]
    )
    response = run(
        make_service(client, donors=[DONOR_ONE]).check_badge_artwork(APP_ID, STEAM_ID)
    )

    assert response.status == "unavailable"


def test_oversized_pages_are_rejected() -> None:
    client = FakeHTTPClient(
        [
            Response(
                200,
                text=RUSSIAPHOBIA_LEVEL_ONE_PAGE,
                headers={"content-length": str(MAX_ARTWORK_PAGE_BYTES + 1)},
            )
        ]
    )
    response = run(
        make_service(client, donors=[DONOR_ONE]).check_badge_artwork(APP_ID, STEAM_ID)
    )

    assert response.status == "unavailable"


def test_transient_network_errors_are_not_cached() -> None:
    client = FakeHTTPClient(
        [TimeoutError(), Response(200, text=RUSSIAPHOBIA_LEVEL_ONE_PAGE)]
    )
    service = make_service(client, donors=[DONOR_ONE])
    first = run(service.check_badge_artwork(APP_ID, STEAM_ID))
    second = run(service.check_badge_artwork(APP_ID, STEAM_ID))

    assert first.status == "unavailable"
    assert second.status == "ready"
    assert len(client.get_calls) == 2


def test_server_errors_are_not_cached() -> None:
    client = FakeHTTPClient(
        [
            Response(503),
            Response(200, text=RUSSIAPHOBIA_LEVEL_ONE_PAGE),
        ]
    )
    service = make_service(client, donors=[DONOR_ONE])
    first = run(service.check_badge_artwork(APP_ID, STEAM_ID))
    second = run(service.check_badge_artwork(APP_ID, STEAM_ID))

    assert first.status == "unavailable"
    assert second.status == "ready"
    assert len(client.get_calls) == 2


def test_rate_limiting_cools_the_provider_down() -> None:
    client = FakeHTTPClient([Response(429, headers={"retry-after": "30"})])
    service = make_service(client, donors=[DONOR_ONE])
    first = run(service.check_badge_artwork(APP_ID, STEAM_ID))
    second = run(service.check_badge_artwork(APP_ID, STEAM_ID))

    assert first.status == "unavailable"
    assert second.status == "unavailable"
    assert len(client.get_calls) == 1


def test_positive_results_are_cached() -> None:
    client = FakeHTTPClient([Response(200, text=RUSSIAPHOBIA_LEVEL_ONE_PAGE)])
    service = make_service(client, donors=[DONOR_ONE])
    first = run(service.check_badge_artwork(APP_ID, STEAM_ID))
    second = run(service.check_badge_artwork(APP_ID, STEAM_ID))

    assert first == second
    assert len(client.get_calls) == 1


def test_expired_results_are_refetched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.badge_artwork.BADGE_ARTWORK_POSITIVE_TTL_SECONDS", 0)
    client = FakeHTTPClient(
        [
            Response(200, text=RUSSIAPHOBIA_LEVEL_ONE_PAGE),
            Response(200, text=RUSSIAPHOBIA_LEVEL_ONE_PAGE),
        ]
    )
    service = make_service(client, donors=[DONOR_ONE])
    run(service.check_badge_artwork(APP_ID, STEAM_ID))
    run(service.check_badge_artwork(APP_ID, STEAM_ID))

    assert len(client.get_calls) == 2


def test_upstream_requests_use_the_fixed_public_shape() -> None:
    client = FakeHTTPClient([Response(200, text=RUSSIAPHOBIA_LEVEL_ONE_PAGE)])
    run(make_service(client, donors=[DONOR_ONE]).check_badge_artwork(APP_ID, STEAM_ID))

    assert len(client.get_calls) == 1
    call = client.get_calls[0]
    assert call["url"] == GAMECARDS_URL_TEMPLATE.format(
        steam_id=DONOR_ONE, app_id=APP_ID
    )
    assert call["params"] == {"l": "english"}
    assert call["headers"] == {
        "User-Agent": STEAM_OPTIMIZER_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
    }
    assert call["follow_redirects"] is False
    assert call["timeout"] == settings().steam_request_timeout_seconds


@pytest.mark.parametrize(
    "app_id",
    [0, -1, 2_147_483_648, True],
)
def test_out_of_range_app_ids_are_rejected(app_id: int) -> None:
    client = FakeHTTPClient([])
    with pytest.raises(ValueError, match="badge_artwork_app_id_invalid"):
        run(
            make_service(client, donors=[DONOR_ONE]).check_badge_artwork(
                app_id, STEAM_ID
            )
        )
    assert client.get_calls == []


@pytest.mark.parametrize(
    "steam_id",
    ["", "7656119796029714", "x76561197960297143", " 76561197960297143"],
)
def test_non_canonical_steam_ids_are_rejected(steam_id: str) -> None:
    client = FakeHTTPClient([])
    with pytest.raises(ValueError, match="badge_artwork_steam_id_invalid"):
        run(
            make_service(client, donors=[DONOR_ONE]).check_badge_artwork(
                APP_ID, steam_id
            )
        )
    assert client.get_calls == []


@pytest.mark.parametrize(
    "donors",
    [
        [],
        (DONOR_ONE, DONOR_ONE),
        ("not-a-steam-id",),
        tuple(f"9{index:016d}" for index in range(17)),
    ],
)
def test_invalid_donor_lists_are_rejected(donors: Sequence[str]) -> None:
    with pytest.raises(ValueError, match="badge_artwork_donor_ids_invalid"):
        make_service(FakeHTTPClient([]), donors=donors)


def test_missing_level_title_falls_back_to_the_badge_title() -> None:
    client = FakeHTTPClient([Response(200, text=PAGE_WITHOUT_LEVEL_TITLE)])
    response = run(
        make_service(client, donors=[DONOR_ONE]).check_badge_artwork(APP_ID, STEAM_ID)
    )

    assert response.status == "ready"
    assert response.badges[0].name == "RUSSIAPHOBIA Badge"


def test_titles_decode_html_entities() -> None:
    client = FakeHTTPClient([Response(200, text=PAGE_WITH_ENTITIES)])
    response = run(
        make_service(client, donors=[DONOR_ONE]).check_badge_artwork(APP_ID, STEAM_ID)
    )

    assert response.status == "ready"
    assert response.badges[0].name == "Hype & Girl"


def test_pages_without_a_badge_block_are_missed() -> None:
    client = FakeHTTPClient([Response(200, text="<html><body></body></html>")])
    response = run(
        make_service(client, donors=[DONOR_ONE]).check_badge_artwork(APP_ID, STEAM_ID)
    )

    assert response.status == "unavailable"


def test_client_errors_are_negatively_cached() -> None:
    client = FakeHTTPClient([Response(404)])
    service = make_service(client, donors=[DONOR_ONE])
    first = run(service.check_badge_artwork(APP_ID, STEAM_ID))
    second = run(service.check_badge_artwork(APP_ID, STEAM_ID))

    assert first.status == "unavailable"
    assert second.status == "unavailable"
    assert len(client.get_calls) == 1
