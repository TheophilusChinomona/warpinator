# warpinator Remaining Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish warpinator's polish — robust error UX, a full live model catalog, and a bridge that Warp auto-spawns — so it's a frictionless daily driver.

**Architecture:** All inference/tool logic stays in the Node bridge (`projects/warpinator/bridge/`); Warp stays a thin UI + executor. Phases 1–2 are bridge-only (unit-testable via Node). Phase 3 adds a small Rust startup hook so the bare binary spawns its own bridge.

**Tech Stack:** Node (CommonJS bridge, `@mariozechner/pi-ai`, `protobufjs`), Rust (`warp` app crate), OpenRouter HTTP API.

**Working dir:** repo root `/home/theo/Documents/Theochinomona.tech/infra/warpinator`. Run bridge tests from `projects/warpinator/bridge/`.

**Branch:** continue on `feature/warpinator-pi-backend-spike`.

> **Scope:** Three independent, individually-shippable phases. Rebrand (UI "Warp" → "warpinator"), full app bundling (ship Node + installer), and additional tools (MCP, web, documents) are **deferred to separate plans** — each needs its own discovery and doesn't block these.

---

## Phase 1 — Bridge robustness & error UX

**Why:** Today a provider failure (missing key, 401, 429, bad model) surfaces as a raw `⚠️ warpinator (…): <message>`. Make errors actionable.

### Task 1.1: Add a pure `classifyError` helper

**Files:**
- Modify: `projects/warpinator/bridge/inference.js`
- Test: `projects/warpinator/bridge/error-test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `projects/warpinator/bridge/error-test.js`:
```js
const assert = require("assert");
const { classifyError } = require("./inference");

assert.match(classifyError(new Error("No openrouter API key (request / ~/.pi/agent/auth.json / env)")), /Add your OpenRouter key/i);
assert.match(classifyError(new Error("401 Unauthorized")), /rejected the API key/i);
assert.match(classifyError(new Error("429 Too Many Requests")), /Rate limited/i);
assert.match(classifyError(new Error("model openrouter/nope not found")), /different model/i);
assert.match(classifyError(new Error("socket hang up")), /warpinator bridge error/i);
console.log("classifyError OK ✓");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd projects/warpinator/bridge && node error-test.js`
Expected: FAIL — `TypeError: classifyError is not a function`.

- [ ] **Step 3: Implement `classifyError` and export it**

In `projects/warpinator/bridge/inference.js`, add this function (above `module.exports`):
```js
// Turn a raw provider/SDK error into an actionable, user-facing message.
function classifyError(err) {
  const msg = (err && err.message) || String(err);
  const low = msg.toLowerCase();
  if (low.includes("key") && (low.includes("no ") || low.includes("missing")))
    return 'No API key configured. Add your OpenRouter key to ~/.pi/agent/auth.json ({"openrouter":{"key":"sk-or-..."}}) or set OPENROUTER_API_KEY, then retry.';
  if (low.includes("401") || low.includes("unauthorized") || low.includes("invalid api key"))
    return "The provider rejected the API key (401). Check your OpenRouter key.";
  if (low.includes("429") || low.includes("rate limit") || low.includes("quota") || low.includes("too many requests"))
    return "Rate limited by the provider (429). Wait a moment or switch models (free-tier models throttle aggressively).";
  if ((low.includes("model")) && (low.includes("not found") || low.includes("unknown") || low.includes("404")))
    return "That model isn't available on OpenRouter right now. Pick a different model in the picker.";
  return `warpinator bridge error: ${msg}`;
}
```
And add `classifyError` to the existing `module.exports`:
```js
module.exports = { runInference, loadApiKey, buildContext, classifyError, PROVIDER, DEFAULT_MODEL };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd projects/warpinator/bridge && node error-test.js`
Expected: `classifyError OK ✓`

- [ ] **Step 5: Commit**

```bash
git add projects/warpinator/bridge/inference.js projects/warpinator/bridge/error-test.js
git commit -m "feat(warpinator): actionable error classification in the bridge"
```

### Task 1.2: Use `classifyError` for the surfaced error message

**Files:**
- Modify: `projects/warpinator/bridge/server.js`

- [ ] **Step 1: Import `classifyError`**

In `projects/warpinator/bridge/server.js`, change the inference import line:
```js
const { runInference, classifyError, PROVIDER, DEFAULT_MODEL } = require("./inference");
```

- [ ] **Step 2: Use it in the error-surfacing branch**

In `handleMultiAgent`, replace the `errored` surfacing block's text with `classifyError`:
```js
  if (errored && !textMsgId && !toolCount) {
    sseWrite(res, {
      client_actions: {
        actions: [
          {
            add_messages_to_task: {
              task_id,
              messages: [{ id: nextId("msg"), task_id, agent_output: { text: `⚠️ ${classifyError(errored)}` } }],
            },
          },
        ],
      },
    });
  }
