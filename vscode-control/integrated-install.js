"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { wslLocation } = require("./private-paths");
const runFile = promisify(execFile);
const MANAGED_DATA_KEY = "codexDecision.installation.managedDataDirectory";

function cleanJson(stdout) {
  try { return JSON.parse(stdout.trim()); }
  catch { throw new Error("Decision installation returned invalid metadata"); }
}

function linuxPath(filename) {
  return typeof filename === "string" && filename.startsWith("/") &&
    !/[\r\n\0]/.test(filename) && path.posix.normalize(filename) === filename;
}

async function ensureIntegratedInstall(vscode, context, options = {}) {
  const processRun = options.run || runFile;
  const run = async (...args) => {
    try { return await processRun(...args); }
    catch (error) {
      const target = args[0] === "wsl.exe" ? args[1][args[1].indexOf("-e") + 1] : args[0];
      const phase = target === "printenv" ? "WSL discovery" : target === "wslpath" ? "WSL path conversion" : "hook installer";
      if (["EAGAIN", "EBUSY", "EINTR", "EIO", "ETIMEDOUT"].includes(error.code) ||
          error.killed === true && error.signal === "SIGTERM" && error.code == null) {
        throw Object.assign(new Error(`Decision installation is temporarily unavailable during ${phase}; check WSL availability`),
          { code: "DECISION_INSTALL_TEMPORARY", retryable: true });
      }
      // Only Python's fixed JSON protocol can reach the installer error parser.
      if (target !== "python3") throw new Error(`Decision installation failed during ${phase}; check WSL availability and file access`);
      throw error;
    }
  };
  const platform = options.platform || process.platform;
  const extensionRoot = context.extensionPath || context.extensionUri?.fsPath;
  if (!extensionRoot) return { status: "not-packaged" };
  const payload = path.join(extensionRoot, "plugin");
  try { await fs.access(path.join(payload, ".codex-plugin", "plugin.json")); }
  catch { return { status: "not-packaged" }; }
  const host = vscode.extensions?.getExtension("openai.chatgpt");
  if (!host?.extensionPath) throw new Error("Install the Codex VS Code extension before repairing Decision");
  const selectedDirectory = typeof options.dataDirectory === "function" ? options.dataDirectory() : options.dataDirectory;
  const useWsl = platform === "win32" &&
    vscode.env?.remoteName !== "wsl" &&
    vscode.workspace.getConfiguration("chatgpt")?.get?.("runCodexInWindowsSubsystemForLinux", false) === true;
  const backend = platform === "win32" ? useWsl ? "wsl" : "native" : "linux";
  const managed = context.globalState?.get?.(MANAGED_DATA_KEY);
  const ownsDirectory = typeof managed?.dataDirectory === "string" &&
    managed.dataDirectory === selectedDirectory && ["native", "wsl", "linux"].includes(managed.backend);
  // Automatically discovered locations belong to their Codex runtime. Switching
  // runtimes selects that runtime's store; each installation keeps its own data.
  const configured = ownsDirectory && managed.backend !== backend ? undefined : selectedDirectory;
  const saveDirectory = async (directory, verifiedCanonical = false) => {
    if (directory !== selectedDirectory) await vscode.workspace.getConfiguration("codexDecision").update("dataDirectory", directory,
      vscode.ConfigurationTarget.Global);
    if (!selectedDirectory || ownsDirectory || verifiedCanonical) await context.globalState?.update?.(MANAGED_DATA_KEY,
      { dataDirectory: directory, backend });
  };
  if (platform === "win32" && !useWsl) {
    if (configured && (!path.win32.isAbsolute(configured) || /^[\\/]/.test(configured))) {
      throw new Error("Codex runs in Windows, but Decision dataDirectory is not a local Windows path; clear the Decision dataDirectory setting or enable Codex WSL integration");
    }
    const installNative = options.installNative || require("./install-plugin-native").install;
    const result = await installNative({ payload,
      codex: path.join(host.extensionPath, "bin", "windows-x86_64", "codex.exe"),
      dataDirectory: configured });
    if (!["ready", "installed"].includes(result.status) ||
        typeof result.dataDirectory !== "string" || !path.win32.isAbsolute(result.dataDirectory) ||
        /[\r\n\0]/.test(result.dataDirectory) || typeof result.decisionctl !== "string") {
      throw new Error("Decision installation returned incomplete metadata");
    }
    await saveDirectory(configured || result.dataDirectory,
      Boolean(configured) && path.win32.normalize(configured) === path.win32.normalize(result.dataDirectory));
    return { ...result, backend: "native", distro: null, execute: run, convert: async (filename) => filename };
  }
  let distro = null;
  let execute;
  let convert = async (filename) => filename;
  if (platform === "win32") {
    distro = wslLocation(configured || "")?.distro || null;
    if (!distro) {
      const reply = await run("wsl.exe", ["-e", "printenv", "WSL_DISTRO_NAME"], { timeout: 15_000, maxBuffer: 4096 });
      distro = reply.stdout.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(distro)) throw new Error("Decision requires an available WSL Linux distribution");
    }
    const prefix = ["-d", distro, "-e"];
    execute = (binary, args, settings) => run("wsl.exe", [...prefix, binary, ...args], settings);
    convert = async (filename) => {
      const location = wslLocation(filename);
      if (location) {
        if (location.distro.toLowerCase() !== distro.toLowerCase()) throw new Error("Decision and Codex must use the same WSL distribution");
        return location.filename;
      }
      // A copied Linux setting is already in the selected Codex filesystem.
      if (filename === configured && linuxPath(filename)) return filename;
      if (!path.win32.isAbsolute(filename) || /[\r\n\0]/.test(filename)) {
        throw new Error("Decision installation needs an absolute Windows or WSL path");
      }
      const result = await execute("wslpath", ["-u", filename], { timeout: 10_000, maxBuffer: 4096 });
      const converted = result.stdout?.trim();
      if (!linuxPath(converted)) throw new Error("Decision installation path could not be converted for WSL");
      return converted;
    };
  } else if (platform === "linux") {
    execute = run;
  } else {
    throw new Error("This Decision package requires Linux x86_64 or Windows with WSL");
  }
  const [script, linuxPayload, codex, linuxConfigured] = await Promise.all([
    convert(path.join(extensionRoot, "install-plugin.py")),
    convert(payload), convert(path.join(host.extensionPath, "bin", "linux-x86_64", "codex")),
    configured ? convert(configured) : null,
  ]);
  let result;
  try {
    const args = [script, "--payload", linuxPayload, "--codex", codex];
    if (linuxConfigured) args.push("--data-directory", linuxConfigured);
    const reply = await execute("python3", args,
      { timeout: 180_000, maxBuffer: 16_384 });
    result = cleanJson(reply.stdout);
  } catch (error) {
    if (error.code === "DECISION_INSTALL_TEMPORARY") throw error;
    if (typeof error.stdout === "string") {
      const failure = cleanJson(error.stdout);
      if (failure.status === "error" && typeof failure.error === "string") {
        throw Object.assign(new Error(failure.error), { retryable: failure.retryable === true });
      }
    }
    throw new Error("Decision could not install its bundled hook in the Codex environment");
  }
  if (!["ready", "installed"].includes(result.status) || typeof result.dataDirectory !== "string" ||
      !linuxPath(result.dataDirectory) || !linuxPath(result.decisionctl)) {
    throw new Error("Decision installation returned incomplete metadata");
  }
  const discovered = platform === "win32"
    ? `\\\\wsl.localhost\\${distro}${result.dataDirectory.replaceAll("/", "\\")}` : result.dataDirectory;
  // Windows consumers cannot read /home paths directly. Persist the matching UNC
  // path even when an old setting was copied from a Linux/remote window.
  const directory = platform === "win32" && linuxPath(configured) ? discovered : configured || discovered;
  // Older controls stored discovered paths without an ownership marker. The
  // installer verifies the configured directory against Codex's canonical store
  // before success, so that exact verified location can join automatic switching.
  await saveDirectory(directory, Boolean(linuxConfigured) && linuxConfigured === result.dataDirectory);
  return { ...result, dataDirectory: directory, linuxDataDirectory: result.dataDirectory,
    backend: platform === "win32" ? "wsl" : "linux", distro, execute, convert };
}

module.exports = { ensureIntegratedInstall };
