"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const test = require("node:test");
const core = require("../../vscode-control/core");
const { readLatestPanelDecision } = require("../../vscode-control/panel-state");

const distro = process.env.CODEX_JEV_TEST_WSL_DISTRO;
test("native Windows reads panel snapshots and preserves private WSL session state", {
  skip: process.platform !== "win32" || !distro,
  timeout: 60_000,
}, async () => {
  assert.match(distro, /^[A-Za-z0-9_-]+$/);
  const run = (args) => execFile("wsl.exe", ["-d", distro, "-e", ...args],
    { timeout: 15_000, maxBuffer: 8192 });
  const created = await run(["mktemp", "-d", "-p", "/tmp", "jev-wsl-native-XXXXXXXX"]);
  const linuxRoot = created.stdout.trim();
  assert.match(linuxRoot, /^\/tmp\/jev-wsl-native-[A-Za-z0-9]{8}$/);
  const directory = `\\\\wsl.localhost\\${distro}${linuxRoot.replaceAll("/", "\\")}`;
  try {
    const one = core.sessionDirectory(directory, "synthetic-one");
    const two = core.sessionDirectory(directory, "synthetic-two");
    await core.ensureSessionDefaults(one);
    await core.ensureSessionDefaults(two);
    await core.writeSelection(one, false);
    await core.writeGlobalSettings(directory, { mode: "observe", log_limit_mb: 50 });
    assert.equal((await core.readConfig(one)).enabled, false);
    assert.equal((await core.readConfig(two)).enabled, true);
    assert.equal((await core.readGlobalSettings(directory)).mode, "observe");
    const logs = path.join(one, "logs");
    await fs.mkdir(logs);
    const snapshot = { version: 4, id: "a".repeat(32), receipt_id: "b".repeat(32),
      at: "2020-01-01T00:00:00Z", filter: "output", status: "keep",
      batch: { number: 1, count: 1, target_count: 1 }, batch_elapsed_ms: 25,
      rows: [{ line: 1, excerpt: "Synthetic Windows build completed", action: "keep",
        reason: "task_relevant", task_relevant: .95 }],
      totals: { seen: 1, judged: 1, kept: 1, omitted: 0, protected: 0, unjudged: 0, requests: 2 } };
    await fs.writeFile(path.join(logs, "latest-decision.json"), JSON.stringify(snapshot));
    const cache = {};
    assert.equal((await readLatestPanelDecision(one, cache)).rows[0].excerpt, snapshot.rows[0].excerpt);
    snapshot.id = "c".repeat(32);
    const replacement = path.join(logs, "latest-decision.new");
    await fs.writeFile(replacement, JSON.stringify(snapshot));
    await fs.rename(replacement, path.join(logs, "latest-decision.json"));
    assert.equal((await readLatestPanelDecision(one, cache)).id, snapshot.id);
    const linuxSnapshot = `${linuxRoot}/sessions/${path.basename(one)}/logs/latest-decision.json`;
    let writerDone = false;
    const writer = run(["python3", "-c",
      "import json,os,pathlib,sys,time; target=pathlib.Path(sys.argv[1]); value=json.loads(target.read_text()); " +
      "temporary=target.with_name('latest-decision.new')" +
      "\nfor sequence in range(1,101):" +
      "\n value['id']=f'{sequence:032x}'; value['rows'][0]['excerpt']=f'Synthetic revision {sequence}'; " +
      "temporary.write_text(json.dumps(value)); temporary.chmod(0o600); os.replace(temporary,target); time.sleep(.002)",
      linuxSnapshot]).finally(() => { writerDone = true; });
    const readers = Array.from({ length: 4 }, async () => {
      const readerCache = {};
      do {
        const current = await readLatestPanelDecision(one, readerCache);
        assert.ok(current.rows[0].excerpt === snapshot.rows[0].excerpt ||
          current.rows[0].excerpt === `Synthetic revision ${Number.parseInt(current.id, 16)}`);
      } while (!writerDone);
      assert.equal((await readLatestPanelDecision(one, readerCache)).id, (100).toString(16).padStart(32, "0"));
    });
    const results = await Promise.allSettled([writer, ...readers]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const metadata = await run(["python3", "-c",
      "import json,os,stat,sys; root=sys.argv[1]; result={}; " +
      "\nfor base,dirs,files in os.walk(root):" +
      "\n for name in dirs+files:" +
      "\n  target=os.path.join(base,name); info=os.lstat(target); assert not stat.S_ISLNK(info.st_mode); " +
      "result[os.path.relpath(target,root)]=stat.S_IMODE(info.st_mode)" +
      "\nprint(json.dumps(result))", linuxRoot]);
    const modes = JSON.parse(metadata.stdout);
    const oneName = path.basename(one);
    const twoName = path.basename(two);
    for (const name of [oneName, twoName]) {
      assert.equal(modes[`sessions/${name}`], 0o700);
      assert.equal(modes[`sessions/${name}/config.json`], 0o600);
    }
    assert.equal(modes["settings.json"], 0o600);
  } finally {
    // Only this test's verified, link-free /tmp fixture can be removed.
    await run(["python3", "-c",
      "import os,pathlib,shutil,stat,sys; root=pathlib.Path(sys.argv[1]); " +
      "assert root.parent==pathlib.Path('/tmp') and root.name.startswith('jev-wsl-native-'); " +
      "assert root.resolve()==root and root.stat().st_uid==os.geteuid(); " +
      "assert all(not stat.S_ISLNK(os.lstat(p).st_mode) for p in root.rglob('*')); shutil.rmtree(root)", linuxRoot]);
  }
});
