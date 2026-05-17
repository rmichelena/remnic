import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  sha256File,
  sha256String,
  stableStringify,
} from './evidence-integrity.mjs';

export function parseArgs(argv) {
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

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function assertNoInvalidRawScores(result) {
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

export function assertCodexProvider(config, label, { required = true } = {}) {
  if (!config) {
    assert(!required, `${label} provider is required`);
    return;
  }
  assert(config.provider === 'codex-cli', `${label} provider must be codex-cli`);
  assert(config.model === 'gpt-5.5', `${label} model must be gpt-5.5`);
  assert(config.reasoningEffort === 'xhigh', `${label} reasoning must be xhigh`);
}

function safeRealpath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return undefined;
  }
}

function addPathReplacement(replacements, value, replacement) {
  if (typeof value !== 'string' || value.length === 0) {
    return;
  }
  replacements.push([path.resolve(value), replacement]);
  const realpath = safeRealpath(value);
  if (realpath) {
    replacements.push([realpath, replacement]);
  }
}

export function pathReplacements(repoRoot, resultsDir, outDir, datasetDir) {
  const replacements = [];
  addPathReplacement(replacements, repoRoot, '<repo-root>');
  addPathReplacement(replacements, resultsDir, '<results-dir>');
  addPathReplacement(replacements, outDir, '<out-dir>');
  addPathReplacement(replacements, datasetDir, '<dataset-dir>');
  addPathReplacement(replacements, os.homedir(), '~');
  const seen = new Set();
  return replacements
    .filter(([needle]) => {
      if (seen.has(needle)) {
        return false;
      }
      seen.add(needle);
      return true;
    })
    .sort(([left], [right]) => right.length - left.length);
}

export function scrubPath(repoRoot, value, replacements = pathReplacements(repoRoot)) {
  if (typeof value !== 'string' || value.length === 0) {
    return value;
  }
  const rel = path.relative(path.resolve(repoRoot), path.resolve(value));
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/');
  }
  return replacements.reduce((out, [needle, replacement]) => out.replaceAll(needle, replacement), value);
}

export function sanitizeArgv(argv, replacements, fallbackArgv = process.argv.slice(2)) {
  const sourceArgv = Array.isArray(argv) && argv.length > 0 ? argv : fallbackArgv;
  return sourceArgv.map((arg) => {
    if (typeof arg !== 'string') {
      return String(arg);
    }
    return replacements.reduce((value, [needle, replacement]) => value.replaceAll(needle, replacement), arg);
  });
}

export function assertInsideResultsDir(resultPath, resultsDir, message = 'raw result must be inside --results-dir') {
  const rel = path.relative(resultsDir, resultPath);
  assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), message);
}

export async function scanDataset(datasetDir, repoRoot, benchmark, replacements) {
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
    path: scrubPath(repoRoot, datasetDir, replacements),
    realpath: scrubPath(repoRoot, await fsp.realpath(root), replacements),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    sha256: sha256String(stableStringify(files)),
    files,
  };
}

export function assertDatasetMatchesRunManifest(baseManifest, benchmark, dataset) {
  const manifestDataset = Array.isArray(baseManifest.datasets)
    ? baseManifest.datasets.find((entry) => entry?.benchmark === benchmark)
    : undefined;
  assert(manifestDataset, `run manifest must include dataset entry for ${benchmark}`);
  assert(manifestDataset.status === 'hashed', `run manifest dataset entry for ${benchmark} must be hashed`);
  assert(manifestDataset.sha256 === dataset.sha256, `dataset hash for ${benchmark} does not match the run manifest`);
  assert(manifestDataset.fileCount === dataset.fileCount, `dataset file count for ${benchmark} does not match the run manifest`);
  assert(manifestDataset.totalBytes === dataset.totalBytes, `dataset byte count for ${benchmark} does not match the run manifest`);
}

function statusEntryPath(entry) {
  return entry.slice(3).replace(/^"|"$/g, '').split(' -> ').at(-1);
}

function isIgnoredDirtyEntry(entry, ignoredRelativePrefixes) {
  const entryPath = statusEntryPath(entry);
  return ignoredRelativePrefixes.some((prefix) => entryPath === prefix || entryPath.startsWith(prefix));
}

export function gitInfo(repoRoot, result, ignoredRelativePrefixes = []) {
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
    commit: result.meta?.gitSha ?? 'unknown',
    shortCommit: String(result.meta?.gitSha ?? 'unknown').slice(0, 8),
    dirty: dirtyEntries.length > 0,
    dirtyEntryCount: dirtyEntries.length,
  };
}

export function resultManifestEntry(resultPath, resultsDir, result, benchmark = result.meta?.benchmark) {
  const stat = fs.statSync(resultPath);
  return {
    path: path.relative(resultsDir, resultPath).split(path.sep).join('/'),
    sha256: sha256File(resultPath),
    sizeBytes: stat.size,
    resultId: result.meta.id,
    benchmark,
    mode: result.meta.mode,
    gitSha: result.meta.gitSha,
    runCount: result.meta.runCount,
    seeds: [...result.meta.seeds],
    taskCount: result.results.tasks.length,
    configHash: sha256String(stableStringify(result.config)),
  };
}

