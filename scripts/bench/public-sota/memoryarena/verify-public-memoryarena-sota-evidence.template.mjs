#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_EVIDENCE_DIR = 'docs/benchmarks/results/public-matrix-codex-bf9b2643-20260515T052919Z';
const evidenceDir = process.argv[2] ?? DEFAULT_EVIDENCE_DIR;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256String(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertClose(actual, expected, label) {
  assert(typeof actual === 'number' && Number.isFinite(actual), `${label} must be finite`);
  assert(typeof expected === 'number' && Number.isFinite(expected), `${label} expected must be finite`);
  assert(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, got ${actual}`);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function compareJson(actual, expected, label) {
  assert(stableStringify(actual) === stableStringify(expected), `${label} mismatch`);
}

function mean(values) {
  assert(values.length > 0, 'cannot average an empty list');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function taskKey(task) {
  const domain = String(task.details?.domain ?? '');
  const id = task.details?.taskId;
  assert(domain.length > 0, `missing details.domain on ${task.taskId ?? '<unknown>'}`);
  assert(Number.isInteger(id), `missing integer details.taskId on ${task.taskId ?? '<unknown>'}`);
  return `${domain}:${id}`;
}

function deriveMemoryArenaOfficialMetrics(result) {
  assert(result.meta?.benchmark === 'memory-arena', 'result must be memory-arena');
  assert(result.meta?.mode === 'full', 'result must be full mode');
  assert(Array.isArray(result.results?.tasks), 'result must contain tasks');

  const tasksByKey = new Map();
  for (const task of result.results.tasks) {
    const key = taskKey(task);
    const domain = String(task.details.domain);
    const taskId = Number(task.details.taskId);
    const subtaskIndex = Number(task.details.subtaskIndex);
    assert(Number.isInteger(subtaskIndex), `missing integer subtaskIndex on ${task.taskId}`);

    const processScore = task.scores?.process_score;
    assert(
      typeof processScore === 'number' && Number.isFinite(processScore),
      `missing finite process_score on ${task.taskId}`,
    );

    const entry = tasksByKey.get(key) ?? {
      key,
      domain,
      taskId,
      subtasks: [],
      taskSuccessRate: undefined,
    };
    entry.subtasks.push({ subtaskIndex, processScore, scores: task.scores ?? {} });
    if (typeof task.scores?.task_success_rate === 'number') {
      entry.taskSuccessRate = task.scores.task_success_rate;
    }
    tasksByKey.set(key, entry);
  }

  const taskRows = [...tasksByKey.values()].map((task) => {
    task.subtasks.sort((a, b) => a.subtaskIndex - b.subtaskIndex);
    const duplicate = task.subtasks.find((subtask, index) =>
      index > 0 && subtask.subtaskIndex === task.subtasks[index - 1].subtaskIndex,
    );
    assert(!duplicate, `duplicate scored subtask ${duplicate?.subtaskIndex} for ${task.key}`);

    const passed = task.subtasks.filter((subtask) => subtask.processScore >= 1).length;
    const progressScore = passed / task.subtasks.length;
    const final = task.subtasks.at(-1);
    const successRate = typeof task.taskSuccessRate === 'number'
      ? task.taskSuccessRate
      : (final?.processScore ?? 0);

    const planRecallValues = task.subtasks
      .map((subtask) => subtask.scores.plan_field_recall)
      .filter((value) => typeof value === 'number' && Number.isFinite(value));
    const softProcessValues = task.subtasks
      .map((subtask) => subtask.scores.soft_process_score)
      .filter((value) => typeof value === 'number' && Number.isFinite(value));

    return {
      key: task.key,
      domain: task.domain,
      taskId: task.taskId,
      scoredSubtasks: task.subtasks.length,
      passedSubtasks: passed,
      successRate,
      progressScore,
      ...(planRecallValues.length > 0 ? { softProgressScore: mean(planRecallValues) } : {}),
      ...(softProcessValues.length > 0 ? { hardTravelProcessScore: mean(softProcessValues) } : {}),
    };
  });

  const byDomain = new Map();
  for (const row of taskRows) {
    const rows = byDomain.get(row.domain) ?? [];
    rows.push(row);
    byDomain.set(row.domain, rows);
  }

  const domainRows = [...byDomain.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, rows]) => {
      const softRows = rows.filter((row) => typeof row.softProgressScore === 'number');
      const hardTravelRows = rows.filter((row) => typeof row.hardTravelProcessScore === 'number');
      return {
        domain,
        taskCount: rows.length,
        scoredSubtasks: rows.reduce((sum, row) => sum + row.scoredSubtasks, 0),
        successRate: mean(rows.map((row) => row.successRate)),
        progressScore: mean(rows.map((row) => row.progressScore)),
        ...(softRows.length > 0
          ? { softProgressScore: mean(softRows.map((row) => row.softProgressScore)) }
          : {}),
        ...(hardTravelRows.length > 0
          ? { hardTravelProcessScore: mean(hardTravelRows.map((row) => row.hardTravelProcessScore)) }
          : {}),
      };
    });

  const taskRowsWithSoftProgress = taskRows.filter((row) => typeof row.softProgressScore === 'number');

  return {
    benchmark: result.meta.benchmark,
    mode: result.meta.mode,
    gitSha: result.meta.gitSha,
    taskCount: taskRows.length,
    scoredSubtasks: result.results.tasks.length,
    official: {
      successRate: mean(taskRows.map((row) => row.successRate)),
      progressScore: mean(taskRows.map((row) => row.progressScore)),
      ...(taskRowsWithSoftProgress.length > 0
        ? { softProgressScore: mean(taskRowsWithSoftProgress.map((row) => row.softProgressScore)) }
        : {}),
    },
    byDomain: domainRows,
  };
}

function byDomain(derived, domain) {
  const row = derived.byDomain.find((entry) => entry.domain === domain);
  assert(row, `missing derived domain ${domain}`);
  return row;
}

function verdict(actual, target, metric) {
  assert(typeof actual === 'number' && Number.isFinite(actual), `${metric} actual must be finite`);
  assert(typeof target === 'number' && Number.isFinite(target), `${metric} target must be finite`);
  return {
    metric,
    actual,
    target,
    delta: actual - target,
    sota: actual > target,
    tied: actual === target,
  };
}

function compareMemoryArenaSota(result, targetMap) {
  const targets = targetMap.benchmarks?.['memory-arena']?.targets;
  assert(targets, 'target map missing memory-arena targets');
  const derived = deriveMemoryArenaOfficialMetrics(result);
  const bundled = byDomain(derived, 'bundled_shopping');
  const travel = byDomain(derived, 'group_travel_planner');
  const search = byDomain(derived, 'progressive_search');
  const math = byDomain(derived, 'formal_reasoning_math');
  const phys = byDomain(derived, 'formal_reasoning_phys');
  const formalProgressScore = (math.progressScore + phys.progressScore) / 2;

  const checks = [
    verdict(derived.official.successRate, targets.allTaskAverageSuccessRate?.score, 'all_task_average_success_rate'),
    verdict(bundled.successRate, targets.bundledWebShopping?.successRate, 'bundled_web_shopping_success_rate'),
    verdict(bundled.progressScore, targets.bundledWebShopping?.progressScore, 'bundled_web_shopping_progress_score'),
    verdict(travel.successRate, targets.groupTravelPlanning?.successRate, 'group_travel_planning_success_rate'),
    verdict(travel.progressScore, targets.groupTravelPlanning?.progressScore, 'group_travel_planning_progress_score'),
    verdict(travel.softProgressScore ?? 0, targets.groupTravelPlanning?.softProgressScore, 'group_travel_planning_soft_progress_score'),
    verdict(search.successRate, targets.progressiveWebSearch?.successRate, 'progressive_search_success_rate'),
    verdict(search.progressScore, targets.progressiveWebSearch?.progressScore, 'progressive_search_progress_score'),
    verdict(math.successRate, targets.formalReasoning?.mathSuccessRate, 'formal_reasoning_math_success_rate'),
    verdict(phys.successRate, targets.formalReasoning?.physSuccessRate, 'formal_reasoning_phys_success_rate'),
    verdict(formalProgressScore, targets.formalReasoning?.processScore, 'formal_reasoning_process_score'),
  ];

  return {
    benchmark: 'memory-arena',
    gitSha: derived.gitSha,
    taskCount: derived.taskCount,
    scoredSubtasks: derived.scoredSubtasks,
    official: derived.official,
    formalReasoning: {
      successRate: (math.successRate + phys.successRate) / 2,
      progressScore: formalProgressScore,
    },
    checks,
    sotaAllCheckedMetrics: checks.every((check) => check.sota),
    atOrAboveAllCheckedMetrics: checks.every((check) => check.sota || check.tied),
  };
}

function manifestArtifactHashIdentity(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    run: {
      id: manifest.run?.id,
      ...(manifest.run?.mode ? { mode: manifest.run.mode } : {}),
      selectedBenchmarks: manifest.run?.selectedBenchmarks,
      runtimeProfiles: manifest.run?.runtimeProfiles,
      ...(Object.prototype.hasOwnProperty.call(manifest.run ?? {}, 'limit') ? { limit: manifest.run.limit } : {}),
      ...(Object.prototype.hasOwnProperty.call(manifest.run ?? {}, 'seed') ? { seed: manifest.run.seed } : {}),
    },
    git: {
      commit: manifest.git?.commit,
      shortCommit: manifest.git?.shortCommit,
    },
    command: {
      argv: manifest.command?.argv,
      envKeys: manifest.command?.envKeys,
    },
    environment: {
      platform: manifest.environment?.platform,
      arch: manifest.environment?.arch,
      nodeVersion: manifest.environment?.nodeVersion,
      ...(manifest.environment?.packageManager ? { packageManager: manifest.environment.packageManager } : {}),
    },
    ...(manifest.qmd ? { qmd: manifest.qmd } : {}),
    configFiles: manifest.configFiles,
    datasets: manifest.datasets,
    results: manifest.results,
    ...(manifest.publicArtifacts ? { publicArtifacts: manifest.publicArtifacts } : {}),
  };
}

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

function officialMetricsForComparison(derived) {
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
const targetMapPath = path.join(evidenceDir, 'current-target-map.json');

const manifest = readJson(manifestPath);
const targetMap = readJson(targetMapPath);
const publicArtifactEntry = manifest.publicArtifacts?.find((entry) => entry.benchmark === 'memory-arena');
const rawResultEntry = manifest.results?.find((entry) => entry.benchmark === 'memory-arena');
assert(publicArtifactEntry, 'manifest must include memory-arena public artifact');
assert(rawResultEntry, 'manifest must include memory-arena raw result entry');

const artifactPath = path.join(evidenceDir, publicArtifactEntry.path);
const artifact = readJson(artifactPath);
const comparison = readJson(comparisonPath);
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
assert(artifact.model === 'gpt-5.5', 'artifact model must be gpt-5.5');
assert(artifact.seed === 1, 'artifact seed must be 1');
assert(Array.isArray(artifact.perTaskScores) && artifact.perTaskScores.length > 0, 'artifact must include perTaskScores');
assert(publicArtifactEntry.publicSafe === true, 'public artifact entry must be publicSafe');
assert(publicArtifactEntry.sha256 === sha256File(artifactPath), 'public artifact sha256 mismatch');
assert(publicArtifactEntry.taskCount === artifact.perTaskScores.length, 'public artifact taskCount mismatch');
assert(publicArtifactEntry.sourceResultPath === rawResultEntry.path, 'source result path mismatch');
assert(publicArtifactEntry.sourceResultSha256 === rawResultEntry.sha256, 'source result sha mismatch');
assert(publicArtifactEntry.sourceResultSizeBytes === rawResultEntry.sizeBytes, 'source result size mismatch');
assert(rawResultEntry.mode === 'full', 'raw result manifest entry must be full');

const pseudoRawResult = toPseudoRawResult(artifact);
const derived = deriveMemoryArenaOfficialMetrics(pseudoRawResult);
compareJson(
  officialMetricsForComparison(artifact.memoryArenaOfficialMetrics),
  officialMetricsForComparison(derived),
  'official metrics',
);
assertClose(artifact.metrics?.memory_arena_official_success_rate, derived.official.successRate, 'official success rate');
assertClose(artifact.metrics?.memory_arena_official_progress_score, derived.official.progressScore, 'official progress score');
if (typeof derived.official.softProgressScore === 'number') {
  assertClose(artifact.metrics?.memory_arena_official_soft_progress_score, derived.official.softProgressScore, 'official soft progress score');
}

const recomputedComparison = compareMemoryArenaSota(pseudoRawResult, targetMap);
compareJson(comparison, recomputedComparison, 'SOTA comparison');
assert(comparison.atOrAboveAllCheckedMetrics === true, 'memory-arena comparison must be at or above all checked metrics');

assert(diagnostics.runId === manifest.run?.id, 'diagnostics runId must match manifest');
assert(diagnostics.benchmark === 'memory-arena', 'diagnostics benchmark must be memory-arena');
assert(diagnostics.checked > 0, 'diagnostics must include at least one completed record');
assert(diagnostics.complete === diagnostics.checked, 'diagnostics complete count must match checked records');
assert(diagnostics.inFlight === 0, 'diagnostics must have zero in-flight records');
assert(diagnostics.errored === 0, 'diagnostics must have zero errors');
assert(diagnostics.nonzero === 0, 'diagnostics must have zero nonzero exits');
assert(diagnostics.providers?.['codex-cli'] === diagnostics.checked, 'diagnostics provider distribution must be all codex-cli');
assert(diagnostics.models?.['gpt-5.5'] === diagnostics.checked, 'diagnostics model distribution must be all gpt-5.5');
assert(diagnostics.reasoningEfforts?.xhigh === diagnostics.checked, 'diagnostics reasoning distribution must be all xhigh');
assert(diagnostics.serviceTiers?.fast === diagnostics.checked, 'diagnostics service tier distribution must be all fast');

console.log(JSON.stringify({
  ok: true,
  benchmark: 'memory-arena',
  taskCount: artifact.perTaskScores.length,
  official: derived.official,
  checks: comparison.checks.length,
  artifactSha256: publicArtifactEntry.sha256,
  rawResultSha256: rawResultEntry.sha256,
}, null, 2));
