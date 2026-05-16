# Remnic Public SOTA Benchmark Queue

Generated: 2026-05-16

Target map refreshed: 2026-05-16T19:46:38Z. Live AMB-backed target values
were unchanged from the prior snapshot; only `generatedAt` changed.

Active run:

- `memory-arena`
- Results dir: `${HOME}/.remnic/bench/results/public-matrix-codex-bf9b2643-20260515T052919Z`
- Worktree: `<repo-root>`
- Commit: `bf9b264356a537e70fce1bddbca3495bf8a19b31`
- Last checked progress: `1250/4209` tasks (`29.70%`), estimated finish
  `2026-05-18T18:30:31Z`
- Last direct status check: `2026-05-16T19:46:51Z`; diagnostics `12526`
  total, `0` errors, `0` nonzero, `1` in flight. Latest completed diagnostic
  still showed `codex-cli`, `gpt-5.5`, `xhigh`, and `fast`.
- Do not start another full scoring run until this finishes.

Publication branch:

- AMA-Bench evidence PR #1005 merged into `bench/public-matrix-codex`, not
  `main`.
- MemoryArena and later benchmark evidence PRs should branch from and target
  `bench/public-matrix-codex` unless the user redirects the publication branch.
- PR #1005 layout to mirror:
  - `docs/benchmarks/evidence/<benchmark>-...md`
  - `docs/benchmarks/results/<run-id>/<public-safe-artifact>.json`
  - `docs/benchmarks/results/<run-id>/MANIFEST.<benchmark>.json`
  - `docs/benchmarks/results/<run-id>/<benchmark>-diagnostics-summary.json`
  - `scripts/bench/verify-public-<benchmark>-...mjs`

MemoryArena has a prepared self-contained verifier template at
`scripts/bench/public-sota/memoryarena/verify-public-memoryarena-sota-evidence.template.mjs`.
After the real evidence package is generated, copy it into the publication PR as
`scripts/bench/verify-public-memoryarena-sota-evidence.mjs` and run:

```bash
node scripts/bench/verify-public-memoryarena-sota-evidence.mjs \
  docs/benchmarks/results/public-matrix-codex-bf9b2643-20260515T052919Z
```

MemoryArena also has a prepared evidence markdown generator:

```bash
node scripts/bench/public-sota/memoryarena/generate-memoryarena-evidence-doc.mjs \
  --evidence-dir <verified-memoryarena-evidence-dir> \
  --out docs/benchmarks/evidence/memory-arena-gpt-5.5-sota-<date>.md
```

It was syntax-checked and exercised against the diagnostics-backed synthetic
evidence package. The full MemoryArena PR staging helper was also validated
end-to-end against diagnostics-backed synthetic evidence in a throwaway
worktree, including generated evidence doc, self-contained verifier,
public-matrix verifier, and `gitleaks`; the throwaway worktree and branch were
removed afterward.

After `complete-memoryarena-if-ready.sh` reports verified evidence, stage the PR
worktree with:

```bash
bash scripts/bench/public-sota/memoryarena/stage-memoryarena-evidence-pr.sh
```

The staging helper targets `bench/public-matrix-codex`, creates/uses branch
`codex/publish-memoryarena-sota-bf9b264`, copies the verified evidence,
generates the markdown evidence doc, copies the self-contained verifier, then
runs the MemoryArena verifier, public-matrix verifier for `memory-arena`, and
`gitleaks`.

After reviewing the staged diff, publish the PR with:

```bash
bash scripts/bench/public-sota/memoryarena/publish-memoryarena-evidence-pr.sh
```

The publish helper commits, pushes, and opens or updates the MemoryArena
evidence PR. It currently exits `0` with `waiting:` until the staging worktree
exists.

Validated remaining full datasets, ordered by scored task count:

