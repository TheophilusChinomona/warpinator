# warpinator — Phase 2: Real Inference via Pi ✅

**Date:** 2026-06-14
**Outcome:** Warp Agent Mode produced a genuine model answer through the local bridge — **no Oz, no Warp account, no Warp credits**. The bridge calls a real provider with the user's own key.

**Proof:** prompt `write a haiku about terminals` → live **Owl Alpha** reply rendered in Warp:
> Pixel cursor blinks, / Commands flow through the shell— / Silent power waits.
Bridge log: `POST /ai/multi-agent` → `inference: openrouter/openrouter/owl-alpha, 1 msg(s)` → `replied 73 chars`.

---

## How it works

- **Library:** `@mariozechner/pi-ai` (Pi's unified provider client; ESM, loaded via dynamic `import()` from the CommonJS bridge). Note: upstream renamed it to `@earendil-works/pi-ai` — migrate later.
- **Key:** read from Pi's own store `~/.pi/agent/auth.json` → `.openrouter.key` (falls back to `OPENROUTER_API_KEY`). No key entry needed in Warp for now.
- **Provider/model:** `openrouter` / `openrouter/owl-alpha` (override with env `BRIDGE_PROVIDER` / `BRIDGE_MODEL`). pi-ai's `getModel(provider, id)` requires the id to exist in its bundled `models.generated` list — owl-alpha is present.
- **Flow** (`projects/warpinator/bridge/`):
  - `inference.js` — decodes the Warp `Request` into a Pi `Context` (`task_context.tasks[].messages` → history; `input.user_inputs[].user_query` → latest turn), runs `stream(model, context, {apiKey})`, surfaces `text_delta` events.
  - `server.js` — on `POST /ai/multi-agent`: emit `init`, run inference (accumulate deltas), emit the reply as one `add_messages_to_task` `agent_output` message, emit `finished{done}`.
- **Test:** `node inference-test.js` proves pi-ai→OpenRouter standalone (no Warp).

## Current limitations (Phase 3 candidates)

1. **Not token-streamed yet** — the reply is buffered and emitted as one block (reuses the proven render path). Streaming = emit `append_to_message_content` per `text_delta`.
2. **No tool round-trips** — the model can't run shell commands / edit files yet. Needs `tool_call` emission + consuming `tool_call_result` from the re-sent Request, mapping Warp tools ↔ Pi tools. (This is the original "Phase 2" in PLANNING.md.)
3. **Key + model come from Pi/env, not Warp's UI** — wire `settings.api_keys` / `custom_model_providers` from the decoded Request, and honor `settings.model_config.base` (the Warp model picker currently shows "auto" and is ignored).
4. **Non-AI root calls** (`/graphql/v2`, model discovery) still 404 — fine, but populating them would light up the model picker.
5. **Run scaffolding** — still env-var + `WARP_DATA_PROFILE` launch; packaging (spawn bridge as managed child, default backend) is later.

## Reproduce

```bash
cd projects/warpinator/bridge && npm install && node server.js   # owl-alpha by default
# Warp (separate shell):
WARP_SERVER_ROOT_URL=http://127.0.0.1:8787 WARP_DATA_PROFILE=warpinator-spike2 ./target/debug/warp-oss
# In Agent Mode, ask anything. To change model: BRIDGE_MODEL=anthropic/claude-3.5-haiku node server.js
```

*Last updated: 2026-06-14*
