// Lazy loader for the optional @remnic/bench package.
//
// Remnic's CLI is installed à la carte: users who only need memory features
// should not have to install benchmark tooling, so @remnic/bench is an
// optional peer dependency, not a bundled dependency. Any command that
// actually needs benchmark code calls loadBenchModule() lazily; the loader
// either returns the module or throws a user-facing install hint.
//
// The specifier is computed so the bundler leaves the dynamic import as a
// runtime call (see also core/cli.ts:ensureBuiltInBulkImportAdapters for the
// same pattern). Mirrors CLAUDE.md invariant: "CLI and plugins MUST load
// optional workspace packages via computed-specifier dynamic imports."

import { isSpecifierNotFoundError } from "./optional-module-loader.js";
import { assertLocalBenchBuildFreshForDevelopment } from "./bench-build-freshness.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type BenchModule = typeof import("@remnic/bench");

const SPECIFIER = "@remnic/" + "bench";

let cached: BenchModule | null | undefined;

function resolveLocalWorkspaceBenchPaths(): {
  distEntry: string;
  sourceEntry: string;
} {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const benchPackageDir = path.resolve(currentDir, "../../bench");
  return {
    distEntry: path.join(benchPackageDir, "dist", "index.js"),
    sourceEntry: path.join(benchPackageDir, "src", "index.ts"),
  };
}

async function tryImportLocalWorkspaceBenchSource(
  err: unknown,
): Promise<BenchModule | null> {
  if (!isMissingLocalWorkspaceBenchDistError(err)) {
    return null;
  }
  const { sourceEntry } = resolveLocalWorkspaceBenchPaths();
  if (!existsSync(sourceEntry)) {
    return null;
  }
  return (await import(pathToFileURL(sourceEntry).href)) as BenchModule;
}

function isMissingLocalWorkspaceBenchDistError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
    return false;
  }

  const { distEntry, sourceEntry } = resolveLocalWorkspaceBenchPaths();
  if (existsSync(distEntry) || !existsSync(sourceEntry)) {
    return false;
  }

  const message = (err as { message?: unknown }).message;
  const url = (err as { url?: unknown }).url;
  const expectedDistHref = pathToFileURL(distEntry).href;
  return [message, url].some(
    (value) =>
      typeof value === "string" &&
      (value.includes(distEntry) ||
        value.includes(expectedDistHref) ||
        value.replaceAll("\\", "/").includes(
          "/@remnic/bench/dist/index.js",
        )),
  );
}

async function tryImportBench(): Promise<BenchModule | null> {
  try {
    return (await import(SPECIFIER)) as BenchModule;
  } catch (err) {
    const localSource = await tryImportLocalWorkspaceBenchSource(err);
    if (localSource) {
      return localSource;
    }
    // Only swallow "this package isn't installed" errors. Syntax
    // errors, init throws, or ERR_MODULE_NOT_FOUND from a transitive
    // miss inside @remnic/bench must all surface so broken releases
    // are diagnosable instead of producing a misleading install hint.
    if (isSpecifierNotFoundError(err, SPECIFIER)) {
      return null;
    }
    throw err;
  }
}

/**
 * Load @remnic/bench if installed. Throws a user-facing install hint if the
 * package is not available. Cache the result so repeated calls in the same
 * CLI invocation do not re-import.
 */
export async function loadBenchModule(): Promise<BenchModule> {
  if (cached === undefined) {
    cached = await tryImportBench();
  }
  if (!cached) {
    throw new Error(
      "The `remnic bench` commands require the optional @remnic/bench package.\n" +
        "\n" +
        "Install it alongside the CLI:\n" +
        "  npm install -g @remnic/bench\n" +
        "\n" +
        "Or add it to a project:\n" +
      "  pnpm add @remnic/bench\n",
    );
  }
  assertBenchModuleFreshForDevelopment();
  return cached;
}

/**
 * Return @remnic/bench if present, or undefined if not installed. Use this
 * for code paths that can degrade gracefully (e.g. `remnic bench list`
 * falling back to the static catalogue when the package is absent).
 */
export async function tryLoadBenchModule(): Promise<BenchModule | undefined> {
  if (cached === undefined) {
    cached = await tryImportBench();
  }
  return cached ?? undefined;
}

export function assertBenchModuleFreshForDevelopment(): void {
  assertLocalBenchBuildFreshForDevelopment(import.meta.url);
}