```

- [ ] **Step 3: Verify the bridge still starts + regression passes**

Run:
```bash
cd projects/warpinator/bridge
pid=$(lsof -ti tcp:8787); [ -n "$pid" ] && kill $pid; sleep 1
node server.js > /tmp/warpinator-bridge.log 2>&1 &
sleep 1 && node agent-test.js 2>&1 | grep -E "PASS|FAIL|==="
```
Expected: `ALL PHASE 3 TESTS PASS ✓`

- [ ] **Step 4: Verify the missing-key path end-to-end**

Run (temporarily hide the key so inference fails with a key error):
```bash
cd projects/warpinator/bridge
node -e '
const http=require("http");const{loadSchema}=require("./proto_loader");const{Request,ResponseEvent}=loadSchema();
const b=Request.encode(Request.fromObject({settings:{api_keys:{open_router:""}},input:{user_inputs:{inputs:[{user_query:{query:"hi"}}]}}})).finish();
process.env.OPENROUTER_API_KEY="";
const r=http.request({host:"127.0.0.1",port:8787,path:"/ai/multi-agent",method:"POST",headers:{"Content-Length":b.length}},x=>{let s="";x.on("data",c=>s+=c);x.on("end",()=>{const f=s.split("\n\n").filter(l=>l.startsWith("data:"));const ev=f.map(l=>ResponseEvent.toObject(ResponseEvent.decode(Buffer.from(l.slice(5).trim().replace(/-/g,"+").replace(/_/g,"/"),"base64")),{oneofs:true}));const txt=ev.flatMap(e=>e.client_actions?e.client_actions.actions:[]).flatMap(a=>a.add_messages_to_task?a.add_messages_to_task.messages:[]).map(m=>m.agent_output&&m.agent_output.text).join("");console.log("error text:",txt);});});r.write(b);r.end();'
```
Note: this only shows the friendly message if no key resolves from `auth.json` either; on a machine with a valid `auth.json` key it will answer normally — that's expected. The unit test (Task 1.1) is the authoritative check.

- [ ] **Step 5: Commit**

```bash
git add projects/warpinator/bridge/server.js
git commit -m "feat(warpinator): surface actionable bridge errors in Agent Mode"
```

---

## Phase 2 — Full OpenRouter model catalog

**Why:** The picker is a hardcoded list of 7. Fetch the live OpenRouter catalog so any model is selectable, keeping owl-alpha/free/auto pinned.

### Task 2.1: Pure mapping from OpenRouter `/models` to picker choices

**Files:**
- Modify: `projects/warpinator/bridge/graphql.js`
- Test: `projects/warpinator/bridge/catalog-test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `projects/warpinator/bridge/catalog-test.js`:
```js
const assert = require("assert");
const { buildChoicesFromOpenRouter, PINNED } = require("./graphql");

const api = [
  { id: "anthropic/claude-3.5-haiku", name: "Anthropic: Claude 3.5 Haiku" },
  { id: "openrouter/owl-alpha", name: "Owl Alpha" }, // duplicate of a pinned id
  { id: "x-ai/grok-2", name: "xAI: Grok 2" },
];
const choices = buildChoicesFromOpenRouter(api);
const ids = choices.map((c) => c.id);

// pinned ids come first and are not duplicated
assert.deepStrictEqual(ids.slice(0, PINNED.length), PINNED.map((p) => p.id), "pinned first");
assert.strictEqual(new Set(ids).size, ids.length, "no duplicate ids");
// fetched models are included
assert.ok(ids.includes("x-ai/grok-2"), "includes fetched model");
// each choice has the fields llmInfo needs
for (const c of choices) {
  assert.ok(c.id && c.name && c.base && c.provider, "choice fields present");
}
console.log(`catalog OK ✓ (${choices.length} models)`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd projects/warpinator/bridge && node catalog-test.js`
Expected: FAIL — `buildChoicesFromOpenRouter is not a function`.

