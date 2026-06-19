// warpinator bridge — Phase 0 hello-world.
// Speaks Warp's warp_multi_agent_api wire contract on /ai/multi-agent:
// decodes the incoming Request, streams back a canned init/client_actions/finished
// ResponseEvent sequence as base64-protobuf over SSE. Later phases swap the canned
// response for Pi-driven inference.
const http = require("http");
const { loadSchema } = require("./proto_loader");
const { runInference, classifyError, loadApiKey, PROVIDER, DEFAULT_MODEL } = require("./inference");
const { handleGraphql, refreshCatalog } = require("./graphql");

const PORT = process.env.WARPINATOR_BRIDGE_PORT || 8787;
const { ResponseEvent, Request } = loadSchema();

function sseWrite(res, evtObj) {
  const bytes = ResponseEvent.encode(ResponseEvent.fromObject(evtObj)).finish();
  // Warp decodes SSE frames with URL-safe base64 (base64::BASE64_URL_SAFE), where the
  // standard-alphabet chars '+' and '/' are INVALID. Emit padded URL-safe base64 to match,
  // otherwise frames whose bytes contain '+'/'/' fail with "Invalid symbol ..., offset ...".
  const b64url = Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  res.write(`data: ${b64url}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

let msgSeq = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${msgSeq++}`;

async function handleMultiAgent(req, res, body) {
  let reqObj = {};
  let conversationId;
  let existingTaskId;
  try {
    reqObj = Request.toObject(Request.decode(body), { defaults: false });
    conversationId = reqObj.metadata && reqObj.metadata.conversation_id;
    const tasks = (reqObj.task_context && reqObj.task_context.tasks) || [];
    const lastTask = tasks[tasks.length - 1];
    existingTaskId = lastTask && lastTask.id ? lastTask.id : undefined;
    console.log(
      `  Request: conversation_id=${conversationId || "(none)"} tasks=${tasks.length} -> task_id=${existingTaskId || "(new)"}`
    );
  } catch (e) {
    console.warn(`  could not decode Request (${e.message})`);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const conversation_id = conversationId || nextId("warpinator-conv");
  sseWrite(res, { init: { conversation_id, request_id: nextId("req"), run_id: nextId("run") } });

  const task_id = existingTaskId || nextId("warpinator-task");
  if (!existingTaskId) {
    sseWrite(res, { client_actions: { actions: [{ create_task: { task: { id: task_id, description: "warpinator" } } }] } });
  }

  // Phase 3a: stream text token-by-token. Create the agent_output message lazily
  // on the first delta, then append subsequent deltas via append_to_message_content.
  let textMsgId = null;
  let textLen = 0;
  const appendText = (delta) => {
    if (!textMsgId) {
      textMsgId = nextId("msg");
      sseWrite(res, {
        client_actions: {
          actions: [{ add_messages_to_task: { task_id, messages: [{ id: textMsgId, task_id, agent_output: { text: "" } }] } }],
        },
      });
    }
    textLen += delta.length;
    sseWrite(res, {
      client_actions: {
        actions: [
          {
            append_to_message_content: {
              task_id,
              message: { id: textMsgId, task_id, agent_output: { text: delta } },
              mask: { paths: ["agent_output.text"] },
            },
          },
        ],
      },
    });
  };

  // Phase 3b: emit tool calls as Message.tool_call. Warp executes them client-side
  // and re-POSTs the result, which the next request feeds back into the model.
  let toolCount = 0;
  const emitToolCall = (tc) => {
    const warpTool = mapToolCall(tc);
    if (!warpTool) {
      console.warn(`  unsupported tool '${tc.name}', ignoring`);
      return;
    }
    toolCount++;
    const message = { id: nextId("tc"), task_id, tool_call: { tool_call_id: tc.id || nextId("toolcall"), ...warpTool } };
    sseWrite(res, { client_actions: { actions: [{ add_messages_to_task: { task_id, messages: [message] } }] } });
    console.log(`  -> tool_call ${tc.name}(${JSON.stringify(tc.arguments)})`);
  };

  let errored = null;
  await runInference(reqObj, {
    onDelta: appendText,
    onToolCall: emitToolCall,
    onError: (e) => {
      errored = e;
    },
  });

  // Surface a hard error as visible text if nothing else was produced.
  if (errored && !textMsgId && !toolCount) {
    sseWrite(res, {
      client_actions: {
        actions: [
          {
            add_messages_to_task: {
              task_id,
              messages: [{ id: nextId("msg"), task_id, agent_output: { text: `⚠️ ${classifyError(errored)}` } }],
            },
          },
        ],
      },
    });
  }

  sseWrite(res, { finished: { done: {} } });
  res.end();
  console.log(`  done: ${textLen} chars, ${toolCount} tool call(s)`);
}

// Map a Pi toolCall to a Warp Message.tool_call oneof payload. Warp executes
// these client-side (terminal, file edits with diffs, etc.) and returns results.
function mapToolCall(tc) {
  const a = tc.arguments || {};
  switch (tc.name) {
    case "run_shell_command":
      return {
        run_shell_command: {
          command: a.command || "",
          // Ask the harness to wait for completion so we get a full result back.
          wait_until_complete_value: { wait_until_complete: true },
        },
      };
    case "read_files":
      return { read_files: { files: (a.paths || []).map((p) => ({ name: p })) } };
    case "apply_file_diffs":
      return {
        apply_file_diffs: {
          summary: a.summary || "",
          diffs: (a.diffs || []).map((d) => ({ file_path: d.file_path, search: d.search, replace: d.replace })),
          new_files: (a.new_files || []).map((f) => ({ file_path: f.file_path, content: f.content })),
          deleted_files: (a.deleted_files || []).map((p) => ({ file_path: p })),
        },
      };
    case "grep":
      return { grep: { queries: a.queries || [], path: a.path || "" } };
    case "file_glob":
      return { file_glob_v2: { patterns: a.patterns || [], search_dir: a.search_dir || "" } };
    default:
      return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "").split("?")[0];
  console.log(`${req.method} ${url}`);

  if (req.method === "GET" && url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", bridge: "warpinator" }));
    return;
  }

  if (req.method === "POST" && (url === "/ai/multi-agent" || url === "/agent-mode-evals/multi-agent")) {
    const body = await readBody(req);
    return handleMultiAgent(req, res, body);
  }

  // GraphQL: answer model-discovery (freeAvailableModels) so Warp's model picker
  // populates with our OpenRouter models; everything else 404s benignly.
  if (req.method === "POST" && url === "/graphql/v2") {
    const body = await readBody(req);
    const gql = handleGraphql(body.toString("utf8"));
    if (gql) {
      console.log("  graphql: served freeAvailableModels");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(gql));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ warpinator_bridge: true, graphql: "unhandled" }));
    return;
  }

  // Benign fallback for every other root path the redirected client may hit
  // (auth, graphql, feature flags, telemetry). Phase 1 will flesh these out.
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ warpinator_bridge: true, unhandled: url }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`warpinator bridge (Pi streaming + tools; default ${DEFAULT_MODEL} via ${PROVIDER}) on http://127.0.0.1:${PORT}`);
  console.log(`Point Warp at it:  WARP_SERVER_ROOT_URL=http://127.0.0.1:${PORT} ./target/debug/warp-oss`);
  refreshCatalog(loadApiKey({})).then((n) =>
    console.log(n ? `catalog: loaded ${n} OpenRouter models` : "catalog: using pinned models (fetch failed)")
  );
});
