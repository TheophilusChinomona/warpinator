# warpinator — Remote Filesystem (Wave-style) Design

**Date:** 2026-06-18
**Status:** Approved — revised after independent code review
**Goal:** When you `ssh user@host` inside Warpinator, the Project Explorer, file tree, and editor all work on the remote filesystem — identical to Wave Terminal's experience — with no Warp account required.

---

## Problem

Warpinator shows "Project explorer unavailable — The Project Explorer requires access to your local workspace, which isn't supported in remote sessions." when SSHed into a remote host. The upstream Warp resolves this by auto-downloading a remote-server daemon from their CDN, which requires a Warp account. Warpinator has no account and our local bridge is not Warp's CDN.

---

## How Warp's remote-server mechanism works (and why it works for us)

When you type `ssh user@host` in a Warp/Warpinator terminal session, the client "warpifies" the connection and runs an install sequence on the remote host:

1. **Server-side download (first attempt):** Runs `install_remote_server.sh` on the remote, which tries to `curl {server_root_url}/download/cli?...` — for us that's `http://127.0.0.1:8787/download/cli`. The remote host can't reach the local machine's loopback port, so curl fails with a non-2 exit code.
2. **SCP fallback (automatic):** `scp_fallback::should_try_install()` returns `true` for any exit code that isn't 2 (unsupported arch/OS), so the client falls back to the SCP upload path. It checks `~/.cache/Warp-Oss/remote-server/tarballs/unversioned/linux-x86_64/oz.tar.gz` locally. If that file exists, it uploads it over the existing SSH connection and runs extraction. If that file doesn't exist, it tries to download it from `download_tarball_url()`.
3. **Daemon starts:** The script extracts the tarball, finds the `oz*` binary, installs it as `~/.warp-dev/remote-server/warp-oss` on the remote (see OSS channel note below), and launches `warp-oss remote-server-daemon`. The local client speaks a length-prefixed protobuf-over-SSH-stdio protocol to it. The post-install step runs `warp-oss --version` to verify the binary is functional; failure here (e.g. glibc mismatch) surfaces as "Post-install verification failed" and aborts the connection.
4. **Daemon persists across disconnects:** The daemon is spawned with `setsid()` (`proxy.rs:183`) and a flock/PID-file (`proxy.rs:134-149`) so it outlives the SSH session and is reused on reconnect. A stale running daemon from an older binary will NOT be replaced by re-staging alone — it must be killed on the remote first (`pkill warp-oss`).
5. **UI lights up:** `LocalOrRemotePath`, the remote file tree (`remote_host_id`), and `ReadFileContextRequest` (editor open) are already fully wired in Warp's UI — no new UI code needed.

**Key code locations:**
- `app/src/remote_server/ssh_transport/installation.rs` — two-step install: server-side → SCP fallback
- `app/src/remote_server/ssh_transport/installation/scp_fallback.rs` — `cached_remote_server_tarball()` short-circuits to the cached file when it exists; `is_valid_cached_tarball()` only checks `len > 0` (no integrity verification)
- `crates/remote_server/src/setup.rs:536` — `remote_server_artifact_version()` returns `"unversioned"` for `Channel::Oss`
- `crates/warp_core/src/channel/mod.rs:62` — `cli_command_name()` returns `"warp-oss"` for `Channel::Oss`
- `crates/remote_server/src/setup.rs:642` — `download_tarball_url()` — Phase 2 changes this for OSS
- `app/src/remote_server/unix/proxy.rs:101` — daemon lifecycle: flock serialisation, setsid, PID reuse

**OSS channel rides the `dev` arms (important):** `remote_server_dir()` for `Channel::Oss` currently returns `".warp-dev"` (setup.rs:349-352, `TODO(alokedesai)` comment). This means the install path on the remote is `~/.warp-dev/remote-server/warp-oss`, not `~/.warp/`. Similarly, `download_channel()` returns `"dev"` for OSS (setup.rs:620-624). This is inherited upstream debt; the spec does not change it.

**Tarball layout requirement:** The install script searches `find … -name 'oz*' ! -name '*.tar.gz'` to locate the executable, then renames it to `{binary_name}` (`warp-oss` for OSS) at install. So the binary inside the tarball must be named `oz` (not `warp-oss`). The `! -name '*.tar.gz'` guard also prevents matching orphaned `oz-upload-{uuid}.tar.gz` files if any exist in the temp dir.

**Cache path on Linux (OSS build):**
```
~/.cache/Warp-Oss/remote-server/tarballs/unversioned/linux-x86_64/oz.tar.gz
```
(`cache_dir()` → `~/.cache/Warp-Oss/` on Linux via `directories::ProjectDirs` with app name `"Warp-Oss"`)

**Orphaned upload tarballs:** On SCP upload success followed by install-script failure, `oz-upload-{uuid}.tar.gz` is left in `~/.warp-dev/remote-server/` on the remote. Each retry adds another UUID copy. The spec accepts this; clean up manually with `rm ~/.warp-dev/remote-server/oz-upload-*.tar.gz` if needed.

