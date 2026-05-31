#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/gh/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

start_session() {
  local session="$1"
  local command="$2"

  if tmux has-session -t "${session}" 2>/dev/null; then
    echo "already-running=${session}"
    return
  fi

  tmux new-session -d -s "${session}" "${command}"
  echo "started=${session}"
}

publish_benchmarks=(amemgym longmemeval locomo beam memoryagentbench membench personamem)
for benchmark in "${publish_benchmarks[@]}"; do
  printf -v command 'INTERVAL_SECONDS=1800 %q %q' "${SCRIPT_DIR}/watch-public-benchmark-publish.sh" "${benchmark}"
  start_session \
    "remnic-${benchmark}-publish-watcher" \
    "${command}"
done

transitions=(
  "amemgym longmemeval"
  "longmemeval locomo"
  "locomo beam"
  "beam memoryagentbench"
  "memoryagentbench membench"
  "membench personamem"
)

for transition in "${transitions[@]}"; do
  previous="${transition%% *}"
  next="${transition##* }"
  printf -v command 'INTERVAL_SECONDS=1800 %q %q %q' "${SCRIPT_DIR}/watch-next-after-benchmark.sh" "${previous}" "${next}"
  start_session \
    "remnic-${previous}-to-${next}-watcher" \
    "${command}"
done
