#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"

WORKTREE="${WORKTREE:-${TMP_ROOT}/remnic-memoryarena-sota-pr}"
BRANCH="${BRANCH:-codex/publish-memoryarena-sota-bf9b264}"
BASE_BRANCH="${BASE_BRANCH:-bench/public-matrix-codex}"
TITLE="${TITLE:-Publish MemoryArena SOTA evidence}"
BODY_FILE="${BODY_FILE:-${TMP_ROOT}/remnic-memoryarena-pr-body.md}"
REPO="${REPO:-joshuaswarren/remnic}"

if [[ ! -d "${WORKTREE}/.git" && ! -f "${WORKTREE}/.git" ]]; then
  echo "waiting: MemoryArena PR worktree does not exist at ${WORKTREE}" >&2
  exit 0
fi

current_branch="$(git -C "${WORKTREE}" branch --show-current)"
if [[ "${current_branch}" != "${BRANCH}" ]]; then
  echo "error: ${WORKTREE} is on ${current_branch}, expected ${BRANCH}" >&2
  exit 2
fi

if [[ -z "$(git -C "${WORKTREE}" status --porcelain --untracked-files=all)" ]]; then
  existing_pr="$(gh pr list --repo "${REPO}" --head "${BRANCH}" --base "${BASE_BRANCH}" --state all --json number --jq 'sort_by(.number) | reverse | .[0].number // empty')"
  if [[ -z "${existing_pr}" ]]; then
    echo "waiting: no staged or unstaged MemoryArena evidence changes in ${WORKTREE} and no PR exists for ${BRANCH}" >&2
    exit 0
  fi
  gh pr view "${existing_pr}" --repo "${REPO}" --json number,url,state,isDraft,headRefOid,baseRefName
  node "${SCRIPT_DIR}/../verify-pr-clean.mjs" --repo "${REPO}" --pr "${existing_pr}" --wait-seconds 1800
  exit 0
fi

manifest_rel="$(cd "${WORKTREE}" && find docs/benchmarks/results -mindepth 2 -maxdepth 2 -name 'MANIFEST.memory-arena.json' -print | sort | tail -1)"
if [[ -z "${manifest_rel}" ]]; then
  echo "error: staged MemoryArena manifest not found in ${WORKTREE}/docs/benchmarks/results" >&2
  exit 2
fi
results_rel="$(dirname "${manifest_rel}")"
run_id="$(basename "${results_rel}")"

cat > "${BODY_FILE}" <<'BODY'
## Summary

Publishes the completed Remnic MemoryArena full-run SOTA evidence for the
__RUN_ID__ benchmark attempt.

The PR includes:

- public-safe MemoryArena result artifact
- benchmark manifest with raw-result hash and dataset hash
- Codex CLI diagnostics summary proving `codex-cli` / `gpt-5.5` / `xhigh` / `fast`
- official MemoryArena SOTA comparison
- self-contained verifier
- markdown evidence document with reproduction commands

## Verification

```bash
node scripts/bench/verify-public-memoryarena-sota-evidence.mjs \
  __RESULTS_REL__

PATH=/opt/homebrew/bin:/opt/homebrew/sbin:$PATH npx tsx scripts/bench/verify-public-matrix.ts \
  --results-dir __RESULTS_REL__ \
  --manifest __MANIFEST_REL__ \
  --benchmarks memory-arena \
  --skip-git \
  --no-diagnostics

gitleaks detect --source . --no-git --redact --exit-code 1
```
BODY

RUN_ID="${run_id}" RESULTS_REL="${results_rel}" MANIFEST_REL="${manifest_rel}" BODY_FILE="${BODY_FILE}" node --input-type=module -e '
import fs from "node:fs";

const file = process.env.BODY_FILE;
let body = fs.readFileSync(file, "utf8");
for (const [key, value] of Object.entries({
  __RUN_ID__: process.env.RUN_ID,
  __RESULTS_REL__: process.env.RESULTS_REL,
  __MANIFEST_REL__: process.env.MANIFEST_REL,
})) {
  body = body.replaceAll(key, value ?? "");
}
fs.writeFileSync(file, body);
'

(
  cd "${WORKTREE}"
  git add docs/benchmarks/evidence docs/benchmarks/results scripts/bench
  git commit -m "Publish MemoryArena SOTA evidence"
  git push -u origin "${BRANCH}"
)

existing_pr="$(gh pr list --repo "${REPO}" --head "${BRANCH}" --base "${BASE_BRANCH}" --state open --json number --jq '.[0].number // empty')"
if [[ -n "${existing_pr}" ]]; then
  gh pr edit "${existing_pr}" --repo "${REPO}" --title "${TITLE}" --body-file "${BODY_FILE}"
  pr_number="${existing_pr}"
else
  pr_url="$(gh pr create --repo "${REPO}" --base "${BASE_BRANCH}" --head "${BRANCH}" --title "${TITLE}" --body-file "${BODY_FILE}")"
  pr_number="$(basename "${pr_url}")"
fi

gh pr view "${pr_number}" --repo "${REPO}" --json number,url,state,isDraft,headRefOid,baseRefName
node "${SCRIPT_DIR}/../verify-pr-clean.mjs" --repo "${REPO}" --pr "${pr_number}" --wait-seconds 1800
