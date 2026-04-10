import { DEFAULT_FREQUENCY_OPTIONS, STATUS, STORAGE_KEYS } from "./lib/constants.js";
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
  buildScriptActionPreactions,
  buildCookieSyncPayload,
  buildCreateJobPayload,
  buildLoginUrl,
  checkVisualpingSession,
  cookieMatchesHost,
  createVisualpingJob,
  getVisualpingJob,
  listVisualpingJobs,
  listVisualpingLabels,
  updateVisualpingJob,
} from "./lib/visualping.js";

const DEFAULT_JOBS_PAGE_SIZE = 10;
const syncState = new Map();
const SCRIPT_GENERATOR_CONTEXT_PREFIX = "scriptGeneratorContext:";
const SCRIPT_GENERATOR_LATEST_CONTEXT_KEY = "scriptGeneratorContextLatest";
const MONITOR_SUGGESTIONS_MODEL_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};
const MONITOR_SUGGESTIONS_CACHE_TTL_MS = 20 * 60 * 1000;
const MONITOR_SUGGESTIONS_MAX_COUNT = 5;
const MONITOR_SUGGESTIONS_MAX_TEXT_CHARS = 500;
const ACTION_ICON_SIZES = [16, 32, 48];
const ACTION_ICON_PATHS = Object.freeze({
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
});
const MONITOR_SUGGESTIONS_TRIGGER_DELAY_MS = 900;
const monitorSuggestionsCache = new Map();
const monitorSuggestionsPending = new Map();
const iconAnimationState = new Map();
const tabsWithSuggestionSignal = new Set();
const lastSuggestionAnimationFingerprint = new Map();
const monitorSuggestionsTriggerTimers = new Map();
let actionIconBitmapsPromise;
let monitorSuggestionsSessionPromise = null;
let monitorSuggestionsPromptQueue = Promise.resolve();

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

function scriptGeneratorContextKey(tabId) {
  return `${SCRIPT_GENERATOR_CONTEXT_PREFIX}${tabId}`;
}

function buildScriptGeneratorPanelPath(context) {
  const params = new URLSearchParams();
  params.set("jobId", String(context.jobId));
  params.set("url", String(context.url));

  if (context.description) {
    params.set("description", String(context.description));
  }

  if (Number.isInteger(Number(context.tabId)) && Number(context.tabId) > 0) {
    params.set("tabId", String(context.tabId));
  }

  return `script_generator.html?${params.toString()}`;
}

async function setScriptGeneratorContext(tabId, context) {
  await chrome.storage.session.set({
    [scriptGeneratorContextKey(tabId)]: context,
    [SCRIPT_GENERATOR_LATEST_CONTEXT_KEY]: context,
  });
}

async function getScriptGeneratorContext(tabId) {
  const result = await chrome.storage.session.get(scriptGeneratorContextKey(tabId));
  return result[scriptGeneratorContextKey(tabId)] ?? null;
}

async function getLatestScriptGeneratorContext() {
  const latestResult = await chrome.storage.session.get(SCRIPT_GENERATOR_LATEST_CONTEXT_KEY);
  const latestContext = latestResult[SCRIPT_GENERATOR_LATEST_CONTEXT_KEY];
  if (latestContext && typeof latestContext === "object") {
    return latestContext;
  }

  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(SCRIPT_GENERATOR_CONTEXT_PREFIX))
    .map(([, value]) => value)
    .filter((value) => value && typeof value === "object")
    .sort((left, right) => {
      return new Date(right.openedAt ?? 0).getTime() - new Date(left.openedAt ?? 0).getTime();
    })[0] ?? null;
}

async function syncScriptGeneratorPanelForTab(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0 || !chrome.sidePanel?.setOptions) {
    return;
  }

  const context = await getScriptGeneratorContext(tabId);
  try {
    await chrome.sidePanel.setOptions({
      enabled: false,
    });
  } catch (_error) {
    // Best effort only.
  }

  if (!context) {
    try {
      await chrome.sidePanel.setOptions({
        tabId,
        enabled: false,
      });
    } catch (_error) {
      // Best effort only.
    }
    return;
  }

  const panelPath = buildScriptGeneratorPanelPath(context);
  await chrome.sidePanel.setOptions({
    tabId,
    enabled: true,
    path: panelPath,
  });

  if (!chrome.sidePanel?.open) {
    return;
  }

  try {
    await chrome.sidePanel.open({ tabId });
  } catch (_error) {
    // Best effort only.
  }
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

async function getMonitorSuggestionsEnabled() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.monitorSuggestionsEnabled);
  return result[STORAGE_KEYS.monitorSuggestionsEnabled] === true;
}

async function setMonitorSuggestionsEnabled(enabled) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.monitorSuggestionsEnabled]: enabled === true,
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  return tabs[0] ?? null;
}

