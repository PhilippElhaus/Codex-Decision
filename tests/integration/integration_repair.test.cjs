"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { runIntegration, activateIntegration, failureMessage } = require("../../vscode-control/integration");

function fixture(states = ["unpatched", "ready"]) {
  const controlRoot = "C:\\Users\\Fixture User\\.vscode\\extensions\\decision-$(`quoted`)";
  const localAppData = "C:\\Users\\Fixture User\\AppData\\Local";
  const host = { packageJSON: { version: "26.1007.21434" },
    extensionPath: "C:\\Users\\Fixture User\\.vscode\\extensions\\openai.chatgpt-26.1007.21434" };
  const binary = path.win32.join(controlRoot, "plugin", "hooks", "bin", "linux-x86_64", "decisionctl");
  const backup = path.win32.join(localAppData, "Codex", "codex-decision", "rollback", host.packageJSON.version);
  const calls = [];
  const created = [];
  const links = new Set();
  const missing = new Set([backup]);
  const io = {
    async lstat(filename) {
      if (missing.has(filename)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isDirectory: () => filename !== binary, isFile: () => filename === binary,
        isSymbolicLink: () => links.has(filename) };
    },
    async mkdir(filename) { created.push(filename); missing.delete(filename); },
  };
  const options = { host, controlRoot, localAppData, platform: "win32", io,
    dataDirectory: "\\\\wsl.localhost\\Ubuntu\\home\\fixture\\.codex\\plugins\\data\\decision",
    async run(command, args, limits) {
      calls.push({ command, args, limits });
      assert.equal(command, "wsl.exe");
      assert.deepEqual(args.slice(0, 3), ["-d", "Ubuntu", "-e"]);
      if (args[3] === "wslpath") {
        assert.equal(args[4], "-u");
        return { stdout: `/mnt/${args[5][0].toLowerCase()}${args[5].slice(2).replaceAll("\\", "/")}\n` };
      }
      const next = states.shift();
      if (next instanceof Error) throw next;
      if (args[5] !== "status") return { stdout: `${args[5]} ready\n` };
      return { stdout: JSON.stringify({ status: next, version: host.packageJSON.version }) };
    } };
  return { options, calls, created, links, missing, backup,
    actions: () => calls.filter((call) => call.args[4] === "patch-webview").map((call) => call.args[5]) };
}

test("first integration installation applies only after pinned status and verifies the final host", async () => {
  const setup = fixture(["unpatched", "applied", "ready"]);
  const rollbackParent = path.win32.dirname(setup.backup);
  setup.missing.add(rollbackParent);
  const result = await runIntegration(setup.options);
  assert.deepEqual(result, { status: "ready", version: "26.1007.21434", changed: true, action: "apply" });
  assert.deepEqual(setup.actions(), ["status", "apply", "status"]);
  assert.deepEqual(setup.created, [rollbackParent], "the patcher owns the version backup directory");
  const invocation = setup.calls.find((call) => call.args[5] === "apply");
  assert.equal(invocation.args[7], "/mnt/c/Users/Fixture User/.vscode/extensions/decision-$(`quoted`)");
  assert.ok(invocation.args[3].endsWith("/plugin/hooks/bin/linux-x86_64/decisionctl"));
  assert.equal(invocation.limits.windowsHide, true);
});

test("managed outdated controls update while healthy controls and diagnostics do no patch writes", async () => {
  const outdated = fixture(["outdated", "updated", "ready"]);
  assert.equal((await runIntegration(outdated.options)).action, "update");
  assert.deepEqual(outdated.actions(), ["status", "update", "status"]);
  const ready = fixture(["ready"]);
  assert.equal((await runIntegration(ready.options)).changed, false);
  assert.deepEqual(ready.actions(), ["status"]);
  const diagnostic = fixture(["unpatched"]);
  assert.equal((await runIntegration({ ...diagnostic.options, repair: false })).status, "unpatched");
  assert.deepEqual(diagnostic.actions(), ["status"]);
});

test("unknown versions, changed hosts, and malformed checker output cannot trigger a mutation", async () => {
  for (const error of ["unsupported Codex extension version; revalidate the composer patch",
    "patched file changed: out/extension.js"]) {
    const setup = fixture([Object.assign(new Error("checker failed"), { stderr: error })]);
    await assert.rejects(runIntegration(setup.options), /checker failed/);
    assert.deepEqual(setup.actions(), ["status"]);
  }
  for (const stdout of ["garbage", "{}", '{"status":"ready","version":"another-version"}']) {
    const setup = fixture();
    const originalRun = setup.options.run;
    setup.options.run = async (...args) => args[1][5] === "status" ? { stdout } : originalRun(...args);
    await assert.rejects(runIntegration(setup.options), /invalid status/);
    assert.deepEqual(setup.actions(), []);
  }
  const incomplete = fixture(["unpatched", "applied", "outdated"]);
  await assert.rejects(runIntegration(incomplete.options), /did not pass verification/);
});

