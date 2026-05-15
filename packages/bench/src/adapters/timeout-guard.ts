import type {
  BenchJudge,
  BenchMemoryAdapter,
  BenchRecallOptions,
  BenchResponder,
  MemoryStats,
  Message,
  SearchResult,
} from "./types.js";
import type { IngestionBenchAdapter, IngestionLog, MemoryGraph } from "../ingestion-types.js";
import type { ProviderConfig } from "../types.js";

const BENCHMARK_TIMEOUT_ABORT_GRACE_MS = 1_500;

export interface TimeoutGuardOptions {
  benchmarkId: string;
  timeoutMs?: number;
  drainTimeoutMs?: number;
  logProgress?: boolean;
  log?: (message: string) => void;
  onTimeout?: (phase: string) => void | Promise<void>;
}

export interface TimeoutGuardConfig {
  remnicConfig?: Record<string, unknown>;
  systemProvider?: ProviderConfig | null;
  judgeProvider?: ProviderConfig | null;
}

export function resolveBenchmarkPhaseTimeoutMs(
  config: TimeoutGuardConfig,
): number | undefined {
  const explicitTimeout = readPositiveIntegerConfig(
    config.remnicConfig,
    "benchmarkPhaseTimeoutMs",
  );
  if (explicitTimeout !== undefined) {
    return explicitTimeout;
  }

  const providerTimeout =
    config.systemProvider?.retryOptions?.timeoutMs ??
    config.judgeProvider?.retryOptions?.timeoutMs;
  if (providerTimeout !== undefined) {
    if (!Number.isInteger(providerTimeout) || providerTimeout <= 0) {
      throw new Error(
        `benchmark provider timeoutMs must be a positive integer; received ${String(providerTimeout)}.`,
      );
    }
    return providerTimeout;
  }

  return undefined;
}

export function resolveBenchmarkProgressLogging(
  remnicConfig?: Record<string, unknown>,
): boolean {
  return coerceBooleanConfig(
    remnicConfig?.benchmarkHarnessProgress,
    "benchmarkHarnessProgress",
  ) === true;
}

export function createTimeoutGuardedAdapter(
  adapter: BenchMemoryAdapter,
  options: TimeoutGuardOptions,
): BenchMemoryAdapter {
  if (options.timeoutMs !== undefined) {
    assertPositiveTimeout(options.timeoutMs, "benchmark phase timeout");
  }
  if (options.drainTimeoutMs !== undefined) {
    assertPositiveTimeout(options.drainTimeoutMs, "benchmark drain timeout");
  }
  const phaseTimeoutMs = options.timeoutMs;
  const drainTimeoutMs = options.drainTimeoutMs ?? phaseTimeoutMs;

  const run = async <T>(
    phase: string,
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs = phaseTimeoutMs,
  ): Promise<T> => {
    if (timeoutMs === undefined) {
      return fn(new AbortController().signal);
    }
    const label = `${options.benchmarkId}:${phase}`;
    return runWithBenchmarkPhaseTimeout(label, timeoutMs, fn, options);
  };

  const wrapped: BenchMemoryAdapter = {
    store(sessionId: string, messages: Message[]): Promise<void> {
      if (phaseTimeoutMs === undefined) {
        return adapter.store(sessionId, messages);
      }
      return run(`store session=${sessionId} messages=${messages.length}`, () =>
        adapter.store(sessionId, messages),
      );
    },
    recall(
      sessionId: string,
      query: string,
      budgetChars?: number,
      recallOptions?: BenchRecallOptions,
    ): Promise<string> {
      if (phaseTimeoutMs === undefined) {
        return adapter.recall(sessionId, query, budgetChars, recallOptions);
      }
      return run(`recall session=${sessionId}`, () =>
        adapter.recall(sessionId, query, budgetChars, recallOptions),
      );
    },
    search(
      query: string,
      limit: number,
      sessionId?: string,
    ): Promise<SearchResult[]> {
      if (phaseTimeoutMs === undefined) {
        return adapter.search(query, limit, sessionId);
      }
      return run(`search session=${sessionId ?? "all"} limit=${limit}`, () =>
        adapter.search(query, limit, sessionId),
      );
    },
    reset(sessionId?: string): Promise<void> {
      if (phaseTimeoutMs === undefined) {
        return adapter.reset(sessionId);
      }
      return run(`reset session=${sessionId ?? "all"}`, () =>
        adapter.reset(sessionId),
      );
    },
    getStats(sessionId?: string): Promise<MemoryStats> {
      if (phaseTimeoutMs === undefined) {
        return adapter.getStats(sessionId);
      }
      return run(`stats session=${sessionId ?? "all"}`, () =>
        adapter.getStats(sessionId),
      );
    },
    destroy(): Promise<void> {
      return adapter.destroy();
    },
  };

  if (adapter.drain) {
    wrapped.drain = (): Promise<void> =>
      drainTimeoutMs === undefined
        ? adapter.drain!()
        : run("drain", () => adapter.drain!(), drainTimeoutMs);
  }
  if (adapter.responder) {
    wrapped.responder =
      phaseTimeoutMs === undefined
        ? adapter.responder
        : wrapResponder(adapter.responder, run);
  }
  if (adapter.judge) {
    wrapped.judge =
      phaseTimeoutMs === undefined ? adapter.judge : wrapJudge(adapter.judge, run);
  }

  return wrapped;
}

