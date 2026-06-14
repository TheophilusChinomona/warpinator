// End-to-end test: build a real Request, POST it to the running bridge, decode
// the SSE ResponseEvent stream, and assert the bridge reuses the request's
// conversation_id + task_id.
const http = require("http");
const { loadSchema } = require("./proto_loader");

const { ResponseEvent, Request } = loadSchema();
const PORT = process.env.WARPINATOR_BRIDGE_PORT || 8787;

const reqObj = {
  metadata: { conversation_id: "test-conv-123" },
  task_context: { tasks: [{ id: "existing-task-abc", description: "user's task" }] },
  input: { user_inputs: { inputs: [{ user_query: { query: "hello?" } }] } },
};
const verr = Request.verify(reqObj);
if (verr) {
  // user_query shape may differ; fall back to a minimal request that still carries metadata+tasks
  console.warn(`Request.verify warning: ${verr} — sending without input`);
  delete reqObj.input;
}
const body = Request.encode(Request.fromObject(reqObj)).finish();

const req = http.request(
  { host: "127.0.0.1", port: PORT, path: "/ai/multi-agent", method: "POST",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": body.length } },
  (res) => {
    let buf = "";
    const got = [];
    res.on("data", (c) => {
      buf += c.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (frame.startsWith("data:")) {
          const b64 = frame.slice(5).trim().replace(/^"|"$/g, "");
          const evt = ResponseEvent.toObject(ResponseEvent.decode(Buffer.from(b64, "base64")), { oneofs: true });
          got.push(evt);
          const v = evt.type;
          let detail = "";
          if (v === "init") detail = `conversation_id=${evt.init.conversation_id}`;
          if (v === "client_actions") {
            const a = evt.client_actions.actions.map((x) => Object.keys(x)[0]).join("+");
            const add = evt.client_actions.actions.find((x) => x.add_messages_to_task);
            detail = `actions=[${a}] task_id=${add ? add.add_messages_to_task.task_id : "?"}`;
          }
          if (v === "finished") detail = `reason=${evt.finished.reason}`;
          console.log(`  <- ${v}  ${detail}`);
        }
      }
    });
    res.on("end", () => {
      const variants = got.map((e) => e.type);
      const addAction = got.find((e) => e.type === "client_actions")?.client_actions.actions.find((x) => x.add_messages_to_task);
      const reusedTask = addAction && addAction.add_messages_to_task.task_id === "existing-task-abc";
      const order = JSON.stringify(variants) === JSON.stringify(["init", "client_actions", "finished"]);
      const initConv = got[0]?.init?.conversation_id === "test-conv-123";
      console.log(`\norder init/client_actions/finished: ${order ? "✓" : "✗ " + variants}`);
      console.log(`echoed conversation_id: ${initConv ? "✓" : "✗"}`);
      console.log(`reused existing task_id: ${reusedTask ? "✓" : "✗"}`);
      process.exit(order && initConv && reusedTask ? 0 : 1);
    });
  }
);
req.on("error", (e) => { console.error("request error:", e.message); process.exit(1); });
req.write(body);
req.end();
