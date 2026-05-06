import {
  generateGemmaText,
  getGemmaModelStatus,
  initializeGemmaModel,
  resetGemmaConversationCache,
} from "./lib/gemma/engine.js";

function sendBackgroundMessage(message) {
  return chrome.runtime.sendMessage({
    target: "gemma-background",
    ...message,
  });
}

function sendProgress(state) {
  return sendBackgroundMessage({
    type: "gemma-model-progress",
    state,
  }).catch(() => {
    // Background may have restarted; the next request will recreate state.
  });
}

async function handleGemmaRequest(message) {
  if (message.type === "gemma-model-status") {
    return getGemmaModelStatus();
  }

  if (message.type === "initialize-gemma-model") {
    await initializeGemmaModel(({ percentage }) => {
      void sendProgress({
        status: "downloading",
        percentage,
        error: "",
      });
    });
    return { ok: true };
  }

  if (message.type === "gemma-generate-text") {
    const payload = message.payload ?? {};
    const text = await generateGemmaText(payload.prompt, {
      messages: payload.messages,
      systemPrompt: payload.systemPrompt,
      maxNewTokens: payload.maxNewTokens,
      resetCache: payload.resetCache !== false,
      tools: payload.tools,
      onProgress({ percentage }) {
        void sendProgress({
          status: "downloading",
          percentage,
          error: "",
        });
      },
    });
    return { text };
  }

  if (message.type === "reset-gemma-conversation-cache") {
    resetGemmaConversationCache();
    return { ok: true };
  }

  throw new Error(`Unknown Gemma offscreen request: ${message.type}`);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "gemma-offscreen") {
    return false;
  }

  (async () => {
    try {
      const result = await handleGemmaRequest(message);
      await sendBackgroundMessage({
        requestId: message.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      await sendBackgroundMessage({
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return false;
});
