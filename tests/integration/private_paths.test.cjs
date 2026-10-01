"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { wslLocation, restrictWslPath } = require("../../vscode-control/private-paths");

test("Windows UNC permissions are applied to Linux owned inodes without following links", async () => {
  assert.deepEqual(wslLocation("\\\\wsl.localhost\\Ubuntu\\home\\fixture\\state"),
    { distro: "Ubuntu", filename: "/home/fixture/state" });
  assert.equal(wslLocation("D:\\workspace\\state"), null);
  let invocation;
  const run = async (...args) => { invocation = args; };
  await restrictWslPath("\\\\wsl$\\Ubuntu\\home\\fixture\\state", true, run, "win32");
  assert.deepEqual(invocation[1].slice(0, 6), ["-d", "Ubuntu", "-e", "python3", "-c", invocation[1][5]]);
  assert.deepEqual(invocation[1].slice(6), ["/home/fixture/state", "directory"]);
  assert.equal(invocation[2].timeout, 10_000);
  const script = invocation[1][5];
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "jev-private-"));
  try {
    const folder = path.join(fixture, "session");
    await fs.mkdir(folder, { mode: 0o755 });
    execFileSync("python3", ["-c", script, folder, "directory"]);
    assert.equal((await fs.stat(folder)).mode & 0o777, 0o700);
    const config = path.join(folder, "config.json");
    await fs.writeFile(config, "{}", { mode: 0o644 });
    execFileSync("python3", ["-c", script, config, "file"]);
    assert.equal((await fs.stat(config)).mode & 0o777, 0o600);
    const linked = path.join(fixture, "linked");
    await fs.symlink(folder, linked);
    for (const [target, kind] of [[linked, "directory"], [path.join(linked, "config.json"), "file"]]) {
      assert.throws(() => execFileSync("python3", ["-c", script, target, kind], { stdio: "pipe" }));
    }
  } finally { await fs.rm(fixture, { recursive: true }); }
  await assert.rejects(restrictWslPath("\\\\wsl$\\Ubuntu\\home\\fixture", true,
    async () => { throw new Error("synthetic process failure"); }, "win32"), /Could not secure Jev/);
});
