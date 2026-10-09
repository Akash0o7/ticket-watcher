#!/usr/bin/env bash
# Run on a fresh Ubuntu server (e.g. Oracle Cloud Always Free) from inside the ticket-watcher folder.
# The browser runs on a virtual screen that you can open from your phone to solve a captcha yourself.
set -euo pipefail

if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if [ "$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)" -lt 2000 ] && [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

sudo apt-get update
sudo apt-get install -y xvfb x11vnc novnc websockify

npm install
npx playwright install --with-deps chromium
sudo npm install -g pm2

[ -f .env ] || { cp .env.example .env; echo "Edit .env first (nano .env), then re-run this script."; exit 1; }
[ -d profile ] || { echo "Missing ./profile. Log in on your own computer with 'npm run login', then upload the profile folder here."; exit 1; }

if [ ! -f "$HOME/.vnc-pass" ]; then
  read -r -s -p "Choose a password for the remote browser: " VNC_PW; echo
  x11vnc -storepasswd "$VNC_PW" "$HOME/.vnc-pass"
fi

# Virtual screen :99, VNC on localhost only, noVNC web viewer on localhost:6080
pm2 delete xvfb x11vnc novnc ticket-watcher 2>/dev/null || true
pm2 start "Xvfb :99 -screen 0 1280x900x24" --name xvfb
sleep 2
pm2 start "x11vnc -display :99 -rfbauth $HOME/.vnc-pass -localhost -forever -shared -rfbport 5900" --name x11vnc
pm2 start "websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900" --name novnc

DISPLAY=:99 DRY_RUN=1 HEADLESS=0 npm run start-env || true

DISPLAY=:99 HEADLESS=0 pm2 start "npm run start-env" --name ticket-watcher --time
pm2 save
pm2 startup | tail -n 1 | bash || true

cat <<'EOF'

Running. Logs: pm2 logs ticket-watcher

To reach the live browser from your phone WITHOUT opening any public port:
  1. Install Tailscale (free) on the server and on your phone:  curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
  2. On the server run:  sudo tailscale serve --bg 6080
  3. Your link is  https://<server-name>.<tailnet>.ts.net/vnc.html?autoconnect=1&resize=scale
  4. Put that link in .env as REMOTE_VIEW_URL, then:  pm2 restart ticket-watcher --update-env
EOF
