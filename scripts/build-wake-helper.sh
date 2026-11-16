#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
project_dir=${script_dir:h}
helper_dir="$project_dir/src-tauri/wake-helper"
app_dir="$helper_dir/JarvisWakeListener.app"
binary_dir="$app_dir/Contents/MacOS"
signing_identity=${APPLE_SIGNING_IDENTITY:--}

# Some Command Line Tools installs leave two equivalent SwiftBridging maps.
# Hide the legacy copy for this compiler invocation only; never edit the SDK.
typeset -a swift_flags
swift_flags=()
clt_dir=/Library/Developer/CommandLineTools
swift_include="$clt_dir/usr/include/swift"
legacy_map="$swift_include/module.modulemap"
current_map="$swift_include/bridging.modulemap"
if [[ "$(/usr/bin/xcode-select -p)" == "$clt_dir" && -f "$legacy_map" && -f "$current_map" ]] &&
    grep -q '^module SwiftBridging ' "$current_map" &&
    cmp -s <(sed '/^\/\/ Copyright /d' "$legacy_map") <(sed '/^\/\/ Copyright /d' "$current_map"); then
  overlay_dir=$(mktemp -d /tmp/jarvis-swift-overlay.XXXXXXXX)
  trap 'rm -rf -- "$overlay_dir"' EXIT
  : > "$overlay_dir/empty.modulemap"
  cat > "$overlay_dir/overlay.json" <<EOF
{"version":0,"roots":[{"type":"file","name":"$legacy_map","external-contents":"$overlay_dir/empty.modulemap"}]}
EOF
  swift_flags+=(-Xcc -ivfsoverlay -Xcc "$overlay_dir/overlay.json")
fi

mkdir -p "$binary_dir"
cp "$helper_dir/Info.plist" "$app_dir/Contents/Info.plist"
/usr/bin/swiftc \
  "${swift_flags[@]}" \
  -O \
  -framework AppKit \
  -framework AVFoundation \
  -framework Speech \
  "$helper_dir/JarvisWakeListener.swift" \
  -o "$binary_dir/JarvisWakeListener"
/usr/bin/codesign \
  --force \
  --options runtime \
  --entitlements "$helper_dir/Entitlements.plist" \
  --sign "$signing_identity" \
  "$app_dir"
