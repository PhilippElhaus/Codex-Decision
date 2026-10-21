"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("../../vscode-control/core");
const { readPanelActivity } = require("../../vscode-control/panel-state");

test("composer and panel restore the same thread outcomes and request counts after reload", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-view-coherence-"));
  const context = { subscriptions: [], extensionUri: {} };
  const commands = new Map();
  let panel;
  const fake = {
    window: { registerWebviewViewProvider: (_id, provider) => {
      panel = provider;
      return { dispose() {} };
    } },
    commands: {
      registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; },
      executeCommand: async () => {},
    },
    workspace: {
      getConfiguration: () => ({ get: (key) => key === "dataDirectory" ? directory : false }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
  };
  const originalLoad = Module._load;
  const originalHealth = core.checkHealth;
  core.checkHealth = async () => ({ ok: true, model: "gpt-6-luna" });
  Module._load = function (request, parent, isMain) {
    return request === "vscode" ? fake : originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../../vscode-control/extension")];
    require("../../vscode-control/extension").activate(context);
  } finally {
    Module._load = originalLoad;
    core.checkHealth = originalHealth;
  }
  try {
    const scoped = core.sessionDirectory(directory, "synthetic-coherent-thread");
    await core.ensureSessionDefaults(scoped);
    await fs.mkdir(path.join(scoped, "logs"));
    const bridge = commands.get("codexDecision.bridge");
    let view = 0;
    const open = () => bridge({ action: "status", viewId: `restored-view-${++view}`,
      sessionId: "synthetic-coherent-thread", sourceId: "selected-host-webview",
      visible: true, focused: false, expectsLocalSession: true });
    const savedAt = Date.now() - 120_000;
    const health = { version: 1, hook_version: require("../../vscode-control/package.json").codexDecisionHookVersion,
      last_seen_ms: savedAt, last_error_ms: savedAt, last_error: "invalid Decision response",
      api_requests: 11, skipped: 41 };
    const check = async (expected) => {
      await fs.writeFile(path.join(scoped, "logs", "hook-health.json"), JSON.stringify(health));
      const composer = await open();
      const activity = await readPanelActivity(panel.dataDirectory());
      assert.equal(panel.dataDirectory(), scoped, "terminal focus must not select another thread");
      assert.deepEqual(composer.hookActivity, activity.hookActivity);
      assert.equal(composer.hookActivity.kind, expected);
      assert.equal(composer.stats.calls, activity.calls);
      assert.equal(composer.stats.skipped, activity.skipped);
      assert.ok(composer.viewStartedAt > health.last_seen_ms,
        "this is saved thread state from before the restored webview");
      return composer;
    };
    const failed = await check("error");
    assert.equal(failed.hookActivity.message, "Hook error. Full output kept.");
    assert.match(failed.hookActivity.detail, /invalid Decision response/);
    Object.assign(health, { last_seen_ms: savedAt + 1000, last_skip_ms: savedAt + 1000,
      last_skip: "small", skipped: 42 });
    const skipped = await check("skip");
    assert.match(skipped.hookActivity.message, /too short/);
    assert.doesNotMatch(skipped.hookActivity.message, /error/);
    Object.assign(health, { last_seen_ms: savedAt + 2000, last_success_ms: savedAt + 2000 });
    await check("ready");
    Object.assign(health, { last_seen_ms: savedAt + 3000, last_error_ms: savedAt + 3000 });
    await check("error");
    Object.assign(health, { last_skip_ms: savedAt + 3000, last_skip: "exact_content" });
    await check("error");
    Object.assign(health, { last_seen_ms: savedAt + 4000, last_skip_ms: savedAt + 4000 });
    await check("skip");
    const off = await bridge({ action: "setSelection", enabled: false,
      viewId: `restored-view-${view}`, sessionId: "synthetic-coherent-thread",
      sourceId: "selected-host-webview", visible: true, focused: false });
    assert.deepEqual(off.hookActivity, (await readPanelActivity(scoped)).hookActivity);
    assert.equal(off.hookActivity.kind, "disabled");
  } finally {
    for (const subscription of context.subscriptions.reverse()) subscription.dispose();
    await fs.rm(directory, { recursive: true });
  }
});
