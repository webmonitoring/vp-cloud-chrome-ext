const state = {
  tabId: null,
  context: null,
  generatedScript: "",
  isGenerating: false,
  isSaving: false,
  stopRequested: false,
  thinkingEntries: [],
  isRecording: false,
  recordedActions: [],
};

const elements = {
  jobContext: document.querySelector("#job-context"),
  requestInput: document.querySelector("#action-request"),
  generateButton: document.querySelector("#generate-script"),
  stopButton: document.querySelector("#stop-generation"),
  saveButton: document.querySelector("#save-script"),
  status: document.querySelector("#status"),
  thinkingLog: document.querySelector("#thinking-log"),
  output: document.querySelector("#generated-script"),
  startRecordButton: document.querySelector("#start-recording"),
  stopRecordButton: document.querySelector("#stop-recording"),
  useRecordingButton: document.querySelector("#use-recording"),
  saveAsPreactionsButton: document.querySelector("#save-as-preactions"),
  useRecordingActionsDiv: document.querySelector("#use-recording-actions"),
  recordingStatus: document.querySelector("#recording-status"),
  recordedActionsList: document.querySelector("#recorded-actions-list"),
};

const EXECUTE_SCRIPT_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "executeScript",
    description:
      "Run JavaScript on the live browser page and return its result or error.",
    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "JavaScript source to execute in the page context.",
        },
      },
      required: ["script"],
    },
  },
});

function setStatus(type, message) {
  elements.status.textContent = message;
  elements.status.className = "status";
  if (type === "success") {
    elements.status.classList.add("is-success");
  } else if (type === "warning") {
    elements.status.classList.add("is-warning");
  } else if (type === "error") {
    elements.status.classList.add("is-error");
  }
}

function clearThinkingLog() {
  state.thinkingEntries = [];
  if (elements.thinkingLog) {
    elements.thinkingLog.textContent = "";
  }
}

function appendThinking(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    return;
  }

  state.thinkingEntries.push(text);
  if (state.thinkingEntries.length > 80) {
    state.thinkingEntries = state.thinkingEntries.slice(-80);
  }

  if (elements.thinkingLog) {
    elements.thinkingLog.textContent = state.thinkingEntries.join("\n");
    elements.thinkingLog.scrollTop = elements.thinkingLog.scrollHeight;
  }
}

function truncateForThinking(text, maxLength = 260) {
  const value = String(text ?? "");
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function logLlmInteraction(label, detail) {
  console.log(`[script-generator][llm] ${label}`, detail);
}

function refreshButtonState() {
  elements.generateButton.disabled = state.isGenerating || !state.context;
  elements.stopButton.disabled = !state.isGenerating;
  elements.saveButton.disabled =
    state.isSaving ||
    state.isGenerating ||
    !state.context ||
    !state.generatedScript.trim();

  elements.generateButton.textContent = state.isGenerating ? "Generating..." : "Generate Script";
  elements.stopButton.textContent = state.stopRequested ? "Stopping..." : "Stop";
  elements.saveButton.textContent = state.isSaving ? "Saving..." : "Save To Job";
}

function updateContextText() {
  if (!state.context) {
    elements.jobContext.textContent = "Open this from a job row in the extension popup.";
    return;
  }

  elements.jobContext.textContent = `Job #${state.context.jobId} | ${state.context.url}`;
}

function getContextFromLocation() {
  const params = new URL(window.location.href).searchParams;
  const jobId = Number(params.get("jobId"));
  const url = String(params.get("url") ?? "").trim();
  const description = String(params.get("description") ?? "").trim();
  const tabId = Number(params.get("tabId"));

  if (!Number.isInteger(jobId) || jobId <= 0 || !url) {
    return null;
  }

  return {
    jobId,
    url,
    description,
    tabId: Number.isInteger(tabId) && tabId > 0 ? tabId : null,
  };
}

async function getCurrentActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function waitForScriptGeneratorContext() {
  const attempts = 120;
  const delayMs = 250;
  let lastError = "No script generator context found for this tab.";

  for (let index = 0; index < attempts; index += 1) {
    const activeTab = await getCurrentActiveTab().catch(() => null);
    const activeTabId = Number(activeTab?.id);
    if (Number.isInteger(activeTabId) && activeTabId > 0) {
      state.tabId = activeTabId;
    }

    let contextResponse = null;
    try {
      contextResponse = await chrome.runtime.sendMessage({
        type: "script-generator-context",
        payload: Number.isInteger(state.tabId) ? { tabId: state.tabId } : {},
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      contextResponse = null;
    }

    if (contextResponse?.ok && contextResponse.context) {
      const contextTabId = Number(contextResponse.context.tabId);
      if (Number.isInteger(contextTabId) && contextTabId > 0) {
        state.tabId = contextTabId;
      }
      return contextResponse.context;
    }

    lastError = contextResponse?.error ?? lastError;

    if (index < attempts - 1) {
      await sleep(delayMs);
    }
  }

  throw new Error(lastError);
}

function parseJsonCandidates(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) {
    throw new Error("Model did not return content.");
  }

  const candidates = [];
  candidates.push(text);

  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    candidates.push(String(fenced[1]).trim());
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }

  const normalizedCandidates = candidates.flatMap((candidate) => {
    const cleaned = String(candidate)
      .replace(/^\s*json\s*/i, "")
      .replace(/[“”]/g, "\"")
      .replace(/[‘’]/g, "'")
      .trim();
    const withoutTrailingCommas = cleaned.replace(/,\s*([}\]])/g, "$1");
    return [cleaned, withoutTrailingCommas];
  });

  let lastError = null;
  for (const candidate of normalizedCandidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Model response did not include parseable JSON.");
}

