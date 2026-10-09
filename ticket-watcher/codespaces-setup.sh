#!/usr/bin/env bash
# Runs automatically when the Codespace is created (see .devcontainer/devcontainer.json).
# Can also be run by hand from anywhere:  bash ticket-watcher/codespaces-setup.sh
set -euo pipefail
cd "$(dirname "$0")"

sudo apt-get update
sudo apt-get install -y xvfb x11vnc novnc websockify

npm install
npx playwright install --with-deps chromium

[ -f .env ] || cp .env.example .env

# Random private alert topic, so nobody else can read your alerts
if grep -q '^NTFY_TOPIC=change-me' .env; then
  TOPIC="tg-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed -i "s|^NTFY_TOPIC=.*|NTFY_TOPIC=${TOPIC}|" .env
fi

# Buyer details from Codespaces secrets (BUYER_NAME / BUYER_EMAIL / BUYER_PHONE), if you added them
for key in BUYER_NAME BUYER_EMAIL BUYER_PHONE; do
  value="${!key:-}"
  [ -n "$value" ] && sed -i "s|^${key}=.*|${key}=${value}|" .env
done

TOPIC_NOW=$(grep '^NTFY_TOPIC=' .env | cut -d= -f2-)

cat <<EOF

Setup done.

1. Install the ntfy app on your phone, tap +, and subscribe to this topic:
       ${TOPIC_NOW}
2. Check buyer details:   grep BUYER .env     (fill any blank ones with: nano .env)
3. Log in to Paytm once:  bash codespaces-run.sh login
   Open the PORTS tab, click the globe icon next to port 6080, and log in to ticketgenie and Paytm in that window.
   Close the window when finished; the session is saved in ./profile.
4. Test without paying:   DRY_RUN=1 bash codespaces-run.sh
5. Start for real (keep this terminal open and visible):   bash codespaces-run.sh
EOF
