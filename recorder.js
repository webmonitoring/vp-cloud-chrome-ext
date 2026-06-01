if (!window.__vpRecorderInstalled) {
  window.__vpRecorderInstalled = true;

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function segmentFor(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `#${CSS.escape(el.id)}`;
    const siblings = el.parentElement
      ? [...el.parentElement.children].filter((c) => c.tagName === el.tagName)
      : [];
    if (siblings.length > 1) {
      const n = siblings.indexOf(el) + 1;
      return `${tag}:nth-of-type(${n})`;
    }
    return tag;
  }

  function getUniqueSelector(selector, el) {
    if (isUnique(selector)) return selector;

    // Walk up building a path until the selector is unique
    const segments = [segmentFor(el)];
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      segments.unshift(segmentFor(node));
      const path = segments.join(" > ");
      if (isUnique(path)) return path;
      if (node.id) break; // id anchor reached, no point going higher
      node = node.parentElement;
    }

    // Last resort: document-level index among all matching elements
    const all = [...document.querySelectorAll(el.tagName.toLowerCase())];
    const n = all.indexOf(el);
    if (n >= 0) return `${el.tagName.toLowerCase()}:nth-of-type(${n + 1})`;

    return selector;
  }

  function nthTagSelector(el) {
    const tag = el.tagName.toLowerCase();
    if (tag !== "select" && tag !== "input" && tag !== "textarea") return null;
    const all = [...document.querySelectorAll(tag)];
    const n = all.indexOf(el);
    if (n < 0) return null;
    return `(//${tag})[${n + 1}]`;
  }

  function xpathSelector(el) {
    const tag = el.tagName.toLowerCase();
    const text = el.textContent?.trim();
    if (text && text.length <= 80 && !text.includes('"')) {
      if (tag === "button" || tag === "a" || tag === "label") {
        return `xpath/.//${tag}[normalize-space(.)="${text}"]`;
      }
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && !ariaLabel.includes('"')) {
      return `xpath/.//${tag}[@aria-label="${ariaLabel}"]`;
    }
    return null;
  }

  function pickSelectors(el) {
    if (!el || !(el instanceof Element)) return null;

    const candidates = [];

    const add = (sel) => {
      if (sel && !candidates.includes(sel)) candidates.push(sel);
    };

    if (el.id) add(`#${CSS.escape(el.id)}`);

    const stableAttrs = ["data-testid", "data-test", "data-qa", "data-id"];
    for (const attr of stableAttrs) {
      const value = el.getAttribute(attr);
      if (value) {
        add(getUniqueSelector(`${el.tagName.toLowerCase()}[${attr}="${value.replaceAll('"', '\\"')}"]`, el));
      }
    }

    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) {
      add(getUniqueSelector(`${el.tagName.toLowerCase()}[aria-label="${ariaLabel.replaceAll('"', '\\"')}"]`, el));
    }

    const name = el.getAttribute("name");
    if (name) {
      add(getUniqueSelector(`${el.tagName.toLowerCase()}[name="${name.replaceAll('"', '\\"')}"]`, el));
    }

    const type = el.getAttribute("type");
    if (type && el.tagName === "INPUT") {
      if (name) {
        add(`input[type="${type}"][name="${name.replaceAll('"', '\\"')}"]`);
      } else {
        add(getUniqueSelector(`input[type="${type}"]`, el));
      }
    }

    const xpath = xpathSelector(el);
    if (xpath) add(xpath);

    const nthTag = nthTagSelector(el);
    if (nthTag) add(nthTag);

    const classes = [...el.classList].slice(0, 2);
    if (classes.length > 0) {
      add(getUniqueSelector(`${el.tagName.toLowerCase()}${classes.map((c) => `.${CSS.escape(c)}`).join("")}`, el));
    }

    add(getUniqueSelector(el.tagName.toLowerCase(), el));

    return candidates.length > 0 ? candidates : null;
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
          const selectors = pickSelectors(el);
          if (!selectors) return;
          sendAction({
            type: "setChecked",
            selectors,
            checked: el.checked,
            label: getLabelText(el),
            timestamp: Date.now(),
          });
        }
        return;
      }

      const selectors = pickSelectors(el);
      if (!selectors) return;

      sendAction({
        type: "click",
        selectors,
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

      const selectors = pickSelectors(el);
      if (!selectors) return;

      sendAction({
        type: "setValue",
        selectors,
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

      const selectors = pickSelectors(el);
      if (!selectors) return;

      const selectedOption = el.options[el.selectedIndex];

      sendAction({
        type: "selectValue",
        selectors,
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