function extractGemmaToolCalls(text) {
  const value = String(text ?? "");
  const calls = [];

  function pushCall(name, args, raw) {
    calls.push({
      id: `tool-call-${calls.length + 1}`,
      name: String(name),
      arguments: args ?? {},
      raw: String(raw ?? ""),
    });
  }

  // 1. Qwen-style: <tool_call>{...}</tool_call> (JSON inside)
  let m;
  const qwenRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  while ((m = qwenRe.exec(value))) {
    try {
      const parsed = JSON.parse(String(m[1]).trim());
      if (parsed && typeof parsed === "object" && parsed.name) {
        pushCall(parsed.name, parsed.arguments ?? parsed.parameters ?? {}, m[1]);
      }
    } catch (_e) {}
  }

  // 2. Gemma-tagged: <|tool_call>call:NAME{...}<tool_call|>
  const gemmaTaggedRe = /<\|tool_call\>([\s\S]*?)<tool_call\|>/g;
  while ((m = gemmaTaggedRe.exec(value))) {
    const payload = m[1].trim();
    const nameMatch = payload.match(/^call:([^\{]+)\{/);
    const argsMatch = payload.match(/^call:[^\{]+(\{[\s\S]*\})$/);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      const args = argsMatch ? parseGemmaArguments(argsMatch[1]) : {};
      pushCall(name, args, payload);
    }
  }

  // 3. Llama 3.2-style: optional <|python_tag|>, then a bare JSON object with name + parameters/arguments.
  //    Llama renders one tool call per assistant turn, so cap at 1.
  if (calls.length === 0) {
    const scan = value.replace(/<\|python_tag\|>/g, "");
    for (let i = 0; i < scan.length; i++) {
      if (scan[i] !== "{") continue;
      const obj = readJsonObject(scan, i);
      if (!obj) continue;
      try {
        const parsed = JSON.parse(obj.text);
        if (parsed && typeof parsed === "object" && parsed.name) {
          pushCall(parsed.name, parsed.arguments ?? parsed.parameters ?? {}, obj.text);
          break;
        }
      } catch (_e) {}
      i = obj.end;
    }
  }

  // 4. Bare Gemma fallback: call:NAME{...} without surrounding tags.
  if (calls.length === 0) {
    let cursor = 0;
    while (cursor < value.length) {
      const callStart = value.indexOf("call:", cursor);
      if (callStart === -1) break;
      const nameStart = callStart + "call:".length;
      const braceStart = value.indexOf("{", nameStart);
      if (braceStart === -1) { cursor = nameStart; continue; }
      const name = value.slice(nameStart, braceStart).trim();
      if (!name) { cursor = braceStart + 1; continue; }
      const body = readJsonObject(value, braceStart);
      if (!body) { cursor = braceStart + 1; continue; }
      pushCall(name, parseGemmaArguments(body.text), body.text);
      cursor = body.end + 1;
    }
  }

  return calls;
}

function parseGemmaArguments(raw) {
  // Gemma uses <|"|>...<|"|> as a string delimiter that lets the model emit
  // unescaped quotes/backslashes inside the value (e.g. document.querySelector("...")).
  // Strategy: extract each <|"|>...<|"|> region verbatim, replace with a placeholder
  // so JSON.parse works, then substitute the original content back.
  const source = String(raw ?? "");
  const literals = [];
  let placeheld = "";
  let i = 0;
  const marker = "<|\"|>";
  while (i < source.length) {
    const open = source.indexOf(marker, i);
    if (open === -1) {
      placeheld += source.slice(i);
      break;
    }
    placeheld += source.slice(i, open);
    const close = source.indexOf(marker, open + marker.length);
    if (close === -1) {
      // Unbalanced — treat the rest as plain text and bail.
      placeheld += source.slice(open);
      break;
    }
    const inner = source.slice(open + marker.length, close);
    const index = literals.push(inner) - 1;
    placeheld += `"__GEMMA_LITERAL_${index}__"`;
    i = close + marker.length;
  }
  const normalized = placeheld.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, "$1\"$2\":");
  try {
    let parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object") {
      // Substitute placeholders back to their raw content.
      const restore = (val) => {
        if (typeof val === "string") {
          const m = val.match(/^__GEMMA_LITERAL_(\d+)__$/);
          return m ? literals[Number(m[1])] : val;
        }
        if (Array.isArray(val)) return val.map(restore);
        if (val && typeof val === "object") {
          const out = {};
          for (const k of Object.keys(val)) out[k] = restore(val[k]);
          return out;
        }
        return val;
      };
      parsed = restore(parsed);
      return parsed;
    }
  } catch (_e) {}
  return {};
}

// Read a balanced JSON object starting at index i (which must be '{').
// Returns { text, end } where end is the index of the closing '}', or null on imbalance.
function readJsonObject(text, i) {
  if (text[i] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === "\"") { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { text: text.slice(i, j + 1), end: j };
    }
  }
  return null;
}

