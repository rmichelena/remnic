#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './evidence-run-utils.mjs';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function score(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '';
  }
  return Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function titleName(benchmark) {
  const names = {
    amemgym: 'AMemGym',
    beam: 'BEAM',
    locomo: 'LoCoMo',
    longmemeval: 'LongMemEval',
    memoryagentbench: 'MemoryAgentBench',
    membench: 'MemBench',
    personamem: 'PersonaMem',
  };
  return names[benchmark] ?? benchmark;
}

function comparisonRows(checks) {
  return checks.map((check) => {
    const publishable = check.publishAsSota === false ? 'reference' : 'yes';
    return `| \`${check.metric}\` | ${score(check.actual)} | ${score(check.target)} | ${score(check.delta)} | ${check.sota ? 'yes' : 'no'} | ${publishable} |`;
  }).join('\n');
}

function metricRows(metrics) {
  return Object.entries(metrics ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([metric, value]) => `| \`${metric}\` | ${score(value)} |`)
    .join('\n');
}

const args = parseArgs(process.argv.slice(2));
if (!args['evidence-dir'] || !args.out) {
  console.error('Usage: generate-public-benchmark-evidence-doc.mjs --evidence-dir <dir> --out <markdown-file> [--benchmark <id>]');
  process.exit(2);
}

const evidenceDir = path.resolve(args['evidence-dir']);
const manifestName = args.benchmark
  ? `MANIFEST.${args.benchmark}.json`
  : fs.readdirSync(evidenceDir).find((name) => /^MANIFEST\.[^.]+\.json$/.test(name) && name !== 'MANIFEST.memory-arena.json');
assert(manifestName, 'could not find benchmark manifest');

const manifest = readJson(path.join(evidenceDir, manifestName));
const benchmark = manifest.run?.selectedBenchmarks?.[0];
assert(typeof benchmark === 'string' && benchmark.length > 0, 'manifest must select a benchmark');
assert(benchmark !== 'memory-arena', 'use the MemoryArena-specific evidence doc generator for memory-arena');

const publicArtifact = manifest.publicArtifacts?.find((entry) => entry.benchmark === benchmark);
const rawResult = manifest.results?.find((entry) => entry.benchmark === benchmark);
assert(publicArtifact, 'manifest missing public artifact');
assert(rawResult, 'manifest missing raw result');

const artifact = readJson(path.join(evidenceDir, publicArtifact.path));
const comparison = readJson(path.join(evidenceDir, `${benchmark}-sota-comparison.json`));
const diagnostics = readJson(path.join(evidenceDir, `${benchmark}-diagnostics-summary.json`));
const name = titleName(benchmark);

const out = `# ${name} SOTA Evidence (Codex CLI gpt-5.5)

This document publishes the completed Remnic ${name} full run from the
\`${manifest.run.id}\` public benchmark attempt.

## Result

- Benchmark: \`${benchmark}\`
- Mode: \`${manifest.run.mode}\`
- Runtime profile: \`${manifest.run.runtimeProfiles.join(', ')}\`
- Model: \`${artifact.model}\`
- Provider: \`codex-cli\`
- Reasoning effort: \`xhigh\`
- Service tier: \`fast\`
- Seed: \`${artifact.seed}\`
- Commit: \`${manifest.git.commit}\`
- Task count: \`${artifact.perTaskScores.length}\`
- SOTA on publishable checked metrics: \`${comparison.sotaAllCheckedMetrics}\`
- At or above all publishable checked metrics: \`${comparison.atOrAboveAllCheckedMetrics}\`

## Committed Artifacts

- Public-safe result: \`docs/benchmarks/results/${manifest.run.id}/${publicArtifact.path}\`
- Manifest: \`docs/benchmarks/results/${manifest.run.id}/${manifestName}\`
- Diagnostics summary: \`docs/benchmarks/results/${manifest.run.id}/${benchmark}-diagnostics-summary.json\`
- SOTA comparison: \`docs/benchmarks/results/${manifest.run.id}/${benchmark}-sota-comparison.json\`
- Verifier: \`scripts/bench/verify-public-${benchmark}-sota-evidence.mjs\`

The raw local result is not committed because it can contain benchmark prompts,
answers, model answers, retrieved context, and local path metadata. The manifest
records the raw result path, size, and SHA-256:
\`${rawResult.sha256}\`.

## Metrics

| Metric | Value |
| --- | ---: |
${metricRows(artifact.metrics)}

## Public Comparison Source

Targets come from the public SOTA target map used while packaging this evidence.

| Metric | Remnic | Target | Delta | SOTA | Publishable |
| --- | ---: | ---: | ---: | --- | --- |
${comparisonRows(comparison.checks)}

## Reproduction

Run the benchmark from the publication branch:

\`\`\`bash
PATH=/opt/homebrew/bin:/opt/homebrew/sbin:$PATH \\
node packages/remnic-cli/bin/remnic.cjs bench published \\
  --name ${benchmark} \\
  --dataset evals/datasets/${benchmark} \\
  --runtime-profile real \\
  --provider codex-cli \\
  --model gpt-5.5 \\
  --system-codex-reasoning-effort xhigh \\
  --judge-provider codex-cli \\
  --judge-model gpt-5.5 \\
  --judge-codex-reasoning-effort xhigh \\
  --internal-provider codex-cli \\
  --internal-model gpt-5.5 \\
  --internal-codex-reasoning-effort xhigh \\
  --request-timeout 3600000 \\
  --drain-timeout 3600000 \\
  --max-429-wait 86400000 \\
  --seed 1 \\
  --results-dir ~/.remnic/bench/results/${manifest.run.id} \\
  --out docs/benchmarks/results/${manifest.run.id}
\`\`\`

Then verify the committed public evidence:

\`\`\`bash
node scripts/bench/verify-public-${benchmark}-sota-evidence.mjs \\
  docs/benchmarks/results/${manifest.run.id}
\`\`\`

The verifier recomputes metric means from public-safe per-task scores,
recomputes the SOTA comparison, checks the public artifact hash, verifies the
raw result hash recorded in the manifest, and validates the compact Codex CLI
diagnostic summary.

## Diagnostics

- Diagnostic records checked: \`${diagnostics.checked}\`
- In-flight records at cutoff: \`${diagnostics.inFlight}\`
- Invalid timestamp records excluded: \`${diagnostics.invalidTimestamps ?? 0}\`
- Errors: \`${diagnostics.errored}\`
- Nonzero exits: \`${diagnostics.nonzero}\`
- Providers: \`${JSON.stringify(diagnostics.providers)}\`
- Models: \`${JSON.stringify(diagnostics.models)}\`
- Reasoning efforts: \`${JSON.stringify(diagnostics.reasoningEfforts)}\`
- Service tiers: \`${JSON.stringify(diagnostics.serviceTiers)}\`

The committed public-safe artifact includes aggregate metrics and per-task
scores needed to recompute the result, but omits question text, expected
answers, model answers, recalled text, and answer context.
`;

fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
fs.writeFileSync(args.out, out, 'utf8');
console.log(JSON.stringify({ ok: true, benchmark, out: path.resolve(args.out) }, null, 2));
