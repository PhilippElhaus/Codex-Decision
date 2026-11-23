"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { runProcess } = require("./assistance-client");
const { wslLocation } = require("./private-paths");
const { parseUniqueJson, validateDirectoryPath } = require("./private-records");

function bundledCommands(controlRoot) {
  const plugin = path.join(controlRoot, "plugin");
  if (!fs.existsSync(path.join(plugin, ".codex-plugin", "plugin.json"))) return null;
  const conversions = new Map();
  return async function nativeCommand(tool, directory, args, options = {}) {
    const location = process.platform === "win32" ? wslLocation(directory) : null;
    const windows = process.platform === "win32" && !location;
    const binary = path.join(plugin, "hooks", "bin", windows ? "windows-x86_64" : "linux-x86_64",
      tool + (windows ? ".exe" : ""));
    await validateDirectoryPath(path.dirname(binary));
    const info = await fs.promises.lstat(binary);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Decision bundled runtime is unavailable");
    const parameters = args(location ? location.filename : directory);
    if (!location) return parseUniqueJson(await runProcess(binary, parameters, options));
    const prefix = ["-d", location.distro, "-e"];
    const key = `${location.distro}:${binary}`;
    let conversion = conversions.get(key);
    if (!conversion) {
      conversion = runProcess("wsl.exe", [...prefix, "wslpath", "-u", binary], { timeout: 10_000 })
        .then(stdout => {
          const linux = stdout.trim();
          if (!linux.startsWith("/") || /[\r\n\0]/.test(linux) || path.posix.normalize(linux) !== linux) {
            throw new Error("Decision bundled WSL runtime is unavailable");
          }
          return linux;
        }).catch(error => { conversions.delete(key); throw error; });
      if (conversions.size >= 8) conversions.delete(conversions.keys().next().value);
      conversions.set(key, conversion);
    }
    return parseUniqueJson(await runProcess("wsl.exe", [...prefix, await conversion, ...parameters], options));
  };
}

function providerProbe(command, directory) {
  return async ({ provider, custom_provider, credential, timeout_ms }, signal) => {
    try {
      const response = await command("decision-hook", directory, () => ["--probe-provider"], {
        input: JSON.stringify({ provider, custom_provider, credential, timeout_ms }), signal, timeout: timeout_ms,
      });
      if (response?.ok === true && typeof response.model === "string") return { ok: true, model: response.model };
      if (response?.ok === false && /^DECISION_(?:INVALID_SETTINGS|KEY_INVALID|KEY_EXPIRED|TIMEOUT|NETWORK_ERROR|INVALID_RESPONSE|HTTP_\d{3})$/.test(response.reason)) {
        return { ok: false, reason: response.reason };
      }
      return { ok: false, reason: "DECISION_INVALID_RESPONSE" };
    } catch {
      return { ok: false, reason: signal.aborted ? "DECISION_TIMEOUT" : "DECISION_NETWORK_ERROR" };
    }
  };
}

async function activityView(command, directory, action) {
  const result = await command("decisionctl", directory, scope => ["activity-view", action, scope]);
  if (result?.version !== 1 || !result.activity || typeof result.activity !== "object" || Array.isArray(result.activity)) {
    throw new Error("Decision activity runtime returned invalid metadata");
  }
  return result.activity;
}

module.exports = { bundledCommands, providerProbe, activityView };