function stripGemmaToolCalls(text) {
  return String(text ?? "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
    .replace(/<\|tool_call\>[\s\S]*?<tool_call\|>/g, "")
    .replace(/<\|tool_response\>[\s\S]*?<tool_response\|>/g, "")
    .replace(/<\|python_tag\|>/g, "")
    .replace(/<\|eom_id\|>|<\|eot_id\|>|<\|end_of_text\|>|<turn\|>/g, "")
    .trim();
}

function parseToolArguments(argumentsText) {
  const text = String(argumentsText ?? "").trim();
  const candidates = [
    text,
    `{${text}}`,
    text.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, "$1\"$2\":"),
    `{${text.replace(/([{,]?\s*)([A-Za-z_$][\w$]*)\s*:/g, "$1\"$2\":")}}`,
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch (_error) {
      // Keep trying less strict native Gemma formats below.
    }
  }

  // Gemma chat templates may emit values like: script:<|"|>...<|"|>
  const marker = '<|"|>';
  const scriptKeyIndex = text.search(/(?:^|[,{]\s*)"?script"?\s*:/);
  if (scriptKeyIndex !== -1) {
    const firstMarker = text.indexOf(marker, scriptKeyIndex);
    if (firstMarker !== -1) {
      const secondMarker = text.indexOf(marker, firstMarker + marker.length);
      if (secondMarker !== -1) {
        return {
          script: text.slice(firstMarker + marker.length, secondMarker),
        };
      }
    }
  }

  // Fallback for relaxed format: script:"..."
  const quotedMatch = text.match(/(?:^|[,{]\s*)"?script"?\s*:\s*"([\s\S]*?)"\s*(?:,|$)/);
  if (quotedMatch?.[1]) {
    return {
      script: quotedMatch[1]
        .replace(/\\"/g, "\"")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t"),
    };
  }

  logLlmInteraction("tool args parse failed", { argumentsText: text });
  return {};
}

function normalizeToolCallForMessage(toolCall, toolCallId) {
  return {
    id: toolCallId,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments ?? {},
    },
  };
}

async function extractJsonObject(text, session) {
  try {
    return parseJsonCandidates(text);
  } catch (firstError) {
    const repairPrompt = [
      "Convert the following model output into strict RFC8259 JSON.",
      "Rules:",
      "- Return JSON only.",
      "- Do not wrap with markdown code fences.",
      "- Do not add comments.",
      "- Preserve keys/values/arrays/objects from the original response.",
      `Original output:\n${String(text ?? "")}`,
    ].join("\n");

    const repairedText = await session.prompt(repairPrompt);
    return parseJsonCandidates(repairedText);
  }
}

function buildGenerationPrompt(actionRequest, previousFailure = "") {
  const retryContext = previousFailure
    ? `Previous attempt failed: ${previousFailure}`
    : "";

  return [
    "Follow the INSPECT → ACT → VERIFY → REPORT steps from your instructions.",
    "After running the action script (ACT), you MUST call executeScript again (VERIFY) to confirm the expected results are present in the DOM before returning JSON.",
    retryContext,
    `Request: ${actionRequest}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function summarizeInspection(inspection, actionRequest) {
  const tokens = String(actionRequest ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);

  const tokenMatch = (text) => {
    const s = String(text ?? "").toLowerCase();
    return tokens.some((t) => s.includes(t));
  };

  const trim = (text, max = 60) => {
    const s = String(text ?? "").trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
  };

  // Selects: keep id, name, selectedText, plus matching options + the currently selected one.
  // Cap to 6 options each and 6 selects total.
  const selects = (inspection.selects || [])
    .slice(0, 6)
    .map((sel) => {
      const opts = sel.options || [];
      const selectedValue = sel.value;
      const matches = opts.filter((o) => tokenMatch(o.text)).slice(0, 5);
      const selectedOpt = opts.find((o) => o.value === selectedValue);
      const keep = [];
      if (selectedOpt) keep.push({ value: selectedOpt.value, text: trim(selectedOpt.text), selected: true });
      for (const o of matches) {
        if (o.value !== selectedValue) keep.push({ value: o.value, text: trim(o.text) });
      }
      return {
        id: sel.id || undefined,
        name: sel.name || undefined,
        selector: sel.selector,
        selectedValue,
        totalOptions: opts.length,
        options: keep,
      };
    });

  // Inputs: key fields only, cap to 12.
  const inputs = (inspection.inputs || [])
    .slice(0, 12)
    .map((i) => ({
      selector: i.selector,
      tag: i.tag,
      type: i.type,
      name: i.name || undefined,
      placeholder: i.placeholder ? trim(i.placeholder, 40) : undefined,
      value: i.value ? trim(i.value, 30) : undefined,
    }));

  // Candidates: selector + short text + a couple of flags, cap to 12, prefer token matches.
  // Add an `index` per (selector) group so the model can disambiguate when several
  // candidates share the same selector (e.g. 10 identical <button> tags).
  const allCandidates = inspection.candidates || [];
  const matched = allCandidates.filter((c) => tokenMatch(c.text) || tokenMatch(c.value));
  const candidatesPool = matched.length ? matched : allCandidates;
  const seenBySelector = new Map();
  const candidates = candidatesPool.slice(0, 12).map((c) => {
    const sel = c.selector;
    const index = seenBySelector.get(sel) ?? 0;
    seenBySelector.set(sel, index + 1);
    return {
      selector: sel,
      index,
      tag: c.tag,
      text: c.text ? trim(c.text, 80) : undefined,
      value: c.value ? trim(c.value, 30) : undefined,
      checked: typeof c.checked === "boolean" ? c.checked : undefined,
      disabled: c.disabled || undefined,
    };
  });

  return {
    url: inspection.url,
    title: inspection.title,
    selects,
    inputs,
    candidates,
  };
}

function coerceScriptString(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value && typeof value === "object") {
    // Model sometimes nests another tool-call shape in the script field.
    if (typeof value.script === "string") return String(value.script).trim();
    if (value.parameters && typeof value.parameters.script === "string") {
      return String(value.parameters.script).trim();
    }
    if (value.arguments && typeof value.arguments.script === "string") {
      return String(value.arguments.script).trim();
    }
  }
  return "";
}

function ensureExecutableScript(script) {
  const trimmed = String(script ?? "").trim();
  if (!trimmed) {
    return "";
  }

  // Named function declaration only -> append invocation.
  const namedDeclaration = trimmed.match(/^(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (namedDeclaration) {
    const isAsync = Boolean(namedDeclaration[1]);
    const name = namedDeclaration[2];
    const hasInvocation = new RegExp(`\\b${name}\\s*\\(`).test(trimmed.slice(namedDeclaration[0].length));
    if (!hasInvocation) {
      return isAsync
        ? `${trimmed}\n\n${name}().catch((error) => console.error(error));`
        : `${trimmed}\n\n${name}();`;
    }
  }

  // Bare anonymous function expression -> invoke as IIFE.
  const anonymousFunctionOnly = /^(?:\(\s*)?(?:async\s*)?function\s*\([^)]*\)\s*\{[\s\S]*\}\s*\)?\s*;?$/.test(trimmed);
  if (anonymousFunctionOnly) {
    const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "");
    return `(${withoutTrailingSemicolon})()`;
  }

  // Bare arrow function expression -> invoke as IIFE.
  const bareArrowOnly =
    /^(?:async\s*)?\([^)]*\)\s*=>[\s\S]+$/.test(trimmed) ||
    /^(?:async\s*)?[A-Za-z_$][\w$]*\s*=>[\s\S]+$/.test(trimmed);
  if (bareArrowOnly) {
    const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "");
    return `(${withoutTrailingSemicolon})()`;
  }

  return trimmed;
}

function normalizeStructuredSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) {
    return [];
  }

  return rawSteps
    .map((rawStep) => {
      if (!rawStep || typeof rawStep !== "object") {
        return null;
      }

      const type = String(rawStep.type ?? "").trim();
      const selector = String(rawStep.selector ?? "").trim();

      if (!type || !selector) {
        return null;
      }

      if (type === "click") {
        const fallbackSelectors = Array.isArray(rawStep.fallbackSelectors)
          ? rawStep.fallbackSelectors.map((value) => String(value ?? "").trim()).filter(Boolean)
          : [];
        return { type, selector, fallbackSelectors };
      }

      if (type === "setValue") {
        const events = Array.isArray(rawStep.events) && rawStep.events.length > 0
          ? rawStep.events.map((eventName) => String(eventName)).filter(Boolean)
          : ["input", "change"];
        const fallbackSelectors = Array.isArray(rawStep.fallbackSelectors)
          ? rawStep.fallbackSelectors.map((value) => String(value ?? "").trim()).filter(Boolean)
          : [];
        return {
          type,
          selector,
          value: String(rawStep.value ?? ""),
          events,
          fallbackSelectors,
        };
      }

      if (type === "setChecked") {
        const events = Array.isArray(rawStep.events) && rawStep.events.length > 0
          ? rawStep.events.map((eventName) => String(eventName)).filter(Boolean)
          : ["change"];
        const fallbackSelectors = Array.isArray(rawStep.fallbackSelectors)
          ? rawStep.fallbackSelectors.map((value) => String(value ?? "").trim()).filter(Boolean)
          : [];
        return {
          type,
          selector,
          checked: Boolean(rawStep.checked),
          events,
          fallbackSelectors,
        };
      }

      if (type === "dispatch") {
        const fallbackSelectors = Array.isArray(rawStep.fallbackSelectors)
          ? rawStep.fallbackSelectors.map((value) => String(value ?? "").trim()).filter(Boolean)
          : [];
        return {
          type,
          selector,
          event: String(rawStep.event ?? "change"),
          fallbackSelectors,
        };
      }

      return null;
    })
    .filter(Boolean);
}

function normalizeValidationCheck(rawCheck) {
  if (!rawCheck || typeof rawCheck !== "object") {
    return null;
  }

  const type = String(rawCheck.type ?? "").trim();
  const expected = rawCheck.expected;
  const selector = String(rawCheck.selector ?? "").trim();

  if (!type) {
    return null;
  }

  if (type === "exists" || type === "valueEquals" || type === "checked" || type === "textIncludes" || type === "classContains") {
    if (!selector) {
      return null;
    }
  }

  if (type === "exists") {
    return { type, selector };
  }

  if (type === "valueEquals" || type === "textIncludes" || type === "classContains") {
    return {
      type,
      selector,
      expected: String(expected ?? ""),
    };
  }

  if (type === "checked") {
    return {
      type,
      selector,
      expected: Boolean(expected),
    };
  }

  if (type === "urlIncludes" || type === "titleIncludes") {
    return {
      type,
      expected: String(expected ?? ""),
    };
  }

  return null;
}

async function inspectDom(tabId, actionRequest) {
  const executed = await chrome.scripting.executeScript({
    target: { tabId },
    func: (requestText) => {
      const text = String(requestText ?? "").toLowerCase();
      const tokens = text
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 2)
        .slice(0, 8);
      const candidateSelector =
        'button, a, label, li, option, select, input, textarea, [role="button"], [class*="swatch"], [class*="option"]';

      function pickSelector(el) {
        if (!el || !(el instanceof Element)) {
          return null;
        }

        if (el.id) {
          return `#${CSS.escape(el.id)}`;
        }

        const preferredAttrs = [
          "data-testid",
          "data-test",
          "data-qa",
          "data-id",
          "name",
          "aria-label",
          "value",
          "type",
        ];

        for (const attr of preferredAttrs) {
          const value = el.getAttribute(attr);
          if (value) {
            return `${el.tagName.toLowerCase()}[${attr}="${value.replaceAll('"', '\\"')}"]`;
          }
        }

        const classes = [...el.classList].slice(0, 2);
        if (classes.length > 0) {
          return `${el.tagName.toLowerCase()}${classes.map((name) => `.${CSS.escape(name)}`).join("")}`;
        }

        return el.tagName.toLowerCase();
      }

      function matchesTarget(content) {
        if (!content) {
          return false;
        }

        if (!tokens.length) {
          return true;
        }

        const normalized = content.toLowerCase();
        return tokens.some((token) => normalized.includes(token));
      }

      const candidates = [...document.querySelectorAll(candidateSelector)]
        .filter((el) => {
          const content = [el.textContent, el.getAttribute("value"), el.getAttribute("aria-label")]
            .filter(Boolean)
            .join(" ");
          return matchesTarget(content);
        })
        .slice(0, 40)
        .map((el) => {
          const dataAttrs = [...el.attributes]
            .filter((attribute) => attribute.name.startsWith("data-"))
            .slice(0, 6)
            .reduce((all, attribute) => {
              all[attribute.name] = attribute.value;
              return all;
            }, {});

          return {
            tag: el.tagName,
            selector: pickSelector(el),
            text: (el.textContent || "").trim().slice(0, 140),
            id: el.id || null,
            name: el.getAttribute("name"),
            type: el.getAttribute("type"),
            value: el.value || el.getAttribute("value") || null,
            href: el.getAttribute("href") || null,
            checked: typeof el.checked === "boolean" ? el.checked : null,
            disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
            dataAttrs,
          };
        });

      const leafText = [...document.querySelectorAll("*")]
        .filter((el) => el.children.length === 0)
        .map((el) => {
          return {
            text: (el.textContent || "").trim(),
            selector: pickSelector(el),
          };
        })
        .filter((item) => item.text.length > 2 && item.text.length < 100 && matchesTarget(item.text))
        .slice(0, 30);

      const selects = [...document.querySelectorAll("select")].slice(0, 10).map((select) => {
        return {
          selector: pickSelector(select),
          name: select.name || null,
          id: select.id || null,
          value: select.value,
          options: [...select.options].slice(0, 30).map((option) => {
            return {
              value: option.value,
              text: option.text.trim().slice(0, 120),
            };
          }),
        };
      });

      const inputs = [...document.querySelectorAll("input, textarea")].slice(0, 20).map((input) => {
        return {
          selector: pickSelector(input),
          tag: input.tagName,
          type: input.getAttribute("type") || "text",
          name: input.getAttribute("name"),
          placeholder: input.getAttribute("placeholder"),
          value: (input.value || "").slice(0, 80),
        };
      });

      const iframes = [...document.querySelectorAll("iframe")].slice(0, 10).map((iframe) => {
        return {
          src: iframe.getAttribute("src") || null,
          id: iframe.id || null,
          name: iframe.getAttribute("name") || null,
        };
      });

      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        candidates,
        leafText,
        selects,
        inputs,
        iframes,
      };
    },
    args: [actionRequest],
  });

  return executed?.[0]?.result ?? null;
}

