import { STATUS, STORAGE_KEYS } from "./constants.js";

function isObjectRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeTrackedJobsStore(rawValue) {
  return isObjectRecord(rawValue) ? rawValue : {};
}

function normalizeAccountJobs(rawValue) {
  return isObjectRecord(rawValue) ? rawValue : {};
}

function requireAccountKey(accountKey) {
  const key = String(accountKey ?? "").trim();
  if (!key) {
    throw new Error("A Visualping account key is required for tracked jobs storage.");
  }

  return key;
}

async function readTrackedJobsStore() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.trackedJobs);
  return normalizeTrackedJobsStore(result[STORAGE_KEYS.trackedJobs]);
}

async function writeTrackedJobsStore(store) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.trackedJobs]: store,
  });
}

async function readAccountJobs(accountKey) {
  const scopeKey = requireAccountKey(accountKey);
  const store = await readTrackedJobsStore();
  const jobs = normalizeAccountJobs(store[scopeKey]);

  return {
    scopeKey,
    store,
    jobs,
  };
}

export async function getTrackedJobs(accountKey) {
  const { jobs } = await readAccountJobs(accountKey);
  return jobs;
}

export async function getTrackedJob(jobId, accountKey) {
  const jobs = await getTrackedJobs(accountKey);
  return jobs[String(jobId)] ?? null;
}

export async function listTrackedJobsForHost(hostname, accountKey) {
  const jobs = await getTrackedJobs(accountKey);
  return Object.values(jobs)
    .filter((job) => job.host === hostname)
    .sort((left, right) => {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });
}

export async function listTrackedJobs(accountKey) {
  const jobs = await getTrackedJobs(accountKey);
  return Object.values(jobs).sort((left, right) => {
    return new Date(right.lastSyncedAt ?? right.createdAt ?? 0).getTime() - new Date(left.lastSyncedAt ?? left.createdAt ?? 0).getTime();
  });
}

export async function upsertTrackedJob(job, accountKey) {
  const { scopeKey, store, jobs } = await readAccountJobs(accountKey);
  jobs[String(job.jobId)] = {
    status: STATUS.synced,
    cookieCount: 0,
    labelIds: [],
    ...jobs[String(job.jobId)],
    ...job,
  };

  await writeTrackedJobsStore({
    ...store,
    [scopeKey]: jobs,
  });

  return jobs[String(job.jobId)];
}

export async function updateTrackedJob(jobId, patch, accountKey) {
  const { scopeKey, store, jobs } = await readAccountJobs(accountKey);
  const key = String(jobId);
  if (!jobs[key]) {
    return null;
  }

  jobs[key] = {
    ...jobs[key],
    ...patch,
  };

  await writeTrackedJobsStore({
    ...store,
    [scopeKey]: jobs,
  });

  return jobs[key];
}

export async function removeTrackedJob(jobId, accountKey) {
  const { scopeKey, store, jobs } = await readAccountJobs(accountKey);
  const key = String(jobId);
  if (!jobs[key]) {
    return false;
  }

  delete jobs[key];

  await writeTrackedJobsStore({
    ...store,
    [scopeKey]: jobs,
  });

  return true;
}
