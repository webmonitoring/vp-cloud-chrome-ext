const uiState = {
  activeTab: "create",
  popupState: null,
  createFlash: null,
  jobsFlash: null,
  jobs: {
    pageIndex: 0,
    pageSize: 10,
    nameFilter: "",
    labelId: "",
    cookieSyncFilter: "all",
    isLoading: false,
    data: null,
    error: "",
    togglingJobId: null,
    openingScriptJobId: null,
  },
  createWorkspaceId: "",
};

let jobsRequestId = 0;
let jobsSearchTimer;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character];
  });
}

function formatInterval(options, value) {
  return options.find((option) => option.value === String(value))?.label ?? (value ? `${value} minutes` : "No interval");
}

function formatTimestamp(value) {
  if (!value) {
    return "Not synced yet";
  }

  return new Date(value).toLocaleString();
}

function renderMessage(message) {
  if (!message?.text) {
    return "";
  }

  const typeClass = message.type === "error" ? "message--error" : "message--success";
  return `<p class="message ${typeClass}">${escapeHtml(message.text)}</p>`;
}

function renderTrackedJobs(trackedJobs, frequencyOptions) {
  if (!trackedJobs?.length) {
    return "";
  }

  const items = trackedJobs
    .map((job) => {
      const error = job.lastError ? `<p class="job-item__error">${escapeHtml(job.lastError)}</p>` : "";
      return `
        <li class="job-item">
          <p class="job-item__title">Job #${escapeHtml(String(job.jobId))}</p>
          <p class="job-item__meta">${escapeHtml(job.importantDefinition || "Cookie sync enabled")}</p>
          <p class="job-item__meta">${escapeHtml(formatInterval(frequencyOptions, job.interval))} · ${escapeHtml(String(job.cookieCount ?? 0))} cookies · ${escapeHtml(formatTimestamp(job.lastSyncedAt))}</p>
          ${error}
        </li>
      `;
    })
    .join("");

  return `
    <section class="jobs-card">
      <p class="jobs-card__label">Tracked On This Site</p>
      <ul class="job-list">${items}</ul>
    </section>
  `;
}

function renderLoggedOut(state, contextLabel) {
  return `
    <div class="empty-state">
      <p class="empty-state__title">${escapeHtml(contextLabel)}</p>
      <p class="empty-state__text">You need an active Visualping session before this extension can create jobs or manage cookie sync.</p>
      <button id="open-login" class="button-primary" type="button">Open Visualping Login</button>
    </div>
  `;
}

function renderCreateTab() {
  const state = uiState.popupState;
  if (!state) {
    return `<p class="status">Loading…</p>`;
  }

  if (!state.loggedIn) {
    return renderLoggedOut(state, "Visualping Login Required");
  }

  if (!state.supportedPage) {
    return `
      <div class="empty-state">
        <p class="empty-state__title">Open A Website Page</p>
        <p class="empty-state__text">The create tab works on a regular website page. The jobs tab is still available for browsing and cookie sync management.</p>
      </div>
    `;
  }

  const trackedJobsMarkup = renderTrackedJobs(state.trackedJobs, state.frequencyOptions);
  const frequencyOptions = state.frequencyOptions
    .map((option) => {
      const selected = option.value === "1440" ? "selected" : "";
      return `<option value="${escapeHtml(option.value)}" ${selected}>${escapeHtml(option.label)}</option>`;
    })
    .join("");
  const workspaceOptions = (state.workspaces ?? [])
    .map((workspace) => {
      const selected = String(workspace.id) === String(uiState.createWorkspaceId) ? "selected" : "";
      return `<option value="${escapeHtml(String(workspace.id))}" ${selected}>${escapeHtml(workspace.name)}</option>`;
    })
    .join("");
  const workspaceSelect = workspaceOptions
    ? `<label>
        Workspace
        <select id="create-workspace">${workspaceOptions}</select>
      </label>`
    : `<p class="muted">Workspace lookup currently unavailable.</p>`;

  return `
    <section class="page-card">
      <p class="page-card__label">Current Page</p>
      <p class="page-card__title">${escapeHtml(state.tab.title)}</p>
      <p class="page-card__url">${escapeHtml(state.tab.url)}</p>
    </section>

    <form id="create-job-form">
      <label>
        Alert me when
        <textarea id="alert-condition" name="alertCondition" placeholder="Price drops below $500, stock is back, a new job posting appears…" required></textarea>
      </label>

      ${workspaceSelect}

      <label>
        Frequency of checking
        <select id="interval" name="interval">${frequencyOptions}</select>
      </label>

      <button id="submit-button" class="button-primary" type="submit">Create Monitoring Job</button>
    </form>

    ${renderMessage(uiState.createFlash)}
    ${trackedJobsMarkup}
  `;
}

