import assert from "node:assert/strict";
import test from "node:test";

import {
  OFFLINE_SYNC_APPLY_MAX_BODY_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
} from "@remnic/core";
import {
  OFFLINE_SYNC_APPLY_MAX_REQUEST_BYTES,
  OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES,
  OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_UPLOAD_CHUNK_BYTES,
  OFFLINE_SYNC_REQUEST_TIMEOUT_DEFAULT_MS,
  advanceOfflineBaseFilesForSuccessfulPush,
  chunkOfflineChangesetApplyBatches,
  chunkOfflineFileContentBatches,
  formatOfflineRequestForError,
  formatOfflineLargeFilePushFailureMessage,
  offlineSnapshotContentFilesForApply,
  parseOfflineSyncRequestTimeoutMs,
  shouldDirectHydrateOfflineFile,
} from "../packages/remnic-cli/src/index.js";
import type { OfflineSyncChangeset, OfflineSyncFileState } from "@remnic/core";

function file(path: string, bytes: number, fill = "0"): OfflineSyncFileState {
  return {
    path,
    bytes,
    sha256: fill.repeat(64),
    mtimeMs: 0,
  };
}

test("offline sync file content batches are bounded by expected bytes", () => {
  const batches = chunkOfflineFileContentBatches([
    file("facts/a.md", 5 * 1024 * 1024),
    file("facts/b.md", 4 * 1024 * 1024),
    file("facts/c.md", 1024),
  ]);

  assert.deepEqual(
    batches.map((batch) => batch.map((entry) => entry.path)),
    [["facts/a.md"], ["facts/b.md", "facts/c.md"]],
  );
});

test("offline sync file content batches keep oversized single files fetchable", () => {
  const batches = chunkOfflineFileContentBatches([
    file("facts/large.md", 12 * 1024 * 1024),
    file("facts/small.md", 1024),
  ]);

  assert.deepEqual(
    batches.map((batch) => batch.map((entry) => entry.path)),
    [["facts/large.md"], ["facts/small.md"]],
  );
});

test("offline sync hydration skips oversized conflict copies", () => {
  const base = [
    file("state/lcm.sqlite", 727 * 1024 * 1024, "a"),
    file("facts/update.md", 100, "b"),
  ];
  const current = [
    file("state/lcm.sqlite", 727 * 1024 * 1024, "c"),
    file("facts/update.md", 100, "b"),
  ];
  const snapshot = {
    format: "remnic.offline-sync.snapshot.v1" as const,
    schemaVersion: 1 as const,
    createdAt: "2026-05-31T00:00:00.000Z",
    sourceId: "remote",
    includeTranscripts: true,
    files: [
      file("facts/new.md", 100, "f"),
      file("facts/update.md", 100, "e"),
      file("state/lcm.sqlite", 727 * 1024 * 1024, "d"),
    ],
  };

  const needed = offlineSnapshotContentFilesForApply({
    snapshot,
    baseFiles: base,
    currentFiles: current,
    conflictContentMaxBytes: 8 * 1024 * 1024,
  });

  assert.deepEqual(
    needed.map((entry) => entry.path),
    ["facts/new.md", "facts/update.md"],
  );
});

test("offline sync hydration skips deferred volatile remote files", () => {
  const base = [
    file("state/memory-lifecycle-ledger.jsonl", 32 * 1024 * 1024, "a"),
    file("facts/update.md", 100, "b"),
  ];
  const current = [
    file("state/memory-lifecycle-ledger.jsonl", 32 * 1024 * 1024, "a"),
    file("facts/update.md", 100, "b"),
  ];
  const snapshot = {
    format: "remnic.offline-sync.snapshot.v1" as const,
    schemaVersion: 1 as const,
    createdAt: "2026-05-31T00:00:00.000Z",
    sourceId: "remote",
    includeTranscripts: true,
    files: [
      file("state/memory-lifecycle-ledger.jsonl", 32 * 1024 * 1024, "c"),
      file("facts/update.md", 100, "e"),
    ],
  };

  const needed = offlineSnapshotContentFilesForApply({
    snapshot,
    baseFiles: base,
    currentFiles: current,
    deferredPaths: ["state/memory-lifecycle-ledger.jsonl"],
  });

  assert.deepEqual(
    needed.map((entry) => entry.path),
    ["facts/update.md"],
  );
});

