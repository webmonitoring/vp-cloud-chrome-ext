function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeDomain(domain) {
  return domain.replace(/^\./, "");
}

function createHeaders(token, init = {}) {
  return {
    "Content-Type": "application/json",
    "X-Api-Client": "visualping-cookie-sync-extension",
    Authorization: token,
    ...init,
  };
}

function appendQueryParam(searchParams, key, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return;
    }

    searchParams.set(key, value.join(","));
    return;
  }

  if (typeof value === "boolean") {
    searchParams.set(key, value ? "1" : "0");
    return;
  }

  searchParams.set(key, String(value));
}

async function parseApiError(response) {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const data = await response.json();
    if (data) {
      const parts = [];
      if (data.code) {
        parts.push(data.code);
      }
      if (data.message) {
        parts.push(data.message);
      }
      const requestId = data.requestIdChain ? ` (${data.requestIdChain})` : "";
      if (parts.length) {
        return `${parts.join(": ")}${requestId}`;
      }
      return JSON.stringify(data);
    }
    return await response.text();
  }

  return (await response.text()) || `Request failed with status ${response.status}`;
}

export function buildLoginUrl(config) {
  return new URL("/login", config.visualpingWebURL).toString();
}

export async function getVisualpingIdToken(config) {
  const cookieUrls = unique([config.visualpingWebURL, "https://visualping.io"]);
  const tokenCookieNames = ["assumedIdToken", "idToken"];

  for (const url of cookieUrls) {
    for (const tokenCookieName of tokenCookieNames) {
      try {
        const cookie = await chrome.cookies.get({
          url,
          name: tokenCookieName,
        });
        if (cookie?.value) {
          return cookie.value;
        }
      } catch (error) {
        console.warn(`Unable to read Visualping ${tokenCookieName} cookie for ${url}.`, error);
      }
    }
  }

  return null;
}

export async function checkVisualpingSession(config) {
  const token = await getVisualpingIdToken(config);
  if (!token) {
    return {
      loggedIn: false,
      reason: "missing-token",
    };
  }

  try {
    const response = await fetch(`${config.accountServiceEndpointURL}/describe-user`, {
      method: "GET",
      headers: createHeaders(token, {
        Accept: "application/json",
      }),
    });

    if (response.ok) {
      const data = await response.json();
      return {
        loggedIn: true,
        token,
        user: data,
      };
    }

    if ([401, 403, 440, 441].includes(response.status)) {
      return {
        loggedIn: false,
        reason: "expired-session",
      };
    }

    return {
      loggedIn: false,
      reason: "unexpected-response",
      error: await parseApiError(response),
    };
  } catch (error) {
    return {
      loggedIn: false,
      reason: "request-failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createVisualpingJob(config, token, payload) {
  const response = await fetch(config.jobServiceEndpointV2URL, {
    method: "POST",
    headers: createHeaders(token),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  return response.json();
}

export async function listVisualpingJobs(config, token, params = {}) {
  const url = new URL(config.jobServiceEndpointV2URL);
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    appendQueryParam(searchParams, key, value);
  });

  url.search = searchParams.toString();

  const response = await fetch(url, {
    method: "GET",
    headers: createHeaders(token, {
      Accept: "application/json",
    }),
  });

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  return response.json();
}

export async function listVisualpingLabels(config, token, params = {}) {
  const url = new URL(`${config.jobServiceEndpointV2URL}/labels`);
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    appendQueryParam(searchParams, key, value);
  });

  url.search = searchParams.toString();

  const response = await fetch(url, {
    method: "GET",
    headers: createHeaders(token, {
      Accept: "application/json",
    }),
  });

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  return response.json();
}

export async function getVisualpingJob(config, token, jobId, params = {}) {
  const url = new URL(`${config.jobServiceEndpointV2URL}/${jobId}`);
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    appendQueryParam(searchParams, key, value);
  });

  url.search = searchParams.toString();

  const response = await fetch(url, {
    method: "GET",
    headers: createHeaders(token, {
      Accept: "application/json",
    }),
  });

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  return response.json();
}

export async function updateVisualpingJob(config, token, jobId, payload) {
  const response = await fetch(`${config.jobServiceEndpointV2URL}/${jobId}`, {
    method: "PUT",
    headers: createHeaders(token),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  return response.json();
}

export function buildCookiePreactions(cookies) {
  const actions = [...cookies]
    .sort((left, right) => {
      return (
        left.domain.localeCompare(right.domain) ||
        left.name.localeCompare(right.name) ||
        left.path.localeCompare(right.path)
      );
    })
    .map((cookie) => {
      return {
        cookie: {
          field: cookie.name,
          value: cookie.value,
          domain: normalizeDomain(cookie.domain),
        },
      };
    });

  return {
    active: actions.length > 0,
    actions,
  };
}

function isCookieAction(action) {
  return Boolean(
    action &&
      typeof action === "object" &&
      action.cookie &&
      typeof action.cookie === "object" &&
      typeof action.cookie.field === "string"
  );
}

export function mergeCookieActionsIntoPreactions(existingPreactions, cookies) {
  const previousActions = Array.isArray(existingPreactions?.actions) ? existingPreactions.actions : [];
  const nonCookieActions = previousActions.filter((action) => !isCookieAction(action));
  const cookieActions = buildCookiePreactions(cookies).actions;
  const actions = [...cookieActions, ...nonCookieActions];

  return {
    ...(existingPreactions && typeof existingPreactions === "object" ? existingPreactions : {}),
    active: actions.length > 0,
    actions,
  };
}

export function buildCreateJobPayload({ url, title, alertCondition, interval, cookies, workspaceId }) {
  return {
    url,
    description: title || new URL(url).hostname,
    mode: "ALL",
    active: true,
    interval,
    trigger: "1",
    target_device: "4",
    wait_time: 0,
    enable_cookies_and_ad_blocker: true,
    alert_error: true,
    origin: "chrome",
    notification: {
      enableEmailAlert: true,
      enableSmsAlert: false,
      onlyImportantAlerts: true,
      config: {},
    },
    summalyzer: {
      importantDefinitionType: "custom",
      importantDefinition: alertCondition.trim(),
    },
    preactions: cookies.length ? buildCookiePreactions(cookies) : undefined,
    ...(workspaceId !== undefined && workspaceId !== null ? { workspaceId } : {}),
  };
}

export function buildCookieSyncPayload({ jobId, cookies, workspaceId, existingPreactions }) {
  const payload = {
    jobId: Number(jobId),
    enable_cookies_and_ad_blocker: true,
    preactions: mergeCookieActionsIntoPreactions(existingPreactions, cookies),
  };

  if (workspaceId !== undefined && workspaceId !== null) {
    payload.workspaceId = workspaceId;
  }

  return payload;
}

export function buildScriptActionPreactions(existingPreactions, script) {
  const existingActions = Array.isArray(existingPreactions?.actions) ? existingPreactions.actions : [];
  const actions = [
    ...existingActions,
    {
      script,
    },
  ];

  return {
    ...(existingPreactions && typeof existingPreactions === "object" ? existingPreactions : {}),
    active: actions.length > 0,
    actions,
  };
}

export function cookieMatchesHost(cookieDomain, hostname) {
  const normalizedDomain = normalizeDomain(cookieDomain);
  return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
}
