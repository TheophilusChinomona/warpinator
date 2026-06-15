# warpinator — Phase 0: The `warp_multi_agent_api` Wire Contract

> The contract a replacement AI backend (the warpinator bridge → Pi) must implement to be a drop-in for Oz. Reverse-engineered from the source. All paths relative to repo root.

**Status:** Contract mapped and validated. The single biggest unknown — the tool round-trip — is **resolved**.

---

## TL;DR — the shape of the integration

- **Transport:** `POST {WARP_SERVER_ROOT_URL}/ai/multi-agent`, request body = a single protobuf `Request`. Response = **SSE**, each `data:` line is **base64(protobuf `ResponseEvent`)**. (`app/src/server/server_api.rs:1310-1380`)
- **Package:** `warp.multi_agent.v1`, proto3. Source: `github.com/warpdotdev/warp-proto-apis`. Copied to `projects/warpinator/bridge/proto/`.
- **The agent loop is driven by client⇄backend round-trips, NOT a websocket.** The backend streams a `tool_call` → **the client executes it locally** → the client **re-POSTs** the same endpoint with the result in `input.user_inputs[].tool_call_result`, correlated by `metadata.conversation_id`. No RTC channel needed for AI.
- **The bridge can be (mostly) stateless.** The client re-sends the full conversation in `task_context.tasks` every request (`app/src/ai/agent/api/impl.rs:62`). The bridge reconstructs context from each request; it only must round-trip `conversation_id` (from `StreamInit`).
- **BYO keys already flow in the request:** `settings.api_keys` (anthropic/openai/google/open_router/aws/grok) + `settings.custom_model_providers` (base_url + api_key + models). The bridge ignores Oz auth and uses these / its own Pi config.

---

## 1. Response stream — what the bridge emits

`ResponseEvent` (`proto/response.proto:17-30`) has exactly **3** top-level variants:

