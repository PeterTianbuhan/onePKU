#!/usr/bin/env bash
set -euo pipefail

# One local installation; build products are never the daily launch target.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
MODE="${1:---verify}"
case "$MODE" in run|--verify|--build-only|--install-only) ;; *) echo "usage: $0 [run|--verify|--build-only|--install-only]" >&2; exit 2;; esac
[[ "$(uname -s)" == Darwin ]] || { echo "This installer is for macOS." >&2; exit 1; }
APP_SOURCE="$ROOT_DIR/target/release/bundle/macos/OnePKU.app"
APP_DEST="$HOME/Applications/OnePKU.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

if [[ "$MODE" != --install-only ]]; then
  [[ -d node_modules ]] || npm ci
  npm run tauri -- build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
  # Record the exact local source without publishing a GitHub release.
  python3 - "$APP_SOURCE" <<'PY'
import datetime, json, pathlib, subprocess, sys
out = pathlib.Path(sys.argv[1]) / 'Contents/Resources/onepku-build.json'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({
    'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'])),
    'builtAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'distribution': 'local',
}, indent=2) + '\n')
PY
  codesign --force --deep --sign - "$APP_SOURCE"
fi
codesign --verify --deep --strict "$APP_SOURCE"
[[ "$MODE" == --build-only ]] && exit 0

if pgrep -x onepku >/dev/null; then
  osascript -e 'tell application id "me.petertian.onepku" to quit'
  for _ in {1..20}; do pgrep -x onepku >/dev/null || break; sleep 0.25; done
  if pgrep -x onepku >/dev/null; then
    echo "OnePKU is still running; finish saving and close it before installing." >&2
    exit 1
  fi
fi
mkdir -p "$HOME/Applications"
STAGE="$(mktemp -d "$HOME/Applications/.onepku-install.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP_SOURCE" "$STAGE/OnePKU.app"
codesign --verify --deep --strict "$STAGE/OnePKU.app"
if [[ -d "$APP_DEST" ]]; then
  mv "$APP_DEST" "$STAGE/previous.app"
fi
if ! mv "$STAGE/OnePKU.app" "$APP_DEST"; then
  [[ ! -d "$STAGE/previous.app" ]] || mv "$STAGE/previous.app" "$APP_DEST"
  exit 1
fi
"$LSREGISTER" -u "$APP_SOURCE" || true
"$LSREGISTER" -f "$APP_DEST"
# Keep only the installed app; build products are reproducible.
cmp "$APP_SOURCE/Contents/MacOS/onepku" "$APP_DEST/Contents/MacOS/onepku"
rm -rf "$APP_SOURCE"
open "$APP_DEST"
if [[ "$MODE" == --verify || "$MODE" == --install-only ]]; then
  sleep 2
  pgrep -x onepku >/dev/null
fi
echo "Installed and opened: $APP_DEST"
