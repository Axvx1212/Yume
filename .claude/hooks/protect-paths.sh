#!/usr/bin/env bash
# PreToolUse guard for Yume.
#
# Blocks edits to files whose contents encode hard-won, non-obvious constraints —
# each of these caused a real, user-visible bug when it was wrong, and each looks
# harmless or removable to someone (or some agent) reading it fresh.
#
# This is a speed bump, not a lock: the user can always edit these by hand or
# temporarily disable the hook. It exists so a change here is deliberate.

set -uo pipefail

payload="$(cat)"

# Extract the target path from the tool call (Edit/Write/NotebookEdit).
path="$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$path" ] || exit 0

base="$(basename "$path")"
rel="${path##*/Yumeyomi/}"

deny() {
  # exit 2 = block the call and show this text to the model
  echo "BLOCKED: $rel is protected." >&2
  echo "" >&2
  echo "$1" >&2
  echo "" >&2
  echo "If the change is genuinely intended, tell the user what you want to alter and why," >&2
  echo "and let them make it or lift this guard. Do not work around it." >&2
  exit 2
}

case "$rel" in
  index.html)
    deny "apple-mobile-web-app-status-bar-style MUST stay \"black\".
\"black-translucent\" makes iOS report a viewport ~59px shorter than the screen in
an installed PWA, stranding a dead band at the bottom of every screen. It also
only takes effect on re-install, so the damage is slow to notice.
Verify with: node tests/03-visual.test.js"
    ;;
  nginx.conf|Dockerfile|docker-compose.yml)
    deny "Deployment config encodes two footguns already paid for:
  · nginx's resolver does NOT read /etc/hosts, so proxy_pass must use the
    envsubst-substituted \${YUME_UPSTREAM} literal, not a variable.
  · localhost resolves to ::1 in nginx:alpine while nginx listens on IPv4,
    so the healthcheck must use 127.0.0.1.
Suwayomi also runs inside gluetun's network namespace and has no DNS name of
its own — it is reachable only via host.docker.internal."
    ;;
esac

# Reader and stylesheet: allow edits, but flag the load-bearing parts.
if [ "$rel" = "js/views/reader.js" ] || [ "$rel" = "css/style.css" ]; then
  echo "NOTE: $rel contains load-bearing details that look removable:" >&2
  echo "  · no full-bleed tap overlay (one made the reader unscrollable)" >&2
  echo "  · no border-top on .page (it drew a seam through webtoon art)" >&2
  echo "  · orphaned images must have src cleared, not just be flagged" >&2
  echo "  · .app is position:fixed so it can't inherit a short height" >&2
  echo "Run: node tests/run.cjs   after changing either." >&2
fi

exit 0
