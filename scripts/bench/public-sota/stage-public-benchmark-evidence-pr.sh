#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_DEFAULT="$(git -C "${SCRIPT_DIR}/../../.." rev-parse --show-toplevel 2>/dev/null || (cd "${SCRIPT_DIR}/../../.." && pwd))"
REPO_ROOT="${REPO_ROOT:-${REPO_ROOT_DEFAULT}}"
TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"

benchmark="${1:-}"
if [[ -z "${benchmark}" ]]; then
  echo "Usage: $0 <amemgym|longmemeval|locomo|beam|memoryagentbench|membench|personamem> [run-id]" >&2
  exit 2
fi

case "${benchmark}" in
  amemgym|longmemeval|locomo|beam|memoryagentbench|membench|personamem) ;;
  *)
    echo "Unsupported benchmark: ${benchmark}" >&2
    exit 2
    ;;
esac

run_id="${2:-}"
EVIDENCE_ROOT="${EVIDENCE_ROOT:-${TMP_ROOT}/remnic-public-benchmark-evidence}"
RESULTS_ROOT="${RESULTS_ROOT:-${HOME}/.remnic/bench/results}"
BASE_BRANCH="${BASE_BRANCH:-bench/public-matrix-codex}"
BRANCH="${BRANCH:-codex/publish-${benchmark}-sota-bf9b264}"
WORKTREE="${WORKTREE:-${TMP_ROOT}/remnic-${benchmark}-sota-pr}"
VERIFY_TEMPLATE="${SCRIPT_DIR}/verify-public-generic-sota-evidence.template.mjs"
DOC_GENERATOR="${SCRIPT_DIR}/generate-public-benchmark-evidence-doc.mjs"
VERIFY_SCRIPT_REL="scripts/bench/verify-public-${benchmark}-sota-evidence.mjs"

if [[ -z "${run_id}" ]]; then
  run_id="$(find "${EVIDENCE_ROOT}" -maxdepth 1 -type d -name "public-${benchmark}-codex-*" -print 2>/dev/null | sort | tail -1 | xargs basename 2>/dev/null || true)"
fi

if [[ -z "${run_id}" ]]; then
  run_id="$(find "${RESULTS_ROOT}" -maxdepth 1 -type d -name "public-${benchmark}-codex-*" -print 2>/dev/null | sort | tail -1 | xargs basename 2>/dev/null || true)"
fi

if [[ -z "${run_id}" ]]; then
  echo "waiting: no run id found for ${benchmark}" >&2
  exit 0
fi

SOURCE_EVIDENCE_DIR="${EVIDENCE_ROOT}/${run_id}"
RESULTS_REL="docs/benchmarks/results/${run_id}"
EVIDENCE_DOC_REL="${EVIDENCE_DOC_REL:-docs/benchmarks/evidence/${benchmark}-gpt-5.5-sota-2026-05.md}"

required=(
  "${SOURCE_EVIDENCE_DIR}/MANIFEST.${benchmark}.json"
  "${SOURCE_EVIDENCE_DIR}/${benchmark}-diagnostics-summary.json"
  "${SOURCE_EVIDENCE_DIR}/${benchmark}-sota-comparison.json"
  "${SOURCE_EVIDENCE_DIR}/current-target-map.json"
)

for file in "${required[@]}"; do
  if [[ ! -f "${file}" ]]; then
    echo "waiting: verified ${benchmark} evidence is missing ${file}" >&2
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
' "${SOURCE_EVIDENCE_DIR}/MANIFEST.${benchmark}.json" || true)"
if [[ -z "${artifact_rel}" ]]; then
  echo "waiting: ${benchmark} manifest does not name a safe public artifact path" >&2
  exit 0
fi
artifact_path="${SOURCE_EVIDENCE_DIR}/${artifact_rel}"
if [[ ! -f "${artifact_path}" ]]; then
  echo "waiting: ${benchmark} public-safe artifact is missing from ${artifact_path}" >&2
  exit 0
fi

PACKAGED_TARGET_MAP="${SOURCE_EVIDENCE_DIR}/current-target-map.json"
node "${SCRIPT_DIR}/verify-public-benchmark-sota-evidence.mjs" "${SOURCE_EVIDENCE_DIR}" "${PACKAGED_TARGET_MAP}" "${benchmark}"

git -C "${REPO_ROOT}" worktree prune

if [[ -e "${WORKTREE}" ]]; then
  current_branch="$(git -C "${WORKTREE}" branch --show-current)"
  if [[ "${current_branch}" != "${BRANCH}" ]]; then
    echo "error: ${WORKTREE} exists on ${current_branch}, expected ${BRANCH}" >&2
    exit 2
  fi
  git -C "${WORKTREE}" status --short --untracked-files=all
else
  if git -C "${REPO_ROOT}" ls-remote --exit-code --heads origin "${BRANCH}" >/dev/null 2>&1; then
    git -C "${REPO_ROOT}" fetch origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
    git -C "${REPO_ROOT}" worktree add -B "${BRANCH}" "${WORKTREE}" "origin/${BRANCH}"
  else
    git -C "${REPO_ROOT}" fetch origin "+refs/heads/${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}"
    git -C "${REPO_ROOT}" worktree add -B "${BRANCH}" "${WORKTREE}" "origin/${BASE_BRANCH}"
  fi
fi

mkdir -p "${WORKTREE}/${RESULTS_REL}" "${WORKTREE}/$(dirname "${EVIDENCE_DOC_REL}")" "${WORKTREE}/scripts/bench"

cp "${SOURCE_EVIDENCE_DIR}/MANIFEST.${benchmark}.json" "${WORKTREE}/${RESULTS_REL}/"
cp "${SOURCE_EVIDENCE_DIR}/${benchmark}-diagnostics-summary.json" "${WORKTREE}/${RESULTS_REL}/"
cp "${SOURCE_EVIDENCE_DIR}/${benchmark}-sota-comparison.json" "${WORKTREE}/${RESULTS_REL}/"
cp "${PACKAGED_TARGET_MAP}" "${WORKTREE}/${RESULTS_REL}/"
cp "${artifact_path}" "${WORKTREE}/${RESULTS_REL}/"
cp "${VERIFY_TEMPLATE}" "${WORKTREE}/${VERIFY_SCRIPT_REL}"
node "${DOC_GENERATOR}" \
  --evidence-dir "${SOURCE_EVIDENCE_DIR}" \
  --benchmark "${benchmark}" \
  --out "${WORKTREE}/${EVIDENCE_DOC_REL}"

(
  cd "${WORKTREE}"
  node "${VERIFY_SCRIPT_REL}" "${RESULTS_REL}" "${benchmark}"
  PATH=/opt/homebrew/bin:/opt/homebrew/sbin:${PATH} npx tsx scripts/bench/verify-public-matrix.ts \
    --results-dir "${RESULTS_REL}" \
    --manifest "${RESULTS_REL}/MANIFEST.${benchmark}.json" \
    --benchmarks "${benchmark}" \
    --skip-git \
    --no-diagnostics
  gitleaks detect --source . --no-git --redact --exit-code 1
  git status --short --untracked-files=all
)

echo "ready: ${benchmark} evidence PR worktree staged at ${WORKTREE} on ${BRANCH}"
