import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock
} from "vitest";
import BadgeArtwork, { type BadgeArtworkProps } from "./BadgeArtwork";
import {
  fetchBadgeArtwork,
  type BadgeArtworkData,
  type BadgeArtworkFetcher
} from "./badgeArtwork";

const APP_ID = "1184160";
const STEAM_ID = "76561198000000001";
const OTHER_STEAM_ID = "76561198000000002";
const LYNE_APP_ID = "266010";

const RUSSIAPHOBIA_IMAGE_URL =
  "https://shared.fastly.steamstatic.com/community_assets/images/items/1184160/9e20a4b3a3afbdab1e13e3dbb368bac73c6ca656.png";
const RUSSIAPHOBIA_SOURCE_URL =
  "https://steamcommunity.com/profiles/76561197960297143/gamecards/1184160/";

type FetcherMock = Mock<BadgeArtworkFetcher>;

function artworkData(
  overrides: Partial<BadgeArtworkData> = {}
): BadgeArtworkData {
  return {
    app_id: APP_ID,
    status: "ready",
    badges: [
      { level: 1, name: "Hype Girl", image_url: RUSSIAPHOBIA_IMAGE_URL }
    ],
    source_url: RUSSIAPHOBIA_SOURCE_URL,
    ...overrides
  };
}

function makeFetcher(): FetcherMock {
  return vi.fn<BadgeArtworkFetcher>(
    () => new Promise<BadgeArtworkData>(() => {})
  );
}

