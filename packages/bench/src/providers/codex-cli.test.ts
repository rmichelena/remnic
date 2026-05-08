import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __codexCliProviderTestHooks,
  createCodexCliProvider,
} from "./codex-cli.ts";

test("codex-cli provider invokes codex exec in an isolated benchmark mode", async () => {
  const captured: {
    args?: string[];
    input?: string;
    env?: NodeJS.ProcessEnv;
    workspacePath?: string;
    outputPath?: string;
  } = {};
  const provider = createCodexCliProvider(
    {
      provider: "codex-cli",
      model: "gpt-5.5",
      apiKey: "test-api-key",
      reasoningEffort: "xhigh",
      retryOptions: { timeoutMs: 1234 },
    },
    {
      async runCodexCli(request) {
        captured.args = request.args;
        captured.input = request.input;
        captured.env = request.env;
        captured.workspacePath = request.workspacePath;
        captured.outputPath = request.outputPath;
        assert.equal(request.executable, "codex");
        assert.equal(request.timeoutMs, 1234);
        return {
          status: 0,
          signal: null,
          stdout: "ignored stdout",
          stderr: "",
          outputText: "  final answer\n",
        };
      },
    },
  );

  const result = await provider.complete("What is remembered?", {
    systemPrompt: "Answer using only benchmark context.",
    temperature: 0,
  });

  assert.equal(result.text, "final answer");
  assert.equal(result.model, "gpt-5.5");
  assert.deepEqual(result.tokens, { input: 0, output: 0 });
  assert.deepEqual(provider.getUsage(), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  assert.deepEqual(captured.args, [
    "exec",
    "--model",
    "gpt-5.5",
    "--config",
    'model_reasoning_effort="xhigh"',
    "--config",
    'approval_policy="never"',
    "--disable",
    "codex_hooks",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--cd",
    captured.workspacePath,
    "--skip-git-repo-check",
    "--output-last-message",
    captured.outputPath,
    "-",
  ]);
  assert.match(captured.workspacePath ?? "", /remnic-codex-cli-/);
  assert.ok(captured.input?.includes("BENCHMARK_REQUEST_JSON:"));
  assert.ok(captured.input?.includes('"systemPrompt": "Answer using only benchmark context."'));
  assert.ok(captured.input?.includes('"userPrompt": "What is remembered?"'));
  assert.equal(captured.env?.REMNIC_MEMORY_DIR, undefined);
  assert.equal(captured.env?.ENGRAM_MEMORY_DIR, undefined);
  assert.equal(captured.env?.OPENCLAW_ENGRAM_ACCESS_TOKEN, undefined);
  assert.equal(captured.env?.OPENAI_API_KEY, "test-api-key");
});

test("codex-cli provider defaults reasoning effort to xhigh", async () => {
  let args: string[] = [];
  const provider = createCodexCliProvider(
    { provider: "codex-cli", model: "gpt-5.5" },
    {
      async runCodexCli(request) {
        args = request.args;
        return {
          status: 0,
          signal: null,
          stdout: "",
          stderr: "",
          outputText: "ok",
        };
      },
    },
  );

  await provider.complete("hello");

  assert.equal(
    args[args.indexOf("--config") + 1],
    'model_reasoning_effort="xhigh"',
  );
});

test("codex-cli provider records total token usage from CLI stderr", async () => {
  const provider = createCodexCliProvider(
    { provider: "codex-cli", model: "gpt-5.5" },
    {
      async runCodexCli() {
        return {
          status: 0,
          signal: null,
          stdout: "",
          stderr: "tokens used 1,234",
          outputText: "final answer",
        };
      },
    },
  );

  const result = await provider.complete("hello");

  assert.deepEqual(result.tokens, { input: 1231, output: 3 });
  assert.deepEqual(provider.getUsage(), {
    inputTokens: 1231,
    outputTokens: 3,
    totalTokens: 1234,
  });
});

test("codex-cli token parser uses the final tokens-used line", () => {
  assert.deepEqual(
    __codexCliProviderTestHooks.parseCodexTokenUsage(
      "tokens used 100\ntokens used 2,000",
      "ok",
    ),
    { input: 1999, output: 1 },
  );
});

test("codex-cli provider records token usage when Codex writes token accounting to stdout", async () => {
  const provider = createCodexCliProvider(
    { provider: "codex-cli", model: "gpt-5.5" },
    {
      async runCodexCli() {
        return {
          status: 0,
          signal: null,
          stdout: "tokens used 44",
          stderr: "",
          outputText: "final answer",
        };
      },
    },
  );

  const result = await provider.complete("hello");

  assert.equal(result.tokens.input + result.tokens.output, 44);
  assert.equal(provider.getUsage().totalTokens, 44);
});

test("codex-cli provider surfaces non-zero CLI exits", async () => {
  const provider = createCodexCliProvider(
    { provider: "codex-cli", model: "gpt-5.5" },
    {
      async runCodexCli() {
        return {
          status: 2,
          signal: null,
          stdout: "",
          stderr: "invalid model",
          outputText: "",
        };
      },
    },
  );

  await assert.rejects(
    provider.complete("hello"),
    /Codex CLI completion failed \(exit 2\): invalid model/,
  );
});

test("codex-cli command terminates subprocess when aborted", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-codex-cli-test-"));
  const controller = new AbortController();

  try {
    const run = __codexCliProviderTestHooks.runCodexCliCommand({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdin.resume(); setInterval(() => {}, 1000);",
      ],
      input: "hello",
      outputPath: path.join(tempDir, "last-message.txt"),
      workspacePath: tempDir,
      timeoutMs: 60_000,
      signal: controller.signal,
      env: process.env,
    });

    setTimeout(() => controller.abort(), 20);
    const result = await run;

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Codex CLI aborted by benchmark timeout/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("codex-cli benchmark prompt keeps system and user input in separate JSON fields", () => {
  const prompt = __codexCliProviderTestHooks.buildCodexCompletionPrompt(
    "USER_CONTEXT: answer this",
    "SYSTEM_CONTEXT: judge this",
  );

  const json = prompt.slice(prompt.indexOf("{"));
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, {
    systemPrompt: "SYSTEM_CONTEXT: judge this",
    userPrompt: "USER_CONTEXT: answer this",
  });
});
