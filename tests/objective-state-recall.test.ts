import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { recordObjectiveStateSnapshot } from "../src/objective-state.js";

async function buildObjectiveStateRecallHarness(options: {
  objectiveStateRecallEnabled: boolean;
  recallSectionEnabled?: boolean;
}) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-recall-"));
  await recordObjectiveStateSnapshot({
    memoryDir,
    snapshot: {
      schemaVersion: 1,
      snapshotId: "snap-npm-failure",
      recordedAt: "2026-03-07T10:00:00.000Z",
      sessionKey: "agent:main",
      source: "tool_result",
      kind: "process",
      changeKind: "failed",
      scope: "npm test",
      summary: "Verification run failed with 3 test failures in npm test.",
      toolName: "exec_command",
      command: "npm test",
      outcome: "failure",
      tags: ["verification", "tests"],
    },
  });

  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    objectiveStateMemoryEnabled: true,
    objectiveStateSnapshotWritesEnabled: true,
    objectiveStateRecallEnabled: options.objectiveStateRecallEnabled,
    recallPipeline: [
      {
        id: "objective-state",
        enabled: options.recallSectionEnabled ?? true,
        maxResults: 2,
        maxChars: 1200,
      },
    ],
  });

  return new Orchestrator(cfg);
}

test("recall injects objective-state section when retrieval is enabled", async () => {
  const orchestrator = await buildObjectiveStateRecallHarness({
    objectiveStateRecallEnabled: true,
  });

  const context = await (orchestrator as any).recallInternal(
    "Why did npm test fail during verification?",
    "agent:main",
  );

  assert.match(context, /## Objective State/);
  assert.match(context, /Verification run failed with 3 test failures in npm test/i);
  assert.equal(context.includes("## Relevant Memories"), false);
});

test("recall omits objective-state section when retrieval flag is disabled", async () => {
  const orchestrator = await buildObjectiveStateRecallHarness({
    objectiveStateRecallEnabled: false,
  });

  const context = await (orchestrator as any).recallInternal(
    "Why did npm test fail during verification?",
    "agent:main",
  );

  assert.equal(context.includes("## Objective State"), false);
});

test("recall omits objective-state section when pipeline section is disabled", async () => {
  const orchestrator = await buildObjectiveStateRecallHarness({
    objectiveStateRecallEnabled: true,
    recallSectionEnabled: false,
  });

  const context = await (orchestrator as any).recallInternal(
    "Why did npm test fail during verification?",
    "agent:main",
  );

  assert.equal(context.includes("## Objective State"), false);
});

test("recall searches objective-state snapshots from the requested namespace store", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-recall-ns-"));
  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    namespacesEnabled: true,
    defaultNamespace: "global",
    sharedNamespace: "shared",
    namespacePolicies: [
      {
        name: "team-a",
        readPrincipals: ["alice"],
        writePrincipals: ["alice"],
        includeInRecallByDefault: false,
      },
    ],
    defaultRecallNamespaces: ["self"],
    objectiveStateMemoryEnabled: true,
    objectiveStateSnapshotWritesEnabled: true,
    objectiveStateRecallEnabled: true,
    recallPipeline: [
      {
        id: "objective-state",
        enabled: true,
        maxResults: 2,
        maxChars: 1200,
      },
    ],
  });
  const orchestrator = new Orchestrator(cfg);

  try {
    await recordObjectiveStateSnapshot({
      memoryDir,
      snapshot: {
        schemaVersion: 1,
        snapshotId: "snap-global-validation",
        recordedAt: "2026-03-07T10:00:00.000Z",
        sessionKey: "agent:main",
        source: "tool_result",
        kind: "process",
        changeKind: "failed",
        scope: "npm run validation",
        summary: "Global validation failed with a default-namespace error.",
        toolName: "exec_command",
        command: "npm run validation",
        outcome: "failure",
        tags: ["validation"],
      },
    });
    const teamStorage = await orchestrator.getStorage("team-a");
    await recordObjectiveStateSnapshot({
      memoryDir: teamStorage.dir,
      snapshot: {
        schemaVersion: 1,
        snapshotId: "snap-team-validation",
        recordedAt: "2026-03-07T10:01:00.000Z",
        sessionKey: "team-a:agent:main",
        source: "tool_result",
        kind: "process",
        changeKind: "failed",
        scope: "npm run team-validation",
        summary: "Team validation failed with a namespace-scoped error.",
        toolName: "exec_command",
        command: "npm run team-validation",
        outcome: "failure",
        tags: ["validation"],
      },
    });

    const context = await (orchestrator as any).recallInternal(
      "Why did validation fail?",
      "agent:main",
      { namespace: "team-a", principalOverride: "alice" },
    );

    assert.match(context, /## Objective State/);
    assert.match(context, /namespace-scoped error/i);
    assert.equal(context.includes("default-namespace error"), false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
