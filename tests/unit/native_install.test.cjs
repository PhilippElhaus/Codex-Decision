"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { install, FILES } = require("../../vscode-control/install-plugin-native");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-native-install-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home with spaces"), payload = path.join(root, "payload");
  await fs.mkdir(home);
  for (const filename of FILES) {
    const target = path.join(payload, filename);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, filename === ".codex-plugin/plugin.json"
      ? JSON.stringify({ name: "codex-decision", version: "1.0.0" }) : `bundled ${filename}`);
  }
  const codexHome = path.join(home, ".codex"), commands = [];
  let current = null;
  let source = path.join(home, ".local/share/codex-decision/plugins/codex-decision");
  let roots = [];
  let afterPrune = async () => {};
  async function cache() {
    const destination = path.join(codexHome, "plugins/cache", current.marketplaceName, "codex-decision", current.version);
    await fs.cp(source, destination, { recursive: true });
    return destination;
  }
  const run = async (_binary, args) => {
    commands.push(args);
    if (args[0] === "list") return { installed: current ? [current] : [] };
    if (args[0] === "marketplace" && args[1] === "list") return { marketplaces: roots };
    if (args[0] === "marketplace" && args[1] === "add") { roots = [{ name: "codex-decision-integrated", root: args[2] }]; return {}; }
    assert.equal(args[0], "add");
    const marketplace = args[1].split("@")[1];
    const manifest = JSON.parse(await fs.readFile(path.join(source, ".codex-plugin/plugin.json")));
    current = { name: "codex-decision", installed: true, enabled: true, pluginId: args[1],
      marketplaceName: marketplace, version: manifest.version, source: { source: "local", path: source } };
    await fs.rm(path.join(codexHome, "plugins/cache", marketplace, "codex-decision"), { recursive: true, force: true });
    await afterPrune();
    await cache();
    return {};
  };
  const options = { home, codexHome, payload, codex: path.join(root, "codex.exe"), run };
  return { root, home, payload, codexHome, commands, options, cache,
    get current() { return current; }, set roots(value) { roots = value; }, set afterPrune(value) { afterPrune = value; },
    async existing(version = "1.0.0") {
      source = path.join(home, "personal/plugins/codex-decision");
      await fs.cp(payload, source, { recursive: true });
      await fs.writeFile(path.join(source, ".codex-plugin/plugin.json"), JSON.stringify({ name: "codex-decision", version }));
      current = { name: "codex-decision", installed: true, enabled: true, pluginId: "codex-decision@personal",
        marketplaceName: "personal", version, source: { source: "local", path: source } };
      roots = [{ name: "personal", root: path.join(home, "personal") }];
      await cache();
      return source;
    },
  };
}

test("native fresh install registers once and repeat verification writes no package files", async t => {
  const f = await fixture(t);
  const first = await install(f.options);
  assert.equal(first.status, "installed");
  assert.equal(first.decisionctl, path.join(first.pluginRoot, "hooks/bin/windows-x86_64/decisionctl.exe"));
  assert.equal(f.commands.filter(args => args[0] === "add").length, 1);
  const manifest = path.join(first.pluginRoot, ".codex-plugin/plugin.json");
  const before = (await fs.stat(manifest)).mtimeMs;
  f.commands.length = 0;
  const second = await install(f.options);
  assert.equal(second.status, "ready");
  assert.equal((await fs.stat(manifest)).mtimeMs, before);
  assert.equal(f.commands.filter(args => args[0] === "add").length, 0);
});

test("native upgrade preserves plugin identity, credentials, trust, and unknown files", async t => {
  const f = await fixture(t), source = await f.existing("0.9.0");
  await fs.writeFile(path.join(source, "operator-notes"), "preserve");
  await fs.writeFile(path.join(f.codexHome, "config.toml"), "preserve trust");
  const data = path.join(f.codexHome, "plugins/data/codex-decision-personal");
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(data, "settings.json"), "preserve settings");
  const result = await install({ ...f.options, dataDirectory: data });
  assert.equal(result.pluginId, "codex-decision@personal");
  assert.equal(await fs.readFile(path.join(source, "operator-notes"), "utf8"), "preserve");
  assert.equal(await fs.readFile(path.join(f.codexHome, "config.toml"), "utf8"), "preserve trust");
  assert.equal(await fs.readFile(path.join(data, "settings.json"), "utf8"), "preserve settings");
  assert.equal(JSON.parse(await fs.readFile(path.join(result.rollback, ".codex-plugin/plugin.json"))).version, "0.9.0");
});

test("native same-version damaged source and cache are repaired", async t => {
  const f = await fixture(t), source = await f.existing();
  const activeCache = path.join(f.codexHome, "plugins/cache/personal/codex-decision/1.0.0");
  await fs.writeFile(path.join(activeCache, "cache-only-helper"), "active thread helper");
  await fs.mkdir(path.join(activeCache, "cache-only-empty-directory"));
  await fs.writeFile(path.join(source, "hooks/hooks.json"), "damaged");
  assert.equal((await install(f.options)).status, "installed");
  assert.equal(await fs.readFile(path.join(activeCache, "cache-only-helper"), "utf8"), "active thread helper");
  assert.equal((await fs.stat(path.join(activeCache, "cache-only-empty-directory"))).isDirectory(), true);
  const cache = await f.cache();
  await fs.writeFile(path.join(cache, "hooks/bin/windows-x86_64/decision-hook.exe"), "damaged");
  assert.equal((await install(f.options)).status, "installed");
});

