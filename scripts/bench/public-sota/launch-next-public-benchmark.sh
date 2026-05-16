#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_DEFAULT="$(git -C "${SCRIPT_DIR}/../../.." rev-parse --show-toplevel 2>/dev/null || (cd "${SCRIPT_DIR}/../../.." && pwd))"

REPO_ROOT="${REPO_ROOT:-${REPO_ROOT_DEFAULT}}"
RESULTS_ROOT="${RESULTS_ROOT:-${HOME}/.remnic/bench/results}"
OUT_ROOT="${OUT_ROOT:-${RESULTS_ROOT}}"

active_scoring_session="$(tmux list-sessions -F '#S' 2>/dev/null \
  | grep -E '^public-.*-codex-.*[0-9]{8}T[0-9]{6}Z$' \
  | head -1 || true)"

if [[ -n "${active_scoring_session}" ]]; then
  echo "Refusing to launch: active public benchmark scoring session ${active_scoring_session} is still running." >&2
  exit 3
fi

benchmark="${1:-amemgym}"
case "${benchmark}" in
  amemgym|longmemeval|locomo|beam|memoryagentbench|membench|personamem) ;;
  *)
    echo "Usage: $0 [amemgym|longmemeval|locomo|beam|memoryagentbench|membench|personamem]" >&2
    exit 2
    ;;
esac

if [[ ! -d "${REPO_ROOT}/evals/datasets/${benchmark}" ]]; then
  echo "Dataset missing: ${REPO_ROOT}/evals/datasets/${benchmark}" >&2
  exit 2
fi

short_sha="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
run_id="public-${benchmark}-codex-${short_sha}-${timestamp}"
results_dir="${RESULTS_ROOT}/${run_id}"
out_dir="${OUT_ROOT}/${run_id}"
status_file="${results_dir}/status.tsv"
log_file="${results_dir}/run.log"

mkdir -p "${results_dir}" "${out_dir}"
printf 'benchmark\tstatus\ttimestamp\n' > "${status_file}"
printf '%s\tstart\t%s\n' "${benchmark}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "${status_file}"

cmd=(
  node packages/remnic-cli/bin/remnic.cjs bench published
  --name "${benchmark}"
  --dataset "evals/datasets/${benchmark}"
  --runtime-profile real
  --provider codex-cli
  --model gpt-5.5
  --system-codex-reasoning-effort xhigh
  --judge-provider codex-cli
  --judge-model gpt-5.5
  --judge-codex-reasoning-effort xhigh
  --internal-provider codex-cli
  --internal-model gpt-5.5
  --internal-codex-reasoning-effort xhigh
  --request-timeout 3600000
  --drain-timeout 3600000
  --max-429-wait 86400000
  --seed 1
  --results-dir "${results_dir}"
  --out "${out_dir}"
)

printf -v cmd_quoted '%q ' "${cmd[@]}"
printf -v repo_quoted '%q' "${REPO_ROOT}"
printf -v log_quoted '%q' "${log_file}"
printf -v status_quoted '%q' "${status_file}"
printf -v benchmark_quoted '%q' "${benchmark}"
printf -v run_id_quoted '%q' "${run_id}"
session="${run_id}"
tmux new-session -d -s "${session}" -c "${REPO_ROOT}" \
  "PATH=/opt/homebrew/bin:/opt/homebrew/sbin:\$PATH; export REMNIC_BENCH_RUN_ID=${run_id_quoted}; cd ${repo_quoted}; (${cmd_quoted}) >> ${log_quoted} 2>&1; rc=\$?; if [ \$rc -eq 0 ]; then printf '%s\tsuccess\t%s\n' ${benchmark_quoted} \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" >> ${status_quoted}; else printf '%s\tfail:%s\t%s\n' ${benchmark_quoted} \"\$rc\" \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" >> ${status_quoted}; fi; exit \$rc"

cat <<EOF
launched=${session}
benchmark=${benchmark}
results_dir=${results_dir}
out_dir=${out_dir}
status_file=${status_file}
log_file=${log_file}
EOF
