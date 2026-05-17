import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { QmdClient } from "./qmd.js";

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${message}${lastError ? `: ${String(lastError)}` : ""}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("QmdClient.dispose force-kills daemon children that ignore SIGTERM", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-cleanup-"));
  const qmdPath = path.join(tempDir, "fake-qmd.mjs");
  const pidFile = path.join(tempDir, "qmd.pid");
  const signalLog = path.join(tempDir, "signals.log");
  let daemonPid: number | undefined;

  t.after(async () => {
    if (daemonPid !== undefined && processIsAlive(daemonPid)) {
      process.kill(daemonPid, "SIGKILL");
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeFile(
    qmdPath,
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

if (process.argv[2] === "--version") {
  console.log("qmd 2.0.0");
  process.exit(0);
}

if (process.argv[2] !== "mcp") {
  process.exit(2);
}

writeFileSync(process.env.REMNIC_FAKE_QMD_PID_FILE, String(process.pid));
process.on("SIGTERM", () => {
  appendFileSync(process.env.REMNIC_FAKE_QMD_SIGNAL_LOG, "SIGTERM\\n");
});

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "fake-qmd", version: "2.0.0" }
        }
      }) + "\\n");
    }
  }
});

setInterval(() => {}, 1_000);
`,
    { mode: 0o700 },
  );
  await chmod(qmdPath, 0o700);

  process.env.REMNIC_FAKE_QMD_PID_FILE = pidFile;
  process.env.REMNIC_FAKE_QMD_SIGNAL_LOG = signalLog;
  t.after(() => {
    delete process.env.REMNIC_FAKE_QMD_PID_FILE;
    delete process.env.REMNIC_FAKE_QMD_SIGNAL_LOG;
  });

  const client = new QmdClient("test", 1, {
    qmdPath,
    daemonUrl: "stdio",
    daemonRecheckIntervalMs: 0,
  });

  assert.equal(await client.probe(), true);
  assert.match(client.debugStatus(), /daemon=true/);
  daemonPid = Number(await readFile(pidFile, "utf8"));
  assert.equal(processIsAlive(daemonPid), true);

  client.dispose();

  await waitFor(
    async () => (await readFile(signalLog, "utf8")).includes("SIGTERM"),
    "fake qmd daemon did not receive SIGTERM",
  );
  await waitFor(
    () => daemonPid !== undefined && !processIsAlive(daemonPid),
    "fake qmd daemon survived disposal escalation",
  );
});
