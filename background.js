import { DEFAULT_FREQUENCY_OPTIONS, STATUS } from "./lib/constants.js";
import { loadPublicConfig } from "./lib/config.js";
import {
  getTrackedJob,
  getTrackedJobs,
  listTrackedJobs,
  listTrackedJobsForHost,
  removeTrackedJob,
  updateTrackedJob,
  upsertTrackedJob,
} from "./lib/storage.js";
import {
  buildCookieSyncPayload,
  buildCreateJobPayload,
  buildLoginUrl,
  checkVisualpingSession,
  cookieMatchesHost,
  createVisualpingJob,
  listVisualpingJobs,
  listVisualpingLabels,
  updateVisualpingJob,
} from "./lib/visualping.js";

const DEFAULT_JOBS_PAGE_SIZE = 10;
const syncState = new Map();

function isSupportedTabUrl(url) {
  if (!url) {
    return false;
  }

  return url.startsWith("http://") || url.startsWith("https://");
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function safeParseUrl(url) {
  try {
    return new URL(url);
  } catch (_error) {
    return null;
  }
}

function getHostname(url) {
  return safeParseUrl(url)?.hostname ?? "";
}

function toNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLabelIds(labelIds) {
  if (!Array.isArray(labelIds)) {
    return [];
  }

  return labelIds
    .map((labelId) => Number(labelId))
    .filter((labelId) => Number.isInteger(labelId) && labelId > 0);
}

function mapLabelIdsToLabels(labelIds, labelsById) {
  return normalizeLabelIds(labelIds)
    .map((labelId) => labelsById.get(labelId))
    .filter(Boolean);
}

function trackedJobsSummary(trackedJobs) {
  return trackedJobs.map((job) => {
    return {
      jobId: job.jobId,
      importantDefinition: job.importantDefinition ?? job.description ?? job.title ?? "",
      interval: job.interval,
      cookieCount: job.cookieCount,
      status: job.status,
      lastSyncedAt: job.lastSyncedAt ?? null,
      lastError: job.lastError ?? null,
    };
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  return tabs[0] ?? null;
}

function permissionPatternForUrl(url) {
  const parsed = new URL(url);
  return `${parsed.origin}/*`;
}

async function ensureSitePermission(url) {
  const originPattern = permissionPatternForUrl(url);
  const hasPermission = await chrome.permissions.contains({
    origins: [originPattern],
  });

  if (hasPermission) {
    return originPattern;
  }

  const granted = await chrome.permissions.request({
    origins: [originPattern],
  });

  if (!granted) {
    throw new Error("Site permission is required to read and sync that page's cookies.");
  }

  return originPattern;
}

async function hasSitePermission(url) {
  return chrome.permissions.contains({
    origins: [permissionPatternForUrl(url)],
  });
}

async function getCookiesForPage(url) {
  const cookies = await chrome.cookies.getAll({ url });
  return cookies.filter((cookie) => cookie.name && cookie.domain);
}

async function requireSession(config) {
  const session = await checkVisualpingSession(config);
  if (!session.loggedIn || !session.token) {
    throw new Error("Log in to Visualping before managing monitoring jobs.");
  }

  return session;
}

function getOrganisationId(session) {
  const organisationId = session.user?.organisation?.id;
  const numericOrganisationId = Number(organisationId);
  return Number.isInteger(numericOrganisationId) && numericOrganisationId > 0 ? numericOrganisationId : null;
}

function getPreferredWorkspaceId(session) {
  const workspaces = session.user?.workspaces ?? [];
  if (!workspaces.length) {
    return null;
  }

  const preferred = workspaces.find((workspace) => workspace.role !== "VIEWER");
  return Number(preferred?.id ?? workspaces[0]?.id) || null;
}

function normalizeJobsQuery(payload = {}) {
  const pageIndex = Math.max(0, Number(payload.pageIndex) || 0);
  const requestedPageSize = Number(payload.pageSize) || DEFAULT_JOBS_PAGE_SIZE;
  const pageSize = Math.min(25, Math.max(1, requestedPageSize));
  const labelId = payload.labelId === "" || payload.labelId === undefined || payload.labelId === null
    ? null
    : toNumberOrNull(payload.labelId);

  return {
    pageIndex,
    pageSize,
    nameFilter: String(payload.nameFilter ?? "").trim(),
    labelId,
    cookieSyncFilter:
      payload.cookieSyncFilter === "on" || payload.cookieSyncFilter === "off" ? payload.cookieSyncFilter : "all",
  };
}

function trackedJobMatchesFilters(job, query) {
  if (query.labelId !== null && !normalizeLabelIds(job.labelIds).includes(query.labelId)) {
    return false;
  }

  if (!query.nameFilter) {
    return true;
  }

  const searchText = query.nameFilter.toLowerCase();
  const haystack = [
    job.description,
    job.title,
    job.importantDefinition,
    job.url,
    job.host,
    `job ${job.jobId}`,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(searchText);
}

function buildJobsApiParams(query, session, pageIndex = query.pageIndex) {
  const params = {
    pageIndex,
    pageSize: query.pageSize,
    fullTextSearchFilter: query.nameFilter || undefined,
    labelsFilter: query.labelId !== null ? [query.labelId] : undefined,
    showSpiderJobs: false,
    showManuallyCreatedJobs: true,
    showAutoCreatedJobs: true,
  };

  const organisationId = getOrganisationId(session);
  if (organisationId) {
    params.organisationId = organisationId;
  }

  return params;
}

async function fetchVisualpingJobsPage(config, session, query, pageIndex = query.pageIndex) {
  return listVisualpingJobs(config, session.token, buildJobsApiParams(query, session, pageIndex));
}

async function getJobLabels(config, session) {
  const organisationId = getOrganisationId(session);
  if (!organisationId) {
    return [];
  }

  try {
    const response = await listVisualpingLabels(config, session.token, {
      organisationId,
      sortBy: "alphabetical_asc",
      computeUsage: true,
    });
    return Array.isArray(response.labels) ? response.labels : [];
  } catch (error) {
    console.warn("Failed to load Visualping labels.", error);
    return [];
  }
}

function buildApiJobListItem(job, trackedJob, labelsById) {
  const labelIds = normalizeLabelIds(job.labelIds ?? trackedJob?.labelIds);
  const description = job.description || getHostname(job.url) || `Job #${job.id}`;
  return {
    id: Number(job.id),
    url: job.url,
    host: getHostname(job.url),
    description,
    interval: toNumberOrNull(job.interval),
    isActive: Boolean(job.isActive),
    mode: job.mode ?? null,
    labelIds,
    labels: mapLabelIdsToLabels(labelIds, labelsById),
    cookieSyncEnabled: Boolean(trackedJob),
    cookieSyncStatus: trackedJob?.status ?? null,
    cookieCount: trackedJob?.cookieCount ?? 0,
    lastSyncedAt: trackedJob?.lastSyncedAt ?? null,
    lastError: trackedJob?.lastError ?? null,
  };
}

function buildTrackedJobListItem(job, labelsById) {
  const labelIds = normalizeLabelIds(job.labelIds);
  const description = job.description || job.title || job.importantDefinition || getHostname(job.url) || `Job #${job.jobId}`;
  return {
    id: Number(job.jobId),
    url: job.url,
    host: job.host ?? getHostname(job.url),
    description,
    interval: toNumberOrNull(job.interval),
    isActive: true,
    mode: job.mode ?? null,
    labelIds,
    labels: mapLabelIdsToLabels(labelIds, labelsById),
    cookieSyncEnabled: true,
    cookieSyncStatus: job.status ?? STATUS.synced,
    cookieCount: job.cookieCount ?? 0,
    lastSyncedAt: job.lastSyncedAt ?? null,
    lastError: job.lastError ?? null,
  };
}

function buildJobsListResult(query, jobs, totalJobs, labels) {
  return {
    ok: true,
    pageIndex: query.pageIndex,
    pageSize: query.pageSize,
    totalJobs,
    totalPages: totalJobs > 0 ? Math.ceil(totalJobs / query.pageSize) : 0,
    availableLabels: labels,
    jobs,
  };
}

async function listJobsForPopup(payload = {}) {
  const query = normalizeJobsQuery(payload);
  const config = await loadPublicConfig();
  const session = await requireSession(config);
  const trackedJobs = await listTrackedJobs();
  const trackedJobsById = new Map(
    trackedJobs.map((job) => {
      return [Number(job.jobId), job];
    })
  );
  const labels = await getJobLabels(config, session);
  const labelsById = new Map(
    labels.map((label) => {
      return [Number(label.id), label];
    })
  );

  if (query.cookieSyncFilter === "on") {
    const filteredTrackedJobs = trackedJobs.filter((job) => trackedJobMatchesFilters(job, query));
    const start = query.pageIndex * query.pageSize;
    const jobs = filteredTrackedJobs.slice(start, start + query.pageSize).map((job) => {
      return buildTrackedJobListItem(job, labelsById);
    });

    return buildJobsListResult(query, jobs, filteredTrackedJobs.length, labels);
  }

  if (query.cookieSyncFilter === "all") {
    const response = await fetchVisualpingJobsPage(config, session, query, query.pageIndex);
    const jobs = (response.jobs ?? []).map((job) => {
      return buildApiJobListItem(job, trackedJobsById.get(Number(job.id)), labelsById);
    });

    return buildJobsListResult(query, jobs, Number(response.totalJobs ?? 0), labels);
  }

  const firstPage = await fetchVisualpingJobsPage(config, session, query, 0);
  const trackedMatchCount = trackedJobs.filter((job) => trackedJobMatchesFilters(job, query)).length;
  const totalJobs = Math.max(Number(firstPage.totalJobs ?? 0) - trackedMatchCount, 0);
  const targetStart = query.pageIndex * query.pageSize;
  const jobs = [];
  let skippedUnsyncedJobs = 0;

  for (let backendPageIndex = 0; backendPageIndex < Number(firstPage.totalPages ?? 0); backendPageIndex += 1) {
    const response = backendPageIndex === 0 ? firstPage : await fetchVisualpingJobsPage(config, session, query, backendPageIndex);

    for (const job of response.jobs ?? []) {
      if (trackedJobsById.has(Number(job.id))) {
        continue;
      }

      if (skippedUnsyncedJobs < targetStart) {
        skippedUnsyncedJobs += 1;
        continue;
      }

      jobs.push(buildApiJobListItem(job, null, labelsById));
      if (jobs.length >= query.pageSize) {
        return buildJobsListResult(query, jobs, totalJobs, labels);
      }
    }
  }

  return buildJobsListResult(query, jobs, totalJobs, labels);
}

async function buildPopupState() {
  const config = await loadPublicConfig();
  const tab = await getActiveTab();
  const loginUrl = buildLoginUrl(config);
  const session = await checkVisualpingSession(config);
  const workspaceRecords = (session.user?.workspaces ?? [])
    .map((workspace) => {
      const id = Number(workspace.id);
      return Number.isFinite(id)
        ? {
            id,
            name: workspace.name ?? `Workspace ${workspace.id}`,
            role: workspace.role ?? "",
          }
        : null;
    })
    .filter(Boolean);
  const preferredWorkspaceId = getPreferredWorkspaceId(session);

  if (!tab || !isSupportedTabUrl(tab.url)) {
    return {
      ok: true,
      supportedPage: false,
      loggedIn: session.loggedIn,
      loginUrl,
      frequencyOptions: DEFAULT_FREQUENCY_OPTIONS,
      sessionError: session.error ?? null,
      workspaces: workspaceRecords,
      preferredWorkspaceId,
    };
  }

  const hostname = getHostname(tab.url);
  const trackedJobs = await listTrackedJobsForHost(hostname);

  return {
    ok: true,
    supportedPage: true,
    loggedIn: session.loggedIn,
    loginUrl,
    configSource: config.__source,
    tab: {
      title: tab.title ?? hostname,
      url: tab.url,
      hostname,
    },
    trackedJobs: trackedJobsSummary(trackedJobs),
    frequencyOptions: DEFAULT_FREQUENCY_OPTIONS,
    sessionError: session.error ?? null,
    workspaces: workspaceRecords,
    preferredWorkspaceId,
  };
}

async function createJobForActiveTab({ alertCondition, interval, workspaceId: requestedWorkspaceId } = {}) {
  const config = await loadPublicConfig();
  const tab = await getActiveTab();

  if (!tab || !isSupportedTabUrl(tab.url)) {
    throw new Error("Open the extension on an http:// or https:// page.");
  }

  if (!alertCondition?.trim()) {
    throw new Error('"Alert me when" is required.');
  }

  await ensureSitePermission(tab.url);

  const session = await requireSession(config);
  const cookies = await getCookiesForPage(tab.url);
  const workspaceId = Number.isFinite(Number(requestedWorkspaceId))
    ? Number(requestedWorkspaceId)
    : getPreferredWorkspaceId(session);
  const payload = buildCreateJobPayload({
    url: tab.url,
    title: tab.title,
    alertCondition,
    interval,
    cookies,
    workspaceId,
  });

  const response = await createVisualpingJob(config, session.token, payload);
  const now = new Date().toISOString();
  const host = getHostname(tab.url);

  await upsertTrackedJob({
    jobId: response.jobid,
    url: tab.url,
    title: tab.title ?? host,
    description: tab.title ?? host,
    host,
    interval,
    importantDefinition: alertCondition.trim(),
    labelIds: [],
    createdAt: now,
    lastSyncedAt: now,
    cookieCount: cookies.length,
    status: STATUS.synced,
    lastError: null,
  });

  return {
    ok: true,
    jobId: response.jobid,
    cookieCount: cookies.length,
  };
}

async function toggleCookieSyncForJob(payload = {}) {
  const jobId = Number(payload.job?.id ?? payload.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new Error("A valid Visualping job id is required.");
  }

  const config = await loadPublicConfig();
  if (payload.enabled === false) {
    await removeTrackedJob(jobId);
    return {
      ok: true,
      enabled: false,
      jobId,
    };
  }

  const url = payload.job?.url;
  if (!isSupportedTabUrl(url)) {
    throw new Error("Cookie sync only works for http:// or https:// jobs.");
  }

  if (!(await hasSitePermission(url))) {
    throw new Error("Site permission is required to read and sync that page's cookies.");
  }

  const session = await requireSession(config);
  const cookies = await getCookiesForPage(url);
  const now = new Date().toISOString();
  const trackedJob = await getTrackedJob(jobId);
  const host = getHostname(url);

  const workspaceId = getPreferredWorkspaceId(session);
  await updateVisualpingJob(
    config,
    session.token,
    jobId,
    buildCookieSyncPayload({ jobId, cookies, workspaceId })
  );

  await upsertTrackedJob({
    ...trackedJob,
    jobId,
    url,
    title: payload.job?.description || trackedJob?.title || host,
    description: payload.job?.description || trackedJob?.description || host,
    host,
    interval: payload.job?.interval ?? trackedJob?.interval ?? null,
    labelIds: normalizeLabelIds(payload.job?.labelIds ?? trackedJob?.labelIds),
    mode: payload.job?.mode ?? trackedJob?.mode ?? null,
    createdAt: trackedJob?.createdAt ?? now,
    lastSyncedAt: now,
    cookieCount: cookies.length,
    status: STATUS.synced,
    lastError: null,
  });

  return {
    ok: true,
    enabled: true,
    jobId,
    cookieCount: cookies.length,
  };
}

async function syncCookiesForJob(jobId) {
  const trackedJob = await getTrackedJob(jobId);
  if (!trackedJob) {
    return;
  }

  const hasPermission = await hasSitePermission(trackedJob.url);
  if (!hasPermission) {
    await updateTrackedJob(jobId, {
      status: STATUS.error,
      lastError: "Missing site permission for cookie sync.",
    });
    return;
  }

  const config = await loadPublicConfig();
  const session = await checkVisualpingSession(config);
  if (!session.loggedIn || !session.token) {
    await updateTrackedJob(jobId, {
      status: STATUS.error,
      lastError: "Visualping session is missing or expired.",
    });
    return;
  }

  const cookies = await getCookiesForPage(trackedJob.url);
  const workspaceId = getPreferredWorkspaceId(session);
  await updateVisualpingJob(
    config,
    session.token,
    trackedJob.jobId,
    buildCookieSyncPayload({ jobId, cookies, workspaceId })
  );

  await updateTrackedJob(jobId, {
    status: STATUS.synced,
    cookieCount: cookies.length,
    lastSyncedAt: new Date().toISOString(),
    lastError: null,
  });
}

function queueCookieSync(jobId) {
  const key = String(jobId);
  const currentState = syncState.get(key) ?? {
    running: false,
    pending: false,
  };

  currentState.pending = true;
  syncState.set(key, currentState);

  if (!currentState.running) {
    void drainCookieSyncQueue(key);
  }
}

async function drainCookieSyncQueue(jobId) {
  const state = syncState.get(jobId);
  if (!state) {
    return;
  }

  state.running = true;

  while (state.pending) {
    state.pending = false;

    try {
      await syncCookiesForJob(jobId);
    } catch (error) {
      console.error(`Cookie sync failed for job ${jobId}.`, error);
      await updateTrackedJob(jobId, {
        status: STATUS.error,
        lastError: formatError(error),
      });
    }
  }

  state.running = false;

  if (!state.pending) {
    syncState.delete(jobId);
  }
}

chrome.cookies.onChanged.addListener(async ({ cookie }) => {
  try {
    const jobs = Object.values(await getTrackedJobs());
    for (const job of jobs) {
      if (cookieMatchesHost(cookie.domain, job.host)) {
        queueCookieSync(job.jobId);
      }
    }
  } catch (error) {
    console.error("Failed to process cookie change.", error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "popup-state") {
      sendResponse(await buildPopupState());
      return;
    }

    if (message?.type === "create-job") {
      try {
        sendResponse(await createJobForActiveTab(message.payload ?? {}));
      } catch (error) {
        sendResponse({
          ok: false,
          error: formatError(error),
        });
      }
      return;
    }

    if (message?.type === "jobs-list") {
      try {
        sendResponse(await listJobsForPopup(message.payload ?? {}));
      } catch (error) {
        sendResponse({
          ok: false,
          error: formatError(error),
        });
      }
      return;
    }

    if (message?.type === "toggle-cookie-sync") {
      try {
        sendResponse(await toggleCookieSyncForJob(message.payload ?? {}));
      } catch (error) {
        sendResponse({
          ok: false,
          error: formatError(error),
        });
      }
      return;
    }

    sendResponse({
      ok: false,
      error: "Unknown message type.",
    });
  })();

  return true;
});
