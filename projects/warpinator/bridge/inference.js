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

// Tools exposed to the model, mapped to Warp tool calls (Warp executes them
// client-side in the user's terminal and returns results on the next request).
function buildTools(reqObj) {
  const { Type } = getTypeBox();
  return [
    {
      name: "run_shell_command",
      description:
        "Run a shell command in the user's terminal and return its output. " +
        "Use whenever the task requires executing a command, inspecting the system, or running code.",
      parameters: Type.Object({
        command: Type.String({ description: "The exact shell command to run." }),
      }),
    },
    {
      name: "read_files",
      description:
        "Read the contents of one or more files (paths relative to the working directory). " +
        "Always read a file before editing it so your search text matches exactly.",
      parameters: Type.Object({
        paths: Type.Array(Type.String(), { description: "File paths to read." }),
      }),
    },
    {
      name: "apply_file_diffs",
      description:
        "Edit existing files via exact search/replace, create new files, and/or delete files. " +
        "For edits, `search` MUST match the current file content exactly (read the file first).",
      parameters: Type.Object({
        summary: Type.Optional(Type.String({ description: "Short summary of the changes." })),
        diffs: Type.Optional(
          Type.Array(
            Type.Object({
              file_path: Type.String(),
              search: Type.String({ description: "Exact existing text to replace." }),
              replace: Type.String({ description: "Replacement text." }),
            }),
            { description: "Search/replace edits to existing files." }
          )
        ),
        new_files: Type.Optional(
          Type.Array(Type.Object({ file_path: Type.String(), content: Type.String() }), {
            description: "New files to create.",
          })
        ),
        deleted_files: Type.Optional(
          Type.Array(Type.String(), { description: "Paths of files to delete." })
        ),
      }),
    },
    {
      name: "grep",
      description: "Search file contents for terms or regex patterns. Returns matching files and line numbers.",
      parameters: Type.Object({
        queries: Type.Array(Type.String(), { description: "Search terms or regex patterns." }),
        path: Type.Optional(Type.String({ description: "Relative file/dir to search in (default: whole project)." })),
      }),
    },
    {
      name: "file_glob",
      description: "Find files by name pattern (supports ?, *, []). Returns matching file paths.",
      parameters: Type.Object({
        patterns: Type.Array(Type.String(), { description: "Glob patterns to match file names against." }),
        search_dir: Type.Optional(Type.String({ description: "Relative directory to search in." })),
      }),
    },
  ];
}

// --- Warp <-> Pi message mapping ---------------------------------------------

function piToolCallFromWarp(tc) {
  const id = tc.tool_call_id || "tc";
  const mk = (name, args) => ({ type: "toolCall", id, name, arguments: args });
  if (tc.run_shell_command) return mk("run_shell_command", { command: tc.run_shell_command.command || "" });
  if (tc.read_files) return mk("read_files", { paths: (tc.read_files.files || []).map((f) => f.name) });
  if (tc.grep) return mk("grep", { queries: tc.grep.queries || [], path: tc.grep.path });
  if (tc.file_glob_v2) return mk("file_glob", { patterns: tc.file_glob_v2.patterns || [], search_dir: tc.file_glob_v2.search_dir });
  if (tc.apply_file_diffs) {
    const a = tc.apply_file_diffs;
    return mk("apply_file_diffs", {
      summary: a.summary,
      diffs: a.diffs,
      new_files: a.new_files,
      deleted_files: (a.deleted_files || []).map((d) => d.file_path),
    });
  }
  return null;
}

function piToolResultFromWarp(tcr) {
  const id = tcr.tool_call_id || "tc";
  let toolName = "tool";
  let text = "(no result)";
  let isError = false;

  if (tcr.run_shell_command) {
    toolName = "run_shell_command";
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
  } else if (tcr.read_files) {
    toolName = "read_files";
    const r = tcr.read_files;
    if (r.error) {
      text = `Error: ${r.error.message}`;
      isError = true;
    } else {
      const files =
        (r.text_files_success && r.text_files_success.files) ||
        ((r.any_files_success && r.any_files_success.files) || []).map((a) => a.text_content).filter(Boolean);
      text =
        (files || []).map((f) => `=== ${f.file_path} ===\n${f.content || ""}`).join("\n\n") || "(no file content)";
    }
  } else if (tcr.apply_file_diffs) {
    toolName = "apply_file_diffs";
    const r = tcr.apply_file_diffs;
    if (r.error) {
      text = `Error applying diffs: ${r.error.message}`;
      isError = true;
    } else {
      const upd = ((r.success && r.success.updated_files_v2) || []).map((u) => u.file && u.file.file_path).filter(Boolean);
      const del = ((r.success && r.success.deleted_files) || []).map((d) => d.file_path);
      text = `Applied. Updated: ${upd.join(", ") || "none"}. Deleted: ${del.join(", ") || "none"}.`;
    }
  } else if (tcr.grep) {
    toolName = "grep";
    const r = tcr.grep;
    if (r.error) {
      text = `Error: ${r.error.message}`;
      isError = true;
    } else {
      const mf = (r.success && r.success.matched_files) || [];
      text = mf.length
        ? mf.map((f) => `${f.file_path}: lines ${(f.matched_lines || []).map((l) => l.line_number).join(", ")}`).join("\n")
        : "No matches.";
    }
  } else if (tcr.file_glob_v2) {
    toolName = "file_glob";
    const r = tcr.file_glob_v2;
    if (r.error) {
      text = `Error: ${r.error.message}`;
      isError = true;
    } else {
      const mf = ((r.success && r.success.matched_files) || []).map((f) => f.file_path);
      text = mf.length ? mf.join("\n") : "No files matched.";
      if (r.success && r.success.warnings) text += `\n(warnings: ${r.success.warnings})`;
    }
  } else if (tcr.cancel !== undefined) {
    text = "(tool call cancelled)";
    isError = true;
  }

  return { role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], isError, timestamp: 0 };
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

