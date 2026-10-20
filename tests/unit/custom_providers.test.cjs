"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { validateCustomProvider } = require("../../vscode-control/providers");
const { validate, defaults } = require("../../vscode-control/schema");
const { saveProviderSettings, readApiKey, readProviderKeys, checkHealth, readGlobalSettings, writeGlobalSettings, writeApiKey,
  customCredentialIdentity } = require("../../vscode-control/core");
const custom = (changes = {}) => ({ name: "Synthetic provider", protocol: "openai", endpoint: "https://decision.example/v1/decisions",
  model: "vendor/typed-model", auth: "bearer", username: "", header_name: "", ...changes });
const fixture = async (run) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-custom-provider-"));
  try { await run(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
};
const response = spec => ({ ok: true, text: async () => JSON.stringify({ model: spec.model,
  answers: spec.protocol === "openai" ? [{ name: "ready", type: "predicate", probability: .95 }] : { ready: { type: "noul", noul: .95 } } }) });

test("custom configuration accepts both schemas and keeps the real model separate from the internal model", () => {
  for (const protocol of ["openai", "jev"]) {
    const config = validate("config", { ...defaults("config"), provider: "custom", custom_provider: custom({ protocol }) });
    assert.equal(config.model, protocol === "openai" ? "gpt-6-luna" : "jev-latest");
    assert.equal(config.custom_provider.model, "vendor/typed-model");
    assert.throws(() => validate("config", { ...config, fallback_enabled: true }));
  }
  for (const endpoint of ["https://@decision.example/api", "https:decision.example", "HTTPS://decision.example", "http://localhost/api", "http://127.1/api",
    "http://2130706433/api", "https://decision.example:0/api", "https://user:password@decision.example/api", "https://decision.example/api?q=x", "https://decision.example/api#hash", "https://decision.example/\\api"]) {
    assert.throws(() => validateCustomProvider(custom({ endpoint })), endpoint);
  }
  for (const endpoint of ["https://decision.example/api", "http://127.0.0.1:8080/api", "http://[::1]:8080/api"]) assert.doesNotThrow(() => validateCustomProvider(custom({ endpoint })));
  for (const header_name of ["Authorization", "Host", "Content-Type", "Connection", "User-Agent", "X-Key\r\nInjected", "bad header"]) {
    assert.throws(() => validateCustomProvider(custom({ auth: "header", header_name })));
  }
});

test("custom health tests each authentication mode and uses the explicitly selected schema", async () => fixture(async directory => {
  for (const protocol of ["openai", "jev"]) for (const auth of ["bearer", "basic", "header", "none"]) {
    const spec = custom({ protocol, auth, username: auth === "basic" ? "test-user" : "", header_name: auth === "header" ? "X-API-Key" : "" });
    const secret = auth === "basic" ? " password with spaces λ " : "synthetic-secret";
    let calls = 0;
    const health = await checkHealth(directory, async (url, options) => {
      calls += 1;
      assert.equal(url, spec.endpoint);
      assert.equal(options.redirect, "error");
      const body = JSON.parse(options.body);
      assert.equal(body.model, spec.model);
      if (protocol === "openai") assert.equal(body.questions[0].type, "predicate");
      else assert.equal(body.questions.ready.type, "noul");
      if (auth === "basic") assert.equal(options.headers.Authorization, `Basic ${Buffer.from(`test-user:${secret}`).toString("base64")}`);
      if (auth === "bearer") assert.equal(options.headers.Authorization, `Bearer ${secret}`);
      if (auth === "header") assert.equal(options.headers["X-API-Key"], secret);
      if (auth === "none") assert.deepEqual(options.headers, { "Content-Type": "application/json" });
      return response(spec);
    }, auth === "bearer" || auth === "header" ? secret : null, "custom", { customProvider: spec, password: auth === "basic" ? secret : "" });
    assert.equal(health.ok, true, `${protocol}/${auth}`);
    assert.equal(calls, 1);
  }
}));

test("custom secrets bind to the destination and auth identity, preserve blank drafts, and coexist with built-in keys", async () => fixture(async directory => {
  await writeApiKey(directory, "synthetic-openai-key");
  await writeApiKey(directory, "synthetic-typesafe-key", "typesafe");
  const spec = custom({ auth: "basic", username: "test-user" });
  const password = "  quoted ' password λ  ";
  await saveProviderSettings(directory, { provider: "custom", custom_provider: spec }, { password });
  assert.equal(await readApiKey(directory, "custom"), password);
  assert.equal(await readApiKey(directory), "synthetic-openai-key");
  assert.equal(await readApiKey(directory, "typesafe"), "synthetic-typesafe-key");
  assert.deepEqual(await readProviderKeys(directory), { openai: { hasKey: true }, typesafe: { hasKey: true }, custom: { hasKey: true } });
  assert.equal((await readProviderKeys(directory, { ...spec, endpoint: "https://another.example/api" })).custom.hasKey, false,
    "session-fallback custom settings use their own credential identity");
  const settingsPath = path.join(directory, "settings.json");
  const retainedPath = path.join(directory, "settings.fixture-retained.json");
  await fs.rename(settingsPath, retainedPath);
  try {
    assert.equal((await readProviderKeys(directory, spec)).custom.hasKey, true,
      "custom session settings find their saved credential before global settings exist");
  } finally { await fs.rename(retainedPath, settingsPath); }

  const stored = await fs.readFile(path.join(directory, "settings.json"), "utf8");
  assert.equal(stored.includes(password), false);
  const status = JSON.stringify(await readProviderKeys(directory));
  assert.equal(status.includes(password), false);
  const credentialFile = await fs.readFile(path.join(directory, ".env"), "utf8");
  assert.ok(credentialFile.includes(`CUSTOM_CREDENTIAL_IDENTITY=${customCredentialIdentity(spec)}`));
  await saveProviderSettings(directory, { provider: "custom", custom_provider: { ...spec, model: "another-model" } }, { password: "" });
  assert.equal(await readApiKey(directory, "custom"), password);
  for (const change of [{ endpoint: "https://other.example/api" }, { username: "other-user" }, { auth: "bearer" }]) {
    const draft = { ...spec, ...change };
    await assert.rejects(saveProviderSettings(directory, { provider: "custom", custom_provider: draft }, {}), /Enter credentials/);
    let calls = 0;
    const health = await checkHealth(directory, async () => { calls += 1; return response(draft); }, null, "custom", { customProvider: draft });
    assert.equal(health.reason, "DECISION_KEY_MISSING");
    assert.equal(calls, 0);
  }
  // Manual edits must not make an old credential usable for a new destination.
  await writeGlobalSettings(directory, { custom_provider: { ...spec, endpoint: "https://other.example/api" } });
  assert.equal((await checkHealth(directory, async () => { throw new Error("must not call"); }, null, "custom")).reason, "DECISION_KEY_MISSING");
  await saveProviderSettings(directory, { provider: "custom", custom_provider: custom({ auth: "none" }) });
  assert.equal(await readApiKey(directory, "custom"), "");
  assert.equal((await fs.readFile(path.join(directory, ".env"), "utf8")).includes("CUSTOM_PASSWORD="), false);
  assert.equal((await readProviderKeys(directory)).custom.hasKey, true);
}));

test("invalid custom drafts never mutate settings or credentials, and health validates the custom model", async () => fixture(async directory => {
  const spec = custom();
  await saveProviderSettings(directory, { provider: "custom", custom_provider: spec }, { key: "synthetic-custom-key" });
  const before = await fs.readFile(path.join(directory, ".env"), "utf8");
  for (const key of ["key\nNEW=value", "key\0", "key\t"]) await assert.rejects(saveProviderSettings(directory,
    { provider: "custom", custom_provider: spec }, { key }));
  assert.equal(await fs.readFile(path.join(directory, ".env"), "utf8"), before);
  assert.equal((await readGlobalSettings(directory)).custom_provider.model, spec.model);
  const health = await checkHealth(directory, async () => response({ ...spec, model: "wrong-model" }), null, "custom");
  assert.equal(health.reason, "DECISION_INVALID_RESPONSE");
}));
