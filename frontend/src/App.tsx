import { useEffect, useState } from "react";
import "./App.css";

type VisibilityStatus = "public" | "private" | "unavailable";

type VisibilityCheck = {
  status: VisibilityStatus;
  message: string;
};

type SteamUser = {
  steam_id: string;
  display_name: string | null;
  avatar_url: string | null;
};

type SignedOutSession = {
  authenticated: false;
};

type SignedInSession = {
  authenticated: true;
  user: SteamUser;
  checks: {
    profile: VisibilityCheck;
    inventory: VisibilityCheck;
  };
};

type SessionResponse = SignedOutSession | SignedInSession;

type ViewState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; session: SignedInSession }
  | { kind: "api-unavailable" };

type SurfaceName = "profile" | "inventory";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const SESSION_URL = `${API_BASE_URL}/api/auth/session`;
const LOGOUT_URL = `${API_BASE_URL}/api/auth/logout`;
const STEAM_LOGIN_URL = `${API_BASE_URL}/api/auth/steam/start`;
const STEAM_PRIVACY_URL = "https://steamcommunity.com/my/edit/settings";
const NON_ASCII_DECIMAL_PATTERN = /[^0-9]/;

const STATUS_LABELS: Record<VisibilityStatus, string> = {
  public: "Public",
  private: "Private",
  unavailable: "Unavailable"
};

function isVisibilityCheck(value: unknown): value is VisibilityCheck {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const check = value as Partial<VisibilityCheck>;
  return (
    (check.status === "public" ||
      check.status === "private" ||
      check.status === "unavailable") &&
    typeof check.message === "string"
  );
}

function isSessionResponse(value: unknown): value is SessionResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const session = value as {
    authenticated?: unknown;
    user?: unknown;
    checks?: unknown;
  };
  if (typeof session.authenticated !== "boolean") {
    return false;
  }

  if (!session.authenticated) {
    return true;
  }

  if (
    typeof session.user !== "object" ||
    session.user === null ||
    typeof session.checks !== "object" ||
    session.checks === null
  ) {
    return false;
  }

  const user = session.user as Partial<SteamUser>;
  const checks = session.checks as {
    profile?: unknown;
    inventory?: unknown;
  };

  return (
    typeof user.steam_id === "string" &&
    user.steam_id.length > 0 &&
    !NON_ASCII_DECIMAL_PATTERN.test(user.steam_id) &&
    (typeof user.display_name === "string" || user.display_name === null) &&
    (typeof user.avatar_url === "string" || user.avatar_url === null) &&
    isVisibilityCheck(checks.profile) &&
    isVisibilityCheck(checks.inventory)
  );
}

async function requestSession(signal?: AbortSignal): Promise<SessionResponse> {
  const response = await fetch(SESSION_URL, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal
  });

  if (!response.ok) {
    throw new Error("The session service returned an error.");
  }

  const payload: unknown = await response.json();
  if (!isSessionResponse(payload)) {
    throw new Error("The session service returned an invalid response.");
  }

  return payload;
}

function toViewState(session: SessionResponse): ViewState {
  return session.authenticated
    ? { kind: "signed-in", session }
    : { kind: "signed-out" };
}

function Brand() {
  return (
    <div className="brand" aria-label="Steam Optimizer">
      <span className="brand-mark" aria-hidden="true">
        SO
      </span>
      <span className="brand-name">Steam Optimizer</span>
    </div>
  );
}

function ReadOnlyBoundary() {
  return (
    <aside className="boundary-note" aria-labelledby="boundary-title">
      <p className="section-label">Read-only by design</p>
      <h2 id="boundary-title">Your account stays under your control.</h2>
      <p>
        Steam Optimizer only reads information Steam exposes publicly. It cannot
        trade, sell, craft, or change your account. Any future account action
        stays manual and happens on Steam.
      </p>
    </aside>
  );
}

function LoadingView() {
  return (
    <section className="state-panel loading-panel" aria-labelledby="loading-title">
      <div>
        <p className="section-label">Steam connection</p>
        <h2 id="loading-title">Checking your connection</h2>
        <p className="state-copy">
          Looking for an existing local session. No Steam credentials are sent
          from this page.
        </p>
      </div>
      <div className="loading-indicator">
        <span className="loading-dot" aria-hidden="true" />
        Checking session…
      </div>
    </section>
  );
}