function clearMonitorSuggestionsTrigger(tabId) {
  const existingTimer = monitorSuggestionsTriggerTimers.get(tabId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    monitorSuggestionsTriggerTimers.delete(tabId);
  }
}

function elapsedMsSince(startedAtMs) {
  if (!Number.isFinite(startedAtMs)) {
    return null;
  }
  return Math.max(0, Date.now() - startedAtMs);
}

async function maybeGenerateMonitorSuggestionsForTabId(tabId, reason) {
  const enabled = await getMonitorSuggestionsEnabled();
  if (!enabled) {
    return;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    return;
  }

  if (!tab?.active || !isSupportedTabUrl(tab.url)) {
    return;
  }

  const triggerStartedAt = Date.now();
  const triggerId = `${tabId}:${triggerStartedAt.toString(36)}`;
  console.info("[monitor-suggestions] background-trigger", {
    triggerId,
    tabId,
    tabUrl: tab.url,
    reason,
  });

  const response = await getMonitorSuggestionsForTab(tab, {
    forceRefresh: false,
  });
  console.info("[monitor-suggestions] background-trigger-result", {
    triggerId,
    tabId,
    tabUrl: tab.url,
    reason,
    ok: response?.ok === true,
    source: response?.source ?? null,
    suggestionsCount: Array.isArray(response?.suggestions) ? response.suggestions.length : 0,
    monitorabilityScore:
      Number.isFinite(Number(response?.monitorabilityScore))
        ? Number(response.monitorabilityScore)
        : null,
    errorCode: response?.errorCode ?? null,
    durationMs: elapsedMsSince(triggerStartedAt),
  });
}

function queueMonitorSuggestionsForTab(tabId, reason, delayMs = MONITOR_SUGGESTIONS_TRIGGER_DELAY_MS) {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return;
  }

  clearMonitorSuggestionsTrigger(tabId);
  const timeoutId = setTimeout(() => {
    monitorSuggestionsTriggerTimers.delete(tabId);
    void maybeGenerateMonitorSuggestionsForTabId(tabId, reason);
  }, delayMs);
  monitorSuggestionsTriggerTimers.set(tabId, timeoutId);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function setTabSuggestionSignal(tabId, hasSuggestions) {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return;
  }

  if (hasSuggestions) {
    tabsWithSuggestionSignal.add(tabId);
  } else {
    tabsWithSuggestionSignal.delete(tabId);
  }
}

async function resetActionIcon(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0 || !chrome.action?.setIcon) {
    return;
  }

  try {
    await chrome.action.setIcon({
      tabId,
      path: ACTION_ICON_PATHS,
    });
  } catch (error) {
    console.warn("Failed to reset action icon.", error);
  }
}

function stopActionIconAnimation(tabId, { reset = true, reason = "unspecified" } = {}) {
  if (!iconAnimationState.has(tabId)) {
    return;
  }

  iconAnimationState.delete(tabId);
  console.info("[monitor-suggestions] icon-animation-stop", {
    tabId,
    reason,
    reset,
  });

  if (reset) {
    void resetActionIcon(tabId);
  }
}

function stopAllActionIconAnimations(reason) {
  for (const tabId of Array.from(iconAnimationState.keys())) {
    stopActionIconAnimation(tabId, {
      reset: true,
      reason,
    });
  }
}

function stopActionIconAnimationsExcept(activeTabId, reason) {
  for (const tabId of Array.from(iconAnimationState.keys())) {
    if (Number(tabId) !== Number(activeTabId)) {
      stopActionIconAnimation(tabId, {
        reset: true,
        reason,
      });
    }
  }
}

function parseJsonCandidates(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) {
    throw new Error("Model did not return content.");
  }

  const candidates = [text];
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    candidates.push(String(fenced[1]).trim());
  }

  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
    candidates.push(text.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    candidates.push(text.slice(arrayStart, arrayEnd + 1));
  }

  let lastError = null;
  for (const candidate of candidates) {
    const normalized = String(candidate)
      .replace(/^\s*json\s*/i, "")
      .replace(/[“”]/g, "\"")
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, "$1")
      .trim();

    try {
      return JSON.parse(normalized);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Could not parse model JSON.");
}

function normalizeMonitorSuggestion(value) {
  let suggestion = String(value ?? "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\-\d.).\s]+/, "")
    .replace(/^(notify me when|let me know when|alert me when|tell me when)\s+/i, "")
    .replace(/^when\s+/i, "")
    .replace(/[.?!]+$/g, "")
    .trim();

  if (!suggestion || suggestion.length < 4) {
    return "";
  }

  if (suggestion.length > 110) {
    suggestion = `${suggestion.slice(0, 107).trim()}...`;
  }

  return suggestion;
}

function normalizeSuggestionArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const suggestion = normalizeMonitorSuggestion(value);
    if (!suggestion) {
      continue;
    }

    const key = suggestion.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(suggestion);

    if (normalized.length >= MONITOR_SUGGESTIONS_MAX_COUNT) {
      break;
    }
  }

  return normalized;
}

function normalizeMonitorabilityScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }

  return Math.min(10, Math.max(1, Math.round(numeric)));
}

function shouldAnimateForSuggestions({ suggestions, monitorabilityScore }) {
  return Array.isArray(suggestions) && suggestions.length > 0 && Number(monitorabilityScore) >= 5;
}

function extractSuggestionsFromModelJson(parsed) {
  if (Array.isArray(parsed)) {
    return {
      suggestions: normalizeSuggestionArray(parsed),
      monitorabilityScore: 1,
    };
  }

  if (parsed && typeof parsed === "object") {
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    return {
      suggestions: normalizeSuggestionArray(suggestions),
      monitorabilityScore: normalizeMonitorabilityScore(parsed.monitorabilityScore),
    };
  }

  return {
    suggestions: [],
    monitorabilityScore: 1,
  };
}

async function parseSuggestionsFromModelResponse(text) {
  try {
    return extractSuggestionsFromModelJson(parseJsonCandidates(text));
  } catch (_firstError) {
    const rawText = String(text ?? "");
    try {
      const repairPrompt = [
        "Convert the output below to strict RFC8259 JSON.",
        "Return JSON only, no markdown fences.",
        "Schema: {\"monitorabilityScore\": number, \"suggestions\":[\"...\"]}",
        `Output:\n${rawText}`,
      ].join("\n");
      const repairedText = await promptMonitorSuggestions(repairPrompt);
      return extractSuggestionsFromModelJson(parseJsonCandidates(repairedText));
    } catch (_repairError) {
      const lines = rawText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, ""))
        .filter((line) => !/^json$/i.test(line))
        .filter((line) => !/^return json only/i.test(line));

      const scoreMatch = rawText.match(/monitorability(?:\s*score)?["']?\s*[:=]\s*(10|[1-9])/i);
      return {
        suggestions: normalizeSuggestionArray(lines),
        monitorabilityScore: normalizeMonitorabilityScore(scoreMatch?.[1]),
      };
    }
  }
}

async function createMonitorSuggestionsSession() {
  if (!("LanguageModel" in globalThis)) {
    throw new Error("Prompt API is unavailable in this Chrome build.");
  }

  const availability = await LanguageModel.availability(MONITOR_SUGGESTIONS_MODEL_OPTIONS);
  if (availability === "unavailable") {
    throw new Error("Chrome local model is unavailable on this device/profile.");
  }

  return LanguageModel.create({
    ...MONITOR_SUGGESTIONS_MODEL_OPTIONS,
    initialPrompts: [
      {
        role: "system",
        content:
          "You identify concrete webpage changes that are useful to monitor. You return concise JSON only.",
      },
    ],
  });
}

async function getSharedMonitorSuggestionsSession() {
  if (monitorSuggestionsSessionPromise) {
    return monitorSuggestionsSessionPromise;
  }

  monitorSuggestionsSessionPromise = createMonitorSuggestionsSession().catch((error) => {
    monitorSuggestionsSessionPromise = null;
    throw error;
  });

  return monitorSuggestionsSessionPromise;
}

function queueMonitorSuggestionsPrompt(task) {
  const queued = monitorSuggestionsPromptQueue.then(task, task);
  monitorSuggestionsPromptQueue = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}

async function promptMonitorSuggestions(promptText) {
  return queueMonitorSuggestionsPrompt(async () => {
    try {
      const session = await getSharedMonitorSuggestionsSession();
      return await session.prompt(promptText);
    } catch (_error) {
      // If a shared session goes stale, recreate once and retry.
      monitorSuggestionsSessionPromise = null;
      const session = await getSharedMonitorSuggestionsSession();
      return session.prompt(promptText);
    }
  });
}

function buildMonitorSuggestionsPrompt(pageContext) {
  return [
    "Return JSON only: {\"monitorabilityScore\":1-10,\"suggestions\":[\"...\"]}.",
    "Score: 1=poor monitorability (static or too noisy), 10=high-value specific changes.",
    `Suggestions: up to ${MONITOR_SUGGESTIONS_MAX_COUNT}, short suffixes for 'notify me when', no prefix text.`,
    "Prefer meaningful change events; avoid vague items.",
    "If nothing useful is monitorable, return an empty suggestions array.",
    `Title: ${pageContext.title}`,
    `URL: ${pageContext.url}`,
    `Excerpt:\n${pageContext.text}`,
  ].join("\n");
}

