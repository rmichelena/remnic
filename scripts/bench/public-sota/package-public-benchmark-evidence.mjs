#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { comparePublicBenchmarkSota } from './compare-public-benchmark-sota.mjs';
import {
  canonicalJson,
  manifestArtifactHashIdentity,
  sha256String,
  stableStringify,
} from './evidence-integrity.mjs';
import {
  assert,
  assertCodexDiagnostics,
  assertCodexProvider,
  assertDatasetMatchesRunManifest,
  assertInsideResultsDir,
  assertNoInvalidRawScores,
  assertResultMatchesRunManifest,
  buildDiagnosticsSummary,
  gitInfo,
  parseArgs,
  pathReplacements,
  readJson,
  resultManifestEntry,
  sanitizeArgv,
  scanDataset,
  statusTimes,
} from './evidence-run-utils.mjs';
import { assertRealRuntime } from './runtime-profile-proof.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET_MAP = path.join(scriptDir, 'current-target-map.json');

function aggregateMeans(result) {
  return Object.fromEntries(
    Object.entries(result.results?.aggregates ?? {})
      .filter(([, aggregate]) => aggregate && typeof aggregate.mean === 'number' && Number.isFinite(aggregate.mean) && aggregate.mean >= 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([metric, aggregate]) => [metric, aggregate.mean]),
  );
}

