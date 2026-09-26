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
  let button, picker, configListener, mode = "replace", health = { ok: true, model: "jev-1.13.0" };
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
      getConfiguration: () => ({ get: (key) => key === "dataDirectory" ? directory : key === "mode" ? mode : "/lan" }),
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
    await until(() => button.tooltip?.includes("Off · no integrations selected"));
    assert.equal(button.color.id, "disabledForeground");
    await fs.writeFile(path.join(directory, "events.jsonl"), JSON.stringify({
      status: "keep", reason: "jev_keep", tool: "Bash", original_chars: 13006, elapsed_ms: 1139,
    }) + "\n");

    commands.get("codexJev.selectHooks")();
    assert.deepEqual(picker.items.map((item) => item.label), ["Output filter", "Test/build logs", "Search/listing"]);
    picker.selectedItems = [picker.items[0]];
    await picker.accept();
    assert.equal((await core.readConfig(directory)).enabled, true);
    assert.equal((await core.readConfig(directory)).mode, "replace");
    await until(() => button.color.id === "charts.blue");
    await until(() => button.color.id === "testing.iconPassed");
    assert.match(button.tooltip, /Connected · jev-1.13.0/);
    assert.match(button.tooltip, /0 checked · 0 replaced · — avg/);
    assert.match(button.tooltip, /Recent Jev outcomes:\nNone yet/);
    assert.doesNotMatch(button.tooltip, /13[,.]006 chars/);

    mode = "observe";
    configListener({ affectsConfiguration: (key) => key === "codexJev" });
    await until(() => button.text.includes("OBS"));
    assert.equal((await core.readConfig(directory)).mode, "observe");
    assert.match(button.tooltip, /observe mode/);
    mode = "replace";
    configListener({ affectsConfiguration: (key) => key === "codexJev" });
    await until(() => !button.text.includes("OBS") && button.tooltip.includes("replace mode"));
    assert.equal((await core.readConfig(directory)).mode, "replace");
    await new Promise((resolve) => setTimeout(resolve, 300)); // Let the event reader establish its new offset.

    await fs.appendFile(path.join(directory, "events.jsonl"), JSON.stringify({
      status: "calling", reason: "jev_request", tool: "Bash", original_chars: 0, elapsed_ms: 0,
    }) + "\n" + JSON.stringify({
      status: "replace", reason: "jev_replace", tool: "Bash", original_chars: 11520, capsule_chars: 912, elapsed_ms: 480,
    }) + "\n");
    await until(() => button.tooltip.includes("replaced · Bash"));
    assert.equal(button.color.id, "charts.blue");
    await until(() => button.color.id === "testing.iconPassed");
    assert.match(button.tooltip, /1 checked · 1 replaced · 480 ms avg/);
    assert.match(button.tooltip, /92%/);

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
    await until(() => button.tooltip.includes("4 checked · 1 replaced · 895 ms avg"));
    const session = await commands.get("codexJev.bridge")({ action: "status" });
    assert.equal(session.stats.checkedChars, 49520);
    assert.equal(session.history.length, 3);
    assert.match(session.history[0], /candidate \(observe\) · Bash · 13[,.]000 chars/);
    assert.match(session.history[1], /kept · mcp__demo__logs/);
    assert.doesNotMatch(session.history.join(" "), /replaced/);

    // A selection change during this view must not skip the next completed hook result.
    await commands.get("codexJev.bridge")({ action: "setSelection", feature: "test_build", enabled: true });
    await fs.appendFile(path.join(directory, "events.jsonl"), JSON.stringify({
      status: "calling", reason: "jev_request", filter: "test_build", tool: "Bash",
    }) + "\n" + JSON.stringify({
      status: "replace", reason: "test_build_replace", filter: "test_build", tool: "Bash",
      original_chars: 6000, capsule_chars: 300, elapsed_ms: 500,
    }) + "\n");
    await until(() => button.tooltip.includes("5 checked · 2 replaced"));

    // Rapid independent button toggles must compose against the latest saved config.
    await Promise.all([
      commands.get("codexJev.bridge")({ action: "setSelection", feature: "output", enabled: false }),
      commands.get("codexJev.bridge")({ action: "setSelection", feature: "test_build", enabled: false }),
    ]);
    assert.equal((await core.readConfig(directory)).enabled, false);
    assert.equal((await core.readConfig(directory)).test_build_enabled, false);
    assert.match(button.tooltip, /5 checked · 2 replaced/);
    const searchOnly = await commands.get("codexJev.bridge")({ action: "setSelection", feature: "search_listing", enabled: true });
    assert.equal(searchOnly.searchListingEnabled, true);
    assert.equal(searchOnly.outputEnabled, false);
    assert.equal(searchOnly.testBuildEnabled, false);
    assert.match(button.tooltip, /Jev search\/listing/);
    await fs.appendFile(path.join(directory, "events.jsonl"), JSON.stringify({
      status: "calling", reason: "jev_request", filter: "search_listing", tool: "Bash", original_chars: 4318,
    }) + "\n" + JSON.stringify({
      status: "replace", reason: "search_listing_replace", filter: "search_listing", tool: "Bash",
      original_chars: 4318, capsule_chars: 1284, elapsed_ms: 1263,
    }) + "\n");
    await until(() => button.tooltip.includes("replaced · search/listing · 4,318 chars · 1,2s · 70%"));
    const searchStatus = await commands.get("codexJev.bridge")({ action: "status" });
    assert.equal(searchStatus.stats.completed, 6);
    assert.equal(searchStatus.stats.replaced, 3);
    await commands.get("codexJev.bridge")({ action: "setSelection", feature: "output", enabled: true });
    assert.equal((await core.readConfig(directory)).search_listing_enabled, true);
    await commands.get("codexJev.bridge")({ action: "setSelection", feature: "search_listing", enabled: false });
    assert.equal((await core.readConfig(directory)).search_listing_enabled, false);
    assert.match(button.tooltip, /6 checked · 3 replaced/);

    const newView = await commands.get("codexJev.bridge")({ action: "status", viewId: "view-new-thread" });
    assert.equal(newView.stats.calls, 0);
    assert.deepEqual(newView.history, []);
    assert.match(button.tooltip, /Recent Jev outcomes:\nNone yet/);
    await fs.appendFile(path.join(directory, "events.jsonl"), JSON.stringify({
      status: "calling", reason: "jev_request", tool: "Bash",
    }) + "\n" + JSON.stringify({
      status: "replace", reason: "jev_replace", tool: "Bash", original_chars: 12100, elapsed_ms: 850,
    }) + "\n");
    await until(() => button.tooltip.includes("1 checked · 1 replaced · 850 ms avg"));
    const reopened = await commands.get("codexJev.bridge")({ action: "status", viewId: "view-old-thread-reopened" });
    assert.equal(reopened.stats.calls, 0);
    assert.deepEqual(reopened.history, []);

    health = { ok: false, reason: "JEV_HTTP_ERROR" };
    await commands.get("codexJev.checkConnection")();
    await until(() => button.color.id === "testing.iconFailed");
    assert.match(button.tooltip, /Unavailable · JEV_HTTP_ERROR/);

    commands.get("codexJev.selectHooks")();
    picker.selectedItems = [];
    await picker.accept();
    await until(() => button.color.id === "disabledForeground");
    assert.equal((await core.readConfig(directory)).enabled, false);

    commands.get("codexJev.selectHooks")();
    picker.selectedItems = [picker.items[1]];
    health = { ok: true, model: "jev-1.13.0" };
    await picker.accept();
    await until(() => button.tooltip.includes("Connected · jev-1.13.0"));
    await until(() => button.color.id === "testing.iconPassed");
    assert.equal((await core.readConfig(directory)).test_build_enabled, true);
    const local = await commands.get("codexJev.bridge")({ action: "status" });
    assert.equal(local.outputEnabled, false);
    assert.equal(local.testBuildEnabled, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fs.appendFile(path.join(directory, "events.jsonl"), JSON.stringify({
      status: "replace", reason: "test_build_replace", filter: "test_build", tool: "Bash",
      original_chars: 5000, capsule_chars: 300, elapsed_ms: 4,
    }) + "\n");
    await until(() => button.tooltip.includes("replaced · test/build · 5,000 chars"));
    assert.match(button.tooltip, /1 checked · 1 replaced · 4 ms avg/);
    assert.match(button.tooltip, /94%/);
    await commands.get("codexJev.bridge")({ action: "setSelection", feature: "output", enabled: true });
    assert.equal((await core.readConfig(directory)).test_build_enabled, true);
    assert.equal((await core.readConfig(directory)).enabled, true);
    await commands.get("codexJev.bridge")({ action: "setSelection", feature: "test_build", enabled: false });
    assert.equal((await core.readConfig(directory)).test_build_enabled, false);
    commands.get("codexJev.selectHooks")();
    picker.selectedItems = [picker.items[2]];
    await picker.accept();
    assert.equal((await core.readConfig(directory)).search_listing_enabled, true);
    assert.equal((await core.readConfig(directory)).enabled, false);
    assert.equal((await core.readConfig(directory)).test_build_enabled, false);

    health = { ok: true, model: "jev-1.13.0" };
    commands.get("codexJev.selectHooks")();
    picker.selectedItems = [];
    await picker.accept();
    await until(() => button.color.id === "disabledForeground");
    commands.get("codexJev.selectHooks")();
    picker.selectedItems = [picker.items[0]];
    await picker.accept();
    await until(() => button.tooltip.includes("replaced · test\/build") || button.tooltip.includes("replaced · Bash"));
  } finally {
    for (const disposable of context.subscriptions.reverse()) disposable.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
