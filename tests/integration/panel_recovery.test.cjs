"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");
const panelState = require("../../vscode-control/panel-state");

function decision(id) {
  return { id, at: "2020-01-01T00:00:00Z", rows: [] };
}

function fixture(readDecision, postMessage = async () => true) {
  const originalLoad = Module._load;
  const originalRead = panelState.readLatestPanelDecision;
  panelState.readLatestPanelDecision = readDecision;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return { Uri: { joinPath: (_root, ...parts) => parts.join("/") } };
    return originalLoad.call(this, request, parent, isMain);
  };
  let LatestDecisionProvider;
  try {
    delete require.cache[require.resolve("../../vscode-control/panel")];
    ({ LatestDecisionProvider } = require("../../vscode-control/panel"));
  } finally {
    Module._load = originalLoad;
    panelState.readLatestPanelDecision = originalRead;
  }
  const messages = [];
  const faults = [];
  let directory = "session-a";
  let now = Date.now();
  const provider = new LatestDecisionProvider({}, () => directory, () => now,
    (fault) => faults.push(fault));
  provider.view = { visible: true, webview: { postMessage: async (message) => {
    messages.push(message);
    return postMessage(message);
  } } };
  return { provider, messages, faults,
    select(value) { directory = value; }, advance(ms) { now += ms; } };
}

test("panel switches sessions immediately while the previous decision is resting", async () => {
  const f = fixture(async (directory) => decision(directory));
  try {
    await f.provider.refresh();
    assert.equal(f.messages.at(-1).decision.id, "session-a");
    f.select("session-b");
    await f.provider.refresh();
    assert.equal(f.messages.at(-1).decision.id, "session-b");
    f.select(null);
    await f.provider.refresh();
    assert.equal(f.messages.at(-1).decision, null);
  } finally { f.provider.dispose(); }
});

test("a delayed panel read cannot publish another session's decision", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const f = fixture(async (directory) => {
    if (directory === "session-a") await held;
    return decision(directory);
  });
  try {
    const first = f.provider.refresh();
    f.select("session-b");
    const second = f.provider.refresh();
    release();
    await Promise.all([first, second]);
    await f.provider.refresh();
    assert.ok(f.messages.every((message) => message.decision?.id !== "session-a"));
    assert.equal(f.messages.at(-1).decision.id, "session-b");
  } finally { f.provider.dispose(); }
});

test("a stale session read failure cannot report a fault for the selected session", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const f = fixture(async (directory) => {
    if (directory === "session-a") { await held; throw new Error("old session read failed"); }
    return decision(directory);
  });
  try {
    const first = f.provider.refresh();
    f.select("session-b");
    const second = f.provider.refresh();
    release();
    await Promise.all([first, second]);
    await f.provider.refresh();
    assert.ok(f.faults.every((fault) => fault === null));
    assert.equal(f.messages.at(-1).decision.id, "session-b");
  } finally { f.provider.dispose(); }
});

for (const failure of [false, "reject"]) {
  test(`panel retries a ${failure === false ? "dropped" : "rejected"} webview delivery`, async () => {
    let attempts = 0;
    const f = fixture(async () => decision("latest"), async () => {
      if (++attempts === 1) {
        if (failure === "reject") throw new Error("webview disposed");
        return false;
      }
      return true;
    });
    try {
      await f.provider.refresh();
      assert.equal(f.provider.nextDecisionAt, 0);
      await f.provider.refresh();
      assert.equal(attempts, 2);
      assert.equal(f.messages.at(-1).decision.id, "latest");
      assert.ok(f.provider.nextDecisionAt > 0);
      await f.provider.refresh();
      assert.equal(attempts, 2);
    } finally { f.provider.dispose(); }
  });
}

test("a disposed panel cannot receive an outstanding read", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const f = fixture(async () => { await held; return decision("latest"); });
  const pending = f.provider.refresh();
  f.provider.dispose();
  release();
  await pending;
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.faults, []);
});

test("a hidden panel reads the latest decision when it returns", async () => {
  let reads = 0;
  const f = fixture(async () => { reads += 1; return decision("latest"); });
  try {
    f.provider.view.visible = false;
    await f.provider.refresh();
    assert.equal(reads, 0);
    f.provider.view.visible = true;
    await f.provider.refresh();
    assert.equal(reads, 1);
    assert.equal(f.messages.at(-1).decision.id, "latest");
  } finally { f.provider.dispose(); }
});

test("panel subscribes before document load and waits for the renderer to be ready", async () => {
  let reads = 0;
  let ready;
  const f = fixture(async () => { reads += 1; return decision("latest"); });
  const view = f.provider.view;
  view.webview.cspSource = "vscode-resource:";
  view.webview.asWebviewUri = (uri) => uri;
  view.webview.onDidReceiveMessage = (callback) => { ready = callback; return { dispose() {} }; };
  view.onDidChangeVisibility = () => ({ dispose() {} });
  view.onDidDispose = () => {};
  Object.defineProperty(view.webview, "html", { set(html) {
    assert.ok(html.includes("jev-panel.js"));
    assert.equal(typeof ready, "function", "the listener must exist before HTML loads");
  } });
  try {
    f.provider.resolveWebviewView(view);
    await f.provider.refresh();
    assert.equal(reads, 0, "a not-yet-ready renderer receives no decision");
    ready({ type: "ready" });
    await f.provider.refresh();
    assert.equal(reads, 1);
    assert.equal(f.messages.at(-1).decision.id, "latest");
    ready({ type: "ready" });
    await f.provider.refresh();
    assert.equal(f.messages.length, 2, "a reloaded renderer receives the retained decision again");
  } finally { f.provider.dispose(); }
});

test("an unavailable data directory reports a fault and recovers on the next refresh", async () => {
  const f = fixture(async () => decision("latest"));
  const directory = f.provider.dataDirectory;
  try {
    f.provider.dataDirectory = () => { throw new Error("configuration missing"); };
    await f.provider.refresh();
    assert.equal(f.messages.at(-1).decision, null);
    assert.equal(f.faults.at(-1), "Latest Jev decision could not be read");
    f.provider.dataDirectory = directory;
    await f.provider.refresh();
    assert.equal(f.messages.at(-1).decision.id, "latest");
    assert.equal(f.faults.at(-1), null);
  } finally { f.provider.dispose(); }
});
