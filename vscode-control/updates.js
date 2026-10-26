"use strict";

const https = require("node:https");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { createHash } = require("node:crypto");
// The callback API also resolves Windows RAM drives that native realpath rejects.
const realpath = promisify(require("node:fs").realpath);
const CURRENT_VERSION = require("./package.json").version;
const RELEASE_API = "https://api.github.com/repos/PhilippElhaus/Codex-Decision/releases/latest";
const RELEASE_BASE = "https://github.com/PhilippElhaus/Codex-Decision/releases/download/";
const MAX_VSIX_BYTES = 50_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK = "codexDecision.updates.lastCheck";

function refusal(message) { return Object.assign(new Error(message), { decisionUpdate: true }); }
function cancelled() { return Object.assign(refusal("Decision update was cancelled"), { cancelled: true }); }
function stableVersion(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function newer(actual, expected) {
  const a = stableVersion(actual), b = stableVersion(expected);
  if (!a || !b) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}

function releaseCandidate(release, currentVersion = CURRENT_VERSION) {
  if (!release || release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") {
    throw refusal("GitHub did not return a stable Decision release");
  }
  const version = release.tag_name.replace(/^v/, "");
  if (!stableVersion(version) || !stableVersion(currentVersion)) throw refusal("Decision release version is invalid");
  if (!newer(version, currentVersion)) return null;
  const name = `codex-decision-${version}.vsix`;
  const assets = Array.isArray(release.assets) ? release.assets.filter(asset => asset?.name === name) : [];
  if (assets.length !== 1) throw refusal("The Decision release does not contain one matching VSIX");
  const asset = assets[0];
  const url = `${RELEASE_BASE}${release.tag_name}/${name}`;
  if (asset.browser_download_url !== url || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_VSIX_BYTES ||
      typeof asset.digest !== "string" || !/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest)) {
    throw refusal("The Decision VSIX has invalid download metadata or no SHA-256 digest");
  }
  return { version, name, url, size: asset.size, sha256: asset.digest.slice(7).toLowerCase() };
}

function safeUrl(value, initial, asset) {
  let url;
  try { url = new URL(value); } catch { throw refusal("GitHub update redirected to an invalid URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || url.hash ||
      !(url.href === initial || asset && ["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname))) {
    throw refusal("GitHub update redirected outside its release download hosts");
  }
  return url;
}

// One wall-clock deadline covers headers, stalled bodies, and every redirect.
async function requestBytes(initial, { maxBytes, asset = false, timeoutMs = 30_000, signal, get = https.get } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_VSIX_BYTES) throw refusal("GitHub update response size limit is invalid");
  const deadline = Date.now() + timeoutMs;
  let next = initial;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const url = safeUrl(next, initial, asset);
    if (signal?.aborted) throw cancelled();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw refusal("GitHub update request timed out");
    const reply = await new Promise((resolve, reject) => {
      let request, response, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) { response?.destroy(); request?.destroy(); reject(error); }
        else resolve(value);
      };
      const abort = () => finish(cancelled());
      const timer = setTimeout(() => finish(refusal("GitHub update request timed out")), remaining);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        request = get(url, { headers: { "User-Agent": "Codex-Decision-Updater", Accept: asset ? "application/octet-stream" : "application/vnd.github+json" } }, incoming => {
          response = incoming;
          if ([301, 302, 303, 307, 308].includes(incoming.statusCode)) {
            let redirect;
            try { redirect = new URL(incoming.headers.location, url).href; }
            catch { finish(refusal("GitHub update returned an invalid redirect")); return; }
            incoming.destroy();
            finish(null, { redirect });
            return;
          }
          if (incoming.statusCode !== 200) { finish(refusal(`GitHub update request returned HTTP ${Number(incoming.statusCode) || 0}`)); return; }
          if (incoming.headers["content-length"] && (!/^\d+$/.test(incoming.headers["content-length"]) || Number(incoming.headers["content-length"]) > maxBytes)) {
            finish(refusal("GitHub update response exceeds the size limit")); return;
          }
          const chunks = [];
          let length = 0;
          incoming.on("error", () => finish(refusal("GitHub update response failed")));
          incoming.on("aborted", () => finish(refusal("GitHub update response was interrupted")));
          incoming.on("data", chunk => {
            length += chunk.length;
            if (length > maxBytes) finish(refusal("GitHub update response exceeds the size limit"));
            else chunks.push(chunk);
          });
          incoming.on("end", () => finish(null, { bytes: Buffer.concat(chunks, length) }));
        });
        request.on("error", () => finish(refusal("GitHub update request failed")));
      } catch { finish(refusal("GitHub update request failed")); }
    });
    if (reply.bytes) return reply.bytes;
    next = reply.redirect;
  }
  throw refusal("GitHub update exceeded the redirect limit");
}

