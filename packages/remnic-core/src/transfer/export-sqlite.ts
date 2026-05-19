import path from "node:path";
import { readFile } from "node:fs/promises";
import { SQLITE_SCHEMA_VERSION, SQLITE_TABLES_SQL } from "./sqlite-schema.js";
import { listFilesRecursive, sha256File, toPosixRelPath } from "./fs-utils.js";
import { openBetterSqlite3 } from "../runtime/better-sqlite.js";
import { computeTransferOutputRel, isTransferPathExcluded } from "./exclusions.js";

export interface ExportSqliteOptions {
  memoryDir: string;
  outFile: string;
  includeTranscripts?: boolean;
  pluginVersion: string;
}

export async function exportSqlite(opts: ExportSqliteOptions): Promise<void> {
  const includeTranscripts = opts.includeTranscripts === true;
  const memDirAbs = path.resolve(opts.memoryDir);
  const outAbs = path.resolve(opts.outFile);
  const outputRelPosix = computeTransferOutputRel(memDirAbs, outAbs);

  const filesAbs = await listFilesRecursive(memDirAbs);
  const db = openBetterSqlite3(outAbs);
  try {
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec(SQLITE_TABLES_SQL);

    const insertMeta = db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)");
    insertMeta.run("schemaVersion", String(SQLITE_SCHEMA_VERSION));
    insertMeta.run("createdAt", new Date().toISOString());
    insertMeta.run("pluginVersion", opts.pluginVersion);
    insertMeta.run("includesTranscripts", includeTranscripts ? "true" : "false");

    const insertFile = db.prepare(
      "INSERT OR REPLACE INTO files(path_rel, bytes, sha256, content) VALUES (?,?,?,?)",
    );

    const tx = db.transaction((rows: Array<{ rel: string; bytes: number; sha256: string; content: string }>) => {
      for (const r of rows) insertFile.run(r.rel, r.bytes, r.sha256, r.content);
    });

    const rows: Array<{ rel: string; bytes: number; sha256: string; content: string }> = [];
    for (const abs of filesAbs) {
      const relPosix = toPosixRelPath(abs, memDirAbs);
      if (isTransferPathExcluded(relPosix, { includeTranscripts, outputRelPosix })) continue;
      const content = await readFile(abs, "utf-8");
      const { sha256, bytes } = await sha256File(abs);
      rows.push({ rel: relPosix, bytes, sha256, content });
    }

    tx(rows);
  } finally {
    db.close();
  }
}