test("integration rejects drive D and linked patch or rollback ancestors", async () => {
  for (const changes of [{ controlRoot: "D:\\Tools\\Decision" }, { localAppData: "D:\\Users\\Fixture" },
    { host: { packageJSON: { version: "26.1007.21434" }, extensionPath: "D:\\extensions\\Codex" } }]) {
    const setup = fixture();
    await assert.rejects(runIntegration({ ...setup.options, ...changes }), /outside D:/);
    assert.deepEqual(setup.created, []);
    assert.deepEqual(setup.calls, []);
  }
  const setup = fixture();
  setup.links.add(path.win32.join(setup.options.localAppData, "Codex"));
  await assert.rejects(runIntegration(setup.options), /linked or invalid directory/);
  assert.deepEqual(setup.calls, []);
});

test("concurrent windows retry busy checks and accept only a verified completed patch", async () => {
  const busy = Object.assign(new Error("busy"), { stderr: "Decision patch is busy; retry later" });
  const setup = fixture([busy, "ready"]);
  assert.equal((await runIntegration(setup.options)).changed, false);
  assert.deepEqual(setup.actions(), ["status", "status"]);
  const concurrent = fixture(["unpatched",
    Object.assign(new Error("concurrent apply"), { stderr: "Codex asset already exists: webview/assets/decision-control.js" }), "ready"]);
  assert.equal((await runIntegration(concurrent.options)).status, "ready");
  assert.deepEqual(concurrent.actions(), ["status", "apply", "status"]);
  const foreign = fixture(["unpatched",
    Object.assign(new Error("concurrent apply"), { stderr: "Codex asset already exists: webview/assets/decision-control.js" }),
    Object.assign(new Error("changed host"), { stderr: "patched file changed: out/extension.js" })]);
  await assert.rejects(runIntegration(foreign.options), /changed host/);
});

function extensionFixture(setup, bootstrap) {
  const commands = new Map();
  const notifications = [];
  const log = [];
  const executed = [];
  const listeners = {};
  const settings = { autoRepairIntegration: true };
  const context = { extensionUri: { fsPath: setup.options.controlRoot }, subscriptions: [] };
  const vscode = {
    window: {
      createOutputChannel: () => ({ appendLine: (line) => log.push(line), show: () => {}, dispose() {} }),
      showInformationMessage: async (...args) => { notifications.push(args); },
      showWarningMessage: async (...args) => { notifications.push(args); },
    },
    commands: {
      registerCommand: (name, action) => { commands.set(name, action); return { dispose() {} }; },
      executeCommand: async (name) => { executed.push(name); },
    },
    extensions: { getExtension: () => setup.options.host,
      onDidChange: (listener) => { listeners.extensions = listener; return { dispose() {} }; } },
    workspace: {
      getConfiguration: () => ({ get: (name, fallback) => settings[name] ?? fallback }),
      onDidChangeConfiguration: (listener) => { listeners.config = listener; return { dispose() {} }; },
    },
  };
  const integration = activateIntegration(vscode, context, { ...setup.options, ready: bootstrap,
    dataDirectory: () => setup.options.dataDirectory });
  return { integration, commands, notifications, log, executed, listeners, settings, vscode,
    dispose() { for (const entry of context.subscriptions.reverse()) entry.dispose(); } };
}

test("activation waits for bundled plugin installation and restores the panel through a public command", async () => {
  const setup = fixture(["unpatched", "applied", "ready", "ready"]);
  let release;
  const bootstrap = new Promise((resolve) => { release = resolve; });
  const extension = extensionFixture(setup, bootstrap);
  try {
    const pending = extension.integration.inspect(true, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(setup.calls, [], "the patch cannot race plugin installation");
    release({ distro: "Ubuntu" });
    assert.equal((await pending).changed, true);
    assert.deepEqual(extension.executed, ["codexDecision.showLatestDecision"]);
    assert.match(extension.notifications[0][0], /Reload VS Code/);
    await extension.commands.get("codexDecision.checkIntegration")();
    assert.match(extension.notifications[1][0], /is verified/);
    assert.deepEqual(extension.executed, ["codexDecision.showLatestDecision"], "polls must not repeatedly steal focus");
  } finally { extension.dispose(); }
});

async function completesWithoutDismissal(operation) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Integration waited for notification dismissal")), 500);
    })]);
  } finally { clearTimeout(timer); }
}

