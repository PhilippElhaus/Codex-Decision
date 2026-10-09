"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { wslLocation } = require("./private-paths");
const runFile = promisify(execFile);
const CONTROL_VERSION = require("./package.json").version;
const PANEL_VERSION_KEY = "codexDecision.integration.panelControlVersion";

function windowsPath(filename) {
  if (typeof filename !== "string" || !/^[A-Za-z]:[\\/]/.test(filename) ||
      /^[dD]:/.test(filename) || filename.includes("\0")) {
    throw new Error("Decision integration paths must be absolute and outside D:");
  }
  return path.win32.normalize(filename);
}

// Windows directory links and reparse points must not redirect patch or rollback writes.
async function directoryPath(filename, create, io) {
  const target = windowsPath(filename);
  const root = path.win32.parse(target).root;
  let current = root;
  for (const part of target.slice(root.length).split("\\").filter(Boolean)) {
    current = path.win32.join(current, part);
    let info;
    try { info = await io.lstat(current); }
    catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
      try { await io.mkdir(current); }
      catch (mkdirError) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
      info = await io.lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Decision integration path contains a linked or invalid directory");
    }
  }
  return target;
}

function patchStatus(stdout, version) {
  if (typeof stdout !== "string" || stdout.length > 4096) {
    throw new Error("Decision integration checker returned invalid status");
  }
  let result;
  try { result = JSON.parse(stdout); }
  catch { throw new Error("Decision integration checker returned invalid status"); }
  if (!result || result.version !== version ||
      !["ready", "unpatched", "outdated"].includes(result.status)) {
    throw new Error("Decision integration checker returned invalid status");
  }
  return { version: result.version, status: result.status };
}

async function runIntegration({ host, controlRoot, dataDirectory, distro, localAppData, marketplacePath,
  repair = true, platform = process.platform, io = fs, run = runFile }) {
  if (platform !== "win32") return { status: "unsupported-platform" };
  if (!host) throw new Error("Install the Codex extension to use Decision integration");
  const version = host.packageJSON?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Codex extension version could not be identified");
  }
  const location = wslLocation(dataDirectory || "");
  const distribution = location?.distro || distro;
  if (typeof distribution !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(distribution)) {
    throw new Error("Decision integration needs an installed WSL distribution");
  }
  if (marketplacePath != null && (typeof marketplacePath !== "string" ||
      !path.posix.isAbsolute(marketplacePath) || /[\r\n\0]/.test(marketplacePath) ||
      path.posix.normalize(marketplacePath) !== marketplacePath)) {
    throw new Error("Decision integration marketplace path is invalid");
  }
  const extension = await directoryPath(host.extensionPath, false, io);
  const source = await directoryPath(controlRoot, false, io);
  const binary = path.win32.join(source, "plugin", "hooks", "bin", "linux-x86_64", "decisionctl");
  await directoryPath(path.win32.dirname(binary), false, io);
  const binaryInfo = await io.lstat(binary);
  if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink()) {
    throw new Error("Decision integration checker is missing or linked");
  }
  const base = await directoryPath(localAppData, false, io);
  if (base === path.win32.parse(base).root) {
    throw new Error("Decision rollback needs the user-local application data directory");
  }
  const parent = await directoryPath(path.win32.join(base, "Codex", "codex-decision", "rollback"), true, io);
  const backup = path.win32.join(parent, version);
  try { await directoryPath(backup, false, io); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const execute = (program, args) => run("wsl.exe", ["-d", distribution, "-e", program, ...args],
    { timeout: 30_000, maxBuffer: 16_384, windowsHide: true });
  // Pass each path as an argument. Never interpolate a shell program.
  const convert = async (filename) => {
    const result = await execute("wslpath", ["-u", filename]);
    const converted = result.stdout?.trim();
    if (typeof converted !== "string" || !converted.startsWith("/") || /[\r\n\0]/.test(converted)) {
      throw new Error("Decision integration path could not be converted for WSL");
    }
    return converted;
  };
  const converted = await Promise.all([binary, source, extension, backup].map(convert));
  const argumentsFor = (action) => ["patch-webview", action, "--root", converted[1],
    "--extension", converted[2], "--backup", converted[3]];
  const invoke = async (action) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await execute(marketplacePath ? "env" : converted[0], marketplacePath
          ? [`CODEX_DECISION_MARKETPLACE_PATH=${marketplacePath}`, converted[0], ...argumentsFor(action)]
          : argumentsFor(action));
      }
      catch (error) {
        if (attempt >= 3 || !/Decision patch is busy; retry later/.test(error.stderr || error.message || "")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  };
  const status = async () => patchStatus((await invoke("status")).stdout, version);
  const before = await status();
  if (!repair || before.status === "ready") return { ...before, changed: false };
  const action = before.status === "unpatched" ? "apply" : "update";
  try { await invoke(action); }
  catch (error) {
    // Another VS Code window can complete the same verified patch between status and apply.
    if (action !== "apply" || !/Codex asset already exists:/.test(error.stderr || "")) throw error;
    const concurrent = await status();
    if (concurrent.status !== "ready") throw error;
    return { ...concurrent, changed: false };
  }
  const after = await status();
  if (after.status !== "ready") throw new Error("Decision integration repair did not pass verification");
  return { ...after, changed: true, action };
}

