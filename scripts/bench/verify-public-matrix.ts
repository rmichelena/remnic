#!/usr/bin/env -S npx tsx
/**
 * Verify that a stored benchmark result directory contains reproducible
 * evidence for the full published public benchmark matrix.
 *
 * This is intentionally stricter than schema validation. It checks the
 * run envelope required for current public-matrix claims: full mode,
 * real runtime, current git SHA, Codex CLI gpt-5.5, xhigh reasoning,
 * fast service tier diagnostics, hashed datasets, and complete results.
 *
 * It does not prove SOTA by itself; benchmark-specific comparative
 * evidence still needs to be reviewed separately.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  PUBLISHED_BENCHMARK_ARTIFACT_IDS,
  listBenchmarkResults,
  loadBenchmarkResult,
} from "@remnic/bench";
import type {
  BenchmarkResult,
  BenchReasoningEffort,
  BenchRuntimeProfile,
  ProviderConfig,
} from "@remnic/bench";

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT: BenchReasoningEffort = "xhigh";
const DEFAULT_SERVICE_TIER = "fast";
const DEFAULT_RUNTIME_PROFILE: BenchRuntimeProfile = "real";
const MANIFEST_FILENAME = "MANIFEST.json";

type ProviderRole = "systemProvider" | "judgeProvider" | "internalProvider";

interface CodexDiagnosticRecord {
  runId?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  error?: string;
  result?: {
    status?: number | null;
    signal?: string | null;
  };
}

interface ReproManifest {
  git?: {
    commit?: string;
    shortCommit?: string;
    dirty?: boolean;
  };
  run?: {
    id?: string;
    mode?: string;
    runtimeProfiles?: string[];
    selectedBenchmarks?: string[];
    limit?: number;
  };
  datasets?: Array<{
    benchmark?: string;
    status?: string;
    fileCount?: number;
    sha256?: string;
  }>;
  results?: Array<{
    benchmark?: string;
    mode?: string;
    gitSha?: string;
    taskCount?: number;
  }>;
}

export interface PublicMatrixEvidenceIssue {
  code: string;
  message: string;
  benchmark?: string;
  path?: string;
}

export interface PublicMatrixEvidenceRow {
  benchmark: string;
  resultPath?: string;
  resultId?: string;
  taskCount?: number;
  diagnosticsChecked?: number;
}

export interface PublicMatrixEvidenceReport {
  ok: boolean;
  issues: PublicMatrixEvidenceIssue[];
  rows: PublicMatrixEvidenceRow[];
}

export interface VerifyPublicMatrixEvidenceOptions {
  resultsDir: string;
  benchmarks?: readonly string[];
  diagnosticsDir?: string;
  manifestPath?: string;
  requireManifest?: boolean;
  requireDiagnostics?: boolean;
  requireInternalProvider?: boolean;
  expectedModel?: string;
  expectedReasoningEffort?: BenchReasoningEffort;
  expectedServiceTier?: string;
  expectedRuntimeProfile?: BenchRuntimeProfile;
  expectedGitSha?: string;
  skipGitSha?: boolean;
}

export async function verifyPublicMatrixEvidence(
  options: VerifyPublicMatrixEvidenceOptions,
): Promise<PublicMatrixEvidenceReport> {
  const expectedModel = options.expectedModel ?? DEFAULT_MODEL;
  const expectedReasoningEffort =
    options.expectedReasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const expectedServiceTier = options.expectedServiceTier ?? DEFAULT_SERVICE_TIER;
  const expectedRuntimeProfile =
    options.expectedRuntimeProfile ?? DEFAULT_RUNTIME_PROFILE;
  const expectedGitSha = options.skipGitSha
    ? undefined
    : options.expectedGitSha === undefined
      ? resolveCurrentGitSha(process.cwd())
      : options.expectedGitSha;
  const benchmarks = resolveBenchmarks(options.benchmarks);
  const resultsDir = path.resolve(expandHome(options.resultsDir));
  const diagnosticsDir = path.resolve(
    expandHome(options.diagnosticsDir ?? path.join(resultsDir, "codex-cli-diagnostics")),
  );
  const manifestPath = path.resolve(
    expandHome(options.manifestPath ?? path.join(resultsDir, MANIFEST_FILENAME)),
  );
  const issues: PublicMatrixEvidenceIssue[] = [];
  const rows: PublicMatrixEvidenceRow[] = benchmarks.map((benchmark) => ({
    benchmark,
  }));

  const summaries = await listBenchmarkResults(resultsDir);
  for (const row of rows) {
    const summary = summaries
      .filter((candidate) => candidate.benchmark === row.benchmark)
      .filter((candidate) => candidate.mode === "full")
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
    if (!summary) {
      issues.push({
        code: "missing-full-result",
        benchmark: row.benchmark,
        message: `No full-mode result found for ${row.benchmark}.`,
      });
      continue;
    }

    row.resultPath = summary.path;
    const result = await loadBenchmarkResult(summary.path);
    row.resultId = result.meta.id;
    row.taskCount = result.results.tasks.length;
    validateResultEnvelope(result, summary.path, {
      expectedModel,
      expectedReasoningEffort,
      expectedRuntimeProfile,
      expectedGitSha,
      requireInternalProvider: options.requireInternalProvider ?? true,
      issues,
    });
  }

  if (options.requireManifest ?? true) {
    await validateManifest(manifestPath, {
      benchmarks,
      expectedGitSha,
      expectedRuntimeProfile,
      issues,
    });
  }

  if (options.requireDiagnostics ?? true) {
    const diagnosticsChecked = await validateDiagnostics(diagnosticsDir, {
      manifestPath,
      expectedModel,
      expectedReasoningEffort,
      expectedServiceTier,
      issues,
    });
    for (const row of rows) {
      row.diagnosticsChecked = diagnosticsChecked;
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    rows,
  };
}

function validateResultEnvelope(
  result: BenchmarkResult,
  resultPath: string,
  options: {
    expectedModel: string;
    expectedReasoningEffort: BenchReasoningEffort;
    expectedRuntimeProfile: BenchRuntimeProfile;
    expectedGitSha: string | undefined;
    requireInternalProvider: boolean;
    issues: PublicMatrixEvidenceIssue[];
  },
): void {
  const benchmark = result.meta.benchmark;
  if (result.meta.benchmarkTier !== "published") {
    addIssue(options.issues, benchmark, resultPath, "not-published-tier", `Expected published tier, got ${result.meta.benchmarkTier}.`);
  }
  if (result.meta.mode !== "full") {
    addIssue(options.issues, benchmark, resultPath, "not-full-mode", `Expected full mode, got ${result.meta.mode}.`);
  }
  if (result.meta.status === "partial") {
    addIssue(options.issues, benchmark, resultPath, "partial-result", `Result is partial: ${result.meta.failureReason ?? "unknown failure"}.`);
  }
  if (result.config.runtimeProfile !== options.expectedRuntimeProfile) {
    addIssue(options.issues, benchmark, resultPath, "wrong-runtime-profile", `Expected runtimeProfile=${options.expectedRuntimeProfile}, got ${String(result.config.runtimeProfile)}.`);
  }
  if (options.expectedGitSha && !gitShaMatches(result.meta.gitSha, options.expectedGitSha)) {
    addIssue(options.issues, benchmark, resultPath, "wrong-git-sha", `Expected gitSha matching ${options.expectedGitSha}, got ${result.meta.gitSha}.`);
  }
  if (result.results.tasks.length === 0) {
    addIssue(options.issues, benchmark, resultPath, "empty-task-set", "Result has no per-task scores.");
  }
  if (Object.keys(result.results.aggregates).length === 0) {
    addIssue(options.issues, benchmark, resultPath, "empty-aggregates", "Result has no aggregate metrics.");
  }
  validateFullDatasetRunOptions(
    benchmark,
    resultPath,
    result.config.benchmarkOptions,
    options.issues,
  );
  for (const [metric, aggregate] of Object.entries(result.results.aggregates)) {
    if (!Number.isFinite(aggregate.mean)) {
      addIssue(options.issues, benchmark, resultPath, "non-finite-metric", `Aggregate ${metric}.mean is not finite.`);
    }
  }

  validateProviderRole(result, resultPath, "systemProvider", result.config.systemProvider, options);
  validateProviderRole(result, resultPath, "judgeProvider", result.config.judgeProvider, options);
  if (options.requireInternalProvider || result.config.internalProvider) {
    validateProviderRole(result, resultPath, "internalProvider", result.config.internalProvider ?? null, options);
  }
}

function validateFullDatasetRunOptions(
  benchmark: string,
  resultPath: string,
  benchmarkOptions: BenchmarkResult["config"]["benchmarkOptions"],
  issues: PublicMatrixEvidenceIssue[],
): void {
  if (!benchmarkOptions || typeof benchmarkOptions !== "object") {
    return;
  }
  const disallowedKeys = ["limit", "trialLimit", "taskFilter"] as const;
  for (const key of disallowedKeys) {
    if (Object.prototype.hasOwnProperty.call(benchmarkOptions, key)) {
      addIssue(
        issues,
        benchmark,
        resultPath,
        "limited-result",
        `Full public-matrix evidence must not use benchmarkOptions.${key}.`,
      );
    }
  }
}

function validateProviderRole(
  result: BenchmarkResult,
  resultPath: string,
  role: ProviderRole,
  provider: ProviderConfig | null,
  options: {
    expectedModel: string;
    expectedReasoningEffort: BenchReasoningEffort;
    issues: PublicMatrixEvidenceIssue[];
  },
): void {
  const benchmark = result.meta.benchmark;
  if (!provider) {
    addIssue(options.issues, benchmark, resultPath, `missing-${role}`, `${role} is missing.`);
    return;
  }
  if (provider.provider !== "codex-cli") {
    addIssue(options.issues, benchmark, resultPath, `wrong-${role}-provider`, `${role}.provider must be codex-cli, got ${provider.provider}.`);
  }
  if (provider.model !== options.expectedModel) {
    addIssue(options.issues, benchmark, resultPath, `wrong-${role}-model`, `${role}.model must be ${options.expectedModel}, got ${provider.model}.`);
  }
  if (provider.reasoningEffort !== options.expectedReasoningEffort) {
    addIssue(options.issues, benchmark, resultPath, `wrong-${role}-reasoning`, `${role}.reasoningEffort must be ${options.expectedReasoningEffort}, got ${String(provider.reasoningEffort)}.`);
  }
}

async function validateManifest(
  manifestPath: string,
  options: {
    benchmarks: string[];
    expectedGitSha: string | undefined;
    expectedRuntimeProfile: BenchRuntimeProfile;
    issues: PublicMatrixEvidenceIssue[];
  },
): Promise<void> {
  if (!fs.existsSync(manifestPath)) {
    options.issues.push({
      code: "missing-manifest",
      path: manifestPath,
      message: `Repro manifest not found: ${manifestPath}.`,
    });
    return;
  }

  let manifest: ReproManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ReproManifest;
  } catch (error) {
    options.issues.push({
      code: "invalid-manifest",
      path: manifestPath,
      message: `Could not parse repro manifest: ${error instanceof Error ? error.message : String(error)}.`,
    });
    return;
  }

  if (manifest.git?.dirty !== false) {
    options.issues.push({
      code: "dirty-manifest-git",
      path: manifestPath,
      message: "Repro manifest was generated from a dirty worktree.",
    });
  }
  if (options.expectedGitSha && !gitShaMatches(manifest.git?.commit ?? manifest.git?.shortCommit ?? "", options.expectedGitSha)) {
    options.issues.push({
      code: "wrong-manifest-git",
      path: manifestPath,
      message: `Expected manifest git to match ${options.expectedGitSha}, got ${manifest.git?.commit ?? manifest.git?.shortCommit ?? "<missing>"}.`,
    });
  }
  if (manifest.run?.mode !== "full") {
    options.issues.push({
      code: "manifest-not-full-mode",
      path: manifestPath,
      message: `Expected manifest run.mode=full, got ${String(manifest.run?.mode)}.`,
    });
  }
  if (!isNonEmptyString(manifest.run?.id)) {
    options.issues.push({
      code: "manifest-missing-run-id",
      path: manifestPath,
      message: "Repro manifest must record run.id so shared Codex diagnostics can be scoped to this run.",
    });
  }
  if (manifest.run && Object.prototype.hasOwnProperty.call(manifest.run, "limit")) {
    options.issues.push({
      code: "manifest-limited-run",
      path: manifestPath,
      message: "Repro manifest records run.limit; full public-matrix evidence must use the full dataset.",
    });
  }
  if (!manifest.run?.runtimeProfiles?.includes(options.expectedRuntimeProfile)) {
    options.issues.push({
      code: "manifest-missing-runtime-profile",
      path: manifestPath,
      message: `Expected manifest runtimeProfiles to include ${options.expectedRuntimeProfile}.`,
    });
  }

  for (const benchmark of options.benchmarks) {
    const dataset = manifest.datasets?.find((entry) => entry.benchmark === benchmark);
    if (!dataset) {
      addIssue(options.issues, benchmark, manifestPath, "manifest-missing-dataset", "Manifest has no dataset entry for benchmark.");
    } else if (
      dataset.status !== "hashed" ||
      !isSha256(dataset.sha256) ||
      !Number.isInteger(dataset.fileCount) ||
      dataset.fileCount <= 0
    ) {
      addIssue(options.issues, benchmark, manifestPath, "manifest-dataset-not-hashed", `Dataset entry must be hashed with files; got status=${String(dataset.status)} fileCount=${String(dataset.fileCount)}.`);
    }

    const result = manifest.results?.find((entry) => entry.benchmark === benchmark);
    if (!result) {
      addIssue(options.issues, benchmark, manifestPath, "manifest-missing-result", "Manifest has no result entry for benchmark.");
    } else if (
      result.mode !== "full" ||
      !Number.isInteger(result.taskCount) ||
      result.taskCount <= 0
    ) {
      addIssue(options.issues, benchmark, manifestPath, "manifest-result-not-full", `Manifest result must be full with tasks; got mode=${String(result.mode)} taskCount=${String(result.taskCount)}.`);
    } else if (options.expectedGitSha && !gitShaMatches(result.gitSha ?? "", options.expectedGitSha)) {
      addIssue(options.issues, benchmark, manifestPath, "manifest-result-wrong-git", `Expected manifest result git to match ${options.expectedGitSha}, got ${String(result.gitSha)}.`);
    }
  }
}

async function validateDiagnostics(
  diagnosticsDir: string,
  options: {
    manifestPath: string;
    expectedModel: string;
    expectedReasoningEffort: BenchReasoningEffort;
    expectedServiceTier: string;
    issues: PublicMatrixEvidenceIssue[];
  },
): Promise<number> {
  const expectedRunId = await readManifestRunId(options.manifestPath);
  if (!fs.existsSync(diagnosticsDir)) {
    options.issues.push({
      code: "missing-codex-diagnostics",
      path: diagnosticsDir,
      message: `Codex CLI diagnostics directory not found: ${diagnosticsDir}.`,
    });
    return 0;
  }

  const files = (await readdir(diagnosticsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(diagnosticsDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    options.issues.push({
      code: "empty-codex-diagnostics",
      path: diagnosticsDir,
      message: "Codex CLI diagnostics directory contains no JSON records.",
    });
    return 0;
  }

  let checked = 0;
  for (const file of files) {
    let record: CodexDiagnosticRecord;
    try {
      record = JSON.parse(await readFile(file, "utf8")) as CodexDiagnosticRecord;
    } catch (error) {
      options.issues.push({
        code: "invalid-codex-diagnostic",
        path: file,
        message: `Could not parse diagnostic record: ${error instanceof Error ? error.message : String(error)}.`,
      });
      continue;
    }
    if (expectedRunId && record.runId !== expectedRunId) {
      continue;
    }
    checked += 1;
    if (record.provider !== "codex-cli") {
      options.issues.push({ code: "wrong-diagnostic-provider", path: file, message: `Expected provider=codex-cli, got ${String(record.provider)}.` });
    }
    if (record.model !== options.expectedModel) {
      options.issues.push({ code: "wrong-diagnostic-model", path: file, message: `Expected model=${options.expectedModel}, got ${String(record.model)}.` });
    }
    if (record.reasoningEffort !== options.expectedReasoningEffort) {
      options.issues.push({ code: "wrong-diagnostic-reasoning", path: file, message: `Expected reasoningEffort=${options.expectedReasoningEffort}, got ${String(record.reasoningEffort)}.` });
    }
    if (record.serviceTier !== options.expectedServiceTier) {
      options.issues.push({ code: "wrong-diagnostic-service-tier", path: file, message: `Expected serviceTier=${options.expectedServiceTier}, got ${String(record.serviceTier)}.` });
    }
    if (record.error) {
      options.issues.push({ code: "diagnostic-error", path: file, message: `Diagnostic captured an error: ${record.error}.` });
    }
    if (record.result?.status !== 0 || record.result?.signal) {
      options.issues.push({ code: "diagnostic-nonzero-exit", path: file, message: `Diagnostic result was status=${String(record.result?.status)} signal=${String(record.result?.signal)}.` });
    }
  }
  if (expectedRunId && checked === 0) {
    options.issues.push({
      code: "missing-run-codex-diagnostics",
      path: diagnosticsDir,
      message: `Codex CLI diagnostics directory contains no JSON records for manifest run.id=${expectedRunId}.`,
    });
  }
  return checked;
}

async function readManifestRunId(manifestPath: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ReproManifest;
    return isNonEmptyString(manifest.run?.id) ? manifest.run.id.trim() : undefined;
  } catch {
    return undefined;
  }
}

function resolveBenchmarks(rawBenchmarks: readonly string[] | undefined): string[] {
  const benchmarks = rawBenchmarks && rawBenchmarks.length > 0
    ? [...new Set(rawBenchmarks.flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean))]
    : [...PUBLISHED_BENCHMARK_ARTIFACT_IDS];
  const allowed = new Set<string>(PUBLISHED_BENCHMARK_ARTIFACT_IDS);
  const unsupported = benchmarks.filter((benchmark) => !allowed.has(benchmark));
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported public benchmark id(s): ${unsupported.join(", ")}. Supported: ${PUBLISHED_BENCHMARK_ARTIFACT_IDS.join(", ")}.`,
    );
  }
  return benchmarks;
}

function addIssue(
  issues: PublicMatrixEvidenceIssue[],
  benchmark: string,
  issuePath: string,
  code: string,
  message: string,
): void {
  issues.push({
    code,
    benchmark,
    ...(issuePath ? { path: issuePath } : {}),
    message,
  });
}

function gitShaMatches(actual: string, expected: string): boolean {
  if (!actual || !expected) {
    return false;
  }
  return actual === expected || actual.startsWith(expected) || expected.startsWith(actual);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveCurrentGitSha(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function parseArgs(args: string[]): VerifyPublicMatrixEvidenceOptions & { json: boolean } {
  let resultsDir = path.join(os.homedir(), ".remnic", "bench", "results");
  let diagnosticsDir: string | undefined;
  let manifestPath: string | undefined;
  let requireManifest = true;
  let requireDiagnostics = true;
  let requireInternalProvider = true;
  let expectedModel = DEFAULT_MODEL;
  let expectedReasoningEffort: BenchReasoningEffort = DEFAULT_REASONING_EFFORT;
  let expectedServiceTier = DEFAULT_SERVICE_TIER;
  let expectedRuntimeProfile: BenchRuntimeProfile = DEFAULT_RUNTIME_PROFILE;
  let expectedGitSha: string | undefined;
  let skipGitSha = false;
  let json = false;
  const benchmarks: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = () => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--results-dir":
        resultsDir = next();
        break;
      case "--diagnostics-dir":
        diagnosticsDir = next();
        break;
      case "--manifest":
        manifestPath = next();
        break;
      case "--benchmarks":
        benchmarks.push(next());
        break;
      case "--model":
        expectedModel = next();
        break;
      case "--reasoning-effort":
        expectedReasoningEffort = parseReasoningEffort(next());
        break;
      case "--service-tier":
        expectedServiceTier = next();
        break;
      case "--runtime-profile":
        expectedRuntimeProfile = parseRuntimeProfile(next());
        break;
      case "--git-sha":
        expectedGitSha = next();
        skipGitSha = false;
        break;
      case "--skip-git":
        skipGitSha = true;
        expectedGitSha = undefined;
        break;
      case "--no-manifest":
        requireManifest = false;
        break;
      case "--no-diagnostics":
        requireDiagnostics = false;
        break;
      case "--allow-missing-internal-provider":
        requireInternalProvider = false;
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        throw new UsageRequested();
      default:
        throw new Error(`Unknown flag ${arg}.`);
    }
  }

  return {
    resultsDir,
    ...(benchmarks.length > 0 ? { benchmarks } : {}),
    ...(diagnosticsDir ? { diagnosticsDir } : {}),
    ...(manifestPath ? { manifestPath } : {}),
    requireManifest,
    requireDiagnostics,
    requireInternalProvider,
    expectedModel,
    expectedReasoningEffort,
    expectedServiceTier,
    expectedRuntimeProfile,
    expectedGitSha,
    skipGitSha,
    json,
  };
}

function parseReasoningEffort(value: string): BenchReasoningEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  throw new Error(`Invalid --reasoning-effort ${JSON.stringify(value)}. Expected low, medium, high, or xhigh.`);
}

function parseRuntimeProfile(value: string): BenchRuntimeProfile {
  if (value === "baseline" || value === "real" || value === "openclaw-chain") {
    return value;
  }
  throw new Error(`Invalid --runtime-profile ${JSON.stringify(value)}. Expected baseline, real, or openclaw-chain.`);
}

class UsageRequested extends Error {}

function printUsage(): void {
  process.stdout.write(`Usage: scripts/bench/verify-public-matrix.ts [options]

Options:
  --results-dir <dir>                 Stored benchmark result directory
  --diagnostics-dir <dir>             Codex CLI diagnostics dir (default: <results-dir>/codex-cli-diagnostics)
  --manifest <path>                   Repro manifest path (default: <results-dir>/MANIFEST.json)
  --benchmarks <ids>                  Comma-separated subset; defaults to all public benchmarks
  --model <id>                        Expected Codex model (default: gpt-5.5)
  --reasoning-effort <value>          Expected reasoning effort (default: xhigh)
  --service-tier <value>              Expected Codex service tier (default: fast)
  --runtime-profile <profile>         Expected runtime profile (default: real)
  --git-sha <sha>                     Expected result git SHA
  --skip-git                          Do not compare result/manifest git SHA
  --no-manifest                       Skip MANIFEST.json checks
  --no-diagnostics                    Skip Codex diagnostics checks
  --allow-missing-internal-provider   Do not require internalProvider to be Codex CLI
  --json                              Print JSON report
`);
}

async function main(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    if (error instanceof UsageRequested) {
      printUsage();
      return 0;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    printUsage();
    return 2;
  }

  const { json, ...options } = parsed;
  const report = await verifyPublicMatrixEvidence(options);
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.ok) {
    process.stdout.write(`OK public benchmark matrix evidence verified for ${report.rows.length} benchmark(s).\n`);
  } else {
    for (const issue of report.issues) {
      const location = [
        issue.benchmark ? `benchmark=${issue.benchmark}` : undefined,
        issue.path ? `path=${issue.path}` : undefined,
      ].filter(Boolean).join(" ");
      process.stderr.write(`FAIL ${issue.code}${location ? ` ${location}` : ""}: ${issue.message}\n`);
    }
  }
  return report.ok ? 0 : 1;
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedUrl) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `verify-public-matrix.ts crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