async function executeStructuredStepsInTab(tabId, steps) {
  const executed = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (structuredSteps) => {
      try {
        const failures = [];
        const missingSelectors = [];
        let appliedSteps = 0;

        async function waitForElement(selectors, timeoutMs = 2500) {
          const startedAt = Date.now();

          while (Date.now() - startedAt <= timeoutMs) {
            for (const selector of selectors) {
              try {
                const element = document.querySelector(selector);
                if (element) {
                  return {
                    element,
                    selector,
                  };
                }
              } catch (_error) {
                // ignore malformed selectors and keep searching
              }
            }

            await new Promise((resolve) => {
              window.setTimeout(resolve, 150);
            });
          }

          return {
            element: null,
            selector: null,
          };
        }

        for (const step of structuredSteps) {
          const type = String(step.type ?? "");
          const selector = String(step.selector ?? "").trim();
          const fallbackSelectors = Array.isArray(step.fallbackSelectors)
            ? step.fallbackSelectors.map((value) => String(value ?? "").trim()).filter(Boolean)
            : [];
          const selectorsToTry = [selector, ...fallbackSelectors].filter(Boolean);
          const lookup = await waitForElement(selectorsToTry);
          const element = lookup.element;

          if (!element) {
            failures.push(`Element not found for selectors: ${selectorsToTry.join(" OR ")}`);
            missingSelectors.push(...selectorsToTry);
            continue;
          }

          if (type === "click") {
            element.click();
            appliedSteps += 1;
            continue;
          }

          if (type === "setValue") {
            element.value = String(step.value ?? "");
            const events = Array.isArray(step.events) && step.events.length > 0 ? step.events : ["input", "change"];
            for (const eventName of events) {
              element.dispatchEvent(new Event(String(eventName), { bubbles: true }));
            }
            appliedSteps += 1;
            continue;
          }

          if (type === "setChecked") {
            element.checked = Boolean(step.checked);
            const events = Array.isArray(step.events) && step.events.length > 0 ? step.events : ["change"];
            for (const eventName of events) {
              element.dispatchEvent(new Event(String(eventName), { bubbles: true }));
            }
            appliedSteps += 1;
            continue;
          }

          if (type === "dispatch") {
            const eventName = String(step.event ?? "change");
            if (selector === "window" && eventName === "reload") {
              window.location.reload();
              appliedSteps += 1;
              continue;
            }
            element.dispatchEvent(new Event(eventName, { bubbles: true }));
            appliedSteps += 1;
            continue;
          }

          failures.push(`Unsupported step type: ${type}`);
        }

        if (failures.length > 0) {
          return {
            ok: false,
            error: failures.join(" | "),
            appliedSteps,
            missingSelectors: [...new Set(missingSelectors)],
          };
        }

        return {
          ok: true,
          appliedSteps,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    args: [steps],
  });

  return executed?.[0]?.result ?? { ok: false, error: "Step execution did not return a result." };
}

async function captureTabScreenshot(tabId) {
  const target = { tabId };
  const protocolVersion = "1.3";
  function attach() {
    return new Promise((resolve, reject) => {
      chrome.debugger.attach(target, protocolVersion, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }
  function detach() {
    return new Promise((resolve) => {
      chrome.debugger.detach(target, () => resolve());
    });
  }
  function sendCommand(method, params = {}) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(target, method, params, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result ?? {});
      });
    });
  }
  let attached = false;
  try {
    await attach();
    attached = true;
    const result = await sendCommand("Page.captureScreenshot", { format: "png" });
    return String(result?.data ?? "");
  } finally {
    if (attached) await detach();
  }
}

