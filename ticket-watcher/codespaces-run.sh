#!/usr/bin/env bash
# Starts the virtual screen and the watcher inside a GitHub Codespace.
#   bash codespaces-run.sh         run the watcher (keep this terminal open: its output keeps the codespace awake)
#   bash codespaces-run.sh login   open the Paytm / ticketgenie login window
set -u
cd "$(dirname "$0")"

[ -f .env ] || { echo "Missing .env. Run: bash codespaces-setup.sh"; exit 1; }

export DISPLAY=:99
export HEADLESS=0

pgrep -x Xvfb >/dev/null || { Xvfb :99 -screen 0 1280x900x24 >/tmp/xvfb.log 2>&1 & sleep 2; }
pgrep -x x11vnc >/dev/null || x11vnc -display :99 -nopw -localhost -forever -shared -rfbport 5900 -bg -o /tmp/x11vnc.log >/dev/null 2>&1
pgrep -f "websockify.*6080" >/dev/null || { websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/tmp/novnc.log 2>&1 & }

# Port 6080 stays private: only you, signed in to GitHub, can open it.
if [ -n "${CODESPACE_NAME:-}" ]; then
  VIEW_URL="https://${CODESPACE_NAME}-6080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}/vnc.html?autoconnect=1&resize=scale"
  sed -i "s|^REMOTE_VIEW_URL=.*|REMOTE_VIEW_URL=${VIEW_URL}|" .env
  echo "Live browser: ${VIEW_URL}"
fi

if [ "${1:-}" = "login" ]; then
  exec npm run login
fi

# A line of output every 4 minutes counts as terminal activity and resets the idle timeout.
( while true; do sleep 240; echo "[keepalive] $(date +%T)"; done ) &
KEEPALIVE_PID=$!
trap 'kill $KEEPALIVE_PID 2>/dev/null' EXIT

while true; do
  npm run start-env
  code=$?
  [ "$code" -eq 0 ] && break
  echo "Watcher crashed (exit $code). Restarting in 5s..."
  sleep 5
done