- [ ] **Step 3: Implement `PINNED` + `buildChoicesFromOpenRouter`**

In `projects/warpinator/bridge/graphql.js`, rename the existing `MODELS` constant to `PINNED` (these stay at the top of the list), and add the builder. Replace the `MODELS`/`DEFAULT_ID` section with:
```js
// Pinned models always shown first (ids must be pi-ai openrouter ids).
const PINNED = [
  { id: "openrouter/owl-alpha", base: "owl-alpha", name: "Owl Alpha", provider: "UNKNOWN", desc: "OpenRouter cloaked model (warpinator default)" },
  { id: "openrouter/free", base: "free", name: "OpenRouter Free", provider: "UNKNOWN", desc: "OpenRouter's free auto-router (rate-limited)" },
  { id: "openrouter/auto", base: "auto", name: "OpenRouter Auto", provider: "UNKNOWN", desc: "OpenRouter auto-router" },
];

const DEFAULT_ID = "openrouter/owl-alpha";

function providerFromId(id) {
  const org = (id.split("/")[0] || "").toLowerCase();
  if (org.includes("anthropic")) return "ANTHROPIC";
  if (org.includes("openai")) return "OPENAI";
  if (org.includes("google")) return "GOOGLE";
  if (org.includes("x-ai") || org.includes("xai")) return "XAI";
  return "UNKNOWN";
}

// Map OpenRouter /models payload entries to picker choices, pinned first, deduped.
function buildChoicesFromOpenRouter(apiModels) {
  const choices = [...PINNED];
  const seen = new Set(PINNED.map((p) => p.id));
  for (const m of apiModels || []) {
    if (!m || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    choices.push({
      id: m.id,
      base: m.id.split("/").slice(1).join("/") || m.id,
      name: m.name || m.id,
      provider: providerFromId(m.id),
      desc: (m.description || "").slice(0, 140) || undefined,
    });
  }
  return choices;
}
```
Update `module.exports` at the bottom of the file (keep a temporary `MODELS` alias so `server.js`, which still imports `MODELS` until Task 2.2, keeps working between commits):
```js
module.exports = { handleGraphql, buildChoicesFromOpenRouter, PINNED, MODELS: PINNED, DEFAULT_ID };
```

- [ ] **Step 4: Point the existing `llmInfo`/`featureModelChoice` at the active list**