let cachedLlmBackend = null;
async function getLlmBackendOnce() {
  if (cachedLlmBackend) return cachedLlmBackend;
  try {
    const r = await chrome.runtime.sendMessage({ type: "get-llm-settings" });
    if (r?.ok) cachedLlmBackend = String(r.backend ?? "local");
  } catch (_e) {
    cachedLlmBackend = "local";
  }
  return cachedLlmBackend || "local";
}

// Attach a viewport screenshot to the most recent message in the array.
// We attach to the LAST message that doesn't already have an image — this
// is normally the most recent tool response (or the original user message
// on the first turn). Safe no-op if capture fails.
async function attachScreenshotToLastMessage(messages, tabId) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  let target = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "tool" || m.role === "user") {
      target = m;
      break;
    }
  }
  if (!target) return;
  try {
    const data = await captureTabScreenshot(tabId);
    if (data) {
      target.image = data;
      appendThinking(`Captured viewport screenshot (${Math.round(data.length / 1024)}KB).`);
    }
  } catch (error) {
    appendThinking(`Screenshot capture failed: ${truncateForThinking(error instanceof Error ? error.message : String(error))}`);
  }
}

async function executeScriptToolInTab(tabId, args) {
  const script = String(args?.script ?? "").trim();
  if (!script) {
    return {
      ok: false,
      error: "executeScript requires script.",
    };
  }

  logLlmInteraction("executeScript request", {
    tabId,
    script,
  });

  const target = { tabId };
  const protocolVersion = "1.3";

  function attach() {
    return new Promise((resolve, reject) => {
      chrome.debugger.attach(target, protocolVersion, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function detach() {
    return new Promise((resolve) => {
      chrome.debugger.detach(target, () => {
        resolve();
      });
    });
  }

  function sendCommand(method, params = {}) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(target, method, params, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result ?? {});
      });
    });
  }

  const expression = `(async () => {\n${script}\n})()`;

  let attached = false;
  try {
    await attach();
    attached = true;
    const cdpResult = await sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });

    if (cdpResult?.exceptionDetails) {
      const details = cdpResult.exceptionDetails;
      const exceptionText = details?.exception?.description
        || details?.exception?.value
        || details?.text
        || "CDP Runtime.evaluate failed.";
      return {
        ok: false,
        error: String(exceptionText),
        line: Number(details?.lineNumber ?? -1) + 1,
        column: Number(details?.columnNumber ?? -1) + 1,
      };
    }

    const resultPayload = cdpResult?.result;
    const result = {
      ok: true,
      result: {
        type: resultPayload?.type ?? typeof resultPayload?.value,
        value: resultPayload?.value,
        description: resultPayload?.description ?? "",
      },
    };
    logLlmInteraction("executeScript result", result);
    return result;
  } catch (error) {
    const failed = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    logLlmInteraction("executeScript result", failed);
    return failed;
  } finally {
    if (attached) {
      await detach();
    }
  }
}

