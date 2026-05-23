import assert from "node:assert/strict";
import test from "node:test";

import {
  OFFLINE_SYNC_APPLY_MAX_BODY_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
} from "@remnic/core";
import {
  OFFLINE_SYNC_APPLY_MAX_REQUEST_BYTES,
  OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_UPLOAD_CHUNK_BYTES,
  chunkOfflineChangesetApplyBatches,
  chunkOfflineFileContentBatches,
  formatOfflineLargeFilePushFailureMessage,
} from "../packages/remnic-cli/src/index.js";
import type { OfflineSyncChangeset, OfflineSyncFileState } from "@remnic/core";

function file(path: string, bytes: number): OfflineSyncFileState {
  return {
    path,
    bytes,
    sha256: "0".repeat(64),
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
