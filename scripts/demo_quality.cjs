"use strict";
// Real Jev calls against reviewed synthetic fixtures. Never copies the installed key.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { readApiKey, DEFAULT_LINE_POLICY } = require("../vscode-control/core");
const cases = require("../tests/fixtures/quality-cases.json");
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
async function main() {
  if (!process.argv.includes("--live") || !process.argv.includes("--data-dir")) {
    throw new Error("usage: node scripts/demo_quality.cjs --live --data-dir <PLUGIN_DATA> [--hook <debug jev-hook>] [--out <directory>] [--omit-min <0..100>] [--exact-max <0..100>] [--case <id>]");
  }
  const selected = cases.filter(item => !process.argv.includes("--case") || item.id === value("--case"));
  if (!selected.length) throw new Error("unknown demo case");
  const key = await readApiKey(value("--data-dir"));
  const policy = structuredClone(DEFAULT_LINE_POLICY);
  for (const [flag, field] of [["--omit-min", "omit_min"], ["--exact-max", "exact_max"]]) {
    if (process.argv.includes(flag)) {
      const number = Number(value(flag));
      if (!Number.isInteger(number) || number < 0 || number > 100) throw new Error("invalid " + flag);
      for (const route of Object.keys(policy)) policy[route][field] = number;
    }
  }
  const hook = process.argv.includes("--hook") ? value("--hook") : path.join(os.homedir(), ".cache/codex-jev/cargo-target/debug/jev-hook");
  const out = path.resolve(process.argv.includes("--out") ? value("--out") : path.join(".local/quality", new Date().toISOString().replaceAll(":", "-") + "-" + require("node:crypto").randomUUID().slice(0, 8)));
  await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
  await fs.mkdir(out, { mode: 0o700 });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "jev-quality-"));
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 28000) throw new Error("request budget"); chunks.push(chunk); }
      const response = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: Buffer.concat(chunks), signal: AbortSignal.timeout(10000),
      });
      calls += 1;
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(await response.text());
    } catch { res.writeHead(502); res.end("{}"); }
  });
  const reports = [];
  const manifest = [];
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    for (const item of selected) {
      const data = path.join(temporary, item.id);
      await fs.mkdir(data, { mode: 0o700 });
      await fs.writeFile(path.join(data, ".env"), "JEV_API_KEY=synthetic-proxy-key\n", { mode: 0o600 });
      await fs.writeFile(path.join(data, "config.json"), JSON.stringify({ schema_version: 2, scope: "global", enabled: true,
        test_build_enabled: true, search_listing_enabled: true, choice_gate_enabled: false, mode: "replace",
        model: "jev-1.13.0", timeout_seconds: 4, line_policy: policy }), { mode: 0o600 });
      const transcript = path.join(data, "transcript.jsonl");
      await fs.writeFile(transcript, JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: item.task }] } }) + "\n");
      const event = { hook_event_name: "PostToolUse", tool_name: "Bash", session_id: item.id, tool_use_id: "demo-call",
        transcript_path: transcript, tool_input: { command: item.command }, tool_response: item.lines.join("\n") + "\n" };
      const started = Date.now();
      const child = spawn(hook, [], { env: { ...process.env, PLUGIN_DATA: data, CODEX_JEV_TEST_ENDPOINT: `http://127.0.0.1:${server.address().port}/` }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.stdin.end(JSON.stringify(event));
      await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error("hook exit " + code))); });
      if (stderr) throw new Error("Demo hook failed for " + item.id + ": " + stderr);
      const files = await fs.readdir(data, { recursive: true });
      const receiptFile = files.find(file => /^receipt-/.test(path.basename(file)));
      if (!receiptFile) throw new Error("Missing demo receipt: " + item.id);
      const receipt = JSON.parse(await fs.readFile(path.join(data, receiptFile), "utf8"));
      const dest = path.join(out, item.id); await fs.mkdir(dest, { recursive: true, mode: 0o700 });
      for (const file of files.filter(file => /^(receipt|batch)-/.test(path.basename(file)))) await fs.copyFile(path.join(data, file), path.join(dest, path.basename(file)));
      manifest.push({ id: item.id, split: item.split, required_lines: item.required_lines, receipt: path.join(dest, path.basename(receiptFile)) });
      const required = new Set(item.required_lines);
      const trials = {};
      for (const [name, omit, exact] of [["70_25", .7, .25], ["95_5", .95, .05], ["90_15", .9, .15], ["85_20", .85, .2], ["80_25", .8, .25]]) {
        const omitted = receipt.decisions.filter(row => !row.protected_reason && row.p_can_omit >= omit && row.p_exact_needed !== null && row.p_exact_needed <= exact);
        trials[name] = { omitted: omitted.length, required_lost: omitted.filter(row => required.has(row.number)).map(row => row.number) };
      }
      const reply = JSON.parse(stdout);
      const visible = reply.reason || event.tool_response;
      let input = 0, output = 0;
      for (const file of files.filter(file => /^batch-/.test(path.basename(file)))) {
        const batch = JSON.parse(await fs.readFile(path.join(data, file), "utf8"));
        input += batch.batch.response.usage?.input_tokens || 0; output += batch.batch.response.usage?.output_tokens || 0;
      }
      const originals = files.filter(file => file.endsWith(".txt") && file.startsWith("outputs"));
      const originalExact = originals.length ? (await fs.readFile(path.join(data, originals[0]), "utf8")) === event.tool_response : null;
      const report = { id: item.id, split: item.split, lines: item.lines.length, required: required.size, elapsed_ms: Date.now() - started,
        status: receipt.manifest.status, saved_bytes: Buffer.byteLength(event.tool_response) - Buffer.byteLength(visible),
        input_tokens: input, output_tokens: output, original_exact: originalExact, trials };
      reports.push(report); console.log(JSON.stringify(report));
    }
    await fs.writeFile(path.join(out, "cases.json"), JSON.stringify(manifest, null, 2) + "\n");
    await fs.writeFile(path.join(out, "report.json"), JSON.stringify({ model: "jev-1.13.0", policy, calls, cases: reports }, null, 2) + "\n");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
