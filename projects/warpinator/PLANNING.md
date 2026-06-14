# warpinator

> A fork of the Warp terminal that keeps 100% of Warp's UI/UX but replaces the proprietary, account-gated "Oz" AI backend with Pi (pi.dev) — so anyone can plug in their own API keys (OpenRouter, OpenAI-compatible, Anthropic, Gemini, Ollama, …) and use the AI features with no Warp account.

**Created:** 2026-06-13
**Type:** Application (feature-subsystem replacement inside an existing Rust desktop app + Node sidecar)
**Stack:** Rust (Warp client, minimal patches) + TypeScript/Node (Pi sidecar + protocol bridge) + Protobuf/SSE wire contract
**Skill Loadout:** PAUL (managed build), fork-rebrand-pipeline (upstream hygiene), AEGIS/security audit, codex (second opinion)
**Quality Gates:** builds clean (`cargo build --bin warp-oss --features gui`), AI works with a BYO key and **no login**, Agent Mode tool-execution parity, no secrets leave the machine except to the chosen provider

---

## Problem Statement

Warp is a best-in-class terminal — the GPU UI, command blocks, input editor, and Agent Mode UX are genuinely loved. But **every AI feature is gated behind "Oz", Warp's closed backend, which requires a Warp account and routes all inference through Warp's servers.** Even Warp's existing "bring your own key" / custom-inference settings still ship the keys *to Oz* and still demand login.

**Who it's for:** Warp users who want to (a) use their own provider API keys, (b) avoid a mandatory account/cloud dependency, (c) control cost and model choice, and (d) keep prompts/code from transiting a third party's servers. This is an open-source fork for people who love the terminal but reject the closed, gated AI.

**Why build vs buy:** No existing build of Warp lets you swap the AI backend. The closed coupling to Oz *is* the problem; the only fix is to fork and re-point the backend.

---

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Client (UI, terminal, everything you love) | **Warp, unchanged** (Rust, WarpUI/Vulkan) | The whole point is to keep Warp's UI/UX intact. Only the AI backend target changes. |
| AI backend | **Pi (pi.dev) — `pi-ai` + `pi-agent-core`** (TypeScript/Node, MIT) | User's explicit choice. Pi gives a maintained 30+ provider matrix, BYO-key/OAuth, mid-session model switching, and a real agent loop — for free. MIT license is compatible with bundling alongside Warp's AGPLv3 core. |
| Bridge | **New Node service** speaking Warp's `warp_multi_agent_api` protocol on the wire, driving Pi internally | Warp's client is purely a UI + event-stream consumer; the agent loop runs server-side. So the integration is a local server that implements Warp's protocol and runs Pi as the loop. |
| Wire contract | **Protobuf `warp_multi_agent_api` over HTTP + SSE** (+ tool round-trip) | This is Warp's existing contract — we conform to it rather than change the client. |
| Providers (via Pi) | **OpenRouter-first**, plus any OpenAI-compatible endpoint, Anthropic, Gemini, Ollama, etc. | OpenRouter alone reaches hundreds of models with one key; Pi covers native providers too. |
| Redirect mechanism | **`WARP_SERVER_ROOT_URL` env var (already exists)** | The client already supports overriding the backend root URL — point it at the local bridge. |

### Why Pi-as-backend (sidecar) over a native Rust reimplementation
Both approaches must reverse-engineer Warp's `ResponseEvent`/tool contract (the hard part). The native path reuses the in-repo Rust protobuf types and avoids a Node runtime, but you reimplement the provider client + agent loop. **The user chose Pi specifically** to inherit its provider matrix and loop, accepting the cost of bundling a Node sidecar and mapping Warp's tool protocol onto Pi's tool model. See Design Decisions.

