// Bridge for the "Edit Actions in Extension" button on visualping.io job pages.
// Marks the page so the host app can show extension-only UI, then forwards the
// `visualping:edit-actions-in-extension` event to the background SW.

// Marker the page can check synchronously to detect the extension.
document.documentElement.setAttribute("data-vp-extension", "installed");
// Ready event for pages that mount before this content script runs.
queueMicrotask(() => {
  window.dispatchEvent(new Event("visualping:extension-ready"));
});

// Receive messages from the background SW and re-dispatch them as DOM events
// on `window` so the page's React listeners can pick them up.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "visualping:actions-from-extension") {
    window.dispatchEvent(
      new CustomEvent("visualping:actions-from-extension", {
        detail: message.payload ?? {},
      }),
    );
  }
});

window.addEventListener("visualping:edit-actions-in-extension", (event) => {
  const url = typeof event?.detail?.url === "string" ? event.detail.url.trim() : "";
  if (!url) return;
  chrome.runtime
    .sendMessage({
      type: "open-script-generator-from-page",
      payload: { url },
    })
    .then((response) => {
      if (!response?.ok) {
        // eslint-disable-next-line no-console
        console.warn("[Visualping] open script generator failed:", response?.error);
      }
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.warn("[Visualping] open script generator error:", error);
    });
});
