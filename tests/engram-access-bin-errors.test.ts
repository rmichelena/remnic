import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

const rootBinPath = new URL("../bin/engram-access.js", import.meta.url);
const shimBinPath = new URL("../packages/shim-openclaw-engram/bin/engram-access.js", import.meta.url);

for (const [label, sourceBinPath] of [
  ["root", rootBinPath],
  ["shim", shimBinPath],
] as const) {
  test(`${label} engram-access reports runCli failures separately from load failures`, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "engram-access-bin-"));
    try {
      const tempBinDir = join(tempRoot, "bin");
      const tempDistDir = join(tempRoot, "dist");
      const tempBinPath = join(tempBinDir, "engram-access.js");
      await mkdir(tempBinDir, { recursive: true });
      await mkdir(tempDistDir, { recursive: true });
      await copyFile(sourceBinPath, tempBinPath);
      await writeFile(join(tempRoot, "package.json"), '{"type":"module"}\n');
      await writeFile(
        join(tempDistDir, "access-cli.js"),
        [
          "export async function runCli() {",
          '  throw new Error("runtime failure after import");',
          "}",
          "",
        ].join("\n"),
      );

      const result = spawnSync(process.execPath, [tempBinPath], {
        encoding: "utf8",
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /engram-access failed: runtime failure after import/);
      assert.doesNotMatch(result.stderr, /failed to load dist\/access-cli\.js/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
}
