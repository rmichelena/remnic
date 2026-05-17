#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roundedJsonNumberReplacer } from '../comparison-json.mjs';
import { deriveMemoryArenaOfficialMetrics } from './derive-memoryarena-official-metrics.mjs';

const publicSotaDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function verdict(actual, target, metricName) {
  assert(typeof actual === 'number' && Number.isFinite(actual), `${metricName} actual is not finite`);
  assert(typeof target === 'number' && Number.isFinite(target), `${metricName} target is not finite`);
  const delta = actual - target;
  const tied = Math.abs(delta) <= 1e-9;
  return {
    metric: metricName,
    actual,
    target,
    delta,
    sota: delta > 1e-9,
    tied,
  };
}

function byDomain(derived, domain) {
  const row = derived.byDomain.find((entry) => entry.domain === domain);
  assert(row, `missing derived domain ${domain}`);
  return row;
}

export function compareMemoryArenaSota(result, targetMap) {
  const targets = targetMap.benchmarks?.['memory-arena']?.targets;
  assert(targets, 'target map missing memory-arena targets');
  const derived = deriveMemoryArenaOfficialMetrics(result);

  const bundled = byDomain(derived, 'bundled_shopping');
  const travel = byDomain(derived, 'group_travel_planner');
  const search = byDomain(derived, 'progressive_search');
  const math = byDomain(derived, 'formal_reasoning_math');
  const phys = byDomain(derived, 'formal_reasoning_phys');
  const formalSuccessRate = (math.successRate + phys.successRate) / 2;
  const formalProgressScore = (math.progressScore + phys.progressScore) / 2;

  const checks = [
    verdict(
      derived.official.successRate,
      targets.allTaskAverageSuccessRate.score,
      'all_task_average_success_rate',
    ),
    verdict(
      bundled.successRate,
      targets.bundledWebShopping.successRate,
      'bundled_web_shopping_success_rate',
    ),
    verdict(
      bundled.progressScore,
      targets.bundledWebShopping.progressScore,
      'bundled_web_shopping_progress_score',
    ),
    verdict(
      travel.successRate,
      targets.groupTravelPlanning.successRate,
      'group_travel_planning_success_rate',
    ),
    verdict(
      travel.progressScore,
      targets.groupTravelPlanning.progressScore,
      'group_travel_planning_progress_score',
    ),
    verdict(
      travel.softProgressScore ?? 0,
      targets.groupTravelPlanning.softProgressScore,
      'group_travel_planning_soft_progress_score',
    ),
    verdict(
      search.successRate,
      targets.progressiveWebSearch.successRate,
      'progressive_search_success_rate',
    ),
    verdict(
      search.progressScore,
      targets.progressiveWebSearch.progressScore,
      'progressive_search_progress_score',
    ),
    verdict(
      math.successRate,
      targets.formalReasoning.mathSuccessRate,
      'formal_reasoning_math_success_rate',
    ),
    verdict(
      phys.successRate,
      targets.formalReasoning.physSuccessRate,
      'formal_reasoning_phys_success_rate',
    ),
    verdict(
      formalProgressScore,
      targets.formalReasoning.processScore,
      'formal_reasoning_process_score',
    ),
  ];

  const publishableChecks = checks.filter((check) => check.publishAsSota !== false);

  return {
    benchmark: 'memory-arena',
    gitSha: derived.gitSha,
    taskCount: derived.taskCount,
    scoredSubtasks: derived.scoredSubtasks,
    official: derived.official,
    formalReasoning: {
      successRate: formalSuccessRate,
      progressScore: formalProgressScore,
    },
    checks,
    sotaAllCheckedMetrics: publishableChecks.every((check) => check.sota),
    atOrAboveAllCheckedMetrics: publishableChecks.every((check) => check.sota || check.tied),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [resultPath, targetMapPath = path.join(publicSotaDir, 'current-target-map.json')] = process.argv.slice(2);

  if (!resultPath) {
    console.error('Usage: compare-memoryarena-sota.mjs <raw-memory-arena-result.json> [target-map.json]');
    process.exit(2);
  }

  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const targetMap = JSON.parse(fs.readFileSync(targetMapPath, 'utf8'));
  const report = {
    ...compareMemoryArenaSota(result, targetMap),
    resultPath,
    targetMapPath,
  };

  console.log(JSON.stringify(report, roundedJsonNumberReplacer, 2));
}