async function validateStructuredCheck(tabId, validationCheck) {
  const executed = await chrome.scripting.executeScript({
    target: { tabId },
    func: (check) => {
      try {
        const type = String(check?.type ?? "");
        const selector = String(check?.selector ?? "");
        const expected = check?.expected;
        const element = selector ? document.querySelector(selector) : null;
        let passed = false;
        let output = "";

        if (type === "exists") {
          passed = Boolean(element);
          output = `exists(${selector}) => ${passed}`;
        } else if (type === "valueEquals") {
          const actual = element ? String(element.value ?? "") : "";
          passed = Boolean(element) && actual === String(expected ?? "");
          output = `value(${selector}) => ${actual}`;
        } else if (type === "checked") {
          const actual = Boolean(element?.checked);
          passed = Boolean(element) && actual === Boolean(expected);
          output = `checked(${selector}) => ${actual}`;
        } else if (type === "textIncludes") {
          const actual = element ? String(element.textContent ?? "") : "";
          passed = Boolean(element) && actual.includes(String(expected ?? ""));
          output = `textIncludes(${selector}) => ${passed}`;
        } else if (type === "classContains") {
          passed = Boolean(element) && element.classList.contains(String(expected ?? ""));
          output = `classContains(${selector}) => ${passed}`;
        } else if (type === "urlIncludes") {
          passed = location.href.includes(String(expected ?? ""));
          output = `urlIncludes(${expected}) => ${passed}`;
        } else if (type === "titleIncludes") {
          passed = document.title.includes(String(expected ?? ""));
          output = `titleIncludes(${expected}) => ${passed}`;
        } else {
          return {
            ok: false,
            passed: false,
            error: `Unsupported validation type: ${type}`,
          };
        }

        return {
          ok: true,
          passed,
          output,
        };
      } catch (error) {
        return {
          ok: false,
          passed: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    args: [validationCheck],
  });

  return executed?.[0]?.result ?? { ok: false, passed: false, error: "Validation did not return a result." };
}

async function createModelSession() {
  return {
    async prompt(prompt, options = {}) {
      const payload = {
        prompt: Array.isArray(prompt) ? "" : prompt,
        messages: Array.isArray(prompt) ? prompt : options.messages,
        maxNewTokens: options.maxNewTokens ?? 1024,
        tools: options.tools,
        systemPrompt:
          options.systemPrompt ??
          "You write robust JavaScript snippets for Visualping script actions based on live DOM data and return strict JSON with success, message, script.",
      };

      logLlmInteraction("request", payload);

      const response = await chrome.runtime.sendMessage({
        type: "gemma-generate-text",
        payload,
      });

      if (!response?.ok) {
        logLlmInteraction("error response", response);
        throw new Error(response?.error ?? "Gemma 4 generation failed.");
      }

      const text = String(response.text ?? "");
      logLlmInteraction("response", {
        text,
        state: response.state,
      });
      return text;
    },
    destroy() {},
  };
}

async function resolveTargetTabId() {
  if (Number.isInteger(state.tabId) && state.tabId > 0) {
    return state.tabId;
  }

  const contextTabId = Number(state.context?.tabId);
  if (Number.isInteger(contextTabId) && contextTabId > 0) {
    state.tabId = contextTabId;
    return state.tabId;
  }

  const activeTab = await getCurrentActiveTab();
  if (activeTab?.id) {
    state.tabId = activeTab.id;
    return state.tabId;
  }

  throw new Error("Could not determine the target tab for script generation.");
}

async function promptModelWithExecuteScriptTool(session, tabId, prompt, actionRequest) {
  const messages = [
    {
      role: "system",
      content: [
        "You are a JavaScript automation agent.",
        "A summary of the relevant DOM (selects with their tokens-matching options, inputs, candidate elements) is provided in the first tool response. Use selectors from that summary. If you need more detail, you may call executeScript yourself to query the page.",
        "Each candidate has both a `selector` and an `index` field. When multiple candidates share the same selector, target a specific one with `document.querySelectorAll(selector)[index]`. The list order matches the DOM order (index 0 is the first, index 2 is the third, etc.). Do NOT use CSS pseudo-classes like :nth-child unless they appear in the selector itself — they will not work reliably on this page.",
        "Follow these steps in order:",
        "1. ACT – call executeScript with the action script that performs the requested operation, using selectors and indices from the summary.",
        "2. VERIFY – call executeScript to confirm the expected DOM state after ACT. Do not skip this step.",
        "3. REPORT – return strict JSON and nothing else: {\"success\":boolean,\"message\":string,\"script\":string}",
        "   • success=true only if VERIFY confirmed the result.",
        "   • message explains what was verified or why it failed.",
        "   • script MUST be a plain string of the JavaScript source code from step 1. Not an object. Not a nested tool call.",
        "   • If the action could not be completed (e.g. the target element does not exist on this page), set success=false and explain.",
      ].join("\n"),
    },
    {
      role: "user",
      content: prompt,
    },
  ];

  // Pre-INSPECT: run the host-side DOM inspector once and feed a *compact* summary
  // as a synthetic tool response so the model starts with real selectors. Heavy
  // pages would otherwise drown the context — we keep only what's relevant.
  try {
    const inspection = await inspectDom(tabId, actionRequest ?? prompt);
    if (inspection) {
      const summary = summarizeInspection(inspection, actionRequest ?? prompt);
      const counts = `${summary.selects.length} selects, ${summary.inputs.length} inputs, ${summary.candidates.length} candidates`;
      appendThinking(`Pre-INSPECT done (${counts}, payload ${JSON.stringify(summary).length}B).`);
      const preInspectId = "tool-call-pre-inspect";
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: preInspectId,
            type: "function",
            function: {
              name: "executeScript",
              arguments: { script: "/* host-side INSPECT: returns a compact summary of selects/inputs/candidates relevant to the request */" },
            },
          },
        ],
      });
      messages.push({
        role: "tool",
        tool_call_id: preInspectId,
        content: JSON.stringify({ ok: true, result: summary }),
      });
    }
  } catch (error) {
    appendThinking(`Pre-INSPECT failed: ${truncateForThinking(error instanceof Error ? error.message : String(error))}`);
  }

  const MAX_TOOL_HANDSHAKES = 4;
  let lastSuccessfulActionScript = "";
  let didRunAnyTool = false;
  const useScreenshots = (await getLlmBackendOnce()) === "claude";
  // Multi-step tool handshake so the model can iterate ACT/VERIFY, then we force REPORT.
  for (let handshake = 0; handshake < MAX_TOOL_HANDSHAKES; handshake += 1) {
    if (useScreenshots) {
      await attachScreenshotToLastMessage(messages, tabId);
    }
    logLlmInteraction("tool prompt", {
      handshake: handshake + 1,
      messages,
      tools: [EXECUTE_SCRIPT_TOOL],
    });
    const modelResponse = await session.prompt(messages, {
      tools: [EXECUTE_SCRIPT_TOOL],
      maxNewTokens: 1536,
    });
    const toolCalls = extractGemmaToolCalls(modelResponse);
    logLlmInteraction("tool response", {
      handshake: handshake + 1,
      modelResponse,
      toolCalls,
    });

    // Treat a response with a {success, script} shape as the final answer even if
    // the model wrapped it in tool-call syntax.
    if (looksLikeFinalReport(modelResponse)) {
      return { text: stripGemmaToolCalls(modelResponse), fallbackScript: lastSuccessfulActionScript };
    }

    if (!toolCalls.length) {
      const stripped = stripGemmaToolCalls(modelResponse);
      // Empty / EOS-only response after tool use → force REPORT so we don't lose the work.
      if (didRunAnyTool && !stripped) {
        break;
      }
      return { text: stripped, fallbackScript: lastSuccessfulActionScript };
    }

    appendThinking(`LLM requested ${toolCalls.length} executeScript call${toolCalls.length === 1 ? "" : "s"}.`);
    const normalizedToolCalls = [];
    messages.push({
      role: "assistant",
      content: stripGemmaToolCalls(modelResponse),
      tool_calls: normalizedToolCalls,
    });

    for (let index = 0; index < toolCalls.length; index += 1) {
      const toolCall = toolCalls[index];
      const toolCallId = toolCall.id;
      const normalizedToolCall = normalizeToolCallForMessage(toolCall, toolCallId);
      normalizedToolCalls.push(normalizedToolCall);

      if (toolCall.name !== "executeScript") {
        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: JSON.stringify({
            ok: false,
            error: `Unsupported tool: ${toolCall.name}. Only executeScript is available.`,
          }),
        });
        continue;
      }

      const toolArgs = normalizedToolCall.function.arguments;
      appendThinking(`Tool ${index + 1}/${toolCalls.length} executeScript started.`);
      const argScript = String(toolArgs?.script ?? "");
      appendThinking(`executeScript input: ${truncateForThinking(argScript, 180)}`);
      const result = await executeScriptToolInTab(tabId, toolArgs);
      didRunAnyTool = true;
      if (result?.ok) {
        appendThinking(`Tool ${index + 1}/${toolCalls.length} executeScript succeeded.`);
        if (argScript.trim()) lastSuccessfulActionScript = argScript;
      } else {
        appendThinking(`Tool ${index + 1}/${toolCalls.length} executeScript failed: ${truncateForThinking(String(result?.error ?? "Unknown error"), 220)}`);
      }
      appendThinking(`executeScript output: ${truncateForThinking(JSON.stringify(result), 220)}`);
      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: JSON.stringify(result),
      });
    }
  }

  // Forced-REPORT pass: drop tools, demand the final JSON, take one shot.
  appendThinking("Forcing REPORT pass.");
  messages.push({
    role: "user",
    content: [
      "Stop calling executeScript. Based on what you have already tried, return ONLY the final JSON now.",
      "Format: {\"success\":boolean,\"message\":string,\"script\":string}",
      "The script field MUST be a single plain-string of JavaScript source that accomplishes the original request, using the real selectors from the inspection. No nested objects, no tool-call shape.",
    ].join("\n"),
  });
  if (useScreenshots) {
    await attachScreenshotToLastMessage(messages, tabId);
  }
  logLlmInteraction("forced report prompt", { messages });
  const finalResponse = await session.prompt(messages, {
    maxNewTokens: 512,
  });
  logLlmInteraction("forced report response", { finalResponse });
  return { text: stripGemmaToolCalls(finalResponse), fallbackScript: lastSuccessfulActionScript };
}

