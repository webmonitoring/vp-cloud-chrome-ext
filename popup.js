const uiState = {
  activeTab: "create",
  lastMainTab: "create",
  popupState: null,
  createFlash: null,
  jobsFlash: null,
  settingsFlash: null,
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
  createPresetId: "",
  createPresetTouched: false,
  createInterval: "1440",
  createAlertCondition: "",
  lastAppliedPresetId: "",
  settings: {
    monitorSuggestionsEnabled: false,
    savingMonitorSuggestionsEnabled: false,
    backendEnv: "prod",
    canSelectBackendEnv: false,
    savingBackendEnv: false,
  },
  suggestions: {
    isLoading: false,
    hasLoaded: false,
    forUrl: "",
    items: [],
    selected: "",
    error: "",
    errorCode: "",
  },
};

const DEFAULT_CREATE_INTERVAL = "1440";

let jobsRequestId = 0;
let jobsSearchTimer;

function resetMonitorSuggestions() {
  uiState.suggestions = {
    isLoading: false,
    hasLoaded: false,
    forUrl: "",
    items: [],
    selected: "",
    error: "",
    errorCode: "",
  };
}

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
  if (!message?.text || message.type !== "error") {
    return "";
  }

  return `<p class="message message--error">${escapeHtml(message.text)}</p>`;
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

function renderMonitorSuggestions() {
  if (!uiState.settings.monitorSuggestionsEnabled) {
    return `
      <section class="suggestions-card suggestions-card--flat">
        <p class="suggestions-title"><span class="suggestions-title__spark">✦</span> Suggestions:</p>
        <p class="muted suggestions-card__status">Enable "Suggest monitoring on pages" in Settings to generate suggestions.</p>
      </section>
    `;
  }

  const { isLoading, hasLoaded, items, error } = uiState.suggestions;
  const suggestionButtons = items
    .map((suggestion) => {
      const selectedClass = uiState.suggestions.selected === suggestion ? " is-selected" : "";
      return `
        <button
          class="suggestion-pill${selectedClass}"
          type="button"
          data-monitor-suggestion="${escapeHtml(suggestion)}"
        >
          <span class="suggestion-pill__text">${escapeHtml(suggestion)}</span>
        </button>
      `;
    })
    .join("");

  const emptyMessage = hasLoaded && !isLoading && !error && !items.length ? `<p class="muted suggestions-card__status">No obvious monitor triggers found on this page.</p>` : "";
  const loadingMessage = isLoading ? `<p class="muted suggestions-card__status">Scanning this page for monitoring ideas...</p>` : "";
  const errorMessage = error ? `<p class="muted suggestions-card__status suggestions-card__status--error">${escapeHtml(error)}</p>` : "";

  return `
    <section class="suggestions-card suggestions-card--flat">
      <div class="suggestions-card__header">
        <p class="suggestions-title"><span class="suggestions-title__spark">✦</span> Suggestions:</p>
      </div>
      ${loadingMessage}
      ${errorMessage}
      ${suggestionButtons ? `<div class="suggestion-pill-list">${suggestionButtons}</div>` : ""}
      ${emptyMessage}
    </section>
  `;
}

function resolveDefaultPreset(presets, selectedWorkspaceId) {
  if (!Array.isArray(presets) || !presets.length) {
    return null;
  }

  const defaultPresetForWorkspace =
    presets.find((preset) => {
      if (!preset?.isDefault) {
        return false;
      }

      const workspaceIds = Array.isArray(preset.workspaceIds) ? preset.workspaceIds : [];
      if (!workspaceIds.length || !Number.isFinite(selectedWorkspaceId) || selectedWorkspaceId <= 0) {
        return true;
      }

      return workspaceIds.some((id) => Number(id) === selectedWorkspaceId);
    }) ?? null;

  return defaultPresetForWorkspace ?? presets.find((preset) => preset.isDefault) ?? null;
}