test("offline sync request diagnostics validate timeout env and include endpoint", () => {
  assert.equal(parseOfflineSyncRequestTimeoutMs(undefined), OFFLINE_SYNC_REQUEST_TIMEOUT_DEFAULT_MS);
  assert.equal(parseOfflineSyncRequestTimeoutMs("1500"), 1500);
  assert.throws(
    () => parseOfflineSyncRequestTimeoutMs("999"),
    /REMNIC_OFFLINE_REQUEST_TIMEOUT_MS must be an integer >= 1000/,
  );
  assert.equal(
    formatOfflineRequestForError("http://localhost:4318/remnic/v1/offline-sync/files?namespace=generalist", {
      method: "post",
    }),
    "POST /remnic/v1/offline-sync/files?namespace=generalist",
  );
});

test("offline sync large-file push failures are explicit", () => {
  assert.equal(
    formatOfflineLargeFilePushFailureMessage([
      { path: "state/lcm.sqlite", error: "offline sync request failed: 500" },
    ]),
    "offline sync large-file push failed for 1 file: state/lcm.sqlite: offline sync request failed: 500",
  );
});

test("offline sync large-file upload chunks stay below the protocol maximum", () => {
  assert.equal(
    OFFLINE_SYNC_FILE_CONTENT_UPLOAD_CHUNK_BYTES,
    OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
  );
  assert.equal(
    OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
    8 * 1024 * 1024,
  );
  assert.ok(
    OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES < OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
  );
});

test("offline sync apply changesets are split below the daemon JSON body budget", () => {
  const changeset: OfflineSyncChangeset = {
    format: "remnic.offline-sync.changeset.v1",
    schemaVersion: 1,
    createdAt: "2026-05-23T00:00:00.000Z",
    sourceId: "test",
    includeTranscripts: true,
    changes: Array.from({ length: 5 }, (_, index) => {
      const content = Buffer.alloc(24 * 1024, index + 1);
      return {
        type: "upsert",
        path: `facts/${index}.md`,
        file: {
          path: `facts/${index}.md`,
          sha256: "0".repeat(64),
          bytes: content.length,
          mtimeMs: index,
          contentBase64: content.toString("base64"),
        },
      };
    }),
  };

  const batches = chunkOfflineChangesetApplyBatches(changeset, "generalist");

  assert.equal(batches.length, 1);
  assert.ok(OFFLINE_SYNC_APPLY_MAX_REQUEST_BYTES < OFFLINE_SYNC_APPLY_MAX_BODY_BYTES);
  const tightBatches = chunkOfflineChangesetApplyBatches(changeset, "generalist", 96 * 1024);
  assert.ok(tightBatches.length > 1);
  assert.equal(
    tightBatches.reduce((total, batch) => total + batch.changes.length, 0),
    changeset.changes.length,
  );
  for (const batch of tightBatches) {
    assert.ok(
      Buffer.byteLength(JSON.stringify({
        namespace: "generalist",
        changeset: batch,
      }), "utf-8") <= 96 * 1024,
    );
  }
});

test("offline sync direct push threshold avoids an inline body-size gap", () => {
  assert.ok(OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES < 16 * 1024 * 1024);
  assert.equal(OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES, OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES);
  const inlineBytes = OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES - 1;
  const content = Buffer.alloc(inlineBytes, 1);
  const changeset: OfflineSyncChangeset = {
    format: "remnic.offline-sync.changeset.v1",
    schemaVersion: 1,
    createdAt: "2026-05-23T00:00:00.000Z",
    sourceId: "test",
    includeTranscripts: true,
    changes: [
      {
        type: "upsert",
        path: "state/mid-size.bin",
        file: {
          path: "state/mid-size.bin",
          sha256: "0".repeat(64),
          bytes: content.length,
          mtimeMs: 1,
          contentBase64: content.toString("base64"),
        },
      },
    ],
  };

  const batches = chunkOfflineChangesetApplyBatches(changeset, "generalist");

  assert.equal(batches.length, 1);
  assert.ok(
    Buffer.byteLength(JSON.stringify({
      namespace: "generalist",
      changeset: batches[0],
    }), "utf-8") <= OFFLINE_SYNC_APPLY_MAX_REQUEST_BYTES,
  );
});