| # | Variant | When | Bridge must send |
|---|---------|------|------------------|
| 1 | `init` (`StreamInit`) | first, exactly once | `conversation_id` (echo request's, or new), `request_id`, `run_id` |
| 2 | `client_actions` (`ClientActions{repeated ClientAction}`) | 0..N | all agent output + tool calls, as `ClientAction`s |
| 3 | `finished` (`StreamFinished`) | last, exactly once | a `reason` (e.g. `done`), optional usage/cost |

### `ClientAction` (`proto/response.proto`) — the actions the UI applies
`create_task=1`, `add_messages_to_task=3`, `update_task_message=4`, `append_to_message_content=5`, `show_suggestions=6`, `update_task_summary=7`, `update_task_description=8`, `begin_transaction=9`, `commit_transaction=10`, `rollback_transaction=11`, `start_new_conversation=12`, `update_task_server_data=13`, `move_messages_to_new_task=14`.

- **Minimum to render an answer:** `add_messages_to_task{ task_id, messages:[ Message{ agent_output } ] }` against the active task id from the request (or `create_task` first to make one).
- **Streaming text:** emit a `Message` then `append_to_message_content{ task_id, message{id}, mask:"agent_output.text" }` chunks.
- **Transactions:** `begin/commit/rollback` wrap provisional messages — optional for MVP.

### `Message` (`proto/task.proto:165`)
`id=1`, `task_id=11`, `request_id=13`, `timestamp=14`, `citations=8`, oneof `message`:
`user_query=2`, **`agent_output=3`**, `tool_call=4`, `tool_call_result=5`, `server_event=6`, `system_query=9`, `update_todos=10`, `agent_reasoning=15`, `summarization=16`, … (28 total).
- `AgentOutput` = `{ string text=1 }`. `AgentReasoning` = `{ string reasoning=1; Duration finished_duration=2 }`.

### Client consumer (the minimum it acts on)
`app/src/ai/blocklist/controller.rs:2684-2741` matches exactly `Init` / `ClientActions` / `Finished`; `ClientActions` are applied in `app/src/ai/agent/conversation.rs` via `apply_client_actions`. So **emitting those three, with `add_messages_to_task`+`agent_output`, is the floor.**

---

## 2. Tool round-trip — RESOLVED (the critical finding)

```
 backend ──stream──► ResponseEvent.client_actions{ add_messages_to_task: Message.tool_call(RunShellCommand{...}) }
 client  ──exec────► runs the command locally in the terminal / applies the diff (client-side execution)
 client  ──POST────► /ai/multi-agent  Request{ input.user_inputs[].tool_call_result(RunShellCommandResult{...}),
                                                metadata.conversation_id = <token from StreamInit>,
                                                task_context.tasks = <full history incl. the tool_call> }
 backend ──stream──► next ResponseEvent... (loop until finished with no pending tool calls)
```

- Client advertises executable tools in `settings.supported_tools` (`app/src/ai/agent/api/impl.rs:172`): RUN_SHELL_COMMAND, READ_FILES, APPLY_FILE_DIFFS, GREP, FILE_GLOB(_V2), SEARCH_CODEBASE, READ/EDIT/CREATE_DOCUMENTS, READ_SHELL_COMMAND_OUTPUT, WRITE_TO_LONG_RUNNING_SHELL_COMMAND, CALL_MCP_TOOL, READ_MCP_RESOURCE, SUBAGENT, SUGGEST_*, etc. (`ToolType` enum, `request.proto`). **The bridge must only emit `tool_call`s for advertised tools.**
- Follow-up assembly: `controller.rs:1508-1608` (`drain_finished_action_results` → `RequestInput::for_actions_results` → re-POST). Token reuse: `impl.rs:108-131` (`metadata.conversation_id`).
- `ToolCall` (`task.proto:366`) and `ToolCallResult` (`task.proto`/`request.proto:149`) each have a parallel oneof of ~36 tool variants. **Mapping these ↔ Pi's tools is the main Phase 2 work.**

---

## 3. Request — what the bridge decodes

`Request` (`proto/request.proto:22`): `task_context{ repeated Task tasks }=1`, `input=2`, `settings=3`, `metadata=4`, `existing_suggestions=5`, `mcp_context=6`.

- **`input.type` oneof:** `user_inputs` (batch of `UserQuery` / `ToolCallResult` / `cli_agent_user_query` / …), plus specialized entrypoints (resume, code_review, summarize, invoke_skill, …). Deprecated direct `user_query=2` / `tool_call_result=3`.
- **`settings`:** `model_config{base,coding,cli_agent,…}`, `api_keys`, `custom_model_providers`, `supported_tools[]`, and ~25 capability bools (parallel tool calls, todos UI, reasoning, v4a diffs, …). The bridge should honor capability flags it cares about.
- **`metadata`:** `conversation_id` (empty on first turn; the StreamInit token thereafter), `ambient_agent_task_id`, `forked_from_conversation_id`, `parent_agent_id`, `agent_name`.
- **`mcp_context`:** the client's MCP servers/tools/resources — relevant later for MCP passthrough.

---

## 4. The account gate (to remove in Phase 1)

AI is blocked when logged out at these `is_logged_in()` sites:
- `app/src/ai/harness_availability.rs:202` (fetch harness auth secrets), `:343` (refresh harnesses)
- `app/src/ai/llms.rs:1084` (authenticated model choices)
- `app/src/ai/request_usage_model.rs:228` (usage/quota refresh)
- `app/src/ai_assistant/requests.rs:133` (request-limit fetch)

Bearer token is attached only if present (`server_api.rs:1337`) — harmless against a local bridge that ignores it.

**Coupling note:** `WARP_SERVER_ROOT_URL` redirects the **root**, so *all* server calls (auth, GraphQL, telemetry, feature flags) hit the bridge too. To exercise AI end-to-end logged-out, Phase 1 must (a) neutralize these gates so the UI lets you send AI without an account, and (b) have the bridge return benign responses (or 404) for non-AI paths it doesn't implement.

---

## 5. Encoding details

- proto3, package `warp.multi_agent.v1`.
- SSE frame: `data: <base64(ResponseEvent bytes)>\n\n`. Client does `data.trim_matches('"')` then base64 then `ResponseEvent::decode` (`server_api.rs:1357-1380`) — surrounding quotes optional.
- Custom options present (`(sensitive)`, `(internal)`, …) defined in `options.proto`; google well-known types used (`Timestamp`, `Duration`, `Struct`, `Value`, `Empty`, `FieldMask`).
- TS types: generate from `projects/warpinator/bridge/proto/*.proto` (e.g. `ts-proto`/`protobufjs`); google WKTs are built into protobufjs / protoc's bundled includes.

---

## 6. Open items carried into Phase 1/2

1. Bridge returns benign responses for non-AI root paths (auth/graphql/flags) so startup + logged-out AI work.
2. Exact `supported_tools` set to honor first (start: RUN_SHELL_COMMAND, READ_FILES, APPLY_FILE_DIFFS, GREP, FILE_GLOB_V2).
3. Map `ToolCall`/`ToolCallResult` variants ↔ Pi tools (Phase 2).
4. Streaming UX: `append_to_message_content` chunking + transactions for clean partial rendering.
5. `StreamFinished` usage/cost fields — can be zeroed for BYOK.

*Last updated: 2026-06-13*
