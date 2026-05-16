#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareMemoryArenaSota } from './compare-memoryarena-sota.mjs';
import { deriveMemoryArenaOfficialMetrics } from './derive-memoryarena-official-metrics.mjs';
import { assertRealRuntime } from '../runtime-profile-proof.mjs';

const publicSotaDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_TARGET_MAP = path.join(publicSotaDir, 'current-target-map.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256String(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256FileSync(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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

function canonicalJson(value, indent = 2) {
  return `${JSON.stringify(sortDeep(value), null, indent)}\n`;
}

function sortDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortDeep(value[key])]),
    );
  }
  return value;
}

function finiteScoreEntries(scores) {
  return Object.fromEntries(
    Object.entries(scores ?? {})
      .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function assertNoInvalidRawScores(result) {
  for (const [metric, aggregate] of Object.entries(result.results?.aggregates ?? {})) {
    const value = aggregate?.mean;
    assert(
      typeof value !== 'number' || (Number.isFinite(value) && value >= 0),
      `raw aggregate ${metric}.mean must be non-negative finite`,
    );
  }
  for (const task of result.results?.tasks ?? []) {
    for (const [metric, score] of Object.entries(task.scores ?? {})) {
      assert(
        typeof score !== 'number' || (Number.isFinite(score) && score >= 0),
        `raw task ${task.taskId ?? '<unknown>'} score ${metric} must be non-negative finite`,
      );
    }
  }
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

function gitOutput(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function statusEntryPath(entry) {
  return entry.slice(3).replace(/^"|"$/g, '').split(' -> ').at(-1);
}

function isIgnoredDirtyEntry(entry, ignoredRelativePrefixes) {
  const entryPath = statusEntryPath(entry);
  return ignoredRelativePrefixes.some((prefix) => entryPath === prefix || entryPath.startsWith(prefix));
}

function gitInfo(repoRoot, result, ignoredRelativePrefixes = []) {
  const commit = result.meta?.gitSha ?? 'unknown';
  const shortCommit = String(result.meta?.gitSha ?? 'unknown').slice(0, 8);
  const dirtyEntries = gitOutput(repoRoot, ['status', '--porcelain', '--untracked-files=all'])
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .filter((line) => !isIgnoredDirtyEntry(line, ignoredRelativePrefixes));
  return {
    commit,
    shortCommit,
    dirty: dirtyEntries.length > 0,
    dirtyEntryCount: dirtyEntries.length,
  };
}

function scrubPath(repoRoot, value) {
  if (typeof value !== 'string' || value.length === 0) {
    return value;
  }
  const normalizedRepo = path.resolve(repoRoot);
  const normalized = path.resolve(value);
  const rel = path.relative(normalizedRepo, normalized);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/');
  }
  return value.replace(os.homedir(), '~');
}

function sanitizeArgv(argv) {
  return (Array.isArray(argv) ? argv : process.argv.slice(2)).map((arg) => {
    if (typeof arg !== 'string') {
      return String(arg);
    }
    if (arg.includes(os.homedir())) {
      return arg.replaceAll(os.homedir(), '~');
    }
    return arg;
  });
}

async function scanDataset(datasetDir, repoRoot) {
  const root = path.resolve(datasetDir);
  const rootStat = await fsp.lstat(root);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), `dataset root must be a real directory: ${datasetDir}`);
  const files = [];

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      const stat = await fsp.lstat(entryPath);
      const relative = path.relative(root, entryPath).split(path.sep).join('/');
      assert(!stat.isSymbolicLink(), `dataset symlinks are not allowed in evidence manifests: ${relative}`);
      if (stat.isDirectory()) {
        await walk(entryPath);
      } else if (stat.isFile()) {
        files.push({
          path: relative,
          kind: 'file',
          sizeBytes: stat.size,
          sha256: sha256FileSync(entryPath),
        });
      }
    }
  }

  await walk(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    benchmark: 'memory-arena',
    status: 'hashed',
    path: scrubPath(repoRoot, datasetDir),
    realpath: scrubPath(repoRoot, await fsp.realpath(root)),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    sha256: sha256String(stableStringify(files)),
    files,
  };
}