test("native upgrades retain every previous cache, extra files, empty directories, and executable modes", async t => {
  const f = await fixture(t);
  await f.existing("0.9.0");
  const cacheRoot = path.join(f.codexHome, "plugins/cache/personal/codex-decision");
  const previous = path.join(cacheRoot, "0.9.0"), older = path.join(cacheRoot, "0.8.0");
  await fs.cp(previous, older, { recursive: true });
  await fs.writeFile(path.join(older, ".codex-plugin/plugin.json"), JSON.stringify({ name: "codex-decision", version: "0.8.0" }));
  await fs.writeFile(path.join(older, "operator-notes"), "retain unique cache content");
  await fs.mkdir(path.join(older, "empty-directory"));
  const executable = path.join(previous, "hooks/bin/linux-x86_64/decision-hook");
  await fs.chmod(executable, 0o751);
  const before = await Promise.all(FILES.map(name => fs.readFile(path.join(previous, name))));
  const result = await install(f.options);
  for (let index = 0; index < FILES.length; index++) assert.deepEqual(await fs.readFile(path.join(previous, FILES[index])), before[index]);
  assert.equal(await fs.readFile(path.join(older, "operator-notes"), "utf8"), "retain unique cache content");
  assert.equal((await fs.stat(path.join(older, "empty-directory"))).isDirectory(), true);
  if (process.platform !== "win32") assert.equal((await fs.stat(executable)).mode & 0o777, 0o751);
  assert.equal((await fs.stat(path.join(result.cacheRollback, "cache/0.8.0/operator-notes"))).isFile(), true);
  const backups = await fs.readdir(path.dirname(result.cacheRollback));
  await install(f.options);
  assert.deepEqual(await fs.readdir(path.dirname(result.cacheRollback)), backups);
});

test("failed native same-version refresh restores removed active hook paths and keeps conflict evidence", async t => {
  const f = await fixture(t), source = await f.existing();
  const current = path.join(f.codexHome, "plugins/cache/personal/codex-decision/1.0.0");
  const binary = path.join(current, "hooks/bin/windows-x86_64/decision-hook.exe");
  const original = await fs.readFile(binary);
  await fs.writeFile(path.join(source, "hooks/hooks.json"), "repair needed");
  f.afterPrune = async () => { throw new Error("synthetic add failure"); };
  await assert.rejects(install(f.options));
  assert.deepEqual(await fs.readFile(binary), original);
  f.afterPrune = async () => {
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, "concurrent unique bytes");
    throw new Error("synthetic add failure");
  };
  await fs.writeFile(path.join(source, "hooks/hooks.json"), "repair needed again");
  await assert.rejects(install(f.options), /active Decision cache changed/);
  assert.equal(await fs.readFile(binary, "utf8"), "concurrent unique bytes");
  const backups = path.join(f.home, ".local/state/codex-decision/cache-rollbacks");
  assert((await fs.readdir(backups)).length >= 2);
});

test("native cache refresh rejects sensitive files, inconsistent ownership, and linked extras before source mutation", async t => {
  const f = await fixture(t), source = await f.existing("0.9.0");
  const cache = path.join(f.codexHome, "plugins/cache/personal/codex-decision/0.9.0");
  const before = await fs.readFile(path.join(source, ".codex-plugin/plugin.json"));
  const sensitive = path.join(cache, ".env");
  await fs.writeFile(sensitive, "synthetic secret-shaped file");
  await assert.rejects(install(f.options), /unsafe or unknown/);
  await fs.unlink(sensitive);
  const manifest = path.join(cache, ".codex-plugin/plugin.json");
  await fs.writeFile(manifest, JSON.stringify({ name: "unrelated", version: "0.9.0" }));
  await assert.rejects(install(f.options), /unsafe or unknown/);
  await fs.writeFile(manifest, before);
  await fs.symlink(f.payload, path.join(cache, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(install(f.options), /links or junctions/);
  assert.deepEqual(await fs.readFile(path.join(source, ".codex-plugin/plugin.json")), before);
  assert.equal(f.commands.filter(args => args[0] === "add").length, 0);
});

test("native cache recovery refuses a surviving hook whose executable mode changed", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await f.existing("0.9.0");
  const hook = path.join(f.codexHome, "plugins/cache/personal/codex-decision/0.9.0/hooks/bin/linux-x86_64/decision-hook");
  const original = await fs.readFile(hook);
  await fs.chmod(hook, 0o755);
  f.afterPrune = async () => {
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, original);
    await fs.chmod(hook, 0o600);
    throw new Error("synthetic add failure");
  };
  await assert.rejects(install(f.options), /active Decision cache changed/);
  assert.equal((await fs.stat(hook)).mode & 0o777, 0o600);
});

