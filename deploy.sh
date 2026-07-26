#!/data/data/com.termux/files/usr/bin/bash
#
# Pull the latest Tag and restart the service (Termux + tmux).
# Run from the phone:  ~/tag/deploy.sh
#
set -euo pipefail

cd "$(dirname "$0")"            # project dir, wherever it was cloned
SESSION="tag"

echo "→ pulling latest…"
before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)

# Only re-download modules when they actually changed. `go build` would fetch them
# anyway, but doing it here surfaces a bad go.sum before we touch the running server.
if ! git diff --quiet "$before" "$after" -- server/go.mod server/go.sum; then
  echo "→ modules changed, downloading…"
  ( cd server && go mod download )
else
  echo "→ modules unchanged, skipping download"
fi

# Compile before restarting: if the new code doesn't build, abort here (set -e) and
# leave the currently-running server untouched. run.sh rebuilds too (Go caches, so
# it's instant) — this is just the pre-flight check.
echo "→ building…"
( cd server && go build -o tag-server . )

echo "→ restarting '$SESSION' service…"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" "$(pwd)/run.sh"

echo "✓ deployed ($after). verify: curl -fsS https://app.rgbored.com/health"
