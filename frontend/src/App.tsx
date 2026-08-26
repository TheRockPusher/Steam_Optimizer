import { useEffect, useState } from "react";
import "./App.css";

type ApiState = "checking" | "healthy" | "unavailable";

type HealthResponse = {
  status: "ok";
};

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

function isHealthyResponse(value: unknown): value is HealthResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "ok"
  );
}

export function App() {
  const [apiState, setApiState] = useState<ApiState>("checking");

  useEffect(() => {
    const controller = new AbortController();

    async function checkApiHealth() {
      try {
        const response = await fetch(`${apiBaseUrl}/api/health`, {
          headers: { Accept: "application/json" },
          signal: controller.signal
        });

        if (!response.ok || !isHealthyResponse(await response.json())) {
          throw new Error("The API returned an unhealthy response.");
        }

        if (!controller.signal.aborted) {
          setApiState("healthy");
        }
      } catch {
        if (!controller.signal.aborted) {
          setApiState("unavailable");
        }
      }
    }

    void checkApiHealth();
    return () => controller.abort();
  }, []);

  const statusLabel = {
    checking: "checking",
    healthy: "healthy",
    unavailable: "unavailable"
  }[apiState];

  return (
    <main className="app-shell">
      <section className="content-panel" aria-labelledby="app-title">
        <p className="eyebrow">Steam inventory tools</p>
        <h1 id="app-title">Steam Optimizer</h1>
        <p className="intro">
          A read-only workspace for understanding your public Steam Community
          inventory and badges.
        </p>

        <aside className="read-only-note" role="note" aria-labelledby="read-only-title">
          <p className="section-label">Read-only by design</p>
          <h2 id="read-only-title">You stay in control</h2>
          <p>
            This app will never change your Steam account. Any action you take
            remains manual and requires your confirmation on Steam.
          </p>
        </aside>

        <section className="health-card" aria-labelledby="health-title">
          <div>
            <p className="section-label">Service status</p>
            <h2 id="health-title">API health</h2>
          </div>
          <p className={`status status-${apiState}`} role="status" aria-live="polite">
            <span className="status-dot" aria-hidden="true" />
            API status: {statusLabel}
          </p>
        </section>
      </section>
    </main>
  );
}
