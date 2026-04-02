import { DEFAULT_CONFIG_URL, FALLBACK_PUBLIC_CONFIG, STORAGE_KEYS } from "./constants.js";

let inMemoryConfig;
let pendingLoad;

function withMeta(config, source) {
  return {
    ...FALLBACK_PUBLIC_CONFIG,
    ...config,
    __source: source,
    __configUrl: DEFAULT_CONFIG_URL,
  };
}

export async function loadPublicConfig({ forceRefresh = false } = {}) {
  if (!forceRefresh && inMemoryConfig) {
    return inMemoryConfig;
  }

  if (!forceRefresh && pendingLoad) {
    return pendingLoad;
  }

  pendingLoad = (async () => {
    const cached = await chrome.storage.local.get(STORAGE_KEYS.configCache);

    try {
      const response = await fetch(DEFAULT_CONFIG_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Failed to load config.json: ${response.status}`);
      }

      const remoteConfig = await response.json();
      if (!remoteConfig?.jobServiceEndpointV2URL) {
        throw new Error("config.json is missing jobServiceEndpointV2URL");
      }

      inMemoryConfig = withMeta(remoteConfig, "remote");
      await chrome.storage.local.set({
        [STORAGE_KEYS.configCache]: {
          ...remoteConfig,
        },
      });
      return inMemoryConfig;
    } catch (error) {
      const cachedConfig = cached[STORAGE_KEYS.configCache];
      if (cachedConfig?.jobServiceEndpointV2URL) {
        inMemoryConfig = withMeta(cachedConfig, "cache");
        return inMemoryConfig;
      }

      inMemoryConfig = withMeta(FALLBACK_PUBLIC_CONFIG, "fallback");
      console.warn("Falling back to built-in Visualping config.", error);
      return inMemoryConfig;
    } finally {
      pendingLoad = undefined;
    }
  })();

  return pendingLoad;
}
