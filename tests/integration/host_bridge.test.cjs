"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const core = require("../../vscode-control/core");

async function hostBridge(executeCommand) {
  const source = await fs.readFile(path.join(__dirname,
    "../../vscode-control/patch-assets/host-bridge.jsfrag"), "utf8");
  let handler;
  const replies = [];
  let delegated = 0;
  const context = {
    require(name) {
      if (name === "node:crypto") return require(name);
      assert.equal(name, "vscode");
      return { commands: { executeCommand } };
    },
    e: {
      onDidReceiveMessage(callback) { handler = callback; },
      postMessage(reply) { replies.push(reply); },
    },
    s: { markMessageReceived() { delegated += 1; } },
    // Codex's minified bindings are unrelated to the public VS Code API.
    qe: {},
  };
  vm.runInNewContext(`${source}{} });`, context);
  return {
    async send(request) {
      handler(request);
      await new Promise((resolve) => setImmediate(resolve));
      return replies.at(-1);
    },
    replies,
    delegated: () => delegated,
  };
}

test("patched host carries the Decision toggle through the extension to session storage", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-host-test-"));
  const commands = new Map();
  const context = { subscriptions: [], extensionUri: {} };
  const fake = {
    window: { registerWebviewViewProvider: () => ({ dispose() {} }) },
    commands: {
      registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; },
      executeCommand(name, payload) { return commands.get(name)(payload); },
    },
    workspace: {
      getConfiguration: () => ({ get: () => directory }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
  };
  const originalLoad = Module._load;
  const originalHealth = core.checkHealth;
  core.checkHealth = async () => ({ ok: false, reason: "DECISION_KEY_MISSING" });
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
    const bridge = await hostBridge(fake.commands.executeCommand);
    let id = 0;
    const request = async (action, extra = {}) => {
      const message = { type: "codex-decision", id: ++id, action, viewId: "host-view",
        sessionId: "host-session", sourceId: "host-source", visible: true, expectsLocalSession: true, focused: true, ...extra };
      const before = bridge.replies.length;
      await bridge.send(message);
      const deadline = Date.now() + 2000;
      while (bridge.replies.length === before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const reply = bridge.replies.at(-1);
      assert.equal(reply?.id, message.id, "the host must reply to every accepted request");
      return reply.status;
    };
    const initial = await request("status");
    assert.equal(initial.enabled, true);
    for (const enabled of [false, true, false]) {
      const reply = await request("setSelection", { enabled });
      assert.equal(reply.enabled, enabled);
      const stored = await core.readConfig(core.sessionDirectory(directory, "host-session"));
      assert.equal(stored.enabled, enabled, "the toggle must reach the hook config");
      assert.equal(stored.schema_version, 5);
      assert.equal("test_build_enabled" in stored, false);
      assert.equal("search_listing_enabled" in stored, false);
    }
    assert.equal((await request("status")).enabled, false);
    const background = await request("status", { viewId: "home-view", sessionId: null,
      expectsLocalSession: false });
    assert.equal(background.sessionPending, true);
    const returned = await request("status");
    assert.equal(returned.enabled, false, "navigation must preserve saved selections");
  } finally {
    for (const disposable of context.subscriptions.reverse()) disposable.dispose();
    await fs.rm(directory, { recursive: true });
  }
});

test("patched host replies when command lookup throws or execution rejects", async () => {
  for (const executeCommand of [
    () => { throw new Error("command unavailable"); },
    () => Promise.reject(new Error("host disconnected")),
  ]) {
    const bridge = await hostBridge(executeCommand);
    const reply = await bridge.send({ type: "codex-decision", id: 17, action: "status" });
    assert.equal(reply.id, 17);
    assert.equal(reply.status.health.reason, "BRIDGE_UNAVAILABLE");
  }
});

test("patched host rejects malformed selections and leaves ordinary messages with Codex", async () => {
  let calls = 0;
  const bridge = await hostBridge(() => { calls += 1; return {}; });
  for (const extra of [{ enabled: null }, { enabled: "true" }, { enabled: true, sessionId: "../other" },
    { enabled: true, sourceId: "../other" }, { enabled: true, visible: "true" }]) {
    await bridge.send({ type: "codex-decision", action: "setSelection", ...extra });
  }
  assert.equal(calls, 0);
  await bridge.send({ type: "chunked-message-ack" });
  assert.equal(bridge.delegated(), 1);
});

test("patched host forwards stable webview identity and visibility without inferring focus", async () => {
  let received;
  const bridge = await hostBridge(async (_command, request) => { received = request; return {}; });
  await bridge.send({ type: "codex-decision", action: "status", id: 1,
    viewId: "restored-route", sourceId: "selected-webview", visible: true, focused: false,
    sessionId: "synthetic-restored-thread", expectsLocalSession: true });
  const hostSource = received.sourceId;
  assert.match(hostSource, /^[a-f0-9-]{36}$/);
  assert.equal(received.visible, true);
  assert.equal(received.focused, false);
  await bridge.send({ type: "codex-decision", action: "status", id: 2,
    viewId: "reloaded-route", sourceId: "new-renderer-identity", visible: true, focused: false,
    sessionId: "synthetic-restored-thread", expectsLocalSession: true });
  assert.equal(received.sourceId, hostSource, "HTML reloads retain the underlying host webview identity");
});
