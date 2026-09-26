"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("../core");

async function until(predicate, timeoutMs = 1500) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for UI state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("status control selects the hook and reflects health, activity, tooltip, and off state", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  const commands = new Map();
  let button, picker, health = { ok: true, model: "jev-1.13.0" };
  const fake = {
    StatusBarAlignment: { Left: 1 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    window: {
      createStatusBarItem: () => button = { show() {}, dispose() {} },
      createQuickPick: () => picker = {
        onDidAccept(callback) { this.accept = callback; },
        onDidHide(callback) { this.onHide = callback; },
        hide() { this.onHide?.(); }, show() {}, dispose() {},
      },
      showErrorMessage: () => {}, showInformationMessage: () => {},
    },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    workspace: {
      getConfiguration: () => ({ get: (key) => key === "dataDirectory" ? directory : "/lan" }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
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
    await until(() => button.tooltip?.includes("Off · no hooks selected"));
    assert.equal(button.color.id, "disabledForeground");

    commands.get("jevPilot.selectHooks")();
    picker.selectedItems = [picker.items[0]];
    await picker.accept();
    assert.equal((await core.readConfig(directory)).enabled, true);
    await until(() => button.color.id === "charts.blue");
    await until(() => button.color.id === "testing.iconPassed");
    assert.match(button.tooltip, /Connected · jev-1.13.0/);

    await fs.writeFile(path.join(directory, "events.jsonl"), JSON.stringify({
      status: "calling", reason: "jev_request", tool: "Bash", original_chars: 0, elapsed_ms: 0,
    }) + "\n" + JSON.stringify({
      status: "replace", reason: "jev_replace", tool: "Bash", original_chars: 11520, elapsed_ms: 480,
    }) + "\n");
    await until(() => button.tooltip.includes("replaced · Bash"));
    assert.equal(button.color.id, "charts.blue");
    await until(() => button.color.id === "testing.iconPassed");
    assert.match(button.tooltip, /1 calls · 0 candidates · 0 kept · 1 replaced/);

    await fs.appendFile(path.join(directory, "events.jsonl"), JSON.stringify({
      status: "skip", reason: "small", tool: "Bash", original_chars: 42, elapsed_ms: 0,
    }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.match(button.tooltip, /replaced · Bash/);
    assert.equal(button.color.id, "testing.iconPassed");

    const later = [
      ["candidate", "observe", "Bash", 11000, 1000],
      ["keep", "jev_keep", "mcp__demo__logs", 14000, 1200],
      ["candidate", "observe", "Bash", 13000, 900],
    ];
    await fs.appendFile(path.join(directory, "events.jsonl"), later.map(([status, reason, tool, original_chars, elapsed_ms]) =>
      JSON.stringify({ status: "calling", reason: "jev_request", tool }) + "\n" +
      JSON.stringify({ status, reason, tool, original_chars, elapsed_ms }) + "\n").join(""));
    await until(() => button.tooltip.includes("4 calls · 2 candidates · 1 kept · 1 replaced"));
    const session = await commands.get("jevPilot.bridge")({ action: "status" });
    assert.equal(session.stats.checkedChars, 49520);
    assert.equal(session.history.length, 3);
    assert.match(session.history[0], /candidate \(observe\) · Bash · 13[,.]000 chars/);
    assert.match(session.history[1], /kept · mcp__demo__logs/);
    assert.doesNotMatch(session.history.join(" "), /replaced/);

    health = { ok: false, reason: "JEV_HTTP_ERROR" };
    await commands.get("jevPilot.checkConnection")();
    await until(() => button.color.id === "testing.iconFailed");
    assert.match(button.tooltip, /Unavailable · JEV_HTTP_ERROR/);

    commands.get("jevPilot.selectHooks")();
    picker.selectedItems = [];
    await picker.accept();
    await until(() => button.color.id === "disabledForeground");
    assert.equal((await core.readConfig(directory)).enabled, false);

    health = { ok: true, model: "jev-1.13.0" };
    commands.get("jevPilot.selectHooks")();
    picker.selectedItems = [picker.items[0]];
    await picker.accept();
    await until(() => button.tooltip.includes("candidate \(observe\) · Bash"));
  } finally {
    for (const disposable of context.subscriptions.reverse()) disposable.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
