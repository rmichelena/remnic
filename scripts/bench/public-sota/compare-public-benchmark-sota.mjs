#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { roundedJsonNumberReplacer } from './comparison-json.mjs';
import { compareMemoryArenaSota } from './memoryarena/compare-memoryarena-sota.mjs';
export { roundedJsonNumberReplacer } from './comparison-json.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET_MAP = path.join(scriptDir, 'current-target-map.json');
const FLOAT_EPSILON = 1e-9;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function mean(values) {
  assert(values.length > 0, 'cannot average an empty list');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteScore(value, label) {
  assert(typeof value === 'number' && Number.isFinite(value), `${label} must be finite`);
  return value;
}

function aggregateMean(result, metric) {
  return finiteScore(result.results?.aggregates?.[metric]?.mean, `aggregate ${metric}.mean`);
}

function taskScores(result, metric, predicate = () => true) {
  return (result.results?.tasks ?? [])
    .filter(predicate)
    .map((task) => task.scores?.[metric])
    .filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function scoredTasks(result, metric, predicate = () => true) {
  return (result.results?.tasks ?? [])
    .filter(predicate)
    .filter((task) => {
      const value = task.scores?.[metric];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    });
}

function metricFromTasks(result, metric, predicate = () => true) {
  const values = taskScores(result, metric, predicate);
  assert(values.length > 0, `no scored tasks for ${metric}`);
  return mean(values);
}

function metricResult(metric, actual, target, meta = {}) {
  const delta = actual - target;
  return {
    metric,
    actual,
    target,
    delta,
    sota: delta > FLOAT_EPSILON,
    tied: Math.abs(delta) <= FLOAT_EPSILON,
    ...meta,
  };
}

function sourceMatches(task, pattern) {
  return pattern.test(String(task.details?.source ?? task.taskId ?? '').toLowerCase());
}

function compareAmaBench(result, targets) {
  const actual = result.metrics?.ama_bench_leaderboard_average
    ?? result.results?.aggregates?.ama_bench_leaderboard_average?.mean
    ?? result.results?.aggregates?.ama_bench_recommended_accuracy?.mean;
  const target = targets.target?.score;
  return [metricResult('ama_bench_leaderboard_average', finiteScore(actual, 'AMA leaderboard average'), finiteScore(target, 'AMA target'))];
}

function amemGymActualMetric(result) {
  const [sourceMetric, actual] = [
    ['normalized_memory_score', result.results?.aggregates?.normalized_memory_score?.mean],
    ['memory_score', result.results?.aggregates?.memory_score?.mean],
    ['qa_accuracy', result.results?.aggregates?.qa_accuracy?.mean],
  ].find(([, value]) => typeof value === 'number' && Number.isFinite(value)) ?? [];
  assert(sourceMetric, 'AMemGym result missing normalized_memory_score, memory_score, and qa_accuracy aggregates');
  return {
    sourceMetric,
    actual: finiteScore(actual, `AMemGym ${sourceMetric}`),
  };
}

function compareAMemGym(result, targets) {
  const { actual, sourceMetric } = amemGymActualMetric(result);
  return [
    metricResult(
      'amemgym_memory_agent_score',
      actual,
      finiteScore(targets.memoryAgent?.score, 'AMemGym memory-agent target'),
      { comparisonClass: 'memory-agent', sourceMetric },
    ),
    metricResult(
      'amemgym_native_llm_score_reference',
      actual,
      finiteScore(targets.nativeLlm?.score, 'AMemGym native target'),
      {
        comparisonClass: 'native-llm-reference',
        sourceMetric,
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
    metricResult(
      'longmemeval_s_accuracy',
      finiteScore(actual, 'LongMemEval judge accuracy'),
      finiteScore(targets.target?.score, 'LongMemEval target'),
    ),
  ];
}

function compareLoCoMo(result, targets) {
  const actual = result.results?.aggregates?.judge_accuracy?.mean
    ?? result.results?.aggregates?.llm_judge?.mean;
  return [
    metricResult(
      'locomo10_accuracy',
      finiteScore(actual, 'LoCoMo judge accuracy'),
      finiteScore(targets.target?.score, 'LoCoMo target'),
    ),
  ];
}

function normalizeSplit(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function compareBeam(result, targets) {
  const checks = [];
  for (const [split, targetEntry] of Object.entries(targets)) {
    const splitKey = normalizeSplit(split);
    const splitPredicate = (task) =>
      normalizeSplit(task.details?.scale) === splitKey ||
      String(task.taskId ?? '').toLowerCase().startsWith(`${splitKey}-`);
    const splitTasks = (result.results?.tasks ?? []).filter(splitPredicate);
    assert(splitTasks.length > 0, `no BEAM tasks for split ${split}`);
    const llmJudgeTasks = scoredTasks(result, 'llm_judge', splitPredicate);
    const values = llmJudgeTasks.length === splitTasks.length
      ? llmJudgeTasks.map((task) => task.scores.llm_judge)
      : taskScores(result, 'rubric_coverage', splitPredicate);
    assert(values.length === splitTasks.length, `BEAM split ${split} missing complete llm_judge and rubric_coverage scores`);
    checks.push(metricResult(`beam_${splitKey}`, mean(values), finiteScore(targetEntry.score, `BEAM ${split} target`)));
  }
  return checks;
}

function comparePersonaMem(result, targets) {
  const supportedSplits = new Set(['32k']);
  const checks = [];
  for (const [split, targetEntry] of Object.entries(targets)) {
    const splitKey = normalizeSplit(split);
    if (!supportedSplits.has(splitKey)) {
      continue;
    }
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
      continue;
    }
    checks.push(metricResult(
      `personamem_${splitKey}_mcq_accuracy`,
      mean(values),
      finiteScore(targetEntry.score, `PersonaMem ${split} target`),
      {
        supportedSplit: true,
        note: 'Current Remnic PersonaMem runner hydrates the 32k chat-history split; 128k and 1M targets are retained as reference targets until those runner modes exist.',
      },
    ));
  }
  assert(checks.length > 0, 'PersonaMem result missing supported 32k split');
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
    accurateRetrieval: mean([
      datasetScores.shDocQa,
      datasetScores.mhDocQa,
      datasetScores.longMemEvalSStar,
      datasetScores.eventQa,
    ]),
    testTimeLearning: mean([
      datasetScores.mcc,
      datasetScores.recommendation,
    ]),
    longRangeUnderstanding: mean([
      datasetScores.summarization,
      datasetScores.detectiveQa,
    ]),
    selectiveForgetting: mean([
      datasetScores.factConsolidationSingleHop,
      datasetScores.factConsolidationMultiHop,
    ]),
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

export function comparePublicBenchmarkSota(result, targetMap) {
  const benchmark = result.meta?.benchmark ?? result.benchmarkId;
  assert(typeof benchmark === 'string' && benchmark.length > 0, 'result missing benchmark id');
  const targets = targetMap.benchmarks?.[benchmark]?.targets ?? targetMap.benchmarks?.[benchmark];
  assert(targets, `target map missing ${benchmark}`);

  if (benchmark === 'memory-arena') {
    return compareMemoryArenaSota(result, targetMap);
  }

  const checks = {
    'ama-bench': compareAmaBench,
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
    sotaAllCheckedMetrics: checks
      .filter((check) => check.publishAsSota !== false)
      .every((check) => check.sota),
    atOrAboveAllCheckedMetrics: checks
      .filter((check) => check.publishAsSota !== false)
      .every((check) => check.sota || check.tied),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [resultPath, targetMapPath = DEFAULT_TARGET_MAP] = process.argv.slice(2);
  if (!resultPath) {
    console.error('Usage: compare-public-benchmark-sota.mjs <result.json> [target-map.json]');
    process.exit(2);
  }
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const targetMap = JSON.parse(fs.readFileSync(targetMapPath, 'utf8'));
  console.log(JSON.stringify(
    {
      ...comparePublicBenchmarkSota(result, targetMap),
      resultPath,
      targetMapPath,
    },
    roundedJsonNumberReplacer,
    2,
  ));
}
