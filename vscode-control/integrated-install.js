"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { wslLocation } = require("./private-paths");
const runFile = promisify(execFile);

function cleanJson(stdout) {
  try { return JSON.parse(stdout.trim()); }
  catch { throw new Error("Decision installation returned invalid metadata"); }
}

async function ensureIntegratedInstall(vscode, context, options = {}) {
  const run = options.run || runFile;
  const platform = options.platform || process.platform;
  const extensionRoot = context.extensionPath || context.extensionUri?.fsPath;
  if (!extensionRoot) return { status: "not-packaged" };
  const payload = path.join(extensionRoot, "plugin");
  try { await fs.access(path.join(payload, ".codex-plugin", "plugin.json")); }
  catch { return { status: "not-packaged" }; }
  const host = vscode.extensions?.getExtension("openai.chatgpt");
  if (!host?.extensionPath) throw new Error("Install the Codex VS Code extension before repairing Decision");
  const configured = typeof options.dataDirectory === "function" ? options.dataDirectory() : options.dataDirectory;
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
      const result = await execute("wslpath", ["-u", filename], { timeout: 10_000, maxBuffer: 4096 });
      return result.stdout.trim();
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
    if (typeof error.stdout === "string") {
      const failure = cleanJson(error.stdout);
      if (failure.status === "error" && typeof failure.error === "string") throw new Error(failure.error);
    }
    throw new Error("Decision could not install its bundled hook in the Codex environment");
  }
  if (!["ready", "installed"].includes(result.status) || typeof result.dataDirectory !== "string" ||
      !result.dataDirectory.startsWith("/") || typeof result.decisionctl !== "string") {
    throw new Error("Decision installation returned incomplete metadata");
  }
  const discovered = platform === "win32"
    ? `\\\\wsl.localhost\\${distro}${result.dataDirectory.replaceAll("/", "\\")}` : result.dataDirectory;
  if (!configured) await vscode.workspace.getConfiguration("codexDecision").update("dataDirectory", discovered,
    vscode.ConfigurationTarget.Global);
  return { ...result, dataDirectory: configured || discovered, linuxDataDirectory: result.dataDirectory,
    distro, execute, convert };
}

module.exports = { ensureIntegratedInstall };