// Resolve which model to use: the model the user picked in Warp
// (request.settings.model_config.base) if it's a real id we can use, else the default.
function resolveModelId(reqObj) {
  const base = reqObj && reqObj.settings && reqObj.settings.model_config && reqObj.settings.model_config.base;
  if (typeof base === "string" && base && base !== "auto") return base;
  return DEFAULT_MODEL;
}

// Single inference attempt (no retries). Returns true on success.
async function _runInferenceOnce(reqObj, apiKey, { onDelta, onToolCall, onDone } = {}) {
  const context = buildContext(reqObj);
  const { getModel, stream } = await getPi();
  const requestedId = resolveModelId(reqObj);
  let model;
  try {
    model = getModel(PROVIDER, requestedId);
  } catch (_) {
    console.warn(`  model '${requestedId}' unknown to pi-ai; falling back to ${DEFAULT_MODEL}`);
    model = getModel(PROVIDER, DEFAULT_MODEL);
  }
  console.log(`  inference: ${requestedId} (${PROVIDER}), ${context.messages.length} msg(s), ${context.tools.length} tool(s)`);
  const events = stream(model, context, { apiKey });
  for await (const evt of events) {
    if (evt.type === "text_delta" && evt.delta) {
      onDelta && onDelta(evt.delta);
    } else if (evt.type === "toolcall_end" && evt.toolCall) {
      onToolCall && onToolCall(evt.toolCall);
    } else if (evt.type === "error") {
      let errText;
      if (typeof evt.error === "string") {
        errText = evt.error;
      } else if (evt.error && typeof evt.error.errorMessage === "string") {
        errText = evt.error.errorMessage;
      } else if (evt.error && typeof evt.error.message === "string") {
        errText = evt.error.message;
      } else {
        errText = JSON.stringify(evt.error);
      }
      throw new Error(errText || "stream error");
    } else if (evt.type === "assistant" && evt.stopReason === "error") {
      const errText = evt.errorMessage || JSON.stringify(evt);
      throw new Error(errText || "model stopped with error");
    }
  }
  onDone && onDone();
  return true;
}

// Whether an error is retryable (transient provider hiccup) vs fatal (bad key, bad model).
function isRetryableError(err) {
  const msg = (err && err.message) || String(err);
  const low = msg.toLowerCase();
  // Don't retry auth failures or missing keys.
  if (low.includes("401") || low.includes("unauthorized") || low.includes("invalid api key")) return false;
  if (low.includes("key") && (low.includes("no ") || low.includes("missing"))) return false;
  // Don't retry "model not found" — that's a config issue.
  if (low.includes("model") && low.includes("not found")) return false;
  // Everything else (429, 500, "provider returned error", timeouts, etc.) is retryable.
  return true;
}

// Stream a completion with automatic retry on transient provider errors.
// Callbacks: onDelta(text), onToolCall(piToolCall), onError(Error), onDone().
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

  const MAX_RETRIES = 2;
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = attempt * 1000;
      console.log(`  retry ${attempt}/${MAX_RETRIES} after ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
    try {
      await _runInferenceOnce(reqObj, apiKey, { onDelta, onToolCall, onDone });
      return; // success
    } catch (e) {
      lastError = e;
      const errMsg = e && typeof e.message === "string" ? e.message : JSON.stringify(e);
      console.warn(`  inference error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${errMsg}`);
      if (!isRetryableError(e)) {
        console.warn(`  error is not retryable, aborting.`);
        break;
      }
    }
  }
  onError && onError(lastError);
}

// Turn a raw provider/SDK error into an actionable, user-facing message.
function classifyError(err) {
  let msg;
  if (err && typeof err.message === "string") {
    msg = err.message;
  } else if (typeof err === "string") {
    msg = err;
  } else {
    try { msg = JSON.stringify(err); } catch (_) { msg = String(err); }
  }
  // If the message is a JSON blob with errorMessage, extract it.
  if (msg.startsWith("{") && msg.includes("errorMessage")) {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.errorMessage) msg = parsed.errorMessage;
    } catch (_) {}
  }
  const low = msg.toLowerCase();
  if (low.includes("key") && (low.includes("no ") || low.includes("missing")))
    return 'No API key configured. Add your OpenRouter key to ~/.pi/agent/auth.json ({"openrouter":{"key":"sk-or-..."}}) or set OPENROUTER_API_KEY, then retry.';
  if (low.includes("401") || low.includes("unauthorized") || low.includes("invalid api key"))
    return "The provider rejected the API key (401). Check your OpenRouter key.";
  if (low.includes("429") || low.includes("rate limit") || low.includes("quota") || low.includes("too many requests"))
    return "Rate limited by the provider (429). Wait a moment or switch models (free-tier models throttle aggressively).";
  if ((low.includes("model")) && (low.includes("not found") || low.includes("unknown") || low.includes("404")))
    return "That model isn't available on OpenRouter right now. Pick a different model in the picker.";
  return `warpinator bridge error: ${msg}`;
}

module.exports = { runInference, loadApiKey, buildContext, classifyError, PROVIDER, DEFAULT_MODEL };
