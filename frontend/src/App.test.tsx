import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const signedInSession = {
  authenticated: true,
  user: {
    steam_id: "76561198000000001",
    display_name: "Alyx",
    avatar_url: "https://cdn.example.test/avatar.jpg"
  },
  checks: {
    profile: {
      status: "public",
      message: "Your Steam profile is publicly visible."
    },
    inventory: {
      status: "private",
      message: "Steam reports that this inventory is private.",
      retry_after_seconds: null,
      rate_limited: false
    }
  }
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status
  });
}

function sessionWithRetry(retryAfterSeconds: number | null) {
  return {
    ...signedInSession,
    checks: {
      ...signedInSession.checks,
      inventory: {
        ...signedInSession.checks.inventory,
        retry_after_seconds: retryAfterSeconds
      }
    }
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("App", () => {
  it("loads the session before offering normal navigation through both official Steam images", async () => {
    let resolveSession!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveSession = resolve;
        })
    );

    const { container } = render(<App />);

    expect(
      screen.getByRole("heading", { name: "Checking your connection" })
    ).toBeInTheDocument();
    const statusRegion = screen.getByRole("status");
    expect(statusRegion).toHaveTextContent("Checking session");
    expect(
      screen.queryByRole("link", { name: /steam sign-in/i })
    ).not.toBeInTheDocument();

    await act(async () => {
      resolveSession(jsonResponse({ authenticated: false }));
    });

    expect(
      await screen.findByRole("heading", {
        name: "Connect Steam to check public access."
      })
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toBe(statusRegion);

    const loginLink = screen.getByRole("link", { name: /steam sign-in/i });
    expect(loginLink).toHaveAccessibleName(
      "Steam sign-in; Steam Optimizer is not affiliated with Valve"
    );
    expect(loginLink).toHaveAttribute("href", "/api/auth/steam/start");
    expect(loginLink).not.toHaveAttribute("target");
    const signInImage = within(loginLink).getByRole("img");
    expect(signInImage.getAttribute("src")).toContain("sits_01.png");
    expect(signInImage).toHaveAttribute("width", "180");
    expect(signInImage).toHaveAttribute("height", "35");
    const compactSource = container.querySelector("picture source");
    expect(compactSource?.getAttribute("srcset")).toContain("sits_02.png");
    expect(compactSource).toHaveAttribute("media", "(max-width: 40rem)");
    expect(compactSource).toHaveAttribute("width", "109");
    expect(compactSource).toHaveAttribute("height", "66");
    expect(screen.getByText(/your password never comes here/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot trade, sell, craft, or change/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /privacy & steam data terms/i })
    ).toHaveAttribute(
      "href",
      "https://github.com/TheRockPusher/Steam_Optimizer#privacy-and-steam-data-policy"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.objectContaining({
        credentials: "include",
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal)
      })
    );
  });

  it("shows an API-unavailable state without calling it a privacy result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 503 })
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Steam connection is unavailable."
      })
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Steam connection is unavailable."
    );
    expect(screen.getByText(/not a Steam privacy result/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("renders Steam identity and independent public and private results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(signedInSession)
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Alyx" })
    ).toBeInTheDocument();
    expect(screen.getByText("Steam ID 76561198000000001")).toBeInTheDocument();

    const profileCard = screen.getByRole("article", { name: "Steam profile" });
    expect(within(profileCard).getByText("Public")).toBeInTheDocument();
    expect(
      within(profileCard).getByText("Your Steam profile is publicly visible.")
    ).toBeInTheDocument();

    const inventoryCard = screen.getByRole("article", {
      name: "Steam inventory"
    });
    expect(within(inventoryCard).getByText("Private")).toBeInTheDocument();
    expect(
      within(inventoryCard).getByText(
        "Steam reports that this inventory is private."
      )
    ).toBeInTheDocument();
    expect(
      within(inventoryCard).getByRole("link", {
        name: /open Steam privacy settings/i
      })
    ).toHaveAttribute("href", "https://steamcommunity.com/my/edit/settings");
  });

  it.each(["", " ", "123\n", "76561198000000001abc", "１２３", "١٢٣", "+123"])(
    "rejects a non-ASCII decimal Steam ID (%j)",
    async (steamId) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonResponse({
          ...signedInSession,
          user: { ...signedInSession.user, steam_id: steamId }
        })
      );

      render(<App />);

      expect(
        await screen.findByRole("heading", {
          name: "Steam connection is unavailable."
        })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: signedInSession.user.display_name })
      ).not.toBeInTheDocument();
    }
  );

  it.each([undefined, "30", -1, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects an invalid inventory retry envelope (%j)",
    async (retryAfterSeconds) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonResponse({
          ...signedInSession,
          checks: {
            ...signedInSession.checks,
            inventory: {
              ...signedInSession.checks.inventory,
              retry_after_seconds: retryAfterSeconds
            }
          }
        })
      );

      render(<App />);

      expect(
        await screen.findByRole("heading", {
          name: "Steam connection is unavailable."
        })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: signedInSession.user.display_name })
      ).not.toBeInTheDocument();
    }
  );

  it.each([undefined, null, 0, "true"])(
    "rejects an invalid inventory rate-limit marker (%j)",
    async (rateLimited) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonResponse({
          ...signedInSession,
          checks: {
            ...signedInSession.checks,
            inventory: {
              ...signedInSession.checks.inventory,
              rate_limited: rateLimited
            }
          }
        })
      );

      render(<App />);

      expect(
        await screen.findByRole("heading", {
          name: "Steam connection is unavailable."
        })
      ).toBeInTheDocument();
    }
  );

  it("labels an unavailable upstream check separately from privacy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ...signedInSession,
        checks: {
          profile: {
            status: "unavailable",
            message: "The Steam Web API is not configured."
          },
          inventory: {
            status: "public",
            message: "Your Steam inventory is publicly accessible.",
            retry_after_seconds: null,
            rate_limited: false
          }
        }
      })
    );

    render(<App />);

    await screen.findByRole("heading", { name: "Alyx" });
    const profileCard = screen.getByRole("article", { name: "Steam profile" });

    expect(within(profileCard).getByText("Unavailable")).toBeInTheDocument();
    expect(
      within(profileCard).getByText("The Steam Web API is not configured.")
    ).toBeInTheDocument();
    expect(within(profileCard).getByText(/not a privacy result/i)).toBeInTheDocument();
    expect(within(profileCard).queryByText("Private")).not.toBeInTheDocument();
  });

  it("shows the backend 429 copy and rate-limit guidance instead of privacy guidance", async () => {
    const rateLimitMessage =
      "Steam is temporarily limiting inventory checks. Try again in 30 seconds.";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ...sessionWithRetry(30),
        checks: {
          ...sessionWithRetry(30).checks,
          inventory: {
            status: "unavailable",
            message: rateLimitMessage,
            retry_after_seconds: 30,
            rate_limited: true
          }
        }
      })
    );

    render(<App />);

    await screen.findByRole("heading", { name: "Alyx" });
    const inventoryCard = screen.getByRole("article", {
      name: "Steam inventory"
    });
    expect(within(inventoryCard).getByText(rateLimitMessage)).toBeInTheDocument();
    expect(within(inventoryCard).getByText("Try later")).toBeInTheDocument();
    expect(
      within(inventoryCard).getByText(
        /Steam is temporarily limiting automated checks/i
      )
    ).toHaveTextContent(/does not mean your inventory is private/i);
    expect(
      within(inventoryCard).queryByRole("link", {
        name: /open Steam privacy settings/i
      })
    ).not.toBeInTheDocument();
    expect(
      within(inventoryCard).queryByText(
        /Recheck when the service is available/i
      )
    ).not.toBeInTheDocument();
  });

  it("applies an authoritative initial cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(sessionWithRetry(3))
    );

    render(<App />);
    await act(async () => { });

    expect(screen.getByRole("heading", { name: "Alyx" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Repeated immediate recheck requests are disabled. Try again in 3s."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Recheck Steam access" })
    ).toBeDisabled();
  });

  it("updates the authoritative cooldown from a recheck response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(sessionWithRetry(4)));

    render(<App />);
    await act(async () => { });
    fireEvent.click(
      screen.getByRole("button", { name: "Recheck Steam access" })
    );
    await act(async () => { });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText(
        "Repeated immediate recheck requests are disabled. Try again in 4s."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Recheck Steam access" })
    ).toBeDisabled();
  });

  it("guards recheck without fetching during cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(sessionWithRetry(5))
    );

    render(<App />);
    await act(async () => { });

    const recheckButton = screen.getByRole("button", {
      name: "Recheck Steam access"
    });
    expect(recheckButton).toBeDisabled();

    recheckButton.removeAttribute("disabled");
    fireEvent.click(recheckButton);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores wall-clock jumps while enforcing cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(sessionWithRetry(5))
    );

    render(<App />);
    await act(async () => { });

    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));
    const recheckButton = screen.getByRole("button", {
      name: "Recheck Steam access"
    });
    recheckButton.removeAttribute("disabled");
    fireEvent.click(recheckButton);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("counts down with ceil and enables recheck at the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(sessionWithRetry(2))
    );

    render(<App />);
    await act(async () => { });

    const recheckButton = screen.getByRole("button", {
      name: "Recheck Steam access"
    });
    expect(screen.getByText(/Try again in 2s\./i)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/Try again in 1s\./i)).toBeInTheDocument();
    expect(recheckButton).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(
      screen.queryByText(/Repeated immediate recheck requests are disabled/i)
    ).not.toBeInTheDocument();
    expect(recheckButton).toBeEnabled();
  });

  it("keeps logout available throughout an inventory cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(sessionWithRetry(30))
    );

    render(<App />);
    await act(async () => { });

    expect(
      screen.getByRole("button", { name: "Recheck Steam access" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Sign out on this device" })
    ).toBeEnabled();
  });

  it("rechecks both access results with credentials and announces both current labels", async () => {
    const refreshedSession = {
      ...signedInSession,
      checks: {
        profile: {
          status: "private",
          message: "Profile access was checked again."
        },
        inventory: {
          status: "unavailable",
          message: "Inventory access was checked again.",
          retry_after_seconds: null,
          rate_limited: false
        }
      }
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(refreshedSession));

    render(<App />);

    await screen.findByRole("heading", { name: "Alyx" });
    const statusRegion = screen.getByRole("status");
    fireEvent.click(
      screen.getByRole("button", { name: "Recheck Steam access" })
    );

    await waitFor(() => {
      expect(screen.getByText("Inventory access was checked again.")).toBeInTheDocument();
    });
    expect(
      within(
        screen.getByRole("article", { name: "Steam inventory" })
      ).getByText("Unavailable")
    ).toBeInTheDocument();
    expect(statusRegion).toHaveTextContent(
      "Recheck complete. Steam profile: Private. Steam inventory: Unavailable."
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/auth/session",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("keeps recheck failures visible and announced without replacing prior results", async () => {
    const message =
      "We could not recheck Steam access. The service is unavailable, and your previous results have not changed.";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    render(<App />);

    await screen.findByRole("heading", { name: "Alyx" });
    const statusRegion = screen.getByRole("status");
    fireEvent.click(
      screen.getByRole("button", { name: "Recheck Steam access" })
    );

    await waitFor(() => {
      expect(statusRegion).toHaveTextContent(message);
    });
    expect(
      screen.getByText(message, { selector: ".action-status" })
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("article", { name: "Steam inventory" })
      ).getByText("Private")
    ).toBeInTheDocument();
  });

  it("clears the local session with a credentialed logout POST", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    render(<App />);

    await screen.findByRole("heading", { name: "Alyx" });
    const statusRegion = screen.getByRole("status");
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out on this device" })
    );

    expect(
      await screen.findByRole("heading", {
        name: "Connect Steam to check public access."
      })
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toBe(statusRegion);
    expect(statusRegion).toHaveTextContent("Signed out successfully.");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/auth/logout", {
      credentials: "include",
      method: "POST"
    });
  });
});
