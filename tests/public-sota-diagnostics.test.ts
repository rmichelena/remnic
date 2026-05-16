import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

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
  await mkdir(datasetDir, { recursive: true });
  await mkdir(diagnosticsDir, { recursive: true });
  await writeFile(path.join(datasetDir, "fixture.json"), "{}\n", "utf8");
  return { root, datasetDir, diagnosticsDir, outDir, resultsDir };
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