test("offline sync direct hydration covers remote mid-size files", () => {
  const incoming = file("state/remote-mid-size.bin", OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES);

  assert.equal(
    shouldDirectHydrateOfflineFile({ incoming }),
    true,
  );
  assert.equal(
    shouldDirectHydrateOfflineFile({
      incoming,
      current: { ...incoming },
    }),
    false,
  );
  assert.equal(
    shouldDirectHydrateOfflineFile({
      incoming: file("state/inline.bin", OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES - 1),
    }),
    false,
  );
});

test("offline sync can advance pushed-path baselines when pull is deferred", () => {
  const base = [
    file("facts/old.md", 100, "a"),
    file("facts/delete.md", 100, "b"),
    file("state/direct.bin", OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES, "c"),
    file("facts/conflict.md", 100, "d"),
  ];
  const current = [
    file("facts/old.md", 120, "e"),
    file("state/direct.bin", OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES, "f"),
    file("facts/conflict.md", 130, "g"),
  ];
  const next = advanceOfflineBaseFilesForSuccessfulPush({
    baseFiles: base,
    currentFiles: current,
    directPushedPaths: ["state/direct.bin"],
    changeset: {
      format: "remnic.offline-sync.changeset.v1",
      schemaVersion: 1,
      createdAt: "2026-05-31T00:00:00.000Z",
      sourceId: "laptop",
      includeTranscripts: true,
      changes: [
        {
          type: "upsert",
          path: "facts/old.md",
          baseSha256: base[0]!.sha256,
          file: {
            ...current[0]!,
            contentBase64: Buffer.from("updated").toString("base64"),
          },
        },
        {
          type: "delete",
          path: "facts/delete.md",
          baseSha256: base[1]!.sha256,
        },
        {
          type: "upsert",
          path: "facts/conflict.md",
          baseSha256: base[3]!.sha256,
          file: {
            ...current[2]!,
            contentBase64: Buffer.from("conflict").toString("base64"),
          },
        },
      ],
    },
    conflicts: [{ path: "facts/conflict.md" }],
  });

  assert.deepEqual(
    next.map((entry) => [entry.path, entry.sha256]),
    [
      ["facts/conflict.md", "d".repeat(64)],
      ["facts/old.md", "e".repeat(64)],
      ["state/direct.bin", "f".repeat(64)],
    ],
  );
});

test("offline sync partial checkpoints preserve directly hydrated files", () => {
  const base = [
    file("facts/local.md", 100, "a"),
  ];
  const current = [
    file("facts/local.md", 110, "b"),
  ];
  const hydrated = file("state/remote-large.bin", OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES, "c");

  const next = advanceOfflineBaseFilesForSuccessfulPush({
    baseFiles: base,
    currentFiles: current,
    hydratedFiles: [hydrated],
    changeset: {
      format: "remnic.offline-sync.changeset.v1",
      schemaVersion: 1,
      createdAt: "2026-05-31T00:00:00.000Z",
      sourceId: "laptop",
      includeTranscripts: true,
      changes: [
        {
          type: "upsert",
          path: "facts/local.md",
          baseSha256: base[0]!.sha256,
          file: {
            ...current[0]!,
            contentBase64: Buffer.from("updated").toString("base64"),
          },
        },
      ],
    },
  });

  assert.deepEqual(
    next.map((entry) => [entry.path, entry.sha256]),
    [
      ["facts/local.md", "b".repeat(64)],
      ["state/remote-large.bin", "c".repeat(64)],
    ],
  );
});
