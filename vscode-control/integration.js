"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { wslLocation } = require("./private-paths");
const runFile = promisify(execFile);
const { version: CONTROL_VERSION, codexDecisionHookVersion: HOOK_VERSION } = require("./package.json");
const PANEL_VERSION_KEY = "codexDecision.integration.panelControlVersion";
const PATCH_BUSY = "Decision patch is busy; retry later";
const PATCH_CONFLICTS = new Set([
  "Codex asset already exists: webview/assets/decision-control.js",
  "Codex asset already exists: webview/assets/decision-settings.js",
  "Codex asset already exists: webview/assets/decision-icon.png",
]);

function windowsPath(filename) {
  if (typeof filename !== "string" || !/^[A-Za-z]:[\\/]/.test(filename) ||
      /^[dD]:/.test(filename) || filename.includes("\0")) {
    throw new Error("Decision integration paths must be absolute and outside D:");
  }
  return path.win32.normalize(filename);
}

// Windows directory links and reparse points must not redirect patch or rollback writes.
async function directoryPath(filename, create, io, paths = path.win32) {
  let target;
  if (paths === path.win32) target = windowsPath(filename);
  else if (typeof filename === "string" && paths.isAbsolute(filename) &&
      paths.normalize(filename) === filename && !/[\r\n\0]/.test(filename) &&
      !/^\/mnt\/d(?:\/|$)/i.test(filename)) target = filename;
  else throw new Error("Decision integration needs an absolute Linux path off D:");
  const root = paths.parse(target).root;
  let current = root;
  for (const part of target.slice(root.length).split(paths.sep).filter(Boolean)) {
    current = paths.join(current, part);
    let info;
    try { info = await io.lstat(current); }
    catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
      try { await io.mkdir(current, { mode: 0o700 }); }
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

function patchCommandFailure(error, action) {
  const stderr = error?.stderr;
  const text = [1, 2].includes(error?.code) && typeof stderr === "string" && stderr.length <= 4096 ? stderr.trim() : "";
  const diagnostic = text.startsWith("decisionctl: ") ? text.slice("decisionctl: ".length) : "";
  if (diagnostic === PATCH_BUSY) return Object.assign(new Error(PATCH_BUSY), { patchFailure: "busy" });
  if (PATCH_CONFLICTS.has(diagnostic)) {
    return Object.assign(new Error("A Decision patch asset already exists; check integration before repairing"),
      { patchFailure: "asset-exists" });
  }
  if (diagnostic === "unsupported Codex extension version; revalidate the composer patch" ||
      diagnostic === "unsupported Codex assets; revalidate the composer patch" ||
      diagnostic === "Decision patch paths must not contain links" || diagnostic === "rollback metadata changed") {
    return new Error(diagnostic);
  }
  if (/^(?:Codex extension file changed|patched file changed|rollback file changed): [^\r\n]+$/.test(diagnostic)) {
    return new Error("Codex or rollback files did not match the verified patch; preserve them for review");
  }
  return new Error(`Decision patch ${action} failed; check the bundled runtime and file access`);
}

async function runIntegration({ host, controlRoot, dataDirectory, distro, backend, localAppData, marketplacePath,
  repair = true, platform = process.platform, homeDirectory = os.homedir(), io = fs, run = runFile }) {
  if (platform !== "win32" && platform !== "linux") return { status: "unsupported-platform" };
  const linuxHost = platform === "linux";
  const paths = linuxHost ? path.posix : path.win32;
  if (!host) throw new Error("Install the Codex extension to use Decision integration");
  const version = host.packageJSON?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Codex extension version could not be identified");
  }
  const location = wslLocation(dataDirectory || "");
  const distribution = distro || location?.distro;
  const useWsl = !linuxHost && (backend ? backend === "wsl" : Boolean(distribution));
  if (useWsl && (typeof distribution !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(distribution))) {
    throw new Error("Decision integration needs an installed WSL distribution");
  }
  if (marketplacePath != null && (typeof marketplacePath !== "string" ||
      /[\r\n\0]/.test(marketplacePath) || (useWsl || linuxHost
        ? !path.posix.isAbsolute(marketplacePath) || path.posix.normalize(marketplacePath) !== marketplacePath
        : !/^[A-Za-z]:[\\/]/.test(marketplacePath) || path.win32.normalize(marketplacePath) !== marketplacePath))) {
    throw new Error("Decision integration marketplace path is invalid");
  }
  const extension = await directoryPath(host.extensionPath, false, io, paths);
  const source = await directoryPath(controlRoot, false, io, paths);
  const linuxBinary = useWsl || linuxHost;
  const binary = paths.join(source, "plugin", "hooks", "bin",
    linuxBinary ? "linux-x86_64" : "windows-x86_64", linuxBinary ? "decisionctl" : "decisionctl.exe");
  await directoryPath(paths.dirname(binary), false, io, paths);
  const binaryInfo = await io.lstat(binary);
  if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink()) {
    throw new Error("Decision integration checker is missing or linked");
  }
  const base = await directoryPath(linuxHost ? homeDirectory : localAppData, false, io, paths);
  if (base === paths.parse(base).root) {
    throw new Error("Decision rollback needs the user-local application data directory");
  }
  const stateDirectory = linuxHost ? paths.join(base, ".local", "state") : paths.join(base, "Codex");
  const parent = await directoryPath(paths.join(stateDirectory, "codex-decision", "rollback"), true, io, paths);
  const backup = paths.join(parent, version);
  try { await directoryPath(backup, false, io, paths); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const execute = async (program, args, action) => {
    try {
      return await (useWsl
        ? run("wsl.exe", ["-d", distribution, "-e", program, ...args],
          { timeout: 30_000, maxBuffer: 16_384, windowsHide: true })
        : run(program, args, { timeout: 30_000, maxBuffer: 16_384, windowsHide: true,
          ...(marketplacePath || linuxHost ? { env: { ...process.env,
            ...(marketplacePath ? { CODEX_DECISION_MARKETPLACE_PATH: marketplacePath } : {}),
            ...(linuxHost ? { CODEX_DECISION_REMOTE_EXTENSION_HOST: "1" } : {}),
          } } : {}) }));
    } catch (error) {
      if (["EAGAIN", "EBUSY", "EINTR", "EIO", "ETIMEDOUT"].includes(error?.code) ||
          error?.killed === true && error.signal === "SIGTERM" && error.code == null) {
        const phase = program === "wslpath" ? "WSL path conversion" : "patch verification";
        throw Object.assign(new Error(`Decision integration is temporarily unavailable during ${phase}; retry repair`),
          { retryable: true });
      }
      if (action) throw patchCommandFailure(error, action);
      throw new Error("Decision integration failed during WSL path conversion; check WSL availability");
    }
  };
  // Pass each path as an argument. Never interpolate a shell program.
  const convert = async (filename) => {
    const result = await execute("wslpath", ["-u", filename]);
    const converted = result.stdout?.trim();
    if (typeof converted !== "string" || !converted.startsWith("/") || /[\r\n\0]/.test(converted) ||
        path.posix.normalize(converted) !== converted) {
      throw new Error("Decision integration path could not be converted for WSL");
    }
    return converted;
  };
  const converted = useWsl ? await Promise.all([binary, source, extension, backup].map(convert))
    : [binary, source, extension, backup];
  const argumentsFor = (action) => ["patch-webview", action, "--root", converted[1],
    "--extension", converted[2], "--backup", converted[3]];
  const invoke = async (action) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await execute(useWsl && marketplacePath ? "env" : converted[0], useWsl && marketplacePath
          ? [`CODEX_DECISION_MARKETPLACE_PATH=${marketplacePath}`, converted[0], ...argumentsFor(action)]
          : argumentsFor(action), action);
      }
      catch (error) {
        if (error.patchFailure !== "busy") throw error;
        if (attempt >= 3) {
          throw Object.assign(new Error(PATCH_BUSY), { retryable: true });
        }
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
    if (action !== "apply" || error.patchFailure !== "asset-exists") throw error;
    const concurrent = await status();
    if (concurrent.status !== "ready") throw error;
    return { ...concurrent, changed: false };
  }
  const after = await status();
  if (after.status !== "ready") throw new Error("Decision integration repair did not pass verification");
  return { ...after, changed: true, action };
}

