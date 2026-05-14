import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import test from "node:test";

import { __benchDatasetTestHooks } from "./index.js";

test("resolveDownloadedBenchDatasetDir rejects explicit dataset paths without benchmark markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-datasets-"));
  const invalidDataset = path.join(root, "not-downloaded");

  assert.equal(
    __benchDatasetTestHooks.resolveBenchDatasetDir(
      "memory-arena",
      false,
      invalidDataset,
    ),
    invalidDataset,
  );
  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memory-arena",
      false,
      invalidDataset,
    ),
    undefined,
  );
});

test("resolveDownloadedBenchDatasetDir accepts explicit dataset paths with benchmark markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-datasets-"));
  const datasetDir = path.join(root, "memory-arena");
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "shopping.jsonl"), "{}\n");

  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memory-arena",
      false,
      datasetDir,
    ),
    datasetDir,
  );
});

test("resolveDownloadedBenchDatasetDir ignores MemoryArena WebShop sidecars as dataset markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-datasets-"));
  const datasetDir = path.join(root, "memory-arena");
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "webshop-products.jsonl"), "{}\n");

  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memory-arena",
      false,
      datasetDir,
    ),
    undefined,
  );
});