export function createTimeoutGuardedIngestionAdapter(
  adapter: IngestionBenchAdapter,
  options: TimeoutGuardOptions & { timeoutMs: number },
): IngestionBenchAdapter {
  assertPositiveTimeout(options.timeoutMs, "benchmark phase timeout");

  const run = async <T>(
    phase: string,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> =>
    runWithBenchmarkPhaseTimeout(`${options.benchmarkId}:${phase}`, options.timeoutMs, fn, options);

  return {
    ingest(inputDir: string): Promise<IngestionLog> {
      return run(`ingestion.ingest inputDir=${inputDir}`, () => adapter.ingest(inputDir));
    },
    getMemoryGraph(): Promise<MemoryGraph> {
      return run("ingestion.getMemoryGraph", () => adapter.getMemoryGraph());
    },
    reset(): Promise<void> {
      return run("ingestion.reset", () => adapter.reset());
    },
    destroy(): Promise<void> {
      return adapter.destroy();
    },
  };
}

function assertPositiveTimeout(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${label} must be a positive integer; received ${String(value)}.`,
    );
  }
}

export async function runWithBenchmarkPhaseTimeout<T>(
  label: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  options: Pick<TimeoutGuardOptions, "logProgress" | "log" | "onTimeout"> = {},
): Promise<T> {
  if (options.logProgress) {
    options.log?.(`[bench] START ${label}`);
  }
  const startedAt = performance.now();
  try {
    const result = await withTimeout(label, timeoutMs, fn, options.onTimeout);
    if (options.logProgress) {
      options.log?.(
        `[bench] DONE ${label} ${Math.round(performance.now() - startedAt)}ms`,
      );
    }
    return result;
  } catch (error) {
    if (options.logProgress) {
      options.log?.(
        `[bench] FAIL ${label} ${Math.round(performance.now() - startedAt)}ms: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    throw error;
  }
}

function wrapResponder(
  responder: BenchResponder,
  run: <T>(phase: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>,
): BenchResponder {
  return {
    respond(question, recalledText) {
      return run("respond", (signal) =>
        responder.respond(question, recalledText, { signal }),
      );
    },
  };
}

function wrapJudge(
  judge: BenchJudge,
  run: <T>(phase: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>,
): BenchJudge {
  const wrapped: BenchJudge = {
    score(question, predicted, expected) {
      return run("judge.score", (signal) =>
        judge.score(question, predicted, expected, { signal }),
      );
    },
  };

  if (judge.scoreWithMetrics) {
    wrapped.scoreWithMetrics = (question, predicted, expected) =>
      run("judge.scoreWithMetrics", (signal) =>
        judge.scoreWithMetrics!(question, predicted, expected, { signal }),
      );
  }

  if (judge.scoreBinaryPrompt) {
    wrapped.scoreBinaryPrompt = (prompt) =>
      run("judge.scoreBinaryPrompt", (signal) =>
        judge.scoreBinaryPrompt!(prompt, { signal }),
      );
  }

  return wrapped;
}

function readPositiveIntegerConfig(
  remnicConfig: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = remnicConfig?.[key];
  if (value === undefined) {
    return undefined;
  }
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(
      `${key} must be a positive integer when provided; received ${String(value)}.`,
    );
  }
  return numericValue;
}

function coerceBooleanConfig(value: unknown, key: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }
  throw new Error(
    `${key} must be a boolean when provided; received ${String(value)}.`,
  );
}

async function withTimeout<T>(
  label: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  onTimeout?: (label: string) => void | Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let timeoutError: Error | undefined;
  const task = Promise.resolve().then(() => fn(controller.signal));
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeoutError = new Error(
        `benchmark phase timed out after ${timeoutMs}ms: ${label}`,
      );
      reject(timeoutError);
      controller.abort(timeoutError);
      if (onTimeout) {
        void Promise.resolve(onTimeout(label)).catch(() => {});
      }
    }, timeoutMs);
  });

  try {
    return await Promise.race([task, timeout]);
  } catch (error) {
    if (error === timeoutError) {
      await Promise.race([
        task.then(
          () => undefined,
          () => undefined,
        ),
        delay(BENCHMARK_TIMEOUT_ABORT_GRACE_MS),
      ]);
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
