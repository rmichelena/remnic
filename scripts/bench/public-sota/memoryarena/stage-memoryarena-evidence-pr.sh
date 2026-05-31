#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/gh/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_SOTA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT_DEFAULT="$(git -C "${SCRIPT_DIR}/../../../.." rev-parse --show-toplevel 2>/dev/null || (cd "${SCRIPT_DIR}/../../../.." && pwd))"
REPO_ROOT="${REPO_ROOT:-${REPO_ROOT_DEFAULT}}"
TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"

RUN_ID="${RUN_ID:-public-matrix-codex-bf9b2643-20260515T052919Z}"
EVIDENCE_ROOT="${EVIDENCE_ROOT:-${TMP_ROOT}/remnic-memoryarena-evidence}"
SOURCE_EVIDENCE_DIR="${SOURCE_EVIDENCE_DIR:-${EVIDENCE_ROOT}/${RUN_ID}}"
BASE_BRANCH="${BASE_BRANCH:-bench/public-matrix-codex}"
RUN_BRANCH_SUFFIX="$(printf '%s' "${RUN_ID}" | sed -E 's/^public-.*-codex-([[:alnum:]]+)-[0-9]{8}T[0-9]{6}Z$/\1/')"
if [[ "${RUN_BRANCH_SUFFIX}" == "${RUN_ID}" ]]; then
  RUN_BRANCH_SUFFIX="bf9b264"
fi
BRANCH="${BRANCH:-codex/publish-memoryarena-sota-${RUN_BRANCH_SUFFIX}}"
WORKTREE="${WORKTREE:-${TMP_ROOT}/remnic-memoryarena-sota-pr}"
RESULTS_REL="docs/benchmarks/results/${RUN_ID}"
EVIDENCE_DOC_REL="${EVIDENCE_DOC_REL:-docs/benchmarks/evidence/memory-arena-gpt-5.5-sota-2026-05.md}"
VERIFY_TEMPLATE="${SCRIPT_DIR}/verify-public-memoryarena-sota-evidence.template.mjs"
VERIFY_CORE_SCRIPT="${SCRIPT_DIR}/verify-memoryarena-sota-evidence.mjs"
COMPARE_MODULE="${SCRIPT_DIR}/compare-memoryarena-sota.mjs"
DERIVE_MODULE="${SCRIPT_DIR}/derive-memoryarena-official-metrics.mjs"
COMPARISON_JSON_MODULE="${PUBLIC_SOTA_DIR}/comparison-json.mjs"
INTEGRITY_MODULE="${PUBLIC_SOTA_DIR}/evidence-integrity.mjs"
EVIDENCE_RUN_UTILS_MODULE="${PUBLIC_SOTA_DIR}/evidence-run-utils.mjs"
DOC_GENERATOR="${SCRIPT_DIR}/generate-memoryarena-evidence-doc.mjs"
VERIFY_SCRIPT_REL="scripts/bench/verify-public-memoryarena-sota-evidence.mjs"
MEMORYARENA_MODULE_DIR_REL="scripts/bench/memoryarena"
COMPARISON_JSON_MODULE_REL="scripts/bench/comparison-json.mjs"
INTEGRITY_MODULE_REL="scripts/bench/evidence-integrity.mjs"
EVIDENCE_RUN_UTILS_MODULE_REL="scripts/bench/evidence-run-utils.mjs"

required=(
  "${SOURCE_EVIDENCE_DIR}/MANIFEST.memory-arena.json"
  "${SOURCE_EVIDENCE_DIR}/memory-arena-diagnostics-summary.json"
  "${SOURCE_EVIDENCE_DIR}/memory-arena-sota-comparison.json"
  "${SOURCE_EVIDENCE_DIR}/current-target-map.json"
)

for file in "${required[@]}"; do
  if [[ ! -f "${file}" ]]; then
    echo "waiting: verified MemoryArena evidence is missing ${file}" >&2
    exit 0
  fi
done

artifact_rel="$(node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const artifactPath = manifest.publicArtifacts?.[0]?.path;
if (typeof artifactPath !== "string" || artifactPath.length === 0 || artifactPath.startsWith("/") || artifactPath.split(/[\\/]+/).includes("..")) {
  process.exit(1);
}
process.stdout.write(artifactPath);
' "${SOURCE_EVIDENCE_DIR}/MANIFEST.memory-arena.json" || true)"
if [[ -z "${artifact_rel}" ]]; then
  echo "waiting: MemoryArena manifest does not name a safe public artifact path" >&2
  exit 0
fi
artifact_path="${SOURCE_EVIDENCE_DIR}/${artifact_rel}"
if [[ ! -f "${artifact_path}" ]]; then
  echo "waiting: MemoryArena public-safe artifact is missing from ${artifact_path}" >&2
  exit 0
fi