function failureMessage(error) {
  if (error?.code === "ENOENT") return "A Decision integration file or directory is missing; check the installation";
  if (["EACCES", "EPERM"].includes(error?.code)) return "Decision integration could not access a required file or directory";
  if (typeof error?.syscall === "string") return "Decision integration failed while accessing local files";
  const text = typeof error?.message === "string" ? error.message : "";
  if (text.length <= 350 && !/[\r\n\0]/.test(text) &&
      SAFE_FAILURES.some((rule) => typeof rule === "string" ? rule === text : rule.test(text))) return text;
  return "Decision integration could not be verified; check the selected runtime and installation";
}

const SAFE_FAILURES = [
  PATCH_BUSY,
  "unsupported Codex extension version; revalidate the composer patch",
  "unsupported Codex assets; revalidate the composer patch",
  "Decision patch paths must not contain links", "rollback metadata changed",
  "Codex or rollback files did not match the verified patch; preserve them for review",
  "A Decision patch asset already exists; check integration before repairing",
  "Codex extension version could not be identified", "Install the Codex extension to use Decision integration",
  "Install the Codex VS Code extension before repairing Decision",
  "This Decision package requires Linux x86_64 or Windows with WSL",
  /^Decision patch (?:status|apply|update) failed; check the bundled runtime and file access$/,
  /^Decision integration is temporarily unavailable during (?:WSL path conversion|patch verification); retry repair$/,
  /^Decision integration (?:paths must be absolute and outside D:|needs an absolute Linux path off D:|path contains a linked or invalid directory|checker returned invalid status|needs an installed WSL distribution|marketplace path is invalid|checker is missing or linked|failed during WSL path conversion; check WSL availability|path could not be converted for WSL|repair did not pass verification)$/,
  "Decision rollback needs the user-local application data directory",
  "Decision dataDirectory does not match the active Codex plugin; correct it before repair",
  "Codex runs in Windows, but Decision dataDirectory is not a local Windows path; clear the Decision dataDirectory setting or enable Codex WSL integration",
  "Multiple Decision registrations need an explicit selection",
  "Decision is disabled in Codex; enable its existing registration before repair",
  "Installed Decision hook is newer than this VSIX",
  "This Decision registration needs a local marketplace for integrated updates",
  "Decision requires an available WSL Linux distribution",
  "Decision and Codex must use the same WSL distribution",
  "The Decision VSIX has an incomplete hook payload",
  /^Decision installation (?:is temporarily unavailable during (?:WSL discovery|WSL path conversion|hook installer); check WSL availability|failed during (?:WSL discovery|WSL path conversion|hook installer); check WSL availability and file access|returned (?:invalid|incomplete) metadata)$/,
  /^Decision installation (?:lock timed out|lock was interrupted|is busy); retry repair$/,
];

