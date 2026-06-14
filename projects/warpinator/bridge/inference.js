// warpinator bridge — inference via Pi (@mariozechner/pi-ai).
// Phase 2: real completions. Phase 3: streaming deltas, tool calls (run_shell_command)
// + tool-result round-trips, and API key sourced from the Warp request (falling back
// to Pi's ~/.pi/agent/auth.json, then env).
//
// pi-ai is ESM-only; this file is CommonJS, so we load it via dynamic import().
const fs = require("fs");
const os = require("os");
const path = require("path");

let piPromise;
function getPi() {
  return (piPromise ||= import("@mariozechner/pi-ai"));
}
let typebox;
function getTypeBox() {
  return (typebox ||= require("typebox"));
}

const PROVIDER = process.env.BRIDGE_PROVIDER || "openrouter";
const DEFAULT_MODEL = process.env.BRIDGE_MODEL || "openrouter/owl-alpha";

// provider -> the field name under Warp Request.settings.api_keys
const REQUEST_KEY_FIELD = {
  openrouter: "open_router",
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
};

// Resolve the provider key: (1) the Warp request's settings.api_keys (entered in
// Warp's AI settings UI), (2) Pi's auth.json, (3) env.
function loadApiKey(reqObj, provider = PROVIDER) {
  const field = REQUEST_KEY_FIELD[provider];
  const fromReq = reqObj && reqObj.settings && reqObj.settings.api_keys && field && reqObj.settings.api_keys[field];
  if (typeof fromReq === "string" && fromReq.length) return fromReq;
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"));
    const entry = auth && auth[provider];
    const key = entry && (typeof entry === "string" ? entry : entry.key);
    if (typeof key === "string" && key.length) return key;
  } catch (_) {}
  return process.env[`${provider.toUpperCase()}_API_KEY`] || process.env.OPENROUTER_API_KEY || null;
}

// Tools exposed to the model. For now: run_shell_command (the core agent capability).
// Only advertise it if the Warp client said it supports it.
function buildTools(reqObj) {
  const { Type } = getTypeBox();
  const supported = (reqObj && reqObj.settings && reqObj.settings.supported_tools) || [];
  // supported_tools is a list of ToolType enum values (numbers or names depending on decode);
  // RUN_SHELL_COMMAND == 0. Advertise unconditionally if the list is empty (older/looser clients).
  const tools = [];
  tools.push({
    name: "run_shell_command",
    description:
      "Run a shell command in the user's terminal and return its output. " +
      "Use this whenever the task requires executing a command, inspecting the system, or running code.",
    parameters: Type.Object({
      command: Type.String({ description: "The exact shell command to run." }),
    }),
  });
  return tools;
}

// --- Warp <-> Pi message mapping ---------------------------------------------

function piToolCallFromWarp(tc) {
  if (tc.run_shell_command) {
    return {
      type: "toolCall",
      id: tc.tool_call_id || "tc",
      name: "run_shell_command",
      arguments: { command: tc.run_shell_command.command || "" },
    };
  }
  return null;
}

function piToolResultFromWarp(tcr) {
  let text = "(no output)";
  let isError = false;
  if (tcr.run_shell_command) {
    const r = tcr.run_shell_command;
    if (r.command_finished) {
      const code = r.command_finished.exit_code || 0;
      const out = r.command_finished.output || "";
      text = code === 0 ? out || "(command produced no output)" : `Command exited with code ${code}.\n${out}`;
      isError = code !== 0;
    } else if (r.permission_denied) {
      text = "The user denied permission to run this command.";
      isError = true;
    } else if (r.long_running_command_snapshot) {
      text = "(command is now running in the background)";
    }
  } else if (tcr.cancel !== undefined) {
    text = "(tool call cancelled)";
    isError = true;
  }
  return {
    role: "toolResult",
    toolCallId: tcr.tool_call_id || "tc",
    toolName: "run_shell_command",
    content: [{ type: "text", text }],
    isError,
    timestamp: 0,
  };
}

// Build a Pi Context from the decoded Warp Request: task history (incl. prior
// tool calls/results) + the new input.
function buildContext(reqObj) {
  const messages = [];
  const handle = (m) => {
    if (m.user_query && m.user_query.query) {
      messages.push({ role: "user", content: m.user_query.query, timestamp: 0 });
    } else if (m.agent_output && m.agent_output.text) {
      messages.push({ role: "assistant", content: [{ type: "text", text: m.agent_output.text }], timestamp: 0 });
    } else if (m.tool_call) {
      const call = piToolCallFromWarp(m.tool_call);
      if (call) messages.push({ role: "assistant", content: [call], timestamp: 0 });
    } else if (m.tool_call_result) {
      messages.push(piToolResultFromWarp(m.tool_call_result));
    }
  };
  for (const t of (reqObj.task_context && reqObj.task_context.tasks) || []) {
    for (const m of t.messages || []) handle(m);
  }
  for (const i of (reqObj.input && reqObj.input.user_inputs && reqObj.input.user_inputs.inputs) || []) {
    if (i.user_query && i.user_query.query) {
      messages.push({ role: "user", content: i.user_query.query, timestamp: 0 });
    } else if (i.tool_call_result) {
      messages.push(piToolResultFromWarp(i.tool_call_result));
    }
  }
  return {
    systemPrompt:
      "You are the AI assistant inside warpinator, an open-source build of the Warp terminal. " +
      "Be concise. When a task requires running a command, call the run_shell_command tool rather than describing it.",
    messages,
    tools: buildTools(reqObj),
  };
}

// Stream a completion. Callbacks: onDelta(text), onToolCall(piToolCall), onError(Error), onDone().
async function runInference(reqObj, { onDelta, onToolCall, onError, onDone } = {}) {
  const apiKey = loadApiKey(reqObj);
  if (!apiKey) {
    onError && onError(new Error(`No ${PROVIDER} API key (request / ~/.pi/agent/auth.json / env)`));
    return;
  }
  const context = buildContext(reqObj);
  if (!context.messages.length) {
    onError && onError(new Error("Request contained no user message or tool result"));
    return;
  }
  try {
    const { getModel, stream } = await getPi();
    const model = getModel(PROVIDER, DEFAULT_MODEL);
    console.log(`  inference: ${PROVIDER}/${DEFAULT_MODEL}, ${context.messages.length} msg(s), ${context.tools.length} tool(s)`);
    const events = stream(model, context, { apiKey });
    for await (const evt of events) {
      if (evt.type === "text_delta" && evt.delta) {
        onDelta && onDelta(evt.delta);
      } else if (evt.type === "toolcall_end" && evt.toolCall) {
        onToolCall && onToolCall(evt.toolCall);
      } else if (evt.type === "error") {
        throw new Error(evt.error || "stream error");
      }
    }
    onDone && onDone();
  } catch (e) {
    console.warn(`  inference error: ${e.message}`);
    onError && onError(e);
  }
}

module.exports = { runInference, loadApiKey, buildContext, PROVIDER, DEFAULT_MODEL };
