import assert from "node:assert/strict";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import type { StorageManager } from "./storage.js";
import type { PluginConfig } from "./types.js";

function makeConfig(): PluginConfig {
  return {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "team", readPrincipals: ["reader", "writer"], writePrincipals: ["writer"] },
    ],
    memoryDir: "/synthetic/mem",
    defaultRecallNamespaces: ["self", "shared"],
    principalFromSessionKeyMode: "disabled",
    principalFromSessionKeyRules: [],
    briefing: { enabled: false, defaultWindow: "yesterday" },
    daySum: { enabled: false },
    searchBackend: "orama",
    qmd: { enabled: false },
    nativeKnowledge: { enabled: false },
    recall: { budget: {} },
    consolidation: { enabled: false },
    extraction: { enabled: false },
    lcm: { enabled: false },
  } as unknown as PluginConfig;
}

function makeService(): {
  service: EngramAccessService;
  storage: StorageManager;
  getStorageCalls: string[];
} {
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const storage = {
    marker: "team-storage",
    async browseProjectedMemories() {
      return { total: 0, memories: [] };
    },
  } as unknown as StorageManager;
  const getStorageCalls: string[] = [];

  (service as unknown as {
    orchestrator: {
      config: PluginConfig;
      getStorage(namespace: string): Promise<StorageManager>;
    };
  }).orchestrator = {
    config: makeConfig(),
    async getStorage(namespace: string): Promise<StorageManager> {
      getStorageCalls.push(namespace);
      return storage;
    },
  };

  return { service, storage, getStorageCalls };
}

test("getWritableStorageForNamespace denies read-only principals before storage lookup", async () => {
  const { service, getStorageCalls } = makeService();

  await assert.rejects(
    () => service.getWritableStorageForNamespace("team", "reader"),
    /namespace is not writable: team/,
  );
  assert.deepEqual(getStorageCalls, []);
});

test("getWritableStorageForNamespace denies missing principals before storage lookup", async () => {
  const { service, getStorageCalls } = makeService();

  await assert.rejects(
    () => service.getWritableStorageForNamespace("team", undefined),
    /authentication required/,
  );
  assert.deepEqual(getStorageCalls, []);
});

test("getWritableStorageForNamespace resolves namespace storage for write principals", async () => {
  const { service, storage, getStorageCalls } = makeService();

  const resolved = await service.getWritableStorageForNamespace("team", "writer");

  assert.equal(resolved.namespace, "team");
  assert.equal(resolved.storage, storage);
  assert.deepEqual(getStorageCalls, ["team"]);
});

test("memoryBrowse denies missing principals before namespace storage lookup", async () => {
  const { service, getStorageCalls } = makeService();

  await assert.rejects(
    () => service.memoryBrowse({ namespace: "team" }),
    /authentication required/,
  );
  assert.deepEqual(getStorageCalls, []);
});

test("memoryBrowse denies principals without read access before namespace storage lookup", async () => {
  const { service, getStorageCalls } = makeService();

  await assert.rejects(
    () => service.memoryBrowse({ namespace: "team", authenticatedPrincipal: "stranger" }),
    /namespace is not readable: team/,
  );
  assert.deepEqual(getStorageCalls, []);
});

test("memoryBrowse resolves namespace storage for read principals", async () => {
  const { service, getStorageCalls } = makeService();

  const result = await service.memoryBrowse({
    namespace: "team",
    authenticatedPrincipal: "reader",
  });

  assert.equal(result.namespace, "team");
  assert.equal(result.count, 0);
  assert.deepEqual(getStorageCalls, ["team"]);
});
