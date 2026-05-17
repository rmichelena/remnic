import test from "node:test";
import assert from "node:assert/strict";
import { comparePublicBenchmarkSota } from "../scripts/bench/public-sota/compare-public-benchmark-sota.mjs";

const TARGET_MAP = {
  benchmarks: {
    beam: {
      targets: {
        "4k": { score: 0.5 },
      },
    },
  },
};

test("BEAM SOTA comparison falls back to rubric coverage for incomplete llm_judge splits", () => {
  const comparison = comparePublicBenchmarkSota(
    {
      meta: {
        benchmark: "beam",
        gitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      results: {
        tasks: [
          {
            taskId: "4k-1",
            details: { scale: "4k" },
            scores: {
              llm_judge: 1,
              rubric_coverage: 0.2,
            },
          },
          {
            taskId: "4k-2",
            details: { scale: "4k" },
            scores: {
              rubric_coverage: 0.4,
            },
          },
        ],
      },
    },
    TARGET_MAP,
  );

  assert.equal(comparison.checks[0]?.metric, "beam_4k");
  assert.ok(Math.abs((comparison.checks[0]?.actual ?? 0) - 0.3) < 1e-9);
});

test("BEAM SOTA comparison uses llm_judge when the whole split has it", () => {
  const comparison = comparePublicBenchmarkSota(
    {
      meta: {
        benchmark: "beam",
        gitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      results: {
        tasks: [
          {
            taskId: "4k-1",
            details: { scale: "4k" },
            scores: {
              llm_judge: 1,
              rubric_coverage: 0,
            },
          },
          {
            taskId: "4k-2",
            details: { scale: "4k" },
            scores: {
              llm_judge: 0.8,
              rubric_coverage: 0,
            },
          },
        ],
      },
    },
    TARGET_MAP,
  );

  assert.equal(comparison.checks[0]?.metric, "beam_4k");
  assert.equal(comparison.checks[0]?.actual, 0.9);
});
