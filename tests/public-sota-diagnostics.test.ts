import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

const CODEX_PROVIDER = {
  provider: "codex-cli",
  model: "gpt-5.5",
  reasoningEffort: "xhigh",
};

const RUN_ID = "public-sota-diagnostics-test";
const STARTED_AT = "2026-05-16T00:00:00.000Z";
const FINISHED_AT = "2026-05-16T00:01:00.000Z";

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256String(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

async function createRunDirs(prefix: string): Promise<{
  root: string;
  datasetDir: string;
  diagnosticsDir: string;
  outDir: string;
  resultsDir: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const datasetDir = path.join(root, "dataset");
  const resultsDir = path.join(root, RUN_ID);
  const diagnosticsDir = path.join(resultsDir, "codex-cli-diagnostics");
  const outDir = path.join(root, "out");
  const datasetFixture = "{}\n";
  await mkdir(datasetDir, { recursive: true });
  await mkdir(diagnosticsDir, { recursive: true });
  await writeFile(path.join(datasetDir, "fixture.json"), datasetFixture, "utf8");
  return { root, datasetDir, diagnosticsDir, outDir, resultsDir };
}

async function writeBaseManifest(
  resultsDir: string,
  benchmark: string,
  resultPath: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const datasetFile = {
    path: "fixture.json",
    kind: "file",
    sizeBytes: Buffer.byteLength("{}\n", "utf8"),
    sha256: sha256String("{}\n"),
  };
  const dataset = {
    benchmark,
    status: "hashed",
    fileCount: 1,
    totalBytes: datasetFile.sizeBytes,
    sha256: sha256String(stableStringify([datasetFile])),
    files: [datasetFile],
    ...overrides,
  };
  const rawResult = JSON.parse(await readFile(resultPath, "utf8"));
  const resultBody = await readFile(resultPath);
  const resultEntry = {
    path: path.relative(resultsDir, resultPath).split(path.sep).join("/"),
    sha256: createHash("sha256").update(resultBody).digest("hex"),
    sizeBytes: resultBody.byteLength,
    resultId: rawResult.meta.id,
    benchmark,
    mode: rawResult.meta.mode,
    gitSha: rawResult.meta.gitSha,
    runCount: rawResult.meta.runCount,
    seeds: rawResult.meta.seeds,
    taskCount: rawResult.results.tasks.length,
    configHash: sha256String(stableStringify(rawResult.config)),
  };
  await writeJson(path.join(resultsDir, "MANIFEST.json"), {
    schemaVersion: 1,
    run: {
      id: RUN_ID,
      selectedBenchmarks: [benchmark],
      runtimeProfiles: ["real"],
    },
    datasets: [dataset],
    results: [resultEntry],
  });
}

async function writeDiagnostics(diagnosticsDir: string): Promise<void> {
  await writeJson(path.join(diagnosticsDir, "valid.json"), {
    runId: RUN_ID,
    startedAt: "2026-05-16T00:00:10.000Z",
    finishedAt: "2026-05-16T00:00:20.000Z",
    provider: "codex-cli",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    serviceTier: "fast",
    result: { status: 0 },
  });
  await writeJson(path.join(diagnosticsDir, "invalid-started-at.json"), {
    runId: RUN_ID,
    finishedAt: "2026-05-16T00:00:30.000Z",
    provider: "codex-cli",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    serviceTier: "fast",
    result: { status: 0 },
  });
}

async function assertRejectsInvalidDiagnostics(
  script: string,
  args: string[],
): Promise<void> {
  await assert.rejects(
    execFileAsync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    }),
    (error: unknown) => {
      assert(error && typeof error === "object");
      const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
      assert.match(output, /diagnostics must have zero invalid timestamps/);
      return true;
    },
  );
}

async function assertRejectsDatasetDrift(
  script: string,
  args: string[],
  benchmark: string,
): Promise<void> {
  await assert.rejects(
    execFileAsync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    }),
    (error: unknown) => {
      assert(error && typeof error === "object");
      const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
      assert.match(output, new RegExp(`dataset hash for ${benchmark} does not match the run manifest`));
      return true;
    },
  );
}