| Order | Benchmark | Dataset | Items | Scored tasks |
| --- | --- | --- | ---: | ---: |
| 1 | `amemgym` | `evals/datasets/amemgym` | 20 | 200 |
| 2 | `longmemeval` | `evals/datasets/longmemeval` | 500 | 500 |
| 3 | `locomo` | `evals/datasets/locomo` | 10 | 1540 |
| 4 | `beam` | `evals/datasets/beam` | 100 | 2000 |
| 5 | `memoryagentbench` | `evals/datasets/memoryagentbench` | 146 | 3671 |
| 6 | `membench` | `evals/datasets/membench` | 5000 | 5000 |
| 7 | `personamem` | `evals/datasets/personamem` | 5000 | 5000 |

Base command template:

```bash
PATH=/opt/homebrew/bin:/opt/homebrew/sbin:$PATH \
node packages/remnic-cli/bin/remnic.cjs bench published \
  --name <benchmark> \
  --dataset evals/datasets/<benchmark> \
  --runtime-profile real \
  --provider codex-cli \
  --model gpt-5.5 \
  --system-codex-reasoning-effort xhigh \
  --judge-provider codex-cli \
  --judge-model gpt-5.5 \
  --judge-codex-reasoning-effort xhigh \
  --internal-provider codex-cli \
  --internal-model gpt-5.5 \
  --internal-codex-reasoning-effort xhigh \
  --request-timeout 3600000 \
  --drain-timeout 3600000 \
  --max-429-wait 86400000 \
  --seed 1 \
  --results-dir ${HOME}/.remnic/bench/results/<run-id> \
  --out ${HOME}/.remnic/bench/results/<run-id>
```

The Remnic `codex-cli` provider injects `--config service_tier="fast"` into
each underlying `codex exec` call and records the observed tier in
`codex-cli-diagnostics/*.json`. Public evidence packagers/verifiers now require
those diagnostics to prove `fast`. The active pipeline health gate also fails
early if the newest completed diagnostic does not report `codex-cli`,
`gpt-5.5`, `xhigh`, and `fast`.

Comparison after each result:

```bash
node scripts/bench/public-sota/compare-public-benchmark-sota.mjs <result.json>
```

Generic evidence packaging after a non-AMA, non-MemoryArena SOTA result:

```bash
bash scripts/bench/public-sota/complete-public-benchmark-if-ready.sh <benchmark> [run-id]
```

The generic completion helper exits `0` with a `waiting:` message until a run
directory and result file exist. Once a result exists, it runs the generic SOTA
comparison, requires SOTA on publishable metrics, packages public evidence, and
runs the generic verifier.

Generic non-MemoryArena evidence docs can be generated with:

```bash
node scripts/bench/public-sota/generate-public-benchmark-evidence-doc.mjs \
  --evidence-dir <verified-evidence-dir> \
  --benchmark <benchmark> \
  --out docs/benchmarks/evidence/<benchmark>-gpt-5.5-sota-<date>.md
```

The generator was syntax-checked and exercised against diagnostics-backed
synthetic AMemGym evidence.

Generic non-MemoryArena evidence PRs also have a prepared self-contained
verifier template:

```bash
cp scripts/bench/public-sota/verify-public-generic-sota-evidence.template.mjs \
  scripts/bench/verify-public-<benchmark>-sota-evidence.mjs
node scripts/bench/verify-public-<benchmark>-sota-evidence.mjs \
  docs/benchmarks/results/<run-id> <benchmark>
```

The template was syntax-checked and exercised against diagnostics-backed
synthetic AMemGym and MemoryAgentBench evidence.

After `complete-public-benchmark-if-ready.sh` reports verified evidence, stage
and publish the PR with:

```bash
bash scripts/bench/public-sota/stage-public-benchmark-evidence-pr.sh <benchmark> [run-id]
bash scripts/bench/public-sota/publish-public-benchmark-evidence-pr.sh <benchmark>
```

The staging helper targets `bench/public-matrix-codex`, creates/uses branch
`codex/publish-<benchmark>-sota-bf9b264`, copies the verified committed
evidence set, generates the markdown evidence doc, copies the self-contained
verifier, then runs the benchmark verifier, public-matrix verifier for that
benchmark, and `gitleaks`. The publish helper commits, pushes, and opens or
updates the PR. Both helpers were syntax-checked and tested in their current
`waiting:` state with `amemgym`. The staging helper also passed an end-to-end
dry run against diagnostics-backed synthetic AMemGym evidence in a throwaway
worktree; the throwaway worktree and branch were removed afterward.

