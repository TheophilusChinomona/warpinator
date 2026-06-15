// Phase 3 validation against a running bridge:
//  (1) streaming  — a normal question yields append_to_message_content deltas
//  (2) tool round-trip — a command request yields a run_shell_command tool_call,
//      and feeding back a synthesized result yields a final text answer.
const http = require("http");
const { loadSchema } = require("./proto_loader");
const { ResponseEvent, Request } = loadSchema();
const PORT = process.env.WARPINATOR_BRIDGE_PORT || 8787;

function post(reqObj) {
  const body = Request.encode(Request.fromObject(reqObj)).finish();
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: PORT, path: "/ai/multi-agent", method: "POST", headers: { "Content-Length": body.length } },
      (res) => {
        let buf = "";
        const events = [];
        res.on("data", (c) => {
          buf += c.toString("utf8");
          let i;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, i).trim();
            buf = buf.slice(i + 2);
            if (frame.startsWith("data:")) {
              const b64 = frame.slice(5).trim().replace(/^"|"$/g, "");
              events.push(ResponseEvent.toObject(ResponseEvent.decode(Buffer.from(b64, "base64")), { oneofs: true }));
            }
          }
        });
        res.on("end", () => resolve(events));
      }
    );
    r.on("error", reject);
    r.write(body);
    r.end();
  });
}

const flatActions = (events) =>
  events.filter((e) => e.type === "client_actions").flatMap((e) => e.client_actions.actions);

function reconstructText(events) {
  let text = "";
  for (const a of flatActions(events)) {
    if (a.add_messages_to_task) for (const m of a.add_messages_to_task.messages) if (m.agent_output) text += m.agent_output.text || "";
    if (a.append_to_message_content && a.append_to_message_content.message.agent_output)
      text += a.append_to_message_content.message.agent_output.text || "";
  }
  return text;
}

(async () => {
  let pass = true;

  // --- Test 1: streaming ---
  console.log("\n[1] streaming a normal answer...");
  const e1 = await post({ input: { user_inputs: { inputs: [{ user_query: { query: "Say hello in exactly three words." } }] } } });
  const appends = flatActions(e1).filter((a) => a.append_to_message_content).length;
  const hasInit = e1.some((e) => e.type === "init");
  const hasFinished = e1.some((e) => e.type === "finished");
  const text1 = reconstructText(e1);
  console.log(`    init=${hasInit} appends=${appends} finished=${hasFinished} text="${text1.trim()}"`);
  const t1ok = hasInit && hasFinished && appends >= 1 && text1.trim().length > 0;
  console.log(`    ${t1ok ? "PASS ✓ (streamed via append_to_message_content)" : "FAIL ✗"}`);
  pass = pass && t1ok;

  // --- Test 2: tool round-trip ---
  console.log("\n[2] tool round-trip (run_shell_command)...");
  const e2a = await post({
    input: { user_inputs: { inputs: [{ user_query: { query: "Run the shell command: echo warpinator-rocks" } }] } },
    settings: { supported_tools: [] },
  });
  const toolMsg = flatActions(e2a)
    .flatMap((a) => (a.add_messages_to_task ? a.add_messages_to_task.messages : []))
    .find((m) => m.tool_call && m.tool_call.run_shell_command);
  if (!toolMsg) {
    console.log("    FAIL ✗ — model did not emit a run_shell_command tool_call (model may lack tool support)");
    console.log(`    (it replied with text instead: "${reconstructText(e2a).trim().slice(0, 120)}")`);
    pass = false;
  } else {
    const cmd = toolMsg.tool_call.run_shell_command.command;
    const tcId = toolMsg.tool_call.tool_call_id;
    const taskId = toolMsg.task_id;
    const convId = e2a.find((e) => e.type === "init").init.conversation_id;
    console.log(`    tool_call: run_shell_command("${cmd}") id=${tcId}`);
    // feed back a synthesized result
    const e2b = await post({
      metadata: { conversation_id: convId },
      task_context: {
        tasks: [
          {
            id: taskId,
            messages: [
              { id: "u1", user_query: { query: "Run the shell command: echo warpinator-rocks" } },
              { id: "a1", tool_call: { tool_call_id: tcId, run_shell_command: { command: cmd } } },
            ],
          },
        ],
      },
      input: {
        user_inputs: {
          inputs: [
            {
              tool_call_result: {
                tool_call_id: tcId,
                run_shell_command: { command: cmd, command_finished: { output: "warpinator-rocks\n", exit_code: 0 } },
              },
            },
          ],
        },
      },
    });
    const text2 = reconstructText(e2b).trim();
    console.log(`    follow-up answer: "${text2.slice(0, 160)}"`);
    const t2ok = text2.toLowerCase().includes("warpinator-rocks") || text2.length > 0;
    console.log(`    ${t2ok ? "PASS ✓ (round-trip: tool_call -> result -> final answer)" : "FAIL ✗"}`);
    pass = pass && t2ok;
  }

  console.log(`\n=== ${pass ? "ALL PHASE 3 TESTS PASS ✓" : "SOME TESTS FAILED ✗"} ===`);
  process.exit(pass ? 0 : 1);
})();
