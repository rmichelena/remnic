#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/gh/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"

benchmark="${1:-}"
run_id="${2:-}"
if [[ -z "${benchmark}" ]]; then
  echo "Usage: $0 <amemgym|longmemeval|locomo|beam|memoryagentbench|membench|personamem>" >&2
  exit 2
fi

case "${benchmark}" in
  amemgym|longmemeval|locomo|beam|memoryagentbench|membench|personamem) ;;
  *)
    echo "Unsupported benchmark: ${benchmark}" >&2
    exit 2
    ;;
esac

WORKTREE="${WORKTREE:-${TMP_ROOT}/remnic-${benchmark}-sota-pr}"
if [[ -z "${run_id}" && ( -d "${WORKTREE}/.git" || -f "${WORKTREE}/.git" ) ]]; then
  current_branch_for_run="$(git -C "${WORKTREE}" branch --show-current)"
  if [[ "${current_branch_for_run}" == codex/publish-"${benchmark}"-sota-* ]]; then
    run_id="${current_branch_for_run##codex/publish-${benchmark}-sota-}"
  fi
fi
RUN_BRANCH_SUFFIX="$(printf '%s' "${run_id}" | sed -E 's/^public-.*-codex-([[:alnum:]]+)-[0-9]{8}T[0-9]{6}Z$/\1/')"
if [[ -z "${RUN_BRANCH_SUFFIX}" || "${RUN_BRANCH_SUFFIX}" == "${run_id}" ]]; then
  RUN_BRANCH_SUFFIX="${run_id:-bf9b264}"
fi
BRANCH="${BRANCH:-codex/publish-${benchmark}-sota-${RUN_BRANCH_SUFFIX}}"
BASE_BRANCH="${BASE_BRANCH:-bench/public-matrix-codex}"
TITLE="${TITLE:-Publish ${benchmark} SOTA evidence}"
BODY_FILE="${BODY_FILE:-${TMP_ROOT}/remnic-${benchmark}-pr-body.md}"
REPO="${REPO:-$(git -C "${SCRIPT_DIR}/../../.." remote get-url origin | sed -E 's#.*github.com[:/]([^/]+/[^/.]+)(\.git)?$#\1#')}"

if [[ ! -d "${WORKTREE}/.git" && ! -f "${WORKTREE}/.git" ]]; then
  echo "waiting: ${benchmark} PR worktree does not exist at ${WORKTREE}" >&2
  exit 0
fi

current_branch="$(git -C "${WORKTREE}" branch --show-current)"
if [[ "${current_branch}" != "${BRANCH}" ]]; then
  echo "error: ${WORKTREE} is on ${current_branch}, expected ${BRANCH}" >&2
  exit 2
fi

cat > "${BODY_FILE}" <<BODY
## Summary

Publishes completed Remnic ${benchmark} full-run SOTA evidence using Codex CLI
\`gpt-5.5\`, reasoning effort \`xhigh\`, and service tier \`fast\`.

The PR includes:

- public-safe ${benchmark} result artifact
- benchmark manifest with raw-result hash and dataset hash
- Codex CLI diagnostics summary proving \`codex-cli\` / \`gpt-5.5\` / \`xhigh\` / \`fast\`
- SOTA comparison
- self-contained verifier
- markdown evidence document with reproduction commands

## Verification

Run the verifier commands shown in the committed evidence document.
BODY

publish_or_update_pr() {
  push_evidence_branch

  existing_pr="$(gh pr list --repo "${REPO}" --head "${BRANCH}" --base "${BASE_BRANCH}" --state open --json number --jq '.[0].number // empty')"
  if [[ -n "${existing_pr}" ]]; then
    gh pr edit "${existing_pr}" --repo "${REPO}" --title "${TITLE}" --body-file "${BODY_FILE}"
    pr_number="${existing_pr}"
  else
    pr_url="$(gh pr create --repo "${REPO}" --base "${BASE_BRANCH}" --head "${BRANCH}" --title "${TITLE}" --body-file "${BODY_FILE}")"
    pr_number="$(basename "${pr_url}")"
  fi

  gh pr view "${pr_number}" --repo "${REPO}" --json number,url,state,isDraft,headRefOid,baseRefName
  node "${SCRIPT_DIR}/verify-pr-clean.mjs" --repo "${REPO}" --pr "${pr_number}" --wait-seconds 1800
}

push_evidence_branch() {
  (
    cd "${WORKTREE}"

    local_head="$(git rev-parse HEAD)"
    remote_head="$(git ls-remote --heads origin "${BRANCH}" | awk 'NR == 1 { print $1 }')"

    if [[ -z "${remote_head}" ]]; then
      git push -u origin "HEAD:refs/heads/${BRANCH}"
      return
    fi

    if [[ "${remote_head}" == "${local_head}" ]]; then
      git push -u origin "HEAD:refs/heads/${BRANCH}"
      return
    fi

    git fetch origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
    if git merge-base --is-ancestor "origin/${BRANCH}" HEAD; then
      git push -u origin "HEAD:refs/heads/${BRANCH}"
    else
      echo "remote ${BRANCH} is not an ancestor of local evidence commit; updating with --force-with-lease" >&2
      git push -u --force-with-lease="refs/heads/${BRANCH}:${remote_head}" origin "HEAD:refs/heads/${BRANCH}"
    fi
  )
}

pr_head_matches_worktree() {
  local pr_number="$1"
  local worktree_head
  local pr_head
  worktree_head="$(git -C "${WORKTREE}" rev-parse HEAD)"
  pr_head="$(gh pr view "${pr_number}" --repo "${REPO}" --json headRefOid --jq '.headRefOid')"
  [[ "${pr_head}" == "${worktree_head}" ]]
}

if [[ -z "$(git -C "${WORKTREE}" status --porcelain --untracked-files=all)" ]]; then
  existing_pr="$(gh pr list --repo "${REPO}" --head "${BRANCH}" --base "${BASE_BRANCH}" --state open --json number --jq 'sort_by(.number) | reverse | .[0].number // empty')"
  if [[ -z "${existing_pr}" ]]; then
    manifest_rel="$(cd "${WORKTREE}" && find docs/benchmarks/results -mindepth 2 -maxdepth 2 -name "MANIFEST.${benchmark}.json" -print 2>/dev/null | sort | tail -1)"
    if [[ -z "${manifest_rel}" ]]; then
      echo "waiting: no staged or unstaged ${benchmark} evidence changes in ${WORKTREE} and no committed evidence manifest exists for ${BRANCH}" >&2
      exit 0
    fi
    echo "resuming: ${benchmark} evidence commit exists on clean ${BRANCH}; pushing and creating PR" >&2
    publish_or_update_pr
    exit 0
  fi
  if ! pr_head_matches_worktree "${existing_pr}"; then
    echo "resuming: ${benchmark} evidence commit on clean ${BRANCH} is newer than PR #${existing_pr}; pushing and creating/updating PR" >&2
    publish_or_update_pr
    exit 0
  fi
  gh pr view "${existing_pr}" --repo "${REPO}" --json number,url,state,isDraft,headRefOid,baseRefName
  node "${SCRIPT_DIR}/verify-pr-clean.mjs" --repo "${REPO}" --pr "${existing_pr}" --wait-seconds 1800
  exit 0
fi

(
  cd "${WORKTREE}"
  git add docs/benchmarks/evidence docs/benchmarks/results scripts/bench
  git commit -m "Publish ${benchmark} SOTA evidence"
)

publish_or_update_pr
