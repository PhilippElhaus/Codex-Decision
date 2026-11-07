"use strict";

// Runs inside VS Code's Node host. A Windows installation needs no Python or WSL.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);
const PLUGIN = "codex-decision";
const FILES = [
  ".codex-plugin/plugin.json", "skills/decision-output/SKILL.md", "hooks/hooks.json",
  "hooks/bin/linux-x86_64/decision-hook", "hooks/bin/linux-x86_64/decisionctl",
  "hooks/bin/windows-x86_64/decision-hook.exe", "hooks/bin/windows-x86_64/decisionctl.exe",
  "assets/logo.png", "assets/icon.png", "config.example.json", "LICENSE",
];

function refusal(message) { return Object.assign(new Error(message), { decisionInstaller: true }); }
async function info(filename) {
  try { return await fs.lstat(filename); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function safePath(filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) throw refusal("Decision installation requires absolute paths");
  if (/[\r\n\0]/.test(filename) || process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(filename)) {
    throw refusal("Decision native installation requires local Windows drive paths");
  }
  const resolved = path.resolve(filename);
  let current = resolved;
  while (true) {
    if ((await info(current))?.isSymbolicLink()) throw refusal("Decision installation paths must not contain links or junctions");
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    current = parent;
  }
}
function offWorkspace(filename) {
  if (/^(?:d:[\\/]|\/mnt\/d(?:\/|$))/i.test(filename)) throw refusal("Decision installation state must remain outside D:");
}
function descendant(root, filename) {
  const relative = path.relative(root, filename);
  return !!relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function samePath(first, second) {
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}
async function readJson(filename) {
  filename = await safePath(filename);
  const stat = await info(filename);
  if (!stat?.isFile() || stat.size > 128_000) throw refusal("Invalid Decision package metadata");
  try { return JSON.parse((await caches.readFile(filename, 128_000)).toString("utf8")); }
  catch (error) { if (error instanceof SyntaxError) throw refusal("Invalid Decision package metadata"); throw error; }
}
function version(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:\+[A-Za-z0-9.-]+)?$/.test(value)) throw refusal("Invalid Decision package version");
  return value.split("+", 1)[0].split(".").map(Number);
}
function newer(actual, expected) {
  const a = version(actual), b = version(expected);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function existing(metadata) {
  const installed = (metadata.installed || []).filter(item => item.name === PLUGIN && item.installed === true);
  const enabled = installed.filter(item => item.enabled === true);
  if (enabled.length > 1 || !enabled.length && installed.length > 1) throw refusal("Multiple Decision registrations need an explicit selection");
  return (enabled.length ? enabled : installed)[0] || null;
}
async function writeExact(filename, bytes) {
  filename = await safePath(filename);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await safePath(path.dirname(filename));
  const stat = await info(filename);
  if (stat && !stat.isFile()) throw refusal("Invalid Decision package destination");
  const temporary = path.join(path.dirname(filename), `.decision-install-${randomUUID()}`);
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await safePath(filename);
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
async function matches(root, payload) {
  for (const filename of FILES) {
    const target = await safePath(path.join(root, filename));
    const stat = await info(target);
    if (!stat?.isFile() || stat.size !== payload.get(filename).length ||
        !(await caches.readFile(target)).equals(payload.get(filename))) return false;
  }
  return true;
}
async function validateSource(source) {
  let ancestor = source;
  while (true) {
    if (await info(path.join(ancestor, ".git"))) throw refusal("Decision cannot overwrite a development repository");
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (await info(source) && !(await info(source)).isDirectory()) throw refusal("Invalid Decision package destination");
}
async function updateSource(payload, source, backupRoot) {
  await validateSource(source);
  const changed = new Map();
  for (const filename of FILES) {
    const target = await safePath(path.join(source, filename));
    const stat = await info(target);
    if (stat && !stat.isFile()) throw refusal("Invalid Decision package destination");
    const previous = stat ? await caches.readFile(target) : null;
    if (!previous || !previous.equals(payload.get(filename))) changed.set(filename, previous);
  }
  let rollback = null;
  for (const [filename, previous] of changed) {
    const target = path.join(source, filename);
    if (previous) {
      if (!rollback) {
        await safePath(backupRoot);
        await fs.mkdir(backupRoot, { recursive: true });
        rollback = await fs.mkdtemp(path.join(backupRoot, `${Date.now()}-`));
        await writeExact(path.join(rollback, "source.json"), Buffer.from(JSON.stringify({ source })));
      }
      await writeExact(path.join(rollback, filename), previous);
    }
    await writeExact(target, payload.get(filename));
  }
  return { changed: !!changed.size, rollback };
}
async function withLock(stateRoot, operation) {
  await safePath(stateRoot);
  await fs.mkdir(stateRoot, { recursive: true });
  const filename = path.join(stateRoot, ".companion-install.lock");
  await safePath(filename);
  if (process.platform === "win32") {
    // Match Python companions' byte range. The kernel releases it on host termination.
    const script = `$ErrorActionPreference='Stop'
$deadline=[DateTime]::UtcNow.AddSeconds(15)
$lock=$null
while($null -eq $lock) {
  try {
    $candidate=[IO.File]::Open($env:DECISION_INSTALL_LOCK,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
    try { $candidate.Lock(0,1); $lock=$candidate }
    catch { $candidate.Dispose(); throw }
  }
  catch [IO.IOException] {
    if(($_.Exception.HResult -band 65535) -notin @(32,33)) { exit 3 }
    if([DateTime]::UtcNow -ge $deadline) { exit 2 }
    Start-Sleep -Milliseconds 100
  }
  catch { exit 3 }
}
try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadToEnd() | Out-Null }
finally { $lock.Dispose() }`;
    const preferred = path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell/7/pwsh.exe");
    const executable = (await info(preferred))?.isFile() ? preferred
      : path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, DECISION_INSTALL_LOCK: filename },
    });
    let ended = false;
    child.once("exit", () => { ended = true; });
    child.once("error", () => { ended = true; });
    child.stdin.on("error", () => {});
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.off("error", failed);
          child.off("exit", exited);
          child.stdout.off("data", received);
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => finish(Object.assign(refusal("Decision installation lock timed out; retry repair"), { retryable: true })), 20_000);
        let output = "";
        const failed = () => { ended = true; finish(refusal("Decision installation lock is unavailable; check PowerShell and file access")); };
        const exited = code => finish(code === 2
          ? Object.assign(refusal("Decision installation is busy; retry repair"), { retryable: true })
          : refusal("Decision installation lock is unavailable; check PowerShell and file access"));
        const received = bytes => {
          output += bytes.toString();
          if (output.trim() === "locked") finish();
          else if (output.length > 128) finish(refusal("Decision installation lock returned invalid metadata"));
        };
        child.once("error", failed);
        child.once("exit", exited);
        child.stdout.on("data", received);
      });
      const result = await operation();
      if (ended) throw Object.assign(refusal("Decision installation lock was interrupted; retry repair"), { retryable: true });
      return result;
    } finally {
      child.stdin.end();
      if (!ended) await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
  }
  const deadline = Date.now() + 15_000;
  let handle;
  while (!handle) {
    await safePath(filename);
    try { handle = await fs.open(filename, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw refusal("Decision installation is busy; retry repair");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { await handle.writeFile(`${process.pid}\n`); return await operation(); }
  finally { await handle.close(); await fs.unlink(filename); }
}

const caches = require("./install-cache")({ safePath, writeExact, version, refusal, files: FILES });

async function install(options) {
  let phase = "package inspection";
  try {
    const home = await safePath(options.home || os.homedir());
    const codexHome = await safePath(options.codexHome || process.env.CODEX_HOME || path.join(home, ".codex"));
    const sourcePayload = await safePath(options.payload);
    offWorkspace(home); offWorkspace(codexHome);
    const stateRoot = path.join(home, ".local/state/codex-decision");
    const secureDirectory = async directory => {
      await safePath(directory);
      await fs.mkdir(directory, { recursive: true });
      if (process.platform !== "win32" || options.run) return;
      try {
        const checker = await safePath(path.join(sourcePayload, "hooks/bin/windows-x86_64/decisionctl.exe"));
        if (!(await info(checker))?.isFile()) throw refusal("The Decision VSIX has an incomplete hook payload");
        await runFile(checker,
          ["secure-directory", "--path", directory], { timeout: 30_000, maxBuffer: 4096, windowsHide: true });
      } catch { throw refusal("Decision could not secure its native installation state"); }
    };
    const lockRoot = path.join(codexHome, "plugins");
    await secureDirectory(lockRoot);
    return await withLock(lockRoot, async () => {
      await secureDirectory(stateRoot);
      const payload = new Map();
      for (const filename of FILES) {
        const incoming = await safePath(path.join(sourcePayload, filename));
        if (!(await info(incoming))?.isFile()) throw refusal("The Decision VSIX has an incomplete hook payload");
        payload.set(filename, await caches.readFile(incoming));
      }
      const manifest = await readJson(path.join(sourcePayload, ".codex-plugin/plugin.json"));
      if (manifest.name !== PLUGIN) throw refusal("Invalid Decision hook payload");
      version(manifest.version);
      const run = options.run || (async (binary, args) => {
        let reply;
        try { reply = await runFile(binary, ["plugin", ...args, "--json"], { timeout: 90_000, maxBuffer: 2_000_000, windowsHide: true }); }
        catch (error) {
          if (error.killed) throw Object.assign(refusal("Codex plugin command timed out"), { retryable: true });
          throw refusal(`Codex plugin command failed during ${phase}`);
        }
        try { return JSON.parse(reply.stdout); } catch { throw refusal("Invalid Codex plugin metadata"); }
      });
      phase = "Codex plugin discovery";
      const current = existing(await run(options.codex, ["list"]));
      let source, marketplace, pluginId, marketplacePath, marketplaceRoot, metadata;
      const roots = (await run(options.codex, ["marketplace", "list"])).marketplaces || [];
      if (current) {
        if (current.enabled !== true) throw refusal("Decision is disabled in Codex; enable its existing registration before repair");
        if (newer(current.version, manifest.version)) throw refusal("Installed Decision hook is newer than this VSIX");
        if (current.source?.source !== "local" || typeof current.source.path !== "string") throw refusal("This Decision registration needs a local marketplace for integrated updates");
        source = await safePath(current.source.path);
        if (!descendant(home, source) || samePath(source, codexHome)) throw refusal("Decision needs a dedicated local package directory under the user home");
        if ((await readJson(path.join(source, ".codex-plugin/plugin.json"))).name !== PLUGIN) throw refusal("The registered Decision source is not a Decision package");
        marketplace = current.marketplaceName;
        if (typeof marketplace !== "string" || !/^[A-Za-z0-9_-]+$/.test(marketplace)) throw refusal("Invalid Decision marketplace identity");
        pluginId = `${PLUGIN}@${marketplace}`;
        if (current.pluginId !== pluginId) throw refusal("Invalid Decision plugin identity");
        const registered = roots.filter(item => item.name === marketplace);
        marketplacePath = registered.length === 1 && typeof registered[0].root === "string"
          ? path.join(await safePath(registered[0].root), ".agents/plugins/marketplace.json") : null;
      } else {
        marketplace = "codex-decision-integrated";
        pluginId = `${PLUGIN}@${marketplace}`;
        marketplaceRoot = path.join(home, ".local/share/codex-decision");
        const registered = roots.filter(item => item.name === marketplace);
        if (registered.length && (registered.length !== 1 || !samePath(await safePath(registered[0].root), marketplaceRoot))) throw refusal("Decision integrated marketplace name is already registered at another directory");
        source = path.join(marketplaceRoot, "plugins/codex-decision");
        marketplacePath = path.join(marketplaceRoot, ".agents/plugins/marketplace.json");
        metadata = { name: marketplace, interface: { displayName: "Codex Decision" }, plugins: [{ name: PLUGIN,
          source: { source: "local", path: "./plugins/codex-decision" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] };
        if (await info(marketplacePath) && JSON.stringify(await readJson(marketplacePath)) !== JSON.stringify(metadata)) throw refusal("Decision integrated marketplace contains unknown configuration");
      }
      const dataDirectory = path.join(codexHome, "plugins/data", `${PLUGIN}-${marketplace}`);
      if (options.dataDirectory && !samePath(await safePath(options.dataDirectory), dataDirectory)) throw refusal("Decision dataDirectory does not match the active Codex plugin; correct it before repair");
      offWorkspace(source);
      await secureDirectory(dataDirectory);
      const cacheRoot = path.join(codexHome, "plugins/cache", marketplace, PLUGIN);
      const installed = path.join(cacheRoot, manifest.version);
      const result = { pluginId, version: manifest.version, pluginRoot: installed, dataDirectory,
        decisionctl: path.join(installed, "hooks/bin/windows-x86_64/decisionctl.exe"), marketplacePath };
      phase = "installed package verification";
      await validateSource(source);
      const refreshed = !current || !await matches(source, payload) || !await matches(installed, payload) || current.version !== manifest.version;
      if (!refreshed) return { ...result, status: "ready", rollback: null, cacheRollback: null };
      const snapshots = await caches.snapshot(cacheRoot);
      const cacheRollback = await caches.backup(snapshots, path.join(stateRoot, "cache-rollbacks"), cacheRoot);
      phase = "package update";
      const update = await updateSource(payload, source, path.join(stateRoot, "integrated-rollbacks"));
      let verified = false;
      try {
        if (!current) {
          await writeExact(marketplacePath, Buffer.from(JSON.stringify(metadata, null, 2) + "\n"));
          await run(options.codex, ["marketplace", "add", marketplaceRoot]);
        }
        if (refreshed) { phase = "Codex plugin registration"; await run(options.codex, ["add", pluginId]); }
        phase = "installed package verification";
        const selected = existing(await run(options.codex, ["list"]));
        if (!selected || selected.pluginId !== pluginId || selected.version !== manifest.version || selected.enabled !== true) throw refusal("Codex did not activate the packaged Decision version");
        if (!await matches(installed, payload)) throw refusal("Codex cached Decision package differs from the VSIX");
        verified = true;
      } finally {
        if (refreshed) await caches.restore(cacheRoot, snapshots, verified ? manifest.version : null);
      }
      return { ...result, status: "installed", rollback: update.rollback || cacheRollback, cacheRollback };
    });
  } catch (error) {
    if (error.decisionInstaller) throw error;
    throw Object.assign(new Error(`Decision hook installation failed during ${phase}: file or process access failure`),
      { retryable: ["EAGAIN", "EBUSY", "EINTR", "EIO", "ETIMEDOUT"].includes(error.code) });
  }
}

module.exports = { install, FILES };