In `graphql.js`, add a module-level mutable `let activeModels = PINNED;` near the top, and change `availableLlms()` to use it:
```js
function availableLlms() {
  return { defaultId: DEFAULT_ID, choices: activeModels.map(llmInfo), preferredCodexModelId: null };
}
```
Add a setter used by the live fetch:
```js
function setActiveModels(choices) {
  if (Array.isArray(choices) && choices.length) activeModels = choices;
}
```
and export it: add `setActiveModels` to `module.exports`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd projects/warpinator/bridge && node catalog-test.js`
Expected: `catalog OK ✓ (3 models)` (only pinned + grok in the fixture; the duplicate owl is dropped).

- [ ] **Step 6: Commit**

```bash
git add projects/warpinator/bridge/graphql.js projects/warpinator/bridge/catalog-test.js
git commit -m "feat(warpinator): map OpenRouter catalog to picker choices (pinned first, deduped)"
```

### Task 2.2: Fetch the live catalog at bridge startup

**Files:**
- Modify: `projects/warpinator/bridge/server.js`
- Modify: `projects/warpinator/bridge/graphql.js`

- [ ] **Step 1: Add an async catalog loader to `graphql.js`**

Append to `graphql.js` (above `module.exports`):
```js
const https = require("https");

// Fetch OpenRouter's model list and install it as the active picker list.
// Best-effort: on any failure the pinned list remains.
function refreshCatalog(apiKey) {
  return new Promise((resolve) => {
    const req = https.request(
      { host: "openrouter.ai", path: "/api/v1/models", method: "GET", headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(body).data || [];
            const choices = buildChoicesFromOpenRouter(data);
            setActiveModels(choices);
            resolve(choices.length);
          } catch (_) {
            resolve(0);
          }
        });
      }
    );
    req.on("error", () => resolve(0));
    req.setTimeout(8000, () => { req.destroy(); resolve(0); });
    req.end();
  });
}
```
Add `refreshCatalog` to `module.exports`.

- [ ] **Step 2: Call it once at server startup**

In `projects/warpinator/bridge/server.js`, change the imports to include the new helpers and the key loader:
```js
const { handleGraphql, refreshCatalog } = require("./graphql");
const { runInference, classifyError, loadApiKey, PROVIDER, DEFAULT_MODEL } = require("./inference");
```
Inside `server.listen(PORT, "127.0.0.1", () => { ... })`, after the existing log lines, add:
```js
  refreshCatalog(loadApiKey({})).then((n) =>
    console.log(n ? `catalog: loaded ${n} OpenRouter models` : "catalog: using pinned models (fetch failed)")
  );
```
(Remove the now-unused `MODELS` import reference: the `console.log("graphql: served …")` line in the GraphQL handler currently interpolates `MODELS.length`; change it to a static string `served freeAvailableModels`.)

- [ ] **Step 3: Verify live fetch + served count**

Run:
```bash
cd projects/warpinator/bridge
pid=$(lsof -ti tcp:8787); [ -n "$pid" ] && kill $pid; sleep 1
node server.js > /tmp/warpinator-bridge.log 2>&1 &
sleep 6
grep "catalog:" /tmp/warpinator-bridge.log
curl -s -X POST http://127.0.0.1:8787/graphql/v2 -H 'Content-Type: application/json' \
  -d '{"query":"query FreeAvailableModels { freeAvailableModels { featureModelChoice { agentMode { choices { id } } } } }"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('picker models:',JSON.parse(d).data.freeAvailableModels.featureModelChoice.agentMode.choices.length))"