function activateIntegration(vscode, context, { dataDirectory, ready = Promise.resolve(),
  platform = process.platform, localAppData = process.env.LOCALAPPDATA, run = runFile, io = fs,
  retryDelaysMs = [2000, 5000, 15000] } = {}) {
  if (!vscode.extensions?.getExtension || !context.extensionUri?.fsPath) return null;
  const output = vscode.window.createOutputChannel("Decision Integration");
  const report = (line) => { try { output.appendLine(line); } catch {} };
  report(`Decision control ${CONTROL_VERSION}; bundled hook ${HOOK_VERSION}.`);
  let inFlight = null;
  let disposed = false;
  let timer = null;
  let retryTimer = null;
  let retryCount = 0;
  let reportedFailure = null;
  let panelRestored = false;
  const configuration = () => vscode.workspace.getConfiguration("codexDecision");
  function notify(method, message, actions, selected) {
    try {
      const reply = vscode.window[method](message, ...actions);
      void Promise.resolve(reply).then((choice) => {
        if (!disposed) return selected(choice);
      }).catch(() => { if (!disposed) report("Decision integration notification action failed."); });
    } catch {
      report("Decision integration notification could not be displayed.");
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
    if (manual) {
      clearTimeout(retryTimer);
      retryCount = 0;
    }
    const task = (async () => {
      let hostVersion = null;
      try {
        const installation = await (typeof ready === "function" ? ready() : ready);
        if (disposed) return;
        if (installation?.status === "installed") report("Bundled Decision hook installed and verified.");
        const host = vscode.extensions.getExtension("openai.chatgpt");
        if (/^\d+\.\d+\.\d+$/.test(host?.packageJSON?.version || "")) hostVersion = host.packageJSON.version;
        const result = await runIntegration({
          host,
          controlRoot: context.extensionUri.fsPath,
          dataDirectory: installation?.dataDirectory || dataDirectory?.(),
          distro: installation?.distro,
          backend: installation?.backend,
          marketplacePath: installation?.marketplacePath,
          localAppData, repair, platform, run, io,
        });
        if (disposed || result.status === "unsupported-platform") return result;
        report(`Codex ${result.version}: Decision integration ${result.status}${result.changed ? ` (${result.action})` : ""}.`);
        clearTimeout(retryTimer);
        retryCount = 0;
        reportedFailure = null;
        let panelRecoveryFailed = false;
        if (repair) {
          try {
            const migratePanel = result.status === "ready" && typeof context.globalState?.get === "function" &&
              typeof context.globalState?.update === "function" && context.globalState.get(PANEL_VERSION_KEY) !== CONTROL_VERSION;
            if (result.changed || manual || installation?.status === "installed" || migratePanel) await restorePanel(manual);
            if (migratePanel) await context.globalState.update(PANEL_VERSION_KEY, CONTROL_VERSION);
          } catch {
            panelRecoveryFailed = true;
            report("Decision patch verification succeeded, but panel recovery failed; run Decision: Show Latest Decision.");
          }
        }
        if (result.changed) {
          notify("showInformationMessage",
            "Decision integration was repaired and verified. Reload VS Code to activate the composer and settings.",
            ["Reload Window"], (selected) => {
              if (selected === "Reload Window") return vscode.commands.executeCommand("workbench.action.reloadWindow");
            });
        } else if (manual) {
          const hookNotice = installation?.status === "installed" ? "Bundled hook installed. " : "";
          const text = hookNotice + (result.status === "ready" ? "Decision integration is verified for the installed Codex extension." :
            "Decision integration needs repair for the installed Codex extension.");
          notify("showInformationMessage", text, result.status === "ready" ? [] : ["Repair Integration"], (selected) => {
            if (selected === "Repair Integration") schedule(true);
          });
        }
        return panelRecoveryFailed ? { ...result, panelRecoveryFailed } : result;
      } catch (error) {
        if (disposed) return;
        const diagnostic = failureMessage(error);
        const message = `${hostVersion ? `Codex ${hostVersion}: ` : ""}${diagnostic}`;
        const recovery = /^unsupported Codex (?:extension version|assets)/.test(diagnostic)
          ? "Run Decision: Check for Updates or install the latest Codex Decision VSIX through VS Code's Extensions menu (Install from VSIX), reload the window, then run Decision: Repair Integration."
          : "";
        report(`Decision integration unavailable: ${message}`);
        if (recovery) report(recovery);
        if (recovery && !manual) return { status: "hook-only", message };
        if (!manual && error.retryable === true && retryCount < retryDelaysMs.length &&
            configuration().get("autoRepairIntegration", true) !== false) {
          const delay = retryDelaysMs[retryCount++];
          report(`Decision will retry the temporary integration failure (${retryCount}/${retryDelaysMs.length}).`);
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => {
            if (!disposed && configuration().get("autoRepairIntegration", true) !== false) void inspect(true, false);
          }, delay);
          return { status: "retrying", message };
        }
        if (manual || reportedFailure !== message) {
          reportedFailure = message;
          notify("showWarningMessage", `Decision integration is unavailable: ${message}${recovery ? `. ${recovery}` : ""}`,
            recovery ? ["Check for Updates", "Show Diagnostics"] : ["Show Diagnostics"], (selected) => {
            if (selected === "Check for Updates") return vscode.commands.executeCommand("codexDecision.checkForUpdates");
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
    clearTimeout(retryTimer);
    retryCount = 0;
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
      if (event.affectsConfiguration("codexDecision") ||
          event.affectsConfiguration("chatgpt.runCodexInWindowsSubsystemForLinux")) schedule();
    }),
    { dispose() { disposed = true; clearTimeout(timer); clearTimeout(retryTimer); } });
  schedule();
  return { inspect };
}

module.exports = { activateIntegration, runIntegration, patchStatus, failureMessage };
