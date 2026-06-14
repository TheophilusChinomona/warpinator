// warpinator bridge — Phase 0 hello-world.
// Speaks Warp's warp_multi_agent_api wire contract on /ai/multi-agent:
// decodes the incoming Request, streams back a canned init/client_actions/finished
// ResponseEvent sequence as base64-protobuf over SSE. Later phases swap the canned
// response for Pi-driven inference.
const http = require("http");
const { loadSchema, helloStream } = require("./proto_loader");

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

function handleMultiAgent(req, res, body) {
  let ctx = {};
  try {
    const decoded = Request.decode(body);
    const obj = Request.toObject(decoded, { defaults: false });
    const convId = obj.metadata && obj.metadata.conversation_id;
    const tasks = (obj.task_context && obj.task_context.tasks) || [];
    const lastTask = tasks[tasks.length - 1];
    ctx = {
      conversation_id: convId || undefined,
      task_id: lastTask && lastTask.id ? lastTask.id : undefined,
    };
    console.log(
      `  decoded Request: conversation_id=${ctx.conversation_id || "(none)"} tasks=${tasks.length} -> reusing task_id=${ctx.task_id || "(new)"}`
    );
  } catch (e) {
    console.warn(`  could not decode Request (${e.message}); using defaults`);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const evt of helloStream(ctx)) sseWrite(res, evt);
  res.end();
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
  console.log(`warpinator bridge (Phase 0 hello-world) on http://127.0.0.1:${PORT}`);
  console.log(`Point Warp at it:  WARP_SERVER_ROOT_URL=http://127.0.0.1:${PORT} ./target/debug/warp-oss`);
});
