import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { main, runCli } from "./access-cli.js";

async function rejectsUsage(argv: string[]): Promise<void> {
  await assert.rejects(
    async () => {
      await main(argv);
    },
    /invalid access-cli arguments/,
  );
}

async function captureRunCliFailure(argv: string[]): Promise<string> {
  let output = "";
  const originalStdoutWrite = process.stdout.write;
  const originalExit = process.exit;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.exit = ((code?: string | number | null | undefined): never => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;

  try {
    await assert.rejects(
      async () => {
        await runCli(argv);
      },
      /process\.exit:1/,
    );
    return output;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.exit = originalExit;
  }
}

test("access-cli rejects malformed dry-run values before store can run", async () => {
  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--dry-run=true",
  ]);

  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--dry-run",
    "true",
  ]);
});

test("access-cli rejects unknown options before runtime initialization", async () => {
  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--typo",
    "value",
  ]);
});

test("access-cli rejects value options with missing values", async () => {
  await rejectsUsage(["browse", "--limit"]);
  await rejectsUsage(["browse", "--principal"]);
  await rejectsUsage(["store", "--content", "hello", "--category"]);
});

test("access-cli rejects partial numeric values", async () => {
  await rejectsUsage(["browse", "--limit", "10abc"]);
  await rejectsUsage(["browse", "--offset", "1.5"]);
  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--confidence",
    "0.5x",
  ]);
});

test("access-cli rejects invalid browse sort and pagination before runtime initialization", async () => {
  await rejectsUsage(["browse", "--sort", "udpated_desc"]);
  await rejectsUsage(["browse", "--limit", "0"]);
  await rejectsUsage(["browse", "--limit", "-1"]);
  await rejectsUsage(["browse", "--offset", "-1"]);
});

test("access-cli browse sort error lists accepted values", async () => {
  const output = await captureRunCliFailure(["browse", "--sort", "udpated_desc"]);

  assert.match(output, /invalid value for --sort/);
  assert.match(output, /Accepted: updated_desc, updated_asc, created_desc, created_asc\./);
});

test("access-cli browse pagination bound errors list accepted ranges", async () => {
  const limitOutput = await captureRunCliFailure(["browse", "--limit", "0"]);
  const offsetOutput = await captureRunCliFailure(["browse", "--offset", "-1"]);
  const principalOutput = await captureRunCliFailure(["browse", "--principal"]);

  assert.match(limitOutput, /invalid value for --limit/);
  assert.match(limitOutput, /Accepted: integer >= 1\./);
  assert.match(offsetOutput, /invalid value for --offset/);
  assert.match(offsetOutput, /Accepted: integer >= 0\./);
  assert.match(principalOutput, /missing required option: --principal/);
});

test("access-cli rejects confidence outside the documented range", async () => {
  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--confidence",
    "1.1",
  ]);
});

test("access-cli prefers active OpenClaw config path over legacy config path", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "access-cli-config-"));
  const activeConfigPath = join(tempRoot, "active-openclaw.json");
  const legacyConfigPath = join(tempRoot, "legacy-openclaw.json");
  const memoryDir = join(tempRoot, "memory");
  const previousOpenClawConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const previousOpenClawEngramConfigPath = process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  let output = "";
  const originalStdoutWrite = process.stdout.write;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    await writeFile(
      activeConfigPath,
      JSON.stringify({
        plugins: {
          entries: {
            "openclaw-remnic": {
              config: {
                memoryDir,
              },
            },
          },
        },
      }),
    );
    await writeFile(legacyConfigPath, "{not valid json");

    process.env.OPENCLAW_CONFIG_PATH = activeConfigPath;
    process.env.OPENCLAW_ENGRAM_CONFIG_PATH = legacyConfigPath;

    await main([
      "store",
      "--content",
      "hello",
      "--category",
      "fact",
      "--dry-run",
    ]);

    assert.match(output, /"operation": "memory_store"/);
    assert.match(output, /"dryRun": true/);
  } finally {
    process.stdout.write = originalStdoutWrite;
    if (previousOpenClawConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousOpenClawConfigPath;
    }
    if (previousOpenClawEngramConfigPath === undefined) {
      delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_ENGRAM_CONFIG_PATH = previousOpenClawEngramConfigPath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