function SignedOutView() {
  return (
    <section className="state-panel connection-panel" aria-labelledby="connect-title">
      <div className="connection-copy">
        <p className="section-label">Stage one · Connect</p>
        <h2 id="connect-title">Connect Steam to check public access.</h2>
        <p id="connect-description" className="state-copy">
          Continue to Steam in this browser. Steam handles sign-in and returns
          your public Steam identity—your password never comes here.
        </p>
        <a
          className="primary-action"
          href={STEAM_LOGIN_URL}
          aria-describedby="connect-description"
        >
          Continue with Steam
          <span aria-hidden="true">→</span>
        </a>
      </div>

      <div className="connection-details" aria-label="Connection details">
        <div>
          <span className="detail-number" aria-hidden="true">
            01
          </span>
          <p>
            <strong>Steam verifies you.</strong>
            <span>Authentication happens on Steam Community.</span>
          </p>
        </div>
        <div>
          <span className="detail-number" aria-hidden="true">
            02
          </span>
          <p>
            <strong>We check public surfaces.</strong>
            <span>Profile and inventory access are reported separately.</span>
          </p>
        </div>
        <div>
          <span className="detail-number" aria-hidden="true">
            03
          </span>
          <p>
            <strong>You decide what comes next.</strong>
            <span>No account actions are automated.</span>
          </p>
        </div>
      </div>
    </section>
  );
}

