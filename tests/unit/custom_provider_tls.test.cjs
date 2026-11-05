"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { validateCustomProvider } = require("../../vscode-control/providers");
const { checkHealth, customCredentialIdentity, saveProviderSettings, readGlobalSettings, readApiKey } = require("../../vscode-control/core");
const readFixture = name => fs.readFileSync(path.join(__dirname, "../fixtures", name), "utf8");
const certificate = readFixture("custom-provider-server.pem");
const key = readFixture("custom-provider-server-key.pem");
const wrongName = readFixture("custom-provider-wrong-name.pem");
const otherCA = readFixture("custom-provider-ca.pem");
const custom = (changes = {}) => ({ name: "Synthetic TLS provider", protocol: "openai",
  endpoint: "https://127.0.0.1/v1/decisions", model: "team/decision-alias", response_model: "resolved-model-v2",
  auth: "none", ca_certificate: certificate, ...changes });
const healthBody = model => JSON.stringify({ model, answers: [{ name: "ready", type: "predicate", probability: .95 }] });

async function serve(t, handler, cert = certificate) {
  const server = https.createServer({ key, cert }, handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `https://127.0.0.1:${server.address().port}/v1/decisions`;
}

test("custom certificates accept public PEM only and response models remain explicit", () => {
  assert.equal(validateCustomProvider(custom()).ca_certificate, certificate);
  assert.equal(validateCustomProvider(custom({ ca_certificate: "", response_model: "" })).ca_certificate, undefined);
  for (const ca_certificate of [null, 1, " ", `${certificate}\v`, `${certificate}\u00a0`, "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----", `${certificate}secret text`,
    "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----", certificate.repeat(20)]) {
    assert.throws(() => validateCustomProvider(custom({ ca_certificate })));
  }
  for (const response_model of [null, "model with spaces", "injected\nmodel", "m".repeat(129)])
    assert.throws(() => validateCustomProvider(custom({ response_model })));
  assert.throws(() => validateCustomProvider(custom({ endpoint: "http://127.0.0.1:8080/v1/decisions" })), /HTTPS/);
  assert.doesNotThrow(() => validateCustomProvider(custom({ endpoint: "http://127.0.0.1:8080/v1/decisions", ca_certificate: "" })));
  const plain = custom({ ca_certificate: "", response_model: "" });
  assert.equal(customCredentialIdentity(plain), customCredentialIdentity({ ...plain, ca_certificate: undefined }));
  assert.notEqual(customCredentialIdentity(plain), customCredentialIdentity(custom()));
  assert.notEqual(customCredentialIdentity(custom()), customCredentialIdentity(custom({ ca_certificate: otherCA })));
  assert.equal(customCredentialIdentity(custom()), customCredentialIdentity(custom({ response_model: "other-model" })));
});

test("real custom health transport verifies scoped trust and the configured response model", async t => {
  const requests = [];
  let model = "resolved-model-v2";
  const endpoint = await serve(t, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ headers: request.headers, body: JSON.parse(body) });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(healthBody(model));
  });
  const spec = custom({ endpoint });
  const invoke = changes => checkHealth(os.tmpdir(), undefined, null, "custom", { customProvider: { ...spec, ...changes } });
  assert.deepEqual(await invoke(), { ok: true, model: "resolved-model-v2" });
  assert.equal(requests[0].body.model, "team/decision-alias");
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal((await invoke({ ca_certificate: otherCA })).reason, "DECISION_NETWORK_ERROR");
  assert.equal((await invoke({ ca_certificate: "" })).reason, "DECISION_NETWORK_ERROR");
  assert.equal(requests.length, 1, "untrusted connections must not deliver the request");
  assert.equal((await invoke({ response_model: "" })).reason, "DECISION_INVALID_RESPONSE");
  model = "another-model";
  assert.equal((await invoke()).reason, "DECISION_INVALID_RESPONSE");
  let injected = 0;
  assert.equal((await checkHealth(os.tmpdir(), async () => {
    injected += 1;
    return { ok: true, text: async () => healthBody("resolved-model-v2") };
  }, null, "custom", { customProvider: spec })).ok, true);
  assert.equal(injected, 1, "explicit test transports must remain injectable");
});

test("custom trust still rejects a valid certificate for another hostname", async t => {
  let requests = 0;
  const endpoint = await serve(t, (_request, response) => { requests += 1; response.end(healthBody("resolved-model-v2")); }, wrongName);
  const result = await checkHealth(os.tmpdir(), undefined, null, "custom", { customProvider: custom({ endpoint, ca_certificate: wrongName }) });
  assert.equal(result.reason, "DECISION_NETWORK_ERROR");
  assert.equal(requests, 0);
});

test("custom TLS requests reject redirects and bound streamed responses", async t => {
  let mode = "redirect";
  let redirects = 0;
  const endpoint = await serve(t, (request, response) => {
    if (request.url !== "/v1/decisions") { redirects += 1; response.end(healthBody("resolved-model-v2")); return; }
    if (mode === "redirect") { response.writeHead(307, { Location: "/redirected" }); response.end(); return; }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("x".repeat(262145));
  });
  const invoke = () => checkHealth(os.tmpdir(), undefined, null, "custom", { customProvider: custom({ endpoint }) });
  assert.equal((await invoke()).reason, "DECISION_NETWORK_ERROR");
  assert.equal(redirects, 0);
  mode = "oversize";
  assert.equal((await invoke()).reason, "DECISION_INVALID_RESPONSE");
});

test("custom TLS response reads respect the shared deadline and cancellation", async t => {
  const endpoint = await serve(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write("{");
  });
  const spec = custom({ endpoint });
  const started = performance.now();
  const result = await checkHealth(os.tmpdir(), undefined, null, "custom", { customProvider: spec, timeoutMs: 100 });
  assert.equal(result.reason, "DECISION_TIMEOUT");
  assert.ok(performance.now() - started < 1000);
  const controller = new AbortController();
  const pending = checkHealth(os.tmpdir(), undefined, null, "custom", { customProvider: spec, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).reason, "DECISION_CANCELLED");
});

test("large public CA settings round trip and changed trust requires fresh credentials", async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "decision-custom-tls-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const spec = custom({ auth: "bearer", ca_certificate: certificate.repeat(10) });
  await saveProviderSettings(directory, { provider: "custom", custom_provider: spec }, { key: "synthetic-custom-key" });
  assert.ok((await fsp.stat(path.join(directory, "settings.json"))).size > 8192);
  assert.deepEqual((await readGlobalSettings(directory)).custom_provider.ca_certificate, spec.ca_certificate);
  assert.equal(await readApiKey(directory, "custom"), "synthetic-custom-key");
  await assert.rejects(saveProviderSettings(directory, { provider: "custom", custom_provider: { ...spec, ca_certificate: otherCA } }), /Enter credentials/);
  assert.equal(await readApiKey(directory, "custom"), "synthetic-custom-key");
});
