import { STATUS, STORAGE_KEYS } from "./constants.js";

export async function getTrackedJobs() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.trackedJobs);
  return result[STORAGE_KEYS.trackedJobs] ?? {};
}

export async function getTrackedJob(jobId) {
  const jobs = await getTrackedJobs();
  return jobs[String(jobId)] ?? null;
}

export async function listTrackedJobsForHost(hostname) {
  const jobs = await getTrackedJobs();
  return Object.values(jobs)
    .filter((job) => job.host === hostname)
    .sort((left, right) => {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });
}

export async function listTrackedJobs() {
  const jobs = await getTrackedJobs();
  return Object.values(jobs).sort((left, right) => {
    return new Date(right.lastSyncedAt ?? right.createdAt ?? 0).getTime() - new Date(left.lastSyncedAt ?? left.createdAt ?? 0).getTime();
  });
}

export async function upsertTrackedJob(job) {
  const jobs = await getTrackedJobs();
  jobs[String(job.jobId)] = {
    status: STATUS.synced,
    cookieCount: 0,
    labelIds: [],
    ...jobs[String(job.jobId)],
    ...job,
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.trackedJobs]: jobs,
  });

  return jobs[String(job.jobId)];
}

export async function updateTrackedJob(jobId, patch) {
  const jobs = await getTrackedJobs();
  const key = String(jobId);
  if (!jobs[key]) {
    return null;
  }

  jobs[key] = {
    ...jobs[key],
    ...patch,
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.trackedJobs]: jobs,
  });

  return jobs[key];
}

export async function removeTrackedJob(jobId) {
  const jobs = await getTrackedJobs();
  const key = String(jobId);
  if (!jobs[key]) {
    return false;
  }

  delete jobs[key];

  await chrome.storage.local.set({
    [STORAGE_KEYS.trackedJobs]: jobs,
  });

  return true;
}