async function assertRejectsRawResultDrift(
  script: string,
  args: string[],
): Promise<void> {
  await assert.rejects(
    execFileAsync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    }),
    (error: unknown) => {
      assert(error && typeof error === "object");
      const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
      assert.match(output, /raw result sha256 .* does not match the run manifest/);
      return true;
    },
  );
}

async function writeAmemGymResult(resultPath: string): Promise<void> {
  await writeJson(resultPath, {
    meta: {
      id: "amemgym-test-result",
      benchmark: "amemgym",
      mode: "full",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      remnicVersion: "test",
      runCount: 1,
      seeds: [1],
      timestamp: FINISHED_AT,
    },
    config: {
      runtimeProfile: "real",
      systemProvider: CODEX_PROVIDER,
      judgeProvider: CODEX_PROVIDER,
      internalProvider: CODEX_PROVIDER,
      remnicConfig: {},
    },
    environment: {
      nodeVersion: process.version,
      os: process.platform,
      hardware: process.arch,
    },
    results: {
      aggregates: {
        normalized_memory_score: { mean: 1 },
      },
      tasks: [
        {
          taskId: "profile-q1",
          details: { profileId: "profile", questionIndex: 1 },
          scores: { normalized_memory_score: 1 },
        },
      ],
    },
  });
}

async function writeMemoryArenaResult(resultPath: string): Promise<void> {
  await writeJson(resultPath, {
    meta: {
      id: "memory-arena-test-result",
      benchmark: "memory-arena",
      mode: "full",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      remnicVersion: "test",
      runCount: 1,
      seeds: [1],
      timestamp: FINISHED_AT,
    },
    config: {
      runtimeProfile: "real",
      systemProvider: CODEX_PROVIDER,
      judgeProvider: CODEX_PROVIDER,
      internalProvider: CODEX_PROVIDER,
      remnicConfig: {},
    },
    environment: {
      nodeVersion: process.version,
      os: process.platform,
      hardware: process.arch,
    },
    results: {
      aggregates: {
        process_score: { mean: 1 },
      },
      tasks: [
        memoryArenaTask("bundled_shopping", 1),
        memoryArenaTask("group_travel_planner", 2, { plan_field_recall: 1 }),
        memoryArenaTask("progressive_search", 3),
        memoryArenaTask("formal_reasoning_math", 4),
        memoryArenaTask("formal_reasoning_phys", 5),
      ],
    },
  });
}

