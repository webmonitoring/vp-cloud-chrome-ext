export const DEFAULT_BACKEND_ENV = "prod";

export const BACKEND_CONFIG_URLS = Object.freeze({
  local: "http://localhost:3000/config.json",
  dev: "https://dev.visualping.io/config.json",
  prod: "https://visualping.io/config.json",
});

export const FALLBACK_PUBLIC_CONFIG = Object.freeze({
  jobServiceEndpointV2URL: "https://job.api.visualping.io/v2/jobs",
  accountServiceEndpointURL: "https://account.api.visualping.io",
  visualpingWebURL: "https://visualping.io",
});

export const DEFAULT_FREQUENCY_OPTIONS = Object.freeze([
  { label: "Every 5 minutes", value: "5" },
  { label: "Every 15 minutes", value: "15" },
  { label: "Every 30 minutes", value: "30" },
  { label: "Every hour", value: "60" },
  { label: "Every 6 hours", value: "360" },
  { label: "Every 12 hours", value: "720" },
  { label: "Every day", value: "1440" },
]);

export const STORAGE_KEYS = Object.freeze({
  configCache: "configCache",
  backendEnv: "backendEnv",
  trackedJobs: "trackedJobs",
  monitorSuggestionsEnabled: "monitorSuggestionsEnabled",
});

export const STATUS = Object.freeze({
  synced: "synced",
  error: "error",
});