test("unanswered reload and status notifications do not hold the integration task open", async () => {
  const setup = fixture(["unpatched", "applied", "ready", "ready"]);
  const extension = extensionFixture(setup, Promise.resolve({ status: "ready", distro: "Ubuntu" }));
  extension.vscode.window.showInformationMessage = (...args) => {
    extension.notifications.push(args);
    return new Promise(() => {});
  };
  try {
    assert.equal((await completesWithoutDismissal(extension.integration.inspect(true, false))).changed, true);
    assert.equal((await completesWithoutDismissal(extension.commands.get("codexDecision.checkIntegration")())).status, "ready");
    assert.equal(extension.notifications.length, 2);
    assert.deepEqual(extension.executed, ["codexDecision.showLatestDecision"]);
    assert.deepEqual(setup.actions(), ["status", "apply", "status", "status"]);
  } finally { extension.dispose(); }
});

test("an unanswered error notification permits a manual bootstrap retry", async () => {
  const setup = fixture(["ready"]);
  let corrected = false;
  const extension = extensionFixture(setup, async () => {
    if (!corrected) throw new Error("Decision bootstrap needs corrected settings");
    return { status: "ready", distro: "Ubuntu" };
  });
  const pendingNotification = (...args) => {
    extension.notifications.push(args);
    return new Promise(() => {});
  };
  extension.vscode.window.showWarningMessage = pendingNotification;
  extension.vscode.window.showInformationMessage = pendingNotification;
  try {
    assert.equal((await completesWithoutDismissal(extension.integration.inspect(true, false))).status, "failed");
    corrected = true;
    assert.equal((await completesWithoutDismissal(extension.commands.get("codexDecision.repairIntegration")())).status, "ready");
    assert.equal(extension.notifications.length, 2);
    assert.deepEqual(setup.actions(), ["status"]);
  } finally { extension.dispose(); }
});

test("the reload notification still runs its optional action after verification completes", async () => {
  const setup = fixture(["unpatched", "applied", "ready"]);
  const extension = extensionFixture(setup, Promise.resolve());
  let choose;
  extension.vscode.window.showInformationMessage = () => new Promise((resolve) => { choose = resolve; });
  try {
    assert.equal((await completesWithoutDismissal(extension.integration.inspect(true, false))).status, "ready");
    assert.deepEqual(extension.executed, ["codexDecision.showLatestDecision"]);
    choose("Reload Window");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(extension.executed, ["codexDecision.showLatestDecision", "workbench.action.reloadWindow"]);
  } finally { extension.dispose(); }
});

test("a bundled plugin upgrade restores a hidden panel once when the Codex patch is already healthy", async () => {
  const setup = fixture(["ready", "ready"]);
  const extension = extensionFixture(setup, Promise.resolve({ status: "installed", distro: "Ubuntu" }));
  try {
    await extension.integration.inspect(true, false);
    await extension.integration.inspect(true, false);
    assert.deepEqual(extension.executed, ["codexDecision.showLatestDecision"]);
    assert.deepEqual(extension.notifications, [], "a healthy patch does not require another reload");
    assert.deepEqual(setup.actions(), ["status", "status"]);
  } finally { extension.dispose(); }
});

test("corrected configuration and manual repair retry a failed bootstrap without a window reload", async () => {
  const setup = fixture(["ready", "ready"]);
  let corrected = false;
  let installations = 0;
  const extension = extensionFixture(setup, async () => {
    installations += 1;
    if (!corrected) throw new Error("Decision dataDirectory does not match the active Codex plugin");
    return { status: "ready", distro: "Ubuntu" };
  });
  try {
    assert.equal((await extension.integration.inspect(true, false)).status, "failed");
    assert.deepEqual(setup.calls, []);
    corrected = true;
    extension.listeners.config({ affectsConfiguration: () => true });
    const deadline = Date.now() + 2000;
    while (!setup.actions().length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(setup.actions(), ["status"]);
    assert.equal(installations, 2, "a corrected setting must start a new installation check");
    assert.equal((await extension.commands.get("codexDecision.repairIntegration")()).status, "ready");
    assert.equal(installations, 3, "manual repair must use current settings");
    assert.deepEqual(extension.executed, ["codexDecision.showLatestDecision"]);
    assert.equal(extension.notifications.length, 2, "one initial failure and one recovered manual status");
  } finally { extension.dispose(); }
});

test("concurrent manual checks serialize their bootstrap factories", async () => {
  const setup = fixture(["ready", "ready", "ready"]);
  let active = 0;
  let maximum = 0;
  const extension = extensionFixture(setup, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return { status: "ready", distro: "Ubuntu" };
  });
  try {
    await Promise.all(Array.from({ length: 3 }, () => extension.integration.inspect(true, true)));
    assert.equal(maximum, 1);
    assert.deepEqual(setup.actions(), ["status", "status", "status"]);
    assert.deepEqual(extension.executed, ["codexDecision.showLatestDecision"]);
  } finally { extension.dispose(); }
});