function statusTimes(resultsDir) {
  const statusPath = path.join(resultsDir, 'status.tsv');
  const rows = fs.existsSync(statusPath)
    ? fs.readFileSync(statusPath, 'utf8').trim().split(/\r?\n/).slice(1)
    : [];
  const memoryRows = rows
    .map((line) => line.split('\t'))
    .filter(([benchmark]) => benchmark === 'memory-arena');
  return {
    startedAt: memoryRows.find(([, status]) => status === 'start')?.[2],
    successAt: [...memoryRows].reverse().find(([, status]) => status === 'success')?.[2],
  };
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

function resultManifestEntry(resultPath, resultsDir, result) {
  const stat = fs.statSync(resultPath);
  return {
    path: path.relative(resultsDir, resultPath).split(path.sep).join('/'),
    sha256: sha256FileSync(resultPath),
    sizeBytes: stat.size,
    resultId: result.meta.id,
    benchmark: 'memory-arena',
    mode: result.meta.mode,
    gitSha: result.meta.gitSha,
    runCount: result.meta.runCount,
    seeds: [...result.meta.seeds],
    taskCount: result.results.tasks.length,
    configHash: sha256String(stableStringify(result.config)),
  };
}

function buildArtifactHashIdentity(manifest) {
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

function providerDistributionSummary(records) {
  const out = {
    providers: {},
    models: {},
    reasoningEfforts: {},
    serviceTiers: {},
    statuses: {},
  };
  for (const record of records) {
    increment(out.providers, record.provider);
    increment(out.models, record.model);
    increment(out.reasoningEfforts, record.reasoningEffort);
    increment(out.serviceTiers, record.serviceTier);
    increment(out.statuses, String(record.result?.status ?? 'missing'));
  }
  return out;
}

function increment(record, key) {
  const safeKey = typeof key === 'string' && key.length > 0 ? key : '<missing>';
  record[safeKey] = (record[safeKey] ?? 0) + 1;
}

function buildDiagnosticsSummary(resultsDir, runId, startedAt, finishedAt, generatedAt) {
  const diagnosticsDir = path.join(resultsDir, 'codex-cli-diagnostics');
  if (!fs.existsSync(diagnosticsDir)) {
    return undefined;
  }
  const files = fs.readdirSync(diagnosticsDir).filter((name) => name.endsWith('.json'));
  const checked = [];
  let beforeStart = 0;
  let afterCutoff = 0;
  let inFlight = 0;
  for (const name of files) {
    const record = readJson(path.join(diagnosticsDir, name));
    if (runId && record.runId !== runId) {
      continue;
    }
    if (!record.finishedAt) {
      inFlight += 1;
      continue;
    }
    if (Date.parse(record.startedAt ?? '') < Date.parse(startedAt)) {
      beforeStart += 1;
      continue;
    }
    if (Date.parse(record.finishedAt) > Date.parse(finishedAt)) {
      afterCutoff += 1;
      continue;
    }
    checked.push(record);
  }
  const complete = checked.filter((record) => record.result?.status === 0 && !record.error).length;
  const errored = checked.filter((record) => record.error).length;
  const nonzero = checked.filter((record) => record.result?.status !== 0).length;
  const startedValues = checked.map((record) => record.startedAt).filter(Boolean).sort();
  const finishedValues = checked.map((record) => record.finishedAt).filter(Boolean).sort();
  return {
    schemaVersion: 1,
    generatedAt,
    runId,
    benchmark: 'memory-arena',
    startedAt,
    finishedAt,
    cutoffMode: 'startedAt>=benchmark.start && finishedAt<=result.meta.timestamp',
    totalFiles: files.length,
    checked: checked.length,
    complete,
    inFlight,
    beforeStart,
    afterCutoff,
    errored,
    nonzero,
    ...providerDistributionSummary(checked),
    minStartedAt: startedValues[0],
    maxFinishedAt: finishedValues.at(-1),
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
  const baseManifestPath = args['base-manifest'] ? path.resolve(args['base-manifest']) : path.join(resultsDir, 'MANIFEST.json');
  const targetMapPath = path.resolve(args['target-map'] ?? DEFAULT_TARGET_MAP);
  const resultRelativePath = path.relative(resultsDir, resultPath);
  assert(
    resultRelativePath.length > 0 &&
      !resultRelativePath.startsWith('..') &&
      !path.isAbsolute(resultRelativePath),
    'raw result must be inside --results-dir so the manifest can use a safe relative source path',
  );

  const result = readJson(resultPath);
  const baseManifest = fs.existsSync(baseManifestPath) ? readJson(baseManifestPath) : {};
  assert(result.meta?.benchmark === 'memory-arena', 'raw result must be memory-arena');
  assert(result.meta?.mode === 'full', 'raw result must be full mode');
  assertRealRuntime(result, baseManifest, 'raw result');
  assert(result.config?.systemProvider?.provider === 'codex-cli', 'system provider must be codex-cli');
  assert(result.config?.systemProvider?.model === 'gpt-5.5', 'system model must be gpt-5.5');
  assert(result.config?.systemProvider?.reasoningEffort === 'xhigh', 'system reasoning must be xhigh');
  assertNoInvalidRawScores(result);

  const targetMap = readJson(targetMapPath);
  const derived = deriveMemoryArenaOfficialMetrics(result);
  const comparison = compareMemoryArenaSota(result, targetMap);
  const dataset = await scanDataset(args['dataset-dir'], repoRoot);
  const times = statusTimes(resultsDir);
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

  const rawEntry = resultManifestEntry(resultPath, resultsDir, result);
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
      argv: sanitizeArgv(baseManifest.command?.argv),
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
    artifactHash: sha256String(stableStringify(buildArtifactHashIdentity(manifestWithoutHash))),
  };
  const manifestPath = path.join(outDir, 'MANIFEST.memory-arena.json');
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const diagnostics = buildDiagnosticsSummary(resultsDir, manifest.run.id, startedAt, finishedAt, generatedAt);
  assert(diagnostics, 'codex-cli diagnostics are required to prove provider/model/reasoning/service-tier for public evidence');
  assert(diagnostics.checked > 0, 'diagnostics must include at least one completed record');
  assert(diagnostics.inFlight === 0, 'diagnostics must not include in-flight records at evidence cutoff');
  assert(diagnostics.afterCutoff === 0, 'diagnostics must not include records after evidence cutoff');
  assert(diagnostics.errored === 0, 'diagnostics must have zero errors');
  assert(diagnostics.nonzero === 0, 'diagnostics must have zero nonzero exits');
  assert(diagnostics.providers?.['codex-cli'] === diagnostics.checked, 'diagnostics provider distribution must be all codex-cli');
  assert(diagnostics.models?.['gpt-5.5'] === diagnostics.checked, 'diagnostics model distribution must be all gpt-5.5');
  assert(diagnostics.reasoningEfforts?.xhigh === diagnostics.checked, 'diagnostics reasoning distribution must be all xhigh');
  assert(diagnostics.serviceTiers?.fast === diagnostics.checked, 'diagnostics service tier distribution must be all fast');
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
