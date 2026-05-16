import test from "node:test";
import assert from "node:assert/strict";
import { comparePublicBenchmarkSota } from "../scripts/bench/public-sota/compare-public-benchmark-sota.mjs";

const TARGET_MAP = {
  benchmarks: {
    personamem: {
      targets: {
        "32k": { score: 0.8 },
        "128k": { score: 0.52 },
        "1M": { score: 0.45 },
      },
    },
  },
};

test("PersonaMem SOTA comparison only requires the runner-supported 32k split", () => {
  const comparison = comparePublicBenchmarkSota(
    {
      meta: {
        benchmark: "personamem",
        gitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      results: {
        tasks: [
          {
            taskId: "persona-1-q0",
            details: {
              chatHistory32kLink: "benchmark/data/persona-1-32k.json",
              chatHistory128kLink: "benchmark/data/persona-1-128k.json",
            },
            scores: {
              mcq_accuracy: 1,
            },
          },
        ],
      },
    },
    TARGET_MAP,
  );

  assert.deepEqual(
    comparison.checks.map((check) => check.metric),
    ["personamem_32k_mcq_accuracy"],
  );
  assert.equal(comparison.checks[0]?.target, 0.8);
  assert.equal(comparison.checks[0]?.sota, true);
  assert.equal(comparison.sotaAllCheckedMetrics, true);
  assert.equal(comparison.atOrAboveAllCheckedMetrics, true);
});

test("PersonaMem SOTA comparison rejects results without supported 32k evidence", () => {
  assert.throws(
    () =>
      comparePublicBenchmarkSota(
        {
          meta: {
            benchmark: "personamem",
            gitSha: "0123456789abcdef0123456789abcdef01234567",
          },
          results: {
            tasks: [
              {
                taskId: "persona-1-q0",
                details: {
                  split: "128k",
                  chatHistory128kLink: "benchmark/data/persona-1-128k.json",
                },
                scores: {
                  mcq_accuracy: 1,
                },
              },
            ],
          },
        },
        TARGET_MAP,
      ),
    /PersonaMem result missing supported 32k split/,
  );
});
