import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { EngramAccessService } from "../src/access-service.js";
import { getObjectiveStateStoreStatus } from "../src/objective-state.js";

function createObjectiveStateObserveService(
  memoryDir: string,
  options: {
    namespacesEnabled?: boolean;
    namespacePolicies?: Array<{
      name: string;
      readPrincipals: string[];
      writePrincipals: string[];
      includeInRecallByDefault?: boolean;
    }>;
    storageDirs?: Record<string, string>;
  } = {},
): EngramAccessService {
  return new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: options.namespacesEnabled === true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: options.namespacePolicies ?? [],
      defaultRecallNamespaces: ["self"],
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
      objectiveStateMemoryEnabled: true,
      objectiveStateSnapshotWritesEnabled: true,
    },
    lcmEngine: null,
    getStorage: async (namespace?: string) => ({
      dir: options.storageDirs?.[namespace ?? "global"] ?? memoryDir,
    }),
  } as never);
}

test("observe persists objective-state snapshots from structured message parts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-access-objective-state-"));
  const service = createObjectiveStateObserveService(memoryDir);

  try {
    const response = await service.observe({
      sessionKey: "agent:main",
      skipExtraction: true,
      messages: [
        {
          role: "assistant",
          content: "Ran the validation command.",
          parts: [
            {
              ordinal: 0,
              kind: "tool_call",
              toolName: "exec_command",
              payload: {
                id: "call-validate",
                name: "exec_command",
                arguments: { cmd: "npm run validate" },
              },
            },
            {
              ordinal: 1,
              kind: "tool_result",
              payload: {
                id: "call-validate",
                output: { exitCode: 0, stdout: "all checks passed" },
              },
            },
          ],
        },
      ],
    });

    assert.equal(response.accepted, 1);
    assert.equal(response.extractionQueued, false);

    const status = await getObjectiveStateStoreStatus({
      memoryDir,
      enabled: true,
      writesEnabled: true,
    });
    assert.equal(status.snapshots.total, 1);
    assert.equal(status.latestSnapshot?.kind, "process");
    assert.equal(status.latestSnapshot?.changeKind, "executed");
    assert.equal(status.latestSnapshot?.scope, "npm run validate");
    assert.equal(status.latestSnapshot?.outcome, "success");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("observe writes objective-state snapshots into the resolved namespace store", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-access-objective-state-global-"));
  const teamDir = await mkdtemp(path.join(os.tmpdir(), "remnic-access-objective-state-team-"));
  const service = createObjectiveStateObserveService(memoryDir, {
    namespacesEnabled: true,
    storageDirs: { "team-a": teamDir },
    namespacePolicies: [
      {
        name: "team-a",
        readPrincipals: ["alice"],
        writePrincipals: ["alice"],
      },
    ],
  });

  try {
    const response = await service.observe({
      sessionKey: "agent:main",
      namespace: "team-a",
      authenticatedPrincipal: "alice",
      skipExtraction: true,
      messages: [
        {
          role: "assistant",
          content: "Ran the validation command.",
          parts: [
            {
              ordinal: 0,
              kind: "tool_call",
              toolName: "exec_command",
              payload: {
                id: "call-team-validate",
                name: "exec_command",
                arguments: { cmd: "npm run team-validate" },
              },
            },
            {
              ordinal: 1,
              kind: "tool_result",
              payload: {
                id: "call-team-validate",
                output: { exitCode: 0, stdout: "all checks passed" },
              },
            },
          ],
        },
      ],
    });

    assert.equal(response.accepted, 1);

    const globalStatus = await getObjectiveStateStoreStatus({
      memoryDir,
      enabled: true,
      writesEnabled: true,
    });
    const teamStatus = await getObjectiveStateStoreStatus({
      memoryDir: teamDir,
      enabled: true,
      writesEnabled: true,
    });

    assert.equal(globalStatus.snapshots.total, 0);
    assert.equal(teamStatus.snapshots.total, 1);
    assert.equal(teamStatus.latestSnapshot?.sessionKey, "team-a:agent:main");
    assert.equal(teamStatus.latestSnapshot?.scope, "npm run team-validate");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(teamDir, { recursive: true, force: true });
  }
});
