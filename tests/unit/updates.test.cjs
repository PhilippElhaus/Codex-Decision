"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { activateUpdates, releaseCandidate, downloadRelease, requestBytes, temporaryRoot, RELEASE_API } = require("../../vscode-control/updates");

const vsix = Buffer.from("synthetic verified Decision VSIX");
function release(version = "0.16.0") {
  const name = `codex-decision-${version}.vsix`;
  return { tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ name, size: vsix.length,
    browser_download_url: `https://github.com/PhilippElhaus/Codex-Decision/releases/download/v${version}/${name}`,
    digest: `sha256:${createHash("sha256").update(vsix).digest("hex")}` }] };
}
async function fixture(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-update-test-"));
  try { await operation(root); } finally { await fs.rm(root, { recursive: true }); }
}

test("only a newer stable release with one exact digest-bound VSIX is selected", () => {
  assert.equal(releaseCandidate(release("0.15.1"), "0.15.1"), null);
  assert.equal(releaseCandidate(release("0.15.0"), "0.15.1"), null);
  assert.equal(releaseCandidate(release("0.16.0"), "0.15.10").version, "0.16.0");
  for (const modify of [
    value => { value.draft = true; }, value => { value.prerelease = true; },
    value => { value.tag_name = "v0.16.0-beta.1"; }, value => { value.tag_name = "v00.16.0"; },
    value => { value.assets = []; }, value => { value.assets.push(value.assets[0]); },
    value => { value.assets[0].digest = null; }, value => { value.assets[0].digest = "sha256:invalid"; },
    value => { value.assets[0].size = 50_000_001; }, value => { value.assets[0].size = -1; },
    value => { value.assets[0].browser_download_url = "https://github.com/another/repo/releases/download/v0.16.0/codex-decision-0.16.0.vsix"; },
    value => { value.assets[0].browser_download_url += "?download=1"; },
  ]) {
    const metadata = release(); modify(metadata);
    assert.throws(() => releaseCandidate(metadata, "0.15.1"));
  }
});

function transport(routes, calls = []) {
  return (url, _options, callback) => {
    calls.push(url.href);
    const request = new EventEmitter();
    request.destroy = () => {};
    setImmediate(() => {
      const route = routes[url.href];
      if (!route) { request.emit("error", new Error("private network diagnostic")); return; }
      const response = new PassThrough();
      response.statusCode = route.status || 200;
      response.headers = route.headers || {};
      callback(response);
      if (route.respond) route.respond(response);
      else response.end(route.body || "");
    });
    return request;
  };
}

test("HTTPS transport follows only bounded official release-asset redirects", async () => {
  const candidate = releaseCandidate(release(), "0.15.1");
  const target = "https://release-assets.githubusercontent.com/github-production-release-asset/123/file?signature=public";
  const calls = [];
  const get = transport({ [candidate.url]: { status: 302, headers: { location: target } }, [target]: { body: vsix } }, calls);
  assert.deepEqual(await requestBytes(candidate.url, { asset: true, maxBytes: 100, get }), vsix);
  assert.deepEqual(calls, [candidate.url, target]);
  for (const location of ["http://release-assets.githubusercontent.com/file", "https://release-assets.githubusercontent.com.evil.test/file",
    "https://user:secret@release-assets.githubusercontent.com/file", "https://github.com/another/repo/file", "https://release-assets.githubusercontent.com:444/file"]) {
    const attempted = [];
    await assert.rejects(requestBytes(candidate.url, { asset: true, maxBytes: 100,
      get: transport({ [candidate.url]: { status: 302, headers: { location } } }, attempted) }), /outside its release download hosts/);
    assert.equal(attempted.length, 1);
  }
  await assert.rejects(requestBytes(RELEASE_API, { maxBytes: 100,
    get: transport({ [RELEASE_API]: { status: 302, headers: { location: target } } }) }), /outside its release download hosts/);
  await assert.rejects(requestBytes(candidate.url, { asset: true, maxBytes: 100,
    get: transport({ [candidate.url]: { status: 302, headers: { location: candidate.url } } }) }), /redirect limit/);
});

test("HTTPS transport bounds bodies, wall-clock time, HTTP failures, and cancellation", async () => {
  for (const route of [{ body: "oversize" }, { headers: { "content-length": "100" } }]) {
    await assert.rejects(requestBytes(RELEASE_API, { maxBytes: 4, get: transport({ [RELEASE_API]: route }) }), /size limit/);
  }
  await assert.rejects(requestBytes(RELEASE_API, { maxBytes: 100,
    get: transport({ [RELEASE_API]: { status: 403 } }) }), /HTTP 403/);
  let timer;
  try {
    await assert.rejects(requestBytes(RELEASE_API, { maxBytes: 1000, timeoutMs: 35,
      get: transport({ [RELEASE_API]: { respond(response) { timer = setInterval(() => response.write("x"), 5); } } }) }), /timed out/);
  } finally { clearInterval(timer); }
  const controller = new AbortController();
  const pending = requestBytes(RELEASE_API, { maxBytes: 100, signal: controller.signal,
    get: transport({ [RELEASE_API]: { respond() { controller.abort(); } } }) });
  await assert.rejects(pending, /cancelled/);
});

