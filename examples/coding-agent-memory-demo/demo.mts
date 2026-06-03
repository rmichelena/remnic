import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EngramAccessService, Orchestrator, parseConfig } from "@remnic/core";

const DEFAULT_MEMORY_DIR = "examples/coding-agent-memory-demo/.demo-memory";
const CHECKOUT_NAMESPACE = "project-checkout-service";
const MARKETING_NAMESPACE = "project-marketing-site";
const WRITE_PRINCIPAL = "codex-cli";
const RECALL_PRINCIPAL = "claude-code";
const WRITE_SESSION = "codex-cli:session-a";
const RECALL_SESSION = "claude-code:session-b";
const QUERY = "payment retry policy decision and change notes";

const memoryWrites = [
  {
    label: "checkout retry-policy decision",
    namespace: CHECKOUT_NAMESPACE,
    category: "decision" as const,
    content:
      "Decision: checkout-service payment retry policy lives in src/payments/retry-policy.ts and uses " +
      "idempotency keys with a maximum of 3 attempts.",
    tags: ["agent-memory-demo", "payment", "retry-policy"],
  },
  {
    label: "checkout change-note preference",
    namespace: CHECKOUT_NAMESPACE,
    category: "preference" as const,
    content:
      "Preference: for checkout-service, include the retry-policy file path in change notes before code edits.",
    tags: ["agent-memory-demo", "change-notes", "retry-policy"],
  },
  {
    label: "marketing-site unrelated decision",
    namespace: MARKETING_NAMESPACE,
    category: "decision" as const,
    content: "Decision: marketing-site hero copy must avoid launch metrics until legal approval.",
    tags: ["agent-memory-demo", "hero-copy"],
  },
];

function parseArgs(argv: string[]) {
  let memoryDir = process.env.REMNIC_DEMO_MEMORY_DIR ?? DEFAULT_MEMORY_DIR;
  let usesDefaultMemoryDir = !process.env.REMNIC_DEMO_MEMORY_DIR;
  let reset: boolean | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--memory-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--memory-dir requires a path value");
      }
      memoryDir = value;
      usesDefaultMemoryDir = false;
      index += 1;
    } else if (arg === "--keep") {
      reset = false;
    } else if (arg === "--reset") {
      reset = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return {
    displayMemoryDir: memoryDir,
    memoryDir: path.resolve(process.cwd(), memoryDir),
    reset: reset ?? usesDefaultMemoryDir,
  };
}

function printUsage() {
  console.log(`Usage: pnpm run demo:coding-agent-memory -- [--memory-dir <path>] [--keep] [--reset]

Runs a local, no-key Remnic coding-agent memory demo.

Options:
  --memory-dir <path>  Memory directory to seed and recall from
  --keep               Do not reset the built-in demo memory directory before seeding
  --reset              Explicitly reset the selected memory directory before seeding`);
}

function createConfig(memoryDir: string) {
  return parseConfig({
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    openaiApiKey: false,
    qmdEnabled: false,
    queryAwareIndexingEnabled: false,
    embeddingFallbackEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    knowledgeIndexEnabled: false,
    compoundingInjectEnabled: false,
    memoryBoxesEnabled: false,
    temporalMemoryTreeEnabled: false,
    injectQuestions: false,
    localLlmEnabled: false,
    recallDirectAnswerEnabled: false,
    namespacesEnabled: true,
    defaultNamespace: "global",
    sharedNamespace: "shared",
    defaultRecallNamespaces: ["self"],
    principalFromSessionKeyMode: "none",
    namespacePolicies: [
      {
        name: CHECKOUT_NAMESPACE,
        readPrincipals: [WRITE_PRINCIPAL, RECALL_PRINCIPAL],
        writePrincipals: [WRITE_PRINCIPAL],
      },
      {
        name: MARKETING_NAMESPACE,
        readPrincipals: [WRITE_PRINCIPAL, RECALL_PRINCIPAL],
        writePrincipals: [WRITE_PRINCIPAL],
      },
    ],
    recallOuterTimeoutMs: 10_000,
  });
}

async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

function resultForMemoryId<T extends { memoryId?: string; id?: string }>(
  entries: T[] | undefined,
  memoryId: string,
): T | undefined {
  return entries?.find((entry) => (entry.memoryId ?? entry.id) === memoryId);
}

function formatReason(result: {
  servedBy?: string;
  provenance?: { scope?: string; retrievalReason?: string };
}): string {
  const scope = result.provenance?.scope ?? "unknown-scope";
  const servedBy = result.servedBy ?? "unknown";
  const retrievalReason = result.provenance?.retrievalReason ?? `served-by=${servedBy}`;
  return `scope=${scope}; servedBy=${servedBy}; ${retrievalReason}`;
}

function assertDemoInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`demo invariant failed: ${message}`);
  }
}

async function runDemo() {
  const options = parseArgs(process.argv.slice(2));
  if (options.reset) {
    await removeDirWithRetry(options.memoryDir);
  }

  const orchestrator = new Orchestrator(createConfig(options.memoryDir));
  await orchestrator.initialize();
  const service = new EngramAccessService(orchestrator);

  try {
    const writes = [];
    for (const memory of memoryWrites) {
      const response = await service.memoryStore({
        schemaVersion: 1,
        sessionKey: WRITE_SESSION,
        authenticatedPrincipal: WRITE_PRINCIPAL,
        namespace: memory.namespace,
        content: memory.content,
        category: memory.category,
        confidence: 0.95,
        tags: memory.tags,
        sourceReason: `coding-agent-memory-demo:${memory.label}`,
      });
      writes.push({ memory, response });
    }

    const xray = await service.recallXray({
      query: QUERY,
      sessionKey: RECALL_SESSION,
      authenticatedPrincipal: RECALL_PRINCIPAL,
      namespace: CHECKOUT_NAMESPACE,
      tags: ["agent-memory-demo"],
      tagMatch: "all",
      mode: "full",
      disclosure: "section",
      includeRecall: true,
    });

    const recall = xray.recall;
    if (!xray.snapshotFound || !recall) {
      throw new Error("expected recallXray(includeRecall=true) to produce a recall response");
    }

    const surfacedMarketing = recall.context.includes("marketing-site hero copy");
    const tagFilter = xray.snapshot?.filters.find((filter) => filter.name === "tag-filter");
    const printableResults = recall.memoryIds.map((memoryId) => {
      const summary = resultForMemoryId(recall.results, memoryId);
      const result = resultForMemoryId(xray.snapshot?.results, memoryId);
      assertDemoInvariant(summary, `missing recall summary for ${memoryId}`);
      assertDemoInvariant(result, `missing X-ray result for ${memoryId}`);
      return { memoryId, result, summary };
    });

    assertDemoInvariant(recall.count === 2, `expected 2 checkout memories, got ${recall.count}`);
    assertDemoInvariant(printableResults.length === 2, `expected 2 printable memories, got ${printableResults.length}`);
    assertDemoInvariant(!surfacedMarketing, "marketing namespace memory surfaced in checkout recall");

    console.log("Remnic coding-agent memory demo");
    console.log(`memoryDir: ${options.displayMemoryDir}`);
    console.log("engine: real @remnic/core Orchestrator + EngramAccessService");
    console.log("apiKeys: none (OpenAI disabled, QMD disabled)");
    console.log("");
    console.log("1) codex-cli / session-a stores real Remnic memories via memoryStore()");
    for (const { memory, response } of writes) {
      console.log(
        `stored ${memory.category} "${memory.label}" -> namespace=${response.namespace} status=${response.status}`,
      );
    }
    console.log("");
    console.log("2) switch to claude-code / session-b and recall through recallXray(includeRecall=true)");
    console.log(`active namespace: ${CHECKOUT_NAMESPACE}`);
    console.log(`query: ${QUERY}`);
    console.log(`recalled ${recall.count} real Remnic memories`);
    for (const { result, summary } of printableResults) {
      console.log(`- ${summary.category}`);
      console.log(`  content: ${summary.content ?? summary.preview}`);
      console.log(`  why: ${formatReason(result)}`);
    }
    console.log("");
    console.log("3) scope check");
    console.log(`checkout namespace: ${CHECKOUT_NAMESPACE}`);
    console.log(`unrelated namespace: ${MARKETING_NAMESPACE}`);
    if (tagFilter) {
      console.log(`xray filter: ${tagFilter.name} admitted ${tagFilter.admitted}/${tagFilter.considered}`);
    }
    console.log(`marketing memory surfaced: ${surfacedMarketing ? "yes" : "no"}`);
    console.log(
      `result: PASS - ${RECALL_SESSION} recalled checkout-service context written by ${WRITE_SESSION} using real Remnic storage and recall.`,
    );
  } finally {
    await orchestrator.destroy();
  }
}

runDemo().catch((error) => {
  const script = path.relative(process.cwd(), fileURLToPath(import.meta.url));
  void error;
  console.error(`${script}: demo failed`);
  process.exitCode = 1;
});
