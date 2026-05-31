#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/gh/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PREVIOUS="${1:-}"
NEXT="${2:-}"
if [[ -z "${PREVIOUS}" || -z "${NEXT}" ]]; then
  echo "Usage: $0 <previous-benchmark> <next-benchmark>" >&2
  exit 2
fi

case "${PREVIOUS}:${NEXT}" in
  amemgym:longmemeval|longmemeval:locomo|locomo:beam|beam:memoryagentbench|memoryagentbench:membench|membench:personamem) ;;
  *)
    echo "Unsupported transition: ${PREVIOUS} -> ${NEXT}" >&2
    exit 2
    ;;
esac

REPO="${REPO:-$(git -C "${SCRIPT_DIR}/../../.." remote get-url origin | sed -E 's#.*github.com[:/]([^/]+/[^/.]+)(\.git)?$#\1#')}"
BASE_BRANCH="${BASE_BRANCH:-bench/public-matrix-codex}"
PREVIOUS_BRANCH="${PREVIOUS_BRANCH:-}"
PREVIOUS_BRANCH_PREFIX="${PREVIOUS_BRANCH_PREFIX:-codex/publish-${PREVIOUS}-sota-}"
PREVIOUS_WATCHER="${PREVIOUS_WATCHER:-remnic-${PREVIOUS}-publish-watcher}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-1800}"
LOG_ROOT="${LOG_ROOT:-${HOME}/.remnic/bench/results}"
LOG_FILE="${LOG_FILE:-${LOG_ROOT}/watch-${PREVIOUS}-to-${NEXT}.log}"
LOCK_DIR="${LOCK_DIR:-/tmp/remnic-${PREVIOUS}-to-${NEXT}-watcher.lock}"

mkdir -p "$(dirname "${LOG_FILE}")"

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "watcher already running: ${LOCK_DIR}" >&2
  exit 0
fi
trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${LOG_FILE}"
}

while :; do
  if tmux has-session -t "${PREVIOUS_WATCHER}" 2>/dev/null; then
    log "waiting: ${PREVIOUS} publish watcher ${PREVIOUS_WATCHER} is still running"
    sleep "${INTERVAL_SECONDS}"
    continue
  fi

  if [[ -n "${PREVIOUS_BRANCH}" ]]; then
    pr_number="$(gh pr list \
      --repo "${REPO}" \
      --head "${PREVIOUS_BRANCH}" \
      --base "${BASE_BRANCH}" \
      --state all \
      --json number,state \
      --jq 'map(select(.state == "OPEN" or .state == "MERGED")) | sort_by(.number) | reverse | .[0].number // empty')"
    branch_label="${PREVIOUS_BRANCH}"
  else
    pr_number="$(gh pr list \
      --repo "${REPO}" \
      --base "${BASE_BRANCH}" \
      --state all \
      --limit 100 \
      --json number,state,headRefName \
      --jq "map(select((.state == \"OPEN\" or .state == \"MERGED\") and (.headRefName | startswith(\"${PREVIOUS_BRANCH_PREFIX}\")))) | sort_by(.number) | reverse | .[0].number // empty")"
    branch_label="${PREVIOUS_BRANCH_PREFIX}*"
  fi

  if [[ -z "${pr_number}" ]]; then
    log "waiting: no ${PREVIOUS} evidence PR found for ${branch_label} -> ${BASE_BRANCH}"
    sleep "${INTERVAL_SECONDS}"
    continue
  fi

  set +e
  clean_output="$(node "${SCRIPT_DIR}/verify-pr-clean.mjs" \
    --repo "${REPO}" \
    --pr "${pr_number}" \
    --wait-seconds 1800 2>&1)"
  clean_status=$?
  set -e
  if [[ -n "${clean_output}" ]]; then
    while IFS= read -r line; do log "${line}"; done <<< "${clean_output}"
  fi
  if [[ "${clean_status}" -ne 0 ]]; then
    log "waiting: ${PREVIOUS} evidence PR #${pr_number} is not clean yet (verifier exited ${clean_status})"
    sleep "${INTERVAL_SECONDS}"
    continue
  fi

  set +e
  launch_output="$(bash "${SCRIPT_DIR}/launch-next-public-benchmark.sh" "${NEXT}" 2>&1)"
  launch_status=$?
  set -e
  if [[ -n "${launch_output}" ]]; then
    while IFS= read -r line; do log "${line}"; done <<< "${launch_output}"
  fi
  if [[ "${launch_status}" -eq 3 ]]; then
    log "waiting: active public benchmark scoring session blocked ${NEXT} launch; retrying"
    sleep "${INTERVAL_SECONDS}"
    continue
  fi
  if [[ "${launch_status}" -ne 0 ]]; then
    log "stopping: next benchmark launch helper exited ${launch_status}"
    exit "${launch_status}"
  fi

  results_dir="$(printf '%s\n' "${launch_output}" | awk -F= '$1 == "results_dir" { print $2 }')"
  if [[ -z "${results_dir}" ]]; then
    log "error: launch helper did not report results_dir"
    exit 2
  fi

  bash "${SCRIPT_DIR}/start-run-monitor.sh" "${results_dir}" 2>&1 | while IFS= read -r line; do
    log "${line}"
  done

  log "done: ${NEXT} launched after clean ${PREVIOUS} evidence PR"
  exit 0
done
