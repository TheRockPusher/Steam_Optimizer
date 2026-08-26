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
      message: "Steam reports that this inventory is private."
    }
  }
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("App", () => {
  it("loads the credentialed session before offering normal Steam navigation", async () => {
    let resolveSession!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveSession = resolve;
        })
    );

    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Checking your connection" })
    ).toBeInTheDocument();
    const statusRegion = screen.getByRole("status");
    expect(statusRegion).toHaveTextContent("Checking session");
    expect(
      screen.queryByRole("link", { name: /continue with steam/i })
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

    const loginLink = screen.getByRole("link", { name: /continue with steam/i });
    expect(loginLink).toHaveAttribute("href", "/api/auth/steam/start");
    expect(screen.getByText(/your password never comes here/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot trade, sell, craft, or change/i)).toBeInTheDocument();

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
            message: "Your Steam inventory is publicly accessible."
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
          message: "Inventory access was checked again."
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