function renderJobBadges(job) {
  if (!job.labels?.length) {
    return "";
  }

  const badges = job.labels
    .map((label) => {
      return `<span class="badge">${escapeHtml(label.name)}</span>`;
    })
    .join("");

  return `<div class="badge-list">${badges}</div>`;
}

function renderJobsList(jobs, frequencyOptions) {
  if (!jobs.length) {
    return `
      <div class="empty-state">
        <p class="empty-state__title">No Jobs Match</p>
        <p class="empty-state__text">Try a different name, tag, or cookie sync filter.</p>
      </div>
    `;
  }

  const items = jobs
    .map((job) => {
      const intervalLabel = job.interval ? formatInterval(frequencyOptions, job.interval) : "Interval unavailable";
      const toggleLabel = job.cookieSyncEnabled ? "Cookie Sync On" : "Cookie Sync Off";
      const toggleClass = job.cookieSyncEnabled ? "is-on" : "is-off";
      const syncStatus = job.cookieSyncEnabled
        ? `Cookie sync active · ${job.cookieCount ?? 0} cookies · ${formatTimestamp(job.lastSyncedAt)}`
        : "Cookie sync is off in this extension";
      const jobState = job.isActive === false ? "Paused" : "Active";
      const meta = [intervalLabel, job.mode, jobState].filter(Boolean).join(" · ");
      const error = job.lastError ? `<p class="job-item__error">${escapeHtml(job.lastError)}</p>` : "";
      const openingScript = uiState.jobs.openingScriptJobId === job.id;
      const scriptHint =
        "If the monitored job needs clicks or actions to end up in the state that you want it to be, use this to add actions";

      return `
        <li class="job-item">
          <div class="job-item__top">
            <div class="job-item__content">
              <p class="job-item__title">${escapeHtml(job.description || `Job #${job.id}`)}</p>
              <p class="job-item__url">${escapeHtml(job.url)}</p>
              <p class="job-item__meta">${escapeHtml(meta)}</p>
              ${renderJobBadges(job)}
              <p class="job-item__status">${escapeHtml(syncStatus)}</p>
              ${error}
            </div>
            <div class="job-item__actions">
              <div class="job-item__script-action">
                <button
                  class="button-ghost button-script-action"
                  data-script-job-id="${escapeHtml(String(job.id))}"
                  type="button"
                  ${openingScript ? "disabled" : ""}
                >
                  ${escapeHtml(openingScript ? "Opening…" : "Add Script Action")}
                </button>
                <span class="info-hint" title="${escapeHtml(scriptHint)}" aria-label="${escapeHtml(scriptHint)}" tabindex="0">?</span>
              </div>
              <button
                class="button-toggle ${toggleClass}"
                data-job-id="${escapeHtml(String(job.id))}"
                type="button"
                ${uiState.jobs.togglingJobId === job.id ? "disabled" : ""}
              >
                ${escapeHtml(uiState.jobs.togglingJobId === job.id ? "Updating…" : toggleLabel)}
              </button>
            </div>
          </div>
        </li>
      `;
    })
    .join("");

  return `<ul class="job-list">${items}</ul>`;
}

function renderJobsTab() {
  const state = uiState.popupState;
  if (!state) {
    return `<p class="status">Loading…</p>`;
  }

  if (!state.loggedIn) {
    return renderLoggedOut(state, "Visualping Login Required");
  }

  const labels = uiState.jobs.data?.availableLabels ?? [];
  const labelOptions = [
    `<option value="">All tags</option>`,
    ...labels.map((label) => {
      const selected = String(label.id) === String(uiState.jobs.labelId) ? "selected" : "";
      return `<option value="${escapeHtml(String(label.id))}" ${selected}>${escapeHtml(label.name)}</option>`;
    }),
  ].join("");

  const data = uiState.jobs.data;
  const totalPages = data?.totalPages ?? 0;
  const pageLabel = totalPages > 0 ? `Page ${uiState.jobs.pageIndex + 1} of ${totalPages}` : "No pages";
  const loadingMessage = uiState.jobs.isLoading && !data ? `<p class="status">Loading jobs…</p>` : "";

  return `
    <section class="filter-card">
      <p class="filter-card__label">Job Filters</p>
      <div class="jobs-toolbar">
        <label>
          Name
          <input id="jobs-name-filter" type="text" value="${escapeHtml(uiState.jobs.nameFilter)}" placeholder="Search by job name or URL" />
        </label>
        <label>
          Tag
          <select id="jobs-tag-filter">${labelOptions}</select>
        </label>
        <label>
          Cookie Sync
          <select id="jobs-sync-filter">
            <option value="all" ${uiState.jobs.cookieSyncFilter === "all" ? "selected" : ""}>All jobs</option>
            <option value="on" ${uiState.jobs.cookieSyncFilter === "on" ? "selected" : ""}>Sync on</option>
            <option value="off" ${uiState.jobs.cookieSyncFilter === "off" ? "selected" : ""}>Sync off</option>
          </select>
        </label>
      </div>
      <p class="jobs-summary">
        ${escapeHtml(data ? `${data.totalJobs} job${data.totalJobs === 1 ? "" : "s"} found` : "Jobs will appear here once loaded.")}
      </p>
    </section>

    ${renderMessage(uiState.jobsFlash)}
    ${uiState.jobs.error ? renderMessage({ type: 'error', text: uiState.jobs.error }) : ""}
    ${loadingMessage}
    ${data ? renderJobsList(data.jobs ?? [], state.frequencyOptions) : ""}

    <div class="jobs-footer">
      <div class="pagination">
        <button id="jobs-prev-page" class="button-ghost" type="button" ${uiState.jobs.pageIndex <= 0 || uiState.jobs.isLoading ? "disabled" : ""}>Previous</button>
        <button id="jobs-next-page" class="button-ghost" type="button" ${!data || uiState.jobs.pageIndex >= Math.max(totalPages - 1, 0) || uiState.jobs.isLoading ? "disabled" : ""}>Next</button>
      </div>
      <span class="pagination__info">${escapeHtml(pageLabel)}</span>
    </div>
  `;
}

function renderApp() {
  const app = document.querySelector("#app");
  if (!app) {
    return;
  }

  const focusedId = document.activeElement?.id ?? null;

  const createActive = uiState.activeTab === "create";
  app.innerHTML = `
    <div class="tabs">
      <button class="tab-button ${createActive ? "is-active" : ""}" data-tab="create" type="button">Create</button>
      <button class="tab-button ${!createActive ? "is-active" : ""}" data-tab="jobs" type="button">Jobs</button>
    </div>
    ${createActive ? renderCreateTab() : renderJobsTab()}
  `;

  bindEvents();

  if (focusedId) {
    document.querySelector(`#${focusedId}`)?.focus();
  }
}

function getCurrentJobFromList(jobId) {
  return uiState.jobs.data?.jobs?.find((job) => String(job.id) === String(jobId)) ?? null;
}

async function ensureTabPermission(url) {
  const origin = new URL(url).origin;
  const originPattern = `${origin}/*`;
  const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
  if (!hasPermission) {
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) {
      throw new Error("Site permission is required to read and sync that page's cookies.");
    }
  }
}

