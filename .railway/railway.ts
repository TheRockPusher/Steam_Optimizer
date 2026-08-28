import {
  defineRailway,
  preserve,
  project,
  service,
  volume,
} from "railway/iac";
export default defineRailway(() => {
  const frontend = service("frontend", {
    replicas: { "europe-west4-drams3a": 1 },
    healthcheck: "/",
    healthcheckTimeout: 60,
    env: {
      API_UPSTREAM: preserve(),
    },
  });
  const backendData = volume("backend-data", {
    region: "europe-west4-drams3a",
  });
  const backend = service("backend", {
    replicas: { "europe-west4-drams3a": 1 },
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
    volumeMounts: {
      "/data": backendData,
    },
    env: {
      ALLOWED_ORIGINS: preserve(),
      COOKIE_SAMESITE: preserve(),
      COOKIE_SECURE: preserve(),
      ENVIRONMENT: preserve(),
      FRONTEND_URL: preserve(),
      GEM_PRICE_CACHE_PATH: "/data/gem_prices.sqlite3",
      STEAMAPIS_PRICE_CACHE_PATH: "/data/steamapis_prices.sqlite3",
      PUBLIC_BACKEND_URL: preserve(),
      SIGNING_SECRET: preserve(),
      STEAM_WEB_API_KEY: preserve(),
      STEAMAPI_KEY: preserve(),
    },
  });

  return project("steam-optimizer", {
    resources: [frontend, backend, backendData],
  });
});
