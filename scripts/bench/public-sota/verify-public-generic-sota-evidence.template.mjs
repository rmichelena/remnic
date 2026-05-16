#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [evidenceDir = '.', benchmarkArg] = process.argv.slice(2);
const FLOAT_EPSILON = 1e-9;

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

function assertClose(actual, expected, label) {
  assert(typeof actual === 'number' && Number.isFinite(actual), `${label} must be finite`);
  assert(typeof expected === 'number' && Number.isFinite(expected), `${label} expected must be finite`);
  assert(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, got ${actual}`);
}

function compareJson(actual, expected, label) {
  assert(stableStringify(actual) === stableStringify(expected), `${label} mismatch`);
}

function mean(values) {
  assert(values.length > 0, 'cannot average an empty list');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteScore(value, label) {
  assert(typeof value === 'number' && Number.isFinite(value), `${label} must be finite`);
  return value;
}

function metricResult(metric, actual, target, meta = {}) {
  return {
    metric,
    actual,
    target,
    delta: actual - target,
    sota: actual > target,
    tied: actual === target,
    ...meta,
  };
}

function taskScores(result, metric, predicate = () => true) {
  return (result.results?.tasks ?? [])
    .filter(predicate)
    .map((task) => task.scores?.[metric])
    .filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function metricFromTasks(result, metric, predicate = () => true) {
  const values = taskScores(result, metric, predicate);
  assert(values.length > 0, `no scored tasks for ${metric}`);
  return mean(values);
}

function aggregateMean(result, metric) {
  return finiteScore(result.results?.aggregates?.[metric]?.mean, `aggregate ${metric}.mean`);
}

function sourceMatches(task, pattern) {
  return pattern.test(String(task.details?.source ?? task.taskId ?? '').toLowerCase());
}

function normalizeSplit(value) {
  return String(value ?? '').trim().toLowerCase();
}

function compareAMemGym(result, targets) {
  const actual = result.results?.aggregates?.normalized_memory_score?.mean
    ?? result.results?.aggregates?.memory_score?.mean
    ?? result.results?.aggregates?.qa_accuracy?.mean;
  return [
    metricResult(
      'amemgym_memory_agent_score',
      finiteScore(actual, 'AMemGym score'),
      finiteScore(targets.memoryAgent?.score, 'AMemGym memory-agent target'),
      { comparisonClass: 'memory-agent' },
    ),
    metricResult(
      'amemgym_native_llm_score_reference',
      finiteScore(actual, 'AMemGym score'),
      finiteScore(targets.nativeLlm?.score, 'AMemGym native target'),
      {
        comparisonClass: 'native-llm-reference',
        publishAsSota: false,
        note: 'Reference only; Remnic memory-system SOTA should be judged against the memory-agent class unless making a model-only claim.',
      },
    ),
  ];
}

function compareLongMemEval(result, targets) {
  const actual = result.results?.aggregates?.judge_accuracy?.mean
    ?? result.results?.aggregates?.llm_judge?.mean;
  return [
    metricResult('longmemeval_s_accuracy', finiteScore(actual, 'LongMemEval judge accuracy'), finiteScore(targets.target?.score, 'LongMemEval target')),
  ];
}

function compareLoCoMo(result, targets) {
  const actual = result.results?.aggregates?.judge_accuracy?.mean
    ?? result.results?.aggregates?.llm_judge?.mean;
  return [
    metricResult('locomo10_accuracy', finiteScore(actual, 'LoCoMo judge accuracy'), finiteScore(targets.target?.score, 'LoCoMo target')),
  ];
}

function compareBeam(result, targets) {
  const checks = [];
  for (const [split, targetEntry] of Object.entries(targets)) {
    const splitKey = normalizeSplit(split);
    const values = taskScores(result, 'llm_judge', (task) =>
      normalizeSplit(task.details?.scale) === splitKey ||
      String(task.taskId ?? '').toLowerCase().startsWith(`${splitKey}-`),
    );
    const fallbackValues = values.length > 0
      ? values
      : taskScores(result, 'rubric_coverage', (task) =>
          normalizeSplit(task.details?.scale) === splitKey ||
          String(task.taskId ?? '').toLowerCase().startsWith(`${splitKey}-`),
        );
    assert(fallbackValues.length > 0, `no BEAM scored tasks for split ${split}`);
    checks.push(metricResult(`beam_${splitKey}`, mean(fallbackValues), finiteScore(targetEntry.score, `BEAM ${split} target`)));
  }
  return checks;
}

function comparePersonaMem(result, targets) {
  const checks = [];
  const missing = [];
  for (const [split, targetEntry] of Object.entries(targets)) {
    const splitKey = normalizeSplit(split);
    const values = taskScores(result, 'mcq_accuracy', (task) =>
      normalizeSplit(
        task.details?.split ??
          task.details?.contextWindow ??
          task.details?.chatHistoryWindow ??
          (task.details?.chatHistory32kLink ? '32k' : undefined),
      ) === splitKey ||
      String(task.taskId ?? '').toLowerCase().includes(splitKey),
    );
    if (values.length === 0) {
      missing.push(split);
      continue;
    }
    checks.push(metricResult(`personamem_${splitKey}_mcq_accuracy`, mean(values), finiteScore(targetEntry.score, `PersonaMem ${split} target`)));
  }
  assert(missing.length === 0, `PersonaMem result missing target split(s): ${missing.join(', ')}`);
  return checks;
}

function memoryAgentBenchPercent(metricName, aggregate) {
  const value = finiteScore(aggregate?.mean, `MemoryAgentBench ${metricName}.mean`);
  const units = String(aggregate?.units ?? aggregate?.unit ?? aggregate?.scale ?? '').toLowerCase();
  if (units === 'percent' || units === 'percentage') {
    return value;
  }
  if (units === 'fraction' || units === 'ratio' || units === 'proportion') {
    return value * 100;
  }
  // Remnic benchmark aggregates are means of 0-1 task scores unless units say otherwise.
  if (metricName === 'memoryagentbench_overall_score' || metricName === 'overall_score') {
    return value * 100;
  }
  throw new Error(`MemoryAgentBench aggregate ${metricName} missing units`);
}

function compareMemoryAgentBench(result, targets) {
  const overallAggregate = [
    ['memoryagentbench_overall_score', result.results?.aggregates?.memoryagentbench_overall_score],
    ['overall_score', result.results?.aggregates?.overall_score],
  ].find(([, aggregate]) => typeof aggregate?.mean === 'number' && Number.isFinite(aggregate.mean));
  if (overallAggregate) {
    const [metricName, aggregate] = overallAggregate;
    return [
      metricResult(
        'memoryagentbench_overall_score',
        memoryAgentBenchPercent(metricName, aggregate),
        finiteScore(targets.overallScore?.score, 'MemoryAgentBench overall target'),
        { units: 'percent', sourceMetric: metricName },
      ),
    ];
  }

  const protocolReady = metricFromTasks(result, 'official_protocol_ready');
  assert(protocolReady >= 1 - FLOAT_EPSILON, `MemoryAgentBench official_protocol_ready must be 1, got ${protocolReady}`);

  const table = memoryAgentBenchTable3Metrics(result);
  return [
    metricResult(
      'memoryagentbench_table3_overall_score',
      table.overallScore,
      finiteScore(targets.overallScore?.score, 'MemoryAgentBench overall target'),
      {
        units: 'percent',
        sourceLabel: 'MemoryAgentBench paper Table 3 overall score formula',
        categoryAverages: table.categoryAverages,
        datasetScores: table.datasetScores,
      },
    ),
    metricResult(
      'memoryagentbench_table3_strongest_memory_agent_overall_score',
      table.overallScore,
      finiteScore(targets.strongestMemoryAgentOverall?.score, 'MemoryAgentBench strongest memory-agent target'),
      {
        units: 'percent',
        comparisonClass: 'memory-agent',
        sourceLabel: 'MemoryAgentBench paper Table 3 strongest agentic memory-agent score',
      },
    ),
  ];
}

function memoryAgentBenchTable3Metrics(result) {
  const percent = (value) => value * 100;
  const source = (pattern) => (task) => sourceMatches(task, pattern);
  const protocol = (name) => (task) => String(task.details?.officialProtocol ?? '').toLowerCase() === name;
  const any = (...predicates) => (task) => predicates.some((predicate) => predicate(task));

  const datasetScores = {
    shDocQa: percent(metricFromTasks(result, 'official_exact_match', source(/^ruler_qa1_/))),
    mhDocQa: percent(metricFromTasks(result, 'official_exact_match', source(/^ruler_qa2_/))),
    longMemEvalSStar: percent(metricFromTasks(result, 'official_exact_match', source(/^longmemeval/))),
    eventQa: percent(metricFromTasks(result, 'eventqa_recall', any(source(/^eventqa/), protocol('eventqa')))),
    mcc: percent(metricFromTasks(result, 'official_exact_match', source(/^icl_/))),
    recommendation: percent(metricFromTasks(result, 'recsys_recall_at_5', any(source(/^recsys_/), protocol('recsys_redial')))),
    summarization: percent(metricFromTasks(result, 'official_f1', source(/^infbench_sum/))),
    detectiveQa: percent(metricFromTasks(result, 'official_exact_match', source(/^detective_/))),
    factConsolidationSingleHop: percent(metricFromTasks(result, 'official_exact_match', source(/^factconsolidation_sh_/))),
    factConsolidationMultiHop: percent(metricFromTasks(result, 'official_exact_match', source(/^factconsolidation_mh_/))),
  };

  const categoryAverages = {
    accurateRetrieval: mean([datasetScores.shDocQa, datasetScores.mhDocQa, datasetScores.longMemEvalSStar, datasetScores.eventQa]),
    testTimeLearning: mean([datasetScores.mcc, datasetScores.recommendation]),
    longRangeUnderstanding: mean([datasetScores.summarization, datasetScores.detectiveQa]),
    selectiveForgetting: mean([datasetScores.factConsolidationSingleHop, datasetScores.factConsolidationMultiHop]),
  };

  return {
    datasetScores,
    categoryAverages,
    overallScore: mean(Object.values(categoryAverages)),
  };
}

function compareMemBench(result, targets) {
  const mapping = {
    FirstAgentLowLevel: 'membench_accuracy_factual_participant',
    ThirdAgentLowLevel: 'membench_accuracy_factual_observation',
    FirstAgentHighLevel: 'membench_accuracy_reflective_participant',
    ThirdAgentHighLevel: 'membench_accuracy_reflective_observation',
  };
  return Object.entries(mapping).map(([targetName, metric]) =>
    metricResult(metric, aggregateMean(result, metric), finiteScore(targets[targetName]?.score, `MemBench ${targetName} target`)),
  );
}

function comparePublicBenchmarkSota(result, targetMap) {
  const benchmark = result.meta?.benchmark ?? result.benchmarkId;
  assert(typeof benchmark === 'string' && benchmark.length > 0, 'result missing benchmark id');
  const entry = targetMap.benchmarks?.[benchmark];
  const targets = entry?.targets ?? entry;
  assert(targets, `target map missing ${benchmark}`);

  const checks = {
    amemgym: compareAMemGym,
    longmemeval: compareLongMemEval,
    locomo: compareLoCoMo,
    beam: compareBeam,
    personamem: comparePersonaMem,
    memoryagentbench: compareMemoryAgentBench,
    membench: compareMemBench,
  }[benchmark]?.(result, targets);
  assert(Array.isArray(checks), `unsupported benchmark ${benchmark}`);

  return {
    benchmark,
    gitSha: result.meta?.gitSha ?? result.system?.gitSha,
    taskCount: result.results?.tasks?.length ?? result.perTaskScores?.length,
    checks,
    sotaAllCheckedMetrics: checks.filter((check) => check.publishAsSota !== false).every((check) => check.sota),
    atOrAboveAllCheckedMetrics: checks.filter((check) => check.publishAsSota !== false).every((check) => check.sota || check.tied),
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

function aggregateObjects(metrics) {
  return Object.fromEntries(
    Object.entries(metrics ?? {})
      .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
      .map(([metric, value]) => [metric, { mean: value }]),
  );
}

function pseudoRawResultFromArtifact(artifact) {
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
      aggregates: aggregateObjects(artifact.metrics),
    },
  };
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

  if (artifact.benchmarkId === 'membench') {
    const groups = {
      membench_accuracy_factual_participant: [],
      membench_accuracy_factual_observation: [],
      membench_accuracy_reflective_participant: [],
      membench_accuracy_reflective_observation: [],
    };
    for (const task of artifact.perTaskScores ?? []) {
      const value = task.scores?.membench_accuracy;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        continue;
      }
      const memoryType = String(task.details?.memoryType ?? '').toLowerCase();
      const scenario = String(task.details?.scenario ?? '').toLowerCase();
      if (memoryType === 'factual' && scenario === 'participant') {
        groups.membench_accuracy_factual_participant.push(value);
      } else if (memoryType === 'factual' && scenario === 'observation') {
        groups.membench_accuracy_factual_observation.push(value);
      } else if (memoryType === 'reflective' && scenario === 'participant') {
        groups.membench_accuracy_reflective_participant.push(value);
      } else if (memoryType === 'reflective' && scenario === 'observation') {
        groups.membench_accuracy_reflective_observation.push(value);
      }
    }
    for (const [metric, values] of Object.entries(groups)) {
      if (values.length > 0) {
        out[metric] = mean(values);
      }
    }
  }

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
const targetMapPath = path.join(evidenceDir, 'current-target-map.json');
const artifact = readJson(artifactPath);
const comparison = readJson(comparisonPath);
const diagnostics = readJson(diagnosticsPath);
const targetMap = readJson(targetMapPath);
assert(Object.prototype.hasOwnProperty.call(targetMap.benchmarks ?? {}, benchmark), `unsupported benchmark ${benchmark}`);

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
assert(rawResultEntry.mode === 'full', 'raw result manifest entry must be full');

const recomputedMetricMeans = recomputeMetricMeans(artifact);
for (const [metric, recomputed] of Object.entries(recomputedMetricMeans)) {
  if (Object.prototype.hasOwnProperty.call(artifact.metrics ?? {}, metric)) {
    assertClose(artifact.metrics[metric], recomputed, `metric ${metric}`);
  }
}

const pseudoRawResult = pseudoRawResultFromArtifact(artifact);
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
