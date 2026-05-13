import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { memBenchDefinition, runMemBenchBenchmark } from "./runner.ts";

test("MemBench open-ended official accuracy tolerates terminal answer punctuation", async () => {
  const result = await runMemBenchBenchmark({
    benchmark: memBenchDefinition,
    mode: "quick",
    limit: 1,
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return "I moved to Lisbon last spring to work from the waterfront.";
      },
      async search() {
        return [];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond() {
          return {
            text: "Lisbon.",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "membench-test-responder",
          };
        },
      },
      judge: {
        async score() {
          return 1;
        },
        async scoreWithMetrics() {
          return {
            score: 1,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "membench-test-judge",
          };
        },
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "Lisbon.");
  assert.equal(task.scores.membench_accuracy, 1);
  assert.equal(
    result.results.aggregates.membench_accuracy_factual_participant?.mean,
    1,
  );
});

test("MemBench adds recommendation cues without exposing them to answer context", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-membench-rec-"));
  const storedMessages: string[] = [];
  const recallQueries: string[] = [];

  try {
    await writeFile(
      path.join(datasetDir, "membench.json"),
      JSON.stringify([
        {
          id: "recommendation-1",
          memoryType: "factual",
          scenario: "participant",
          level: "surface",
          turns: [
            {
              role: "user",
              content:
                "For late-night coding, I recommended hojicha because it is mellow.",
            },
            {
              role: "assistant",
              content: "Hojicha for late-night coding, noted.",
            },
          ],
          question: "What tea recommendation should I use for late-night coding?",
          answer: "hojicha",
        },
      ]),
      "utf8",
    );

    const result = await runMemBenchBenchmark({
      benchmark: memBenchDefinition,
      mode: "full",
      datasetDir,
      system: {
        async reset() {
          storedMessages.length = 0;
        },
        async store(_sessionId, messages) {
          storedMessages.push(...messages.map((message) => message.content));
        },
        async recall(_sessionId, query) {
          recallQueries.push(query);
          return storedMessages.join("\n\n");
        },
        async search() {
          return [];
        },
        async destroy() {},
        async getStats() {
          return { totalMessages: storedMessages.length, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(question, context) {
            assert.match(question, /Return only the exact recommended item/);
            assert.match(context, /hojicha/);
            assert.doesNotMatch(context, /MemBench semantic cues/);
            return {
              text: "hojicha",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "membench-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 1;
          },
          async scoreWithMetrics(_question, predicted, expected) {
            return {
              score: predicted === expected ? 1 : 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "membench-test-judge",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.match(storedMessages.join("\n"), /MemBench semantic cues:/);
    assert.match(recallQueries[0] ?? "", /exact recommendation/);
    assert.equal(task.scores.membench_accuracy, 1);
    assert.equal(task.scores.f1, 1);
    assert.equal(task.details.predictedAnswer, "hojicha");
  } finally {
    await rm(datasetDir, { recursive: true, force: true });
  }
});
