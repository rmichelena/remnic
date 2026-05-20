import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { listReviewItems, performReview, type ReviewItem } from "./index.js";

async function makeMemoryDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function reviewMarkdown(
  id: string,
  reviewReason: ReviewItem["reviewReason"] = "low_confidence",
): string {
  return `---
id: ${id}
category: fact
confidence: 0.4
confidenceTier: low
source: test
created: 2026-05-17T00:00:00.000Z
reviewReason: ${reviewReason}
---
Candidate memory.`;
}

test("listReviewItems applies reason filtering before enforcing the limit", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const suggestionsDir = path.join(memoryDir, "suggestions");
  const reviewDir = path.join(memoryDir, "review");
  await mkdir(suggestionsDir, { recursive: true });
  await mkdir(reviewDir, { recursive: true });
  await writeFile(path.join(suggestionsDir, "first.md"), reviewMarkdown("suggestion-1", "suggestion"), "utf8");
  await writeFile(path.join(suggestionsDir, "second.md"), reviewMarkdown("suggestion-2", "suggestion"), "utf8");
  await writeFile(path.join(reviewDir, "contradiction.md"), reviewMarkdown("matching-review", "contradiction"), "utf8");

  const result = listReviewItems({
    memoryDir,
    reason: "contradiction",
    limit: 1,
  });

  assert.deepEqual(result.items.map((item) => item.id), ["matching-review"]);
  assert.equal(result.total, 1);
});

test("approve promotes to the source basename when no target exists", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const reviewDir = path.join(memoryDir, "review");
  await mkdir(reviewDir, { recursive: true });
  const reviewPath = path.join(reviewDir, "candidate.md");
  await writeFile(reviewPath, reviewMarkdown("review-no-collision"), "utf8");

  const result = performReview(memoryDir, "review-no-collision", "approve");

  const today = new Date().toISOString().split("T")[0];
  const expectedPath = path.join(memoryDir, "facts", today, "candidate.md");
  assert.equal(result.updatedPath, expectedPath);
  assert.match(await readFile(expectedPath, "utf8"), /confidence: 0\.9/);
  await assert.rejects(stat(reviewPath), /ENOENT/);
});

test("approve does not overwrite an existing promoted memory with the same basename", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const reviewDir = path.join(memoryDir, "review");
  await mkdir(reviewDir, { recursive: true });
  const reviewPath = path.join(reviewDir, "candidate.md");
  await writeFile(reviewPath, reviewMarkdown("review/collision"), "utf8");

  const today = new Date().toISOString().split("T")[0];
  const targetDir = path.join(memoryDir, "facts", today);
  await mkdir(targetDir, { recursive: true });
  const collisionPath = path.join(targetDir, "candidate.md");
  await writeFile(collisionPath, "original promoted memory", "utf8");

  const result = performReview(memoryDir, "review/collision", "approve");

  assert.notEqual(result.updatedPath, collisionPath);
  assert.match(path.basename(result.updatedPath ?? ""), /^candidate-review-collision(?:-\d+)?\.md$/);
  assert.equal(await readFile(collisionPath, "utf8"), "original promoted memory");

  const promotedContent = await readFile(result.updatedPath!, "utf8");
  assert.match(promotedContent, /confidence: 0\.9/);
  assert.match(promotedContent, /confidenceTier: high/);
  await assert.rejects(stat(reviewPath), /ENOENT/);
});