async function refreshPopupState() {
  const state = await chrome.runtime.sendMessage({ type: "popup-state" });
  uiState.popupState = state;

  if (!state?.supportedPage && state?.loggedIn && uiState.activeTab === "create") {
    uiState.activeTab = "jobs";
  }

  const availableWorkspaces = (state?.workspaces ?? []).map((workspace) => workspace.id);
  if (!availableWorkspaces.includes(Number(uiState.createWorkspaceId))) {
    const defaultId = state?.preferredWorkspaceId ?? availableWorkspaces[0] ?? "";
    uiState.createWorkspaceId = defaultId ? String(defaultId) : "";
  }
}

async function loadJobsPage() {
  if (!uiState.popupState?.loggedIn) {
    uiState.jobs.data = null;
    uiState.jobs.error = "";
    renderApp();
    return;
  }

  const requestId = ++jobsRequestId;
  uiState.jobs.isLoading = true;
  uiState.jobs.error = "";
  renderApp();

  const response = await chrome.runtime.sendMessage({
    type: "jobs-list",
    payload: {
      pageIndex: uiState.jobs.pageIndex,
      pageSize: uiState.jobs.pageSize,
      nameFilter: uiState.jobs.nameFilter,
      labelId: uiState.jobs.labelId,
      cookieSyncFilter: uiState.jobs.cookieSyncFilter,
    },
  });

  if (requestId !== jobsRequestId) {
    return;
  }

  uiState.jobs.isLoading = false;

  if (!response?.ok) {
    uiState.jobs.error = response?.error ?? "Failed to load jobs.";
    renderApp();
    return;
  }

  if (uiState.jobs.pageIndex > 0 && response.totalPages > 0 && uiState.jobs.pageIndex >= response.totalPages) {
    uiState.jobs.pageIndex = Math.max(response.totalPages - 1, 0);
    await loadJobsPage();
    return;
  }

  uiState.jobs.data = response;
  renderApp();
}