**Security / trust model:** Neither the SCP path nor the GitHub download path performs a checksum or signature check on the tarball — `is_valid_cached_tarball()` only verifies `len > 0`. Transport integrity on the Phase 2 GitHub download is provided by HTTPS only. The threat model is: you control the GitHub repo (only you can push release assets) and the remote hosts are your own servers (only you can SSH in). No third-party CDN is involved. This is acceptable for a single-operator fork; a future hardening step could add a `oz-linux-x86_64.tar.gz.sha256` release asset and verify before SCP upload.

---

## Target environment

- Remote servers: Linux x86_64, Ubuntu 24.04 (confirmed via `apps@client-apps`)
- Local machine: Linux x86_64 — no cross-compilation needed
- Access: Tailscale/Tailnet (`ssh apps@client-apps` already works)

---

## Phase 1 — Local staging script (no code changes)

**What:** A shell script that builds the release binary, packages it correctly, and stages it at the cache path. Run once after any build that changes the binary.

**New file:** `script/stage-remote-server.sh`

```bash
#!/usr/bin/env bash
# Packages warp-oss as the remote-server daemon tarball and stages it at the
# local SCP-fallback cache path so Warpinator can upload it when SSHing into
# a remote host without a Warp account or CDN access.
#
# OSS channel only — targets linux-x86_64 (the channel's binary_name is
# "warp-oss" and remote_server_dir() returns ".warp-dev"; see setup.rs:349).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="$REPO_ROOT/target/release/warp-oss"
CACHE_DIR="$HOME/.cache/Warp-Oss/remote-server/tarballs/unversioned/linux-x86_64"
CACHE_PATH="$CACHE_DIR/oz.tar.gz"

if [ ! -f "$BINARY" ]; then
  echo "error: $BINARY not found — run 'cargo build --release --bin warp-oss --features gui' first" >&2
  exit 1
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cp "$BINARY" "$TMPDIR/oz"
# strip is a size optimization (~950MB debug → ~50MB release+stripped).
# It is safe on a dynamically-linked Rust binary and does not affect --version.
# Guard: if strip is not installed, proceed without it (binary is larger but functional).
if command -v strip >/dev/null 2>&1; then
  strip "$TMPDIR/oz"
else
  echo "warning: strip not found — binary will be larger" >&2
fi
tar czf "$TMPDIR/oz.tar.gz" -C "$TMPDIR" oz

mkdir -p "$CACHE_DIR"
mv "$TMPDIR/oz.tar.gz" "$CACHE_PATH"

SIZE="$(du -sh "$CACHE_PATH" 2>/dev/null | cut -f1 || stat -c%s "$CACHE_PATH")"
echo "Staged remote-server tarball at $CACHE_PATH ($SIZE)"
echo "NOTE: if a daemon is already running on a remote, kill it first (pkill warp-oss) so Warpinator picks up the new binary on reconnect."
```

