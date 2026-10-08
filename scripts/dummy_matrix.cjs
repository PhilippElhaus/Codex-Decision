"use strict";
// Run each reviewed corpus once per provider, with one fault suite per provider.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
const SPLITS = ["base", "holdout", "batching", "precision", "precision-holdout"];

async function main() {
  const options = { jobs: 2, providers: ["openai", "typesafe"],
    hook: path.join(os.homedir(), ".cache/codex-decision/cargo-target/debug/decision-hook"),
    out: path.join(ROOT, ".local/quality/dummy-matrix") };
  const known = new Set(["--jobs", "--providers", "--hook", "--out"]);
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index], value = process.argv[index + 1];
    if (!known.has(flag) || !value) throw new Error("Use --hook <debug-hook> --out <new-directory> [--jobs 1..4] [--providers openai,typesafe]");
    options[flag.slice(2)] = flag === "--jobs" ? Number(value) : flag === "--providers" ? value.split(",") : value;
  }
  if (!Number.isInteger(options.jobs) || options.jobs < 1 || options.jobs > 4 ||
      !options.providers.length || new Set(options.providers).size !== options.providers.length ||
      options.providers.some(provider => !["openai", "typesafe"].includes(provider))) throw new Error("Invalid matrix limits");
  const hook = path.resolve(options.hook), out = path.resolve(options.out);
  const details = await fs.lstat(hook);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("The debug hook must be a regular file");
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(out, { mode: 0o700 });
  const jobs = options.providers.flatMap(provider => SPLITS.map(split => ({ provider, split })));
  const results = [];
  let next = 0;
  const started = Date.now();
  async function run(job) {
    const name = `${job.provider}-${job.split}`;
    const destination = path.join(out, name);
    const log = await fs.open(path.join(out, `${name}.log`), "wx", 0o600);
    const args = [path.join(__dirname, "two_stage_quality.cjs"), "--provider", job.provider,
      "--hook", hook, "--out", destination];
    if (job.split !== "base") args.push(`--${job.split}`, "--skip-faults");
    console.log(JSON.stringify({ starting: name }));
    let code;
    try {
      const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", log.fd, log.fd] });
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } catch (error) {
      return { ...job, failed: true, error: error.message };
    } finally { await log.close(); }
    let summary;
    try { summary = JSON.parse(await fs.readFile(path.join(destination, "report.json"), "utf8")).summary; }
    catch (error) { return { ...job, failed: true, exitCode: code, error: error.message }; }
    const result = { ...job, exitCode: code, failed: code !== 0 || !Array.isArray(summary.failures) ||
      summary.failures.length > 0 || summary.required_lost !== 0, summary };
    console.log(JSON.stringify({ completed: name, failed: result.failed, cases: summary.cases, calls: summary.calls }));
    return result;
  }
  await Promise.all(Array.from({ length: Math.min(options.jobs, jobs.length) }, async () => {
    while (next < jobs.length) results.push(await run(jobs[next++]));
  }));
  results.sort((a, b) => jobs.findIndex(job => job.provider === a.provider && job.split === a.split) -
    jobs.findIndex(job => job.provider === b.provider && job.split === b.split));
  const summary = { jobs: options.jobs, providers: options.providers, splits: SPLITS,
    runs: results.length, cases: results.reduce((sum, result) => sum + (result.summary?.cases || 0), 0),
    calls: results.reduce((sum, result) => sum + (result.summary?.calls || 0), 0),
    requiredLinesLost: results.reduce((sum, result) => sum + (result.summary?.required_lost || 0), 0),
    failures: results.filter(result => result.failed).map(result => `${result.provider}-${result.split}`),
    elapsedMs: Date.now() - started };
  await fs.writeFile(path.join(out, "summary.json"), JSON.stringify({ summary, results }, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(summary));
  if (summary.failures.length) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
