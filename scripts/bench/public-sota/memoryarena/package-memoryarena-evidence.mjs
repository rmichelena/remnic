#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareMemoryArenaSota } from './compare-memoryarena-sota.mjs';
import { deriveMemoryArenaOfficialMetrics } from './derive-memoryarena-official-metrics.mjs';
import {
  canonicalJson,
  manifestArtifactHashIdentity,
  sha256String,
  stableStringify,
} from '../evidence-integrity.mjs';
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
} from '../evidence-run-utils.mjs';
import { assertRealRuntime } from '../runtime-profile-proof.mjs';

const publicSotaDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_TARGET_MAP = path.join(publicSotaDir, 'current-target-map.json');

function usage() {
  return [
    'Usage:',
    '  node package-memoryarena-evidence.mjs \\',
    '    --result <raw-memory-arena-result.json> \\',
    '    --results-dir <raw-results-dir> \\',
    '    --dataset-dir <evals/datasets/memory-arena> \\',
    '    --repo-root <repo-root> \\',
    '    --out-dir <evidence-output-dir> \\',
    '    [--base-manifest <MANIFEST.json>] \\',
    '    [--target-map <current-target-map.json>]',
  ].join('\n');
}

function finiteScoreEntries(scores) {
  return Object.fromEntries(
    Object.entries(scores ?? {})
      .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function aggregateMeans(result) {
  const out = {};
  for (const [key, aggregate] of Object.entries(result.results?.aggregates ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (aggregate && typeof aggregate.mean === 'number' && Number.isFinite(aggregate.mean) && aggregate.mean >= 0) {
      out[key] = aggregate.mean;
    }
  }
  return out;
}

function buildPublicArtifact(result, dataset, derived, comparison, startedAt) {
  const finishedAt = result.meta?.timestamp ?? new Date().toISOString();
  const metrics = {
    ...aggregateMeans(result),
    memory_arena_official_progress_score: derived.official.progressScore,
    memory_arena_official_success_rate: derived.official.successRate,
  };
  if (typeof derived.official.softProgressScore === 'number') {
    metrics.memory_arena_official_soft_progress_score = derived.official.softProgressScore;
  }
  for (const row of derived.byDomain) {
    metrics[`memory_arena_${row.domain}_progress_score`] = row.progressScore;
    metrics[`memory_arena_${row.domain}_success_rate`] = row.successRate;
    if (typeof row.softProgressScore === 'number') {
      metrics[`memory_arena_${row.domain}_soft_progress_score`] = row.softProgressScore;
    }
  }

  return {
    schemaVersion: 1,
    benchmarkId: 'memory-arena',
    datasetVersion: `sha256:${dataset.sha256}`,
    system: {
      name: 'remnic',
      version: result.meta?.remnicVersion ?? 'unknown',
      gitSha: result.meta?.gitSha ?? 'unknown',
    },
    model: result.config?.systemProvider?.model ?? 'gpt-5.5',
    seed: result.meta?.seeds?.[0] ?? 1,
    metrics,
    perTaskScores: result.results.tasks.map((task) => ({
      taskId: task.taskId,
      category: String(task.details?.domain ?? task.details?.category ?? 'unknown'),
      scores: finiteScoreEntries(task.scores),
      memoryArena: {
        domain: String(task.details?.domain ?? ''),
        taskId: task.details?.taskId,
        subtaskIndex: task.details?.subtaskIndex,
        category: task.details?.category,
      },
    })),
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    env: {
      node: result.environment?.nodeVersion ?? process.version,
      os: result.environment?.os ?? process.platform,
      arch: result.environment?.hardware ?? process.arch,
    },
    note: 'Full MemoryArena run. Public-safe artifact omits question text, expected answers, model answers, recalled text, and answer context; see MANIFEST.memory-arena.json for raw local result hash and reproduction command.',
    memoryArenaOfficialMetrics: derived,
    sotaComparison: comparison,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.result || !args['results-dir'] || !args['dataset-dir'] || !args['repo-root'] || !args['out-dir']) {
    console.error(usage());
    process.exit(2);
  }

  const resultPath = path.resolve(args.result);
  const resultsDir = path.resolve(args['results-dir']);
  const repoRoot = path.resolve(args['repo-root']);
  const outDir = path.resolve(args['out-dir']);
  const replacements = pathReplacements(repoRoot, resultsDir, outDir, args['dataset-dir']);
  const baseManifestPath = args['base-manifest'] ? path.resolve(args['base-manifest']) : path.join(resultsDir, 'MANIFEST.json');
  const targetMapPath = path.resolve(args['target-map'] ?? DEFAULT_TARGET_MAP);
  assertInsideResultsDir(resultPath, resultsDir, 'raw result must be inside --results-dir so the manifest can use a safe relative source path');

  const result = readJson(resultPath);
  const baseManifest = fs.existsSync(baseManifestPath) ? readJson(baseManifestPath) : {};
  assert(result.meta?.benchmark === 'memory-arena', 'raw result must be memory-arena');
  assert(result.meta?.mode === 'full', 'raw result must be full mode');
  assertRealRuntime(result, baseManifest, 'raw result');
  assertCodexProvider(result.config?.systemProvider, 'system');
  assertCodexProvider(result.config?.judgeProvider, 'judge');
  assertCodexProvider(result.config?.internalProvider, 'internal', { required: false });
  assertNoInvalidRawScores(result);

  const targetMap = readJson(targetMapPath);
  const derived = deriveMemoryArenaOfficialMetrics(result);
  const comparison = compareMemoryArenaSota(result, targetMap);
  const dataset = await scanDataset(args['dataset-dir'], repoRoot, 'memory-arena', replacements);
  assertDatasetMatchesRunManifest(baseManifest, 'memory-arena', dataset);
  const times = statusTimes(resultsDir, 'memory-arena');
  const startedAt = times.startedAt ?? result.meta.timestamp;
  const finishedAt = result.meta.timestamp;
  const generatedAt = new Date().toISOString();
  const artifact = buildPublicArtifact(result, dataset, derived, comparison, startedAt);
  const artifactFilename = `${startedAt.slice(0, 10)}-memory-arena-gpt-5.5-real-${String(result.meta.gitSha ?? 'unknown').slice(0, 8)}.json`;

  await fsp.mkdir(outDir, { recursive: true });
  const artifactPath = path.join(outDir, artifactFilename);
  const artifactBody = canonicalJson(artifact);
  await fsp.writeFile(artifactPath, artifactBody, 'utf8');
  const artifactStats = fs.statSync(artifactPath);

  const rawEntry = resultManifestEntry(resultPath, resultsDir, result, 'memory-arena');
  assertResultMatchesRunManifest(baseManifest, rawEntry);
  const generatedResultPrefix = `docs/benchmarks/results/${path.basename(resultsDir)}/`;
  const git = gitInfo(repoRoot, result, [generatedResultPrefix]);
  const publicEntry = {
    path: artifactFilename,
    sha256: sha256String(artifactBody),
    sizeBytes: artifactStats.size,
    resultId: result.meta.id,
    benchmark: 'memory-arena',
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
  const qmdCollection = result.config?.remnicConfig?.qmdCollection;
  const manifestWithoutHash = {
    schemaVersion: 1,
    generatedAt,
    run: {
      id: baseManifest.run?.id ?? path.basename(resultsDir),
      mode: 'full',
      selectedBenchmarks: ['memory-arena'],
      runtimeProfiles: ['real'],
      seed: result.meta.seeds?.[0] ?? 1,
    },
    git,
    command: {
      cwd: '<repo-root>',
      argv: sanitizeArgv(baseManifest.command?.argv, replacements),
      envKeys: Array.isArray(baseManifest.command?.envKeys) ? [...baseManifest.command.envKeys].sort() : ['OPENAI_API_KEY'],
    },
    environment: {
      platform: result.environment?.os ?? process.platform,
      arch: result.environment?.hardware ?? process.arch,
      nodeVersion: result.environment?.nodeVersion ?? process.version,
      ...(baseManifest.environment?.packageManager ? { packageManager: baseManifest.environment.packageManager } : {}),
    },
    ...(typeof qmdCollection === 'string' && qmdCollection.length > 0
      ? { qmd: { collections: [qmdCollection] } }
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
  const manifestPath = path.join(outDir, 'MANIFEST.memory-arena.json');
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const diagnostics = buildDiagnosticsSummary(resultsDir, manifest.run.id, 'memory-arena', startedAt, finishedAt, generatedAt);
  assertCodexDiagnostics(diagnostics, result.results.tasks.length);
  const diagnosticsPath = path.join(outDir, 'memory-arena-diagnostics-summary.json');
  await fsp.writeFile(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');

  const comparisonPath = path.join(outDir, 'memory-arena-sota-comparison.json');
  await fsp.writeFile(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    ok: true,
    outDir,
    artifactPath,
    manifestPath,
    diagnosticsPath,
    comparisonPath,
    artifactSha256: publicEntry.sha256,
    rawResultSha256: rawEntry.sha256,
    taskCount: result.results.tasks.length,
    official: derived.official,
    sotaAllCheckedMetrics: comparison.sotaAllCheckedMetrics,
    atOrAboveAllCheckedMetrics: comparison.atOrAboveAllCheckedMetrics,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
