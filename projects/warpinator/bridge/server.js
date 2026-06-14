// warpinator bridge — Phase 0 hello-world.
// Speaks Warp's warp_multi_agent_api wire contract on /ai/multi-agent:
// decodes the incoming Request, streams back a canned init/client_actions/finished
// ResponseEvent sequence as base64-protobuf over SSE. Later phases swap the canned
// response for Pi-driven inference.
const http = require("http");
const { loadSchema } = require("./proto_loader");
const { runInference, PROVIDER, DEFAULT_MODEL } = require("./inference");

const PORT = process.env.WARPINATOR_BRIDGE_PORT || 8787;
const { ResponseEvent, Request } = loadSchema();

function sseWrite(res, evtObj) {
  const bytes = ResponseEvent.encode(ResponseEvent.fromObject(evtObj)).finish();
  res.write(`data: ${Buffer.from(bytes).toString("base64")}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

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

  const now = Date.now();
  const conversation_id = conversationId || `warpinator-conv-${now}`;
  sseWrite(res, { init: { conversation_id, request_id: `req-${now}`, run_id: `run-${now}` } });

  // Run real inference via Pi; accumulate the reply, then emit it as one
  // agent_output message (the render path proven in Phase 0/1).
  let text = "";
  await runInference(reqObj, {
    onDelta: (d) => {
      text += d;
    },
    onError: (e) => {
      text = text || `⚠️ warpinator bridge (${PROVIDER}/${DEFAULT_MODEL}) error: ${e.message}`;
    },
  });
  if (!text) text = "(no response)";

  const task_id = existingTaskId || `warpinator-task-${now}`;
  const actions = [];
  if (!existingTaskId) {
    actions.push({ create_task: { task: { id: task_id, description: "warpinator" } } });
  }
  actions.push({
    add_messages_to_task: {
      task_id,
      messages: [{ id: `msg-${now}`, task_id, agent_output: { text } }],
    },
  });
  sseWrite(res, { client_actions: { actions } });
  sseWrite(res, { finished: { done: {} } });
  res.end();
  console.log(`  replied ${text.length} chars`);
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "").split("?")[0];
  console.log(`${req.method} ${url}`);

  if (req.method === "POST" && (url === "/ai/multi-agent" || url === "/agent-mode-evals/multi-agent")) {
    const body = await readBody(req);
    return handleMultiAgent(req, res, body);
  }

  // Benign fallback for every other root path the redirected client may hit
  // (auth, graphql, feature flags, telemetry). Phase 1 will flesh these out.
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ warpinator_bridge: true, unhandled: url }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`warpinator bridge (Phase 2: Pi inference via ${PROVIDER}/${DEFAULT_MODEL}) on http://127.0.0.1:${PORT}`);
  console.log(`Point Warp at it:  WARP_SERVER_ROOT_URL=http://127.0.0.1:${PORT} ./target/debug/warp-oss`);
});