test("Codex extension changes repair the new selected installation after the initial check", async () => {
  const setup = fixture(["ready", "unpatched", "applied", "ready"]);
  const extension = extensionFixture(setup, Promise.resolve());
  try {
    await extension.integration.inspect(true, false);
    setup.options.host.packageJSON.version = "26.1008.12345";
    setup.options.host.extensionPath = "C:\\Users\\Fixture User\\.vscode\\extensions\\openai.chatgpt-26.1008.12345";
    extension.listeners.extensions();
    const deadline = Date.now() + 2000;
    while (setup.actions().length < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(setup.actions(), ["status", "status", "apply", "status"]);
    const update = setup.calls.find((call) => call.args[5] === "apply");
    assert.ok(update.args[9].endsWith("openai.chatgpt-26.1008.12345"));
    assert.ok(update.args[11].endsWith("/rollback/26.1008.12345"));
    assert.deepEqual(extension.executed, ["codexDecision.showLatestDecision"]);
  } finally { extension.dispose(); }
});

test("disabling automatic repair preserves the manual verified repair command", async () => {
  const setup = fixture(["unpatched", "applied", "ready"]);
  const extension = extensionFixture(setup, Promise.resolve());
  try {
    extension.settings.autoRepairIntegration = false;
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.deepEqual(setup.calls, []);
    assert.equal((await extension.commands.get("codexDecision.repairIntegration")()).status, "ready");
    assert.deepEqual(setup.actions(), ["status", "apply", "status"]);
  } finally { extension.dispose(); }
});

test("fresh installs can use the bootstrap distribution without a configured WSL data path", async () => {
  const setup = fixture(["ready"]);
  assert.equal((await runIntegration({ ...setup.options, dataDirectory: "", distro: "Ubuntu" })).status, "ready");
  await assert.rejects(runIntegration({ ...setup.options, dataDirectory: "", distro: "Ubuntu;bad" }), /WSL distribution/);
  assert.deepEqual(await runIntegration({ ...setup.options, platform: "linux" }), { status: "unsupported-platform" });
  const dotted = fixture(["ready"]);
  const run = dotted.options.run;
  assert.equal((await runIntegration({ ...dotted.options, dataDirectory: "", distro: "Ubuntu-24.04",
    run: (command, args, limits) => {
      assert.equal(args[1], "Ubuntu-24.04");
      return run(command, [args[0], "Ubuntu", ...args.slice(2)], limits);
    } })).status, "ready");
});

test("the installed marketplace reaches the patcher as a literal scoped environment argument", async () => {
  const setup = fixture(["ready"]);
  const originalRun = setup.options.run;
  const marketplacePath = "/home/fixture/.local/share/Decision $(`literal`)/.agents/plugins/marketplace.json";
  const scoped = [];
  setup.options.run = (command, args, limits) => {
    if (args[3] === "env") {
      scoped.push(args);
      assert.equal(args[4], `CODEX_DECISION_MARKETPLACE_PATH=${marketplacePath}`);
      assert.ok(args[5].endsWith("/plugin/hooks/bin/linux-x86_64/decisionctl"));
      return originalRun(command, [...args.slice(0, 3), ...args.slice(5)], limits);
    }
    return originalRun(command, args, limits);
  };
  const extension = extensionFixture(setup, Promise.resolve({ status: "ready", distro: "Ubuntu", marketplacePath }));
  try {
    assert.equal((await extension.integration.inspect(true, false)).status, "ready");
    assert.equal(scoped.length, 1);
  } finally { extension.dispose(); }
  for (const invalid of ["relative.json", "/home/fixture/../other.json", "/home/fixture/marketplace\n.json"]) {
    const unsafe = fixture();
    await assert.rejects(runIntegration({ ...unsafe.options, marketplacePath: invalid }), /marketplace path is invalid/);
    assert.deepEqual(unsafe.calls, []);
    assert.deepEqual(unsafe.created, []);
  }
});

test("diagnostics expose bounded errors without child process output or private environment", async () => {
  const error = Object.assign(new Error("process failed"), { stderr: "decisionctl: unsupported Codex extension version",
    stdout: "private-value-must-not-appear", env: { TOKEN: "private-env-must-not-appear" } });
  assert.equal(failureMessage(error), "unsupported Codex extension version");
  const setup = fixture([error, error]);
  const extension = extensionFixture(setup, Promise.resolve());
  try {
    assert.equal((await extension.integration.inspect(true, false)).status, "failed");
    await extension.integration.inspect(true, false);
    assert.equal(extension.notifications.length, 1, "the same automatic failure is reported once");
    assert.equal(JSON.stringify(extension.log).includes("private-value"), false);
    assert.equal(JSON.stringify(extension.log).includes("private-env"), false);
    assert.deepEqual(setup.actions(), ["status", "status"]);
  } finally { extension.dispose(); }
});
