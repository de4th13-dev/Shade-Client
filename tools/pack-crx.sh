#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${CRX_PRIVATE_KEY:?Set CRX_PRIVATE_KEY to the permanent RSA PEM key}"
if [[ $# != 3 ]]; then echo 'Usage: pack-crx.sh CHROMIUM EXTENSION_DIRECTORY OUTPUT.crx' >&2; exit 2; fi
browser=$1
src=$(realpath "$2")
out=$(realpath -m "$3")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
printf '%s\n' "$CRX_PRIVATE_KEY" > "$tmp/key.pem"
unset CRX_PRIVATE_KEY
openssl rsa -in "$tmp/key.pem" -check -noout >/dev/null
cp -a "$src" "$tmp/extension"
"$browser" --headless --disable-gpu --no-sandbox --user-data-dir="$tmp/profile" \
  --pack-extension="$tmp/extension" --pack-extension-key="$tmp/key.pem"
python3 - "$tmp/extension.crx" <<'PY'
import struct, sys, zipfile
with open(sys.argv[1], 'rb') as f:
    assert f.read(4) == b'Cr24', 'not a CRX file'
    assert struct.unpack('<I', f.read(4))[0] == 3, 'not CRX3'
with zipfile.ZipFile(sys.argv[1]) as z:
    assert 'manifest.json' in z.namelist()
    assert z.testzip() is None
PY
mkdir -p "$(dirname "$out")"
cp "$tmp/extension.crx" "$out"
