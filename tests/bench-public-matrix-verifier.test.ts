import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import type { BenchmarkResult, ProviderConfig } from "@remnic/bench";

interface VerifyPublicMatrixEvidenceOptions {
  resultsDir: string;
  benchmarks?: readonly string[];
  diagnosticsDir?: string;
  manifestPath?: string;
  requireManifest?: boolean;
  requireDiagnostics?: boolean;
  requireInternalProvider?: boolean;
  expectedGitSha?: string;
  skipGitSha?: boolean;
}

interface PublicMatrixEvidenceReport {
  ok: boolean;
  issues: Array<{ code: string }>;
}

type VerifyPublicMatrixEvidence = (
  options: VerifyPublicMatrixEvidenceOptions,
) => Promise<PublicMatrixEvidenceReport>;

const CODEX_MODEL = "gpt-5.5";
const CODEX_REASONING_EFFORT = "xhigh";
const CODEX_SERVICE_TIER = "fast";

async function loadVerifier(): Promise<VerifyPublicMatrixEvidence> {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), "scripts", "bench", "verify-public-matrix.ts"),
  ).href;
  const verifierModule = await import(
    `${moduleUrl}?bench-public-matrix-verifier=${Date.now()}-${Math.random()}`
  ) as { verifyPublicMatrixEvidence: VerifyPublicMatrixEvidence };
  return verifierModule.verifyPublicMatrixEvidence;
}

function codexProvider(): ProviderConfig {
  return {
    provider: "codex-cli",
    model: CODEX_MODEL,
    reasoningEffort: CODEX_REASONING_EFFORT,
  };
}

