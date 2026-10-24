"use strict";

// Runs with native Node only. It never starts VS Code or reads a user profile.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const [taskRoot, control, host, codex, report] = process.argv.slice(2);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

async function fingerprint(filenames) {
  return Promise.all(filenames.map(async filename => {
    const stat = await fs.stat(filename);
    return [filename, stat.size, stat.mtimeMs, digest(await fs.readFile(filename))];
  }));
}

async function hook(installation, command, shell, session) {
  const event = JSON.stringify({ hook_event_name: "PostToolUse", session_id: session,
    tool_name: "exec_command", tool_use_id: "background-fixture", tool_input: { cmd: "printf routine" },
    tool_response: "Synthetic routine output" });
  return new Promise((resolve, reject) => {
    const child = execFile(shell, ["-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...process.env, PLUGIN_ROOT: installation.pluginRoot, PLUGIN_DATA: installation.dataDirectory },
      timeout: 30_000, maxBuffer: 8192, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Packaged hook failed under ${path.basename(shell)} (${error.code})`));
      else resolve({ stdout, stderr });
    });
    child.stdin.end(event);
  });
}

async function main() {
  assert.equal(process.platform, "win32");
  for (const filename of [taskRoot, control, host, codex, report]) assert(path.isAbsolute(filename));
  const result = { ok: false, packageSha256: process.env.DECISION_BACKGROUND_PACKAGE_SHA256,
    runId: process.env.DECISION_BACKGROUND_RUN_ID, checks: [] };
  const checkpoint = () => fs.writeFile(report, JSON.stringify(result, null, 2) + "\n");
  try {
    const { install, FILES } = require(path.join(control, "install-plugin-native.js"));
    const core = require(path.join(control, "core.js"));
    const payload = path.join(control, "plugin");
    const options = { payload, codex, home: path.join(taskRoot, "home"), codexHome: process.env.CODEX_HOME };
    const first = await install(options);
    assert.equal(first.status, "installed");
    const version = JSON.parse(await fs.readFile(path.join(control, "package.json"))).version;
    assert.equal(first.version, version);
    for (const filename of FILES) assert.deepEqual(await fs.readFile(path.join(first.pluginRoot, filename)),
      await fs.readFile(path.join(payload, filename)), `cache exactness: ${filename}`);
    const watched = FILES.map(filename => path.join(first.pluginRoot, filename));
    const before = await fingerprint(watched);
    assert.equal((await install(options)).status, "ready");
    const concurrent = await Promise.all([install(options), install(options)]);
    assert(concurrent.every(item => item.status === "ready"));
    assert.deepEqual(await fingerprint(watched), before);
    const listed = JSON.parse((await run(codex, ["plugin", "list", "--json"],
      { timeout: 30_000, maxBuffer: 2_000_000, windowsHide: true })).stdout);
    const registrations = listed.installed.filter(item => item.name === "codex-decision");
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].enabled, true);
    assert.equal(registrations[0].version, version);
    result.checks.push("actual native Codex installs the exact packaged payload once; restart and concurrent checks preserve every cached byte and timestamp");
    await assert.rejects(fs.access(path.join(first.dataDirectory, ".env")), { code: "ENOENT" });

    const session = "background-native-thread";
    const selected = core.sessionDirectory(first.dataDirectory, session);
    assert.equal((await core.ensureSessionDefaults(selected)).enabled, true);
    await core.writeSelection(selected, false);
    const manifest = JSON.parse(await fs.readFile(path.join(first.pluginRoot, "hooks/hooks.json")));
    const command = manifest.hooks.PostToolUse[0].hooks[0].commandWindows;
    assert.equal(typeof command, "string");
    const shells = ["pwsh.exe", path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe")];
    for (const shell of shells) {
      const reply = await hook(first, command, shell, session);
      assert.equal(reply.stderr, "");
      assert.deepEqual(JSON.parse(reply.stdout), {});
    }
    await assert.rejects(fs.access(path.join(selected, "logs")), { code: "ENOENT" });
    await core.writeSelection(selected, true);
    const reply = await hook(first, command, shells[0], session);
    assert.equal(reply.stderr, "");
    assert.deepEqual(JSON.parse(reply.stdout), {});
    const health = await core.readHookHealth(selected);
    assert.equal(health.seen, 1);
    assert.equal(health.skipped, 1);
    assert.equal(health.api_requests, 0);
    assert.equal(health.errors, 0);
    result.checks.push("packaged hook receives stdin under PowerShell 7 and its 5.1 fallback; enabled short-output handling writes private health with no API request");

    const logs = path.join(selected, "logs");
    await fs.writeFile(path.join(logs, "latest-decision.json"), JSON.stringify({ version: 4,
      id: "a".repeat(32), receipt_id: "b".repeat(32), at: "2020-01-01T00:00:00Z", filter: "output", status: "keep",
      batch: { number: 1, count: 1, target_count: 2 }, batch_elapsed_ms: 20,
      rows: [{ line: 1, excerpt: "Synthetic routine line", action: "omit", reason: "irrelevant", task_relevant: .01 },
        { line: 2, excerpt: "Synthetic diagnostic line", action: "keep", reason: "task_relevant", task_relevant: .99 }],
      totals: { seen: 2, judged: 2, kept: 1, omitted: 1, protected: 0, unjudged: 0, requests: 2 } }));
    const panel = require(path.join(control, "panel-state.js"));
    assert.equal((await panel.readLatestPanelDecision(selected)).rows.length, 2);
    assert.equal((await panel.readPanelActivity(selected)).skipped, 1);
    result.checks.push("packaged panel readers load native snapshots and hook activity without a desktop window");

    const hostManifest = JSON.parse(await fs.readFile(path.join(host, "package.json")));
    result.codexVersion = hostManifest.version;
    result.version = version;
    const assets = ["out/extension.js", "webview/index.html", "webview/assets/use-plugins-74ac3ed173d4.js",
      "webview/assets/chunk-KS7C4IRE-c36c021bd659.js"];
    const hostFiles = assets.map(filename => path.join(host, filename));
    const original = await fingerprint(hostFiles);
    const rollbackParent = path.join(process.env.LOCALAPPDATA, "Codex/codex-decision/rollback");
    await fs.mkdir(rollbackParent, { recursive: true });
    const backup = path.join(rollbackParent, hostManifest.version);
    const patch = async action => run(first.decisionctl,
      ["patch-webview", action, "--root", control, "--extension", host, "--backup", backup],
      { timeout: 30_000, maxBuffer: 8192, windowsHide: true });
    assert.equal(JSON.parse((await patch("status")).stdout).status, "unpatched");
    await patch("apply");
    assert.equal(JSON.parse((await patch("status")).stdout).status, "ready");
    const patched = await fingerprint([...hostFiles, path.join(backup, "manifest.json")]);
    const { runIntegration } = require(path.join(control, "integration.js"));
    const inspected = await runIntegration({ host: { extensionPath: host, packageJSON: hostManifest },
      controlRoot: control, dataDirectory: first.dataDirectory, backend: "native",
      localAppData: process.env.LOCALAPPDATA, repair: true });
    assert.equal(inspected.status, "ready");
    assert.equal(inspected.changed, false);
    assert.deepEqual(await fingerprint([...hostFiles, path.join(backup, "manifest.json")]), patched);
    await patch("restore");
    assert.equal(JSON.parse((await patch("status")).stdout).status, "unpatched");
    const restored = await fingerprint(hostFiles);
    assert.deepEqual(restored.map(item => [item[0], item[1], item[3]]), original.map(item => [item[0], item[1], item[3]]));
    for (const filename of ["decision-control.js", "decision-settings.js", "decision-icon.png"]) {
      await assert.rejects(fs.access(path.join(host, "webview/assets", filename)), { code: "ENOENT" });
    }
    result.checks.push("native checker verifies four real pinned Codex assets, applies the patch, leaves a ready patch unchanged, and restores exact original hashes");
    result.ok = true;
  } catch (error) {
    result.error = String(error.message).replace(/[\r\n\t]/g, " ").slice(0, 1200);
    process.exitCode = 1;
  } finally { await checkpoint(); }
}

main().catch(() => { process.exitCode = 1; });