Manual equivalent:

```bash
node scripts/bench/public-sota/package-public-benchmark-evidence.mjs \
  --result <result.json> \
  --results-dir ${HOME}/.remnic/bench/results/<run-id> \
  --dataset-dir <repo-root>/evals/datasets/<benchmark> \
  --repo-root <repo-root> \
  --out-dir <evidence-output-dir>

node scripts/bench/public-sota/verify-public-benchmark-sota-evidence.mjs \
  <evidence-output-dir> \
  scripts/bench/public-sota/current-target-map.json \
  <benchmark>
```

The generic verifier has been syntax-checked and validated against synthetic
result shapes for `amemgym`, `longmemeval`, `locomo`, `beam`, `personamem`,
`memoryagentbench`, and `membench`. It recomputes metric means, checks manifest
and artifact hashes, enforces the public-safe per-task score shape, and
recomputes SOTA comparisons from the public artifact. The packager and verifier
also require codex-cli diagnostics proving `codex-cli`, `gpt-5.5`, `xhigh`, and
`fast`; evidence generation fails if those diagnostics are missing, in-flight,
errored, nonzero, or mixed. The diagnostics-backed path has been revalidated
against synthetic completed diagnostics for all seven generic benchmark shapes.
Publish helpers are idempotent around existing PRs: if a worktree is clean after
a prior push, the helper verifies the existing PR instead of treating the clean
worktree as proof of success. Publish and transition watchers now wait/retry on
transient PR-clean failures so the queue does not stop permanently while checks
are still settling.

Guarded launch after MemoryArena finishes:

```bash
bash scripts/bench/public-sota/launch-next-public-benchmark.sh amemgym
bash scripts/bench/public-sota/start-run-monitor.sh <results-dir-from-launch-output>
```

The launcher exits with code `3` if the active MemoryArena tmux session still
exists, so it is safe to probe but must not be bypassed.

MemoryArena-specific comparison and packaging:

```bash
node scripts/bench/public-sota/check-active-public-run.mjs | jq '{progress, memoryArenaResultFiles, diagnostics:{total:.diagnostics.total, errors:.diagnostics.errors, nonzero:.diagnostics.nonzero, inFlight:.diagnostics.inFlight}}'
bash scripts/bench/public-sota/memoryarena/complete-memoryarena-if-ready.sh
```

The completion helper exits `0` with a `waiting:` message while the tmux session
is still running and no `memory-arena-*.json` exists. Once a result file appears,
it runs the comparison, requires SOTA on all checked metrics, packages evidence,
and runs the MemoryArena verifier.

Manual equivalent:

```bash
node scripts/bench/public-sota/memoryarena/compare-memoryarena-sota.mjs <memory-arena-result.json>
node scripts/bench/public-sota/memoryarena/package-memoryarena-evidence.mjs \
  --result <memory-arena-result.json> \
  --results-dir ${HOME}/.remnic/bench/results/public-matrix-codex-bf9b2643-20260515T052919Z \
  --dataset-dir <repo-root>/evals/datasets/memory-arena \
  --repo-root <repo-root> \
  --out-dir <evidence-output-dir>

node scripts/bench/public-sota/memoryarena/verify-memoryarena-sota-evidence.mjs \
  <evidence-output-dir> \
  scripts/bench/public-sota/current-target-map.json
```

The MemoryArena packager/verifier has also been package/verify tested after
diagnostics hardening with a synthetic completed diagnostics record.

Notes:

- Dry-run validation passed for all listed datasets.
- PersonaMem has 5000 CSV data rows. Physical line count is much higher because quoted fields contain newlines.
- MemoryAgentBench comparator now derives the paper Table 3 score directly:
  ten dataset-level official metrics are averaged into AR/TTL/LRU/SF category
  averages, then the four category averages are averaged into the official
  overall score. The synthetic Table 3 evidence path has been package/verify
  tested.
