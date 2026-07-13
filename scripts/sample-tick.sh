#!/usr/bin/env bash
# sample-tick.sh — one NAV/metric snapshot for the demand-velocity series.
#
# Runs `watch --once`, which is the ONLY CLI path that persists metric_snapshots
# (insertMetricSnapshot). `loop demand` / `loop brief` only read that series.
#
# Exit-code contract (SPEC004): 0/10/20/30 are normal monitoring outcomes and
# must NOT fail the scheduler. Only tool-error (1) or unexpected codes are
# treated as hard failures (logged; consecutive tool-errors are escalated in
# the log). Sustained indeterminate (20) is counted across ticks for ops review.
#
# Env overrides:
#   WSTDIEM_REPO          repo root (default: parent of scripts/)
#   WSTDIEM_CONFIG        config YAML (default: config.sampling.example.yaml)
#   WSTDIEM_LOG_DIR       log directory (default: ~/.wstdiem/logs)
#   WSTDIEM_STATE_DIR     state directory (default: ~/.wstdiem)
#   WSTDIEM_NODE          node binary (default: node on PATH)
#   WSTDIEM_MAX_LOG_BYTES rotate when log exceeds this (default: 10485760 = 10 MiB)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${WSTDIEM_REPO:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
CONFIG="${WSTDIEM_CONFIG:-${REPO_ROOT}/config.sampling.example.yaml}"
STATE_DIR="${WSTDIEM_STATE_DIR:-${HOME}/.wstdiem}"
LOG_DIR="${WSTDIEM_LOG_DIR:-${STATE_DIR}/logs}"
LOG_FILE="${LOG_DIR}/sample-tick.log"
STATE_FILE="${STATE_DIR}/sample-tick.state"
NODE_BIN="${WSTDIEM_NODE:-node}"
CLI="${REPO_ROOT}/dist/cli/index.js"
MAX_LOG_BYTES="${WSTDIEM_MAX_LOG_BYTES:-10485760}"

mkdir -p "${LOG_DIR}" "${STATE_DIR}"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

rotate_log_if_needed() {
  if [[ -f "${LOG_FILE}" ]]; then
    local size
    size="$(wc -c < "${LOG_FILE}" | tr -d ' ')"
    if [[ "${size}" -gt "${MAX_LOG_BYTES}" ]]; then
      mv "${LOG_FILE}" "${LOG_FILE}.1"
    fi
  fi
}

load_state() {
  consecutive_indeterminate=0
  consecutive_tool_error=0
  if [[ -f "${STATE_FILE}" ]]; then
    # shellcheck disable=SC1090
    source "${STATE_FILE}" || true
  fi
}

save_state() {
  cat > "${STATE_FILE}" <<EOF
consecutive_indeterminate=${consecutive_indeterminate}
consecutive_tool_error=${consecutive_tool_error}
last_exit=${last_exit}
last_run=$(ts)
EOF
}

log() {
  printf '%s %s\n' "$(ts)" "$*" | tee -a "${LOG_FILE}"
}

rotate_log_if_needed
load_state

if [[ ! -f "${CLI}" ]]; then
  log "ERROR: CLI not built at ${CLI} — run: npm run build"
  last_exit=1
  consecutive_tool_error=$((consecutive_tool_error + 1))
  save_state
  # Hard failure: missing build. Exit 1 so launchd/cron can surface it.
  exit 1
fi

if [[ ! -f "${CONFIG}" ]]; then
  log "ERROR: config not found: ${CONFIG}"
  last_exit=1
  consecutive_tool_error=$((consecutive_tool_error + 1))
  save_state
  exit 1
fi

# Ensure durable DB parent exists (sqlite opens the file; dir must exist).
# Path is resolved by the tool via ${HOME} in config; create the conventional dir.
mkdir -p "${HOME}/.wstdiem"

cd "${REPO_ROOT}" || {
  log "ERROR: cannot cd to ${REPO_ROOT}"
  exit 1
}

# Load repo .env for BASE_RPC_URL when present (dotenv also loads it inside node).
if [[ -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/.env"
  set +a
fi

log "BEGIN sample-tick config=${CONFIG} cli=${CLI}"

set +e
# Capture stdout+stderr into the log while still showing on the terminal when interactive.
"${NODE_BIN}" "${CLI}" --config "${CONFIG}" watch --once >>"${LOG_FILE}" 2>&1
rc=$?
set -e

last_exit=${rc}
case ${rc} in
  0)
    consecutive_indeterminate=0
    consecutive_tool_error=0
    log "OK exit=0 nominal (NAV sample written if vault read completed)"
    ;;
  10)
    consecutive_indeterminate=0
    consecutive_tool_error=0
    log "OK exit=10 warn (sample still written; review thresholds)"
    ;;
  20)
    consecutive_indeterminate=$((consecutive_indeterminate + 1))
    consecutive_tool_error=0
    log "INDETERMINATE exit=20 (no/partial vault read this tick; sample may be empty-sentinel). consecutive=${consecutive_indeterminate}"
    if [[ "${consecutive_indeterminate}" -ge 3 ]]; then
      log "ALERT sustained_indeterminate count=${consecutive_indeterminate} — check RPC / BASE_RPC_URL"
    fi
    ;;
  30)
    # watch --once should not emit 30 (vault-liveness only), but log if it ever does.
    consecutive_indeterminate=0
    consecutive_tool_error=0
    log "CRITICAL exit=30 (unexpected for watch --once; investigate)"
    ;;
  1)
    consecutive_tool_error=$((consecutive_tool_error + 1))
    consecutive_indeterminate=0
    log "TOOL_ERROR exit=1 consecutive=${consecutive_tool_error}"
    if [[ "${consecutive_tool_error}" -ge 2 ]]; then
      log "ALERT sustained_tool_error count=${consecutive_tool_error} — fix invocation/build/config"
    fi
    ;;
  *)
    consecutive_tool_error=$((consecutive_tool_error + 1))
    consecutive_indeterminate=0
    log "UNEXPECTED exit=${rc} consecutive_tool_error=${consecutive_tool_error}"
    ;;
esac

save_state
log "END sample-tick exit=${rc}"

# Scheduler-safe: never let 0/10/20/30 kill launchd/cron. Only tool-error /
# unexpected exits return non-zero (and even then launchd keeps the calendar).
case ${rc} in
  0 | 10 | 20 | 30) exit 0 ;;
  *) exit "${rc}" ;;
esac