test("generic public SOTA packager rejects diagnostics with invalid timestamps", async () => {
  const dirs = await createRunDirs("remnic-public-sota-generic-");
  try {
    await writeDiagnostics(dirs.diagnosticsDir);
    await writeFile(
      path.join(dirs.resultsDir, "status.tsv"),
      `benchmark\tstatus\ttimestamp\namemgym\tstart\t${STARTED_AT}\namemgym\tsuccess\t${FINISHED_AT}\n`,
      "utf8",
    );
    const resultPath = path.join(dirs.resultsDir, "amemgym-result.json");
    await writeAmemGymResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "amemgym", resultPath);

    await assertRejectsInvalidDiagnostics(
      path.join("scripts", "bench", "public-sota", "package-public-benchmark-evidence.mjs"),
      [
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("MemoryArena public SOTA packager rejects diagnostics with invalid timestamps", async () => {
  const dirs = await createRunDirs("remnic-public-sota-memoryarena-");
  try {
    await writeDiagnostics(dirs.diagnosticsDir);
    await writeFile(
      path.join(dirs.resultsDir, "status.tsv"),
      `benchmark\tstatus\ttimestamp\nmemory-arena\tstart\t${STARTED_AT}\nmemory-arena\tsuccess\t${FINISHED_AT}\n`,
      "utf8",
    );
    const resultPath = path.join(dirs.resultsDir, "memory-arena-result.json");
    await writeMemoryArenaResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "memory-arena", resultPath);

    await assertRejectsInvalidDiagnostics(
      path.join("scripts", "bench", "public-sota", "memoryarena", "package-memoryarena-evidence.mjs"),
      [
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("generic public SOTA packager rejects dataset drift from the run manifest", async () => {
  const dirs = await createRunDirs("remnic-public-sota-generic-dataset-");
  try {
    const resultPath = path.join(dirs.resultsDir, "amemgym-result.json");
    await writeAmemGymResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "amemgym", resultPath, { sha256: "different-dataset-hash" });

    await assertRejectsDatasetDrift(
      path.join("scripts", "bench", "public-sota", "package-public-benchmark-evidence.mjs"),
      [
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
      "amemgym",
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("MemoryArena public SOTA packager rejects dataset drift from the run manifest", async () => {
  const dirs = await createRunDirs("remnic-public-sota-memoryarena-dataset-");
  try {
    const resultPath = path.join(dirs.resultsDir, "memory-arena-result.json");
    await writeMemoryArenaResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "memory-arena", resultPath, { sha256: "different-dataset-hash" });

    await assertRejectsDatasetDrift(
      path.join("scripts", "bench", "public-sota", "memoryarena", "package-memoryarena-evidence.mjs"),
      [
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
      "memory-arena",
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("generic public SOTA packager rejects raw result drift from the run manifest", async () => {
  const dirs = await createRunDirs("remnic-public-sota-generic-result-");
  try {
    const resultPath = path.join(dirs.resultsDir, "amemgym-result.json");
    await writeAmemGymResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "amemgym", resultPath);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    result.meta.id = "amemgym-drifted-result";
    await writeJson(resultPath, result);

    await assertRejectsRawResultDrift(
      path.join("scripts", "bench", "public-sota", "package-public-benchmark-evidence.mjs"),
      [
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("MemoryArena public SOTA packager rejects raw result drift from the run manifest", async () => {
  const dirs = await createRunDirs("remnic-public-sota-memoryarena-result-");
  try {
    const resultPath = path.join(dirs.resultsDir, "memory-arena-result.json");
    await writeMemoryArenaResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "memory-arena", resultPath);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    result.meta.id = "memory-arena-drifted-result";
    await writeJson(resultPath, result);

    await assertRejectsRawResultDrift(
      path.join("scripts", "bench", "public-sota", "memoryarena", "package-memoryarena-evidence.mjs"),
      [
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("public SOTA publish helpers resume clean committed branches without a PR", async () => {
  const generic = await readFile(
    path.join("scripts", "bench", "public-sota", "publish-public-benchmark-evidence-pr.sh"),
    "utf8",
  );
  const memoryArena = await readFile(
    path.join("scripts", "bench", "public-sota", "memoryarena", "publish-memoryarena-evidence-pr.sh"),
    "utf8",
  );

  for (const [label, source] of [
    ["generic", generic],
    ["memoryarena", memoryArena],
  ] as const) {
    assert.match(source, /resuming: .*evidence commit exists on clean .*\$\{BRANCH\}; pushing and creating PR/);
    assert.match(source, /pr_head_matches_worktree\(\)/);
    assert.match(source, /gh pr view "\$\{pr_number\}" --repo "\$\{REPO\}" --json headRefOid --jq '\.headRefOid'/);
    assert.match(source, /evidence commit on clean \$\{BRANCH\} is newer than PR #\$\{existing_pr\}/);
    assert.match(source, /publish_or_update_pr\(\)/);
    assert.doesNotMatch(
      source,
      new RegExp(`if \\[\\[ -z "\\$\\{existing_pr\\}" \\]\\]; then\\n\\s*echo "waiting: no staged or unstaged ${label === "generic" ? "\\$\\{benchmark\\}" : "MemoryArena"} evidence changes[^\\n]+and no PR exists`),
    );
  }
});

test("public benchmark publish watcher does not baseline completed successes", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "watch-public-benchmark-publish.sh"),
    "utf8",
  );

  assert.match(source, /status_file="\$\{RESULTS_ROOT\}\/\$\{run_id\}\/status\.tsv"/);
  assert.match(source, /awk -F '\\t' -v benchmark="\$\{BENCHMARK\}" '\$1 == benchmark && \$2 == "success"/);
  assert.match(source, /return 1[\s\S]*return 0/);
});

test("public SOTA completion audit aligns MemoryAgentBench target freshness with comparison metrics", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "audit-public-sota-completion.mjs"),
    "utf8",
  );

  assert.match(source, /function expectedComparisonTargets\(benchmark, checks = \[\]\)/);
  assert.match(source, /const comparisonMetrics = new Set\(checks\.map\(\(check\) => check\.metric\)\)/);
  assert.match(source, /comparisonMetrics\.has\('memoryagentbench_overall_score'\)/);
  assert.match(source, /comparisonMetrics\.has\('memoryagentbench_table3_overall_score'\)/);
  assert.match(source, /expectedComparisonTargets\(item\.benchmark, comparison\.checks \?\? \[\]\)/);
});

test("chained public benchmark watcher retries active-session launch collisions", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "watch-next-after-benchmark.sh"),
    "utf8",
  );

  assert.match(source, /if \[\[ "\$\{launch_status\}" -eq 3 \]\]; then/);
  assert.match(source, /waiting: active public benchmark scoring session blocked \$\{NEXT\} launch; retrying/);
  assert.match(source, /sleep "\$\{INTERVAL_SECONDS\}"[\s\S]*continue[\s\S]*if \[\[ "\$\{launch_status\}" -ne 0 \]\]; then/);
});

test("MemoryArena transition helper retries active-session launch collisions", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "launch-next-after-memoryarena.sh"),
    "utf8",
  );

  assert.match(source, /launch_status=\$\?/);
  assert.match(source, /if \[\[ "\$\{launch_status\}" -eq 3 \]\]; then/);
  assert.match(source, /waiting: active public benchmark scoring session blocked \$\{BENCHMARK\} launch; retrying/);
  assert.match(source, /exit 0[\s\S]*if \[\[ "\$\{launch_status\}" -ne 0 \]\]; then/);
});

test("public SOTA staging helpers start from base and prune stale evidence", async () => {
  const generic = await readFile(
    path.join("scripts", "bench", "public-sota", "stage-public-benchmark-evidence-pr.sh"),
    "utf8",
  );
  const memoryArena = await readFile(
    path.join("scripts", "bench", "public-sota", "memoryarena", "stage-memoryarena-evidence-pr.sh"),
    "utf8",
  );

  for (const source of [generic, memoryArena]) {
    assert.match(source, /worktree add -B "\$\{BRANCH\}" "\$\{WORKTREE\}" "origin\/\$\{BASE_BRANCH\}"/);
    assert.match(source, /reset --hard "origin\/\$\{BASE_BRANCH\}"/);
    assert.match(source, /git -C "\$\{WORKTREE\}" clean -fd/);
    assert.match(source, /find docs\/benchmarks\/results[\s\S]*-exec rm -rf \{\} \+/);
    assert.match(source, /rm -f "\$\{EVIDENCE_DOC_REL\}" "\$\{VERIFY_SCRIPT_REL\}"/);
  }
});

test("MemoryArena verifier template treats zero-target ties as SOTA", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "memoryarena", "verify-public-memoryarena-sota-evidence.template.mjs"),
    "utf8",
  );

  assert.match(source, /const zeroTargetTie = target === 0 && tied/);
  assert.match(source, /sota: actual > target \|\| zeroTargetTie/);
  assert.match(source, /sotaCriterion: 'target is zero; matching the target ties state of the art'/);
});

function memoryArenaTask(
  domain: string,
  taskId: number,
  extraScores: Record<string, number> = {},
): unknown {
  return {
    taskId: `${domain}-${taskId}-0`,
    details: {
      domain,
      taskId,
      subtaskIndex: 0,
      category: "fixture",
    },
    scores: {
      process_score: 1,
      task_success_rate: 1,
      ...extraScores,
    },
  };
}
