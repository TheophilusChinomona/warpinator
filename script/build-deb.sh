#!/usr/bin/env bash
# Packages the warp-oss binary as a warpinator_amd64.deb.
# Usage: ./script/build-deb.sh <version>
# Output: warpinator_amd64.deb in the current directory.
set -euo pipefail

VERSION="${1:?usage: $0 <version>}"
BINARY="target/release/warp-oss"

if [ ! -f "$BINARY" ]; then
  echo "error: $BINARY not found — build first" >&2
  exit 1
fi

PKG="warpinator_${VERSION}_amd64"
rm -rf "$PKG"
mkdir -p \
  "$PKG/DEBIAN" \
  "$PKG/usr/lib/warpinator" \
  "$PKG/usr/bin" \
  "$PKG/usr/share/applications" \
  "$PKG/usr/share/doc/warpinator"

# ── Binary ────────────────────────────────────────────────────────────────────
cp "$BINARY" "$PKG/usr/lib/warpinator/warp-oss"
chmod 755 "$PKG/usr/lib/warpinator/warp-oss"

# ── Launcher wrapper ──────────────────────────────────────────────────────────
# Writes the /usr/bin/warpinator shell script without heredoc nesting.
WRAPPER="$PKG/usr/bin/warpinator"
printf '%s\n' '#!/bin/bash' > "$WRAPPER"
printf '%s\n' '# Auto-stage the SSH remote-server daemon tarball on first run.' >> "$WRAPPER"
printf '%s\n' 'CACHE_DIR="$HOME/.cache/Warp-Oss/remote-server/tarballs/unversioned/linux-x86_64"' >> "$WRAPPER"
printf '%s\n' 'if [ ! -f "$CACHE_DIR/oz.tar.gz" ]; then' >> "$WRAPPER"
printf '%s\n' '    mkdir -p "$CACHE_DIR"' >> "$WRAPPER"
printf '%s\n' '    _tmp=$(mktemp -d)' >> "$WRAPPER"
printf '%s\n' '    cp /usr/lib/warpinator/warp-oss "$_tmp/oz"' >> "$WRAPPER"
printf '%s\n' '    tar czf "$CACHE_DIR/oz.tar.gz" -C "$_tmp" oz' >> "$WRAPPER"
printf '%s\n' '    rm -rf "$_tmp"' >> "$WRAPPER"
printf '%s\n' 'fi' >> "$WRAPPER"
printf '%s\n' '# Default to OpenGL backend (Intel HD 630/Mesa Vulkan glyph-atlas fix).' >> "$WRAPPER"
printf '%s\n' 'export WGPU_BACKEND="${WGPU_BACKEND:-gl}"' >> "$WRAPPER"
printf '%s\n' 'exec /usr/lib/warpinator/warp-oss "$@"' >> "$WRAPPER"
chmod 755 "$WRAPPER"

# ── .desktop entry ────────────────────────────────────────────────────────────
DESKTOP="$PKG/usr/share/applications/warpinator.desktop"
printf '%s\n' '[Desktop Entry]'                                   > "$DESKTOP"
printf '%s\n' 'Name=Warpinator'                                  >> "$DESKTOP"
printf '%s\n' 'Comment=AI terminal with SSH remote filesystem'   >> "$DESKTOP"
printf '%s\n' 'Exec=warpinator'                                  >> "$DESKTOP"
printf '%s\n' 'Terminal=false'                                   >> "$DESKTOP"
printf '%s\n' 'Type=Application'                                 >> "$DESKTOP"
printf '%s\n' 'Categories=System;TerminalEmulator;'             >> "$DESKTOP"

# ── DEBIAN/control ────────────────────────────────────────────────────────────
CTRL="$PKG/DEBIAN/control"
printf 'Package: warpinator\n'                                   > "$CTRL"
printf 'Version: %s\n' "$VERSION"                               >> "$CTRL"
printf 'Architecture: amd64\n'                                  >> "$CTRL"
printf 'Maintainer: Theophilus Chinomona <hein@speccon.co.za>\n' >> "$CTRL"
printf 'Depends: libssl3, libfontconfig1, libasound2t64\n'      >> "$CTRL"
printf 'Description: Warpinator -- AI terminal with SSH remote filesystem\n' >> "$CTRL"
printf ' Fork of Warp terminal with self-hosted Pi AI backend and Wave Terminal\n' >> "$CTRL"
printf ' parity: Project Explorer and file editing work over SSH without a\n' >> "$CTRL"
printf ' Warp account.\n'                                       >> "$CTRL"

# ── Build .deb ────────────────────────────────────────────────────────────────
dpkg-deb --build "$PKG" warpinator_amd64.deb
SIZE=$(du -sh warpinator_amd64.deb | cut -f1)
echo "Built warpinator_amd64.deb ($SIZE)"
