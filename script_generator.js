const state = {
  tabId: null,
  context: null,
  generatedScript: "",
  isGenerating: false,
  isSaving: false,
  stopRequested: false,
  thinkingEntries: [],
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
};

const MODEL_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

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

function buildGenerationPrompt(actionRequest, domSnapshot, previousFailure = "") {
  const retryContext = previousFailure
    ? `Previous attempt failed: ${previousFailure}\nProduce corrected script, steps, and validationCheck.`
    : "";

  return [
    "You generate JavaScript snippets for Visualping Script actions.",
    "Use the live DOM snapshot to choose stable selectors.",
    "Return JSON only with keys: script, steps, validationCheck, validationDescription.",
    "Requirements:",
    "- script must be plain JavaScript, no markdown fences.",
    "- script must execute immediately when run (not only define a function).",
    "- do not return only a function declaration or function expression.",
    "- if helper functions are defined, invoke them in the script.",
    "- include error handling and console confirmation logs.",
    "- steps is an array that mirrors the script with structured actions for CSP-safe verification.",
    "- Each step must be one of:",
    "  {\"type\":\"click\",\"selector\":\"...\"}",
    "  {\"type\":\"setValue\",\"selector\":\"...\",\"value\":\"...\",\"events\":[\"input\",\"change\"],\"fallbackSelectors\":[\"...\"]}",
    "  {\"type\":\"setChecked\",\"selector\":\"...\",\"checked\":true,\"events\":[\"change\"],\"fallbackSelectors\":[\"...\"]}",
    "  {\"type\":\"dispatch\",\"selector\":\"...\",\"event\":\"change\"}",
    "- Any step may include fallbackSelectors (array of alternate selectors).",
    "- validationCheck must be one of:",
    "  {\"type\":\"exists\",\"selector\":\"...\"}",
    "  {\"type\":\"valueEquals\",\"selector\":\"...\",\"expected\":\"...\"}",
    "  {\"type\":\"checked\",\"selector\":\"...\",\"expected\":true}",
    "  {\"type\":\"textIncludes\",\"selector\":\"...\",\"expected\":\"...\"}",
    "  {\"type\":\"classContains\",\"selector\":\"...\",\"expected\":\"...\"}",
    "  {\"type\":\"urlIncludes\",\"expected\":\"...\"}",
    "  {\"type\":\"titleIncludes\",\"expected\":\"...\"}",
    "- validationCheck must evaluate true when the action worked.",
    "- use click() for buttons/links/labels/radios.",
    "- use value + input/change events for text/select inputs.",
    "- prefer id, name, value, or data-* selectors over brittle class-only selectors.",
    "- If prior selectors failed, choose selectors from the provided live DOM snapshot candidates/selects/inputs.",
    retryContext,
    `User action request: ${actionRequest}`,
    `Live DOM snapshot JSON: ${JSON.stringify(domSnapshot)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
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
            element.dispatchEvent(new Event(String(step.event ?? "change"), { bubbles: true }));
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
  if (!("LanguageModel" in globalThis)) {
    throw new Error("Prompt API is unavailable in this Chrome build. Enable the Prompt API and reload the extension.");
  }

  const availability = await LanguageModel.availability(MODEL_OPTIONS);
  if (availability === "unavailable") {
    throw new Error("Chrome's local model is unavailable on this device/profile.");
  }

  const session = await LanguageModel.create({
    ...MODEL_OPTIONS,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        const percent = Math.round(Number(event.loaded ?? 0) * 100);
        setStatus("", `Downloading model: ${percent}%`);
      });
    },
    initialPrompts: [
      {
        role: "system",
        content:
          "You write robust JavaScript snippets for Visualping script actions based on live DOM data and return strict JSON with script, steps, validationCheck, validationDescription.",
      },
    ],
  });

  return session;
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

async function generateScriptWithValidation(actionRequest, tabId) {
  let previousFailure = "";
  let bestCandidate = null;
  let loopCount = 0;

  function buildStoppedResult() {
    return {
      script: bestCandidate?.script ?? "",
      steps: bestCandidate?.steps ?? [],
      validationCheck: bestCandidate?.validationCheck ?? null,
      validationDescription: bestCandidate?.validationDescription ?? "",
      verified: false,
      stopped: true,
      warning: previousFailure || "Generation stopped by user.",
      loopCount,
    };
  }

  while (true) {
    if (state.stopRequested) {
      appendThinking("Stop requested. Ending generation loop.");
      return buildStoppedResult();
    }

    loopCount += 1;
    setStatus("", "Thinking... inspecting live page DOM.");
    appendThinking(`Loop ${loopCount}: inspecting live DOM.`);
    const domSnapshot = await inspectDom(tabId, actionRequest);
    if (!domSnapshot) {
      throw new Error("Could not inspect the page DOM. Keep the target tab open and try again.");
    }

    if (state.stopRequested) {
      appendThinking("Stop requested after DOM inspection.");
      return buildStoppedResult();
    }

    const session = await createModelSession();
    try {
      if (previousFailure) {
        appendThinking(`Previous failure signal: ${truncateForThinking(previousFailure)}`);
      }

      setStatus("", "Thinking... drafting and repairing script.");
      appendThinking("Prompting local LLM for the next script candidate.");
      const prompt = buildGenerationPrompt(actionRequest, domSnapshot, previousFailure);
      const modelResponse = await session.prompt(prompt);

      if (state.stopRequested) {
        appendThinking("Stop requested after model response.");
        return buildStoppedResult();
      }

      let parsed;
      try {
        parsed = await extractJsonObject(modelResponse, session);
      } catch (error) {
        previousFailure = `Model returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
        appendThinking(`JSON parse failed. ${truncateForThinking(previousFailure)}`);
        await sleep(400);
        continue;
      }
      const script = String(parsed.script ?? "").trim();
      const executableScript = ensureExecutableScript(script);
      const validationDescription = String(parsed.validationDescription ?? "").trim();
      const steps = normalizeStructuredSteps(parsed.steps);
      const validationCheck = normalizeValidationCheck(parsed.validationCheck);

      if (!executableScript) {
        previousFailure = "Model returned an empty script.";
        appendThinking(previousFailure);
        await sleep(400);
        continue;
      }

      if (!steps.length) {
        previousFailure = "Model returned empty structured steps.";
        appendThinking(previousFailure);
        await sleep(400);
        continue;
      }

      if (!validationCheck) {
        previousFailure = "Model returned an invalid validation check.";
        appendThinking(previousFailure);
        await sleep(400);
        continue;
      }

      bestCandidate = {
        script: executableScript,
        steps,
        validationCheck,
        validationDescription,
      };

      setStatus("", "Thinking... running candidate actions.");
      appendThinking("Running structured actions in the target tab.");
      const executionResult = await executeStructuredStepsInTab(tabId, steps);
      if (!executionResult.ok) {
        const missingSelectors = Array.isArray(executionResult.missingSelectors)
          ? executionResult.missingSelectors.filter(Boolean).slice(0, 10)
          : [];
        const availableSelectors = Array.isArray(domSnapshot.candidates)
          ? domSnapshot.candidates
              .map((candidate) => candidate?.selector)
              .filter(Boolean)
              .slice(0, 20)
          : [];
        const missingDetails = missingSelectors.length
          ? ` Missing selectors: ${missingSelectors.join(", ")}.`
          : "";
        const availableDetails = availableSelectors.length
          ? ` Available selectors from page snapshot: ${availableSelectors.join(", ")}.`
          : "";
        previousFailure = `Script execution failed: ${executionResult.error}.${missingDetails}${availableDetails}`;
        appendThinking(`Execution failed. ${truncateForThinking(previousFailure)}`);
        await sleep(500);
        continue;
      }

      if (state.stopRequested) {
        appendThinking("Stop requested after step execution.");
        return buildStoppedResult();
      }

      setStatus("", "Thinking... validating resulting page state.");
      appendThinking("Validating the outcome.");
      const validationResult = await validateStructuredCheck(tabId, validationCheck);
      if (!validationResult.ok) {
        previousFailure = `Validation failed: ${validationResult.error}`;
        appendThinking(`Validation error. ${truncateForThinking(previousFailure)}`);
        await sleep(500);
        continue;
      }

      if (validationResult.passed) {
        appendThinking(`Verified successfully on loop ${loopCount}.`);
        return {
          ...bestCandidate,
          verified: true,
          stopped: false,
          warning: "",
          loopCount,
        };
      }

      previousFailure = `Validation check returned false. Check: ${JSON.stringify(validationCheck)}. Observed: ${String(validationResult.output ?? "")}`;
      appendThinking(`Validation not satisfied. ${truncateForThinking(previousFailure)}`);
      await sleep(500);
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
    if (result.script) {
      state.generatedScript = result.script;
      elements.output.value = result.script;
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
      const validationMessage = result.validationDescription
        ? ` Script verified. ${result.validationDescription}`
        : " Script verified.";
      setStatus("success", `Script generated.${validationMessage}`);
    } else {
      setStatus("warning", `Script generated but not verified: ${result.warning}`);
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

async function initialize() {
  refreshButtonState();

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

void initialize();
