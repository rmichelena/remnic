import test from "node:test";
import assert from "node:assert/strict";
import { compareMemoryArenaSota } from "../scripts/bench/public-sota/memoryarena/compare-memoryarena-sota.mjs";

const TARGET_MAP = {
  benchmarks: {
    "memory-arena": {
      targets: {
        allTaskAverageSuccessRate: { score: 0.19 },
        bundledWebShopping: { successRate: 0.12, progressScore: 0.79 },
        groupTravelPlanning: { successRate: 0, progressScore: 0.06, softProgressScore: 0.62 },
        progressiveWebSearch: { successRate: 0.28, progressScore: 0.32 },
        formalReasoning: { mathSuccessRate: 0.6, physSuccessRate: 0.7, processScore: 0.65 },
      },
    },
  },
};

test("MemoryArena SOTA comparison treats zero-target equality as a tie, not SOTA", () => {
  const comparison = compareMemoryArenaSota(
    {
      meta: {
        benchmark: "memory-arena",
        mode: "full",
        gitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      results: {
        tasks: [
          memoryArenaSubtask("bundled_shopping", 1, 0, 1, 1),
          memoryArenaSubtask("group_travel_planner", 2, 0, 1, undefined, { plan_field_recall: 1 }),
          memoryArenaSubtask("group_travel_planner", 2, 1, 0, 0, { plan_field_recall: 1 }),
          memoryArenaSubtask("progressive_search", 3, 0, 1, 1),
          memoryArenaSubtask("formal_reasoning_math", 4, 0, 1, 1),
          memoryArenaSubtask("formal_reasoning_phys", 5, 0, 1, 1),
        ],
      },
    },
    TARGET_MAP,
  );

  const travelSuccess = comparison.checks.find(
    (check) => check.metric === "group_travel_planning_success_rate",
  );
  assert.equal(travelSuccess?.target, 0);
  assert.equal(travelSuccess?.actual, 0);
  assert.equal(travelSuccess?.tied, true);
  assert.equal(travelSuccess?.sota, false);
  assert.equal("sotaCriterion" in (travelSuccess ?? {}), false);
  assert.equal(comparison.sotaAllCheckedMetrics, false);
  assert.equal(comparison.atOrAboveAllCheckedMetrics, true);
});

test("MemoryArena SOTA comparison treats floating-point ties as ties, not SOTA", () => {
  const result = {
    meta: {
      benchmark: "memory-arena",
      mode: "full",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
    },
    results: {
      tasks: [
        memoryArenaSubtask("bundled_shopping", 1, 0, 1, 0.1),
        memoryArenaSubtask("bundled_shopping", 2, 0, 1, 0.2),
        memoryArenaSubtask("group_travel_planner", 2, 0, 1, 1),
        memoryArenaSubtask("progressive_search", 3, 0, 1, 1),
        memoryArenaSubtask("formal_reasoning_math", 4, 0, 1, 1),
        memoryArenaSubtask("formal_reasoning_phys", 5, 0, 1, 1),
      ],
    },
  };
  const targetMap = {
    benchmarks: {
      "memory-arena": {
        targets: {
          allTaskAverageSuccessRate: { score: 0 },
          bundledWebShopping: {
            successRate: 0.15,
            progressScore: 0,
          },
          groupTravelPlanning: {
            successRate: 0,
            progressScore: 0,
            softProgressScore: 0,
          },
          progressiveWebSearch: {
            successRate: 0,
            progressScore: 0,
          },
          formalReasoning: {
            mathSuccessRate: 0,
            physSuccessRate: 0,
            processScore: 0,
          },
        },
      },
    },
  };

  const comparison = compareMemoryArenaSota(result, targetMap);
  const bundledProgress = comparison.checks.find((check) => check.metric === "bundled_web_shopping_success_rate");

  assert.equal(bundledProgress?.sota, false);
  assert.equal(bundledProgress?.tied, true);
});

function memoryArenaSubtask(
  domain: string,
  taskId: number,
  subtaskIndex: number,
  processScore: number,
  taskSuccessRate?: number,
  extraScores: Record<string, number> = {},
): unknown {
  return {
    taskId: `${domain}-${taskId}-${subtaskIndex}`,
    details: {
      domain,
      taskId,
      subtaskIndex,
    },
    scores: {
      process_score: processScore,
      ...(taskSuccessRate === undefined ? {} : { task_success_rate: taskSuccessRate }),
      ...extraScores,
    },
  };
}
