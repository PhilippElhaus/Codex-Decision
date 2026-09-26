"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("../core");

async function until(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for bridge state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("composer bridge selects integrations and reports view-scoped activity without a status item", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  const commands = new Map();
  let mode = "replace";
  let health = { ok: true, model: "jev-1.13.0" };
  let configListener;
  const fake = {
    window: {
      createStatusBarItem: () => { throw new Error("Status bar item must not be created"); },
      showInformationMessage: () => {},
    },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    workspace: {
      getConfiguration: () => ({ get: (key) => key === "dataDirectory" ? directory : key === "mode" ? mode : "" }),
      onDidChangeConfiguration: (callback) => { configListener = callback; return { dispose() {} }; },
    },
  };
  const originalLoad = Module._load;
  const originalHealth = core.checkHealth;
  core.checkHealth = async () => health;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return fake;
    return originalLoad.call(this, request, parent, isMain);
  };
  let extension;
  try {
    delete require.cache[require.resolve("../extension")];
    extension = require("../extension");
  } finally {
    Module._load = originalLoad;
    core.checkHealth = originalHealth;
  }
  const context = { subscriptions: [] };
  try {
    extension.activate(context);
    assert.equal(commands.has("codexJev.selectHooks"), false);
    const bridge = commands.get("codexJev.bridge");
    assert.equal((await bridge({ action: "status", viewId: "view-one" })).enabled, false);
    await bridge({ action: "setSelection", feature: "output", enabled: true, viewId: "view-one" });
    await until(async () => (await bridge({ action: "status", viewId: "view-one" })).health?.ok === true);
    assert.equal((await core.readConfig(directory)).enabled, true);

    mode = "observe";
    configListener({ affectsConfiguration: (key) => key === "codexJev" });
    await until(async () => (await bridge({ action: "status", viewId: "view-one" })).mode === "observe");
    assert.equal((await core.readConfig(directory)).mode, "observe");
    mode = "replace";
    configListener({ affectsConfiguration: (key) => key === "codexJev" });
    await until(async () => (await bridge({ action: "status", viewId: "view-one" })).mode === "replace");

    await fs.appendFile(path.join(directory, "events.jsonl"), JSON.stringify({
      status: "calling", reason: "jev_request", tool: "Bash",
    }) + "\n" + JSON.stringify({
      status: "replace", reason: "jev_replace", tool: "Bash", original_chars: 11520,
      capsule_chars: 912, elapsed_ms: 480,
    }) + "\n");
    await until(async () => (await bridge({ action: "status", viewId: "view-one" })).stats.replaced === 1);
    const first = await bridge({ action: "status", viewId: "view-one" });
    assert.match(first.history[0], /replaced · Bash.*92%/);
    assert.equal(first.stats.completed, 1);

    await Promise.all([
      bridge({ action: "setSelection", feature: "output", enabled: false, viewId: "view-one" }),
      bridge({ action: "setSelection", feature: "test_build", enabled: true, viewId: "view-one" }),
    ]);
    const selected = await bridge({ action: "status", viewId: "view-one" });
    assert.equal(selected.outputEnabled, false);
    assert.equal(selected.testBuildEnabled, true);
    assert.equal(selected.stats.replaced, 1);
    const newView = await bridge({ action: "status", viewId: "view-two" });
    assert.equal(newView.stats.completed, 0);
    assert.deepEqual(newView.history, []);

    health = { ok: false, reason: "JEV_HTTP_ERROR" };
    await commands.get("codexJev.checkConnection")();
    assert.equal((await bridge({ action: "status", viewId: "view-two" })).health.reason, "JEV_HTTP_ERROR");
  } finally {
    for (const disposable of context.subscriptions.reverse()) disposable.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
