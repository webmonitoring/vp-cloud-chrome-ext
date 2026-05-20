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
  llmBackend: "llmBackend",
  claudeApiKey: "claudeApiKey",
  claudeModel: "claudeModel",
});

export const LLM_BACKENDS = Object.freeze(["local", "claude"]);
export const DEFAULT_LLM_BACKEND = "local";

export const CLAUDE_MODELS = Object.freeze([
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
]);
export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-7";
export const ANTHROPIC_API_BASE = "https://api.anthropic.com";

export const STATUS = Object.freeze({
  synced: "synced",
  error: "error",
});
