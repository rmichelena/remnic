#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const maxLatestAgeSeconds = Number(process.env.MAX_LATEST_DIAGNOSTIC_AGE_SECONDS ?? 1800);
const expectedProvider = process.env.EXPECTED_CODEX_PROVIDER ?? 'codex-cli';
const expectedModel = process.env.EXPECTED_CODEX_MODEL ?? 'gpt-5.5';
const expectedReasoningEffort = process.env.EXPECTED_CODEX_REASONING_EFFORT ?? 'xhigh';
const expectedServiceTier = process.env.EXPECTED_CODEX_SERVICE_TIER ?? 'fast';
const statusRaw = execFileSync('node', [path.join(scriptDir, 'status-public-sota-pipeline.mjs')], {
  encoding: 'utf8',
});
const status = JSON.parse(statusRaw);

const watcherPlan = [
  {
    benchmark: 'memory-arena',
    publish: 'remnic-memoryarena-publish-watcher-bf9b2643',
    transition: 'remnic-next-after-memoryarena-watcher-bf9b2643',
  },
  {
    benchmark: 'amemgym',
    publish: 'remnic-amemgym-publish-watcher',
    transition: 'remnic-amemgym-to-longmemeval-watcher',
  },
  {
    benchmark: 'longmemeval',
    publish: 'remnic-longmemeval-publish-watcher',
    transition: 'remnic-longmemeval-to-locomo-watcher',
  },
  {
    benchmark: 'locomo',
    publish: 'remnic-locomo-publish-watcher',
    transition: 'remnic-locomo-to-beam-watcher',
  },
  {
    benchmark: 'beam',
    publish: 'remnic-beam-publish-watcher',
    transition: 'remnic-beam-to-memoryagentbench-watcher',
  },
  {
    benchmark: 'memoryagentbench',
    publish: 'remnic-memoryagentbench-publish-watcher',
    transition: 'remnic-memoryagentbench-to-membench-watcher',
  },
  {
    benchmark: 'membench',
    publish: 'remnic-membench-publish-watcher',
    transition: 'remnic-membench-to-personamem-watcher',
  },
  {
    benchmark: 'personamem',
    publish: 'remnic-personamem-publish-watcher',
  },
];

const failures = [];
const activeRun = status.activeRun ?? (
  status.memoryArena
    ? { benchmark: 'memory-arena', ...status.memoryArena }
    : undefined
);

if (!Array.isArray(status.scoringSessions) || status.scoringSessions.length !== 1) {
  failures.push(`expected exactly one active scoring session, found ${status.scoringSessions?.length ?? 'unknown'}`);
}

function requiredWatchersFor(activeBenchmark) {
  const startIndex = watcherPlan.findIndex((entry) => entry.benchmark === activeBenchmark);
  const remainingPlan = startIndex >= 0 ? watcherPlan.slice(startIndex) : watcherPlan;
  return remainingPlan
    .flatMap((entry) => [entry.publish, entry.transition])
    .filter((session) => typeof session === 'string');
}

const requiredWatchers = requiredWatchersFor(activeRun?.benchmark);
const missingWatchers = requiredWatchers.filter((session) => !status.watcherSessions?.includes(session));
if (missingWatchers.length > 0) {
  failures.push(`missing watcher sessions: ${missingWatchers.join(', ')}`);
}

const diagnostics = activeRun?.diagnostics;
if (!diagnostics) {
  failures.push('missing active run diagnostics');
} else {
  if (diagnostics.errors !== 0) {
    failures.push(`diagnostics errors=${diagnostics.errors}`);
  }
  if (diagnostics.nonzero !== 0) {
    failures.push(`diagnostics nonzero=${diagnostics.nonzero}`);
  }
  const latestFinished = diagnostics.latestFinished;
  if (!latestFinished?.finishedAt) {
    failures.push('missing latest finished diagnostic timestamp');
  } else {
    const ageSeconds = (Date.now() - Date.parse(latestFinished.finishedAt)) / 1000;
    if (!Number.isFinite(ageSeconds) || ageSeconds > maxLatestAgeSeconds) {
      failures.push(`latest finished diagnostic age ${Math.round(ageSeconds)}s exceeds ${maxLatestAgeSeconds}s`);
    }
    if (latestFinished.provider !== expectedProvider) {
      failures.push(`latest finished diagnostic provider=${String(latestFinished.provider)} expected ${expectedProvider}`);
    }
    if (latestFinished.model !== expectedModel) {
      failures.push(`latest finished diagnostic model=${String(latestFinished.model)} expected ${expectedModel}`);
    }
    if (latestFinished.reasoningEffort !== expectedReasoningEffort) {
      failures.push(`latest finished diagnostic reasoningEffort=${String(latestFinished.reasoningEffort)} expected ${expectedReasoningEffort}`);
    }
    if (latestFinished.serviceTier !== expectedServiceTier) {
      failures.push(`latest finished diagnostic serviceTier=${String(latestFinished.serviceTier)} expected ${expectedServiceTier}`);
    }
  }
}

const result = {
  ok: failures.length === 0,
  checkedAt: new Date().toISOString(),
  maxLatestAgeSeconds,
  expectedCodex: {
    provider: expectedProvider,
    model: expectedModel,
    reasoningEffort: expectedReasoningEffort,
    serviceTier: expectedServiceTier,
  },
  scoringSessions: status.scoringSessions,
  watcherSessionCount: status.watcherSessionCount,
  activeBenchmark: activeRun?.benchmark ?? null,
  requiredWatchers,
  missingWatchers,
  activeRun: status.activeRun,
  memoryArena: status.memoryArena,
  failures,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  process.exit(1);
}