**After running this once**, every `ssh apps@client-apps` in Warpinator:
1. Tries server-side download → fails (remote can't reach `127.0.0.1:8787`)
2. SCP fallback finds the staged tarball → uploads over SSH (timeout: 240s; large binaries over slow DERP relays may time out) → installs to `~/.warp-dev/remote-server/warp-oss` → post-install `--version` verification runs
3. Daemon starts (or existing daemon reused via flock/PID), Project Explorer shows remote file tree, editor opens remote files

**To update the daemon binary on an already-connected host:** run `stage-remote-server.sh` again, then on the remote: `pkill warp-oss`. Reconnect — Warpinator detects the binary is missing and reinstalls.

---

## Phase 2 — GitHub Releases as CDN

**Why:** Eliminates the manual staging step. On any fresh Warpinator install (no cached tarball), the SCP fallback auto-downloads from GitHub Releases instead of failing.

### 2a. Rust change: override `download_tarball_url()` for OSS

**File:** `crates/remote_server/src/setup.rs`

In `download_tarball_url()`, add an OSS arm before the existing format string. GitHub Releases uses static filenames, not query parameters:

```rust
pub fn download_tarball_url(platform: &RemotePlatform) -> String {
    // warpinator: for OSS builds, serve tarballs from GitHub Releases instead
    // of the Warp CDN (which requires an account and uses query-string routing
    // that GitHub's asset URLs don't support).
    if matches!(ChannelState::channel(), Channel::Oss) {
        return format!(
            "https://github.com/TheophilusChinomona/warpinator/releases/latest/download/oz-{}-{}.tar.gz",
            platform.os.as_str(),
            platform.arch.as_str()
        );
    }
    format!(
        "{}?package=tar&os={}&arch={}&channel={}{}",
        download_url(),
        platform.os.as_str(),
        platform.arch.as_str(),
        download_channel(),
        version_query(),
    )
}
```

This function is only called by `cached_remote_server_tarball()` in `scp_fallback.rs` when the local cache is empty. The install script on the remote still tries our bridge URL (and fails), SCP fallback still kicks in, but now it auto-populates the cache from GitHub rather than hard-failing.

### 2b. GitHub Actions release workflow

**File:** `.github/workflows/warpinator-release.yml` — a **new, separate workflow file** (not a job added to `warpinator.yml`). GitHub Actions triggers are workflow-level; existing jobs inside `warpinator.yml` cannot have independent `on: tags:` triggers. A separate file is the correct approach.

Triggered on: `push: tags: ['v*-warpinator']`

Steps:
1. Checkout + cache + install deps (mirrors `warpinator.yml` build environment)
2. Pin runner to `ubuntu-24.04` — **not** `ubuntu-latest`. The target remote (Ubuntu 24.04, glibc 2.39) must match the build runner's glibc. If `ubuntu-latest` rolls to 26.04 (glibc 2.40+), a dynamically-linked binary built there will fail on Ubuntu 24.04 remotes with `GLIBC_2.xx not found` — surfacing as a post-install `--version` failure with no clear diagnosis.
3. Build: `cargo build --release --bin warp-oss --features gui`
4. Package: `strip target/release/warp-oss && cp target/release/warp-oss oz && tar czf oz-linux-x86_64.tar.gz oz`
5. Create GitHub Release and upload `oz-linux-x86_64.tar.gz` via `softprops/action-gh-release`

**Release asset naming:** `oz-linux-x86_64.tar.gz` — matches the `oz-{os}-{arch}.tar.gz` pattern in the Rust override above.

**Tagging convention:** `v0.YYYY.MM.DD-warpinator` — distinct from Warp's release tags, safe to push to the fork.

**`releases/latest/download/` note:** Using `latest` means the SCP fallback always downloads the newest release, regardless of what client version is running. This is consistent with `REMOTE_SERVER_ARTIFACT_VERSION_UNPINNED` (OSS is deliberately unpinned) but means protocol skew is possible if a very old client connects after a new release. Acceptable for a single-maintainer fork where both sides are updated together.

---

## End-to-end flow after Phase 2

```
Tag push v0.2026.06.18-warpinator
  → GHA (ubuntu-24.04 runner) builds + strips warp-oss
  → packages oz-linux-x86_64.tar.gz
  → uploads to GitHub Release

User SSHs: ssh apps@client-apps in Warpinator
  → install script runs on remote, curl fails (can't reach 127.0.0.1:8787)
  → SCP fallback checks ~/.cache/Warp-Oss/remote-server/tarballs/unversioned/linux-x86_64/oz.tar.gz
    → cache empty: downloads from https://github.com/TheophilusChinomona/warpinator/releases/latest/download/oz-linux-x86_64.tar.gz → caches
    → cache hit: uses existing cached tarball
  → SCP uploads tarball over SSH (timeout: 240s)
  → extracts, installs as ~/.warp-dev/remote-server/warp-oss on remote
  → post-install: warp-oss --version (must succeed; glibc must match)
  → daemon starts (setsid; survives disconnect), speaks protobuf-over-stdio
  → Project Explorer: remote file tree ✓
  → Editor: open + edit remote files ✓

Binary update flow:
  → push new tag → GHA uploads new release asset
  → on remote: pkill warp-oss
  → delete local cache OR wait — SCP fallback re-downloads when cache is stale/missing
  → reconnect → reinstalls new binary → daemon restarts
```

---

## Testing plan

**Phase 1 (local, immediate):**
1. Build release binary: `cargo build --release --bin warp-oss --features gui`
2. Run `script/stage-remote-server.sh` — confirm output shows tarball at cache path
3. Launch Warpinator, open a new tab, type `ssh apps@client-apps`
4. Verify: Project Explorer shows remote file tree, open a file in the editor, edit + save

**Phase 2 (post-tag):**
1. Push a `v0.YYYY.MM.DD-warpinator` tag
2. Verify GHA job completes and `oz-linux-x86_64.tar.gz` appears on the GitHub Release
3. Delete local cache (`rm ~/.cache/Warp-Oss/remote-server/tarballs/unversioned/linux-x86_64/oz.tar.gz`)
4. SSH again — verify tarball is re-downloaded from GitHub and feature still works

---

## Files changed

| File | Change |
|------|--------|
| `script/stage-remote-server.sh` | New — local staging script (Phase 1) |
| `crates/remote_server/src/setup.rs` | 8-line change to `download_tarball_url()` for OSS (Phase 2) |
| `.github/workflows/warpinator-release.yml` | New workflow triggered on `v*-warpinator` tag push; separate from `warpinator.yml` because GHA triggers are workflow-level (Phase 2) |

No UI changes. No bridge changes. No new Rust crates.

---

## Deferred

- **aarch64 support:** Add `oz-linux-aarch64.tar.gz` to the release job if ARM servers are needed later. No code change — the Rust URL pattern already handles arch dynamically.
- **macOS remote:** Same mechanism works; add a macOS GHA runner + `oz-macos-aarch64.tar.gz` asset.