test("downloads verify digest and exact size before creating a private temporary VSIX", async () => fixture(async root => {
  const candidate = releaseCandidate(release(), "0.15.1");
  for (const bytes of [Buffer.from(vsix.toString().replace("verified", "tampered")), vsix.subarray(0, -1)]) {
    await assert.rejects(downloadRelease(candidate, { tempRoot: root, request: async () => bytes }), /SHA-256 digest and size/);
    assert.deepEqual(await fs.readdir(root), []);
  }
  const download = await downloadRelease(candidate, { tempRoot: root, request: async (url, options) => {
    assert.equal(url, candidate.url); assert.equal(options.maxBytes, candidate.size); assert.equal(options.asset, true);
    return vsix;
  } });
  assert.deepEqual(await fs.readFile(download.filename), vsix);
  if (process.platform !== "win32") assert.equal((await fs.stat(download.filename)).mode & 0o777, 0o600);
  await download.cleanup();
  assert.deepEqual(await fs.readdir(root), []);
}));

test("temporary paths reject drive D and links, and cleanup preserves unknown content", async () => fixture(async root => {
  for (const target of ["D:\\Temp", "/mnt/d/tmp"]) await assert.rejects(temporaryRoot(target), /outside D:/);
  if (process.platform !== "win32") {
    const linked = path.join(root, "linked");
    await fs.symlink(root, linked);
    await assert.rejects(temporaryRoot(linked), /contains a link/);
  }
  const downloaded = await downloadRelease(releaseCandidate(release(), "0.15.1"), { tempRoot: root, request: async () => vsix });
  const unknown = path.join(path.dirname(downloaded.filename), "unknown.txt");
  await fs.writeFile(unknown, "preserve");
  await assert.rejects(downloaded.cleanup(), /unknown files/);
  assert.equal(await fs.readFile(unknown, "utf8"), "preserve");
  await fs.unlink(unknown);
  const changed = Buffer.from(vsix);
  changed[0] ^= 1;
  await fs.writeFile(downloaded.filename, changed);
  await assert.rejects(downloaded.cleanup(), /VSIX changed/);
  assert.deepEqual(await fs.readFile(downloaded.filename), changed, "cleanup must preserve changed same-name content");
  await fs.writeFile(downloaded.filename, vsix);
  await downloaded.cleanup();
}));

function activation(options = {}) {
  const commands = new Map(), calls = [], notifications = [], log = [], values = new Map();
  const config = { autoUpdate: true };
  let configListener;
  const context = { extensionMode: 1, subscriptions: [], globalState: { get: key => values.get(key), update: async (key, value) => values.set(key, value) } };
  const vscode = {
    ExtensionMode: { Production: 1, Development: 2 }, Uri: { file: filename => ({ scheme: "file", fsPath: filename }) },
    commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; },
      async executeCommand(...args) { calls.push(args); } },
    window: { createOutputChannel: () => ({ appendLine: line => log.push(line), dispose() {} }),
      showInformationMessage: async (...args) => { notifications.push(args); },
      showWarningMessage: async (...args) => { notifications.push(args); } },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }),
      onDidChangeConfiguration(listener) { configListener = listener; return { dispose() {} }; } },
  };
  const cleanup = [];
  const updater = activateUpdates(vscode, context, { delayMs: 60_000, currentVersion: "0.15.1",
    request: async () => Buffer.from(JSON.stringify(release())),
    download: async () => ({ filename: "/synthetic/codex-decision-0.16.0.vsix", cleanup: async () => cleanup.push(true) }), ...options });
  return { updater, context, vscode, commands, calls, notifications, log, values, config, cleanup,
    changeConfig() { configListener({ affectsConfiguration: name => name === "codexDecision.autoUpdate" }); },
    dispose() { for (const item of context.subscriptions.reverse()) item.dispose(); } };
}

test("automatic updates use the VSIX URI and offer reload without blocking or reinstalling", async () => {
  const setup = activation();
  setup.vscode.window.showInformationMessage = (...args) => { setup.notifications.push(args); return new Promise(() => {}); };
  try {
    assert.deepEqual(await setup.updater.check(), { status: "installed", version: "0.16.0" });
    assert.deepEqual(setup.calls, [["workbench.extensions.installExtension", { scheme: "file", fsPath: "/synthetic/codex-decision-0.16.0.vsix" }]]);
    assert.deepEqual(setup.cleanup, [true]);
    assert.equal(setup.notifications[0][1], "Reload Window");
    assert.equal((await setup.commands.get("codexDecision.checkForUpdates")()).status, "current");
    assert.equal(setup.calls.length, 1, "the loaded old version must not trigger another install before reload");
    assert.match(setup.notifications.at(-1)[0], /Reload VS Code/);
  } finally { setup.dispose(); }
});

