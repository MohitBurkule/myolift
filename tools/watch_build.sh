#!/usr/bin/env bash
# Build (and sign, if a debug certificate is set up) the MyoLift lite-wearable watch app on Linux
# with Huawei's Command Line Tools. Then copy the .hap to the phone over USB for DevEco Assistant.
#
#   tools/watch_build.sh                # build unsigned .hap (checks the project compiles)
#   tools/watch_build.sh --sign         # build signed .hap (needs the files in $SIGN_DIR, see watch/lite-wearable/README.md)
#   tools/watch_build.sh --sign --copy  # ...and copy it to the phone's Download/MyoLift over USB (MTP)
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT=watch/lite-wearable
CLI=${HUAWEI_CLI:-$HOME/src/huawei-cli/command-line-tools}
JDK=${JAVA_HOME:-$(ls -d "$HOME"/src/jdk/jdk-17* 2>/dev/null | head -1)}
SIGN_DIR=${SIGN_DIR:-$HOME/.config/myolift-watch-sign}
SIGN=0; COPY=0
for a in "$@"; do case "$a" in --sign) SIGN=1 ;; --copy) COPY=1 ;; *) echo "unknown option $a"; exit 2 ;; esac; done

[ -x "$CLI/bin/hvigorw" ] || { echo "Huawei Command Line Tools not found at $CLI (set HUAWEI_CLI)"; exit 1; }
[ -x "$JDK/bin/java" ] || { echo "JDK 17 not found (set JAVA_HOME; a portable one lives in ~/src/jdk)"; exit 1; }
export JAVA_HOME="$JDK" PATH="$JDK/bin:$CLI/bin:$CLI/tool/node/bin:$PATH" DEVECO_SDK_HOME="$CLI/sdk"

PROFILE="$PROJECT/build-profile.json5"
cp "$PROFILE" "$PROFILE.bak"
trap 'mv -f "$PROFILE.bak" "$PROFILE"' EXIT
if [ "$SIGN" = 1 ]; then
  # $SIGN_DIR/sign.env: STORE_PASSWORD=… KEY_ALIAS=… KEY_PASSWORD=…  (plus debug.p12, debug.cer, debug.p7b next to it)
  for f in debug.p12 debug.cer debug.p7b sign.env; do [ -f "$SIGN_DIR/$f" ] || { echo "missing $SIGN_DIR/$f (see watch/lite-wearable/README.md)"; exit 1; }; done
  # shellcheck disable=SC1091
  . "$SIGN_DIR/sign.env"
  python3 - "$PROFILE" "$SIGN_DIR" "$STORE_PASSWORD" "$KEY_ALIAS" "$KEY_PASSWORD" <<'EOF'
import re, sys
p, d, sp, alias, kp = sys.argv[1:]
s = open(p).read()
cfg = f'''"signingConfigs": [{{ "name": "default", "type": "HarmonyOS", "material": {{
      "storeFile": "{d}/debug.p12", "storePassword": "{sp}", "keyAlias": "{alias}", "keyPassword": "{kp}",
      "certpath": "{d}/debug.cer", "profile": "{d}/debug.p7b", "signAlg": "SHA256withECDSA" }} }}]'''
open(p, "w").write(re.sub(r'"signingConfigs":\s*\[\s*\]', cfg, s, count=1))
EOF
fi

( cd "$PROJECT" && hvigorw assembleHap --no-daemon )
HAP=$(ls -t "$PROJECT"/entry/build/default/outputs/default/*.hap | head -1)
echo "built: $HAP"
case "$HAP" in *unsigned*) [ "$SIGN" = 1 ] && { echo "signing did not happen: check the certificate files"; exit 1; } ;; esac

if [ "$COPY" = 1 ]; then
  MTP=$(ls -d /run/user/$(id -u)/gvfs/mtp:host=* 2>/dev/null | head -1)
  [ -n "$MTP" ] || { echo "phone not mounted over USB (set it to File transfer)"; exit 1; }
  DST="$MTP/Internal shared storage/Download/MyoLift"
  mkdir -p "$DST" && cp "$HAP" "$DST/myolift-watch.hap" && echo "copied to phone: Download/MyoLift/myolift-watch.hap"
fi