function benchmarkResult(
  benchmark: string,
  overrides: Partial<BenchmarkResult> = {},
): BenchmarkResult {
  const base: BenchmarkResult = {
    meta: {
      id: `${benchmark}-test-result`,
      benchmark,
      benchmarkTier: "published",
      version: "test",
      remnicVersion: "test",
      gitSha: "abc123",
      timestamp: "2026-05-14T12:00:00.000Z",
      mode: "full",
      runCount: 1,
      seeds: [1],
      status: "complete",
    },
    config: {
      runtimeProfile: "real",
      systemProvider: codexProvider(),
      judgeProvider: codexProvider(),
      internalProvider: codexProvider(),
      adapterMode: "remnic",
      remnicConfig: {},
    },
    cost: {
      totalTokens: 3,
      inputTokens: 2,
      outputTokens: 1,
      estimatedCostUsd: 0,
      totalLatencyMs: 1,
      meanQueryLatencyMs: 1,
    },
    results: {
      tasks: [
        {
          taskId: `${benchmark}-task-1`,
          question: "What should be recalled?",
          expected: "answer",
          actual: "answer",
          scores: { accuracy: 1 },
          latencyMs: 1,
          tokens: { input: 2, output: 1 },
        },
      ],
      aggregates: {
        accuracy: {
          mean: 1,
          median: 1,
          stdDev: 0,
          min: 1,
          max: 1,
        },
      },
    },
    environment: {
      os: "test",
      nodeVersion: process.version,
    },
  };

  return {
    ...base,
    ...overrides,
    meta: {
      ...base.meta,
      ...overrides.meta,
    },
    config: {
      ...base.config,
      ...overrides.config,
    },
    results: {
      ...base.results,
      ...overrides.results,
    },
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeResult(resultsDir: string, result: BenchmarkResult): Promise<void> {
  await writeJson(path.join(resultsDir, `${result.meta.id}.json`), result);
}

async function writeManifest(
  resultsDir: string,
  benchmarks: readonly string[],
  gitSha = "abc123",
  limit?: number,
  runId = "test-public-matrix-run",
): Promise<void> {
  await writeJson(path.join(resultsDir, "MANIFEST.json"), {
    git: {
      commit: gitSha,
      dirty: false,
    },
    run: {
      id: runId,
      mode: "full",
      runtimeProfiles: ["real"],
      selectedBenchmarks: benchmarks,
      ...(limit !== undefined ? { limit } : {}),
    },
    datasets: benchmarks.map((benchmark) => ({
      benchmark,
      status: "hashed",
      fileCount: 1,
      sha256: "a".repeat(64),
    })),
    results: benchmarks.map((benchmark) => ({
      benchmark,
      path: `${benchmark}-test-result.json`,
      mode: "full",
      gitSha,
      taskCount: 1,
    })),
  });
}

async function writeDiagnostic(
  diagnosticsDir: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const fileName = typeof overrides.runId === "string"
    ? `codex-cli-${overrides.runId}.json`
    : "codex-cli.json";
  await writeJson(path.join(diagnosticsDir, fileName), {
    runId: "test-public-matrix-run",
    provider: "codex-cli",
    model: CODEX_MODEL,
    reasoningEffort: CODEX_REASONING_EFFORT,
    serviceTier: CODEX_SERVICE_TIER,
    result: {
      status: 0,
      signal: null,
    },
    ...overrides,
  });
}

test("verifies a complete Codex CLI public matrix evidence subset", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-public-matrix-ok-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const resultsDir = path.join(tmpDir, "results");
  const diagnosticsDir = path.join(resultsDir, "codex-cli-diagnostics");
  const benchmarks = ["longmemeval", "locomo"];
  for (const benchmark of benchmarks) {
    await writeResult(resultsDir, benchmarkResult(benchmark));
  }
  await writeResult(
    resultsDir,
    benchmarkResult("longmemeval", {
      meta: {
        id: "longmemeval-newer-unmanifested",
        timestamp: "2026-05-14T13:00:00.000Z",
      },
      config: {
        runtimeProfile: "baseline",
        systemProvider: {
          provider: "openai",
          model: "gpt-4.1",
        },
      },
    }),
  );
  await writeManifest(resultsDir, benchmarks);
  await writeDiagnostic(diagnosticsDir);
  await writeDiagnostic(diagnosticsDir, {
    runId: "stale-run",
    serviceTier: "auto",
    error: "stale failure from previous run",
  });

  const verifyPublicMatrixEvidence = await loadVerifier();
  const report = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks,
    expectedGitSha: "abc123",
  });

  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  assert.deepEqual(report.issues, []);

  const skipGitReport = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks,
    skipGitSha: true,
  });
  assert.equal(skipGitReport.ok, true, JSON.stringify(skipGitReport.issues, null, 2));
});

test("reports missing and wrong public matrix evidence", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-public-matrix-bad-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const resultsDir = path.join(tmpDir, "results");
  const diagnosticsDir = path.join(resultsDir, "codex-cli-diagnostics");
  await writeResult(
    resultsDir,
    benchmarkResult("longmemeval", {
      config: {
        runtimeProfile: "baseline",
        systemProvider: {
          provider: "openai",
          model: "gpt-4.1",
          reasoningEffort: "high",
        },
        benchmarkOptions: {
          limit: 1,
        },
      },
    }),
  );
  await writeManifest(resultsDir, ["longmemeval", "locomo"], "abc123", 1);
  await writeDiagnostic(diagnosticsDir, {
    serviceTier: "auto",
  });

  const verifyPublicMatrixEvidence = await loadVerifier();
  const report = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks: ["longmemeval", "locomo"],
    expectedGitSha: "abc123",
  });
  const issueCodes = new Set(report.issues.map((issue) => issue.code));

  assert.equal(report.ok, false);
  assert.equal(issueCodes.has("wrong-runtime-profile"), true);
  assert.equal(issueCodes.has("wrong-systemProvider-provider"), true);
  assert.equal(issueCodes.has("limited-result"), true);
  assert.equal(issueCodes.has("manifest-limited-run"), true);
  assert.equal(issueCodes.has("wrong-diagnostic-service-tier"), true);
  assert.equal(issueCodes.has("manifest-result-unreadable"), true);
});