async function extractPageMonitorContext(tabId) {
  const executed = await chrome.scripting.executeScript({
    target: { tabId },
    args: [MONITOR_SUGGESTIONS_MAX_TEXT_CHARS],
    func: (maxTextChars) => {
      function cleanText(value) {
        return String(value ?? "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      const title = cleanText(document.title).slice(0, 240);
      const description = cleanText(document.querySelector('meta[name="description"]')?.content || "").slice(0, 500);
      const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
        .map((heading) => cleanText(heading.textContent))
        .filter(Boolean)
        .slice(0, 20)
        .join(" | ");

      const signalSelector = [
        "[class*='stock']",
        "[id*='stock']",
        "[class*='price']",
        "[id*='price']",
        "[class*='status']",
        "[id*='status']",
        "[class*='availability']",
        "[id*='availability']",
      ].join(",");
      const signalText = Array.from(document.querySelectorAll(signalSelector))
        .map((element) => cleanText(element.textContent))
        .filter(Boolean)
        .slice(0, 30)
        .join(" | ");

      const bodyText = cleanText(document.body?.innerText ?? "").slice(0, maxTextChars);
      const mergedText = [description, headings, signalText, bodyText]
        .filter(Boolean)
        .join("\n")
        .slice(0, maxTextChars);

      return {
        url: location.href,
        title,
        text: mergedText,
      };
    },
  });

  return executed?.[0]?.result ?? null;
}

async function loadActionIconBitmaps() {
  if (actionIconBitmapsPromise) {
    return actionIconBitmapsPromise;
  }

  if (!("OffscreenCanvas" in globalThis) || typeof createImageBitmap !== "function") {
    return null;
  }

  actionIconBitmapsPromise = (async () => {
    const entries = await Promise.all(
      ACTION_ICON_SIZES.map(async (size) => {
        const response = await fetch(chrome.runtime.getURL(ACTION_ICON_PATHS[size]));
        if (!response.ok) {
          throw new Error(`Failed to load action icon ${size}px.`);
        }

        const bitmap = await createImageBitmap(await response.blob());
        return [size, bitmap];
      })
    );

    return new Map(entries);
  })();

  return actionIconBitmapsPromise;
}

function buildAnimatedIconImageData(bitmaps, angle) {
  const imageData = {};

  for (const size of ACTION_ICON_SIZES) {
    const bitmap = bitmaps.get(size);
    if (!bitmap) {
      continue;
    }

    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext("2d");
    if (!context) {
      continue;
    }

    context.clearRect(0, 0, size, size);
    context.drawImage(bitmap, 0, 0, size, size);

    const center = size / 2;
    const orbitRadius = size * 0.42;
    const starX = center + Math.cos(angle) * orbitRadius;
    const starY = center + Math.sin(angle) * orbitRadius;

    // Tangent gives the motion direction; tail is drawn in the opposite direction.
    const tangentX = -Math.sin(angle);
    const tangentY = Math.cos(angle);
    const traceLength = size * 0.28;
    const tailX = starX - tangentX * traceLength;
    const tailY = starY - tangentY * traceLength;

    const traceGradient = context.createLinearGradient(starX, starY, tailX, tailY);
    traceGradient.addColorStop(0, "rgba(255, 245, 204, 0.92)");
    traceGradient.addColorStop(1, "rgba(255, 245, 204, 0.0)");

    context.lineCap = "round";
    context.lineWidth = Math.max(1.2, size * 0.12);
    context.strokeStyle = traceGradient;
    context.beginPath();
    context.moveTo(starX, starY);
    context.lineTo(tailX, tailY);
    context.stroke();

    const glowRadius = Math.max(1.8, size * 0.22);
    const glow = context.createRadialGradient(starX, starY, 0, starX, starY, glowRadius);
    glow.addColorStop(0, "rgba(255, 255, 232, 0.95)");
    glow.addColorStop(1, "rgba(255, 255, 232, 0.0)");
    context.fillStyle = glow;
    context.beginPath();
    context.arc(starX, starY, glowRadius, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = "rgba(255, 255, 245, 0.98)";
    context.beginPath();
    context.arc(starX, starY, Math.max(1.2, size * 0.09), 0, Math.PI * 2);
    context.fill();

    imageData[size] = context.getImageData(0, 0, size, size);
  }

  return imageData;
}

function startActionIconAnimation(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0 || !chrome.action?.setIcon) {
    console.info("[monitor-suggestions] icon-animation-skipped", {
      tabId,
      reason: "invalid-tab-or-action-api-missing",
    });
    return;
  }

  if (iconAnimationState.has(tabId)) {
    return;
  }

  const token = Date.now() + Math.random();
  iconAnimationState.set(tabId, token);
  console.info("[monitor-suggestions] icon-animation-start", {
    tabId,
    token,
  });

  void (async () => {
    try {
      const bitmaps = await loadActionIconBitmaps();
      if (!bitmaps) {
        console.info("[monitor-suggestions] icon-animation-skipped", {
          tabId,
          reason: "offscreen-canvas-or-create-image-bitmap-unavailable",
        });
        iconAnimationState.delete(tabId);
        return;
      }

      let frame = 0;
      while (iconAnimationState.get(tabId) === token) {
        const angle = -frame * 0.22;
        await chrome.action.setIcon({
          tabId,
          imageData: buildAnimatedIconImageData(bitmaps, angle),
        });
        frame += 1;
        await sleep(70);
      }
    } catch (error) {
      console.warn("Failed to animate action icon.", error);
    } finally {
      if (iconAnimationState.get(tabId) === token) {
        iconAnimationState.delete(tabId);
      }
      await resetActionIcon(tabId);
      console.info("[monitor-suggestions] icon-animation-finished", {
        tabId,
        token,
      });
    }
  })();
}

function syncActionIconAnimationForTab(tab) {
  const tabId = Number(tab?.id);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return;
  }

  const shouldAnimate = Boolean(tab?.active) && tabsWithSuggestionSignal.has(tabId);
  if (shouldAnimate) {
    startActionIconAnimation(tabId);
  } else {
    stopActionIconAnimation(tabId, {
      reset: true,
      reason: tab?.active ? "no-suggestions-signal" : "tab-inactive",
    });
  }
}

async function getMonitorSuggestionsForTab(tab, { forceRefresh = false } = {}) {
  if (!tab?.id || !isSupportedTabUrl(tab.url)) {
    if (tab?.id) {
      setTabSuggestionSignal(Number(tab.id), false);
      syncActionIconAnimationForTab(tab);
    }
    console.info("[monitor-suggestions] skipped unsupported tab", {
      tabId: tab?.id ?? null,
      tabUrl: tab?.url ?? null,
    });
    return {
      ok: true,
      supportedPage: false,
      suggestions: [],
      monitorabilityScore: 1,
      source: "unsupported",
    };
  }

  const tabId = Number(tab.id);
  const now = Date.now();
  const requestStartedAt = now;
  const requestId = `${tabId}:${requestStartedAt.toString(36)}`;
  const cached = monitorSuggestionsCache.get(tabId);
  console.info("[monitor-suggestions] request", {
    requestId,
    tabId,
    tabUrl: tab.url,
    forceRefresh,
    hasCache: Boolean(cached),
    elapsedMs: elapsedMsSince(requestStartedAt),
  });

  if (!forceRefresh && cached?.url === tab.url && now - cached.generatedAt < MONITOR_SUGGESTIONS_CACHE_TTL_MS) {
    const cachedSuggestions = Array.isArray(cached.suggestions) ? cached.suggestions : [];
    const monitorabilityScore = normalizeMonitorabilityScore(cached.monitorabilityScore);
    console.info("[monitor-suggestions] cache-hit", {
      requestId,
      tabId,
      tabUrl: tab.url,
      suggestionsCount: cachedSuggestions.length,
      monitorabilityScore,
      elapsedMs: elapsedMsSince(requestStartedAt),
    });
    setTabSuggestionSignal(
      tabId,
      shouldAnimateForSuggestions({
        suggestions: cachedSuggestions,
        monitorabilityScore,
      })
    );
    syncActionIconAnimationForTab(tab);
    return {
      ok: true,
      supportedPage: true,
      suggestions: cachedSuggestions,
      monitorabilityScore,
      source: "cache",
    };
  }

  const pending = monitorSuggestionsPending.get(tabId);
  if (!forceRefresh && pending?.url === tab.url) {
    console.info("[monitor-suggestions] pending-request-reused", {
      requestId,
      pendingRequestId: pending.requestId ?? null,
      tabId,
      tabUrl: tab.url,
      elapsedMs: elapsedMsSince(requestStartedAt),
      pendingElapsedMs: elapsedMsSince(pending.startedAt ?? null),
    });
    return pending.promise;
  }

  const promise = (async () => {
    console.info("[monitor-suggestions] extracting-page-context", {
      requestId,
      tabId,
      tabUrl: tab.url,
      elapsedMs: elapsedMsSince(requestStartedAt),
    });
    const context = await extractPageMonitorContext(tabId);
    const pageContext = {
      url: context?.url || tab.url,
      title: context?.title || tab.title || "",
      text: context?.text || "",
    };

    console.info("[monitor-suggestions] page-context-ready", {
      requestId,
      tabId,
      pageUrl: pageContext.url,
      titleLength: pageContext.title.length,
      textLength: pageContext.text.length,
      elapsedMs: elapsedMsSince(requestStartedAt),
    });

    if (!pageContext.text) {
      const emptyResult = {
        ok: true,
        supportedPage: true,
        suggestions: [],
        monitorabilityScore: 1,
        source: "empty",
      };
      monitorSuggestionsCache.set(tabId, {
        url: tab.url,
        suggestions: [],
        monitorabilityScore: 1,
        generatedAt: now,
      });
      setTabSuggestionSignal(tabId, false);
      syncActionIconAnimationForTab(tab);
      console.info("[monitor-suggestions] no-page-text", {
        requestId,
        tabId,
        tabUrl: tab.url,
        elapsedMs: elapsedMsSince(requestStartedAt),
      });
      return emptyResult;
    }

    console.info("[monitor-suggestions] prompting-llm", {
      requestId,
      tabId,
      tabUrl: tab.url,
      elapsedMs: elapsedMsSince(requestStartedAt),
    });
    const modelText = await promptMonitorSuggestions(buildMonitorSuggestionsPrompt(pageContext));
    const { suggestions, monitorabilityScore } = await parseSuggestionsFromModelResponse(modelText);
    monitorSuggestionsCache.set(tabId, {
      url: tab.url,
      suggestions,
      monitorabilityScore,
      generatedAt: Date.now(),
    });
    console.info("[monitor-suggestions] llm-success", {
      requestId,
      tabId,
      tabUrl: tab.url,
      suggestionsCount: suggestions.length,
      monitorabilityScore,
      elapsedMs: elapsedMsSince(requestStartedAt),
    });
    const fingerprint = suggestions.length > 0
      ? `${tab.url}::${suggestions.join("|").toLowerCase()}`
      : "";
    const previousFingerprint = lastSuggestionAnimationFingerprint.get(tabId);
    if (fingerprint && previousFingerprint !== fingerprint) {
      lastSuggestionAnimationFingerprint.set(tabId, fingerprint);
    }
    if (!fingerprint) {
      lastSuggestionAnimationFingerprint.delete(tabId);
    }

    setTabSuggestionSignal(
      tabId,
      shouldAnimateForSuggestions({
        suggestions,
        monitorabilityScore,
      })
    );
    syncActionIconAnimationForTab(tab);

    return {
      ok: true,
      supportedPage: true,
      suggestions,
      monitorabilityScore,
      source: "llm",
    };
  })()
    .catch((error) => {
      const message = formatError(error);
      const permissionLikeError =
        message.includes("Cannot access contents of the page") ||
        message.includes("Missing host permission") ||
        message.includes("Cannot access a chrome:// URL");
      const errorCode = permissionLikeError ? "missing-host-permission" : "monitor-suggestions-failed";

      console.warn("[monitor-suggestions] failed", {
        requestId,
        tabId,
        tabUrl: tab.url,
        errorCode,
        message,
        elapsedMs: elapsedMsSince(requestStartedAt),
      });
      setTabSuggestionSignal(tabId, false);
      syncActionIconAnimationForTab(tab);

      return {
        ok: false,
        supportedPage: true,
        suggestions: [],
        monitorabilityScore: 1,
        errorCode,
        error: permissionLikeError
          ? "This page cannot be scanned yet. Grant site access to generate suggestions."
          : message,
      };
    })
    .finally(() => {
      const current = monitorSuggestionsPending.get(tabId);
      if (current?.promise === promise) {
        monitorSuggestionsPending.delete(tabId);
      }
      console.info("[monitor-suggestions] request-finished", {
        requestId,
        tabId,
        tabUrl: tab.url,
        durationMs: elapsedMsSince(requestStartedAt),
      });
    });

  monitorSuggestionsPending.set(tabId, {
    url: tab.url,
    promise,
    requestId,
    startedAt: requestStartedAt,
  });

  return promise;
}

async function getMonitorSuggestionsForActiveTab(payload = {}) {
  const tab = await getActiveTab();
  const enabled = await getMonitorSuggestionsEnabled();
  if (!enabled) {
    if (tab?.id) {
      setTabSuggestionSignal(Number(tab.id), false);
      syncActionIconAnimationForTab(tab);
    }
    return {
      ok: true,
      supportedPage: Boolean(tab?.url && isSupportedTabUrl(tab.url)),
      disabled: true,
      suggestions: [],
      monitorabilityScore: 1,
      source: "disabled",
    };
  }

  return getMonitorSuggestionsForTab(tab, {
    forceRefresh: Boolean(payload.forceRefresh),
  });
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

function getUserEmail(session) {
  const candidateValues = [
    session.user?.email,
    session.user?.emailAddress,
    session.user?.profile?.email,
    session.user?.attributes?.email,
  ];

  return candidateValues
    .map((value) => String(value ?? "").trim())
    .find((value) => value.includes("@")) ?? "";
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
  const monitorSuggestionsEnabled = await getMonitorSuggestionsEnabled();
  const isBusinessUser = getOrganisationId(session) !== null;
  const userEmail = getUserEmail(session);
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
      monitorSuggestionsEnabled,
      isBusinessUser,
      userEmail,
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
    monitorSuggestionsEnabled,
    isBusinessUser,
    userEmail,
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
  const jobDetails = await getVisualpingJob(config, session.token, jobId, {
    workspaceId: workspaceId ?? undefined,
  });
  await updateVisualpingJob(
    config,
    session.token,
    jobId,
    buildCookieSyncPayload({
      jobId,
      cookies,
      workspaceId,
      existingPreactions: jobDetails.preactions,
    })
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
  const jobDetails = await getVisualpingJob(config, session.token, trackedJob.jobId, {
    workspaceId: workspaceId ?? undefined,
  });
  await updateVisualpingJob(
    config,
    session.token,
    trackedJob.jobId,
    buildCookieSyncPayload({
      jobId,
      cookies,
      workspaceId,
      existingPreactions: jobDetails.preactions,
    })
  );

  await updateTrackedJob(jobId, {
    status: STATUS.synced,
    cookieCount: cookies.length,
    lastSyncedAt: new Date().toISOString(),
    lastError: null,
  });
}

async function openScriptGeneratorForJob(payload = {}) {
  const jobId = Number(payload.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new Error("A valid Visualping job id is required.");
  }

  const url = String(payload.url ?? "").trim();
  if (!isSupportedTabUrl(url)) {
    throw new Error("Script generation requires an http:// or https:// job URL.");
  }

  if (!chrome.sidePanel?.setOptions || !chrome.sidePanel?.open) {
    throw new Error("This Chrome version does not support extension side panels.");
  }

  const shouldOpenPanel = payload.openPanel !== false;
  const requestedTabId = Number(payload.tabId);
  const hasRequestedTabId = Number.isInteger(requestedTabId) && requestedTabId > 0;
  const requestedWindowId = Number(payload.windowId);
  const hasRequestedWindowId = Number.isInteger(requestedWindowId) && requestedWindowId >= 0;

  let panelOpened = false;
  let lastOpenError = null;

  let tab = null;
  if (hasRequestedTabId) {
    try {
      tab = await chrome.tabs.get(requestedTabId);
    } catch (error) {
      throw new Error(`Could not find tab #${requestedTabId} for script generation. ${formatError(error)}`);
    }
  }

  if (!tab) {
    tab = await chrome.tabs.create({
      url,
      active: true,
      ...(hasRequestedWindowId ? { windowId: requestedWindowId } : {}),
    });
  }

  if (!tab?.id) {
    throw new Error("Unable to open a browser tab for this job.");
  }

  if (tab.url !== url) {
    try {
      await chrome.tabs.update(tab.id, {
        url,
      });
    } catch (_error) {
      // Best effort only.
    }
  }

  if (Number.isInteger(tab.windowId)) {
    try {
      await chrome.windows.update(tab.windowId, {
        focused: true,
      });
    } catch (_error) {
      // Best effort only.
    }
  }

  try {
    await chrome.tabs.update(tab.id, {
      active: true,
    });
  } catch (_error) {
    // Best effort only.
  }

  const context = {
    jobId,
    url,
    description: String(payload.description ?? ""),
    openedAt: new Date().toISOString(),
    tabId: tab.id,
    windowId: tab.windowId ?? null,
  };
  const panelPath = buildScriptGeneratorPanelPath(context);

  await setScriptGeneratorContext(tab.id, context);

  try {
    await chrome.sidePanel.setOptions({
      enabled: false,
    });
  } catch (_error) {
    // Best effort only.
  }

  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    enabled: true,
    path: panelPath,
  });

  if (!shouldOpenPanel) {
    return {
      ok: true,
      tabId: tab.id,
    };
  }

  if (!panelOpened) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
      panelOpened = true;
      console.info("Script generator panel opened via tab.", {
        tabId: tab.id,
      });
    } catch (error) {
      lastOpenError = error;
      console.warn("Failed to open script generator panel via tab.", {
        tabId: tab.id,
        error: formatError(error),
      });
    }
  }

  if (!panelOpened) {
    const details = lastOpenError ? formatError(lastOpenError) : "Unknown side panel error.";
    throw new Error(
      `Could not open side panel automatically. ${details}`
    );
  }

  return {
    ok: true,
    tabId: tab.id,
  };
}

