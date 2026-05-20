import assert from "node:assert/strict";
import test from "node:test";

import { HermesClient } from "./index.js";

test("recall retries transient server errors according to client policy", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "temporary failure" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        context: "remembered context",
        results: [{ id: "mem-1", content: "remembered context", score: 1 }],
        count: 1,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:4318",
      authToken: "test-token",
      maxRetries: 1,
      retryBaseDelayMs: 0,
    });

    const result = await client.recall("what matters?");

    assert.equal(calls, 2);
    assert.equal(result.context, "remembered context");
    assert.equal(result.results?.[0]?.id, "mem-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
