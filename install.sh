#!/usr/bin/env bash
# Installs (or updates) Studio on this Mac:
#
#   curl -fsSL https://raw.githubusercontent.com/jensbjork/studio/main/install.sh | bash
#
# 1. checks that this is a Mac with Apple Silicon and macOS 13 or later,
# 2. installs ffmpeg with Homebrew if it is missing (Studio needs it for frames, sequences and export),
# 3. downloads the latest Studio-mac-arm64.zip from GitHub Releases and puts Studio.app in /Applications
#    (or ~/Applications when /Applications isn't writable), replacing an older Studio,
# 4. opens it.
#
# Downloaded with curl, the app carries no quarantine flag, so macOS opens it without the "can't be verified" stop.
# Nothing else is changed: your library and settings stay where they are.
#
# STUDIO_VERSION=v0.2.0 installs that release instead of the latest. For testing the script itself: STUDIO_ZIP (a local
# zip instead of the download), STUDIO_APPS_DIR (instead of /Applications) and STUDIO_NO_OPEN=1.

set -euo pipefail

REPO="${STUDIO_REPO:-jensbjork/studio}"
VERSION="${STUDIO_VERSION:-latest}"
ASSET="Studio-mac-arm64.zip"

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
fail() {
  printf '\033[31mStudio could not be installed:\033[0m %s\n' "$1" >&2
  exit 1
}

# ── 1. This Mac ───────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Darwin" ] || fail "Studio is a macOS app."
[ "$(uname -m)" = "arm64" ] || fail "Studio needs a Mac with Apple Silicon (M1 or later)."
major="$(sw_vers -productVersion | cut -d. -f1)"
[ "$major" -ge 13 ] || fail "Studio needs macOS 13 or later (this Mac has $(sw_vers -productVersion))."

# ── 2. ffmpeg ─────────────────────────────────────────────────────────────────
if command -v ffmpeg >/dev/null 2>&1 || [ -x /opt/homebrew/bin/ffmpeg ]; then
  say "ffmpeg is installed."
elif command -v brew >/dev/null 2>&1 || [ -x /opt/homebrew/bin/brew ]; then
  say "Installing ffmpeg with Homebrew…"
  "$(command -v brew || echo /opt/homebrew/bin/brew)" install ffmpeg
else
  printf '\033[33mNote:\033[0m ffmpeg is missing. Studio opens without it, but frames, sequences and export need it.\n'
  printf '      Install Homebrew (https://brew.sh), then run: brew install ffmpeg\n'
fi

# ── 3. Studio.app ─────────────────────────────────────────────────────────────
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$ASSET"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [ -n "${STUDIO_ZIP:-}" ]; then
  cp "$STUDIO_ZIP" "$tmp/$ASSET"
else
  say "Downloading Studio ($VERSION)…"
  curl -fL --progress-bar "$url" -o "$tmp/$ASSET" || fail "the download failed ($url)."
fi
ditto -x -k "$tmp/$ASSET" "$tmp/app" || fail "the download couldn't be unpacked."
[ -d "$tmp/app/Studio.app" ] || fail "the download didn't contain Studio.app."

target="${STUDIO_APPS_DIR:-/Applications}"
if [ ! -w "$target" ]; then
  target="$HOME/Applications"
  mkdir -p "$target"
fi

# The Studio being replaced is asked to quit first, if it is running (another copy elsewhere is left alone).
running_here() {
  local pid
  for pid in $(pgrep -x Studio || true); do
    case "$(ps -o command= -p "$pid")" in "$target/Studio.app/"*) return 0 ;; esac
  done
  return 1
}
if running_here; then
  say "Quitting Studio…"
  osascript -e "quit app \"$target/Studio.app\"" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do running_here || break; sleep 1; done
  if running_here; then fail "Studio is still running. Quit it and run the command again."; fi
fi

say "Installing Studio.app in $target…"
rm -rf "$target/Studio.app"
ditto "$tmp/app/Studio.app" "$target/Studio.app"
# In case the zip was fetched some other way: nothing here should be held back by Gatekeeper.
xattr -dr com.apple.quarantine "$target/Studio.app" 2>/dev/null || true

# ── 4. Open ───────────────────────────────────────────────────────────────────
if [ -n "${STUDIO_NO_OPEN:-}" ]; then
  say "Done: $target/Studio.app"
else
  say "Done. Opening Studio."
  open "$target/Studio.app"
fi
