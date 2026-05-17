#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');
const repo = process.env.REPO ?? (() => {
  try {
    const remote = execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
    if (match) {
      return match[1];
    }
  } catch {
    // Fall through to requiring REPO below.
  }
  throw new Error('Set REPO=owner/name or configure origin to a GitHub repository');
})();
const branchRef = process.env.BRANCH_REF ?? 'origin/bench/public-matrix-codex';
const auditWorktree = process.env.AUDIT_WORKTREE ?? path.join(os.tmpdir(), 'remnic-public-sota-completion-audit');
const targetMapPath = process.env.TARGET_MAP ?? path.join(os.tmpdir(), 'remnic-public-sota-audit-target-map.json');

function fetchBranchRef() {
  if (!branchRef.startsWith('origin/')) {
    return;
  }
  const branch = branchRef.slice('origin/'.length);
  execFileSync('git', ['-C', repoRoot, 'fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { stdio: ['ignore', 'ignore', 'ignore'] });
}

const benchmarks = [
  {
    benchmark: 'ama-bench',
    branch: 'codex/publish-ama-agent-sota-bf9b264',
    evidenceDoc: 'evidence/ama-bench-gpt-5.5-agent-sota-2026-05-15.md',
    verifier: 'verify-public-ama-agent-sota-evidence.mjs',
    manifestGlob: 'MANIFEST.ama-bench.json',
  },
  {
    benchmark: 'memory-arena',
    branch: 'codex/publish-memoryarena-sota-bf9b264',
    evidenceDoc: 'evidence/memory-arena-gpt-5.5-sota-2026-05.md',
    verifier: 'verify-public-memoryarena-sota-evidence.mjs',
    manifestGlob: 'MANIFEST.memory-arena.json',
  },
  ...['amemgym', 'longmemeval', 'locomo', 'beam', 'memoryagentbench', 'membench', 'personamem'].map((benchmark) => ({
    benchmark,
    branch: `codex/publish-${benchmark}-sota-bf9b264`,
    evidenceDoc: `evidence/${benchmark}-gpt-5.5-sota-2026-05.md`,
    verifier: `verify-public-${benchmark}-sota-evidence.mjs`,
    manifestGlob: `MANIFEST.${benchmark}.json`,
  })),
];

function gitLsTree(prefix) {
  try {
    const raw = execFileSync('git', ['ls-tree', '-r', '--name-only', branchRef, prefix], {
      encoding: 'utf8',
    });
    return raw.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

fetchBranchRef();

const branchFiles = [
  ...gitLsTree('docs/benchmarks'),
  ...gitLsTree('scripts/bench'),
];
const branchFileSet = new Set(branchFiles);

function exists(relPath) {
  return branchFileSet.has(`docs/benchmarks/${relPath}`) || branchFileSet.has(`scripts/bench/${relPath}`);
}

function findManifest(manifestName) {
  const matches = branchFiles.filter((file) => file.startsWith('docs/benchmarks/results/') && file.endsWith(`/${manifestName}`));
  matches.sort();
  return matches.at(-1);
}

function ghJson(args) {
  try {
    return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
  } catch {
    return undefined;
  }
}

function latestPrFor(branch) {
  const rows = ghJson([
    'pr',
    'list',
    '--repo', repo,
    '--head', branch,
    '--base', 'bench/public-matrix-codex',
    '--state', 'all',
    '--limit', '20',
    '--json', 'number,state,url,headRefName,baseRefName',
  ]) ?? [];
  const activeRows = rows.filter((row) => row.state === 'OPEN' || row.state === 'MERGED');
  activeRows.sort((a, b) => Number(b.number) - Number(a.number));
  return activeRows[0];
}

function verifyPr(prNumber, requireMerged) {
  if (!prNumber) {
    return { ok: false, error: 'missing PR' };
  }
  const args = [
    path.join(scriptDir, 'verify-pr-clean.mjs'),
    '--repo', repo,
    '--pr', String(prNumber),
  ];
  if (requireMerged) {
    args.push('--require-merged');
  }
  try {
    return JSON.parse(execFileSync('node', args, { encoding: 'utf8' }));
  } catch (error) {
    try {
      return JSON.parse(error.stdout?.toString() ?? '');
    } catch {
      return { ok: false, error: error.message };
    }
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function refreshTargetMap() {
  execFileSync('node', [path.join(scriptDir, 'build-target-map.mjs'), targetMapPath], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return readJson(targetMapPath);
}

const currentTargetMap = refreshTargetMap();

function expectedComparisonTargets(benchmark, checks = []) {
  const entry = currentTargetMap.benchmarks?.[benchmark];
  if (!entry) {
    return {};
  }
  const comparisonMetrics = new Set(checks.map((check) => check.metric));
  switch (benchmark) {
    case 'memory-arena':
      return {
        all_task_average_success_rate: entry.targets.allTaskAverageSuccessRate.score,
        bundled_web_shopping_success_rate: entry.targets.bundledWebShopping.successRate,
        bundled_web_shopping_progress_score: entry.targets.bundledWebShopping.progressScore,
        group_travel_planning_success_rate: entry.targets.groupTravelPlanning.successRate,
        group_travel_planning_progress_score: entry.targets.groupTravelPlanning.progressScore,
        group_travel_planning_soft_progress_score: entry.targets.groupTravelPlanning.softProgressScore,
        progressive_search_success_rate: entry.targets.progressiveWebSearch.successRate,
        progressive_search_progress_score: entry.targets.progressiveWebSearch.progressScore,
        formal_reasoning_math_success_rate: entry.targets.formalReasoning.mathSuccessRate,
        formal_reasoning_phys_success_rate: entry.targets.formalReasoning.physSuccessRate,
        formal_reasoning_process_score: entry.targets.formalReasoning.processScore,
      };
    case 'amemgym':
      return {
        amemgym_memory_agent_score: entry.targets.memoryAgent.score,
        amemgym_native_llm_score_reference: entry.targets.nativeLlm.score,
      };
    case 'longmemeval':
      return { longmemeval_s_accuracy: entry.target.score };
    case 'locomo':
      return { locomo10_accuracy: entry.target.score };
    case 'beam':
      return Object.fromEntries(Object.entries(entry.targets).map(([split, target]) => [`beam_${split.toLowerCase()}`, target.score]));
    case 'personamem':
      return {
        personamem_32k_mcq_accuracy: entry.targets['32k'].score,
      };
    case 'memoryagentbench':
      if (comparisonMetrics.has('memoryagentbench_overall_score')) {
        return {
          memoryagentbench_overall_score: entry.targets.overallScore.score,
        };
      }
      if (
        comparisonMetrics.has('memoryagentbench_table3_overall_score') ||
        comparisonMetrics.has('memoryagentbench_table3_strongest_memory_agent_overall_score')
      ) {
        return {
          memoryagentbench_table3_overall_score: entry.targets.overallScore.score,
          memoryagentbench_table3_strongest_memory_agent_overall_score: entry.targets.strongestMemoryAgentOverall.score,
        };
      }
      return {
        memoryagentbench_overall_score: entry.targets.overallScore.score,
        memoryagentbench_table3_overall_score: entry.targets.overallScore.score,
        memoryagentbench_table3_strongest_memory_agent_overall_score: entry.targets.strongestMemoryAgentOverall.score,
      };
    case 'membench':
      return {
        membench_accuracy_factual_participant: entry.targets.FirstAgentLowLevel.score,
        membench_accuracy_factual_observation: entry.targets.ThirdAgentLowLevel.score,
        membench_accuracy_reflective_participant: entry.targets.FirstAgentHighLevel.score,
        membench_accuracy_reflective_observation: entry.targets.ThirdAgentHighLevel.score,
      };
    default:
      return {};
  }
}

function runTargetFreshnessCheck(row, item) {
  if (!row.manifestExists || item.benchmark === 'ama-bench') {
    return { ok: true, skipped: true, reason: item.benchmark === 'ama-bench' ? 'legacy AMA evidence has no comparison artifact' : 'missing manifest' };
  }
  try {
    preparedAuditWorktree ??= ensureAuditWorktree();
    const resultDir = path.posix.dirname(row.manifest);
    const comparisonPath = path.join(preparedAuditWorktree, resultDir, `${item.benchmark}-sota-comparison.json`);
    if (!fs.existsSync(comparisonPath)) {
      return { ok: false, error: `missing comparison artifact ${path.posix.join(resultDir, `${item.benchmark}-sota-comparison.json`)}` };
    }
    const comparison = readJson(comparisonPath);
    const expected = expectedComparisonTargets(item.benchmark, comparison.checks ?? []);
    const mismatches = [];
    for (const check of comparison.checks ?? []) {
      if (check.publishAsSota === false && !Object.prototype.hasOwnProperty.call(expected, check.metric)) {
        continue;
      }
      const expectedTarget = expected[check.metric];
      if (typeof expectedTarget !== 'number') {
        mismatches.push({ metric: check.metric, issue: 'unexpected metric in comparison' });
        continue;
      }
      if (Math.abs(check.target - expectedTarget) > 1e-12) {
        mismatches.push({ metric: check.metric, actualTarget: check.target, expectedTarget });
      }
    }
    const comparisonMetrics = new Set((comparison.checks ?? []).map((check) => check.metric));
    if (item.benchmark === 'memoryagentbench') {
      const hasAggregate = comparisonMetrics.has('memoryagentbench_overall_score');
      const hasTable3 = comparisonMetrics.has('memoryagentbench_table3_overall_score')
        && comparisonMetrics.has('memoryagentbench_table3_strongest_memory_agent_overall_score');
      if (!hasAggregate && !hasTable3) {
        mismatches.push({
          metric: 'memoryagentbench',
          issue: 'missing aggregate or Table 3 metric set in comparison',
        });
      }
    } else {
      for (const metric of Object.keys(expected)) {
        if (!comparisonMetrics.has(metric)) {
          mismatches.push({ metric, issue: 'missing metric in comparison' });
        }
      }
    }
    return {
      ok: mismatches.length === 0,
      comparisonPath: path.posix.join(resultDir, `${item.benchmark}-sota-comparison.json`),
      targetMapGeneratedAt: currentTargetMap.generatedAt,
      mismatchCount: mismatches.length,
      mismatches,
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function ensureAuditWorktree() {
  try {
    if (fs.existsSync(auditWorktree)) {
      try {
        fetchBranchRef();
        execFileSync('git', ['-C', auditWorktree, 'checkout', '--detach', branchRef], { stdio: ['ignore', 'ignore', 'ignore'] });
        return auditWorktree;
      } catch {
        execFileSync('rm', ['-rf', auditWorktree], { stdio: ['ignore', 'ignore', 'ignore'] });
      }
    }
    execFileSync('git', ['worktree', 'prune'], { stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['worktree', 'add', '--detach', auditWorktree, branchRef], { stdio: ['ignore', 'ignore', 'ignore'] });
    return auditWorktree;
  } catch (error) {
    throw new Error(`could not prepare audit worktree ${auditWorktree}: ${error.message}`);
  }
}

let preparedAuditWorktree;
function runArtifactVerifier(row, item) {
  if (!row.manifestExists || !row.verifierExists) {
    return { ok: false, skipped: true, reason: 'missing manifest or verifier' };
  }
  try {
    preparedAuditWorktree ??= ensureAuditWorktree();
    const resultDir = path.posix.dirname(row.manifest);
    const args = [`scripts/bench/${item.verifier}`, resultDir];
    if (!['ama-bench', 'memory-arena'].includes(item.benchmark)) {
      args.push(item.benchmark);
    }
    execFileSync('node', args, {
      cwd: preparedAuditWorktree,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, command: `node ${args.join(' ')}` };
  } catch (error) {
    return {
      ok: false,
      command: error.spawnargs ? `node ${error.spawnargs.slice(1).join(' ')}` : undefined,
      error: String(error.stderr?.toString() || error.stdout?.toString() || error.message || error),
    };
  }
}

function runPublicMatrixVerifier(row, item) {
  if (!row.manifestExists) {
    return { ok: false, skipped: true, reason: 'missing manifest' };
  }
  try {
    preparedAuditWorktree ??= ensureAuditWorktree();
    const resultDir = path.posix.dirname(row.manifest);
    const args = [
      'tsx',
      'scripts/bench/verify-public-matrix.ts',
      '--results-dir', resultDir,
      '--manifest', row.manifest,
      '--benchmarks', item.benchmark,
      '--skip-git',
      '--no-diagnostics',
      '--json',
    ];
    const output = execFileSync('npx', args, {
      cwd: preparedAuditWorktree,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/opt/homebrew/sbin:${process.env.PATH ?? ''}`,
      },
    });
    const report = JSON.parse(output);
    return {
      ok: report.ok === true,
      command: `npx ${args.join(' ')}`,
      issueCount: Array.isArray(report.issues) ? report.issues.length : undefined,
      issues: Array.isArray(report.issues) ? report.issues.slice(0, 10) : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      command: error.spawnargs ? `${error.spawnargs.join(' ')}` : undefined,
      error: String(error.stderr?.toString() || error.stdout?.toString() || error.message || error),
    };
  }
}

const rows = benchmarks.map((item) => {
  const manifest = findManifest(item.manifestGlob);
  const pr = latestPrFor(item.branch);
  const prClean = verifyPr(pr?.number, item.benchmark === 'ama-bench');
  const row = {
    benchmark: item.benchmark,
    evidenceDoc: item.evidenceDoc,
    evidenceDocExists: exists(item.evidenceDoc),
    verifier: item.verifier,
    verifierExists: exists(item.verifier),
    manifest,
    manifestExists: Boolean(manifest),
    pr: pr ? {
      number: pr.number,
      state: pr.state,
      url: pr.url,
      headRefName: pr.headRefName,
    } : null,
    prClean: prClean.ok === true,
    prCleanDetails: prClean,
  };
  return {
    ...row,
    artifactVerifier: runArtifactVerifier(row, item),
    publicMatrixVerifier: runPublicMatrixVerifier(row, item),
    targetFreshness: runTargetFreshnessCheck(row, item),
  };
});

const failures = [];
for (const row of rows) {
  if (!row.evidenceDocExists) failures.push(`${row.benchmark}: missing evidence doc`);
  if (!row.verifierExists) failures.push(`${row.benchmark}: missing verifier`);
  if (!row.manifestExists) failures.push(`${row.benchmark}: missing manifest`);
  if (row.manifestExists && row.verifierExists && !row.artifactVerifier?.ok) failures.push(`${row.benchmark}: artifact verifier failed`);
  if (row.manifestExists && !row.publicMatrixVerifier?.ok) failures.push(`${row.benchmark}: public matrix verifier failed`);
  if (row.manifestExists && !row.targetFreshness?.ok) failures.push(`${row.benchmark}: comparison targets stale or invalid`);
  if (!row.pr) failures.push(`${row.benchmark}: missing publication PR`);
  if (row.pr && !row.prClean) failures.push(`${row.benchmark}: PR not clean`);
}

const result = {
  ok: failures.length === 0,
  checkedAt: new Date().toISOString(),
  repo,
  branchRef,
  targetMap: {
    path: targetMapPath,
    generatedAt: currentTargetMap.generatedAt,
  },
  rows,
  failures,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  process.exit(1);
}
