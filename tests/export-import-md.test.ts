import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("markdown import rejects target subdirectory symlinks outside the memory root", async () => {
  const fromDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-outside-"));

  try {
    await mkdir(path.join(fromDir, "facts"), { recursive: true });
    await writeFile(path.join(fromDir, "facts", "a.md"), "incoming fact\n", "utf-8");
    await symlink(outsideDir, path.join(targetDir, "facts"), "dir");

    await assert.rejects(
      importMarkdownBundle({
        targetMemoryDir: targetDir,
        fromDir,
        conflict: "overwrite",
      }),
      /escapes target root via symlink|targets a symlink/,
    );

    await assert.rejects(
      readFile(path.join(outsideDir, "a.md"), "utf-8"),
      /ENOENT/,
    );
  } finally {
    await rm(fromDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("markdown import rejects symlinked target memory roots", async () => {
  const fromDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const parentDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-parent-"));
  const targetLink = path.join(parentDir, "target-link");

  try {
    await writeFile(path.join(fromDir, "profile.md"), "incoming profile\n", "utf-8");
    await symlink(targetDir, targetLink, "dir");

    await assert.rejects(
      importMarkdownBundle({
        targetMemoryDir: targetLink,
        fromDir,
        conflict: "overwrite",
      }),
      /targetMemoryDir' must not be a symlink/,
    );

    await assert.rejects(
      readFile(path.join(targetDir, "profile.md"), "utf-8"),
      /ENOENT/,
    );
  } finally {
    await rm(fromDir, { recursive: true, force: true });
    await rm(parentDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});