async function handleCreateJobSubmit(event) {
  event.preventDefault();

  const app = document.querySelector("#app");
  const alertCondition = app.querySelector("#alert-condition")?.value?.trim() ?? "";
  const interval = app.querySelector("#interval")?.value ?? "1440";

  if (!alertCondition) {
    uiState.createFlash = {
      type: 'error',
      text: '"Alert me when" cannot be empty.',
    };
    renderApp();
    return;
  }

  const tabUrl = uiState.popupState?.tab?.url;
  if (tabUrl) {
    try {
      await ensureTabPermission(tabUrl);
    } catch (error) {
      uiState.createFlash = {
        type: 'error',
        text: error instanceof Error ? error.message : 'Site permission required.',
      };
      renderApp();
      return;
    }
  }

  const submitButton = app.querySelector("#submit-button");
  submitButton.disabled = true;
  submitButton.textContent = "Creating…";

  const workspaceIdValue = Number(uiState.createWorkspaceId);
  const workspaceId =
    Number.isFinite(workspaceIdValue) && workspaceIdValue > 0 ? workspaceIdValue : undefined;

  const response = await chrome.runtime.sendMessage({
    type: "create-job",
    payload: {
      alertCondition,
      interval,
      workspaceId,
    },
  });

  if (!response?.ok) {
    uiState.createFlash = {
      type: 'error',
      text: response?.error ?? "Job creation failed.",
    };
    renderApp();
    return;
  }

  uiState.createFlash = {
    type: "success",
    text: `Created job #${response.jobId}. Cookie sync is active with ${response.cookieCount} cookies.`,
  };
  uiState.jobsFlash = {
    type: "success",
    text: `Job #${response.jobId} is now available in the jobs tab.`,
  };

  await refreshPopupState();
  await loadJobsPage();
}

async function handleOpenLogin() {
  await chrome.tabs.create({ url: uiState.popupState.loginUrl });
  window.close();
}

async function handleTabChange(nextTab) {
  uiState.activeTab = nextTab;
  renderApp();

  if (nextTab === "jobs" && uiState.popupState?.loggedIn && !uiState.jobs.data && !uiState.jobs.isLoading) {
    await loadJobsPage();
  }
}

async function handleToggleCookieSync(jobId) {
  const job = getCurrentJobFromList(jobId);
  if (!job) {
    return;
  }

  const enabling = !job.cookieSyncEnabled;

  if (enabling) {
    try {
      await ensureTabPermission(job.url);
    } catch (error) {
      uiState.jobsFlash = {
        type: 'error',
        text: error instanceof Error ? error.message : "Site permission required.",
      };
      renderApp();
      return;
    }
  }

  uiState.jobs.togglingJobId = job.id;
  uiState.jobsFlash = null;
  renderApp();

  const response = await chrome.runtime.sendMessage({
    type: "toggle-cookie-sync",
    payload: {
      enabled: enabling,
      job,
    },
  });

  uiState.jobs.togglingJobId = null;

  if (!response?.ok) {
    uiState.jobsFlash = {
      type: 'error',
      text: response?.error ?? "Cookie sync update failed.",
    };
    renderApp();
    return;
  }

  uiState.jobsFlash = {
    type: "success",
    text: response.enabled
      ? `Cookie sync enabled for job #${job.id}.`
      : `Cookie sync disabled for job #${job.id}.`,
  };

  await refreshPopupState();
  await loadJobsPage();
}

