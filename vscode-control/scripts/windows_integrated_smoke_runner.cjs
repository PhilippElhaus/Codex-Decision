"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const vscode = require("vscode");

const root = process.env.DECISION_INTEGRATED_TEST_CONTROL;
const linux = process.env.DECISION_INTEGRATED_TEST_LINUX;
const distro = process.env.DECISION_INTEGRATED_TEST_DISTRO;
const core = require(path.join(root, "core.js"));
const separator = path.win32.sep;
const toWindows = (filename) => separator.repeat(2) + "wsl.localhost" + separator + distro + filename.replaceAll("/", separator);

async function until(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Native integration did not reach ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function fingerprint(files) {
  return Promise.all(files.map(async (filename) => {
    const metadata = await fs.stat(filename);
    return [filename, metadata.size, metadata.mtimeMs, crypto.createHash("sha256").update(await fs.readFile(filename)).digest("hex")];
  }));
}

async function providerBridge(checks) {
  const fragment = await fs.readFile(path.join(root, "patch-assets", "host-bridge.jsfrag"), "utf8");
  let handler;
  let captured;
  const replies = [];
  vm.runInNewContext(`${fragment}{} });`, {
    require(name) {
      if (name === "node:crypto") return require(name);
      assert.equal(name, "vscode");
      return { commands: { executeCommand: async (_command, message) => { captured = message; return {}; } } };
    },
    e: { onDidReceiveMessage(callback) { handler = callback; }, postMessage(reply) { replies.push(reply); } },
    s: { markMessageReceived() {} },
  });
  let id = 0;
  for (const provider of ["openai", "typesafe"]) {
    for (const action of ["testApiKey", "saveApiKey", "settingsTest", "settingsSave", "openProvider"]) {
      // Empty keys avoid test credentials and real connection requests.
      const message = { type: "codex-decision", id: ++id, action, provider, key: "",
        mode: "replace", relevancePolicy: { relevant_max: 5 }, logLimitMb: 50, neverDeleteLogs: false };
      handler(message);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(replies.at(-1).id, id);
      assert.equal(captured.provider, provider);
      assert.equal(captured.action, action);
    }
  }
  checks.push("packaged host bridge retains OpenAI and TypeSafe across all provider actions");
}

async function actualPanel(dataDirectory, checks) {
  const session = "integrated-native-thread";
  const selected = core.sessionDirectory(dataDirectory, session);
  const initial = await vscode.commands.executeCommand("codexDecision.bridge", {
    action: "status", viewId: "native-integrated-view", sourceId: "native-integrated-source",
    sessionId: session, visible: true, focused: true, expectsLocalSession: true,
  });
  assert.equal(initial.enabled, true);
  assert.equal(initial.provider, "openai");
  assert.equal(initial.needsKey, true);
  assert.equal((await core.readConfig(selected)).schema_version, 5);
  assert.equal((await core.readConfig(selected)).enabled, true);
  for (const chosen of ["typesafe", "openai"]) {
    const reply = await vscode.commands.executeCommand("codexDecision.bridge", {
      action: "settingsSave", viewId: "native-integrated-view", sessionId: session,
      provider: chosen, key: "", mode: "replace", relevancePolicy: { relevant_max: 5 },
      logLimitMb: 50, neverDeleteLogs: false,
    });
    assert.equal(reply.settings.action, "saved");
    assert.equal(reply.provider, chosen);
    assert.equal((await core.readGlobalSettings(dataDirectory)).provider, chosen);
    assert.equal((await core.readGlobalSettings(dataDirectory)).model, chosen === "openai" ? "gpt-6-luna" : "jev-latest");
  }
  checks.push("native settings bridge saves and restores each provider with the matching model and no keys");
  const logs = path.join(selected, "logs");
  await fs.mkdir(logs, { recursive: true });
  const id = "a".repeat(32);
  await fs.writeFile(path.join(logs, "latest-decision.json"), JSON.stringify({
    version: 4, id, receipt_id: "b".repeat(32), at: "2020-01-01T00:00:00Z",
    filter: "output", status: "keep", batch: { number: 1, count: 1, target_count: 2 }, batch_elapsed_ms: 20,
    rows: [{ line: 1, excerpt: "Synthetic routine line", action: "omit", reason: "irrelevant", task_relevant: .01 },
      { line: 2, excerpt: "Synthetic diagnostic line", action: "keep", reason: "task_relevant", task_relevant: .99 }],
    totals: { seen: 2, judged: 2, kept: 1, omitted: 1, protected: 0, unjudged: 0, requests: 2 },
  }));
  await fs.writeFile(path.join(logs, "hook-health.json"), JSON.stringify({
    version: 1, hook_version: require(path.join(root, "package.json")).codexDecisionHookVersion,
    last_seen_ms: Date.now(), counter_scheme: 1, partial_counters: [], seen: 350, api_requests: 9,
    skipped: 341, errors: 0, responses_received: 8, responses_validated: 8,
    request_cancelled: 0, request_failures: 1, skip_reasons_partial: false, skip_details_partial: false,
  }));
  await vscode.commands.executeCommand("codexDecision.showLatestDecision");
  await until(() => globalThis.__decisionIntegratedPanel?.view && !globalThis.__decisionIntegratedPanel.awaitingReady, "panel readiness");
  const provider = globalThis.__decisionIntegratedPanel;
  let rendered;
  const subscription = provider.view.webview.onDidReceiveMessage((message) => {
    if (message?.type === "decision-integrated-rendered") rendered = message;
  });
  try {
    await provider.pending;
    provider.lastMessage = "";
    provider.nextDecisionAt = 0;
    await provider.refresh();
    await until(() => rendered?.id === id, "actual synthetic decision render");
    assert.equal(rendered.rows, 2);
    assert.equal(rendered.layout, "grid", "packaged CSS loads under the real CSP");
    assert.equal(rendered.title, "0 / 2 removed");
    assert.match(rendered.activity, /9 API requests.*341 skipped outputs/);
    checks.push("fresh local session defaults and saved counters reach the actual native panel renderer");
    const generation = provider.generation;
    rendered = null;
    provider.view.webview.html += "<!-- integrated native reload -->";
    await until(() => provider.generation > generation && !provider.awaitingReady, "panel reload");
    await until(() => rendered?.id === id, "restored native panel decision");
    assert.equal(rendered.rows, 2);
    assert.match(rendered.activity, /9 API requests.*341 skipped outputs/);
    checks.push("actual webview reload restores the packaged panel and durable session counts");
  } finally {
    subscription.dispose();
  }
}

exports.run = async () => {
  const result = { ok: false, runId: process.env.DECISION_INTEGRATED_TEST_RUN,
    phase: process.env.DECISION_INTEGRATED_TEST_PHASE, checks: [] };
    const checkpoint = () => fs.writeFile(process.env.DECISION_INTEGRATED_TEST_REPORT, JSON.stringify(result, null, 2) + "\n");
  try {
        await checkpoint();
    const extension = vscode.extensions.getExtension("elhaus-labs.codex-decision-control");
    assert(extension, "combined VSIX extension is discoverable");
    await extension.activate();
    await until(() => globalThis.__decisionIntegratedInstallation, "startup installer");
    const installation = await globalThis.__decisionIntegratedInstallation;
    assert.equal(installation.status, result.phase === "first" ? "installed" : "ready");
    assert.equal(installation.version, extension.packageJSON.codexDecisionHookVersion);
    assert(installation.pluginRoot.startsWith(`${linux}/codex/plugins/cache/`));
    assert(installation.linuxDataDirectory.startsWith(`${linux}/codex/plugins/data/`));
    assert.equal(installation.pluginId, "codex-decision@codex-decision-integrated");
    result.controlVersion = extension.packageJSON.version;
    result.hookVersion = installation.version;
    const host = vscode.extensions.getExtension("openai.chatgpt");
    assert(host, "isolated native Codex extension is discoverable");
    result.codexVersion = host.packageJSON.version;
    const listed = JSON.parse((await installation.execute(
      path.posix.join((await installation.convert(host.extensionPath)), "bin/linux-x86_64/codex"),
      ["plugin", "list", "--json"], { timeout: 30_000, maxBuffer: 2_000_000 })).stdout);
    const plugins = listed.installed.filter((item) => item.name === "codex-decision");
    assert.equal(plugins.length, 1, "exactly one hook registration");
    assert.equal(plugins[0].enabled, true);
    assert.equal(plugins[0].version, installation.version);
    for (const filename of [".codex-plugin/plugin.json", "hooks/hooks.json", "hooks/bin/linux-x86_64/decision-hook",
      "hooks/bin/linux-x86_64/decisionctl", "skills/decision-output/SKILL.md", "assets/logo.png", "assets/icon.png", "LICENSE", "config.example.json"]) {
      assert.deepEqual(await fs.readFile(path.join(toWindows(installation.pluginRoot), filename)),
        await fs.readFile(path.join(root, "plugin", filename)), `cache exactness: ${filename}`);
    }
    result.checks.push("native activation installs the exact bundled hook, discovers its data directory, and creates one enabled registration");
        await checkpoint();
    await until(() => globalThis.__decisionIntegratedIntegration, "startup repair service");
    const backupManifest = path.join(process.env.LOCALAPPDATA, "Codex", "codex-decision", "rollback", host.packageJSON.version, "manifest.json");
    await until(() => fsSync.existsSync(backupManifest), "automatic startup patch", 60_000);
    const firstRepair = await globalThis.__decisionIntegratedIntegration.inspect(true, false);
    assert.equal(firstRepair.status, "ready", firstRepair.message);
    result.checks.push("automatic startup repair verifies the isolated supported Codex host");
        await checkpoint();
    const watched = [path.join(host.extensionPath, "out", "extension.js"), path.join(host.extensionPath, "webview", "index.html"),
      backupManifest,
      path.join(toWindows(installation.pluginRoot), "hooks/bin/linux-x86_64/decisionctl")];
    const before = await fingerprint(watched);
    const repeated = await require(path.join(root, "integrated-install.js")).ensureIntegratedInstall(vscode,
      { extensionPath: root, extensionUri: vscode.Uri.file(root) },
      { dataDirectory: vscode.workspace.getConfiguration("codexDecision").get("dataDirectory") });
    assert.equal(repeated.status, "ready");
    const repeatedRepair = await globalThis.__decisionIntegratedIntegration.inspect(true, false);
    assert.equal(repeatedRepair.status, "ready");
    assert.equal(repeatedRepair.changed, false);
    assert.deepEqual(await fingerprint(watched), before, "healthy repair performs zero host, rollback, or payload writes");
    result.checks.push("repeated activation checks are idempotent and preserve host, rollback, and bundled binary bytes and timestamps");
        await checkpoint();
    await assert.rejects(fs.access(path.join(installation.dataDirectory, ".env")), { code: "ENOENT" });
    await actualPanel(installation.dataDirectory, result.checks);
    await providerBridge(result.checks);
    result.ok = true;
  } catch (error) {
    result.error = error.message;
    throw error;
  } finally {
        await checkpoint();
  }
};
