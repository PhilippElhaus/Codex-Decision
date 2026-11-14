"use strict";
// One project, native runners, and conservative function-level test selection.
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
process.env.PYTHONPYCACHEPREFIX ||= path.join(ROOT, ".cache", "python");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() :
      reject(new Error(`${command} failed (${signal || code})`)));
  });
}

async function main() {
  const flags = new Set(), comparison = { base: "main", head: "HEAD" };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const [name, inline] = args[index].split("=", 2);
    if (["--base", "--head"].includes(name)) {
      const value = inline ?? args[++index];
      if (!value) throw new Error(`Missing ${name} commit`);
      comparison[name.slice(2)] = value;
    } else if (["--full", "--collect", "--affected", "--plan"].includes(name) && inline === undefined) flags.add(name);
    else throw new Error(`Unknown test option: ${args[index]}`);
  }
  if (flags.has("--collect") && flags.size > 1) throw new Error("Collection must run separately");
  if (flags.has("--affected")) {
    try {
      const commit = ref => execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      const changes = execFileSync("git", ["diff", "--name-only", "-z", `${commit(comparison.base)}...${commit(comparison.head)}`],
        { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
      if (!changes.length) { console.log("No committed changes in the selected comparison."); return; }
    } catch { console.log("Git comparison unavailable; running complete test boundaries."); }
  }
  if (!flags.has("--plan")) await run("cargo", ["test", "--locked", "-p", "codex-decision", "--no-run"]);
  const options = ["--full", "--collect", "--plan"].filter(flag => flags.has(flag));
  const native = family => run(python, ["scripts/tia/run.py", family, ...options]);
  if (flags.has("--collect")) {
    for (const family of ["node", "python", "rust"]) await native(family);
  } else {
    const results = await Promise.allSettled(["node", "python", "rust"].map(native));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  if (flags.has("--affected") && !flags.has("--plan")) {
    for (const gate of ["browser", "quality"]) await run(python, ["scripts/tia/gates.py", gate]);
    await run(python, ["-m", "unittest", "tests.smoke.test_packages", "tests.smoke.test_integrated_install"]);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
