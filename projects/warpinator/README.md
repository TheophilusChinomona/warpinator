# warpinator

**Warp's terminal, your AI.** A fork of the open-source [Warp](https://www.warp.dev) terminal that keeps 100% of Warp's UI/UX but replaces the closed, account-gated **Oz** AI backend with a local bridge powered by **[Pi](https://pi.dev)** → **OpenRouter** (and any provider Pi supports). Use Agent Mode with **your own API key, no Warp account, no Warp credits.**

> Built by forking Warp and changing 5 small Rust files + adding a ~300-line Node bridge. Everything you love about Warp (GPU terminal, command blocks, diffs, Agent Mode UI) is untouched — only the AI brain is swapped.

## Quickstart

```bash
# 1. Build Warp from source (one time; ~15-40 min first build)
cargo build --bin warp-oss --features gui     # needs protoc on PATH

# 2. Put your OpenRouter key where Pi looks for it (one time)
#    ~/.pi/agent/auth.json  ->  { "openrouter": { "key": "sk-or-..." } }
#    (or set OPENROUTER_API_KEY)

# 3. Run it (starts the bridge + launches Warp, account-free)
projects/warpinator/run.sh

# pick a model:
BRIDGE_MODEL=anthropic/claude-haiku-4.5 projects/warpinator/run.sh
```

Then in Warp: you land straight in the terminal (no login), Agent Mode is available, and the model picker lists OpenRouter models (Owl Alpha, OpenRouter Free, Claude, Gemini, …).

## What works

- **Account-free AI** — Agent Mode with no Warp login, no credits.
- **Your provider, your key** — OpenRouter by default (key from Pi's `~/.pi/agent/auth.json` or Warp's AI settings).
- **Streaming** replies, token-by-token.
- **Tools** — Owl can run shell commands *and* read/edit files: `run_shell_command`, `read_files`, `apply_file_diffs` (search/replace, new files, deletes), `grep`, `file_glob`. Tools execute **in your real terminal** (cwd, diff UI, your approval).
- **Model picker** — choose the model in-app; the selection is honored per request.

## Architecture

Warp's client is a UI + event-stream consumer; the agent loop is driven by client⇄backend round-trips, and **tools execute client-side in your terminal**. So the backend's job is one model step per request — exactly what `pi-ai` provides.

```
 Warp (unchanged UI)
   │  POST /ai/multi-agent   (protobuf over SSE, URL-safe base64)
   │  WARP_SERVER_ROOT_URL → 127.0.0.1:8787
   ▼
 warpinator bridge (Node, projects/warpinator/bridge/)
   • speaks Warp's warp_multi_agent_api wire contract
   • per step: pi-ai stream() → text deltas + tool calls
   • answers model-discovery GraphQL (populates the picker)
   ▼
 pi-ai → OpenRouter / OpenAI-compatible / Anthropic / Gemini / … (your key)
```

> We deliberately use **pi-ai** (per-step inference), not **pi-agent-core** (full loop): pi-agent-core executes tools in its own process with no external-executor mode, which would either move execution out of your terminal or require a fragile suspended-loop bridge. Warp already owns the loop + execution. See `docs/` for the full investigation.

## The warpinator changes (vs upstream Warp)

5 Rust files, each tagged `// warpinator:`:
1. `crates/warp_core/src/channel/mod.rs` — OSS channel honors `WARP_SERVER_ROOT_URL`.
2. `app/src/root_view.rs` — onboarding completes with AI enabled, no forced login.
3. `app/src/settings/ai.rs` — `is_any_ai_enabled` no longer requires an account (the master gate).
4. `app/src/server/server_api.rs` — multi-agent send tolerates a missing auth token.
5. `app/src/ai/llms.rs` — fetch the model list at startup (so the picker populates).

Plus the Node bridge: `projects/warpinator/bridge/{server,inference,graphql,proto_loader}.js` and `run.sh`.

## Docs

- `docs/PHASE0-CONTRACT.md` — the reverse-engineered `warp_multi_agent_api` wire contract.
- `docs/PHASE1-SPIKE-RESULT.md` — making AI work logged-out.
- `docs/PHASE2-INFERENCE.md` — real Pi/OpenRouter inference.
- `docs/PHASE3-STREAMING-TOOLS.md` — streaming, tools, key wiring.
- `PLANNING.md` — overall plan.

## Limitations / next

- Bridge runs as a separate Node process (via `run.sh`); native auto-spawn + bundling is future work.
- Model picker list is curated in `bridge/graphql.js` (not the full OpenRouter catalog).
- UI still says "Warp" (rebrand pending).
- Free-tier models can be rate-limited.

## License

Inherits Warp's licensing: `warpui_core`/`warpui` are MIT; the rest is AGPLv3. Pi (`@mariozechner/pi-ai`) is MIT.