test("automatic checks respect production mode, settings, and daily cadence; manual checks remain available", async () => {
  let time = 1_000_000;
  let requests = 0;
  const setup = activation({ now: () => time, request: async () => { requests += 1; return Buffer.from(JSON.stringify(release("0.15.1"))); } });
  try {
    setup.config.autoUpdate = false;
    assert.equal((await setup.updater.check()).status, "skipped");
    assert.equal((await setup.commands.get("codexDecision.checkForUpdates")()).status, "current");
    setup.config.autoUpdate = true;
    assert.equal((await setup.updater.check()).status, "skipped");
    time += 24 * 60 * 60 * 1000;
    assert.equal((await setup.updater.check()).status, "current");
    assert.equal(requests, 2);
  } finally { setup.dispose(); }
  const dev = activation();
  // Production mode is captured at activation, as it is immutable in VS Code.
  dev.dispose();
  const context = { ...dev.context, extensionMode: 2, subscriptions: [] };
  const updater = activateUpdates(dev.vscode, context, { delayMs: 60_000, currentVersion: "0.15.1",
    request: async () => Buffer.from(JSON.stringify(release("0.15.1"))) });
  try {
    assert.equal((await updater.check()).status, "skipped");
    assert.equal((await updater.check({ manual: true })).status, "current");
  } finally { for (const item of context.subscriptions.reverse()) item.dispose(); }
});

test("disable and disposal abort pending automatic checks, and disabled installation is rechecked", async () => {
  for (const operation of ["disable", "dispose"]) {
    let started;
    const begun = new Promise(resolve => { started = resolve; });
    const setup = activation({ request: async (_url, { signal }) => {
      started();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("private cancellation details")), { once: true }));
    } });
    try {
      const pending = setup.updater.check();
      await begun;
      if (operation === "disable") { setup.config.autoUpdate = false; setup.changeConfig(); }
      else setup.updater.dispose();
      assert.equal((await pending).status, "cancelled");
      assert.deepEqual(setup.calls, []);
      assert.deepEqual(setup.notifications, []);
    } finally { setup.dispose(); }
  }
  const setup = activation({ download: async () => {
    setup.config.autoUpdate = false;
    return { filename: "/synthetic/update.vsix", cleanup: async () => setup.cleanup.push(true) };
  } });
  try {
    assert.equal((await setup.updater.check()).status, "cancelled");
    assert.deepEqual(setup.calls, []);
    assert.deepEqual(setup.cleanup, [true]);
  } finally { setup.dispose(); }
});

test("digest failures prevent installation and automatic failures stay quiet with safe diagnostics", async () => fixture(async root => {
  const setup = activation({ tempRoot: root, download: downloadRelease, request: async url => url === RELEASE_API
    ? Buffer.from(JSON.stringify(release())) : Buffer.from("corrupt") });
  try {
    assert.equal((await setup.updater.check()).status, "failed");
    assert.deepEqual(setup.calls, []);
    assert.deepEqual(setup.notifications, []);
    assert.match(setup.log.at(-1), /SHA-256 digest/);
    await setup.updater.check({ manual: true });
    assert.match(setup.notifications[0][0], /SHA-256 digest/);
  } finally { setup.dispose(); }
  const unsafe = activation({ request: async () => { throw new Error("private signed URL and private credentials"); } });
  try {
    await unsafe.updater.check({ manual: true });
    assert.equal(JSON.stringify([unsafe.notifications, unsafe.log]).includes("private"), false);
  } finally { unsafe.dispose(); }
}));

test("concurrent commands share one check and reload runs only after the user's action", async () => {
  let releaseRequest, started;
  const begun = new Promise(resolve => { started = resolve; });
  let requests = 0;
  const setup = activation({ request: async () => {
    requests += 1; started();
    return new Promise(resolve => { releaseRequest = resolve; });
  } });
  let choose;
  setup.vscode.window.showInformationMessage = () => new Promise(resolve => { choose = resolve; });
  try {
    const first = setup.updater.check({ manual: true });
    await begun;
    const second = setup.updater.check({ manual: true });
    releaseRequest(Buffer.from(JSON.stringify(release())));
    assert.equal((await first).status, "installed");
    assert.equal((await second).status, "installed");
    assert.equal(requests, 1);
    assert.equal(setup.calls.length, 1);
    choose("Reload Window");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(setup.calls[1][0], "workbench.action.reloadWindow");
  } finally { setup.dispose(); }
});

test("an immediate reload selection waits until the update's temporary cleanup completes", async () => {
  let finishCleanup, cleanupStarted;
  const cleaning = new Promise(resolve => { cleanupStarted = resolve; });
  const setup = activation({ download: async () => ({ filename: "/synthetic/update.vsix", cleanup: async () => {
    cleanupStarted();
    await new Promise(resolve => { finishCleanup = resolve; });
  } }) });
  setup.vscode.window.showInformationMessage = async () => "Reload Window";
  try {
    const pending = setup.updater.check({ manual: true });
    await cleaning;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(setup.calls.length, 1, "reload must not interrupt cleanup");
    finishCleanup();
    assert.equal((await pending).status, "installed");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(setup.calls[1][0], "workbench.action.reloadWindow");
  } finally { setup.dispose(); }
});
