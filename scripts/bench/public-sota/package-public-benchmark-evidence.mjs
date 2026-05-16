#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { comparePublicBenchmarkSota } from './compare-public-benchmark-sota.mjs';
import { assertRealRuntime } from './runtime-profile-proof.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET_MAP = path.join(scriptDir, 'current-target-map.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    out[arg.slice(2)] = value;
    i += 1;
  }
  return out;
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

function sha256File(file) {
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

function sortDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

function aggregateMeans(result) {
  return Object.fromEntries(
    Object.entries(result.results?.aggregates ?? {})
      .filter(([, aggregate]) => aggregate && typeof aggregate.mean === 'number' && Number.isFinite(aggregate.mean) && aggregate.mean >= 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([metric, aggregate]) => [metric, aggregate.mean]),
  );
}

function cleanedScores(scores) {
  return Object.fromEntries(
    Object.entries(scores ?? {})
      .filter(([, score]) => typeof score === 'number' && Number.isFinite(score) && score >= 0)
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

function publicTaskCategory(benchmark, task) {
  switch (benchmark) {
    case 'amemgym':
      return String(task.details?.profileId ?? task.taskId).split('-q')[0];
    case 'longmemeval':
      return String(task.details?.questionType ?? 'unknown');
    case 'locomo':
      return String(task.details?.categoryName ?? task.details?.category ?? 'unknown');
    case 'beam':
      return String(task.details?.scale ?? 'unknown');
    case 'personamem':
      return String(task.details?.prefType ?? task.details?.evaluationMode ?? 'unknown');
    case 'memoryagentbench':
      return String(task.details?.competency ?? task.details?.officialProtocol ?? 'unknown');
    case 'membench':
      return `${String(task.details?.memoryType ?? 'unknown')}/${String(task.details?.scenario ?? 'unknown')}`;
    default:
      return String(task.details?.category ?? 'unknown');
  }
}

function publicTaskDetails(benchmark, task) {
  const details = task.details ?? {};
  switch (benchmark) {
    case 'amemgym':
      return {
        profileId: details.profileId,
        itemIndex: details.questionIndex,
      };
    case 'longmemeval':
      return {
        itemType: details.questionType,
        judgeProtocol: details.judgeProtocol,
        searchHits: task.scores?.search_hits,
      };
    case 'locomo':
      return {
        category: details.category,
        categoryName: details.categoryName,
        hiddenEvidenceIdLeakCount: details.hiddenEvidenceIdLeakCount,
      };
    case 'beam':
      return {
        scale: details.scale,
        ability: details.ability,
        difficulty: details.difficulty,
      };
    case 'personamem':
      return {
        split: details.split ?? details.contextWindow ?? details.chatHistoryWindow ?? (details.chatHistory32kLink ? '32k' : undefined),
        chatHistory32kLink: details.chatHistory32kLink,
        chatHistory128kLink: details.chatHistory128kLink,
        prefType: details.prefType,
        evaluationMode: details.evaluationMode,
      };
    case 'memoryagentbench':
      return {
        competency: details.competency,
        source: details.source,
        officialProtocol: details.officialProtocol,
        recsysScoringReady: details.recsysScoringReady,
      };
    case 'membench':
      return {
        memoryType: details.memoryType,
        scenario: details.scenario,
        level: details.level,
        officialProtocol: details.officialProtocol,
      };
    default:
      return {};
  }
}

async function scanDataset(datasetDir, repoRoot, benchmark) {
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
          sha256: sha256File(entryPath),
        });
      }
    }
  }
  await walk(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    benchmark,
    status: 'hashed',
    path: scrubPath(repoRoot, datasetDir),
    realpath: scrubPath(repoRoot, await fsp.realpath(root)),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    sha256: sha256String(stableStringify(files)),
    files,
  };
}

function scrubPath(repoRoot, value) {
  if (typeof value !== 'string') {
    return value;
  }
  const rel = path.relative(path.resolve(repoRoot), path.resolve(value));
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/');
  }
  return value.replace(os.homedir(), '~');
}

