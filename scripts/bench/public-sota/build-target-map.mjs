#!/usr/bin/env node
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = process.argv[2] ?? path.join(scriptDir, 'current-target-map.json');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          reject(new Error(`${url} returned ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        resolve(JSON.parse(body));
      });
    }).on('error', reject);
  });
}

function best(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return undefined;
  }
  return [...rows].sort((a, b) => Number(b.accuracy ?? 0) - Number(a.accuracy ?? 0))[0];
}

function bestBySplitFromExternal(external, dataset) {
  const bySplit = external[dataset];
  if (!bySplit) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(bySplit).flatMap(([split, rows]) => {
      const row = best(rows);
      if (!row) {
        return [];
      }
      return [[split, {
        score: row.accuracy,
        method: row.memory,
        sourceLabel: row.source_label,
        sourceUrl: row.source_url,
        comment: row.comment,
      }]];
    }),
  );
}

function bestBySplitFromAmbResults(results, dataset) {
  const bySplit = {};
  for (const row of results.filter((entry) => entry.dataset === dataset)) {
    const split = row.split ?? 'default';
    if (!bySplit[split] || Number(row.accuracy) > Number(bySplit[split].score)) {
      bySplit[split] = {
        score: row.accuracy,
        method: row.memory,
        runName: row.run_name,
        sourcePath: row.path,
        totalQueries: row.total_queries,
      };
    }
  }
  return bySplit;
}

function maxTarget(...targets) {
  const rows = targets.filter(Boolean);
  if (rows.length === 0) {
    return undefined;
  }
  return rows.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))[0];
}

const external = await fetchJson('https://agentmemorybenchmark.ai/api/external-results');
const ambResults = await fetchJson('https://agentmemorybenchmark.ai/api/results');
const catalog = await fetchJson('https://agentmemorybenchmark.ai/api/catalog');

const liveTargets = {};
for (const dataset of ['ama-bench', 'longmemeval', 'locomo', 'beam', 'personamem', 'membench']) {
  liveTargets[dataset] = {
    external: bestBySplitFromExternal(external, dataset),
    ambReproduced: bestBySplitFromAmbResults(ambResults, dataset),
  };
}

const targetMap = {
  generatedAt: new Date().toISOString(),
  sources: {
    ambExternalResults: 'https://agentmemorybenchmark.ai/api/external-results',
    ambResults: 'https://agentmemorybenchmark.ai/api/results',
    ambCatalog: 'https://agentmemorybenchmark.ai/api/catalog',
    memoryArenaPaper: 'https://arxiv.org/abs/2602.16313',
    amemGymPaper: 'https://arxiv.org/abs/2603.01966',
    memoryAgentBenchPaper: 'https://arxiv.org/abs/2507.05257',
  },
  benchmarks: {
    'ama-bench': {
      primaryMetric: 'ama_bench_leaderboard_average',
      comparison: 'agent/memory-system leaderboard average across 24 domain x qaType cells',
      target: liveTargets['ama-bench'].external.test,
      caveat: 'Model-only long-context results are tracked separately; Remnic PR #1005 claims agent/memory-system SOTA only.',
    },
    'memory-arena': {
      primaryMetric: 'task_success_rate and task_progress_score',
      comparison: 'paper Table 3 reports SR and PS by environment plus all-task average SR; Group Travel Planning additionally uses sPS',
      targets: {
        allTaskAverageSuccessRate: {
          score: 0.19,
          method: 'Claude-Sonnet-4.5 long-context',
          sourceLabel: 'MemoryArena paper Table 3',
        },
        bundledWebShopping: {
          successRate: 0.12,
          progressScore: 0.79,
          method: 'Claude-Sonnet-4.5 long-context',
          sourceLabel: 'MemoryArena paper Table 3',
        },
        groupTravelPlanning: {
          successRate: 0,
          progressScore: 0.06,
          softProgressScore: 0.62,
          method: 'Gemini-3-Flash long-context',
          sourceLabel: 'MemoryArena paper Table 3',
        },
        progressiveWebSearch: {
          successRate: 0.28,
          progressScore: 0.32,
          method: 'BM25 / Text-Embedding-3-Small RAG',
          sourceLabel: 'MemoryArena paper Table 3',
        },
        formalReasoning: {
          mathSuccessRate: 0.60,
          physSuccessRate: 0.70,
          processScore: 0.65,
          method: 'Text-Embedding-3-Small RAG',
          sourceLabel: 'MemoryArena paper Table 3',
        },
      },
      note: 'Raw Remnic process_score means are subtask-weighted; official PS must average per-task subtask pass fractions.',
    },
    amemgym: {
      primaryMetric: 'normalized_memory_score',
      comparison: 'on-policy memory score from AMemGym paper',
      targets: {
        nativeLlm: {
          score: 0.463,
          method: 'gemini-3-pro-preview',
          sourceLabel: 'AMemGym paper Figure 5',
        },
        memoryAgent: {
          score: 0.296,
          method: 'AWE-(2,4,30)',
          sourceLabel: 'AMemGym paper Figure 6',
        },
      },
      note: 'Paper separates native LLMs from memory agents; use the memory-agent target for Remnic memory-system SOTA unless making a model-only claim.',
    },
    longmemeval: {
      primaryMetric: 'llm_judge/pass-rate accuracy on LongMemEval-S',
      comparison: 'max of live AMB reproduced and external reported targets',
      target: maxTarget(
        liveTargets.longmemeval.ambReproduced.s,
        liveTargets.longmemeval.external.s,
      ),
      live: liveTargets.longmemeval,
      scoringNote: catalog.datasets.longmemeval.scoring_note,
    },
    locomo: {
      primaryMetric: 'LLM-judge pass-rate accuracy on locomo10',
      comparison: 'max of live AMB reproduced and external reported targets',
      target: maxTarget(
        liveTargets.locomo.ambReproduced.locomo10,
        liveTargets.locomo.external.locomo10,
      ),
      live: liveTargets.locomo,
      scoringNote: catalog.datasets.locomo.scoring_note,
    },
    beam: {
      primaryMetric: 'mean rubric score by split',
      comparison: 'live AMB reproduced target per split',
      targets: liveTargets.beam.ambReproduced,
      external: liveTargets.beam.external,
      scoringNote: catalog.datasets.beam.scoring_note,
    },
    personamem: {
      primaryMetric: 'MCQ accuracy by split',
      comparison: 'live AMB reproduced target for 32k; paper targets for 128k and 1M',
      targets: {
        '32k': liveTargets.personamem.ambReproduced['32k'],
        '128k': liveTargets.personamem.external['128k'],
        '1M': liveTargets.personamem.external['1M'],
      },
      scoringNote: catalog.datasets.personamem.scoring_note,
    },
    memoryagentbench: {
      primaryMetric: 'official protocol accuracy/recall/F1 by competency and overall score',
      comparison: 'paper Table 3 overall score',
      targets: {
        overallScore: {
          score: 49.6,
          method: 'Claude-3.7-Sonnet long-context',
          sourceLabel: 'MemoryAgentBench paper Table 3',
        },
        strongestMemoryAgentOverall: {
          score: 37.7,
          method: 'MIRIX (GPT-4.1-mini)',
          sourceLabel: 'MemoryAgentBench paper Table 3',
        },
      },
      note: 'Paper reports percentages; Remnic artifacts may emit 0-1 fractions. Normalize before comparison.',
    },
    membench: {
      primaryMetric: 'MCQ accuracy by split',
      comparison: 'paper split targets surfaced by AMB external API',
      targets: liveTargets.membench.external,
      scoringNote: catalog.datasets.membench.scoring_note,
    },
  },
};

fs.writeFileSync(OUT_PATH, JSON.stringify(targetMap, null, 2) + '\n');
console.log(JSON.stringify({
  ok: true,
  outPath: OUT_PATH,
  generatedAt: targetMap.generatedAt,
  benchmarks: Object.keys(targetMap.benchmarks),
}, null, 2));
