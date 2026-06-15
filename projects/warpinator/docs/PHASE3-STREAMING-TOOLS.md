# warpinator — Phase 3: Streaming + Tools + Key Wiring ✅

**Date:** 2026-06-14
**Outcome:** The bridge now (a) streams tokens live, (b) lets the model run shell commands via Warp's tool round-trip, and (c) sources the API key from the Warp request (falling back to Pi auth / env). Validated at the bridge level by `agent-test.js`.

## What landed

### 3a — Token streaming
`server.js` emits the agent reply incrementally: an empty `agent_output` message is created on the first delta, then each `text_delta` is sent as `append_to_message_content` with mask `agent_output.text`. (Previously the whole reply was one buffered block.)

### 3b — Tool round-trip (run_shell_command)
- `inference.js` advertises a `run_shell_command` tool to the model (TypeBox schema `{command}`).
- When pi-ai emits `toolcall_end`, the bridge maps it to a Warp `Message.tool_call` (`run_shell_command{command, wait_until_complete}`) and sends it. Warp executes the command client-side and re-POSTs the result.
- On the follow-up request, `buildContext` reconstructs the full conversation from `task_context.tasks` (incl. prior `tool_call`) + the new `input.tool_call_result`, mapping Warp tool calls/results ↔ Pi `toolCall` / `toolResult` messages, and the model continues.
- **owl-alpha supports tool-calling** — confirmed by the round-trip test.

### 3c — API key from the request
`loadApiKey` now reads `request.settings.api_keys.open_router` first (the key a user enters in Warp's AI settings), then `~/.pi/agent/auth.json`, then env. So keys can come from Warp's existing UI without code changes.

## Validation (`node agent-test.js`, bridge-level)
```
[1] streaming      init=true appends=4 finished=true  -> PASS ✓
[2] tool round-trip run_shell_command("echo warpinator-rocks") -> result -> final answer  -> PASS ✓
```
Plus `node inference-test.js` for standalone provider sanity.

## Still open (future)
- **Other tools** — only `run_shell_command` is mapped. `read_files`, `apply_file_diffs`, `grep`, `file_glob`, MCP, etc. follow the same map-call / map-result pattern in `inference.js`/`server.js`.
- **Model picker** — Warp's picker shows "auto" because the bridge 404s model-discovery `/graphql/v2`. Honoring `settings.model_config.base` needs that endpoint populated.
- **GUI confirmation** — bridge logic is proven by simulation; live in-app confirmation (watch tokens stream, approve+run a real command) is the user's final check.
- **Packaging** — still launched via env vars + `WARP_DATA_PROFILE`; spawning the bridge as a managed child + defaulting the backend is later.

*Last updated: 2026-06-14*
