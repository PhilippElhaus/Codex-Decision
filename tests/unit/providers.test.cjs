"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { provider, wireRequest, parseHealthResult } = require("../../vscode-control/providers");
const { readApiKey, writeApiKey, checkHealth, readGlobalSettings, writeGlobalSettings } = require("../../vscode-control/core");
const { validate } = require("../../vscode-control/schema");

test("default provider uses Decisions predicate API and validates refusals", () => {
  assert.equal(provider().endpoint, "https://api.openai.com/v1/decisions");
  const request = wireRequest({model:"gpt-6-luna",state:{text:"λ"},questions:{ready:{type:"noul",instructions:"Is it ready?"}}});
  assert.equal(JSON.parse(request.input).text,"λ");
  assert.deepEqual(request.questions,[{name:"ready",type:"predicate",instructions:"Is it ready?"}]);
  assert.deepEqual(parseHealthResult({model:"gpt-6-luna",answers:[{name:"ready",type:"predicate",probability:0.9}]}),{ok:true,model:"gpt-6-luna"});
  for (const answer of [{name:"ready",type:"refusal"},{name:"other",type:"predicate",probability:.9},{name:"ready",type:"predicate",probability:1.1}])
    assert.throws(()=>parseHealthResult({model:"gpt-6-luna",answers:[answer]}));
});

test("provider keys coexist and health requests use only the selected credential", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"decision-providers-"));
  try {
    await writeApiKey(directory,"synthetic-openai-key");
    await writeApiKey(directory,"synthetic-typesafe-key","typesafe");
    await writeApiKey(directory,"updated-openai-key");
    assert.equal(await readApiKey(directory),"updated-openai-key");
    assert.equal(await readApiKey(directory,"typesafe"),"synthetic-typesafe-key");
    await writeGlobalSettings(directory,{provider:"typesafe",model:"jev-latest"});
    const result = await checkHealth(directory, async (url,options)=>{
      assert.equal(url,provider("typesafe").endpoint);
      assert.equal(options.headers.Authorization,"Bearer synthetic-typesafe-key");
      assert.equal(JSON.parse(options.body).questions.ready.type,"noul");
      return {ok:true,text:async()=>JSON.stringify({model:"jev-latest",answers:{ready:{type:"noul",noul:.9}}})};
    });
    assert.equal(result.ok,true);
    const old = validate("settings",{schema_version:3,mode:"replace",relevance_policy:{relevant_max:5},log_limit_mb:50,never_delete_logs:false});
    assert.equal(old.provider,"typesafe");
    assert.throws(()=>validate("settings",{...old,provider:"openai"}));
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});

test("shared behavior changes preserve the legacy provider when settings are absent", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"decision-legacy-settings-"));
  const legacy = {provider:"typesafe", model:"jev-latest"};
  try {
    assert.equal((await readGlobalSettings(directory)).provider,"openai");
    assert.equal((await readGlobalSettings(directory,legacy)).provider,"typesafe");
    await writeGlobalSettings(directory,{never_delete_logs:true},legacy);
    assert.equal((await readGlobalSettings(directory)).provider,"typesafe");
    await writeGlobalSettings(directory,{provider:"openai",model:"gpt-6-luna"},legacy);
    assert.equal((await readGlobalSettings(directory,legacy)).provider,"openai");
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});

test("concurrent provider credential updates retain both maximum length keys", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-provider-lock-"));
  try {
    await Promise.all([
      writeApiKey(directory, "o".repeat(4096), "openai"),
      writeApiKey(directory, "j".repeat(4096), "typesafe"),
    ]);
    assert.equal((await readApiKey(directory, "openai")).length, 4096);
    assert.equal((await readApiKey(directory, "typesafe")).length, 4096);
    const status = await require("../../vscode-control/core").readProviderKeys(directory);
    assert.deepEqual(status, { openai: { hasKey: true }, typesafe: { hasKey: true } });
    assert.equal(JSON.stringify(status).includes("oooo"), false);
    await assert.rejects(writeApiKey(directory, "short", "openai"));
    assert.equal((await readApiKey(directory, "typesafe")).length, 4096);
    await assert.rejects(fs.stat(path.join(directory, ".decision-write.lock")), { code: "ENOENT" });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("fallback defaults off, persists explicit opt in and rejects nonboolean values", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-fallback-settings-"));
  try {
    assert.equal((await readGlobalSettings(directory)).fallback_enabled, false);
    await writeGlobalSettings(directory, { fallback_enabled: true });
    assert.equal((await readGlobalSettings(directory)).fallback_enabled, true);
    await writeGlobalSettings(directory, { provider: "typesafe", model: "jev-latest" });
    assert.equal((await readGlobalSettings(directory)).fallback_enabled, true);
    await assert.rejects(writeGlobalSettings(directory, { fallback_enabled: "true" }));
    await writeGlobalSettings(directory, { fallback_enabled: false });
    assert.equal((await readGlobalSettings(directory)).fallback_enabled, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("health distinguishes missing credentials from invalid or unsafe records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-credential-health-"));
  const filename = path.join(directory, ".env");
  let calls = 0;
  const send = async () => { calls += 1; throw new Error("must not call"); };
  try {
    assert.equal((await checkHealth(directory, send)).reason, "DECISION_KEY_MISSING");
    await fs.writeFile(filename, "JEV_API_KEY=synthetic-jevv-key\n", { mode: 0o600 });
    assert.equal((await checkHealth(directory, send)).reason, "DECISION_KEY_MISSING");
    for (const content of ["OPENAI_API_KEY=short\n", "OPENAI_API_KEY=synthetic-one\nOPENAI_API_KEY=synthetic-two\n"]) {
      await fs.writeFile(filename, content);
      assert.equal((await checkHealth(directory, send)).reason, "DECISION_KEY_INVALID");
    }
    await fs.writeFile(filename, Buffer.from([0xff, 0xfe, 0x01]));
    assert.equal((await checkHealth(directory, send)).reason, "DECISION_CREDENTIAL_UNSAFE");
    await fs.writeFile(filename, "OPENAI_API_KEY=synthetic-one\n");
    await fs.chmod(filename, 0o644);
    if (process.platform !== "win32") assert.equal((await checkHealth(directory, send)).reason, "DECISION_CREDENTIAL_UNSAFE");
    assert.equal(calls, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("health checks abort slow requests at the supplied budget and support superseding checks", async () => {
  let aborted = 0;
  const slow = async (_url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: false, status: 503 }), 2000);
    const cancel = () => { aborted += 1; clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
  const started = performance.now();
  const timed = await checkHealth(os.tmpdir(), slow, "synthetic-health-key", "openai", { timeoutMs: 30 });
  assert.equal(timed.reason, "DECISION_TIMEOUT");
  assert.ok(performance.now() - started < 500, "request must not wait for the slow response");
  const controller = new AbortController();
  const pending = checkHealth(os.tmpdir(), slow, "synthetic-health-key", "openai", { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).reason, "DECISION_CANCELLED");
  assert.equal(aborted, 2);
});