```
Expected: `catalog: loaded <N> OpenRouter models` (N in the hundreds) and `picker models: <N>`. (If offline: `using pinned models` and `picker models: 3`.)

- [ ] **Step 4: Verify model honoring still works (regression)**

Run: `cd projects/warpinator/bridge && node agent-test.js 2>&1 | grep -E "PASS|==="`
Expected: `ALL PHASE 3 TESTS PASS ✓`

- [ ] **Step 5: Commit**

```bash
git add projects/warpinator/bridge/graphql.js projects/warpinator/bridge/server.js
git commit -m "feat(warpinator): live OpenRouter model catalog in the picker"
```

---

## Phase 3 — Native bridge auto-spawn + default backend

**Why:** Remove the launcher dependency for the common case — the bare `warp-oss` binary should start its own bridge and point at it. (The `run.sh` launcher remains as an explicit alternative.)

> Verification here is integration (build + launch + observe), not unit tests — Warp's startup path isn't unit-testable. Each task gives exact observe commands.

### Task 3.1: Spawn the bridge + default the backend URL on startup (Oss only)

**Files:**
- Modify: `app/src/lib.rs` (the startup block around lines 596–620, right after `let args = warp_cli::Args::from_env();` and the existing server-url-override block)

- [ ] **Step 1: Add the spawn-and-default logic**

In `app/src/lib.rs`, immediately **after** the closing brace of the `if ChannelState::channel().allows_server_url_overrides() { … }` block (the one that handles `args.server_root_url()` etc., ~line 620), insert:
```rust
    // warpinator: on the OSS build, auto-start the local bridge and point the client at it
    // unless the user already specified a server URL. Keeps the account-free AI working with
    // zero setup. The bridge dir can be overridden with WARPINATOR_BRIDGE_DIR; the port with
    // WARPINATOR_BRIDGE_PORT (default 8787). Set WARPINATOR_NO_AUTOSPAWN=1 to opt out.
    #[cfg(not(target_family = "wasm"))]
    if matches!(ChannelState::channel(), warp_core::channel::Channel::Oss)
        && std::env::var_os("WARP_SERVER_ROOT_URL").is_none()
        && std::env::var_os("WARPINATOR_NO_AUTOSPAWN").is_none()
    {
        let port = std::env::var("WARPINATOR_BRIDGE_PORT").unwrap_or_else(|_| "8787".to_string());
        let root = format!("http://127.0.0.1:{port}");
        let ws = format!("ws://127.0.0.1:{port}/graphql/v2");
        warpinator_bridge::ensure_started(&port);
        if let Err(e) = ChannelState::override_server_root_url(root) {
            eprintln!("warpinator: invalid bridge URL: {e:#}");
        }
        let _ = ChannelState::override_ws_server_url(ws);
    }
```

- [ ] **Step 2: Create the spawn helper module**

Create `app/src/warpinator_bridge.rs`:
```rust
//! warpinator: spawn and supervise the local AI bridge (a Node sidecar).
use std::process::{Command, Stdio};

/// Start the bridge if nothing is already listening on `port`. Best-effort and
/// non-fatal: if Node or the bridge dir is missing, AI simply won't work until
/// the user runs the bridge manually. The bridge dir defaults to
/// `<repo>/projects/warpinator/bridge` relative to the executable, overridable
/// via `WARPINATOR_BRIDGE_DIR`.
pub fn ensure_started(port: &str) {
    // Already running? (a TCP connect to the port succeeds)
    if std::net::TcpStream::connect(format!("127.0.0.1:{port}")).is_ok() {
        return;
    }
    let dir = bridge_dir();
    let server_js = dir.join("server.js");
    if !server_js.exists() {
        eprintln!(
            "warpinator: bridge not found at {} (set WARPINATOR_BRIDGE_DIR); AI disabled until started",
            server_js.display()
        );
        return;
    }
    let mut cmd = Command::new("node");
    cmd.arg("server.js")
        .current_dir(&dir)
        .env("WARPINATOR_BRIDGE_PORT", port)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match cmd.spawn() {
        Ok(_) => eprintln!("warpinator: started bridge ({})", server_js.display()),
        Err(e) => eprintln!("warpinator: failed to start bridge: {e}"),
    }
}