function looksLikeFinalReport(text) {
  const value = String(text ?? "");
  // Strip code fences and Llama markers.
  const cleaned = value
    .replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, "$1")
    .replace(/<\|python_tag\|>|<\|eom_id\|>|<\|eot_id\|>/g, "")
    .trim();
  // Look for a JSON object that has both `success` and `script` keys.
  return /\"success\"\s*:/.test(cleaned) && /\"script\"\s*:/.test(cleaned) && !/\"name\"\s*:\s*\"executeScript\"/.test(cleaned);
}

async function generateScriptWithValidation(actionRequest, tabId) {
  const session = await createModelSession();
  try {
    setStatus("", "Thinking... drafting and testing script.");
    appendThinking("Prompting local LLM once with executeScript available.");
    const prompt = buildGenerationPrompt(actionRequest, "");
    const { text: modelResponse, fallbackScript } = await promptModelWithExecuteScriptTool(session, tabId, prompt, actionRequest);

    let parsed;
    try {
      parsed = await extractJsonObject(modelResponse, session);
    } catch (error) {
      const warning = `Model returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
      appendThinking(`JSON parse failed. ${truncateForThinking(warning)}`);
      return {
        script: "",
        steps: [],
        validationCheck: null,
        validationDescription: "",
        verified: false,
        stopped: false,
        warning,
        loopCount: 1,
      };
    }

    let script = coerceScriptString(parsed.script);
    if (!script && fallbackScript) {
      appendThinking("Final REPORT had no script; falling back to the last successful tool-call script.");
      script = fallbackScript.trim();
    }
    const executableScript = ensureExecutableScript(script);
    const modelSuccess = Boolean(parsed.success);
    const modelMessage = String(parsed.message ?? "").trim();

    if (!executableScript) {
      const warning = "Model returned an empty script.";
      appendThinking(warning);
      return {
        script: executableScript,
        steps: [],
        validationCheck: null,
        validationDescription: modelMessage,
        verified: false,
        stopped: false,
        warning,
        loopCount: 1,
      };
    }
    appendThinking(modelSuccess ? "Model reported success." : "Model reported failure.");
    return {
      script: executableScript,
      steps: [],
      validationCheck: null,
      validationDescription: modelMessage,
      verified: modelSuccess,
      stopped: false,
      warning: modelSuccess ? "" : (modelMessage || "Model reported unsuccessful result."),
      loopCount: 1,
    };
  } finally {
    if (typeof session.destroy === "function") {
      try {
        session.destroy();
      } catch (_error) {
        // no-op
      }
    }
  }
}

async function handleGenerate() {
  if (!state.context) {
    setStatus("error", "No job context loaded. Open this from a job row in the popup.");
    return;
  }

  const actionRequest = elements.requestInput.value.trim();
  if (!actionRequest) {
    setStatus("error", "Describe the action you want to automate.");
    return;
  }

  state.isGenerating = true;
  state.stopRequested = false;
  state.generatedScript = "";
  elements.output.value = "";
  clearThinkingLog();
  appendThinking("Starting continuous script generation loop.");
  setStatus("", "Thinking... preparing generation.");
  refreshButtonState();

  try {
    const targetTabId = await resolveTargetTabId();
    const result = await generateScriptWithValidation(actionRequest, targetTabId);
    if (result.verified && result.script) {
      state.generatedScript = result.script;
      elements.output.value = result.script;
    } else {
      state.generatedScript = "";
      elements.output.value = "";
    }

    if (result.validationDescription) {
      appendThinking(`Final message: ${result.validationDescription}`);
    }

    if (result.stopped) {
      if (result.script) {
        setStatus("warning", `Generation stopped. Last candidate is shown but not verified. ${result.warning}`);
      } else {
        setStatus("warning", "Generation stopped.");
      }
      return;
    }

    if (result.verified) {
      const successMessage = result.validationDescription || "Script generated successfully.";
      setStatus("success", successMessage);
    } else {
      const warningMessage = result.validationDescription || result.warning || "Script generation was not successful.";
      setStatus("warning", warningMessage);
    }
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : String(error));
  } finally {
    state.isGenerating = false;
    state.stopRequested = false;
    refreshButtonState();
  }
}

function handleStopGeneration() {
  if (!state.isGenerating || state.stopRequested) {
    return;
  }

  state.stopRequested = true;
  appendThinking("Stop requested by user. Finishing current in-flight step...");
  setStatus("warning", "Stopping generation after current step...");
  refreshButtonState();
}

async function handleSave() {
  if (!state.context || !state.generatedScript.trim()) {
    return;
  }

  state.isSaving = true;
  refreshButtonState();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "save-script-action",
      payload: {
        jobId: state.context.jobId,
        script: state.generatedScript,
      },
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? "Failed to save script action.");
    }

    setStatus("success", `Saved script action to job #${state.context.jobId}.`);
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : String(error));
  } finally {
    state.isSaving = false;
    refreshButtonState();
  }
}

function setRecordingStatus(type, message) {
  elements.recordingStatus.textContent = message;
  elements.recordingStatus.className = "status";
  if (type === "success") elements.recordingStatus.classList.add("is-success");
  else if (type === "warning") elements.recordingStatus.classList.add("is-warning");
  else if (type === "error") elements.recordingStatus.classList.add("is-error");
}

function refreshRecordingButtonState() {
  elements.startRecordButton.disabled = state.isRecording || !state.context;
  elements.stopRecordButton.disabled = !state.isRecording;
  elements.startRecordButton.textContent = state.isRecording ? "Recording..." : "Start Recording";
  elements.useRecordingActionsDiv.hidden = state.isRecording || state.recordedActions.length === 0;
}

function actionLabel(action) {
  switch (action.type) {
    case "click":
      return `Click${action.label ? ` "${action.label}"` : ""}  (${action.selector})`;
    case "setValue":
      return `Type "${action.value}"${action.label ? ` into "${action.label}"` : ""}  (${action.selector})`;
    case "setChecked":
      return `${action.checked ? "Check" : "Uncheck"}${action.label ? ` "${action.label}"` : ""}  (${action.selector})`;
    case "navigate":
      return `Navigate to ${action.url}`;
    default:
      return action.type;
  }
}

function renderRecordedActions() {
  const list = elements.recordedActionsList;
  const actions = state.recordedActions;

  if (actions.length === 0) {
    list.innerHTML = "";
    return;
  }

  list.innerHTML = actions
    .map(
      (action, index) =>
        `<li class="action-item action-type-${action.type}"><span class="action-index">${index + 1}</span><span class="action-text">${actionLabel(action)}</span></li>`,
    )
    .join("");

  list.scrollTop = list.scrollHeight;
}

