"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("empty panel explains real API requests and skipped outputs for its selected thread", async () => {
  const { readPanelActivity } = require("../../vscode-control/panel-state");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-panel-activity-"));
  try {
    await fs.mkdir(path.join(directory, "logs"));
    const config = { schema_version: 4, enabled: true, mode: "replace", relevance_policy: { relevant_max: 5 } };
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(config));
    await fs.writeFile(path.join(directory, "stats.json"), JSON.stringify({ calls: 11, completed: 0,
      replaced: 0, timed: 11, elapsedMs: 4000 }));
    const seen = Date.now();
    const health = { version: 1, hook_version: "0.10.5", last_seen_ms: seen, last_skip_ms: seen,
      last_skip: "choice_kept_full_output", skipped: 341 };
    await fs.writeFile(path.join(directory, "logs", "hook-health.json"), JSON.stringify(health));
    const activity = await readPanelActivity(directory);
    assert.equal(activity.calls, 11);
    assert.equal(activity.skipped, 341);
    assert.match(activity.message, /Decision classified.*No line judgments/);
    health.api_requests = 14;
    await fs.writeFile(path.join(directory, "logs", "hook-health.json"), JSON.stringify(health));
    assert.equal((await readPanelActivity(directory)).calls, 14,
      "in-flight and failed API attempts are included independently of completed decisions");
    health.last_skip = "unsupported_route";
    await fs.writeFile(path.join(directory, "logs", "hook-health.json"), JSON.stringify(health));
    assert.match((await readPanelActivity(directory)).message, /before calling Decision/);
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ ...config, enabled: false }));
    assert.match((await readPanelActivity(directory)).message, /off for this thread/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("panel manifest registers a visible view in a valid container", () => {
  const manifest = require("../../vscode-control/package.json");
  const [container] = manifest.contributes.viewsContainers.panel;
  assert.match(container.id, /^[A-Za-z0-9_-]+$/);
  const [view] = manifest.contributes.views[container.id];
  assert.equal(view.id, "codexDecisionDecision");
  assert.equal(view.visibility, "visible");
});

test("panel keeps each decision visible through its animation and a one second rest", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-panel-test-"));
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
  let MIN_DISPLAY_MS;
  try {
    delete require.cache[require.resolve("../../vscode-control/panel")];
    ({ LatestDecisionProvider, MIN_DISPLAY_MS } = require("../../vscode-control/panel"));
  } finally {
    Module._load = originalLoad;
  }
  const oldId = "0".repeat(32);
  const make = (id, status, at) => {
    const rows = [{ line: 1, excerpt: "Build finished", action: "keep",
      reason: "below_omit_cutoff", can_omit: .2, exact_needed: .8, task_relevant: null }];
    return { version: 3, id, receipt_id: "e".repeat(32), at, filter: "output", status,
      batch: { number: 1, count: 1, target_count: 1 }, rows,
      totals: { seen: 1, judged: 1, kept: 1, omitted: 0, protected: 0, unjudged: 0, requests: 1 },
      batch_elapsed_ms: 24 };
  };
  await fs.writeFile(filename, JSON.stringify(make(oldId, "keep", new Date(Date.now() - 10_000).toISOString())));
  let now = Date.now();
  const provider = new LatestDecisionProvider({}, () => directory, () => now);
  assert.equal(MIN_DISPLAY_MS, 2080);
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
    assert.equal(messages.at(-1).decision.id, oldId,
      "the current session's latest decision survives a VS Code reload");
    assert.equal(messages.at(-1).activity.calls, 0,
      "activity remains available alongside a saved decision");
    const health = { version: 1, hook_version: "0.11.2", last_seen_ms: Date.now(),
      skipped: 9, last_skip: "small", last_skip_ms: Date.now() };
    health.last_skip_ms = health.last_seen_ms;
    await fs.writeFile(path.join(logs, "hook-health.json"), JSON.stringify(health));
    await provider.refresh();
    assert.deepEqual(messages.at(-1), { type: "activity", activity: {
      calls: 0, skipped: 9, message: "Decision is off for this thread." } });
    assert.equal(provider.displayedDecision.id, oldId,
      "counters refresh during the animation rest without changing the displayed result");
    now += MIN_DISPLAY_MS;
    const newAt = new Date(now).toISOString();
    await fs.writeFile(filename, JSON.stringify(make("a".repeat(32), "keep", newAt)));
    await provider.refresh();
    assert.equal(messages.at(-1).decision.status, "keep");
    const count = messages.length;
    await provider.refresh();
    assert.equal(messages.length, count);
    await fs.writeFile(filename, JSON.stringify(make("b".repeat(32), "replace", newAt)));
    await provider.refresh();
    assert.equal(messages.at(-1).decision.id, "a".repeat(32));
    await fs.writeFile(filename, JSON.stringify(make("c".repeat(32), "replace", newAt)));
    now += MIN_DISPLAY_MS - 1;
    await provider.refresh();
    assert.equal(messages.at(-1).decision.id, "a".repeat(32));
    now += 1;
    await provider.refresh();
    assert.equal(messages.at(-1).decision.id, "c".repeat(32));
    assert.equal(messages.at(-1).decision.status, "replace");
    view.visible = false;
    onVisibility();
    await fs.writeFile(filename, JSON.stringify(make("d".repeat(32), "keep", newAt)));
    await provider.refresh();
    assert.equal(messages.at(-1).decision.id, "c".repeat(32));
    view.visible = true;
    onVisibility();
    await provider.refresh();
    assert.equal(messages.at(-1).decision.id, "d".repeat(32));
  } finally {
    onDispose?.();
    provider.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("panel is empty without a thread and reports corrupt session data outside the panel", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-panel-test-"));
  const messages = [];
  const faults = [];
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
  } finally { Module._load = originalLoad; }
  let active = null;
  const provider = new LatestDecisionProvider({}, () => active, () => Date.now(),
    (fault) => faults.push(fault));
  provider.view = { visible: true, webview: { postMessage: async (message) => messages.push(message) } };
  try {
    await provider.refresh();
    assert.deepEqual(messages.at(-1), { type: "decision", decision: null });
    assert.equal(faults.at(-1), null);
    active = directory;
    await fs.mkdir(path.join(directory, "logs"));
    await fs.writeFile(path.join(directory, "logs", "latest-decision.json"), "{broken");
    await provider.refresh();
    assert.deepEqual(messages.at(-1), { type: "decision", decision: null });
    assert.equal(faults.at(-1), "Latest Decision decision could not be read");
    await fs.rm(path.join(directory, "logs", "latest-decision.json"));
    await provider.refresh();
    assert.equal(faults.at(-1), null);
  } finally {
    provider.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
