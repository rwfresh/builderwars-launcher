#!/usr/bin/env bash
# Renders the app icons from build/icon.svg (the "Prompt Badge", the same mark as builderwars.ai). Run it after changing
# icon.svg, then commit the output:
#   icon.png   512 px: Linux packages and the window icon (electron/main/index.ts)
#   icon.ico   16-256 px: Windows
#   icon.icns  16-1024 px as PNG entries, the way Apple's iconutil writes them: macOS
# Needs rsvg-convert (librsvg), magick (ImageMagick 7) and python3.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for bin in rsvg-convert magick python3; do
  command -v "$bin" >/dev/null || { echo "icons.sh: missing $bin" >&2; exit 1; }
done

for size in 16 24 32 48 64 128 256 512 1024; do
  rsvg-convert -w "$size" -h "$size" "$here/icon.svg" -o "$tmp/$size.png"
done
cp "$tmp/512.png" "$here/icon.png"
magick "$tmp/16.png" "$tmp/24.png" "$tmp/32.png" "$tmp/48.png" "$tmp/64.png" "$tmp/128.png" "$tmp/256.png" "$here/icon.ico"

python3 - "$tmp" "$here/icon.icns" <<'PY'
import struct
import sys

tmp, out = sys.argv[1], sys.argv[2]
# OSType -> pixel size of its PNG. The @2x types (ic10-ic14) hold double-size images of the point size they stand for.
types = [("icp4", 16), ("icp5", 32), ("ic07", 128), ("ic08", 256), ("ic09", 512), ("ic10", 1024),
         ("ic11", 32), ("ic12", 64), ("ic13", 256), ("ic14", 512)]
body = b""
for ostype, size in types:
    with open(f"{tmp}/{size}.png", "rb") as f:
        data = f.read()
    body += ostype.encode("ascii") + struct.pack(">I", len(data) + 8) + data
with open(out, "wb") as f:
    f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)
PY
echo "icons.sh: wrote icon.png, icon.ico and icon.icns"