### Research Needed
- The exact, complete set of `warp_multi_agent_api::ResponseEvent` variants the UI requires to render thoughts/blocks/diffs/tool-calls (read from the `warp_multi_agent_api` crate's `.proto` / generated types).
- The **tool-execution round-trip**: whether the client re-sends the conversation (with locally-executed tool results) on each turn, or whether there is a bidirectional RTC channel (`WARP_WS_SERVER_URL` → `rtc_server_url`). This determines the bridge's state machine.
- How to regenerate the protobuf types for TypeScript (the in-repo definitions are a Rust crate).
- Pi's RPC/JSON headless mode surface — how the bridge embeds/drives `pi-agent-core`.

---

## Architecture

```
 Warp client (UNCHANGED UI/UX, Rust)
   │  POST {WARP_SERVER_ROOT_URL}/ai/multi-agent
   │  body: warp_multi_agent_api::Request (protobuf)   ── includes api_keys, custom_model_providers, model, tasks, input
   │  resp: stream of base64(protobuf ResponseEvent) over SSE
   │  tool round-trip: via re-sent Request and/or rtc channel (WARP_WS_SERVER_URL)
   ▼
 ┌──────────────────────────────────────────────┐
 │  warpinator bridge  (Node, localhost-only)    │
 │  • decodes warp_multi_agent_api::Request      │
 │  • translates ↔ Pi (tools, messages, model)   │
 │  • runs the loop via pi-agent-core            │
 │  • streams warp ResponseEvents back over SSE  │
 └──────────────────────────────────────────────┘
   │
   ▼  pi-ai providers (USER'S OWN KEYS)
      OpenRouter / OpenAI-compatible / Anthropic / Gemini / Ollama / …
```

**Client-side patches (Rust, minimal):**
- Default `server_root_url` (or AI endpoint) to the local bridge.
- Remove/neutralize the `is_logged_in()` gates so AI works with no Warp account.
- Reuse the existing key-entry UI and request fields (already present — see below).

---

## Data Model

Not a database app, but the relevant state:

| Entity | Where it lives today | warpinator change |
|--------|----------------------|-------------------|
| API keys / custom providers | `ApiKeyManager`, settings storage (`app/src/settings_view/ai_page.rs`, `custom_inference_modal.rs`); already serialized into the request as `api_keys` / `custom_model_providers` (`app/src/ai/agent/api.rs:116`) | Reuse the UI; route keys to the **bridge/Pi** instead of Oz. Optionally surface Pi's `~/.pi/agent/auth.json` model. |
| Conversation / agent turn | `warp_multi_agent_api::Request` (`input: Vec<AIAgentInput>`, `tasks`, `model`, `metadata` w/ conversation tokens) | Bridge consumes this; maps to Pi session state keyed by conversation tokens. |
| Conversation history (local) | `ai_queries` sqlite table | Unchanged — still written client-side. |
| Auth token | Bearer token attached at `app/src/server/server_api.rs:1337` | Bridge ignores/loosens it; no Warp account needed. |

---

## API Surface (the protocol contract)

### The single seam
| Endpoint | Methods | Auth | Purpose |
|----------|---------|------|---------|
| `POST /ai/multi-agent` | POST + SSE stream | none (loosened) | Main Agent Mode turn. Bridge implements this. |
| `POST /agent-mode-evals/multi-agent` | POST + SSE | none | Evals variant (optional). |
| (legacy) GraphQL AI ops | — | — | Older "generate command"/dialogue features; out of scope for MVP, may stub. |
| Tool round-trip channel | TBD (re-sent Request and/or `rtc_server_url`) | none | How locally-executed tool results return to the loop. **Open question #1.** |

### Bridge ↔ Pi (internal)
- Embed/drive `pi-agent-core` (in-process Node) or Pi's RPC/JSON headless mode.
- Map Warp tool calls ↔ Pi tools (read/write/edit/bash + Warp's command-execution semantics). **The main adaptation layer.**

### Auth strategy
**Remove the account requirement.** No bearer token needed against the local bridge; the bridge binds `127.0.0.1` only. Keys authenticate to *providers*, not to Warp.

---

## Deployment Strategy

### Local Development (MVP)
| Service | Runtime | Port | Purpose |
|---------|---------|------|---------|
| Warp client | `target/debug/warp-oss` | — | Built from source (already working). |
| warpinator bridge | `node` (Pi sidecar) | e.g. `:8787` (localhost) | Implements `/ai/multi-agent`, runs Pi. |

Run: start the bridge, then launch Warp with `WARP_SERVER_ROOT_URL=http://localhost:8787` (and `WARP_WS_SERVER_URL` if the round-trip uses RTC).

### Production / packaging
- Warp **spawns the bridge as a managed child process** at startup (Warp already spawns subprocesses — terminal-server, GPU process), with health-check + restart.
- Bundle a Node runtime (or compile the bridge to a single executable, e.g. via `bun build`/`pkg`) to avoid requiring a system Node.
- Ship MIT/AGPL license notices for the combined distribution.

---

## Security Considerations

- **Secrets locality:** API keys are stored locally and only leave the machine when calling the *user-chosen* provider — this is the core privacy win over Oz. Verify nothing is logged or phoned home.
- **Bridge exposure:** bind `127.0.0.1` only; never `0.0.0.0`. Optional shared-secret handshake between client and bridge.
- **Removing the auth gate:** auditing what *else* the `is_logged_in()` checks protect (request usage limits, harness availability, Drive/sync) so ungating AI doesn't break or expose unrelated cloud features — disable cleanly rather than half-on.
- **Key storage at rest:** reuse Warp's existing secret storage; consider Pi's `auth.json` + `!command`/`$VAR` resolution for advanced users.
- **Supply chain:** Pi + its npm deps become part of the trust base — pin and review.

---

## UI/UX Needs

Mostly **reuse what exists** — that's the win.

| View | Status | Work |
|------|--------|------|
| API key / custom provider entry | **Exists** (`ai_page.rs`, `custom_inference_modal.rs`) | Re-point to bridge; relabel for BYO/no-account. |
| Model picker | **Exists** (`app/src/ai/llms.rs`, `harness_*`) | Populate from Pi's available providers/models; drop Oz-only harness assumptions. |
| Login walls on AI | **Exists (to remove)** | Remove `is_logged_in()` gates; design a "no account needed" first-run state. |
| Agent Mode panels / blocks / diffs | **Unchanged** | Must render identically — driven entirely by faithful `ResponseEvent`s from the bridge. |

- **Real-time:** SSE streaming of `ResponseEvent`s (existing); tool round-trip channel.
- **Design system:** WarpUI — untouched.

---

## Integration Points

| Integration | Type | Purpose | Auth |
|-------------|------|---------|------|
| Pi (`pi-ai`, `pi-agent-core`) | Embedded Node lib / RPC | The AI engine | n/a (local) |
| OpenRouter | Provider (via Pi) | Hundreds of models, one key | user API key |
| OpenAI-compatible endpoints (Ollama, LM Studio, vLLM, …) | Provider (via Pi `models.json`) | Local/self-hosted models | optional |
| Anthropic / Gemini / etc. | Native providers (via Pi) | Direct provider access | user API key |

---

## Phase Breakdown

### Phase 0: De-risk the contract (spike)
- **Build:** Read the `warp_multi_agent_api` schema; enumerate every `ResponseEvent` variant the UI consumes; determine the tool round-trip mechanism (re-sent Request vs RTC). Capture a real Oz session's event sequence if possible.
- **Testable:** A written, complete spec of the wire contract + a "hello world" bridge that returns one canned `ResponseEvent` stream Warp renders without crashing.
- **Outcome:** Confidence the rest is buildable; the riskiest unknown resolved.

### Phase 1: Chat-only MVP (no tools, no account)
- **Build:** Bridge implements `POST /ai/multi-agent` for single-turn text via Pi→OpenRouter using the user's key; remove `is_logged_in()` AI gates; default `WARP_SERVER_ROOT_URL` to the bridge.
- **Testable:** Launch Warp logged-out, type a question, get a streamed answer from your own OpenRouter key.
- **Outcome:** Proves the entire thesis — Warp's UI + your key + no Oz.

### Phase 2: Tool round-trips (Agent Mode parity)
- **Build:** Implement the tool-execution loop in the bridge — emit tool calls, receive locally-executed results, continue the Pi loop; map Warp tools ↔ Pi tools.
- **Testable:** Agent Mode runs commands, edits files, shows diffs/blocks correctly end-to-end.
- **Outcome:** Full agentic functionality on BYO keys.

### Phase 3: Multi-provider + settings polish
- **Build:** Wire the key/provider UI and model picker to Pi's provider matrix (OpenRouter, OpenAI-compat, Anthropic, Gemini, Ollama); first-run "no account" UX.
- **Testable:** Switch providers/models from settings; keys persist; local models work.
- **Outcome:** A real BYO-everything experience.

### Phase 4: Packaging & distribution
- **Build:** Warp spawns/manages the bridge as a child process (health/restart); bundle Node runtime or single-binary the bridge; license notices; docs.
- **Testable:** Fresh install runs with no manual sidecar steps.
- **Outcome:** Shippable warpinator.

---

## Skill Loadout & Quality Gates

### Skills Used During Build
| Skill | When It Fires | Purpose |
|-------|---------------|---------|
| PAUL | Throughout | Milestones/phases for a complex build |
| fork-rebrand-pipeline | Setup + ongoing | Upstream remote hygiene, license compliance, keep ability to pull Warp updates |
| AEGIS / security-review | End of each phase | Secrets handling, ungated-auth audit, supply chain |
| codex (consult/challenge) | Architecture + contract spike | Adversarial check on the protocol reverse-engineering |

### Quality Gates
| Gate | Threshold | When |
|------|-----------|------|
| Build | `cargo build --bin warp-oss --features gui` succeeds | Every phase |
| Functional | AI answers with BYO key, logged out | Phase 1 on |
| Agent parity | Tool calls/edits/diffs render identically to Oz | Phase 2 |
| Security | No secrets leave host except to chosen provider; bridge localhost-only | Each phase |
| Upstream | Can still rebase/merge `upstream/warp` | Ongoing |

---

## Design Decisions

1. **Pi as the AI backend (sidecar), not native Rust** — user's explicit choice; inherit Pi's provider matrix + agent loop, accept a bundled Node sidecar + tool-protocol mapping cost.
2. **Keep Warp's UI/UX 100% unchanged** — it's the asset; only the backend target changes.
3. **Conform to Warp's `warp_multi_agent_api` wire contract** rather than alter the client — minimizes Rust changes and keeps the UI behaving natively.
4. **Redirect via the existing `WARP_SERVER_ROOT_URL`** — the seam is one endpoint + an env var that already works.
5. **Remove the `is_logged_in()` AI gates** — no Warp account required (the literal goal).
6. **OpenRouter-first** — one key reaches hundreds of models; broadest BYO coverage for least effort.
7. **Bridge binds localhost only** — security; keys authenticate to providers, not to a server.
8. **"UI on Pi" rejected** — Pi is an AI brain, not a UI/terminal host; that path means rebuilding Warp. Pi meets Warp only at the AI backend seam.

---

## Open Questions

1. **Tool round-trip mechanism** — does the client re-send the full conversation with locally-executed tool results each turn, or is there a bidirectional RTC channel (`WARP_WS_SERVER_URL`/`rtc_server_url`)? Resolve in Phase 0.
2. **Full `ResponseEvent` variant coverage** — exactly which events must the bridge emit for the UI to render thoughts/blocks/diffs/tool-calls correctly?
3. **Protobuf for TypeScript** — best way to regenerate `warp_multi_agent_api` types in Node (the in-repo defs are Rust).
4. **Warp tools ↔ Pi tools mapping** — how cleanly do Warp's tool/command semantics map onto Pi's read/write/edit/bash? Where are the gaps?
5. **Collateral of ungating auth** — what else do the `is_logged_in()` checks protect (usage limits, harness availability, Drive/sync), and how to disable cleanly?
6. **Packaging** — bundle Node vs single-binary the bridge (bun/pkg); size and startup cost.
7. **License/notice obligations** for distributing Warp(AGPL) + Pi(MIT) + bridge together.

---

## Next Actions

- [ ] Phase 0 spike: read `warp_multi_agent_api` crate, document every `ResponseEvent` variant + the tool round-trip mechanism.
- [ ] Stand up a "hello world" bridge that returns a canned `ResponseEvent` stream; point Warp at it via `WARP_SERVER_ROOT_URL` and confirm the UI renders it.
- [ ] Locate and list the exact `is_logged_in()` AI gates to remove.
- [ ] Verify Pi's headless/RPC embedding API and a minimal OpenRouter call.
- [ ] Run `/seed launch warpinator` (or `/seed graduate`) to hand off to PAUL once Phase 0 is scoped.

---

## References

- Build/run (verified working): `cargo build --bin warp-oss --features gui` → `target/debug/warp-oss`. See `WARP.md`, `README.md`, `script/run`.
- AI/Oz seam (code, verified):
  - `app/src/server/server_api.rs:1310-1380` — `/ai/multi-agent` URL build, bearer auth, SSE decode of `ResponseEvent`.
  - `app/src/ai/agent/api.rs:116` — request `api_keys` / `custom_model_providers` fields; `app/src/ai/agent/api/impl.rs` — request building.
  - `app/src/ai/harness_availability.rs:202` (login gate), `:49`/`:398` (Oz harness default/mapping).
  - `app/src/ai/llms.rs:1084`, `app/src/ai/request_usage_model.rs:228`, `app/src/ai_assistant/requests.rs:132` — more login gates.
  - `app/src/settings_view/ai_page.rs`, `app/src/settings_view/custom_inference_modal.rs` — existing key/provider UI.
  - `crates/warp_cli/src/lib.rs:44` (`WARP_SERVER_ROOT_URL`, `WARP_WS_SERVER_URL`), `crates/warp_core/src/channel/state.rs:85` (override fns).
- Pi (pi.dev): https://pi.dev/docs/latest/providers · architecture: https://mariozechner.at/posts/2025-11-30-pi-coding-agent/ · source: https://github.com/badlogic/pi-mono (**MIT**).
- Licensing: Warp core **AGPLv3** (`LICENSE-AGPL`); WarpUI crates **MIT** (`LICENSE-MIT`); Pi **MIT**.

---

*Last updated: 2026-06-13*