function applyPresetDerivedFields(state) {
  const presets = Array.isArray(state?.savedJobPresets) ? state.savedJobPresets : [];
  const id = uiState.createPresetId;
  if (!id || !presets.length) {
    return;
  }

  const selectedPreset = presets.find((preset) => String(preset.id) === String(id));
  if (!selectedPreset) {
    return;
  }

  const selectedPresetId = String(selectedPreset.id);
  if (uiState.lastAppliedPresetId === selectedPresetId) {
    return;
  }

  if (selectedPreset.importantDefinition) {
    uiState.createAlertCondition = String(selectedPreset.importantDefinition);
  }
  if (selectedPreset.interval) {
    uiState.createInterval = String(selectedPreset.interval);
  }
  uiState.lastAppliedPresetId = selectedPresetId;
}

function syncCreatePresetSelection(state) {
  if (!state?.isBusinessUser || !(state.workspaces ?? []).length) {
    return;
  }

  const presets = Array.isArray(state.savedJobPresets) ? state.savedJobPresets : [];
  if (!presets.length) {
    return;
  }

  const selectedWorkspaceId = Number(uiState.createWorkspaceId || state.preferredWorkspaceId);

  if (!uiState.createPresetTouched && !uiState.createPresetId) {
    const defaultPreset = resolveDefaultPreset(presets, selectedWorkspaceId);
    if (defaultPreset) {
      uiState.createPresetId = String(defaultPreset.id);
    }
  }

  applyPresetDerivedFields(state);
}

