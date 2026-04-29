if (!window.__vpRecorderInstalled) {
  window.__vpRecorderInstalled = true;

  function pickSelector(el) {
    if (!el || !(el instanceof Element)) return null;

    if (el.id) return `#${CSS.escape(el.id)}`;

    const stableAttrs = ["data-testid", "data-test", "data-qa", "data-id", "name", "aria-label"];
    for (const attr of stableAttrs) {
      const value = el.getAttribute(attr);
      if (value) return `${el.tagName.toLowerCase()}[${attr}="${value.replaceAll('"', '\\"')}"]`;
    }

    const type = el.getAttribute("type");
    if (type && el.tagName === "INPUT") {
      const name = el.getAttribute("name");
      if (name) return `input[type="${type}"][name="${name.replaceAll('"', '\\"')}"]`;
      return `input[type="${type}"]`;
    }

    const classes = [...el.classList].slice(0, 2);
    if (classes.length > 0) {
      return `${el.tagName.toLowerCase()}${classes.map((c) => `.${CSS.escape(c)}`).join("")}`;
    }

    return el.tagName.toLowerCase();
  }

  function getLabelText(el) {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim().slice(0, 80);

    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim().slice(0, 80);
    }

    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim().slice(0, 80);

    const text = el.textContent?.trim().slice(0, 80);
    if (text) return text;

    return "";
  }

  function sendAction(action) {
    try {
      chrome.runtime.sendMessage({ type: "recording-action", payload: action });
    } catch (_error) {
      // Extension may have been reloaded
    }
  }

  // Click events — skip plain text inputs (captured on blur instead)
  document.addEventListener(
    "click",
    (event) => {
      const el = event.target;
      if (!el || !(el instanceof Element)) return;

      const tag = el.tagName.toLowerCase();
      const inputType = el.getAttribute("type")?.toLowerCase();

      if (tag === "input" || tag === "textarea" || tag === "select") {
        if (inputType === "checkbox" || inputType === "radio") {
          sendAction({
            type: "setChecked",
            selector: pickSelector(el),
            checked: el.checked,
            label: getLabelText(el),
            timestamp: Date.now(),
          });
        }
        return;
      }

      const selector = pickSelector(el);
      if (!selector) return;

      sendAction({
        type: "click",
        selector,
        label: getLabelText(el),
        timestamp: Date.now(),
      });
    },
    true,
  );

  // Track pre-focus value to detect changes on blur
  const preFocusValues = new WeakMap();

  document.addEventListener(
    "focus",
    (event) => {
      const el = event.target;
      if (!el || !(el instanceof Element)) return;
      const tag = el.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea") return;
      const inputType = el.getAttribute("type")?.toLowerCase();
      if (inputType === "checkbox" || inputType === "radio") return;
      preFocusValues.set(el, el.value);
    },
    true,
  );

  document.addEventListener(
    "blur",
    (event) => {
      const el = event.target;
      if (!el || !(el instanceof Element)) return;
      const tag = el.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea") return;
      const inputType = el.getAttribute("type")?.toLowerCase();
      if (inputType === "checkbox" || inputType === "radio") return;

      const newValue = el.value;
      const oldValue = preFocusValues.get(el);
      if (newValue === oldValue) return;

      const selector = pickSelector(el);
      if (!selector) return;

      sendAction({
        type: "setValue",
        selector,
        value: newValue,
        label: getLabelText(el),
        timestamp: Date.now(),
      });
    },
    true,
  );

  // Select dropdowns
  document.addEventListener(
    "change",
    (event) => {
      const el = event.target;
      if (!el || !(el instanceof Element)) return;
      if (el.tagName.toLowerCase() !== "select") return;

      const selector = pickSelector(el);
      if (!selector) return;

      const selectedOption = el.options[el.selectedIndex];

      sendAction({
        type: "setValue",
        selector,
        value: el.value,
        label: selectedOption?.text?.trim().slice(0, 80) || getLabelText(el),
        timestamp: Date.now(),
      });
    },
    true,
  );

  // Recording badge
  const badge = document.createElement("div");
  badge.id = "__vp-recorder-badge";
  badge.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ff4444;margin-right:5px;animation:__vp-pulse 1s infinite"></span>REC';
  badge.style.cssText = [
    "position:fixed",
    "top:12px",
    "right:12px",
    "z-index:2147483647",
    "background:rgba(20,10,5,0.82)",
    "color:#fff",
    "padding:5px 11px",
    "border-radius:999px",
    "font:bold 11px/1.4 sans-serif",
    "letter-spacing:0.06em",
    "pointer-events:none",
    "box-shadow:0 2px 10px rgba(0,0,0,0.4)",
    "display:flex",
    "align-items:center",
  ].join(";");

  const style = document.createElement("style");
  style.textContent = "@keyframes __vp-pulse{0%,100%{opacity:1}50%{opacity:0.3}}";
  document.head?.appendChild(style);
  document.documentElement.appendChild(badge);
}
