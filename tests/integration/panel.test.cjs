"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("panel manifest registers a visible view in a valid container", () => {
  const manifest = require("../../vscode-control/package.json");
  const [container] = manifest.contributes.viewsContainers.panel;
  assert.match(container.id, /^[A-Za-z0-9_-]+$/);
  const [view] = manifest.contributes.views[container.id];
  assert.equal(view.id, "codexJevDecision");
  assert.equal(view.visibility, "visible");
});

test("panel refreshes only the latest decision while visible", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-panel-test-"));
  const logs = path.join(directory, "logs");
  await fs.mkdir(logs);
  const filename = path.join(logs, "latest-decision.json");
  const messages = [];
  let onReady;
  let onVisibility;
  let onDispose;
  const fake = { Uri: { joinPath: (_root, ...parts) => parts.join("/") } };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return fake;
    return originalLoad.call(this, request, parent, isMain);
  };
  let LatestDecisionProvider;
  try {
    delete require.cache[require.resolve("../../vscode-control/panel")];
    ({ LatestDecisionProvider } = require("../../vscode-control/panel"));
  } finally {
    Module._load = originalLoad;
  }
  const provider = new LatestDecisionProvider({}, () => directory);
  const view = {
    visible: true,
    webview: {
      cspSource: "vscode-resource:",
      asWebviewUri: (uri) => uri,
      onDidReceiveMessage: (callback) => { onReady = callback; return { dispose() {} }; },
      postMessage: async (message) => { messages.push(message); return true; },
    },
    onDidChangeVisibility: (callback) => { onVisibility = callback; return { dispose() {} }; },
    onDidDispose: (callback) => { onDispose = callback; return { dispose() {} }; },
  };
  try {
    provider.resolveWebviewView(view);
    assert.match(view.webview.html, /Content-Security-Policy/);
    onReady({ type: "ready" });
    await provider.refresh();
    assert.equal(messages.at(-1).decision, null);
    const make = (id, status) => ({ version: 1, id, at: "2026-09-28T12:34:56Z",
      filter: "output", status, call_index: 1, call_count: 1,
      choices: [{ name: "filter_decision", selected: "keep", probabilities: { filter: .2, keep: .8 } }], checks: [] });
    await fs.writeFile(filename, JSON.stringify(make("a".repeat(32), "keep")));
    await provider.refresh();
    assert.equal(messages.at(-1).decision.status, "keep");
    const count = messages.length;
    await provider.refresh();
    assert.equal(messages.length, count);
    await fs.writeFile(filename, JSON.stringify(make("b".repeat(32), "replace")));
    await provider.refresh();
    assert.equal(messages.at(-1).decision.id, "b".repeat(32));
    assert.equal(messages.at(-1).decision.status, "replace");
    view.visible = false;
    onVisibility();
    await fs.writeFile(filename, JSON.stringify(make("c".repeat(32), "keep")));
    await provider.refresh();
    assert.equal(messages.at(-1).decision.id, "b".repeat(32));
    view.visible = true;
    onVisibility();
    await provider.refresh();
    assert.equal(messages.at(-1).decision.id, "c".repeat(32));
  } finally {
    onDispose?.();
    provider.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