function renderSavedPresetSelect(state) {
  if (!state?.isBusinessUser || !(state.workspaces ?? []).length) {
    return "";
  }

  const presets = Array.isArray(state.savedJobPresets) ? state.savedJobPresets : [];
  if (!presets.length) {
    return "";
  }

  const selectedWorkspaceId = Number(uiState.createWorkspaceId || state.preferredWorkspaceId);

  const optionsHtml = presets
    .map((preset) => {
      const selected = String(preset.id) === String(uiState.createPresetId) ? "selected" : "";
      const workspaceIds = Array.isArray(preset.workspaceIds) ? preset.workspaceIds : [];
      const isWorkspaceDefault =
        Boolean(preset.isDefault) &&
        (!workspaceIds.length ||
          !Number.isFinite(selectedWorkspaceId) ||
          selectedWorkspaceId <= 0 ||
          workspaceIds.some((id) => Number(id) === selectedWorkspaceId));
      const label = isWorkspaceDefault ? `${preset.name} (default)` : preset.name;
      return `<option value="${escapeHtml(String(preset.id))}" ${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");

  return `
    <div class="preset-picker">
      <label class="form-row-select">
        <span class="form-row-select__label"><span class="form-row-select__icon">⚙️</span> Presets:</span>
        <select id="create-preset">
          <option value="">Select a preset</option>
          ${optionsHtml}
        </select>
      </label>
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

  const frequencyOptions = state.frequencyOptions
    .map((option) => {
      const selectedValue = uiState.createInterval || "1440";
      const selected = option.value === selectedValue ? "selected" : "";
      return `<option value="${escapeHtml(option.value)}" ${selected}>${escapeHtml(option.label)}</option>`;
    })
    .join("");
  const workspaces = state.workspaces ?? [];
  const workspaceOptions = workspaces
    .map((workspace) => {
      const selected = String(workspace.id) === String(uiState.createWorkspaceId) ? "selected" : "";
      return `<option value="${escapeHtml(String(workspace.id))}" ${selected}>${escapeHtml(workspace.name)}</option>`;
    })
    .join("");
  const workspaceSelect = state.isBusinessUser
    ? workspaceOptions
      ? `
        <label class="form-row-select">
          <span class="form-row-select__label"><span class="form-row-select__icon">🧰</span> Workspace:</span>
          <select id="create-workspace">${workspaceOptions}</select>
        </label>
      `
      : `
        <label class="form-row-select form-row-select--disabled">
          <span class="form-row-select__label"><span class="form-row-select__icon">🧰</span> Workspace:</span>
          <select id="create-workspace" disabled><option>Unavailable</option></select>
        </label>
      `
    : "";
  const presetSelect = renderSavedPresetSelect(state);
  const userEmail = String(state.userEmail ?? "").trim();
  const identityLabel = userEmail || "Signed in";

  return `
    <form id="create-job-form" class="create-form">
      <label class="create-form__label">
        Alert me when:
        <div class="important-definition-input">
          <textarea id="alert-condition" name="alertCondition" placeholder="Enter a condition or pick from below" required>${escapeHtml(uiState.createAlertCondition)}</textarea>
          <span class="important-definition-input__pulse" aria-hidden="true"></span>
        </div>
      </label>

      ${renderMonitorSuggestions()}

      <label class="form-row-select">
        <span class="form-row-select__label"><span class="form-row-select__icon">🕒</span> Check:</span>
        <select id="interval" name="interval">${frequencyOptions}</select>
      </label>

      ${workspaceSelect}
      ${presetSelect}

      <button id="submit-button" class="button-primary button-primary--main" type="submit">Start monitoring</button>
    </form>

    ${renderMessage(uiState.createFlash)}
    <section class="create-footer">
      <div class="create-footer__identity">
        <span class="create-footer__avatar"></span>
        <span class="create-footer__email">${escapeHtml(identityLabel)}</span>
      </div>
    </section>
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

function renderJobsList(jobs) {
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
      const toggleClass = job.cookieSyncEnabled ? "is-on" : "is-off";
      const openingScript = uiState.jobs.openingScriptJobId === job.id;
      const scriptHint = "If the monitored job needs clicks or actions to end up in the state that you want it to be, use this to add actions";
      const titleText = String(job.description || `Job #${job.id}`).trim();
      const scriptTitle = `Add script action. ${scriptHint}`;
      const cookieTitle = job.cookieSyncEnabled ? "Cookie sync on" : "Cookie sync off";

      return `
        <li class="job-item">
          <div class="job-item__top job-item__top--compact">
            <div class="job-item__content job-item__content--compact">
              <p class="job-item__title job-item__title--compact" title="${escapeHtml(job.url)}">${escapeHtml(titleText)}</p>
            </div>
            <div class="job-item__actions job-item__actions--compact">
              <button
                class="job-icon-button job-icon-button--script"
                data-script-job-id="${escapeHtml(String(job.id))}"
                type="button"
                title="${escapeHtml(scriptTitle)}"
                aria-label="${escapeHtml(scriptTitle)}"
                ${openingScript ? "disabled" : ""}
              >
                🔧
              </button>
              <button
                class="job-icon-button job-icon-button--cookie ${toggleClass}"
                data-job-id="${escapeHtml(String(job.id))}"
                type="button"
                title="${escapeHtml(cookieTitle)}"
                aria-label="${escapeHtml(cookieTitle)}"
                ${uiState.jobs.togglingJobId === job.id ? "disabled" : ""}
              >
                🍪
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
    ${uiState.jobs.error ? renderMessage({ type: "error", text: uiState.jobs.error }) : ""}
    ${loadingMessage}
    ${data ? renderJobsList(data.jobs ?? []) : ""}

    <div class="jobs-footer">
      <div class="pagination">
        <button id="jobs-prev-page" class="button-ghost" type="button" ${uiState.jobs.pageIndex <= 0 || uiState.jobs.isLoading ? "disabled" : ""}>Previous</button>
        <button id="jobs-next-page" class="button-ghost" type="button" ${!data || uiState.jobs.pageIndex >= Math.max(totalPages - 1, 0) || uiState.jobs.isLoading ? "disabled" : ""}>Next</button>
      </div>
      <span class="pagination__info">${escapeHtml(pageLabel)}</span>
    </div>
  `;
}

function renderSettingsTab() {
  if (!uiState.popupState) {
    return `<p class="status">Loading…</p>`;
  }

  const disabled = uiState.settings.savingMonitorSuggestionsEnabled ? "disabled" : "";
  const backendEnvDisabled = uiState.settings.savingBackendEnv ? "disabled" : "";
  const backendEnvOptions = (uiState.popupState.backendEnvOptions ?? [])
    .map((option) => {
      const value = String(option?.value ?? "").trim();
      const label = String(option?.label ?? value).trim() || value;
      if (!value) {
        return "";
      }
      const selected = value === uiState.settings.backendEnv ? "selected" : "";
      return `<option value="${escapeHtml(value)}" ${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");
  const backendEnvSection = uiState.settings.canSelectBackendEnv
    ? `
      <label>
        Backend Environment
        <select id="backend-env-select" ${backendEnvDisabled}>
          ${backendEnvOptions}
        </select>
      </label>
      <p class="muted settings-card__hint">Use this only for extension development. Production installs always use Production backend.</p>
    `
    : "";

  return `
    <section class="filter-card settings-card">
      <p class="filter-card__label">Settings</p>
      ${backendEnvSection}
      <label class="settings-toggle">
        <input
          id="monitor-suggestions-enabled"
          type="checkbox"
          ${uiState.settings.monitorSuggestionsEnabled ? "checked" : ""}
          ${disabled}
        />
        <span>Suggest monitoring on pages</span>
      </label>
      <p class="muted settings-card__hint">When enabled, the extension requests all-sites access and suggests useful "notify me when..." conditions based on page text.</p>
    </section>
    ${renderMessage(uiState.settingsFlash)}
  `;
}

function renderApp() {
  const app = document.querySelector("#app");
  if (!app) {
    return;
  }

  const focusedId = document.activeElement?.id ?? null;

  const createActive = uiState.activeTab === "create";
  const jobsActive = uiState.activeTab === "jobs";
  const settingsActive = uiState.activeTab === "settings";
  const tabContentClass = createActive ? "tab-content tab-content--create" : jobsActive ? "tab-content tab-content--jobs" : "tab-content tab-content--settings";
  app.innerHTML = `
    <div class="topbar">
      <div class="topbar__left">
        <img class="topbar__logo" src="icons/logo.svg" alt="Visualping" />
        <div class="tabs">
          <button class="tab-button ${createActive ? "is-active" : ""}" data-tab="create" type="button">Create</button>
          <button class="tab-button ${jobsActive ? "is-active" : ""}" data-tab="jobs" type="button">Jobs</button>
        </div>
      </div>
      <button
        id="settings-toggle"
        class="settings-button ${settingsActive ? "is-active" : ""}"
        type="button"
        aria-label="Settings"
        title="Settings"
      >
        ⚙
      </button>
    </div>
    <div class="topbar-divider"></div>
    <div class="${tabContentClass}">
      ${createActive ? renderCreateTab() : jobsActive ? renderJobsTab() : renderSettingsTab()}
    </div>
  `;

  bindEvents();

  if (focusedId) {
    document.querySelector(`#${focusedId}`)?.focus();
  }
}

function getCurrentJobFromList(jobId) {
  return uiState.jobs.data?.jobs?.find((job) => String(job.id) === String(jobId)) ?? null;
}

function isSupportedTabUrl(url) {
  const value = String(url ?? "");
  return value.startsWith("http://") || value.startsWith("https://");
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

function applyMonitorSuggestion(value) {
  const suggestion = String(value ?? "").trim();
  if (!suggestion) {
    return;
  }

  uiState.createAlertCondition = suggestion;
  uiState.suggestions.selected = suggestion;
  renderApp();

  const textarea = document.querySelector("#alert-condition");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    return;
  }

  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

async function loadMonitorSuggestions({ forceRefresh = false } = {}) {
  if (!uiState.settings.monitorSuggestionsEnabled) {
    resetMonitorSuggestions();
    renderApp();
    return;
  }

  const state = uiState.popupState;
  const tabUrl = state?.tab?.url ?? "";
  if (!state?.loggedIn || !state?.supportedPage || !tabUrl) {
    resetMonitorSuggestions();
    renderApp();
    return;
  }

  if (!forceRefresh && uiState.suggestions.hasLoaded && uiState.suggestions.forUrl === tabUrl) {
    return;
  }

  uiState.suggestions.isLoading = true;
  uiState.suggestions.error = "";
  uiState.suggestions.errorCode = "";
  uiState.suggestions.forUrl = tabUrl;
  renderApp();

  const response = await chrome.runtime.sendMessage({
    type: "monitor-suggestions",
    payload: {
      forceRefresh,
    },
  });

  if (uiState.popupState?.tab?.url !== tabUrl) {
    return;
  }

  uiState.suggestions.isLoading = false;
  uiState.suggestions.hasLoaded = true;

  if (!response?.ok) {
    uiState.suggestions.items = [];
    uiState.suggestions.error = response?.error ?? "Could not generate monitoring suggestions.";
    uiState.suggestions.errorCode = String(response?.errorCode ?? "");
    renderApp();
    return;
  }

  uiState.suggestions.items = Array.isArray(response.suggestions) ? response.suggestions.map((value) => String(value ?? "").trim()).filter(Boolean) : [];
  if (!uiState.suggestions.items.includes(uiState.suggestions.selected)) {
    uiState.suggestions.selected = "";
  }
  uiState.suggestions.error = "";
  uiState.suggestions.errorCode = "";
  renderApp();
}

async function refreshPopupState() {
  const previousTabUrl = uiState.popupState?.tab?.url ?? "";
  const state = await chrome.runtime.sendMessage({ type: "popup-state" });
  uiState.popupState = state;
  uiState.settings.monitorSuggestionsEnabled = Boolean(state?.monitorSuggestionsEnabled);
  uiState.settings.backendEnv = String(state?.backendEnv ?? "prod");
  uiState.settings.canSelectBackendEnv = state?.canSelectBackendEnv === true;
  const nextTabUrl = state?.tab?.url ?? "";

  if (!state?.supportedPage && state?.loggedIn && uiState.activeTab === "create") {
    uiState.activeTab = "jobs";
  }

  if (previousTabUrl !== nextTabUrl) {
    resetMonitorSuggestions();
  }

  if (!uiState.settings.monitorSuggestionsEnabled) {
    resetMonitorSuggestions();
  }

  const availableWorkspaces = (state?.workspaces ?? []).map((workspace) => workspace.id);
  if (!availableWorkspaces.includes(Number(uiState.createWorkspaceId))) {
    const defaultId = state?.preferredWorkspaceId ?? availableWorkspaces[0] ?? "";
    uiState.createWorkspaceId = defaultId ? String(defaultId) : "";
    uiState.createPresetTouched = false;
  }

  syncCreatePresetSelection(state);
}

async function handleBackendEnvChange(backendEnv) {
  uiState.settings.savingBackendEnv = true;
  uiState.settingsFlash = null;
  renderApp();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "set-backend-env",
      payload: {
        backendEnv,
      },
    });

    if (!response?.ok) {
      uiState.settingsFlash = {
        type: "error",
        text: response?.error ?? "Could not change backend environment.",
      };
      await refreshPopupState();
      renderApp();
      return;
    }

    await refreshPopupState();
    uiState.settingsFlash = {
      type: "success",
      text: `Backend environment set to ${uiState.settings.backendEnv}.`,
    };
    renderApp();
  } catch (error) {
    uiState.settingsFlash = {
      type: "error",
      text: error instanceof Error ? error.message : String(error),
    };
    await refreshPopupState();
    renderApp();
  } finally {
    uiState.settings.savingBackendEnv = false;
    renderApp();
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
  const rawAlertCondition = app.querySelector("#alert-condition")?.value ?? uiState.createAlertCondition ?? "";
  uiState.createAlertCondition = String(rawAlertCondition);
  const alertCondition = String(rawAlertCondition).trim();
  const interval = app.querySelector("#interval")?.value ?? "1440";
  uiState.createInterval = String(interval);

  if (!alertCondition) {
    uiState.createFlash = {
      type: "error",
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
        type: "error",
        text: error instanceof Error ? error.message : "Site permission required.",
      };
      renderApp();
      return;
    }
  }

  const submitButton = app.querySelector("#submit-button");
  submitButton.disabled = true;
  submitButton.textContent = "Creating…";

  const workspaceIdValue = Number(uiState.createWorkspaceId);
  const workspaceId = Number.isFinite(workspaceIdValue) && workspaceIdValue > 0 ? workspaceIdValue : undefined;
  const presetIdValue = Number(uiState.createPresetId);
  const savedJobSettingsId = Number.isFinite(presetIdValue) && presetIdValue > 0 ? presetIdValue : undefined;

  const response = await chrome.runtime.sendMessage({
    type: "create-job",
    payload: {
      alertCondition,
      interval,
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(savedJobSettingsId !== undefined ? { savedJobSettingsId } : {}),
    },
  });

  if (!response?.ok) {
    uiState.createFlash = {
      type: "error",
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

async function handleMonitorSuggestionsToggle(enabled) {
  uiState.settings.savingMonitorSuggestionsEnabled = true;
  uiState.settingsFlash = null;
  renderApp();

  try {
    if (enabled) {
      const granted = await chrome.permissions.request({
        origins: ["http://*/*", "https://*/*"],
      });
      if (!granted) {
        uiState.settings.monitorSuggestionsEnabled = false;
        uiState.settingsFlash = {
          type: "error",
          text: "All-sites access is required to suggest monitoring ideas.",
        };
        uiState.settings.savingMonitorSuggestionsEnabled = false;
        renderApp();
        return;
      }
    }

    const response = await chrome.runtime.sendMessage({
      type: "set-monitor-suggestions-enabled",
      payload: {
        enabled,
      },
    });

    if (!response?.ok) {
      uiState.settingsFlash = {
        type: "error",
        text: response?.error ?? "Could not save this setting.",
      };
      await refreshPopupState();
      uiState.settings.savingMonitorSuggestionsEnabled = false;
      renderApp();
      return;
    }

    uiState.settings.monitorSuggestionsEnabled = response.enabled === true;
    uiState.settingsFlash = {
      type: "success",
      text: uiState.settings.monitorSuggestionsEnabled ? "Monitoring suggestions are enabled." : "Monitoring suggestions are disabled.",
    };

    const shouldLoadSuggestionsAfterEnable = uiState.settings.monitorSuggestionsEnabled && (uiState.activeTab === "create" || uiState.lastMainTab === "create");

    if (shouldLoadSuggestionsAfterEnable) {
      await loadMonitorSuggestions({ forceRefresh: true });
    } else if (!uiState.settings.monitorSuggestionsEnabled) {
      resetMonitorSuggestions();
    }
  } catch (error) {
    uiState.settingsFlash = {
      type: "error",
      text: error instanceof Error ? error.message : String(error),
    };
    await refreshPopupState();
  } finally {
    uiState.settings.savingMonitorSuggestionsEnabled = false;
    renderApp();
  }
}

async function handleTabChange(nextTab) {
  if (nextTab !== "create" && nextTab !== "jobs") {
    return;
  }

  uiState.activeTab = nextTab;
  uiState.lastMainTab = nextTab;
  renderApp();

  if (nextTab === "create" && uiState.popupState?.loggedIn && uiState.popupState?.supportedPage && uiState.settings.monitorSuggestionsEnabled) {
    await loadMonitorSuggestions();
  }

  if (nextTab === "jobs" && uiState.popupState?.loggedIn && !uiState.jobs.data && !uiState.jobs.isLoading) {
    await loadJobsPage();
  }
}

function handleSettingsToggle() {
  if (uiState.activeTab === "settings") {
    uiState.activeTab = uiState.lastMainTab;
    if (uiState.activeTab === "create" && uiState.popupState?.loggedIn && !uiState.popupState?.supportedPage) {
      uiState.activeTab = "jobs";
      uiState.lastMainTab = "jobs";
    }
  } else {
    if (uiState.activeTab === "create" || uiState.activeTab === "jobs") {
      uiState.lastMainTab = uiState.activeTab;
    }
    uiState.activeTab = "settings";
  }

  renderApp();
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
        type: "error",
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
      type: "error",
      text: response?.error ?? "Cookie sync update failed.",
    };
    renderApp();
    return;
  }

  uiState.jobsFlash = {
    type: "success",
    text: response.enabled ? `Cookie sync enabled for job #${job.id}.` : `Cookie sync disabled for job #${job.id}.`,
  };

  await refreshPopupState();
  await loadJobsPage();
}

async function handleOpenScriptAction(jobId) {
  const job = getCurrentJobFromList(jobId);
  if (!job) {
    return;
  }

  if (!isSupportedTabUrl(job.url)) {
    uiState.jobsFlash = {
      type: "error",
      text: "Script generation requires an http:// or https:// job URL.",
    };
    renderApp();
    return;
  }

  const popupTab = uiState.popupState?.tab ?? null;
  const popupWindowId = Number(popupTab?.windowId);
  const hasPopupWindowId = Number.isInteger(popupWindowId) && popupWindowId >= 0;
  let panelOpened = false;
  let panelOpenError = null;

  if (hasPopupWindowId && chrome.sidePanel?.open) {
    try {
      // Open immediately from the click handler so Chrome treats this as a user gesture.
      await chrome.sidePanel.open({ windowId: popupWindowId });
      panelOpened = true;
    } catch (error) {
      panelOpenError = error;
    }
  }

  uiState.jobs.openingScriptJobId = job.id;
  uiState.jobsFlash = null;
  renderApp();

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

  const response = await chrome.runtime.sendMessage({
    type: "open-script-generator",
    payload: {
      jobId: job.id,
      url: job.url,
      description: job.description,
      ...(hasPopupWindowId ? { windowId: popupWindowId } : {}),
      // The popup opens panel immediately for user gesture compatibility,
      // but background should still try opening after creating/activating the target tab.
      openPanel: true,
    },
  });

  uiState.jobs.openingScriptJobId = null;

  if (!response?.ok) {
    uiState.jobsFlash = {
      type: "error",
      text: response?.error ?? "Could not open the script generator.",
    };
    renderApp();
    return;
  }

  if (!panelOpened && response?.openedPanel !== true) {
    const openError = response?.panelOpenError ?? panelOpenError;
    uiState.jobsFlash = {
      type: "error",
      text: `Could not open the script generator panel. ${openError instanceof Error ? openError.message : String(openError ?? "Unknown side panel error.")}`,
    };
    renderApp();
    return;
  }

  uiState.jobsFlash = {
    type: "success",
    text: "Script generator opened. Add actions in the side panel, then click Save To Job.",
  };
  renderApp();
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

  document.querySelector("#settings-toggle")?.addEventListener("click", () => {
    handleSettingsToggle();
  });

  document.querySelector("#open-login")?.addEventListener("click", () => {
    void handleOpenLogin();
  });

  document.querySelector("#create-job-form")?.addEventListener("submit", (event) => {
    void handleCreateJobSubmit(event);
  });

  document.querySelector("#alert-condition")?.addEventListener("input", (event) => {
    uiState.createAlertCondition = String(event.target?.value ?? "");
  });

  document.querySelector("#create-workspace")?.addEventListener("change", (event) => {
    uiState.createWorkspaceId = event.target.value;
    uiState.createPresetId = "";
    uiState.createPresetTouched = false;
    uiState.lastAppliedPresetId = "";
    syncCreatePresetSelection(uiState.popupState);
    renderApp();
  });

  document.querySelector("#create-preset")?.addEventListener("change", (event) => {
    uiState.createPresetId = String(event.target?.value ?? "");
    uiState.createPresetTouched = true;
    uiState.lastAppliedPresetId = "";
    if (!uiState.createPresetId) {
      uiState.createAlertCondition = "";
      uiState.createInterval = DEFAULT_CREATE_INTERVAL;
    } else {
      applyPresetDerivedFields(uiState.popupState);
    }
    renderApp();
  });

  document.querySelector("#interval")?.addEventListener("change", (event) => {
    uiState.createInterval = String(event.target?.value ?? DEFAULT_CREATE_INTERVAL);
  });

  document.querySelector("#monitor-suggestions-enabled")?.addEventListener("change", (event) => {
    void handleMonitorSuggestionsToggle(event.target.checked);
  });

  document.querySelector("#backend-env-select")?.addEventListener("change", (event) => {
    void handleBackendEnvChange(event.target.value);
  });

  document.querySelectorAll("[data-monitor-suggestion]").forEach((button) => {
    button.addEventListener("click", () => {
      applyMonitorSuggestion(button.dataset.monitorSuggestion);
    });
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

function focusAlertConditionField() {
  if (uiState.activeTab !== "create") {
    return;
  }

  const textarea = document.querySelector("#alert-condition");
  if (!(textarea instanceof HTMLTextAreaElement) || textarea.disabled) {
    return;
  }

  textarea.focus();
  const cursorAtEnd = textarea.value.length;
  textarea.setSelectionRange(cursorAtEnd, cursorAtEnd);
}

async function bootstrap() {
  await refreshPopupState();
  renderApp();
  focusAlertConditionField();

  if (uiState.popupState?.loggedIn && uiState.popupState?.supportedPage && uiState.settings.monitorSuggestionsEnabled) {
    void loadMonitorSuggestions();
  }

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
