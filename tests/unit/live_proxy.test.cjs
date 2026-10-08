"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { LiveProxyError, postLive, observedUsage } = require("../../scripts/two-stage/live_proxy.cjs");

const options = { key: "synthetic-test-key", wire: { model: "synthetic" },
  calls: 1, tokens: 0, maxCalls: 1, maxTokens: 100 };

test("live budget stops before forwarding and permits the final allowed request", async () => {
  let forwards = 0, responses = 0, transports = 0;
  const run = (limits) => postLive({ ...options, ...limits,
    onForward: () => forwards++, onResponse: () => responses++,
    fetchImpl: async () => { transports++; return new Response("{}"); } });
  for (const limits of [{ calls: 2 }, { tokens: 100 }]) {
    await assert.rejects(run(limits), (error) => error instanceof LiveProxyError && error.code === "budget");
  }
  assert.deepEqual([forwards, responses, transports], [0, 0, 0]);
  assert.equal((await run({ tokens: 99 })).text, "{}");
  assert.deepEqual([forwards, responses, transports], [1, 1, 1]);
});

test("live proxy rejects redirects without sending a second request", async (t) => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++; req.resume();
    res.writeHead(302, { Location: "/redirected" }); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(postLive({ ...options,
    endpoint: `http://127.0.0.1:${server.address().port}/decision` }),
    (error) => error.code === "transport" && !error.message.includes(options.key));
  assert.equal(requests, 1);
});

test("live proxy cancels oversized bodies after a header receipt", async () => {
  let cancelled = false, responses = 0;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1_000_001)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(postLive({ ...options,
    onResponse: () => responses++, fetchImpl: async () => new Response(stream) }),
    (error) => error.code === "response_size");
  assert.equal(responses, 1);
  assert.equal(cancelled, true);
});

test("a credential echoed by the provider never becomes a saved response", async () => {
  const escaped = [...options.key].map(value => "\\u" + value.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  for (const text of [JSON.stringify({ error: options.key }),
    '{"error":"' + escaped + '"}',
    '{"error":"' + escaped + '","error":"safe"}']) {
    await assert.rejects(postLive({ ...options, fetchImpl: async () => new Response(text) }),
      (error) => error.code === "credential_echo" && !error.message.includes(options.key));
  }
});

test("unknown or invalid usage never becomes an exact zero or a budget bypass", async () => {
  assert.deepEqual(observedUsage({ usage: { input_tokens: 17, output_tokens: 0 } }),
    { input: 17, output: 0, complete: true });
  for (const body of [{}, { usage: {} }, { usage: { input_tokens: 17 } }]) {
    assert.equal(observedUsage(body).complete, false);
  }
  for (const value of ["17", -1, 0.5, NaN, 100_000_001, null]) {
    assert.throws(() => observedUsage({ usage: { input_tokens: value } }),
      (error) => error.code === "invalid_usage");
  }
  let forwarded = false;
  await assert.rejects(postLive({ ...options, unknownUsage: true,
    onForward: () => { forwarded = true; } }), (error) => error.code === "usage");
  assert.equal(forwarded, false);
});
