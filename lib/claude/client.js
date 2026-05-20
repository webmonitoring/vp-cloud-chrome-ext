// Minimal Anthropic Messages API client for the extension's background SW.
// No SDK — direct fetch. Maps the extension's internal message+tool shape to
// Anthropic's structured tool_use/tool_result format, then serializes any
// tool_use blocks in the response back to <tool_call>{...}</tool_call> strings
// so the existing parser in script_generator.js picks them up unchanged.

import {
  ANTHROPIC_API_BASE,
  DEFAULT_CLAUDE_MODEL,
} from "../constants.js";

const ANTHROPIC_VERSION = "2023-06-01";

function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .map((t) => {
      const fn = t.function ?? t;
      if (!fn?.name) return null;
      return {
        name: String(fn.name),
        description: String(fn.description ?? ""),
        input_schema: fn.parameters ?? { type: "object", properties: {} },
      };
    })
    .filter(Boolean);
}

// Convert our internal messages array into Anthropic's format.
// Our shape: { role: "system"|"user"|"assistant"|"tool", content: string,
//   tool_calls?: [{ id, type:"function", function:{name, arguments} }],
//   tool_call_id?: string }
// Anthropic shape: separate `system` field + messages with only "user"/"assistant",
// where assistant tool calls become tool_use blocks and tool responses become
// user messages containing tool_result blocks.
function imageBlock(base64Png) {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: String(base64Png) },
  };
}

function toAnthropicMessages(internalMessages) {
  let systemText = "";
  const messages = [];
  for (const msg of internalMessages || []) {
    if (!msg) continue;
    if (msg.role === "system") {
      systemText += (systemText ? "\n\n" : "") + String(msg.content ?? "");
      continue;
    }
    if (msg.role === "user") {
      const text = String(msg.content ?? "");
      if (msg.image) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text },
            imageBlock(msg.image),
          ],
        });
      } else {
        messages.push({ role: "user", content: text });
      }
      continue;
    }
    if (msg.role === "assistant") {
      const blocks = [];
      const text = String(msg.content ?? "").trim();
      if (text) blocks.push({ type: "text", text });
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      for (const tc of toolCalls) {
        const fn = tc.function ?? {};
        let input = fn.arguments;
        if (typeof input === "string") {
          try { input = JSON.parse(input); } catch (_e) { input = {}; }
        }
        if (input == null || typeof input !== "object") input = {};
        blocks.push({
          type: "tool_use",
          id: String(tc.id ?? `tool_${messages.length}_${blocks.length}`),
          name: String(fn.name ?? "executeScript"),
          input,
        });
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: "" });
      messages.push({ role: "assistant", content: blocks });
      continue;
    }
    if (msg.role === "tool") {
      // Tool responses ride on a user-role message as tool_result blocks.
      const blocks = [
        {
          type: "tool_result",
          tool_use_id: String(msg.tool_call_id ?? ""),
          content: String(msg.content ?? ""),
        },
      ];
      if (msg.image) blocks.push(imageBlock(msg.image));
      messages.push({ role: "user", content: blocks });
      continue;
    }
  }
  return { system: systemText, messages };
}

function serializeContentForParser(contentBlocks) {
  const parts = [];
  for (const block of contentBlocks || []) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block?.type === "tool_use") {
      // Wrap Claude's structured tool_use back into the Qwen-style tag so
      // extractGemmaToolCalls in script_generator.js picks it up.
      const payload = JSON.stringify({
        name: String(block.name ?? ""),
        arguments: block.input ?? {},
      });
      parts.push(`<tool_call>${payload}</tool_call>`);
    }
  }
  return parts.join("");
}

export async function promptClaude(prompt, options = {}) {
  const apiKey = String(options.apiKey ?? "").trim();
  if (!apiKey) {
    throw new Error("Claude API key is missing. Set it in Settings.");
  }
  const model = String(options.model ?? DEFAULT_CLAUDE_MODEL);
  const internalMessages = Array.isArray(options.messages)
    ? options.messages
    : prompt
      ? [{ role: "user", content: String(prompt) }]
      : [];
  if (options.systemPrompt) {
    internalMessages.unshift({ role: "system", content: String(options.systemPrompt) });
  }
  const { system, messages } = toAnthropicMessages(internalMessages);
  const tools = toAnthropicTools(options.tools);

  // Cache the system block so repeated generations within the same session
  // are cheaper — system + tools share the cached prefix.
  const systemPayload = system
    ? [
        {
          type: "text",
          text: system,
          cache_control: { type: "ephemeral" },
        },
      ]
    : undefined;

  const body = {
    model,
    max_tokens: Math.max(256, Number(options.maxNewTokens ?? 1024)),
    messages,
  };
  if (systemPayload) body.system = systemPayload;
  if (tools && tools.length) body.tools = tools;

  const response = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    let errMsg = `Claude API error ${response.status}`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed?.error?.message) errMsg += `: ${parsed.error.message}`;
    } catch (_e) {
      if (errText) errMsg += `: ${errText.slice(0, 200)}`;
    }
    throw new Error(errMsg);
  }

  const json = await response.json();
  return serializeContentForParser(json?.content);
}
