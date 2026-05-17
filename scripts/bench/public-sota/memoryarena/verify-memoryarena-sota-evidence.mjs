#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareMemoryArenaSota } from './compare-memoryarena-sota.mjs';
import { deriveMemoryArenaOfficialMetrics } from './derive-memoryarena-official-metrics.mjs';
import {
  manifestArtifactHashIdentity,
  sha256File,
  sha256String,
  stableStringify,
} from '../evidence-integrity.mjs';
import {
  assert,
  assertClose,
  assertCodexDiagnostics,
  assertPublicSafeArtifact,
  compareJson,
  readJson,
} from '../evidence-run-utils.mjs';

const publicSotaDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_TARGET_MAP = path.join(publicSotaDir, 'current-target-map.json');

const [evidenceDir = '.', targetMapPath = DEFAULT_TARGET_MAP] = process.argv.slice(2);

function toPseudoRawResult(artifact) {
  return {
    meta: {
      benchmark: 'memory-arena',
      mode: 'full',
      gitSha: artifact.system?.gitSha,
    },
    results: {
      tasks: (artifact.perTaskScores ?? []).map((task) => ({
        taskId: task.taskId,
        scores: task.scores,
        details: task.memoryArena,
      })),
      aggregates: {},
    },
  };
}

function officialMetricsForPublicComparison(derived) {
  return {
    benchmark: derived.benchmark,
    mode: derived.mode,
    gitSha: derived.gitSha,
    taskCount: derived.taskCount,
    scoredSubtasks: derived.scoredSubtasks,
    official: derived.official,
    byDomain: derived.byDomain,
  };
}

const manifestPath = path.join(evidenceDir, 'MANIFEST.memory-arena.json');
const comparisonPath = path.join(evidenceDir, 'memory-arena-sota-comparison.json');
const diagnosticsPath = path.join(evidenceDir, 'memory-arena-diagnostics-summary.json');

const manifest = readJson(manifestPath);
const publicArtifactEntry = manifest.publicArtifacts?.find((entry) => entry.benchmark === 'memory-arena');
const rawResultEntry = manifest.results?.find((entry) => entry.benchmark === 'memory-arena');
assert(publicArtifactEntry, 'manifest must include memory-arena public artifact');
assert(rawResultEntry, 'manifest must include memory-arena raw result entry');

const artifactPath = path.join(evidenceDir, publicArtifactEntry.path);
const artifact = readJson(artifactPath);
const targetMap = readJson(targetMapPath);
const comparison = readJson(comparisonPath);
assert(fs.existsSync(diagnosticsPath), 'diagnostics summary is required to prove provider/model/reasoning/service-tier');
const diagnostics = readJson(diagnosticsPath);

assert(manifest.schemaVersion === 1, 'manifest schemaVersion must be 1');
assert(manifest.run?.mode === 'full', 'manifest run.mode must be full');
assert(JSON.stringify(manifest.run?.selectedBenchmarks) === JSON.stringify(['memory-arena']), 'manifest must select only memory-arena');
assert(JSON.stringify(manifest.run?.runtimeProfiles) === JSON.stringify(['real']), 'manifest runtimeProfiles must be real');
assert(manifest.git?.dirty === false, 'manifest git must be clean');
assert(manifest.command?.cwd === '<repo-root>', 'manifest cwd must be scrubbed');
assert(!JSON.stringify(manifest).includes('/Users/'), 'manifest must not contain /Users paths');
assert(!JSON.stringify(manifest).includes('MacStudio'), 'manifest must not contain local hostnames');
assert(
  sha256String(stableStringify(manifestArtifactHashIdentity(manifest))) === manifest.artifactHash,
  'manifest artifactHash mismatch',
);

assert(artifact.schemaVersion === 1, 'artifact schemaVersion must be 1');
assert(artifact.benchmarkId === 'memory-arena', 'artifact benchmarkId must be memory-arena');
assert(artifact.system?.name === 'remnic', 'artifact system.name must be remnic');
assert(artifact.system?.gitSha === manifest.git?.commit, 'artifact git SHA must match manifest commit');
assert(artifact.model === 'gpt-5.5', 'artifact model must be gpt-5.5');
assert(artifact.seed === 1, 'artifact seed must be 1');
assert(Array.isArray(artifact.perTaskScores) && artifact.perTaskScores.length > 0, 'artifact must include perTaskScores');
assertPublicSafeArtifact(artifact);
assert(publicArtifactEntry.publicSafe === true, 'public artifact entry must be publicSafe');
assert(publicArtifactEntry.gitSha === manifest.git?.commit, 'public artifact git SHA must match manifest commit');
assert(publicArtifactEntry.sha256 === sha256File(artifactPath), 'public artifact sha256 mismatch');
assert(publicArtifactEntry.taskCount === artifact.perTaskScores.length, 'public artifact taskCount mismatch');
assert(publicArtifactEntry.sourceResultPath === rawResultEntry.path, 'source result path mismatch');
assert(publicArtifactEntry.sourceResultSha256 === rawResultEntry.sha256, 'source result sha mismatch');
assert(publicArtifactEntry.sourceResultSizeBytes === rawResultEntry.sizeBytes, 'source result size mismatch');
assert(rawResultEntry.gitSha === manifest.git?.commit, 'raw result git SHA must match manifest commit');
assert(rawResultEntry.mode === 'full', 'raw result manifest entry must be full');
assert(rawResultEntry.taskCount === artifact.perTaskScores.length, 'raw result taskCount mismatch');

const pseudoRawResult = toPseudoRawResult(artifact);
const derived = deriveMemoryArenaOfficialMetrics(pseudoRawResult);
compareJson(
  officialMetricsForPublicComparison(artifact.memoryArenaOfficialMetrics),
  officialMetricsForPublicComparison(derived),
  'official metrics',
);
assertClose(artifact.metrics?.memory_arena_official_success_rate, derived.official.successRate, 'official success rate');
assertClose(artifact.metrics?.memory_arena_official_progress_score, derived.official.progressScore, 'official progress score');
if (typeof derived.official.softProgressScore === 'number') {
  assertClose(artifact.metrics?.memory_arena_official_soft_progress_score, derived.official.softProgressScore, 'official soft progress score');
}

const recomputedComparison = compareMemoryArenaSota(pseudoRawResult, targetMap);
compareJson(comparison, recomputedComparison, 'SOTA comparison');
assert(comparison.sotaAllCheckedMetrics === true, 'memory-arena comparison must beat all checked metrics for SOTA publication');

assert(diagnostics.runId === manifest.run?.id, 'diagnostics runId must match manifest');
assert(diagnostics.benchmark === 'memory-arena', 'diagnostics benchmark must be memory-arena');
assertCodexDiagnostics(diagnostics, artifact.perTaskScores.length);

console.log(JSON.stringify({
  ok: true,
  benchmark: 'memory-arena',
  taskCount: artifact.perTaskScores.length,
  official: derived.official,
  checks: comparison.checks.length,
  artifactSha256: publicArtifactEntry.sha256,
  rawResultSha256: rawResultEntry.sha256,
}, null, 2));
