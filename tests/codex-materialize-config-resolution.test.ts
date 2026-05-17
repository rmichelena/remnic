import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadRawConfig as loadDevRawConfig,
} from "../scripts/codex-materialize.ts";
import {
  LEGACY_PLUGIN_ID,
  PLUGIN_ID,
  resolveRemnicPluginEntry,
} from "../packages/remnic-core/src/plugin-id.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const packagedMaterialize = require(
  path.resolve(__dirname, "..", "packages", "plugin-codex", "bin", "materialize.cjs"),
) as {
  loadRawConfig: (
    resolveEntry: typeof resolveRemnicPluginEntry,
    env?: NodeJS.ProcessEnv,
  ) => Record<string, unknown>;
};

type Loader = (env: NodeJS.ProcessEnv) => Record<string, unknown>;

const loaders: Array<[string, Loader]> = [
  ["dev script", (env) => loadDevRawConfig(env)],
  [
    "packaged bin",
    (env) => packagedMaterialize.loadRawConfig(resolveRemnicPluginEntry, env),
  ],
];

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-materialize-config-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

for (const [name, loadRawConfig] of loaders) {
  test(`${name} resolves the active OpenClaw Remnic slot`, () => {
    withTempDir((dir) => {
      const configPath = path.join(dir, "openclaw.json");
      writeJson(configPath, {
        plugins: {
          slots: { memory: PLUGIN_ID },
          entries: {
            [PLUGIN_ID]: {
              config: { memoryDir: "/tmp/canonical", marker: "canonical" },
            },
            [LEGACY_PLUGIN_ID]: {
              config: { memoryDir: "/tmp/legacy", marker: "legacy" },
            },
          },
        },
      });

      const raw = loadRawConfig({
        HOME: dir,
        OPENCLAW_CONFIG_PATH: configPath,
      });
      assert.equal(raw.marker, "canonical");
      assert.equal(raw.memoryDir, "/tmp/canonical");
    });
  });

  test(`${name} keeps OPENCLAW_ENGRAM_CONFIG_PATH ahead of OPENCLAW_CONFIG_PATH`, () => {
    withTempDir((dir) => {
      const primaryPath = path.join(dir, "primary.json");
      const legacyPath = path.join(dir, "legacy.json");
      writeJson(primaryPath, { memoryDir: "/tmp/primary", marker: "primary" });
      writeJson(legacyPath, { memoryDir: "/tmp/legacy", marker: "legacy" });

      const raw = loadRawConfig({
        HOME: dir,
        OPENCLAW_CONFIG_PATH: primaryPath,
        OPENCLAW_ENGRAM_CONFIG_PATH: legacyPath,
      });
      assert.equal(raw.marker, "legacy");
      assert.equal(raw.memoryDir, "/tmp/legacy");
    });
  });

  test(`${name} skips OpenClaw configs without a Remnic entry instead of treating them as flat config`, () => {
    withTempDir((dir) => {
      const openclawPath = path.join(dir, "openclaw.json");
      writeJson(openclawPath, {
        memoryDir: "/tmp/should-not-be-used",
        marker: "top-level-openclaw",
        plugins: {
          slots: { memory: "other-memory-plugin" },
          entries: {
            "other-memory-plugin": {
              config: { memoryDir: "/tmp/foreign", marker: "foreign" },
            },
          },
        },
      });

      const raw = loadRawConfig({
        HOME: dir,
        OPENCLAW_CONFIG_PATH: openclawPath,
      });
      assert.deepEqual(raw, {});
    });
  });

  test(`${name} fails fast when an existing explicit config contains invalid JSON`, () => {
    withTempDir((dir) => {
      const configPath = path.join(dir, "broken.json");
      writeFileSync(configPath, "{not json");

      assert.throws(
        () =>
          loadRawConfig({
            HOME: dir,
            REMNIC_CONFIG: configPath,
          }),
        /codex-materialize config error: invalid JSON in REMNIC_CONFIG/u,
      );
    });
  });
}