export function assertResultMatchesRunManifest(baseManifest, rawEntry) {
  const manifestResult = Array.isArray(baseManifest.results)
    ? baseManifest.results.find((entry) => entry?.path === rawEntry.path)
    : undefined;
  assert(manifestResult, `run manifest must include result entry for ${rawEntry.path}`);
  for (const field of ['sha256', 'resultId', 'gitSha', 'taskCount']) {
    assert(
      manifestResult[field] === rawEntry[field],
      `raw result ${field} for ${rawEntry.path} does not match the run manifest`,
    );
  }
}

function parseTimestampMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : undefined;
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
    increment(out.statuses, String(record.result?.status ?? '<missing>'));
  }
  return out;
}

function increment(record, key) {
  const safeKey = typeof key === 'string' && key.length > 0 ? key : '<missing>';
  record[safeKey] = (record[safeKey] ?? 0) + 1;
}

export function buildDiagnosticsSummary(resultsDir, runId, benchmark, startedAt, finishedAt, generatedAt) {
  const diagnosticsDir = path.join(resultsDir, 'codex-cli-diagnostics');
  if (!fs.existsSync(diagnosticsDir)) {
    return undefined;
  }
  const startedAtMs = parseTimestampMs(startedAt);
  const finishedAtMs = parseTimestampMs(finishedAt);
  assert(startedAtMs !== undefined, 'diagnostics summary start timestamp must be valid');
  assert(finishedAtMs !== undefined, 'diagnostics summary finish timestamp must be valid');
  const files = fs.readdirSync(diagnosticsDir).filter((name) => name.endsWith('.json'));
  const checked = [];
  let beforeStart = 0;
  let afterCutoff = 0;
  let inFlight = 0;
  let invalidTimestamps = 0;
  for (const name of files) {
    const record = readJson(path.join(diagnosticsDir, name));
    if (runId && record.runId !== runId) {
      continue;
    }
    if (!record.finishedAt) {
      inFlight += 1;
      continue;
    }
    const recordStartedAtMs = parseTimestampMs(record.startedAt);
    const recordFinishedAtMs = parseTimestampMs(record.finishedAt);
    if (recordStartedAtMs === undefined || recordFinishedAtMs === undefined) {
      invalidTimestamps += 1;
      continue;
    }
    if (recordStartedAtMs < startedAtMs) {
      beforeStart += 1;
      continue;
    }
    if (recordFinishedAtMs > finishedAtMs) {
      afterCutoff += 1;
      continue;
    }
    checked.push(record);
  }
  const startedValues = checked.map((record) => record.startedAt).filter(Boolean).sort();
  const finishedValues = checked.map((record) => record.finishedAt).filter(Boolean).sort();
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
    invalidTimestamps,
    errored: checked.filter((record) => record.error).length,
    nonzero: checked.filter((record) => record.result && record.result.status !== 0).length,
    ...providerDistributionSummary(checked),
    minStartedAt: startedValues[0],
    maxFinishedAt: finishedValues.at(-1),
  };
}

export function assertCodexDiagnostics(diagnostics, taskCount) {
  assert(diagnostics, 'codex-cli diagnostics are required to prove provider/model/reasoning/service-tier for public evidence');
  assert(diagnostics.checked > 0, 'diagnostics must include at least one completed record');
  assert(diagnostics.complete === diagnostics.checked, 'diagnostics complete count must match checked records');
  assert(diagnostics.inFlight === 0, 'diagnostics must have zero in-flight records');
  assert(diagnostics.afterCutoff === 0, 'diagnostics must have zero after-cutoff records');
  assert(diagnostics.invalidTimestamps === 0, 'diagnostics must have zero invalid timestamps');
  assert(diagnostics.errored === 0, 'diagnostics must have zero errors');
  assert(diagnostics.nonzero === 0, 'diagnostics must have zero nonzero exits');
  assert(
    diagnostics.checked >= taskCount,
    `diagnostics checked count must cover published task count (${diagnostics.checked} < ${taskCount})`,
  );
  assert(diagnostics.providers?.['codex-cli'] === diagnostics.checked, 'diagnostics provider distribution must be all codex-cli');
  assert(diagnostics.models?.['gpt-5.5'] === diagnostics.checked, 'diagnostics model distribution must be all gpt-5.5');
  assert(diagnostics.reasoningEfforts?.xhigh === diagnostics.checked, 'diagnostics reasoning distribution must be all xhigh');
  assert(diagnostics.serviceTiers?.fast === diagnostics.checked, 'diagnostics service tier distribution must be all fast');
}

export function statusTimes(resultsDir, benchmark, fallback) {
  const statusPath = path.join(resultsDir, 'status.tsv');
  if (!fs.existsSync(statusPath)) {
    return { startedAt: fallback, successAt: fallback };
  }
  const body = fs.readFileSync(statusPath, 'utf8').trim();
  const rows = body ? body.split(/\r?\n/).slice(1).map((line) => line.split('\t')) : [];
  const matching = rows.filter(([name]) => name === benchmark);
  return {
    startedAt: matching.find(([, status]) => status === 'start')?.[2] ?? fallback,
    successAt: [...matching].reverse().find(([, status]) => status === 'success')?.[2] ?? fallback,
  };
}

export function assertClose(actual, expected, label) {
  assert(typeof actual === 'number' && Number.isFinite(actual), `${label} must be finite`);
  assert(typeof expected === 'number' && Number.isFinite(expected), `${label} expected must be finite`);
  assert(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, got ${actual}`);
}

export function compareJson(actual, expected, label) {
  assert(stableStringify(actual) === stableStringify(expected), `${label} mismatch`);
}

export function assertPublicSafeArtifact(artifact) {
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