test("native mismatched data path, disabled plugin, and downgrade refuse before package writes", async t => {
  const f = await fixture(t), source = await f.existing("2.0.0");
  const before = await fs.readFile(path.join(source, ".codex-plugin/plugin.json"));
  await assert.rejects(install(f.options), /newer than/);
  f.current.version = "1.0.0";
  f.current.enabled = false;
  await assert.rejects(install(f.options), /disabled in Codex/);
  f.current.enabled = true;
  await assert.rejects(install({ ...f.options, dataDirectory: path.join(f.home, "wrong") }), /dataDirectory does not match/);
  assert.deepEqual(await fs.readFile(path.join(source, ".codex-plugin/plugin.json")), before);
  assert.equal(f.commands.filter(args => args[0] === "add").length, 0);
});

test("native links and development repositories refuse before package writes", async t => {
  const f = await fixture(t), source = await f.existing();
  await fs.mkdir(path.join(source, ".git"));
  await assert.rejects(install(f.options), /development repository/);
  await fs.rmdir(path.join(source, ".git"));
  const target = path.join(source, "hooks");
  await fs.rm(target, { recursive: true });
  await fs.symlink(path.join(f.payload, "hooks"), target, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(install(f.options), /links or junctions/);
});

test("native marketplace collision and incomplete payload refuse before source creation", async t => {
  const f = await fixture(t);
  f.roots = [{ name: "codex-decision-integrated", root: path.join(f.home, "unknown") }];
  await assert.rejects(install(f.options), /already registered/);
  f.roots = [];
  await fs.unlink(path.join(f.payload, "hooks/bin/windows-x86_64/decision-hook.exe"));
  await assert.rejects(install(f.options), /incomplete hook payload/);
  assert.equal(f.commands.filter(args => args[0] === "add").length, 0);
});

test("native installer hides private OS errors", async t => {
  const f = await fixture(t);
  const run = async () => { throw Object.assign(new Error("PRIVATE-content-path"), { code: "EBUSY" }); };
  await assert.rejects(install({ ...f.options, run }), error => {
    assert.equal(error.retryable, true);
    assert.match(error.message, /Codex plugin discovery/);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
});

test("concurrent native installs serialize registration and release the lock", async t => {
  const f = await fixture(t);
  const options = { ...f.options, run: async (...args) => {
    assert.equal((await fs.stat(path.join(f.codexHome, "plugins/.companion-install.lock"))).isFile(), true);
    return f.options.run(...args);
  } };
  const results = await Promise.all([install(options), install(options)]);
  assert.deepEqual(results.map(result => result.status).sort(), ["installed", "ready"]);
  assert.equal(f.commands.filter(args => args[0] === "add").length, 1);
  assert.equal((await install(f.options)).status, "ready");
});

test("native Windows accepts canonical data paths with different letter case", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  await f.existing();
  const dataDirectory = path.join(f.codexHome, "plugins/data/codex-decision-personal").toUpperCase();
  const result = await install({ ...f.options, dataDirectory });
  assert.equal(result.status, "ready");
  assert.equal(result.dataDirectory.toUpperCase(), dataDirectory);
});

test("Windows lock contention retries; unavailable and interrupted locks keep distinct diagnostics", async () => {
  const vm = require("node:vm");
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const source = await fs.readFile(require.resolve("../../vscode-control/install-plugin-native"), "utf8");
  for (const outcome of ["busy", "unavailable", "spawn-error", "interrupted", "ready"]) {
    let entered = false, helper;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.once("finish", () => child.emit("exit", 0));
    const context = { module: { exports: {} }, process: { platform: "win32", env: {} }, Buffer, setTimeout, clearTimeout,
      require(request) {
        if (request === "node:path") return path.win32;
        if (request === "node:fs/promises") return { mkdir: async () => {},
          lstat: async () => ({ isSymbolicLink: () => false, isFile: () => true }) };
        if (request === "node:child_process") return { execFile: require(request).execFile,
          spawn(_executable, args) {
            helper = args.at(-1);
            queueMicrotask(() => {
              if (outcome === "spawn-error") child.emit("error", new Error("PRIVATE-process-detail"));
              else if (outcome === "busy" || outcome === "unavailable") child.emit("exit", outcome === "busy" ? 2 : 3);
              else child.stdout.write("locked\n");
            });
            return child;
          } };
        return require(request);
      } };
    vm.runInNewContext(`${source}\nmodule.exports.withLock = withLock;`, context);
    const operation = () => { entered = true; if (outcome === "interrupted") child.emit("exit", 1); return "installed"; };
    const result = context.module.exports.withLock("C:\\fixture", operation);
    if (outcome === "ready") assert.equal(await result, "installed");
    else await assert.rejects(result, error => {
      assert.equal(error.retryable === true, outcome === "busy" || outcome === "interrupted");
      assert.match(error.message, outcome === "busy" ? /busy/ : outcome === "interrupted" ? /interrupted/ : /unavailable/);
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
    assert.equal(entered, outcome === "ready" || outcome === "interrupted");
    assert.match(helper, /-notin @\(32,33\)/);
  }
});
