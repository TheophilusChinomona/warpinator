// Shared protobuf loader for the warpinator bridge.
// Loads the warp_multi_agent_api schema from ./proto and exposes the message types.
const path = require("path");
const protobuf = require("protobufjs");

const PROTO_DIR = path.join(__dirname, "proto");

function loadSchema() {
  const root = new protobuf.Root();
  // Resolve flat local imports (e.g. import "task.proto") against ./proto.
  // protobufjs resolves google/protobuf/* well-known types from its bundled set.
  root.resolvePath = (origin, target) => {
    // google/* (incl. descriptor.proto for custom options) resolve from our
    // vendored copy under proto/google; flat warp protos resolve by basename.
    if (target.startsWith("google/")) return path.join(PROTO_DIR, target);
    return path.join(PROTO_DIR, path.basename(target));
  };
  root.loadSync(path.join(PROTO_DIR, "response.proto"), { keepCase: true });
  root.loadSync(path.join(PROTO_DIR, "request.proto"), { keepCase: true });
  root.resolveAll();
  return {
    root,
    ResponseEvent: root.lookupType("warp.multi_agent.v1.ResponseEvent"),
    Request: root.lookupType("warp.multi_agent.v1.Request"),
  };
}

// Build a canned three-event hello-world stream as an array of ResponseEvent
// plain objects (keepCase / snake_case field names). `ctx` may carry the
// conversation_id and target task_id pulled from the incoming Request.
function helloStream(ctx = {}) {
  const conversation_id = ctx.conversation_id || "warpinator-hello-conv";
  const now = Date.now();
  const text =
    "👋 Hello from the warpinator bridge — generated locally, " +
    "no Oz, no account. (Phase 0 wire-contract proof.)";

  const events = [];

  // 1. init
  events.push({
    init: { conversation_id, request_id: `req-${now}`, run_id: `run-${now}` },
  });

  // 2. client_actions: ensure a task exists, then add an agent_output message
  const task_id = ctx.task_id || `warpinator-hello-task-${now}`;
  const actions = [];
  if (!ctx.task_id) {
    actions.push({ create_task: { task: { id: task_id, description: "warpinator bridge" } } });
  }
  actions.push({
    add_messages_to_task: {
      task_id,
      messages: [{ id: `msg-${now}`, task_id, agent_output: { text } }],
    },
  });
  events.push({ client_actions: { actions } });

  // 3. finished
  events.push({ finished: { done: {} } });

  return events;
}

module.exports = { loadSchema, helloStream, PROTO_DIR };
