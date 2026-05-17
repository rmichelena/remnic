import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importMarkdownBundle } from "../src/transfer/import-md.js";

test("markdown import rejects invalid conflict policy without overwriting existing files", async () => {
  const fromDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const targetPath = path.join(targetDir, "profile.md");

  await writeFile(path.join(fromDir, "profile.md"), "incoming profile\n", "utf-8");
  await writeFile(targetPath, "original profile\n", "utf-8");

  await assert.rejects(
    importMarkdownBundle({
      targetMemoryDir: targetDir,
      fromDir,
      conflict: "replace" as any,
    }),
    /invalid conflict policy/i,
  );
  assert.equal(await readFile(targetPath, "utf-8"), "original profile\n");
});
