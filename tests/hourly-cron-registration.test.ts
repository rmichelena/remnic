import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../src/config.js";
import {
  buildHourlySummaryCronJob,
  loadHourlySummaryCronJobsData,
  parseHourlySummaryCronJobsData,
} from "../src/index.js";

const CRON_OPTS = {
  jobId: "engram-hourly-summary",
  minute: 17,
  nowMs: 1_700_000_000_000,
};

test("hourly cron jobs loader preserves malformed existing jobs files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hourly-cron-"));
  try {
    const jobsPath = path.join(dir, "jobs.json");
    const malformed = "{ not valid jobs json\n";
    await writeFile(jobsPath, malformed, "utf8");

    const result = await loadHourlySummaryCronJobsData(jobsPath);

    assert.equal(result.status, "invalid");
    assert.equal(await readFile(jobsPath, "utf8"), malformed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hourly cron jobs parser rejects invalid jobs shape", () => {
  assert.throws(
    () => parseHourlySummaryCronJobsData(JSON.stringify({ version: 1, jobs: {} })),
    /jobs array/,
  );
  assert.throws(
    () => parseHourlySummaryCronJobsData(JSON.stringify({ version: 1, jobs: [null] })),
    /jobs entries/,
  );
});

test("hourly cron job pins the gateway task model in the isolated agentTurn payload", () => {
  const cfg = parseConfig({
    modelSource: "gateway",
    taskModelChain: {
      primary: "openrouter/deepseek/deepseek-v4-flash",
      fallbacks: ["zai/glm-4.5-air"],
    },
  });

  const job = buildHourlySummaryCronJob(cfg, CRON_OPTS);
  const payload = job.payload as Record<string, unknown>;

  assert.equal(job.sessionTarget, "isolated");
  assert.equal(payload.kind, "agentTurn");
  // Isolated agentTurn jobs honor payload.model, not the root model — without
  // this the configured task model is dropped and the run falls through to the
  // agent default. Issue #1469 / codex review on PR #1470.
  assert.equal(payload.model, "openrouter/deepseek/deepseek-v4-flash");
  // Root model kept for backward compatibility with older host builds.
  assert.equal(job.model, "openrouter/deepseek/deepseek-v4-flash");
});

test("hourly cron job lets an explicit summaryModel win over the task chain", () => {
  const cfg = parseConfig({
    modelSource: "gateway",
    summaryModel: "openrouter/summary-override",
    taskModelChain: { primary: "openrouter/deepseek/deepseek-v4-flash" },
  });

  const job = buildHourlySummaryCronJob(cfg, CRON_OPTS);

  assert.equal(job.model, "openrouter/summary-override");
  assert.equal(
    (job.payload as Record<string, unknown>).model,
    "openrouter/summary-override",
  );
});

test("hourly cron job omits the model when no task model is configured", () => {
  const cfg = parseConfig({ modelSource: "gateway" });

  const job = buildHourlySummaryCronJob(cfg, CRON_OPTS);

  // No bare "gpt-5.5" leaks to the gateway; the Gateway default + provider win.
  assert.equal("model" in job, false);
  assert.equal("model" in (job.payload as Record<string, unknown>), false);
});
