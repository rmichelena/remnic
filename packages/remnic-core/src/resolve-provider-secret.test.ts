import assert from "node:assert/strict";
import test from "node:test";

import {
  __findExecutableOnPathForTest,
  __setGatewayResolverForTest,
  clearSecretCache,
  resolveProviderApiKey,
} from "./resolve-provider-secret.js";

test("resolveProviderApiKey scopes cached gateway secrets by agent directory", async () => {
  clearSecretCache();

  const calls: string[] = [];
  __setGatewayResolverForTest(async ({ agentDir }) => {
    calls.push(String(agentDir));
    return { apiKey: `key:${agentDir}` };
  });

  try {
    const first = await resolveProviderApiKey(
      "openai",
      "secretref-managed",
      {},
      "/tmp/openclaw-profile-a/agent",
    );
    const second = await resolveProviderApiKey(
      "openai",
      "secretref-managed",
      {},
      "/tmp/openclaw-profile-b/agent",
    );
    const repeatFirst = await resolveProviderApiKey(
      "openai",
      "secretref-managed",
      {},
      "/tmp/openclaw-profile-a/agent",
    );

    assert.equal(first, "key:/tmp/openclaw-profile-a/agent");
    assert.equal(second, "key:/tmp/openclaw-profile-b/agent");
    assert.equal(repeatFirst, first);
    assert.deepEqual(calls, [
      "/tmp/openclaw-profile-a/agent",
      "/tmp/openclaw-profile-b/agent",
    ]);
  } finally {
    clearSecretCache();
  }
});

test("resolveProviderApiKey does not reuse cached literal keys for different inputs", async () => {
  clearSecretCache();

  try {
    const first = await resolveProviderApiKey(
      "openai",
      "sk-first",
      {},
      "/tmp/openclaw-profile-literals/agent",
    );
    const second = await resolveProviderApiKey(
      "openai",
      "sk-second",
      {},
      "/tmp/openclaw-profile-literals/agent",
    );

    assert.equal(first, "sk-first");
    assert.equal(second, "sk-second");
  } finally {
    clearSecretCache();
  }
});

test("resolveProviderApiKey scopes cached gateway secrets by auth input and config", async () => {
  clearSecretCache();

  const calls: string[] = [];
  __setGatewayResolverForTest(async ({ cfg }) => {
    const profile = (cfg as { profile?: string } | undefined)?.profile ?? "unknown";
    calls.push(profile);
    return { apiKey: `key:${profile}` };
  });

  try {
    const first = await resolveProviderApiKey(
      "openai",
      "secretref-managed",
      { profile: "alpha" },
      "/tmp/openclaw-profile-shared/agent",
    );
    const second = await resolveProviderApiKey(
      "openai",
      "secretref-managed",
      { profile: "beta" },
      "/tmp/openclaw-profile-shared/agent",
    );
    const repeatFirst = await resolveProviderApiKey(
      "openai",
      "secretref-managed",
      { profile: "alpha" },
      "/tmp/openclaw-profile-shared/agent",
    );

    assert.equal(first, "key:alpha");
    assert.equal(second, "key:beta");
    assert.equal(repeatFirst, first);
    assert.deepEqual(calls, ["alpha", "beta"]);
  } finally {
    clearSecretCache();
  }
});

test("resolveProviderApiKey treats env-var-shaped config strings as markers", async () => {
  clearSecretCache();
  const previousOpenAI = process.env.OPENAI_API_KEY;
  __setGatewayResolverForTest(async () => null);

  try {
    delete process.env.OPENAI_API_KEY;
    const unresolved = await resolveProviderApiKey(
      "openai",
      "OPENAI_API_KEY",
      {},
      "/tmp/openclaw-profile-marker/agent",
    );
    assert.equal(
      unresolved,
      undefined,
      "OPENAI_API_KEY must not be sent as a literal bearer token when no env value exists",
    );

    clearSecretCache();
    __setGatewayResolverForTest(async () => null);
    process.env.OPENAI_API_KEY = "sk-from-env";
    const resolvedFromEnv = await resolveProviderApiKey(
      "openai",
      "OPENAI_API_KEY",
      {},
      "/tmp/openclaw-profile-marker/agent",
    );
    assert.equal(resolvedFromEnv, "sk-from-env");

    clearSecretCache();
    __setGatewayResolverForTest(async () => null);
    const resolvedNamedMarker = await resolveProviderApiKey(
      "custom-openai",
      "OPENAI_API_KEY",
      {},
      "/tmp/openclaw-profile-marker/agent",
    );
    assert.equal(
      resolvedNamedMarker,
      "sk-from-env",
      "env-var markers should dereference the named variable before provider-derived fallback",
    );
  } finally {
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
    clearSecretCache();
  }
});

test("findExecutableOnPath skips directories named like the executable", () => {
  const calls: string[] = [];
  const access = (candidate: string): void => {
    calls.push(candidate);
  };
  const stat = (candidate: string): { isFile(): boolean } => ({
    isFile: () => candidate === "/bin/openclaw",
  });
  const previousPath = process.env.PATH;

  try {
    process.env.PATH = ["/tmp", "/bin"].join(":");
    const resolved = __findExecutableOnPathForTest("openclaw", access, stat, 1);
    assert.equal(resolved, "/bin/openclaw");
    assert.deepEqual(calls, ["/tmp/openclaw", "/bin/openclaw"]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
