#!/usr/bin/env bash
# Install (or reinstall) the macOS launchd agent for sample-tick every 6h.
# Machine-local: writes ~/Library/LaunchAgents/com.wstdiem.sample-tick.plist
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LABEL="com.wstdiem.sample-tick"
PLIST_SRC="${SCRIPT_DIR}/com.wstdiem.sample-tick.plist.example"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
SAMPLE_TICK="${SCRIPT_DIR}/sample-tick.sh"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS launchd. On Linux use cron — see docs/deployment/monitoring.md" >&2
  exit 1
fi

if [[ ! -f "${PLIST_SRC}" ]]; then
  echo "Missing template: ${PLIST_SRC}" >&2
  exit 1
fi

if [[ ! -x "${SAMPLE_TICK}" ]]; then
  chmod +x "${SAMPLE_TICK}"
fi

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/.wstdiem/logs"

# Substitute absolute paths into the installed plist (not committed).
sed \
  -e "s|__WSTDIEM_SAMPLE_TICK_SH__|${SAMPLE_TICK}|g" \
  -e "s|__WSTDIEM_REPO__|${REPO_ROOT}|g" \
  -e "s|__WSTDIEM_HOME__|${HOME}|g" \
  "${PLIST_SRC}" > "${PLIST_DST}"

# Unload if already present, then bootstrap.
if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
fi

launchctl bootstrap "${DOMAIN}" "${PLIST_DST}"
launchctl enable "${DOMAIN}/${LABEL}"

echo "Installed ${PLIST_DST}"
echo "Label: ${LABEL}"
echo "Schedule: 00:05 06:05 12:05 18:05 local"
echo "Logs: ${HOME}/.wstdiem/logs/sample-tick.log"
echo
echo "Manual tick: ${SAMPLE_TICK}"
echo "Kick once now: launchctl kickstart -k ${DOMAIN}/${LABEL}"
echo "Status: launchctl print ${DOMAIN}/${LABEL} | head -40"