function convertRecordingToScript(actions) {
  if (!actions.length) return "";

  const lines = [];

  for (const action of actions) {
    if (action.type === "navigate") {
      lines.push(`window.location.href = ${JSON.stringify(action.url)};`);
      continue;
    }

    if (action.type === "click") {
      const comment = action.label ? ` // ${action.label}` : "";
      lines.push(`document.querySelector(${JSON.stringify(action.selector)})?.click();${comment}`);
      continue;
    }

    if (action.type === "setValue") {
      const sel = JSON.stringify(action.selector);
      const val = JSON.stringify(action.value);
      const comment = action.label ? ` // ${action.label}` : "";
      lines.push(`(function() { var el = document.querySelector(${sel});${comment}`);
      lines.push(`  if (el) { el.value = ${val}; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }`);
      lines.push(`})();`);
      continue;
    }

    if (action.type === "setChecked") {
      const sel = JSON.stringify(action.selector);
      const comment = action.label ? ` // ${action.label}` : "";
      lines.push(`(function() { var el = document.querySelector(${sel});${comment}`);
      lines.push(`  if (el) { el.checked = ${Boolean(action.checked)}; el.dispatchEvent(new Event('change', {bubbles:true})); }`);
      lines.push(`})();`);
      continue;
    }
  }

  return lines.join("\n");
}

function convertRecordingToPreactions(actions) {
  const preactions = [];

  for (const action of actions) {
    if (action.type === "navigate") {
      preactions.push({ goto: action.url });
      continue;
    }

    if (action.type === "click") {
      preactions.push({ click: action.selector });
      continue;
    }

    if (action.type === "setValue") {
      preactions.push({ type: { field: action.selector, value: action.value } });
      continue;
    }

    if (action.type === "setChecked") {
      preactions.push({ click: action.selector });
      continue;
    }
  }

  return preactions;
}

let recordingPollTimer = null;

async function pollRecordingActions() {
  if (!state.isRecording) return;

  try {
    const tabId = await resolveTargetTabId();
    const response = await chrome.runtime.sendMessage({
      type: "get-recording-state",
      payload: { tabId },
    });

    if (response?.ok) {
      state.recordedActions = response.actions ?? [];
      const count = state.recordedActions.length;
      setRecordingStatus("", `Recording… ${count} action${count === 1 ? "" : "s"} captured`);
      renderRecordedActions();
    }
  } catch (_error) {}

  if (state.isRecording) {
    recordingPollTimer = window.setTimeout(pollRecordingActions, 600);
  }
}

async function handleStartRecording() {
  if (!state.context) {
    setRecordingStatus("error", "No job context. Open this from a job row in the popup.");
    return;
  }

  try {
    const tabId = await resolveTargetTabId();

    const response = await chrome.runtime.sendMessage({
      type: "start-recording",
      payload: { tabId, jobId: state.context.jobId },
    });

    if (!response?.ok) throw new Error(response?.error ?? "Could not start recording.");

    state.isRecording = true;
    state.recordedActions = [];
    renderRecordedActions();
    setRecordingStatus("", "Recording… interact with the page");
    document.querySelector("#recording-panel")?.classList.add("is-recording");
    refreshRecordingButtonState();

    void pollRecordingActions();
  } catch (error) {
    setRecordingStatus("error", error instanceof Error ? error.message : String(error));
  }
}

async function handleStopRecording() {
  state.isRecording = false;
  clearTimeout(recordingPollTimer);
  document.querySelector("#recording-panel")?.classList.remove("is-recording");

  try {
    const tabId = await resolveTargetTabId();

    const response = await chrome.runtime.sendMessage({
      type: "stop-recording",
      payload: { tabId },
    });

    if (response?.ok) {
      state.recordedActions = response.actions ?? [];
    }
  } catch (_error) {}

  renderRecordedActions();

  const count = state.recordedActions.length;
  if (count === 0) {
    setRecordingStatus("warning", "Recording stopped. No actions were captured.");
  } else {
    setRecordingStatus("success", `Recording stopped. ${count} action${count === 1 ? "" : "s"} captured.`);
  }

  refreshRecordingButtonState();
}

function handleUseRecording() {
  const script = convertRecordingToScript(state.recordedActions);
  if (!script) return;

  state.generatedScript = script;
  elements.output.value = script;

  const actionSummary = state.recordedActions
    .filter((a) => a.type !== "navigate")
    .map((a) => actionLabel(a))
    .slice(0, 5)
    .join("; ");

  elements.requestInput.value = actionSummary ? `Recorded: ${actionSummary}` : "Recorded actions";

  setStatus("success", "Script converted from recording. Review and save to job.");
  refreshButtonState();

  elements.output.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function handleSaveAsPreactions() {
  if (!state.context) {
    setRecordingStatus("error", "No job context.");
    return;
  }
  const preactions = convertRecordingToPreactions(state.recordedActions);
  if (!preactions.length) return;

  elements.saveAsPreactionsButton.disabled = true;
  elements.saveAsPreactionsButton.textContent = "Saving...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "save-recorded-preactions",
      payload: { jobId: state.context.jobId, actions: preactions },
    });

    if (!response?.ok) throw new Error(response?.error ?? "Failed to save actions.");

    setRecordingStatus("success", `Saved ${preactions.length} action${preactions.length === 1 ? "" : "s"} to job #${state.context.jobId}.`);
  } catch (error) {
    setRecordingStatus("error", error instanceof Error ? error.message : String(error));
  } finally {
    elements.saveAsPreactionsButton.disabled = false;
    elements.saveAsPreactionsButton.textContent = "Save as Actions";
  }
}

async function initialize() {
  refreshButtonState();
  refreshRecordingButtonState();

  const locationContext = getContextFromLocation();
  if (locationContext) {
    state.context = locationContext;
    if (Number.isInteger(Number(locationContext.tabId)) && Number(locationContext.tabId) > 0) {
      state.tabId = Number(locationContext.tabId);
    }
  }

  if (state.context) {
    updateContextText();
    setStatus("", "Enter an action and generate a script.");
    clearThinkingLog();
    refreshButtonState();
    refreshRecordingButtonState();
    return;
  }

  setStatus("", "Waiting for job context...");

  try {
    state.context = await waitForScriptGeneratorContext();
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : String(error));
    updateContextText();
    refreshButtonState();
    return;
  }

  updateContextText();
  setStatus("", "Enter an action and generate a script.");
  clearThinkingLog();
  refreshButtonState();
  refreshRecordingButtonState();
}

elements.generateButton.addEventListener("click", () => {
  void handleGenerate();
});

elements.stopButton.addEventListener("click", () => {
  handleStopGeneration();
});

elements.saveButton.addEventListener("click", () => {
  void handleSave();
});

elements.startRecordButton.addEventListener("click", () => {
  void handleStartRecording();
});

elements.stopRecordButton.addEventListener("click", () => {
  void handleStopRecording();
});

elements.useRecordingButton.addEventListener("click", () => {
  handleUseRecording();
});

elements.saveAsPreactionsButton.addEventListener("click", () => {
  void handleSaveAsPreactions();
});

void initialize();
