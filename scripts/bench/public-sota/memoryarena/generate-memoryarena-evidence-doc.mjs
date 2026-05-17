#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../evidence-run-utils.mjs';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function score(value) {
  return Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function comparisonRows(checks) {
  return checks.map((check) =>
    `| \`${check.metric}\` | ${score(check.actual)} | ${score(check.target)} | ${score(check.delta)} | ${check.sota ? 'yes' : 'no'} |`,
  ).join('\n');
}

function domainRows(officialMetrics) {
  return officialMetrics.byDomain.map((row) => {
    const soft = typeof row.softProgressScore === 'number' ? score(row.softProgressScore) : '';
    return `| \`${row.domain}\` | ${row.taskCount} | ${row.scoredSubtasks} | ${score(row.successRate)} | ${score(row.progressScore)} | ${soft} |`;
  }).join('\n');
}

const args = parseArgs(process.argv.slice(2));
if (!args['evidence-dir'] || !args.out) {
  console.error('Usage: generate-memoryarena-evidence-doc.mjs --evidence-dir <dir> --out <markdown-file>');
  process.exit(2);
}

const evidenceDir = path.resolve(args['evidence-dir']);
const manifest = readJson(path.join(evidenceDir, 'MANIFEST.memory-arena.json'));
const comparison = readJson(path.join(evidenceDir, 'memory-arena-sota-comparison.json'));
const diagnostics = readJson(path.join(evidenceDir, 'memory-arena-diagnostics-summary.json'));
const publicArtifact = manifest.publicArtifacts?.find((entry) => entry.benchmark === 'memory-arena');
const rawResult = manifest.results?.find((entry) => entry.benchmark === 'memory-arena');
assert(publicArtifact, 'manifest missing memory-arena public artifact');
assert(rawResult, 'manifest missing memory-arena raw result');
const artifact = readJson(path.join(evidenceDir, publicArtifact.path));

const out = `# MemoryArena SOTA Evidence (Codex CLI gpt-5.5)

This document publishes the completed Remnic MemoryArena full run from the
\`${manifest.run.id}\` public-matrix attempt.

## Result

- Benchmark: \`memory-arena\`
- Mode: \`${manifest.run.mode}\`
- Runtime profile: \`${manifest.run.runtimeProfiles.join(', ')}\`
- Model: \`${artifact.model}\`
- Provider: \`codex-cli\`
- Reasoning effort: \`xhigh\`
- Service tier: \`fast\`
- Seed: \`${artifact.seed}\`
- Commit: \`${manifest.git.commit}\`
- Task count: \`${artifact.perTaskScores.length}\`
- Scored subtasks: \`${comparison.scoredSubtasks}\`
- Official task success rate: \`${score(comparison.official.successRate)}\` (${pct(comparison.official.successRate)})
- Official progress score: \`${score(comparison.official.progressScore)}\`
${typeof comparison.official.softProgressScore === 'number' ? `- Official soft progress score: \`${score(comparison.official.softProgressScore)}\`\n` : ''}
The run is SOTA on all checked MemoryArena paper Table 3 metrics:
\`${comparison.sotaAllCheckedMetrics}\`.

## Committed Artifacts

- Public-safe result: \`docs/benchmarks/results/${manifest.run.id}/${publicArtifact.path}\`
- Manifest: \`docs/benchmarks/results/${manifest.run.id}/MANIFEST.memory-arena.json\`
- Diagnostics summary: \`docs/benchmarks/results/${manifest.run.id}/memory-arena-diagnostics-summary.json\`
- SOTA comparison: \`docs/benchmarks/results/${manifest.run.id}/memory-arena-sota-comparison.json\`
- Verifier: \`scripts/bench/verify-public-memoryarena-sota-evidence.mjs\`

The raw local result is not committed because it can contain benchmark prompts,
answers, model answers, retrieved context, and local path metadata. The manifest
records the raw result path, size, and SHA-256:
\`${rawResult.sha256}\`.

## Official Metrics

| Domain | Tasks | Scored Subtasks | Success Rate | Progress Score | Soft Progress |
| --- | ---: | ---: | ---: | ---: | ---: |
${domainRows(artifact.memoryArenaOfficialMetrics)}

## Public Comparison Source

Targets come from MemoryArena paper Table 3 as captured in the SOTA target map
used for packaging this evidence.

| Metric | Remnic | Target | Delta | SOTA |
| --- | ---: | ---: | ---: | --- |
${comparisonRows(comparison.checks)}

## Reproduction

Run the benchmark from the publication branch:

\`\`\`bash
PATH=/opt/homebrew/bin:/opt/homebrew/sbin:$PATH \\
node packages/remnic-cli/bin/remnic.cjs bench published \\
  --name memory-arena \\
  --dataset evals/datasets/memory-arena \\
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
node scripts/bench/verify-public-memoryarena-sota-evidence.mjs \\
  docs/benchmarks/results/${manifest.run.id}
\`\`\`

The verifier recomputes official MemoryArena task-level success/progress
metrics from public-safe per-task scores, recomputes the SOTA comparison,
checks the public artifact hash, verifies the raw result hash recorded in the
manifest, and validates the compact Codex CLI diagnostic summary.

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
scores needed to recompute the official result, but omits question text,
expected answers, model answers, recalled text, and answer context.
`;

fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
fs.writeFileSync(args.out, out, 'utf8');
console.log(JSON.stringify({ ok: true, out: path.resolve(args.out) }, null, 2));