PACKAGED_TARGET_MAP="${SOURCE_EVIDENCE_DIR}/current-target-map.json"
node "${SCRIPT_DIR}/verify-memoryarena-sota-evidence.mjs" "${SOURCE_EVIDENCE_DIR}" "${PACKAGED_TARGET_MAP}"

git -C "${REPO_ROOT}" worktree prune

if [[ -e "${WORKTREE}" ]]; then
  current_branch="$(git -C "${WORKTREE}" branch --show-current)"
  if [[ "${current_branch}" != "${BRANCH}" ]]; then
    echo "error: ${WORKTREE} exists on ${current_branch}, expected ${BRANCH}" >&2
    exit 2
  fi
  git -C "${REPO_ROOT}" fetch origin "+refs/heads/${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}"
  git -C "${WORKTREE}" reset --hard "origin/${BASE_BRANCH}"
  git -C "${WORKTREE}" clean -fd
else
  git -C "${REPO_ROOT}" fetch origin "+refs/heads/${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}"
  git -C "${REPO_ROOT}" worktree add -B "${BRANCH}" "${WORKTREE}" "origin/${BASE_BRANCH}"
fi

(
  cd "${WORKTREE}"
  find docs/benchmarks/results -mindepth 1 -maxdepth 1 -type d -name 'public-matrix-codex-*' ! -name "${RUN_ID}" -exec rm -rf {} + 2>/dev/null || true
  rm -f "${EVIDENCE_DOC_REL}" "${VERIFY_SCRIPT_REL}" "${COMPARISON_JSON_MODULE_REL}" "${INTEGRITY_MODULE_REL}" "${EVIDENCE_RUN_UTILS_MODULE_REL}"
  rm -rf "${MEMORYARENA_MODULE_DIR_REL}"
)

mkdir -p "${WORKTREE}/${RESULTS_REL}" "${WORKTREE}/$(dirname "${EVIDENCE_DOC_REL}")" "${WORKTREE}/scripts/bench"
mkdir -p "${WORKTREE}/${MEMORYARENA_MODULE_DIR_REL}"

cp "${SOURCE_EVIDENCE_DIR}/MANIFEST.memory-arena.json" "${WORKTREE}/${RESULTS_REL}/"
cp "${SOURCE_EVIDENCE_DIR}/memory-arena-diagnostics-summary.json" "${WORKTREE}/${RESULTS_REL}/"
cp "${SOURCE_EVIDENCE_DIR}/memory-arena-sota-comparison.json" "${WORKTREE}/${RESULTS_REL}/"
cp "${PACKAGED_TARGET_MAP}" "${WORKTREE}/${RESULTS_REL}/"
cp "${artifact_path}" "${WORKTREE}/${RESULTS_REL}/"
cp "${VERIFY_TEMPLATE}" "${WORKTREE}/${VERIFY_SCRIPT_REL}"
cp "${VERIFY_CORE_SCRIPT}" "${WORKTREE}/${MEMORYARENA_MODULE_DIR_REL}/verify-memoryarena-sota-evidence.mjs"
cp "${COMPARE_MODULE}" "${WORKTREE}/${MEMORYARENA_MODULE_DIR_REL}/compare-memoryarena-sota.mjs"
cp "${DERIVE_MODULE}" "${WORKTREE}/${MEMORYARENA_MODULE_DIR_REL}/derive-memoryarena-official-metrics.mjs"
cp "${COMPARISON_JSON_MODULE}" "${WORKTREE}/${COMPARISON_JSON_MODULE_REL}"
cp "${INTEGRITY_MODULE}" "${WORKTREE}/${INTEGRITY_MODULE_REL}"
cp "${EVIDENCE_RUN_UTILS_MODULE}" "${WORKTREE}/${EVIDENCE_RUN_UTILS_MODULE_REL}"
node "${DOC_GENERATOR}" \
  --evidence-dir "${SOURCE_EVIDENCE_DIR}" \
  --out "${WORKTREE}/${EVIDENCE_DOC_REL}"

(
  cd "${WORKTREE}"
  node "${VERIFY_SCRIPT_REL}" "${RESULTS_REL}"
  PATH=/opt/homebrew/opt/gh/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${PATH} npx tsx scripts/bench/verify-public-matrix.ts \
    --results-dir "${RESULTS_REL}" \
    --manifest "${RESULTS_REL}/MANIFEST.memory-arena.json" \
    --benchmarks memory-arena \
    --skip-git \
    --no-diagnostics
  gitleaks detect --source . --no-git --redact --exit-code 1
)

staged_status="$(git -C "${WORKTREE}" status --porcelain --untracked-files=all)"
if [[ -z "${staged_status}" ]]; then
  echo "done: MemoryArena evidence already present on ${BASE_BRANCH}; no PR staging changes"
  exit 0
fi
printf '%s\n' "${staged_status}"

echo "ready: MemoryArena evidence PR worktree staged at ${WORKTREE} on ${BRANCH}"