function cleanedScores(scores) {
  return Object.fromEntries(
    Object.entries(scores ?? {})
      .filter(([, score]) => typeof score === 'number' && Number.isFinite(score) && score >= 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function publicTaskCategory(benchmark, task) {
  switch (benchmark) {
    case 'amemgym':
      return String(task.details?.profileId ?? task.taskId).split('-q')[0];
    case 'longmemeval':
      return String(task.details?.questionType ?? 'unknown');
    case 'locomo':
      return String(task.details?.categoryName ?? task.details?.category ?? 'unknown');
    case 'beam':
      return String(task.details?.scale ?? 'unknown');
    case 'personamem':
      return String(task.details?.prefType ?? task.details?.evaluationMode ?? 'unknown');
    case 'memoryagentbench':
      return String(task.details?.competency ?? task.details?.officialProtocol ?? 'unknown');
    case 'membench':
      return `${String(task.details?.memoryType ?? 'unknown')}/${String(task.details?.scenario ?? 'unknown')}`;
    default:
      return String(task.details?.category ?? 'unknown');
  }
}

function publicTaskDetails(benchmark, task) {
  const details = task.details ?? {};
  switch (benchmark) {
    case 'amemgym':
      return {
        profileId: details.profileId,
        itemIndex: details.questionIndex,
      };
    case 'longmemeval':
      return {
        itemType: details.questionType,
        judgeProtocol: details.judgeProtocol,
        searchHits: task.scores?.search_hits,
      };
    case 'locomo':
      return {
        category: details.category,
        categoryName: details.categoryName,
        hiddenEvidenceIdLeakCount: details.hiddenEvidenceIdLeakCount,
      };
    case 'beam':
      return {
        scale: details.scale,
        ability: details.ability,
        difficulty: details.difficulty,
      };
    case 'personamem':
      return {
        split: details.split ?? details.contextWindow ?? details.chatHistoryWindow ?? (details.chatHistory32kLink ? '32k' : undefined),
        chatHistory32kLink: details.chatHistory32kLink,
        chatHistory128kLink: details.chatHistory128kLink,
        prefType: details.prefType,
        evaluationMode: details.evaluationMode,
      };
    case 'memoryagentbench':
      return {
        competency: details.competency,
        source: details.source,
        officialProtocol: details.officialProtocol,
        recsysScoringReady: details.recsysScoringReady,
      };
    case 'membench':
      return {
        memoryType: details.memoryType,
        scenario: details.scenario,
        level: details.level,
        officialProtocol: details.officialProtocol,
      };
    default:
      return {};
  }
}

function fallbackBenchmarkArgv(benchmark) {
  return [
    'bench', 'published', '--name', benchmark, '--dataset', `evals/datasets/${benchmark}`,
    '--runtime-profile', 'real', '--provider', 'codex-cli', '--model', 'gpt-5.5',
    '--system-codex-reasoning-effort', 'xhigh', '--judge-provider', 'codex-cli',
    '--judge-model', 'gpt-5.5', '--judge-codex-reasoning-effort', 'xhigh',
    '--internal-provider', 'codex-cli', '--internal-model', 'gpt-5.5',
    '--internal-codex-reasoning-effort', 'xhigh', '--request-timeout', '3600000',
    '--drain-timeout', '3600000', '--max-429-wait', '86400000', '--seed', '1',
    '--results-dir', '<results-dir>', '--out', '<out-dir>',
  ];
}

function buildArtifact(result, dataset, comparison, startedAt) {
  const benchmark = result.meta.benchmark;
  const finishedAt = result.meta.timestamp;
  return {
    schemaVersion: 1,
    benchmarkId: benchmark,
    datasetVersion: `sha256:${dataset.sha256}`,
    system: {
      name: 'remnic',
      version: result.meta.remnicVersion,
      gitSha: result.meta.gitSha,
    },
    model: result.config.systemProvider?.model ?? 'gpt-5.5',
    seed: result.meta.seeds?.[0] ?? 1,
    metrics: aggregateMeans(result),
    perTaskScores: result.results.tasks.map((task) => ({
      taskId: task.taskId,
      category: publicTaskCategory(benchmark, task),
      scores: cleanedScores(task.scores),
      details: publicTaskDetails(benchmark, task),
    })),
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    env: {
      node: result.environment?.nodeVersion ?? process.version,
      os: result.environment?.os ?? process.platform,
      arch: result.environment?.hardware ?? process.arch,
    },
    note: `Full ${benchmark} run. Public-safe artifact omits question text, expected answers, model answers, recalled text, and answer context; see MANIFEST.${benchmark}.json for raw local result hash and reproduction command.`,
    sotaComparison: comparison,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.result || !args['results-dir'] || !args['dataset-dir'] || !args['repo-root'] || !args['out-dir']) {
    console.error('Usage: package-public-benchmark-evidence.mjs --result <result.json> --results-dir <dir> --dataset-dir <dir> --repo-root <repo> --out-dir <dir> [--target-map <json>]');
    process.exit(2);
  }
  const resultPath = path.resolve(args.result);
  const resultsDir = path.resolve(args['results-dir']);
  const repoRoot = path.resolve(args['repo-root']);
  const outDir = path.resolve(args['out-dir']);
  const replacements = pathReplacements(repoRoot, resultsDir, outDir, args['dataset-dir']);
  const baseManifestPath = args['base-manifest'] ? path.resolve(args['base-manifest']) : path.join(resultsDir, 'MANIFEST.json');
  const baseManifest = fs.existsSync(baseManifestPath) ? readJson(baseManifestPath) : {};
  const targetMap = readJson(path.resolve(args['target-map'] ?? DEFAULT_TARGET_MAP));
  const result = readJson(resultPath);
  const benchmark = result.meta?.benchmark;
  assert(typeof benchmark === 'string' && benchmark !== 'memory-arena', 'use the MemoryArena-specific packager for memory-arena');
  assertInsideResultsDir(resultPath, resultsDir);
  assert(result.meta.mode === 'full', 'result must be full mode');
  assertRealRuntime(result, baseManifest, 'raw result');
  assertCodexProvider(result.config.systemProvider, 'system');
  assertCodexProvider(result.config.judgeProvider, 'judge');
  assertCodexProvider(result.config.internalProvider, 'internal', { required: false });
  assertNoInvalidRawScores(result);

  const comparison = comparePublicBenchmarkSota(result, targetMap);
  const dataset = await scanDataset(args['dataset-dir'], repoRoot, benchmark, replacements);
  assertDatasetMatchesRunManifest(baseManifest, benchmark, dataset);
  const generatedAt = new Date().toISOString();
  const times = statusTimes(resultsDir, benchmark, result.meta.timestamp);
  const artifact = buildArtifact(result, dataset, comparison, times.startedAt);
  const filename = `${times.startedAt.slice(0, 10)}-${benchmark}-gpt-5.5-real-${String(result.meta.gitSha).slice(0, 8)}.json`;
  const generatedResultPrefix = `docs/benchmarks/results/${path.basename(resultsDir)}/`;
  const git = gitInfo(repoRoot, result, [generatedResultPrefix]);

  await fsp.mkdir(outDir, { recursive: true });
  const artifactPath = path.join(outDir, filename);
  const artifactBody = canonicalJson(artifact);
  await fsp.writeFile(artifactPath, artifactBody, 'utf8');

  const rawEntry = resultManifestEntry(resultPath, resultsDir, result);
  assertResultMatchesRunManifest(baseManifest, rawEntry);
  const publicEntry = {
    path: filename,
    sha256: sha256String(artifactBody),
    sizeBytes: fs.statSync(artifactPath).size,
    resultId: result.meta.id,
    benchmark,
    mode: result.meta.mode,
    gitSha: result.meta.gitSha,
    runCount: result.meta.runCount,
    seeds: [...result.meta.seeds],
    taskCount: result.results.tasks.length,
    publicSafe: true,
    sourceResultPath: rawEntry.path,
    sourceResultSha256: rawEntry.sha256,
    sourceResultSizeBytes: rawEntry.sizeBytes,
  };
  const manifestWithoutHash = {
    schemaVersion: 1,
    generatedAt,
    run: {
      id: baseManifest.run?.id ?? path.basename(resultsDir),
      mode: 'full',
      selectedBenchmarks: [benchmark],
      runtimeProfiles: ['real'],
      seed: result.meta.seeds?.[0] ?? 1,
    },
    git,
    command: {
      cwd: '<repo-root>',
      argv: sanitizeArgv(baseManifest.command?.argv, replacements, fallbackBenchmarkArgv(benchmark)),
      envKeys: Array.isArray(baseManifest.command?.envKeys) ? [...baseManifest.command.envKeys].sort() : ['OPENAI_API_KEY'],
    },
    environment: {
      platform: result.environment?.os ?? process.platform,
      arch: result.environment?.hardware ?? process.arch,
      nodeVersion: result.environment?.nodeVersion ?? process.version,
      ...(baseManifest.environment?.packageManager ? { packageManager: baseManifest.environment.packageManager } : {}),
    },
    ...(typeof result.config.remnicConfig?.qmdCollection === 'string'
      ? { qmd: { collections: [result.config.remnicConfig.qmdCollection] } }
      : {}),
    configFiles: [],
    datasets: [dataset],
    results: [rawEntry],
    publicArtifacts: [publicEntry],
  };
  const manifest = {
    ...manifestWithoutHash,
    artifactHash: sha256String(stableStringify(manifestArtifactHashIdentity(manifestWithoutHash))),
  };
  const manifestPath = path.join(outDir, `MANIFEST.${benchmark}.json`);
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const comparisonPath = path.join(outDir, `${benchmark}-sota-comparison.json`);
  await fsp.writeFile(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
  const diagnostics = buildDiagnosticsSummary(resultsDir, manifest.run.id, benchmark, times.startedAt, result.meta.timestamp, generatedAt);
  assertCodexDiagnostics(diagnostics, result.results.tasks.length);
  const diagnosticsPath = path.join(outDir, `${benchmark}-diagnostics-summary.json`);
  await fsp.writeFile(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    ok: true,
    benchmark,
    outDir,
    artifactPath,
    manifestPath,
    comparisonPath,
    diagnosticsPath,
    taskCount: result.results.tasks.length,
    sotaAllCheckedMetrics: comparison.sotaAllCheckedMetrics,
    atOrAboveAllCheckedMetrics: comparison.atOrAboveAllCheckedMetrics,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