function fallbackBenchmarkArgv(benchmark) {
  return [
    'bench', 'published', '--name', benchmark, '--dataset', `evals/datasets/${benchmark}`,
    '--runtime-profile', 'real', '--provider', 'codex-cli', '--model', 'gpt-5.5',
    '--system-codex-reasoning-effort', 'xhigh', '--judge-provider', 'codex-cli',
    '--judge-model', 'gpt-5.5', '--judge-codex-reasoning-effort', 'xhigh',
    '--internal-provider', 'codex-cli', '--internal-model', 'gpt-5.5',
    '--internal-codex-reasoning-effort', 'xhigh', '--request-timeout', '3600000',
    '--drain-timeout', '3600000', '--max-429-wait', '86400000', '--seed', '1',
    '--results-dir', '<results-dir>', '--out', '<out-dir>',
  ];
}

function sanitizeArgv(argv, repoRoot, resultsDir, outDir, benchmark) {
  const sourceArgv = Array.isArray(argv) && argv.length > 0 ? argv : fallbackBenchmarkArgv(benchmark);
  const replacements = [
    [path.resolve(repoRoot), '<repo-root>'],
    [path.resolve(resultsDir), '<results-dir>'],
    [path.resolve(outDir), '<out-dir>'],
    [os.homedir(), '~'],
  ];
  return sourceArgv.map((arg) => {
    if (typeof arg !== 'string') {
      return String(arg);
    }
    return replacements.reduce((value, [needle, replacement]) => value.replaceAll(needle, replacement), arg);
  });
}

function statusEntryPath(entry) {
  return entry.slice(3).replace(/^"|"$/g, '').split(' -> ').at(-1);
}

function isIgnoredDirtyEntry(entry, ignoredRelativePrefixes) {
  const entryPath = statusEntryPath(entry);
  return ignoredRelativePrefixes.some((prefix) => entryPath === prefix || entryPath.startsWith(prefix));
}

function gitInfo(repoRoot, result, ignoredRelativePrefixes = []) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const dirtyEntries = git(['status', '--porcelain', '--untracked-files=all'])
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .filter((line) => !isIgnoredDirtyEntry(line, ignoredRelativePrefixes));
  return {
    commit: result.meta.gitSha,
    shortCommit: String(result.meta.gitSha).slice(0, 8),
    dirty: dirtyEntries.length > 0,
    dirtyEntryCount: dirtyEntries.length,
  };
}

function resultManifestEntry(resultPath, resultsDir, result) {
  const stat = fs.statSync(resultPath);
  return {
    path: path.relative(resultsDir, resultPath).split(path.sep).join('/'),
    sha256: sha256File(resultPath),
    sizeBytes: stat.size,
    resultId: result.meta.id,
    benchmark: result.meta.benchmark,
    mode: result.meta.mode,
    gitSha: result.meta.gitSha,
    runCount: result.meta.runCount,
    seeds: [...result.meta.seeds],
    taskCount: result.results.tasks.length,
    configHash: sha256String(stableStringify(result.config)),
  };
}

