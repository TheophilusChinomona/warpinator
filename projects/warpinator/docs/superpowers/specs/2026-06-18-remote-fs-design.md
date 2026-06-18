# warpinator — Remote Filesystem (Wave-style) Design

**Date:** 2026-06-18
**Status:** Approved
**Goal:** When you `ssh user@host` inside Warpinator, the Project Explorer, file tree, and editor all work on the remote filesystem — identical to Wave Terminal's experience — with no Warp account required.

---

## Problem

Warpinator shows "Project explorer unavailable — The Project Explorer requires access to your local workspace, which isn't supported in remote sessions." when SSHed into a remote host. The upstream Warp resolves this by auto-downloading a remote-server daemon from their CDN, which requires a Warp account. Warpinator has no account and our local bridge is not Warp's CDN.

---

## How Warp's remote-server mechanism works (and why it works for us)

When you type `ssh user@host` in a Warp/Warpinator terminal session, the client "warpifies" the connection and runs an install sequence on the remote host:

1. **Server-side download (first attempt):** Runs `install_remote_server.sh` on the remote, which tries to `curl {server_root_url}/download/cli?...` — for us that's `http://127.0.0.1:8787/download/cli`. The remote host can't reach the local machine's loopback port, so curl fails with a non-2 exit code.
2. **SCP fallback (automatic):** `scp_fallback::should_try_install()` returns `true` for any exit code that isn't 2 (unsupported arch/OS), so the client falls back to the SCP upload path. It checks `~/.cache/Warp-Oss/remote-server/tarballs/unversioned/linux-x86_64/oz.tar.gz` locally. If that file exists, it uploads it over the existing SSH connection and runs extraction. If that file doesn't exist, it tries to download it from `download_tarball_url()`.
3. **Daemon starts:** The script extracts the tarball, finds the `oz*` binary, installs it as `~/.warp/remote-server/warp-oss` on the remote, and launches `warp-oss remote-server-daemon`. The local client speaks a length-prefixed protobuf-over-SSH-stdio protocol to it.
4. **UI lights up:** `LocalOrRemotePath`, the remote file tree (`remote_host_id`), and `ReadFileContextRequest` (editor open) are already fully wired in Warp's UI — no new UI code needed.

**Key code locations:**
- `app/src/remote_server/ssh_transport/installation.rs` — two-step install: server-side → SCP fallback
- `app/src/remote_server/ssh_transport/installation/scp_fallback.rs` — `cached_remote_server_tarball()` short-circuits to the cached file when it exists
- `crates/remote_server/src/setup.rs:536` — `remote_server_artifact_version()` returns `"unversioned"` for `Channel::Oss`
- `crates/warp_core/src/channel/mod.rs:62` — `cli_command_name()` returns `"warp-oss"` for `Channel::Oss`
- `crates/remote_server/src/setup.rs:642` — `download_tarball_url()` — Phase 2 changes this for OSS

**Tarball layout requirement:** The install script searches for `find … -name 'oz*'` to locate the executable, then renames it to `{binary_name}` (`warp-oss` for OSS) at install. So the binary inside the tarball must be named `oz` (not `warp-oss`).

**Cache path on Linux (OSS build):**
```
~/.cache/Warp-Oss/remote-server/tarballs/unversioned/linux-x86_64/oz.tar.gz
```
(`cache_dir()` → `~/.cache/Warp-Oss/` on Linux via `directories::ProjectDirs` with app name `"Warp-Oss"`)

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
strip "$TMPDIR/oz"
tar czf "$TMPDIR/oz.tar.gz" -C "$TMPDIR" oz

mkdir -p "$CACHE_DIR"
mv "$TMPDIR/oz.tar.gz" "$CACHE_PATH"

echo "Staged remote-server tarball at $CACHE_PATH ($(du -sh "$CACHE_PATH" | cut -f1))"
```

**After running this once**, every `ssh apps@client-apps` in Warpinator:
1. Tries server-side download → fails (remote can't reach `127.0.0.1:8787`)
2. SCP fallback finds the staged tarball → uploads over SSH → installs → daemon starts
3. Project Explorer shows remote file tree; editor opens remote files

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

### 2b. GitHub Actions release job

**File:** `.github/workflows/warpinator.yml` — add a new job triggered on `v*-warpinator` tags

The job reuses the existing build environment from the `build-and-test` job:
1. Checkout + cache + install deps (same as existing job)
2. Build: `cargo build --release --bin warp-oss --features gui`
3. Package: `strip target/release/warp-oss && cp target/release/warp-oss oz && tar czf oz-linux-x86_64.tar.gz oz`
4. Create GitHub Release and upload `oz-linux-x86_64.tar.gz` via `softprops/action-gh-release`

**Release asset naming:** `oz-linux-x86_64.tar.gz` — matches the `oz-{os}-{arch}.tar.gz` pattern in the Rust code above.

**Tagging convention:** `v0.YYYY.MM.DD-warpinator` — distinct from Warp's release tags, safe to push to the fork.

---

## End-to-end flow after Phase 2

```
Tag push v0.2026.06.18-warpinator
  → GHA builds + strips warp-oss
  → packages oz-linux-x86_64.tar.gz
  → uploads to GitHub Release

User SSHs: ssh apps@client-apps in Warpinator
  → install script runs on remote, curl fails (can't reach 127.0.0.1:8787)
  → SCP fallback checks local cache
    → cache empty: downloads oz-linux-x86_64.tar.gz from GitHub Releases → caches
    → cache hit: uses existing cached tarball
  → SCP uploads tarball over SSH
  → installs as ~/.warp/remote-server/warp-oss on remote
  → daemon starts, speaks protobuf-over-stdio
  → Project Explorer: remote file tree ✓
  → Editor: open + edit remote files ✓
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
| `.github/workflows/warpinator.yml` | New release job triggered on `v*-warpinator` tags (Phase 2) |

No UI changes. No bridge changes. No new Rust crates.

---

## Deferred

- **aarch64 support:** Add `oz-linux-aarch64.tar.gz` to the release job if ARM servers are needed later. No code change — the Rust URL pattern already handles arch dynamically.
- **macOS remote:** Same mechanism works; add a macOS GHA runner + `oz-macos-aarch64.tar.gz` asset.