async function getScriptGeneratorContextForTab(payload = {}) {
  const requestedTabId = Number(payload.tabId);
  const hasRequestedTabId = Number.isInteger(requestedTabId) && requestedTabId > 0;

  const context = hasRequestedTabId ? await getScriptGeneratorContext(requestedTabId) : null;
  const fallbackContext = context ?? (await getLatestScriptGeneratorContext());
  if (!fallbackContext) {
    return {
      ok: false,
      error: "No script generator context found for this tab. Start from the Jobs tab in the extension popup.",
    };
  }

  return {
    ok: true,
    context: fallbackContext,
  };
}

async function saveScriptActionForJob(payload = {}) {
  const jobId = Number(payload.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new Error("A valid Visualping job id is required.");
  }

  const script = String(payload.script ?? "").trim();
  if (!script) {
    throw new Error("Generated script is empty.");
  }

  const config = await loadPublicConfig();
  const session = await requireSession(config);
  const workspaceId = getPreferredWorkspaceId(session);
  const jobDetails = await getVisualpingJob(config, session.token, jobId, {
    workspaceId: workspaceId ?? undefined,
  });

  const preactions = buildScriptActionPreactions(jobDetails.preactions, script);
  const updatePayload = {
    jobId,
    enable_cookies_and_ad_blocker: true,
    preactions,
  };

  if (workspaceId) {
    updatePayload.workspaceId = workspaceId;
  }

  await updateVisualpingJob(config, session.token, jobId, updatePayload);

  return {
    ok: true,
    jobId,
    actionCount: preactions.actions.length,
  };
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

chrome.tabs.onActivated.addListener(({ tabId }) => {
  stopActionIconAnimationsExcept(tabId, "different-tab-activated");
  chrome.tabs.get(tabId).then((tab) => {
    syncActionIconAnimationForTab(tab);
  }).catch(() => {
    // no-op
  });
  void syncScriptGeneratorPanelForTab(tabId);
  queueMonitorSuggestionsForTab(tabId, "tab-activated", 350);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab?.active) {
    return;
  }

  if (changeInfo.status === "loading") {
    clearMonitorSuggestionsTrigger(tabId);
    setTabSuggestionSignal(tabId, false);
    syncActionIconAnimationForTab(tab);
    return;
  }

  if (changeInfo.status === "complete") {
    syncActionIconAnimationForTab(tab);
    queueMonitorSuggestionsForTab(tabId, "tab-load-complete", MONITOR_SUGGESTIONS_TRIGGER_DELAY_MS);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  clearMonitorSuggestionsTrigger(tabId);
  tabsWithSuggestionSignal.delete(tabId);
  stopActionIconAnimation(tabId, {
    reset: true,
    reason: "tab-removed",
  });
  monitorSuggestionsCache.delete(tabId);
  monitorSuggestionsPending.delete(tabId);
  lastSuggestionAnimationFingerprint.delete(tabId);

  try {
    await chrome.storage.session.remove(scriptGeneratorContextKey(tabId));

    const latest = await chrome.storage.session.get(SCRIPT_GENERATOR_LATEST_CONTEXT_KEY);
    if (Number(latest[SCRIPT_GENERATOR_LATEST_CONTEXT_KEY]?.tabId) === Number(tabId)) {
      await chrome.storage.session.remove(SCRIPT_GENERATOR_LATEST_CONTEXT_KEY);
    }
  } catch (error) {
    console.warn("Failed to clear script generator tab context.", error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "popup-state") {
      sendResponse(await buildPopupState());
      return;
    }

    if (message?.type === "set-monitor-suggestions-enabled") {
      try {
        const enabled = message?.payload?.enabled === true;
        await setMonitorSuggestionsEnabled(enabled);
        if (enabled) {
          const activeTab = await getActiveTab();
          if (activeTab?.id) {
            queueMonitorSuggestionsForTab(activeTab.id, "settings-enabled", 100);
          }
        } else {
          for (const tabId of monitorSuggestionsTriggerTimers.keys()) {
            clearMonitorSuggestionsTrigger(tabId);
          }
          tabsWithSuggestionSignal.clear();
          stopAllActionIconAnimations("settings-disabled");
        }
        sendResponse({
          ok: true,
          enabled,
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: formatError(error),
        });
      }
      return;
    }

    if (message?.type === "monitor-suggestions") {
      try {
        sendResponse(await getMonitorSuggestionsForActiveTab(message.payload ?? {}));
      } catch (error) {
        sendResponse({
          ok: false,
          error: formatError(error),
        });
      }
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

    if (message?.type === "open-script-generator") {
      try {
        sendResponse(await openScriptGeneratorForJob(message.payload ?? {}));
      } catch (error) {
        sendResponse({
          ok: false,
          error: formatError(error),
        });
      }
      return;
    }

    if (message?.type === "script-generator-context") {
      try {
        sendResponse(await getScriptGeneratorContextForTab(message.payload ?? {}));
      } catch (error) {
        sendResponse({
          ok: false,
          error: formatError(error),
        });
      }
      return;
    }

    if (message?.type === "save-script-action") {
      try {
        sendResponse(await saveScriptActionForJob(message.payload ?? {}));
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
