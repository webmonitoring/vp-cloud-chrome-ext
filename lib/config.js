import {
  BACKEND_CONFIG_URLS,
  DEFAULT_BACKEND_ENV,
  FALLBACK_PUBLIC_CONFIG,
  STORAGE_KEYS,
} from "./constants.js";

let inMemoryConfig;
let pendingLoad;

function normalizeBackendEnv(envValue) {
  if (typeof envValue !== "string") {
    return DEFAULT_BACKEND_ENV;
  }

  const normalized = envValue.trim().toLowerCase();
  return BACKEND_CONFIG_URLS[normalized] ? normalized : DEFAULT_BACKEND_ENV;
}

function resolveConfigUrl(backendEnv) {
  return BACKEND_CONFIG_URLS[backendEnv] || BACKEND_CONFIG_URLS[DEFAULT_BACKEND_ENV];
}

function withMeta(config, source, backendEnv, configUrl) {
  return {
    ...FALLBACK_PUBLIC_CONFIG,
    ...config,
    __source: source,
    __backendEnv: backendEnv,
    __configUrl: configUrl,
  };
}

export async function loadPublicConfig({ forceRefresh = false, backendEnv: requestedBackendEnv } = {}) {
  const backendEnv = normalizeBackendEnv(requestedBackendEnv);
  const configUrl = resolveConfigUrl(backendEnv);

  if (!forceRefresh && inMemoryConfig && inMemoryConfig.__backendEnv === backendEnv) {
    return inMemoryConfig;
  }

  if (!forceRefresh && pendingLoad?.backendEnv === backendEnv) {
    return pendingLoad.promise;
  }

  const loadPromise = (async () => {
    const cached = await chrome.storage.local.get(STORAGE_KEYS.configCache);
    const cachedByEnv = cached[STORAGE_KEYS.configCache] || {};
    const cachedConfig = cachedByEnv[backendEnv];

    try {
      const response = await fetch(configUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Failed to load config.json: ${response.status}`);
      }

      const remoteConfig = await response.json();
      if (!remoteConfig?.jobServiceEndpointV2URL) {
        throw new Error("config.json is missing jobServiceEndpointV2URL");
      }

      inMemoryConfig = withMeta(remoteConfig, "remote", backendEnv, configUrl);
      await chrome.storage.local.set({
        [STORAGE_KEYS.configCache]: {
          ...cachedByEnv,
          [backendEnv]: {
            ...remoteConfig,
          },
        },
      });
      return inMemoryConfig;
    } catch (error) {
      if (cachedConfig?.jobServiceEndpointV2URL) {
        inMemoryConfig = withMeta(cachedConfig, "cache", backendEnv, configUrl);
        return inMemoryConfig;
      }

      inMemoryConfig = withMeta(FALLBACK_PUBLIC_CONFIG, "fallback", backendEnv, configUrl);
      console.warn("Falling back to built-in Visualping config.", error);
      return inMemoryConfig;
    } finally {
      pendingLoad = undefined;
    }
  })();

  pendingLoad = {
    backendEnv,
    promise: loadPromise,
  };

  return loadPromise;
}