function ApiUnavailableView({ onRetry }: { onRetry: () => void }) {
  return (
    <section
      className="state-panel unavailable-panel"
      aria-labelledby="unavailable-title"
    >
      <div>
        <p className="section-label">Connection service</p>
        <h2 id="unavailable-title">Steam connection is unavailable.</h2>
        <p className="state-copy">
          We could not reach the app's session service. This is a service or
          configuration problem—not a Steam privacy result.
        </p>
      </div>
      <button className="secondary-action" type="button" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

function SteamIdentity({ user }: { user: SteamUser }) {
  const displayName = user.display_name?.trim() || "Steam member";
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <div className="identity">
      {user.avatar_url ? (
        <img className="avatar" src={user.avatar_url} alt="" />
      ) : (
        <span className="avatar avatar-fallback" aria-hidden="true">
          {initials}
        </span>
      )}
      <div>
        <p className="section-label">Connected Steam identity</p>
        <h2 id="account-title">{displayName}</h2>
        <p className="steam-id">Steam ID {user.steam_id}</p>
      </div>
    </div>
  );
}

function AccessCard({
  surface,
  check
}: {
  surface: SurfaceName;
  check: VisibilityCheck;
}) {
  const title = surface === "profile" ? "Steam profile" : "Steam inventory";
  const privateGuidance =
    surface === "profile"
      ? "Your Steam profile is not public."
      : "Your Steam inventory is not public.";

  return (
    <article
      className={`access-card access-card-${check.status}`}
      aria-labelledby={`${surface}-title`}
    >
      <div className="access-card-heading">
        <div>
          <p className="card-index">{surface === "profile" ? "01" : "02"}</p>
          <h3 id={`${surface}-title`}>{title}</h3>
        </div>
        <p className={`access-badge access-badge-${check.status}`}>
          <span className="status-dot" aria-hidden="true" />
          {STATUS_LABELS[check.status]}
        </p>
      </div>

      <p className="check-message">{check.message}</p>

      {check.status === "private" && (
        <p className="result-guidance">
          {privateGuidance}{" "}
          <a href={STEAM_PRIVACY_URL} target="_blank" rel="noreferrer">
            Open Steam privacy settings
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
          , then recheck.
        </p>
      )}

      {check.status === "unavailable" && (
        <p className="result-guidance">
          This is not a privacy result. Recheck when the service is available.
        </p>
      )}
    </article>
  );
}

function SignedInView({
  session,
  isRechecking,
  isSigningOut,
  actionMessage,
  onRecheck,
  onLogout
}: {
  session: SignedInSession;
  isRechecking: boolean;
  isSigningOut: boolean;
  actionMessage: string | null;
  onRecheck: () => void;
  onLogout: () => void;
}) {
  const isBusy = isRechecking || isSigningOut;

  return (
    <section className="account-view" aria-labelledby="account-title">
      <div className="account-header">
        <SteamIdentity user={session.user} />
        <div className="account-actions">
          <button
            className="secondary-action"
            type="button"
            onClick={onRecheck}
            disabled={isBusy}
          >
            {isRechecking ? "Checking…" : "Recheck Steam access"}
          </button>
          <button
            className="text-action"
            type="button"
            onClick={onLogout}
            disabled={isBusy}
          >
            {isSigningOut ? "Signing out…" : "Sign out on this device"}
          </button>
        </div>
      </div>

      {(isRechecking || actionMessage) && (
        <p className={`action-status${actionMessage ? " action-status-error" : ""}`}>
          {isRechecking ? "Rechecking profile and inventory access…" : actionMessage}
        </p>
      )}

      <div className="access-intro">
        <div>
          <p className="section-label">Public access check</p>
          <h2>What Steam exposes right now</h2>
        </div>
        <p>
          These checks are independent. An unavailable check means we could not
          verify it—not that the surface is private.
        </p>
      </div>

      <div className="access-grid">
        <AccessCard surface="profile" check={session.checks.profile} />
        <AccessCard surface="inventory" check={session.checks.inventory} />
      </div>
    </section>
  );
}

export function App() {
  const [viewState, setViewState] = useState<ViewState>({ kind: "loading" });
  const [isRechecking, setIsRechecking] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState("Checking session…");

  useEffect(() => {
    const controller = new AbortController();

    void requestSession(controller.signal)
      .then((session) => {
        if (!controller.signal.aborted) {
          setViewState(toViewState(session));
          setStatusAnnouncement("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setViewState({ kind: "api-unavailable" });
          setStatusAnnouncement("Steam connection is unavailable.");
        }
      });

    return () => controller.abort();
  }, []);

  async function handleRetry() {
    setViewState({ kind: "loading" });
    setActionMessage(null);
    setStatusAnnouncement("Checking session…");

    try {
      setViewState(toViewState(await requestSession()));
      setStatusAnnouncement("");
    } catch {
      setViewState({ kind: "api-unavailable" });
      setStatusAnnouncement("Steam connection is unavailable.");
    }
  }

  async function handleRecheck() {
    setIsRechecking(true);
    setActionMessage(null);
    setStatusAnnouncement("Rechecking profile and inventory access…");

    try {
      const session = await requestSession();
      setViewState(toViewState(session));
      setStatusAnnouncement(
        session.authenticated
          ? `Recheck complete. Steam profile: ${STATUS_LABELS[session.checks.profile.status]}. Steam inventory: ${STATUS_LABELS[session.checks.inventory.status]}.`
          : "Your local session has ended. Sign in again to recheck Steam access."
      );
    } catch {
      const message =
        "We could not recheck Steam access. The service is unavailable, and your previous results have not changed.";
      setActionMessage(message);
      setStatusAnnouncement(message);
    } finally {
      setIsRechecking(false);
    }
  }

  async function handleLogout() {
    setIsSigningOut(true);
    setActionMessage(null);
    setStatusAnnouncement("Signing out…");

    try {
      const response = await fetch(LOGOUT_URL, {
        credentials: "include",
        method: "POST"
      });

      if (response.status !== 204) {
        throw new Error("The logout service returned an unexpected response.");
      }

      setViewState({ kind: "signed-out" });
      setStatusAnnouncement("Signed out successfully.");
    } catch {
      const message =
        "We could not clear your local session. Your Steam account was not changed; please try again.";
      setActionMessage(message);
      setStatusAnnouncement(message);
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <header className="site-header">
        <Brand />
        <p className="boundary-pill">
          <span aria-hidden="true">●</span>
          Read-only workspace
        </p>
      </header>

      <main id="main-content" className="page-main">
        <section className="hero" aria-labelledby="page-title">
          <p className="eyebrow">Understand what Steam makes public</p>
          <h1 id="page-title">A clearer view of your Steam inventory.</h1>
          <p className="hero-copy">
            Connect your account to verify which Steam surfaces are public before
            using read-only inventory and badge tools.
          </p>
        </section>
        <p
          className="visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {statusAnnouncement}
        </p>

        {viewState.kind === "loading" && <LoadingView />}
        {viewState.kind === "signed-out" && <SignedOutView />}
        {viewState.kind === "api-unavailable" && (
          <ApiUnavailableView onRetry={() => void handleRetry()} />
        )}
        {viewState.kind === "signed-in" && (
          <SignedInView
            session={viewState.session}
            isRechecking={isRechecking}
            isSigningOut={isSigningOut}
            actionMessage={actionMessage}
            onRecheck={() => void handleRecheck()}
            onLogout={() => void handleLogout()}
          />
        )}

        <ReadOnlyBoundary />
      </main>

      <footer className="site-footer">
        <p>Steam Optimizer</p>
        <p>Public data in. Manual decisions out.</p>
      </footer>
    </div>
  );
}
