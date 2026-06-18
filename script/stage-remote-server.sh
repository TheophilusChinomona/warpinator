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
