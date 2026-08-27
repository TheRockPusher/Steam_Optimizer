import { defineRailway, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const frontend = service("frontend", {
    replicas: { "europe-west4-drams3a": 1 },
    healthcheck: "/",
    healthcheckTimeout: 60,
    env: {
      API_UPSTREAM: preserve(),
    },
  });
  const backend = service("backend", {
    replicas: { "europe-west4-drams3a": 1 },
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
    env: {
      ALLOWED_ORIGINS: preserve(),
      COOKIE_SAMESITE: preserve(),
      COOKIE_SECURE: preserve(),
      ENVIRONMENT: preserve(),
      FRONTEND_URL: preserve(),
      PUBLIC_BACKEND_URL: preserve(),
      SIGNING_SECRET: preserve(),
      STEAM_WEB_API_KEY: preserve(),
      STEAMAPI_KEY: preserve(),
    },
  });

  return project("steam-optimizer", {
    resources: [frontend, backend],
  });
});
