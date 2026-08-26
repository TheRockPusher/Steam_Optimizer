import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("App", () => {
  it("explains the read-only workflow and reports a healthy API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
        status: 200
      })
    );

    render(<App />);

    expect(screen.getByRole("heading", { name: "Steam Optimizer" })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/read-only/i);
    expect(screen.getByRole("status")).toHaveTextContent("checking");

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("API status: healthy");
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/health",
      expect.objectContaining({
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal)
      })
    );
  });
});
