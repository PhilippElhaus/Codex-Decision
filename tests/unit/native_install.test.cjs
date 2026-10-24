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
    await cache();
    return {};
  };
  const options = { home, codexHome, payload, codex: path.join(root, "codex.exe"), run };
  return { root, home, payload, codexHome, commands, options, cache,
    get current() { return current; }, set roots(value) { roots = value; },
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
  await fs.writeFile(path.join(source, "hooks/hooks.json"), "damaged");
  assert.equal((await install(f.options)).status, "installed");
  const cache = await f.cache();
  await fs.writeFile(path.join(cache, "hooks/bin/windows-x86_64/decision-hook.exe"), "damaged");
  assert.equal((await install(f.options)).status, "installed");
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
  const results = await Promise.all([install(f.options), install(f.options)]);
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
