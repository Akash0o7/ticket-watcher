#!/usr/bin/env bash
# One-time setup done entirely from a phone, inside a GitHub Codespace.
# It logs you in to ticketgenie in a browser you view on the phone, then uploads
# the saved login and a private alert topic to the repo's GitHub Actions secrets.
set -euo pipefail
cd "$(dirname "$0")"

REPO="Akash0o7/ticket-watcher"
export DISPLAY="${DISPLAY:-:1}"

# The Codespace's built-in token cannot write secrets, so sign in with your own account once
if ! GITHUB_TOKEN= GH_TOKEN= gh auth status >/dev/null 2>&1; then
  echo "Sign in to GitHub (open the link it prints, enter the code):"
  GITHUB_TOKEN= GH_TOKEN= gh auth login -h github.com -s repo -w
fi
gh_user() { GITHUB_TOKEN= GH_TOKEN= gh "$@"; }

TOPIC="tg-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"

echo
echo "STEP 1 of 2: in the PORTS tab, open port 6080 (globe icon)."
echo "A desktop with a browser will appear. Log in to ticketgenie.in there."
echo "Then come back here and press Enter."
echo
node login.mjs

gh_user secret set STORAGE_STATE_B64 --repo "$REPO" < session.b64
gh_user secret set NTFY_TOPIC --repo "$REPO" --body "$TOPIC"

echo
echo "STEP 2 of 2: install the ntfy app on your phone, tap +, and subscribe to this topic:"
echo
echo "    $TOPIC"
echo
echo "Then start the watcher: github.com/$REPO -> Actions -> ticket-watcher -> Run workflow."