fn bridge_dir() -> std::path::PathBuf {
    if let Some(d) = std::env::var_os("WARPINATOR_BRIDGE_DIR") {
        return std::path::PathBuf::from(d);
    }
    // Dev default: walk up from the executable to the repo, then projects/warpinator/bridge.
    // target/debug/warp-oss -> repo root is two levels up from target/.
    let exe = std::env::current_exe().unwrap_or_default();
    let repo = exe
        .ancestors()
        .find(|p| p.join("projects/warpinator/bridge/server.js").exists())
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    repo.join("projects/warpinator/bridge")
}
```

- [ ] **Step 3: Register the module**

In `app/src/lib.rs`, add the module declaration near the other top-level `mod` statements (search for an existing `mod ` line, e.g. `mod features;`, and add beneath it):
```rust
mod warpinator_bridge;
```

- [ ] **Step 4: Build**

Run: `PATH="$HOME/.local/bin:$PATH" PROTOC="$HOME/.local/bin/protoc" cargo build --bin warp-oss --features gui > build.log 2>&1; tail -n1 build.log`
Expected: `Finished \`dev\` profile …`, 0 errors.

- [ ] **Step 5: Verify the bare binary auto-spawns the bridge and uses it**

Run (no `WARP_SERVER_ROOT_URL`, no manual bridge, kill any existing bridge first):
```bash
pid=$(lsof -ti tcp:8787); [ -n "$pid" ] && kill $pid; sleep 1
pkill -x warp-oss; sleep 1
WARP_DATA_PROFILE=autospawn-check ./target/debug/warp-oss > run.log 2>&1 &
sleep 6
echo "bridge listening: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/healthz)"
echo "node bridge proc: $(pgrep -af 'server.js' | grep -c warpinator || echo 0)"
grep -i "warpinator: started bridge" run.log || echo "(spawn log not captured — stderr may be redirected; check the port result above)"
```
Expected: `bridge listening: 404` (bridge up) and a node `server.js` process running. Then open the model picker in the GUI and confirm models load. Stop with `pkill -x warp-oss; pkill -f projects/warpinator/bridge/server.js`.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib.rs app/src/warpinator_bridge.rs
git commit -m "feat(warpinator): OSS build auto-spawns the local bridge and defaults to it"
```

### Task 3.2: Update README to reflect zero-setup launch

**Files:**
- Modify: `projects/warpinator/README.md`

- [ ] **Step 1: Update the Quickstart**

In `projects/warpinator/README.md`, change the run step to note the bare binary now works:
```markdown
# 3. Run it — the OSS build auto-starts the bridge and points at it
./target/debug/warp-oss
#    (or use the explicit launcher: projects/warpinator/run.sh)
#    opt out of auto-spawn with WARPINATOR_NO_AUTOSPAWN=1
```

- [ ] **Step 2: Commit**

```bash
git add projects/warpinator/README.md
git commit -m "docs(warpinator): document zero-setup auto-spawn launch"
```

---

## Final verification (run after all phases)

- [ ] **Full bridge regression**

Run:
```bash
cd projects/warpinator/bridge
pid=$(lsof -ti tcp:8787); [ -n "$pid" ] && kill $pid; sleep 1
node server.js > /tmp/warpinator-bridge.log 2>&1 & sleep 6
node error-test.js && node catalog-test.js && node agent-test.js 2>&1 | grep -E "PASS|==="  && node file-tools-test.js 2>&1 | grep -E "OK|✓"
```
Expected: `classifyError OK ✓`, `catalog OK ✓`, `ALL PHASE 3 TESTS PASS ✓`, `FILE TOOLS OK ✓`.

- [ ] **Push the branch**

```bash
git push origin feature/warpinator-pi-backend-spike
```

---

## Deferred to separate plans

- **Rebrand** (UI "Warp" → "warpinator"): needs discovery of user-facing strings/assets and care around `app_id`/data-dir identifiers (changing them resets profiles). Write `2026-..-warpinator-rebrand.md`.
- **Full app bundling**: ship a Node runtime (or single-binary the bridge via `bun build`/`pkg`) + an installer so end users don't need `node`. Write `2026-..-warpinator-bundling.md`.
- **More tools**: MCP passthrough, web search/fetch, documents — each needs its proto shape mapped like the file tools. Write `2026-..-warpinator-more-tools.md`.