function failureMessage(error) {
  // Only surface a bounded patcher diagnostic. Do not log child-process objects or environment.
  const diagnostic = typeof error?.stderr === "string" ? error.stderr.trim().split(/\r?\n/).at(-1) : "";
  const message = diagnostic || error?.message || "Decision integration could not be verified";
  return message.replace(/^decisionctl:\s*/, "").slice(0, 350);
}

function activateIntegration(vscode, context, { dataDirectory, ready = Promise.resolve(),
  platform = process.platform, localAppData = process.env.LOCALAPPDATA, run = runFile, io = fs } = {}) {
  if (!vscode.extensions?.getExtension || !context.extensionUri?.fsPath) return null;
  const output = vscode.window.createOutputChannel("Decision Integration");
  let inFlight = null;
  let disposed = false;
  let timer = null;
  let reportedFailure = null;
  let panelRestored = false;
  const configuration = () => vscode.workspace.getConfiguration("codexDecision");
  function notify(method, message, actions, selected) {
    try {
      const reply = vscode.window[method](message, ...actions);
      void Promise.resolve(reply).then((choice) => {
        if (!disposed) return selected(choice);
      }).catch(() => { if (!disposed) output.appendLine("Decision integration notification action failed."); });
    } catch {
      output.appendLine("Decision integration notification could not be displayed.");
    }
  }
  const restorePanel = async (force = false) => {
    if (force || !panelRestored) {
      await vscode.commands.executeCommand("codexDecision.showLatestDecision");
      panelRestored = true;
    }
  };
  async function inspect(repair, manual) {
    while (inFlight) {
      if (!manual) return inFlight;
      await inFlight;
    }
    const task = (async () => {
      let hostVersion = null;
      try {
        const installation = await (typeof ready === "function" ? ready() : ready);
        if (disposed) return;
        const host = vscode.extensions.getExtension("openai.chatgpt");
        if (/^\d+\.\d+\.\d+$/.test(host?.packageJSON?.version || "")) hostVersion = host.packageJSON.version;
        const result = await runIntegration({
          host,
          controlRoot: context.extensionUri.fsPath,
          dataDirectory: dataDirectory?.() || installation?.dataDirectory,
          distro: installation?.distro,
          marketplacePath: installation?.marketplacePath,
          localAppData, repair, platform, run, io,
        });
        if (disposed || result.status === "unsupported-platform") return result;
        output.appendLine(`Codex ${result.version}: Decision integration ${result.status}${result.changed ? ` (${result.action})` : ""}.`);
        reportedFailure = null;
        const migratePanel = result.status === "ready" && typeof context.globalState?.get === "function" &&
          typeof context.globalState?.update === "function" && context.globalState.get(PANEL_VERSION_KEY) !== CONTROL_VERSION;
        if (result.changed || manual || installation?.status === "installed" || migratePanel) {
          await restorePanel(manual && repair);
        }
        if (migratePanel) await context.globalState.update(PANEL_VERSION_KEY, CONTROL_VERSION);
        if (result.changed) {
          notify("showInformationMessage",
            "Decision integration was repaired and verified. Reload VS Code to activate the composer and settings.",
            ["Reload Window"], (selected) => {
              if (selected === "Reload Window") return vscode.commands.executeCommand("workbench.action.reloadWindow");
            });
        } else if (manual) {
          const text = result.status === "ready" ? "Decision integration is verified for the installed Codex extension." :
            "Decision integration needs repair for the installed Codex extension.";
          notify("showInformationMessage", text, result.status === "ready" ? [] : ["Repair Integration"], (selected) => {
            if (selected === "Repair Integration") schedule(true);
          });
        }
        return result;
      } catch (error) {
        if (disposed) return;
        const message = `${hostVersion ? `Codex ${hostVersion}: ` : ""}${failureMessage(error)}`;
        output.appendLine(`Decision integration unavailable: ${message}`);
        if (manual || reportedFailure !== message) {
          reportedFailure = message;
          notify("showWarningMessage", `Decision integration is unavailable: ${message}`, ["Show Diagnostics"], (selected) => {
            if (selected === "Show Diagnostics") output.show(true);
          });
        }
        return { status: "failed", message };
      }
    })();
    inFlight = task;
    try { return await task; }
    finally { if (inFlight === task) inFlight = null; }
  }
  function schedule(manual = false) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (inFlight) await inFlight;
      if (!disposed && (manual || configuration().get("autoRepairIntegration", true) !== false)) void inspect(true, manual);
    }, manual ? 0 : 500);
  }
  context.subscriptions.push(output,
    vscode.commands.registerCommand("codexDecision.checkIntegration", () => inspect(false, true)),
    vscode.commands.registerCommand("codexDecision.repairIntegration", () => inspect(true, true)),
    vscode.extensions.onDidChange(() => schedule()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexDecision")) schedule();
    }),
    { dispose() { disposed = true; clearTimeout(timer); } });
  schedule();
  return { inspect };
}

module.exports = { activateIntegration, runIntegration, patchStatus, failureMessage };