function props(overrides: Partial<BadgeArtworkProps> = {}): BadgeArtworkProps {
  return {
    appId: APP_ID,
    steamId: STEAM_ID,
    gameName: "RUSSIAPHOBIA",
    targetLevel: 1,
    fetchBadgeArtwork: makeFetcher(),
    ...overrides
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  return Promise.withResolvers<T>();
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BadgeArtwork", () => {
  it("renders nothing and fetches nothing without a Steam session", () => {
    const fetcher = makeFetcher();
    const { container } = render(
      <BadgeArtwork {...props({ steamId: null, fetchBadgeArtwork: fetcher })} />
    );

    expect(container).toBeEmptyDOMElement();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("renders verified levels with target highlight, source link and partial note", async () => {
    const fetcher = makeFetcher();
    const { promise, resolve } = deferred<BadgeArtworkData>();
    fetcher.mockReturnValue(promise);
    render(<BadgeArtwork {...props({ fetchBadgeArtwork: fetcher })} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading badge artwork…"
    );

    await act(async () => {
      resolve(artworkData());
    });
    const image = await screen.findByRole("img");
    expect(image).toHaveAttribute("src", RUSSIAPHOBIA_IMAGE_URL);
    expect(image).toHaveAttribute(
      "alt",
      "RUSSIAPHOBIA level 1 badge: Hype Girl"
    );
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(screen.getByText("Level 1")).toBeInTheDocument();
    expect(screen.getByText("Hype Girl")).toBeInTheDocument();

    const targetLevel = screen.getByText("Level 1").closest("li");
    expect(targetLevel).toHaveAttribute("aria-current", "true");
    expect(targetLevel).toHaveTextContent("Target");

    const source = screen.getByText("Source: Steam Community game cards");
    expect(source).toHaveAttribute("href", RUSSIAPHOBIA_SOURCE_URL);
    expect(source).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("does not highlight a level when target artwork is missing", async () => {
    const fetcher = makeFetcher();
    const { promise, resolve } = deferred<BadgeArtworkData>();
    fetcher.mockReturnValue(promise);
    render(
      <BadgeArtwork
        {...props({ targetLevel: 3, fetchBadgeArtwork: fetcher })}
      />
    );

    await act(async () => {
      resolve(artworkData());
    });
    const image = await screen.findByRole("img");
    expect(image.closest("li")).not.toHaveAttribute("aria-current");
  });

  it("does not highlight a target that is out of range", async () => {
    const fetcher = makeFetcher();
    const { promise, resolve } = deferred<BadgeArtworkData>();
    fetcher.mockReturnValue(promise);
    render(
      <BadgeArtwork
        {...props({ targetLevel: 9, fetchBadgeArtwork: fetcher })}
      />
    );

    await act(async () => {
      resolve(artworkData());
    });
    const level = await screen.findByText("Level 1");
    expect(level.closest("li")).not.toHaveAttribute("aria-current");
  });

  it("reports an honest unavailable state with a check-again retry", async () => {
    const fetcher = makeFetcher();
    const { promise, resolve } = deferred<BadgeArtworkData>();
    fetcher.mockReturnValue(promise);
    render(<BadgeArtwork {...props({ fetchBadgeArtwork: fetcher })} />);

    await act(async () => {
      resolve(
        artworkData({ status: "unavailable", badges: [], source_url: null })
      );
    });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();

    fetcher.mockResolvedValue(artworkData());
    await act(async () => {
      screen.getByRole("button", { name: /check again/i }).click();
    });
    await waitFor(() => {
      expect(screen.getByRole("img")).toBeInTheDocument();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shows fetch failures accessibly and retries with a fresh request", async () => {
    const fetcher = makeFetcher();
    const first = deferred<BadgeArtworkData>();
    fetcher.mockReturnValueOnce(first.promise);
    render(<BadgeArtwork {...props({ fetchBadgeArtwork: fetcher })} />);

    await act(async () => {
      first.reject(new Error("Steam badge artwork is unavailable right now."));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Steam badge artwork is unavailable right now."
    );

    fetcher.mockResolvedValueOnce(artworkData());
    await act(async () => {
      screen.getByRole("button", { name: /retry/i }).click();
    });
    await waitFor(() => {
      expect(screen.getByRole("img")).toBeInTheDocument();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts the in-flight request on unmount", async () => {
    const fetcher = makeFetcher();
    const { promise } = deferred<BadgeArtworkData>();
    fetcher.mockReturnValue(promise);
    const { unmount } = render(
      <BadgeArtwork {...props({ fetchBadgeArtwork: fetcher })} />
    );

    unmount();
    expect(fetcher.mock.calls[0][2].aborted).toBe(true);
  });

  it("isolates accounts: a SteamID change aborts and refetches", async () => {
    const fetcher = makeFetcher();
    const { promise } = deferred<BadgeArtworkData>();
    fetcher.mockReturnValueOnce(promise);
    const view = render(
      <BadgeArtwork {...props({ fetchBadgeArtwork: fetcher })} />
    );

    view.rerender(
      <BadgeArtwork
        {...props({ steamId: OTHER_STEAM_ID, fetchBadgeArtwork: fetcher })}
      />
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]).toBe(STEAM_ID);
    expect(fetcher.mock.calls[1][1]).toBe(OTHER_STEAM_ID);
    expect(fetcher.mock.calls[0][2].aborted).toBe(true);
  });

  it("never shows the previous account's artwork while refetching", async () => {
    const fetcher = makeFetcher();
    const first = deferred<BadgeArtworkData>();
    fetcher.mockReturnValueOnce(first.promise);
    const view = render(
      <BadgeArtwork {...props({ fetchBadgeArtwork: fetcher })} />
    );

    await act(async () => {
      first.resolve(artworkData());
    });
    expect(await screen.findByRole("img")).toBeInTheDocument();
    expect(
      screen.getByText("Source: Steam Community game cards")
    ).toBeInTheDocument();

    fetcher.mockReturnValueOnce(deferred<BadgeArtworkData>().promise);
    view.rerender(
      <BadgeArtwork
        {...props({ steamId: OTHER_STEAM_ID, fetchBadgeArtwork: fetcher })}
      />
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("Source: Steam Community game cards")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading badge artwork…"
    );

    fetcher.mockReturnValueOnce(deferred<BadgeArtworkData>().promise);
    view.rerender(
      <BadgeArtwork
        {...props({
          appId: LYNE_APP_ID,
          gameName: "LYNE",
          fetchBadgeArtwork: fetcher
        })}
      />
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("Source: Steam Community game cards")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("refetches when the expanded game changes", async () => {
    const fetcher = makeFetcher();
    const view = render(
      <BadgeArtwork {...props({ fetchBadgeArtwork: fetcher })} />
    );

    view.rerender(
      <BadgeArtwork
        {...props({
          appId: "266010",
          gameName: "LYNE",
          fetchBadgeArtwork: fetcher
        })}
      />
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe("266010");
  });

  it("renders nothing for a malformed game id", () => {
    const fetcher = makeFetcher();
    const { container } = render(
      <BadgeArtwork
        {...props({ appId: "not-an-id", fetchBadgeArtwork: fetcher })}
      />
    );

    expect(container).toBeEmptyDOMElement();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("fetchBadgeArtwork", () => {
  it("issues an authenticated GET against the fixed endpoint", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(artworkData()), { status: 200 })
    );
    const controller = new AbortController();

    const data = await fetchBadgeArtwork(APP_ID, STEAM_ID, controller.signal);

    expect(data.status).toBe("ready");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe(`/api/auth/badge-artwork/${APP_ID}`);
    expect(init).toMatchObject({
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "x-expected-steam-id": STEAM_ID
      },
      signal: controller.signal
    });
  });

  it("rejects a non-canonical SteamID before any request", async () => {
    await expect(
      fetchBadgeArtwork(APP_ID, "12345", new AbortController().signal)
    ).rejects.toThrow("The SteamID for badge artwork is invalid.");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("maps an expired session to a sign-in message", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(null, { status: 401 })
    );

    await expect(
      fetchBadgeArtwork(APP_ID, STEAM_ID, new AbortController().signal)
    ).rejects.toThrow("Your Steam session expired");
  });

  it("maps endpoint failure to an honest unavailable message", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(null, { status: 503 })
    );

    await expect(
      fetchBadgeArtwork(APP_ID, STEAM_ID, new AbortController().signal)
    ).rejects.toThrow("Steam badge artwork is unavailable right now.");
  });

  it("maps network failure to an honest unavailable message", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("offline"));

    await expect(
      fetchBadgeArtwork(APP_ID, STEAM_ID, new AbortController().signal)
    ).rejects.toThrow("Steam badge artwork is unavailable right now.");
  });

  it("rejects a non-Steam source link even when the artwork is genuine", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify(
          artworkData({ source_url: "https://evil.example/gamecards/1184160/" })
        )
      )
    );
    await expect(
      fetchBadgeArtwork(APP_ID, STEAM_ID, new AbortController().signal)
    ).rejects.toThrow();
  });

  it("rejects genuine Steam artwork belonging to another game", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify(
          artworkData({
            badges: [
              {
                level: 1,
                name: "Hype Girl",
                image_url: RUSSIAPHOBIA_IMAGE_URL.replace(
                  `/${APP_ID}/`,
                  `/${LYNE_APP_ID}/`
                )
              }
            ]
          })
        )
      )
    );
    await expect(
      fetchBadgeArtwork(APP_ID, STEAM_ID, new AbortController().signal)
    ).rejects.toThrow();
  });

  it("rejects payloads for a different game", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(artworkData({ app_id: "999999" })), {
        status: 200
      })
    );

    await expect(
      fetchBadgeArtwork(APP_ID, STEAM_ID, new AbortController().signal)
    ).rejects.toThrow("unexpected data");
  });

  it("rejects payloads with non-allowlisted image URLs", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify(
          artworkData({
            badges: [
              {
                level: 1,
                name: "Hype Girl",
                image_url: "https://evil.example/badge.png"
              }
            ]
          })
        ),
        { status: 200 }
      )
    );

    await expect(
      fetchBadgeArtwork(APP_ID, STEAM_ID, new AbortController().signal)
    ).rejects.toThrow("unexpected data");
  });

  it("rejects payloads whose image URL misses the badge path shape", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify(
          artworkData({
            badges: [
              {
                level: 1,
                name: "Hype Girl",
                image_url:
                  "https://shared.fastly.steamstatic.com/economy/image/abc"
              }
            ]
          })
        ),
        { status: 200 }
      )
    );

    await expect(
      fetchBadgeArtwork(APP_ID, STEAM_ID, new AbortController().signal)
    ).rejects.toThrow("unexpected data");
  });

  it("rejects malformed payloads", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("<html>not json</html>", { status: 200 })
    );

    await expect(
      fetchBadgeArtwork(APP_ID, STEAM_ID, new AbortController().signal)
    ).rejects.toThrow("unexpected data");
  });

  it("surfaces unavailable payloads as data, not errors", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify(
          artworkData({ status: "unavailable", badges: [], source_url: null })
        ),
        { status: 200 }
      )
    );

    const data = await fetchBadgeArtwork(
      APP_ID,
      STEAM_ID,
      new AbortController().signal
    );
    expect(data.status).toBe("unavailable");
    expect(data.badges).toEqual([]);
  });
});