function artifactHashIdentity(manifest) {
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

function buildDiagnosticsSummary(resultsDir, runId, benchmark, startedAt, finishedAt, generatedAt) {
  const diagDir = path.join(resultsDir, 'codex-cli-diagnostics');
  if (!fs.existsSync(diagDir)) {
    return undefined;
  }
  const files = fs.readdirSync(diagDir).filter((name) => name.endsWith('.json'));
  const checked = [];
  let inFlight = 0;
  let beforeStart = 0;
  let afterCutoff = 0;
  for (const name of files) {
    const record = readJson(path.join(diagDir, name));
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
  const distribution = (field) => {
    const out = {};
    for (const record of checked) {
      const key = field(record);
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  };
  const started = checked.map((record) => record.startedAt).filter(Boolean).sort();
  const finished = checked.map((record) => record.finishedAt).filter(Boolean).sort();
  return {
    schemaVersion: 1,
    generatedAt,
    runId,
    benchmark,
    startedAt,
    finishedAt,
    cutoffMode: 'startedAt>=benchmark.start && finishedAt<=result.meta.timestamp',
    totalFiles: files.length,
    checked: checked.length,
    complete: checked.filter((record) => record.result?.status === 0 && !record.error).length,
    inFlight,
    beforeStart,
    afterCutoff,
    errored: checked.filter((record) => record.error).length,
    nonzero: checked.filter((record) => record.result?.status !== 0).length,
    providers: distribution((record) => record.provider ?? '<missing>'),
    models: distribution((record) => record.model ?? '<missing>'),
    reasoningEfforts: distribution((record) => record.reasoningEffort ?? '<missing>'),
    serviceTiers: distribution((record) => record.serviceTier ?? '<missing>'),
    statuses: distribution((record) => String(record.result?.status ?? '<missing>')),
    minStartedAt: started[0],
    maxFinishedAt: finished.at(-1),
  };
}

function statusTimes(resultsDir, benchmark, fallback) {
  const statusPath = path.join(resultsDir, 'status.tsv');
  if (!fs.existsSync(statusPath)) {
    return { startedAt: fallback, successAt: fallback };
  }
  const rows = fs.readFileSync(statusPath, 'utf8').trim().split(/\r?\n/).slice(1).map((line) => line.split('\t'));
  const matching = rows.filter(([name]) => name === benchmark);
  return {
    startedAt: matching.find(([, status]) => status === 'start')?.[2] ?? fallback,
    successAt: [...matching].reverse().find(([, status]) => status === 'success')?.[2] ?? fallback,
  };
}

function buildArtifact(result, dataset, comparison, startedAt) {
  const benchmark = result.meta.benchmark;
  const finishedAt = result.meta.timestamp;
  return {
    schemaVersion: 1,
    benchmarkId: benchmark,
    datasetVersion: `sha256:${dataset.sha256}`,
    system: {
      name: 'remnic',
      version: result.meta.remnicVersion,
      gitSha: result.meta.gitSha,
    },
    model: result.config.systemProvider?.model ?? 'gpt-5.5',
    seed: result.meta.seeds?.[0] ?? 1,
    metrics: aggregateMeans(result),
    perTaskScores: result.results.tasks.map((task) => ({
      taskId: task.taskId,
      category: publicTaskCategory(benchmark, task),
      scores: cleanedScores(task.scores),
      details: publicTaskDetails(benchmark, task),
    })),
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    env: {
      node: result.environment?.nodeVersion ?? process.version,
      os: result.environment?.os ?? process.platform,
      arch: result.environment?.hardware ?? process.arch,
    },
    note: `Full ${benchmark} run. Public-safe artifact omits question text, expected answers, model answers, recalled text, and answer context; see MANIFEST.${benchmark}.json for raw local result hash and reproduction command.`,
    sotaComparison: comparison,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.result || !args['results-dir'] || !args['dataset-dir'] || !args['repo-root'] || !args['out-dir']) {
    console.error('Usage: package-public-benchmark-evidence.mjs --result <result.json> --results-dir <dir> --dataset-dir <dir> --repo-root <repo> --out-dir <dir> [--target-map <json>]');
    process.exit(2);
  }
  const resultPath = path.resolve(args.result);
  const resultsDir = path.resolve(args['results-dir']);
  const repoRoot = path.resolve(args['repo-root']);
  const outDir = path.resolve(args['out-dir']);
  const baseManifestPath = args['base-manifest'] ? path.resolve(args['base-manifest']) : path.join(resultsDir, 'MANIFEST.json');
  const baseManifest = fs.existsSync(baseManifestPath) ? readJson(baseManifestPath) : {};
  const targetMap = readJson(path.resolve(args['target-map'] ?? DEFAULT_TARGET_MAP));
  const result = readJson(resultPath);
  const benchmark = result.meta?.benchmark;
  assert(typeof benchmark === 'string' && benchmark !== 'memory-arena', 'use the MemoryArena-specific packager for memory-arena');
  const rel = path.relative(resultsDir, resultPath);
  assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'raw result must be inside --results-dir');
  assert(result.meta.mode === 'full', 'result must be full mode');
  assertRealRuntime(result, baseManifest, 'raw result');
  assert(result.config.systemProvider?.provider === 'codex-cli', 'system provider must be codex-cli');
  assert(result.config.systemProvider?.model === 'gpt-5.5', 'system model must be gpt-5.5');
  assert(result.config.systemProvider?.reasoningEffort === 'xhigh', 'system reasoning must be xhigh');
  assertNoInvalidRawScores(result);

  const comparison = comparePublicBenchmarkSota(result, targetMap);
  const dataset = await scanDataset(args['dataset-dir'], repoRoot, benchmark);
  const generatedAt = new Date().toISOString();
  const times = statusTimes(resultsDir, benchmark, result.meta.timestamp);
  const artifact = buildArtifact(result, dataset, comparison, times.startedAt);
  const filename = `${times.startedAt.slice(0, 10)}-${benchmark}-gpt-5.5-real-${String(result.meta.gitSha).slice(0, 8)}.json`;
  const generatedResultPrefix = `docs/benchmarks/results/${path.basename(resultsDir)}/`;
  const git = gitInfo(repoRoot, result, [generatedResultPrefix]);

  await fsp.mkdir(outDir, { recursive: true });
  const artifactPath = path.join(outDir, filename);
  const artifactBody = canonicalJson(artifact);
  await fsp.writeFile(artifactPath, artifactBody, 'utf8');

  const rawEntry = resultManifestEntry(resultPath, resultsDir, result);
  const publicEntry = {
    path: filename,
    sha256: sha256String(artifactBody),
    sizeBytes: fs.statSync(artifactPath).size,
    resultId: result.meta.id,
    benchmark,
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
  const manifestWithoutHash = {
    schemaVersion: 1,
    generatedAt,
    run: {
      id: baseManifest.run?.id ?? path.basename(resultsDir),
      mode: 'full',
      selectedBenchmarks: [benchmark],
      runtimeProfiles: ['real'],
      seed: result.meta.seeds?.[0] ?? 1,
    },
    git,
    command: {
      cwd: '<repo-root>',
      argv: sanitizeArgv(baseManifest.command?.argv, repoRoot, resultsDir, outDir, benchmark),
      envKeys: Array.isArray(baseManifest.command?.envKeys) ? [...baseManifest.command.envKeys].sort() : ['OPENAI_API_KEY'],
    },
    environment: {
      platform: result.environment?.os ?? process.platform,
      arch: result.environment?.hardware ?? process.arch,
      nodeVersion: result.environment?.nodeVersion ?? process.version,
      ...(baseManifest.environment?.packageManager ? { packageManager: baseManifest.environment.packageManager } : {}),
    },
    ...(typeof result.config.remnicConfig?.qmdCollection === 'string'
      ? { qmd: { collections: [result.config.remnicConfig.qmdCollection] } }
      : {}),
    configFiles: [],
    datasets: [dataset],
    results: [rawEntry],
    publicArtifacts: [publicEntry],
  };
  const manifest = {
    ...manifestWithoutHash,
    artifactHash: sha256String(stableStringify(artifactHashIdentity(manifestWithoutHash))),
  };
  const manifestPath = path.join(outDir, `MANIFEST.${benchmark}.json`);
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const comparisonPath = path.join(outDir, `${benchmark}-sota-comparison.json`);
  await fsp.writeFile(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
  const diagnostics = buildDiagnosticsSummary(resultsDir, manifest.run.id, benchmark, times.startedAt, result.meta.timestamp, generatedAt);
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
  const diagnosticsPath = path.join(outDir, `${benchmark}-diagnostics-summary.json`);
  await fsp.writeFile(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    ok: true,
    benchmark,
    outDir,
    artifactPath,
    manifestPath,
    comparisonPath,
    diagnosticsPath,
    taskCount: result.results.tasks.length,
    sotaAllCheckedMetrics: comparison.sotaAllCheckedMetrics,
    atOrAboveAllCheckedMetrics: comparison.atOrAboveAllCheckedMetrics,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
