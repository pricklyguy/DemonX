#!/usr/bin/env bash
# Wait for the DemonX server to answer, then open it in a browser window.
# Used by the login autostart entry; safe to run by hand too.
URL="${DEMONX_URL:-http://localhost:8080}"
HOSTPORT="${URL#*://}"; HOSTPORT="${HOSTPORT%%/*}"
HOST="${HOSTPORT%%:*}"; PORT="${HOSTPORT##*:}"; [ "$PORT" = "$HOSTPORT" ] && PORT=80

# Wait up to 2 minutes for the server (PM2 starts it at boot, possibly a bit after login).
for _ in $(seq 1 120); do
  if (exec 3<>"/dev/tcp/$HOST/$PORT") 2>/dev/null; then break; fi
  sleep 1
done

for b in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$b" >/dev/null 2>&1; then
    # --app: a clean window with no tabs or address bar
    exec "$b" --app="$URL" --start-maximized --no-first-run
  fi
done
if command -v firefox >/dev/null 2>&1; then exec firefox "$URL"; fi
echo "No supported browser found (tried Chrome, Chromium, Firefox)" >&2
exit 1