async function temporaryRoot(selected = os.tmpdir()) {
  if (!path.isAbsolute(selected) || /^(?:d:[\\/]|\/mnt\/d(?:\/|$))/i.test(selected)) {
    throw refusal("Decision update downloads need a temporary directory outside D:");
  }
  const root = path.resolve(selected);
  for (let current = root; ; current = path.dirname(current)) {
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw refusal("Decision update temporary path contains a link or invalid directory");
    if (path.dirname(current) === current) break;
  }
  const resolved = await realpath(root);
  if (/^(?:d:[\\/]|\/mnt\/d(?:\/|$))/i.test(resolved)) throw refusal("Decision update downloads need a temporary directory outside D:");
  return resolved;
}

async function downloadRelease(candidate, options = {}) {
  const request = options.request || requestBytes;
  const bytes = await request(candidate.url, { maxBytes: candidate.size, asset: true, timeoutMs: 120_000, signal: options.signal });
  if (options.signal?.aborted) throw cancelled();
  if (bytes.length !== candidate.size || createHash("sha256").update(bytes).digest("hex") !== candidate.sha256) {
    throw refusal("The downloaded Decision VSIX does not match GitHub's SHA-256 digest and size");
  }
  const root = await temporaryRoot(options.tempRoot);
  const directory = await fs.mkdtemp(path.join(root, "codex-decision-update-"));
  const filename = path.join(directory, candidate.name);
  const cleanup = async () => {
    if (await temporaryRoot(root) !== root || path.dirname(directory) !== root ||
        !(await fs.lstat(directory)).isDirectory() || (await fs.lstat(directory)).isSymbolicLink()) {
      throw refusal("Decision update temporary cleanup path changed");
    }
    const entries = await fs.readdir(directory);
    if (entries.some(entry => entry !== candidate.name)) throw refusal("Decision update temporary directory contains unknown files");
    if (entries.length) {
      const info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== candidate.size) throw refusal("Decision update temporary VSIX changed");
      const file = await fs.open(filename, "r");
      const hash = createHash("sha256");
      try {
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (offset < candidate.size) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, candidate.size - offset), offset);
          if (!bytesRead) throw refusal("Decision update temporary VSIX changed");
          hash.update(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
      } finally { await file.close(); }
      const after = await fs.lstat(filename);
      if (!after.isFile() || after.isSymbolicLink() || after.size !== info.size || after.ino !== info.ino ||
          after.dev !== info.dev || after.mtimeMs !== info.mtimeMs || hash.digest("hex") !== candidate.sha256) {
        throw refusal("Decision update temporary VSIX changed");
      }
      await fs.unlink(filename);
    }
    await fs.rmdir(directory);
  };
  try {
    await fs.writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
    return { filename, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

function activateUpdates(vscode, context, options = {}) {
  if (!vscode.commands?.registerCommand || !vscode.commands?.executeCommand || !vscode.Uri?.file ||
      !vscode.window?.createOutputChannel || !vscode.workspace?.getConfiguration || !context.subscriptions) return null;
  const output = vscode.window.createOutputChannel("Decision Updates");
  const request = options.request || requestBytes;
  const download = options.download || downloadRelease;
  const now = options.now || Date.now;
  const enabled = () => vscode.workspace.getConfiguration("codexDecision").get("autoUpdate", true) !== false;
  const production = vscode.ExtensionMode?.Production != null && context.extensionMode === vscode.ExtensionMode.Production;
  const loadedVersion = options.currentVersion || CURRENT_VERSION;
  let installedVersion = loadedVersion;
  output.appendLine(`Decision updater loaded for control ${loadedVersion}.`);
  let inFlight = null, controller = null, disposed = false, activeManual = false;
  function notify(method, message, action) {
    try {
      void Promise.resolve(vscode.window[method](message, ...(action ? [action] : []))).then(async selected => {
        if (selected !== "Reload Window") return;
        // The current check owns temporary files until its finally block completes.
        const pending = inFlight;
        if (pending) await pending;
        if (!disposed) return vscode.commands.executeCommand("workbench.action.reloadWindow");
      }).catch(() => {});
    } catch { /* Notifications must not hold installation or cleanup open. */ }
  }
  async function check({ manual = false } = {}) {
    if (disposed) return { status: "cancelled" };
    if (inFlight) return inFlight;
    const lastCheck = context.globalState?.get?.(LAST_CHECK);
    if (!manual && (!production || !enabled() || typeof lastCheck === "number" && lastCheck <= now() && now() - lastCheck < DAY_MS)) {
      return { status: "skipped" };
    }
    controller = new AbortController();
    activeManual = manual;
    const signal = controller.signal;
    const task = (async () => {
      let downloaded;
      try {
        output.appendLine(`Checking GitHub releases for an update to Decision ${installedVersion}.`);
        await context.globalState?.update?.(LAST_CHECK, now());
        const bytes = await request(RELEASE_API, { maxBytes: 1_000_000, signal });
        let release;
        try { release = JSON.parse(bytes.toString("utf8")); } catch { throw refusal("GitHub returned invalid Decision release metadata"); }
        const candidate = releaseCandidate(release, installedVersion);
        if (!candidate) {
          output.appendLine(`No newer stable Decision release than ${installedVersion} is available.`);
          if (manual) notify("showInformationMessage", installedVersion === loadedVersion
            ? `Decision ${installedVersion} is up to date.`
            : `Decision ${installedVersion} is installed. Reload VS Code to activate the update.`,
          installedVersion === loadedVersion ? undefined : "Reload Window");
          return { status: "current", version: installedVersion };
        }
        downloaded = await download(candidate, { request, signal, tempRoot: options.tempRoot });
        if (disposed || signal.aborted || !manual && !enabled()) throw cancelled();
        // A Uri selects VSIX installation. A string would select a Marketplace ID.
        await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(downloaded.filename));
        installedVersion = candidate.version;
        output.appendLine(`Decision ${installedVersion} was installed from its verified GitHub release VSIX. Reload VS Code to activate it.`);
        if (!disposed) notify("showInformationMessage", `Decision ${installedVersion} is installed. Reload VS Code to activate the update.`, "Reload Window");
        return { status: "installed", version: installedVersion };
      } catch (error) {
        if (signal.aborted || disposed || error?.cancelled) return { status: "cancelled" };
        const message = error?.decisionUpdate ? error.message : "Decision update failed during download or installation; check file access and VS Code extension installation";
        output.appendLine(message);
        if (manual) notify("showWarningMessage", message);
        return { status: "failed", message };
      } finally {
        if (downloaded) {
          try { await downloaded.cleanup(); }
          catch { if (!disposed) output.appendLine("Decision update temporary files could not be removed safely."); }
        }
      }
    })();
    inFlight = task;
    try { return await task; }
    finally { if (inFlight === task) { inFlight = null; controller = null; } }
  }
  const startup = setTimeout(() => { void check(); }, options.delayMs ?? 2000);
  const interval = setInterval(() => { void check(); }, options.checkEveryMs ?? 60 * 60 * 1000);
  startup.unref?.(); interval.unref?.();
  const disposable = { dispose() { disposed = true; clearTimeout(startup); clearInterval(interval); controller?.abort(); } };
  context.subscriptions.push(output, vscode.commands.registerCommand("codexDecision.checkForUpdates", () => check({ manual: true })), disposable);
  if (vscode.workspace?.onDidChangeConfiguration) context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("codexDecision.autoUpdate") && !enabled() && !activeManual) controller?.abort();
  }));
  return { check, dispose: () => disposable.dispose() };
}

module.exports = { activateUpdates, releaseCandidate, downloadRelease, requestBytes, temporaryRoot, RELEASE_API };
