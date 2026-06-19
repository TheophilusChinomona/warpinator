# warpinator — Phase 1 Spike: RESULT ✅

**Date:** 2026-06-14
**Outcome:** End-to-end proof. Warp's full Agent Mode UI, **logged out / no Warp account / no API key**, sent an agent request to the local **warpinator bridge** and rendered its reply natively. Oz fully bypassed.

**Proof:**
- Bridge log: `1 × POST /ai/multi-agent`, request protobuf decoded (first turn: `conversation_id=(none) tasks=0`).
- Warp UI rendered: *"👋 Hello from the warpinator bridge — generated locally, no Oz, no account. (Phase 0 wire-contract proof.)"*

---

## What it actually took (4 code changes)

The "remove 5 `is_logged_in()` gates" hypothesis was wrong. The real locks, found empirically by running the build and observing where it stopped:

| # | File | Change | Why |
|---|------|--------|-----|
| 1 | `crates/warp_core/src/channel/mod.rs` (`allows_server_url_overrides`) | `Channel::Oss` now returns `true` | OSS silently ignored `WARP_SERVER_ROOT_URL`, so the client never talked to the bridge. |
| 2 | `app/src/root_view.rs` (`OnboardingCompleted` handler, ~:2168) | `requires_login = false` | Onboarding forced login when AI was enabled → the "Get started with AI / Connect your account" wall. |
| 3 | `app/src/settings/ai.rs` (`is_any_ai_enabled`, ~:1547) | dropped the `!is_anonymous_or_logged_out` condition | **The master gate.** It disabled ALL AI for logged-out users → `default_session_mode` downgraded to Terminal, Agent Mode hidden, input locked to terminal. |
| 4 | `app/src/server/server_api.rs` (`generate_multi_agent_output`, ~:1297) | auth token + ambient-workload token now optional (`.ok()` / `.ok().flatten()` instead of `?`); bearer attached only if present | The send aborted with "missing authentication credentials" before POSTing when logged out. |

All four carry a `// warpinator:` comment explaining the divergence from upstream.

### Not needed in the end (profile-local, harmless)
While diagnosing, I also set `agents.warp_agent.input.nld_in_terminal_enabled = true` in the spike profile's `settings.toml` and bound `input:toggle_input_type` → `ctrl-shift-A` in its `keybindings.yaml`. Once change #3 landed, `default_session_mode = "agent"` took effect and the session opened directly in Agent Mode, making these unnecessary. They live only in `~/.config/warp-oss-warpinator-spike2/`, not the repo.

---

## How to reproduce

```bash
# 1. bridge (Phase 0 hello-world)
cd projects/warpinator/bridge && node server.js          # http://127.0.0.1:8787

# 2. Warp, pointed at the bridge, fresh profile so onboarding runs once
WARP_SERVER_ROOT_URL=http://127.0.0.1:8787 \
WARP_WS_SERVER_URL=ws://127.0.0.1:8787/graphql/v2 \
WARP_DATA_PROFILE=warpinator-spike2 \
./target/debug/warp-oss
```
Complete onboarding (no login required now) → land in the terminal → session is in Agent Mode → type a prompt → bridge answers.

Notes:
- `WARP_DATA_PROFILE` works because this is a **debug** build (`channel/state.rs:132`); it sandboxes user data so we don't touch the user's real Warp profile.
- Redirecting `WARP_SERVER_ROOT_URL` sends ALL root traffic to the bridge; non-AI calls (`/graphql/v2`, `/signup/remote`, …) get a benign 404 and Warp tolerates them.

---

## What this unlocks (next: Phase 2/3)

The hard parts are now proven: the wire contract (Phase 0) and a logged-out, account-free, redirectable client (Phase 1). Remaining:

1. **Real inference** — replace the bridge's canned reply with Pi (`pi-ai` → OpenRouter) using the user's key, emitting streamed `agent_output` (`append_to_message_content`) instead of one block.
2. **Tool round-trips** (Phase 2) — emit `tool_call`s, consume `tool_call_result` from the re-sent `Request`, map Warp tools ↔ Pi tools.
3. **API-key wiring** — route the existing key UI (`settings_view/ai_page.rs`, `custom_inference_modal.rs`; request already carries `api_keys` / `custom_model_providers`) to the bridge/Pi.
4. **Bridge ergonomics** — answer the model-discovery `/graphql/v2` calls so the model picker is populated (instead of falling back to the default `auto`), and serve benign responses for other root paths.
5. **Packaging** — default the backend to the bridge + spawn it as a managed child process (drop the env-var/profile scaffolding).

*Last updated: 2026-06-14*
