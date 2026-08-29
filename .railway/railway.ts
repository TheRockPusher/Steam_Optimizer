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
      LEVEL_UP_CURRENCY_CODE: preserve(),
      LEVEL_UP_CURRENCY_MINOR_DIGITS: preserve(),
      LEVEL_UP_MAX_INVENTORY_AGE_SECONDS: preserve(),
      LEVEL_UP_MAX_QUOTE_AGE_SECONDS: preserve(),
      LEVEL_UP_MIN_FEE_MINOR: preserve(),
      LEVEL_UP_PRICE_BASIS: preserve(),
      LEVEL_UP_PUBLISHER_FEE_BPS: preserve(),
      LEVEL_UP_STEAM_FEE_BPS: preserve(),
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
