#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { comparePublicBenchmarkSota } from './compare-public-benchmark-sota.mjs';
import {
  manifestArtifactHashIdentity,
  sha256File,
  sha256String,
  stableStringify,
} from './evidence-integrity.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET_MAP = path.join(scriptDir, 'current-target-map.json');

const [evidenceDir = '.', targetMapPath = DEFAULT_TARGET_MAP, benchmarkArg] = process.argv.slice(2);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertClose(actual, expected, label) {
  assert(typeof actual === 'number' && Number.isFinite(actual), `${label} must be finite`);
  assert(typeof expected === 'number' && Number.isFinite(expected), `${label} expected must be finite`);
  assert(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, got ${actual}`);
}

function compareJson(actual, expected, label) {
  assert(stableStringify(actual) === stableStringify(expected), `${label} mismatch`);
}

function findManifest(dir, requestedBenchmark) {
  if (requestedBenchmark) {
    return path.join(dir, `MANIFEST.${requestedBenchmark}.json`);
  }
  const matches = fs.readdirSync(dir)
    .filter((name) => /^MANIFEST\.[^.]+\.json$/.test(name) && name !== 'MANIFEST.memory-arena.json')
    .sort();
  assert(matches.length === 1, `expected exactly one generic benchmark manifest, found ${matches.length}`);
  return path.join(dir, matches[0]);
}

function aggregateObjects(metrics, comparison) {
  const out = Object.fromEntries(
    Object.entries(metrics ?? {})
      .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
      .map(([metric, value]) => [metric, { mean: value }]),
  );
  for (const check of comparison?.checks ?? []) {
    if (
      check?.metric === 'memoryagentbench_overall_score' &&
      typeof check.sourceMetric === 'string' &&
      typeof check.units === 'string' &&
      out[check.sourceMetric]
    ) {
      out[check.sourceMetric] = {
        ...out[check.sourceMetric],
        units: check.units,
      };
    }
  }
  return out;
}

function pseudoRawResultFromArtifact(artifact, comparison) {
  return {
    meta: {
      benchmark: artifact.benchmarkId,
      mode: 'full',
      gitSha: artifact.system?.gitSha,
    },
    results: {
      tasks: (artifact.perTaskScores ?? []).map((task) => ({
        taskId: task.taskId,
        scores: task.scores,
        details: task.details,
      })),
      aggregates: aggregateObjects(artifact.metrics, comparison),
    },
  };
}

function mean(values) {
  assert(values.length > 0, 'cannot average an empty list');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function recomputeMetricMeans(artifact) {
  const byMetric = new Map();
  for (const task of artifact.perTaskScores ?? []) {
    for (const [metric, score] of Object.entries(task.scores ?? {})) {
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        continue;
      }
      const values = byMetric.get(metric) ?? [];
      values.push(score);
      byMetric.set(metric, values);
    }
  }

  const out = Object.fromEntries(
    Array.from(byMetric.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([metric, values]) => [metric, mean(values)]),
  );

  return out;
}

function assertPublicSafeArtifact(artifact) {
  const forbiddenKeys = new Set([
    'answer',
    'answers',
    'answerContext',
    'context',
    'expected',
    'expectedAnswer',
    'expectedAnswers',
    'expectedChoiceIndex',
    'gold',
    'groundTruth',
    'messages',
    'modelAnswer',
    'modelResponse',
    'predictedMcqOption',
    'prompt',
    'question',
    'recalledText',
    'response',
    'selectedChoiceIndex',
    'text',
    'transcript',
  ]);

  function walk(value, pathLabel) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${pathLabel}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string') {
        assert(value.length <= 512, `${pathLabel} string is too long for public-safe score metadata`);
        assert(!value.includes('/Users/'), `${pathLabel} contains local /Users path`);
      }
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      assert(!forbiddenKeys.has(key), `${pathLabel}.${key} is not public-safe`);
      walk(entry, `${pathLabel}.${key}`);
    }
  }

  walk(artifact.perTaskScores, 'artifact.perTaskScores');
}

const manifestPath = findManifest(evidenceDir, benchmarkArg);
const manifest = readJson(manifestPath);
const benchmark = manifest.run?.selectedBenchmarks?.[0];
assert(typeof benchmark === 'string' && benchmark.length > 0, 'manifest must select one benchmark');
assert(benchmark !== 'memory-arena', 'use the MemoryArena-specific verifier for memory-arena');

const publicArtifactEntry = manifest.publicArtifacts?.find((entry) => entry.benchmark === benchmark);
const rawResultEntry = manifest.results?.find((entry) => entry.benchmark === benchmark);
assert(publicArtifactEntry, 'manifest must include public artifact entry');
assert(rawResultEntry, 'manifest must include raw result entry');

const artifactPath = path.join(evidenceDir, publicArtifactEntry.path);
const comparisonPath = path.join(evidenceDir, `${benchmark}-sota-comparison.json`);
const diagnosticsPath = path.join(evidenceDir, `${benchmark}-diagnostics-summary.json`);
const artifact = readJson(artifactPath);
const comparison = readJson(comparisonPath);
const targetMap = readJson(targetMapPath);
assert(fs.existsSync(diagnosticsPath), 'diagnostics summary is required to prove provider/model/reasoning/service-tier');
const diagnostics = readJson(diagnosticsPath);

assert(manifest.schemaVersion === 1, 'manifest schemaVersion must be 1');
assert(manifest.run?.mode === 'full', 'manifest run.mode must be full');
assert(JSON.stringify(manifest.run?.selectedBenchmarks) === JSON.stringify([benchmark]), 'manifest must select one benchmark');
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
assert(artifact.benchmarkId === benchmark, `artifact benchmarkId must be ${benchmark}`);
assert(artifact.system?.name === 'remnic', 'artifact system.name must be remnic');
assert(artifact.system?.gitSha === manifest.git?.commit, 'artifact git SHA must match manifest commit');
assert(artifact.model === 'gpt-5.5', 'artifact model must be gpt-5.5');
assert(artifact.seed === 1, 'artifact seed must be 1');
assert(Array.isArray(artifact.perTaskScores) && artifact.perTaskScores.length > 0, 'artifact must include perTaskScores');
assertPublicSafeArtifact(artifact);

assert(publicArtifactEntry.publicSafe === true, 'manifest public artifact must be marked publicSafe');
assert(publicArtifactEntry.sha256 === sha256File(artifactPath), 'public artifact sha256 mismatch');
assert(publicArtifactEntry.taskCount === artifact.perTaskScores.length, 'public artifact taskCount mismatch');
assert(publicArtifactEntry.sourceResultPath === rawResultEntry.path, 'source result path mismatch');
assert(publicArtifactEntry.sourceResultSha256 === rawResultEntry.sha256, 'source result sha mismatch');
assert(publicArtifactEntry.sourceResultSizeBytes === rawResultEntry.sizeBytes, 'source result size mismatch');
assert(publicArtifactEntry.gitSha === manifest.git?.commit, 'public artifact git SHA must match manifest commit');
assert(rawResultEntry.gitSha === manifest.git?.commit, 'raw result git SHA must match manifest commit');
assert(rawResultEntry.mode === 'full', 'raw result manifest entry must be full');

const recomputedMetricMeans = recomputeMetricMeans(artifact);
for (const [metric, recomputed] of Object.entries(recomputedMetricMeans)) {
  if (Object.prototype.hasOwnProperty.call(artifact.metrics ?? {}, metric)) {
    assertClose(artifact.metrics[metric], recomputed, `metric ${metric}`);
  }
}

const pseudoRawResult = pseudoRawResultFromArtifact(artifact, comparison);
const recomputedComparison = comparePublicBenchmarkSota(pseudoRawResult, targetMap);
compareJson(comparison, recomputedComparison, 'SOTA comparison');
assert(comparison.sotaAllCheckedMetrics === true, `${benchmark} comparison must beat all publishable metrics for SOTA publication`);
for (const check of comparison.checks ?? []) {
  if (check.publishAsSota === false) {
    continue;
  }
  assert(check.sota === true, `${check.metric} must beat target for SOTA claim`);
}

assert(diagnostics.runId === manifest.run?.id, 'diagnostics runId must match manifest');
assert(diagnostics.benchmark === benchmark, `diagnostics benchmark must be ${benchmark}`);
assert(diagnostics.checked > 0, 'diagnostics must include at least one completed record');
assert(diagnostics.complete === diagnostics.checked, 'diagnostics complete count must match checked records');
assert(diagnostics.inFlight === 0, 'diagnostics must have zero in-flight records');
assert(diagnostics.afterCutoff === 0, 'diagnostics must have zero after-cutoff records');
assert(diagnostics.invalidTimestamps === 0, 'diagnostics must have zero invalid timestamps');
assert(diagnostics.errored === 0, 'diagnostics must have zero errors');
assert(diagnostics.nonzero === 0, 'diagnostics must have zero nonzero exits');
assert(diagnostics.providers?.['codex-cli'] === diagnostics.checked, 'diagnostics provider distribution must be all codex-cli');
assert(diagnostics.models?.['gpt-5.5'] === diagnostics.checked, 'diagnostics model distribution must be all gpt-5.5');
assert(diagnostics.reasoningEfforts?.xhigh === diagnostics.checked, 'diagnostics reasoning distribution must be all xhigh');
assert(diagnostics.serviceTiers?.fast === diagnostics.checked, 'diagnostics service tier distribution must be all fast');

console.log(JSON.stringify({
  ok: true,
  benchmark,
  taskCount: artifact.perTaskScores.length,
  metrics: artifact.metrics,
  checks: comparison.checks.length,
  artifactSha256: publicArtifactEntry.sha256,
  rawResultSha256: rawResultEntry.sha256,
}, null, 2));
