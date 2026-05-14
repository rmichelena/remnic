import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { memoryArenaDefinition, runMemoryArenaBenchmark } from "./runner.ts";

test("MemoryArena derives missing categories from the source filename", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "formal_reasoning_math.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 7,
        category: null,
        questions: ["Which proof topic did we review?"],
        answers: ["number theory"],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "number theory";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
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
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.equal(
      result.results.tasks[0]?.details?.category,
      "formal_reasoning_math",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena quick fixture seeds prerequisite subtasks before scoring follow-ups", async () => {
  const storedMessages: string[] = [];
  const recalledQueries: string[] = [];
  const completedCounts: number[] = [];

  const result = await runMemoryArenaBenchmark({
    benchmark: memoryArenaDefinition,
    mode: "quick",
    system: {
      async store(_sessionId, messages) {
        storedMessages.push(...messages.map((message) => message.content));
      },
      async recall(_sessionId, query) {
        recalledQueries.push(query);
        return storedMessages.join("\n\n");
      },
      async search() {
        return [];
      },
      async reset() {
        storedMessages.length = 0;
      },
      async destroy() {},
      async drain() {},
      async getStats() {
        return { totalMessages: storedMessages.length, totalSummaryNodes: 0, maxDepth: 0 };
      },
      judge: {
        async score() {
          return 1;
        },
        async scoreWithMetrics(_question, predicted, expected) {
          return {
            score: predicted.includes(expected) ? 1 : 0,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "judge-smoke",
          };
        },
      },
    },
    onTaskComplete(_task, completed) {
      completedCounts.push(completed);
    },
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.taskId, "bundled_shopping-t1-q1");
  assert.equal(result.results.tasks[0]?.expected, "trail mix");
  assert.equal(result.results.tasks[0]?.scores.contains_answer, 1);
  assert.equal(result.results.tasks[0]?.scores.process_score, 1);
  assert.equal(result.results.tasks[0]?.scores.task_success_rate, 1);
  assert.match(result.results.tasks[0]?.actual ?? "", /trail mix/);
  assert.deepEqual(completedCounts, [1]);
  assert.equal(recalledQueries.length, 1);
  assert.match(storedMessages.join("\n"), /Environment result: trail mix/);
});

test("MemoryArena accepts optional string-array backgrounds from dataset files", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 8,
        category: "shopping",
        questions: [
          "What did the previous shopper choose?",
          "Which item should be packed?",
        ],
        answers: ["trail mix", "trail mix"],
        backgrounds: ["The shopper already bought trail mix.", ""],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "trail mix";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
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
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 2);
    assert.equal(result.results.tasks[0]?.taskId, "shopping-t8-q0");
    assert.equal(result.results.tasks[1]?.taskId, "shopping-t8-q1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena passes the live task prompt into answer context", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 9,
        category: "bundled_shopping",
        questions: [
          "Product 1 options: ASIN A costs $4. Product 2 options: ASIN B costs $5. Which bundle should be purchased?",
        ],
        answers: ["ASIN A | ASIN B"],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "Prior memory context.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "ASIN A | ASIN B",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
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
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.match(responderContext, /Current MemoryArena task prompt/);
    assert.match(responderContext, /Product 1 options: ASIN A/);
    assert.match(responderContext, /Prior memory context/);
    assert.doesNotMatch(
      responderContext,
      /Best-supported option by current rules/,
    );
    assert.match(
      String(result.results.tasks[0]?.details?.answerContext ?? ""),
      /Product 2 options: ASIN B/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena item-selection context prioritizes compact prior environment results", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  const storedMessages: string[] = [];
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 15,
        category: "bundled_shopping",
        questions: [
          [
            "Product 1:",
            "### Select Base",
            "**Goal:** Buy the base.",
            "**Available Options:**",
            "- A stale old option that must not be replayed.",
            "- A vanilla cake base.",
          ].join("\n"),
          [
            "Product 2:",
            "### Select Frosting",
            "**Goal:** Vanilla pairs well with White.",
            "**Constraint:** Must be compatible with the previous product.",
            "**Available Options:**",
            "- A white frosting.",
            "- A chocolate frosting.",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "B00-BASE",
            attributes: ["vanilla cake base"],
          },
          {
            target_asin: "B00-WHITE",
            attributes: ["white frosting"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store(_sessionId, messages) {
          storedMessages.push(...messages.map((message) => message.content));
        },
        async recall() {
          return storedMessages.join("\n\n");
        },
        async search() {
          return [];
        },
        async reset() {
          storedMessages.length = 0;
        },
        async drain() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: storedMessages.length, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "item: A white frosting.; attributes: white frosting",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.match(responderContext, /Prior completed MemoryArena subtasks/);
    assert.match(responderContext, /Environment result: B00-BASE/);
    assert.match(responderContext, /Selected item attributes: vanilla cake base/);
    assert.match(responderContext, /A white frosting/);
    assert.doesNotMatch(responderContext, /stale old option/);
    assert.equal(result.results.tasks[0]?.scores.item_selection_match, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena item-selection context includes WebShop sidecar observations", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  const sidecarPath = path.join(tempDir, "webshop-products.jsonl");
  const previousSidecarPath =
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
  const storedMessages: string[] = [];
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 16,
        category: "bundled_shopping",
        questions: [
          [
            "Product 1:",
            "### Select Base",
            "**Goal:** Buy the cake base.",
            "**Available Options:**",
            "- A vanilla cake base.",
          ].join("\n"),
          [
            "Product 2:",
            "### Select Decorations",
            "**Goal:** Compatibility notes: Vanilla pairs well with Rose.",
            "**Preference:** Pick the highest-priced option among those compatible with the notes.",
            "**Constraint:** Must be compatible with the previous (ground truth) products.",
            "**Available Options:**",
            "- A low-price chocolate sprinkle mix for cakes.",
            "- A Dessert Rose Sprinkle Mix for cupcakes and baked goods.",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "BASE000001",
            attributes: ["vanilla cake base"],
          },
          {
            target_asin: "B08957C9ZH",
            attributes: ["dessert rose", "sprinkle mix"],
          },
        ],
      }) + "\n",
      "utf8",
    );
    await writeFile(
      sidecarPath,
      [
        JSON.stringify({
          asin: "BASE000001",
          name: "Vanilla Cake Base",
          pricing: "$3.00",
          average_rating: 4.5,
          total_reviews: 10,
          product_category: "Grocery & Gourmet Food > Cakes",
        }),
        JSON.stringify({
          asin: "LOWPRICE01",
          name: "Low Price Chocolate Sprinkle Mix for Cakes",
          pricing: "$4.00",
          average_rating: 4.9,
          total_reviews: 50,
          product_category: "Grocery & Gourmet Food > Sprinkles",
        }),
        JSON.stringify({
          asin: "B08957C9ZH",
          name: "Dessert Rose Sprinkle Mix for cupcakes and baked goods",
          pricing: "$12.00",
          average_rating: 4.2,
          total_reviews: 9,
          product_category: "Grocery & Gourmet Food > Sprinkles",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS = sidecarPath;

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store(_sessionId, messages) {
          storedMessages.push(...messages.map((message) => message.content));
        },
        async recall() {
          return storedMessages.join("\n\n");
        },
        async search() {
          return [];
        },
        async reset() {
          storedMessages.length = 0;
        },
        async drain() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: storedMessages.length, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "target_asin: B08957C9ZH; item: A Dessert Rose Sprinkle Mix for cupcakes and baked goods.; attributes: dessert rose, sprinkle mix",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.match(responderContext, /WebShop environment observations/);
    assert.match(responderContext, /Selected WebShop product title: Vanilla Cake Base/);
    assert.match(responderContext, /LOWPRICE01/);
    assert.match(responderContext, /\$4\.00/);
    assert.match(responderContext, /B08957C9ZH/);
    assert.match(responderContext, /\$12\.00/);
    assert.match(responderContext, /Average rating: 4\.2/);
    assert.match(responderContext, /WebShop derived decision support/);
    assert.match(
      String(result.results.tasks[0]?.details?.promptQuestion ?? ""),
      /return that option/,
    );
    assert.match(responderContext, /Prior selected rule labels detected: Vanilla/);
    assert.match(
      responderContext,
      /Best-supported option by current rules: Option 2: A Dessert Rose Sprinkle Mix/,
    );
    assert.equal(
      result.results.tasks[0]?.details?.webshopProductCatalog,
      sidecarPath,
    );
    assert.equal(result.results.tasks[0]?.scores.item_selection_match, 1);
    assert.equal(result.results.tasks[0]?.scores.process_score, 1);
  } finally {
    if (previousSidecarPath === undefined) {
      delete process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
    } else {
      process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS =
        previousSidecarPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena matches WebShop sidecar observations for ASIN-only options", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  const sidecarPath = path.join(tempDir, "webshop-products.jsonl");
  const previousSidecarPath =
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 17,
        category: "bundled_shopping",
        questions: [
          [
            "Product 1:",
            "### Select Sprinkles",
            "**Goal:** Buy the dessert rose sprinkle mix.",
            "**Available Options:**",
            "- B08957C9ZH",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "B08957C9ZH",
            attributes: ["dessert rose", "sprinkle mix"],
          },
        ],
      }) + "\n",
      "utf8",
    );
    await writeFile(
      sidecarPath,
      JSON.stringify([
        {
          asin: "B08957C9ZH",
          name: "Dessert Rose Sprinkle Mix for cupcakes and baked goods",
          pricing: "$12.00",
          average_rating: 4.2,
          total_reviews: 9,
          product_category: "Grocery & Gourmet Food > Sprinkles",
        },
      ]) + "\n",
      "utf8",
    );
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS = sidecarPath;

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "";
        },
        async search() {
          return [];
        },
        async reset() {},
        async drain() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "target_asin: B08957C9ZH; attributes: dessert rose, sprinkle mix",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.match(responderContext, /WebShop environment observations/);
    assert.match(responderContext, /Option 1: B08957C9ZH/);
    assert.match(responderContext, /Dessert Rose Sprinkle Mix/);
    assert.match(responderContext, /\$12\.00/);
    assert.equal(result.results.tasks[0]?.scores.item_selection_match, 1);
  } finally {
    if (previousSidecarPath === undefined) {
      delete process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
    } else {
      process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS =
        previousSidecarPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena no-responder runs do not score the live task prompt as recall", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 10,
        category: "bundled_shopping",
        questions: [
          "Product options include ASIN A. Which item should be purchased?",
        ],
        answers: ["ASIN A"],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "Prior memory context without the answer.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks[0]?.actual, "Prior memory context without the answer.");
    assert.equal(result.results.tasks[0]?.scores.contains_answer, 0);
    assert.match(
      String(result.results.tasks[0]?.details?.answerContext ?? ""),
      /Product options include ASIN A/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena honors negative judges before lexical fallbacks for non-item-selection tasks", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "formal_reasoning_math.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 11,
        category: "formal_reasoning_math",
        questions: ["Which theorem name was established?"],
        answers: ["Euler theorem"],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "Euler theorem";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.contains_answer, 1);
    assert.equal(task.scores.f1, 1);
    assert.equal(task.scores.llm_judge, 0);
    assert.equal(task.scores.process_score, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena scores item-selection objects with deterministic match metric", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");
  let responderPrompt = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 11,
        category: "shopping",
        questions: [
          "Options include target_asin B00-TEA, a blue ceramic mug, and target_asin B00-CUP, a red cup. Which item should be selected for the tea setup?",
        ],
        answers: [
          {
            target_asin: "B00-TEA",
            attributes: ["blue ceramic mug"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The tea setup should use the blue ceramic mug with target_asin B00-TEA.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(question) {
            responderPrompt = question;
            return {
              text: "target_asin: B00-TEA; attributes: blue ceramic mug",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.match(responderPrompt, /item-selection task/);
    assert.equal(task.scores.item_selection_match, 1);
    assert.equal(task.scores.process_score, 1);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena accepts exact ASIN matches without requiring secondary attributes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 12,
        category: "shopping",
        questions: [
          "Options include target_asin B00TUDFEW2, a washable travel bottle. Which item should be selected?",
        ],
        answers: [
          {
            target_asin: "B00TUDFEW2",
            attributes: ["washable travel bottle", "navy"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The selected item is target_asin B00TUDFEW2.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "target_asin: B00TUDFEW2",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 1);
    assert.equal(task.scores.process_score, 1);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena rejects conflicting explicit ASINs before attribute fallback", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 17,
        category: "shopping",
        questions: [
          "Options include target_asin B000RIGHT1, a red cotton bag. Which item should be selected?",
        ],
        answers: [
          {
            target_asin: "B000RIGHT1",
            attributes: ["red", "cotton"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The selected item should be the red cotton bag.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "target_asin: B000WRONG1; attributes: red, cotton",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 0);
    assert.equal(task.scores.process_score, 0);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena scores hidden-ASIN selections by unique visible option text", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");
  let responderPrompt = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 13,
        category: "shopping",
        questions: [
          [
            "Available Options:",
            "- A BBTO 50th birthday cake topper decoration with glitter numeral candles in rose gold.",
            "- A Amscan #5 metallic birthday candle in gold for my party.",
            "- A black 50th birthday candle cake topper for a man or woman party decoration.",
            "- A red birthday candle with numeral for a one year cake.",
            "- A Glitter Star Candle set for cake in gold color.",
            "Which item should be selected?",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "B06XG24BBK",
            attributes: ["metallic", "birthday", "candle", "gold", "party supply"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The best visible option is the metallic birthday candle in gold.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(question) {
            responderPrompt = question;
            return {
              text: "item: A Amscan #5 metallic birthday candle in gold for my party; attributes: metallic, birthday, candle, gold",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.match(responderPrompt, /omit target_asin instead of answering unknown/);
    assert.match(responderPrompt, /item: <visible option text>/);
    assert.equal(task.scores.item_selection_match, 1);
    assert.equal(task.scores.process_score, 1);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena rejects wrong visible option selections that share generic attributes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 14,
        category: "shopping",
        questions: [
          [
            "Available Options:",
            "- A BBTO 50th birthday cake topper decoration with glitter numeral candles in rose gold.",
            "- A Amscan #5 metallic birthday candle in gold for my party.",
            "- A black 50th birthday candle cake topper for a man or woman party decoration.",
            "- A red birthday candle with numeral for a one year cake.",
            "- A Glitter Star Candle set for cake in gold color.",
            "Which item should be selected?",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "B06XG24BBK",
            attributes: ["metallic", "birthday", "candle", "gold", "party supply"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The answer is a gold candle option.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "item: A Glitter Star Candle set for cake in gold color; attributes: glitter star candle, gold color",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 0);
    assert.equal(task.scores.process_score, 0);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