async function handleOpenScriptAction(jobId) {
  const job = getCurrentJobFromList(jobId);
  if (!job) {
    return;
  }

  uiState.jobs.openingScriptJobId = job.id;
  uiState.jobsFlash = null;
  renderApp();

  let panelOpenedFromGesture = false;
  let panelGestureError = "";
  if (chrome.sidePanel?.open) {
    try {
      await chrome.sidePanel.open({
        windowId: chrome.windows.WINDOW_ID_CURRENT,
      });
      panelOpenedFromGesture = true;
    } catch (error) {
      panelGestureError = error instanceof Error ? error.message : String(error);
    }
  }

  try {
    await ensureTabPermission(job.url);
  } catch (error) {
    uiState.jobsFlash = {
      type: "error",
      text: error instanceof Error ? error.message : "Site permission required.",
    };
    uiState.jobs.openingScriptJobId = null;
    renderApp();
    return;
  }

  const focusedWindow = await chrome.windows.getLastFocused({ populate: false });
  const targetWindowId = focusedWindow?.id;

  const response = await chrome.runtime.sendMessage({
    type: "open-script-generator",
    payload: {
      jobId: job.id,
      url: job.url,
      description: job.description,
      ...(Number.isInteger(targetWindowId) ? { windowId: targetWindowId } : {}),
      openPanel: !panelOpenedFromGesture,
    },
  });

  uiState.jobs.openingScriptJobId = null;

  if (!response?.ok) {
    const debugMessage = panelGestureError
      ? ` Direct open failed: ${panelGestureError}`
      : "";
    uiState.jobsFlash = {
      type: "error",
      text: `${response?.error ?? "Could not open the script generator."}${debugMessage}`,
    };
    renderApp();
    return;
  }

  window.close();
}

function scheduleJobsSearch(value) {
  uiState.jobs.nameFilter = value;
  uiState.jobs.pageIndex = 0;

  window.clearTimeout(jobsSearchTimer);
  jobsSearchTimer = window.setTimeout(() => {
    void loadJobsPage();
  }, 250);
}

function bindEvents() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      void handleTabChange(button.dataset.tab);
    });
  });

  document.querySelector("#open-login")?.addEventListener("click", () => {
    void handleOpenLogin();
  });

  document.querySelector("#create-job-form")?.addEventListener("submit", (event) => {
    void handleCreateJobSubmit(event);
  });

  document.querySelector("#create-workspace")?.addEventListener("change", (event) => {
    uiState.createWorkspaceId = event.target.value;
  });

  document.querySelector("#jobs-name-filter")?.addEventListener("input", (event) => {
    scheduleJobsSearch(event.target.value);
  });

  document.querySelector("#jobs-tag-filter")?.addEventListener("change", (event) => {
    uiState.jobs.labelId = event.target.value;
    uiState.jobs.pageIndex = 0;
    void loadJobsPage();
  });

  document.querySelector("#jobs-sync-filter")?.addEventListener("change", (event) => {
    uiState.jobs.cookieSyncFilter = event.target.value;
    uiState.jobs.pageIndex = 0;
    void loadJobsPage();
  });

  document.querySelector("#jobs-prev-page")?.addEventListener("click", () => {
    if (uiState.jobs.pageIndex <= 0) {
      return;
    }

    uiState.jobs.pageIndex -= 1;
    void loadJobsPage();
  });

  document.querySelector("#jobs-next-page")?.addEventListener("click", () => {
    uiState.jobs.pageIndex += 1;
    void loadJobsPage();
  });

  document.querySelectorAll("[data-job-id]").forEach((button) => {
    button.addEventListener("click", () => {
      void handleToggleCookieSync(button.dataset.jobId);
    });
  });

  document.querySelectorAll("[data-script-job-id]").forEach((button) => {
    button.addEventListener("click", () => {
      void handleOpenScriptAction(button.dataset.scriptJobId);
    });
  });
}

async function bootstrap() {
  await refreshPopupState();
  renderApp();

  if (uiState.popupState?.loggedIn) {
    await loadJobsPage();
  }
}

bootstrap().catch((error) => {
  const app = document.querySelector("#app");
  if (!app) {
    return;
  }

  app.innerHTML = `<p class="message message--error">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
});
