# warpinator — Remote-FS (VS Code Remote-SSH-style) Phase 0 Spike

**Date:** 2026-06-15
**Question:** Can warpinator browse a remote host's filesystem in the editor/file-tree (like VS Code Remote-SSH / Wave's `wsh`), account-free?
**Answer:** **Yes — leverage Warp's existing remote-server architecture and self-host our own binary.** Feasible; moderate wiring, not a from-scratch build.

## Why it's feasible (de-risked facts)

- **The remote server IS our own binary.** `warp-oss remote-server-daemon` / `remote-server-proxy` are subcommands (`app/src/lib.rs:674-693`). Verified: `warp-oss remote-server-daemon --identity-key X` **starts and runs account-free** (`--api-key` is optional, env `WARP_API_KEY`). We compile the server when we build `warp-oss`.
- **Self-host via SCP-deploy, no Warp CDN.** `cached_remote_server_tarball()` (`app/src/remote_server/ssh_transport/installation/scp_fallback.rs`) **uses a pre-staged tarball if one exists at the cache path** and only downloads otherwise. Staging our tarball there = warp uploads OUR binary to the host over the existing SSH connection (exactly Wave's `wsh` model).
  - Cache path: `cache_dir()/remote-server/tarballs/<version>/<os>-<arch>/oz.tar.gz`
  - `<version>` for OSS = `"unversioned"` (`setup.rs:8,536-538`).
  - `cache_dir()` = `directories` ProjectDirs(qualifier="dev", org="warp", app="WarpOss") cache dir on Linux (`paths.rs:190`). Resolve the literal empirically at impl time (warp logs it).
- **Tarball layout is trivial.** `install_remote_server.sh`: tar contains a binary named `oz*` + an optional `resources/` sibling. **"A tarball without resources is not an error"** → for file browsing we only need the binary (skills/resources optional).
- **No hard auth gate** — falls back to `anonymous_id()` (`auth_context.rs:48-61`).
- **Editor + file-tree remote support already complete** — `LocalOrRemotePath` (Local|Remote), remote-rooted trees with `remote_host_id` (`code/file_tree/view.rs:230-238`), `ReadFileContextRequest` RPC. We don't build the UI.
- **Protocol** = length-prefixed protobuf over SSH stdio (`crates/remote_server/proto/remote_server.proto`, `protocol.rs:68-99`); our binary already speaks it (it's the same code).
- **Trigger** = typing `ssh user@host` in a terminal (warpify). Independent of the removed TMUX flow (#12478) — intact.

## Remaining work (for the plan)

1. **Package & stage:** build `warp-oss` (release/stripped for upload size; debug is ~950MB), tar as `oz.tar.gz` with the binary named `oz`, place at the cache path for `linux-<arch>`. Add a small bridge/script step (or a tiny Rust hook / `WARPINATOR_REMOTE_SERVER_TARBALL` env) so the OSS build reliably uses our local tarball.
2. **OSS-channel wiring:** upstream has a TODO ("figure out how remote server works with warp-oss"); OSS currently maps downloads to the "dev" channel. Ensure the OSS path prefers the SCP-fallback/our staged tarball (since `server_root_url` is the local bridge and won't serve `/download/cli`).
3. **Arch matching:** the staged tarball must match the remote's `os-arch` (most servers = linux-x86_64; cross-compile for arm64 if needed — `script/deploy_remote_server` shows the musl cross pattern).
4. **Verify end-to-end:** `ssh host` in warpinator → tarball uploaded → daemon starts → file-tree browses + editor opens remote files.

## Blocker for end-to-end validation
- **No SSH server on this machine** (`ssh localhost` refused; no `sshd`). Need either `openssh-server` enabled locally (`ssh localhost` — clean, no network/creds) or a real x86_64 Linux remote.
- Full validation also needs the GUI (warpify is triggered + rendered in-app).

*Last updated: 2026-06-15*
