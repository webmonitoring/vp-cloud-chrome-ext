import {
  DynamicCache,
  ModelRegistry,
  TextStreamer,
  env,
  pipeline,
} from "@huggingface/transformers";

export const GEMMA_MODEL = Object.freeze({
  id: "onnx-community/Qwen2.5-Coder-0.5B-Instruct",
  title: "Qwen2.5 Coder 0.5B",
  dtype: "q4f16",
  task: "text-generation",
});

const END_OF_TEXT_TOKEN_REGEX = /<\|end_of_text\|>/g;

let textGenerationPipelinePromise = null;
let pastKeyValues = null;

function extensionUrl(path) {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }

  return path;
}

function configureTransformersEnvironment() {
  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.useWasmCache = true;

  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.wasmPaths = {
      mjs: extensionUrl("lib/vendor/ort/ort-wasm-simd-threaded.asyncify.mjs"),
      wasm: extensionUrl("lib/vendor/ort/ort-wasm-simd-threaded.asyncify.wasm"),
    };
  }
}

function sanitizeModelText(text) {
  return String(text ?? "").replace(END_OF_TEXT_TOKEN_REGEX, "").trim();
}

function normalizeProgress(progress) {
  const value = Number(progress);
  if (!Number.isFinite(value)) {
    return null;
  }

  if (value <= 1) {
    return Math.max(0, Math.min(100, value * 100));
  }

  return Math.max(0, Math.min(100, value));
}

function notifyProgress(onProgress, progress) {
  const percentage = normalizeProgress(progress);
  if (percentage === null) {
    return;
  }

  onProgress({
    modelId: GEMMA_MODEL.id,
    percentage,
  });
}

function buildMessages(systemPrompt, prompt) {
  if (Array.isArray(prompt)) {
    return prompt;
  }

  const messages = [];
  const normalizedSystemPrompt = String(systemPrompt ?? "").trim();
  if (normalizedSystemPrompt) {
    messages.push({
      role: "system",
      content: normalizedSystemPrompt,
    });
  }

  messages.push({
    role: "user",
    content: String(prompt ?? ""),
  });

  return messages;
}

export async function getGemmaModelStatus() {
  configureTransformersEnvironment();

  const files = await ModelRegistry.get_pipeline_files(GEMMA_MODEL.task, GEMMA_MODEL.id, {
    dtype: GEMMA_MODEL.dtype,
  });
  const metas = await Promise.all(
    files.map((file) => ModelRegistry.get_file_metadata(GEMMA_MODEL.id, file))
  );
  const size = metas.reduce((total, item) => total + Number(item?.size ?? 0), 0);
  const cached = await ModelRegistry.is_pipeline_cached(GEMMA_MODEL.task, GEMMA_MODEL.id, {
    dtype: GEMMA_MODEL.dtype,
  });

  return {
    modelId: GEMMA_MODEL.id,
    title: GEMMA_MODEL.title,
    dtype: GEMMA_MODEL.dtype,
    task: GEMMA_MODEL.task,
    size,
    cached,
  };
}

export async function initializeGemmaModel(onProgress = () => {}) {
  configureTransformersEnvironment();

  if (textGenerationPipelinePromise) {
    return textGenerationPipelinePromise;
  }

  textGenerationPipelinePromise = pipeline(GEMMA_MODEL.task, GEMMA_MODEL.id, {
    dtype: GEMMA_MODEL.dtype,
    device: "webgpu",
    progress_callback(event) {
      if (event?.status === "progress_total") {
        notifyProgress(onProgress, event.progress);
      }
    },
  }).catch((error) => {
    textGenerationPipelinePromise = null;
    throw error;
  });

  return textGenerationPipelinePromise;
}

export async function generateGemmaText(prompt, options = {}) {
  const pipe = await initializeGemmaModel(options.onProgress);
  const messages = Array.isArray(options.messages)
    ? options.messages
    : buildMessages(options.systemPrompt, prompt);
  let response = "";

  if (pastKeyValues && options.resetCache === true && typeof pastKeyValues.dispose === "function") {
    pastKeyValues.dispose();
    pastKeyValues = null;
  }

  if (!pastKeyValues) {
    pastKeyValues = new DynamicCache();
  }

  const streamer = new TextStreamer(pipe.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: false,
    callback_function(token) {
      response += token;
      if (typeof options.onToken === "function") {
        options.onToken(sanitizeModelText(response));
      }
    },
  });

  const output = await pipe(messages, {
    add_generation_prompt: true,
    past_key_values: pastKeyValues,
    max_new_tokens: Number(options.maxNewTokens ?? 1024),
    do_sample: false,
    tools: Array.isArray(options.tools) ? options.tools : null,
    streamer,
  });

  if (!response.trim()) {
    const generatedText = output?.[0]?.generated_text;
    if (Array.isArray(generatedText)) {
      const lastMessage = generatedText[generatedText.length - 1];
      response = typeof lastMessage === "string" ? lastMessage : String(lastMessage?.content ?? "");
    } else if (typeof generatedText === "string") {
      response = generatedText;
    }
  }

  return sanitizeModelText(response);
}

export function resetGemmaConversationCache() {
  if (pastKeyValues && typeof pastKeyValues.dispose === "function") {
    pastKeyValues.dispose();
  }
  pastKeyValues = null;
}
