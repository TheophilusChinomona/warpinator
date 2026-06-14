// warpinator bridge — Phase 2 real inference via Pi (@mariozechner/pi-ai).
// Decodes a Warp multi-agent Request into a Pi conversation, runs a streaming
// completion against the user's configured provider (OpenRouter, key read from
// Pi's own ~/.pi/agent/auth.json), and surfaces text deltas to the caller.
//
// pi-ai is ESM-only; this file is CommonJS, so we load it via dynamic import().
const fs = require("fs");
const os = require("os");
const path = require("path");

let piPromise;
function getPi() {
  return (piPromise ||= import("@mariozechner/pi-ai"));
}

// Provider/model. OpenRouter is what the user has configured; the model id must
// be one Pi knows for that provider (see models.generated). Override via env.
const PROVIDER = process.env.BRIDGE_PROVIDER || "openrouter";
const DEFAULT_MODEL = process.env.BRIDGE_MODEL || "openrouter/owl-alpha";

// Read the provider key from Pi's auth store (~/.pi/agent/auth.json -> {provider:{key}}),
// falling back to the conventional env var.
function loadApiKey(provider = PROVIDER) {
  const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const entry = auth && auth[provider];
    const key = entry && (typeof entry === "string" ? entry : entry.key);
    if (typeof key === "string" && key.length) return key;
  } catch (_) {
    /* fall through to env */
  }
  return process.env[`${provider.toUpperCase()}_API_KEY`] || process.env.OPENROUTER_API_KEY || null;
}

// Build a Pi `Context` from a decoded Warp Request: prior task messages become
// the conversation history, and the new input is the latest user turn.
function buildContext(reqObj) {
  const messages = [];
  const tasks = (reqObj.task_context && reqObj.task_context.tasks) || [];
  for (const t of tasks) {
    for (const m of t.messages || []) {
      if (m.user_query && m.user_query.query) {
        messages.push({ role: "user", content: m.user_query.query, timestamp: 0 });
      } else if (m.agent_output && m.agent_output.text) {
        messages.push({ role: "assistant", content: [{ type: "text", text: m.agent_output.text }], timestamp: 0 });
      }
    }
  }
  const inputs = (reqObj.input && reqObj.input.user_inputs && reqObj.input.user_inputs.inputs) || [];
  for (const i of inputs) {
    if (i.user_query && i.user_query.query) {
      messages.push({ role: "user", content: i.user_query.query, timestamp: 0 });
    }
  }
  return {
    systemPrompt:
      "You are the AI assistant inside warpinator, an open-source build of the Warp terminal. " +
      "Be concise and helpful.",
    messages,
  };
}

// Run a streaming completion. Calls onDelta(text) per token, onDone() at the
// end, onError(Error) on failure. Returns the final accumulated text.
async function runInference(reqObj, { onDelta, onDone, onError } = {}) {
  const apiKey = loadApiKey();
  if (!apiKey) {
    onError && onError(new Error(`No ${PROVIDER} key in ~/.pi/agent/auth.json or env`));
    return "";
  }
  const context = buildContext(reqObj);
  if (!context.messages.length) {
    onError && onError(new Error("Request contained no user message"));
    return "";
  }
  let full = "";
  try {
    const { getModel, stream } = await getPi();
    const model = getModel(PROVIDER, DEFAULT_MODEL);
    console.log(`  inference: ${PROVIDER}/${DEFAULT_MODEL}, ${context.messages.length} msg(s)`);
    const events = stream(model, context, { apiKey });
    for await (const evt of events) {
      if (evt.type === "text_delta" && evt.delta) {
        full += evt.delta;
        onDelta && onDelta(evt.delta);
      } else if (evt.type === "error") {
        throw new Error(evt.error || "stream error");
      }
    }
    onDone && onDone(full);
  } catch (e) {
    console.warn(`  inference error: ${e.message}`);
    onError && onError(e);
  }
  return full;
}

module.exports = { runInference, loadApiKey, buildContext, PROVIDER, DEFAULT_MODEL };
