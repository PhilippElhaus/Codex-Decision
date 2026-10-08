"use strict";
// Stop only an owned synthetic hook at exact cross-file publication points.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { fixture, response } = require("../tests/fixtures/pipeline-stress.cjs");
const { start, invoke, stopOwned } = require("./pipeline-stress/process.cjs");
const { requireProxyHook } = require("./two_stage_audit.cjs");
const { readLifetimeStats } = require("../vscode-control/core");
const arg = (flag, fallback) => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const json = async file => JSON.parse(await fs.readFile(file, "utf8"));

async function stopped(child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (/^State:\s+T\b/m.test(await fs.readFile(`/proc/${child.pid}/status`, "utf8"))) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Owned hook did not stop at the commit barrier");
}

async function waiting(child, lock) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    for (const name of await fs.readdir(`/proc/${child.pid}/fd`)) {
      if (await fs.readlink(`/proc/${child.pid}/fd/${name}`).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      }) === lock) return;
    }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Concurrent same-event waiter never reached the held log lock");
}

async function verify(hook, library, provider, phase, concurrent) {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "decision-commit-interrupt-"));
  let server;
  try {
    const data = path.join(temporary, "data"); await fs.mkdir(data, { mode: 0o700 });
    const session = "commit-interrupt", scoped = path.join(data, "sessions", hash(session)), logs = path.join(scoped, "logs");
    await fs.writeFile(path.join(data, "config.json"), JSON.stringify({ schema_version: 5, scope: "global", enabled: true,
      mode: "replace", provider, model: provider === "openai" ? "gpt-6-luna" : "jev-latest", relevance_policy: { relevant_max: 5 },
      timeout_seconds: 4, log_limit_mb: 1, never_delete_logs: phase !== "cleanup-deferred" }), { mode: 0o600 });
    await fs.writeFile(path.join(data, ".env"), `${provider === "openai" ? "OPENAI_API_KEY" : "JEV_API_KEY"}=synthetic-commit-key\n`, { mode: 0o600 });
    const transcript = path.join(temporary, "transcript.jsonl");
    await fs.writeFile(transcript, JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ type: "input_text",
      text: "Identify the failure cause and final status. Preserve their exact values." }] } }) + "\n");
    const event = run => ({ hook_event_name: "PostToolUse", tool_name: run.envelope ? "exec_command" : "Bash", session_id: session,
      tool_use_id: run.id, transcript_path: transcript, tool_input: run.envelope ? { cmd: run.command } : { command: run.command }, tool_response: run.response });
    let requests = 0; const unexpected = [];
    server = http.createServer(async (req, res) => {
      try {
        assert.equal(req.headers.authorization, "Bearer synthetic-commit-key");
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; assert.ok(size + 4096 <= 64000); chunks.push(chunk); }
        requests++; res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(response(JSON.parse(Buffer.concat(chunks)), provider)));
      } catch (error) { unexpected.push(error.message); res.writeHead(500); res.end("{}"); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/`;
    const seed = await invoke(hook, data, endpoint, event(fixture(0, 0, 64)));
    assert.equal(seed.stderr, ""); assert.equal(seed.reply.continue, false);
    const before = await json(path.join(scoped, "stats.json"));
    let retainedReceipt;
    if (phase === "cleanup-deferred") {
      const folder = (await fs.readdir(logs)).find(name => /^\d{4}-\d{2}-\d{2}-[a-f0-9]{10}$/.test(name));
      assert.ok(folder);
      retainedReceipt = path.join(logs, folder, `receipt-${"e".repeat(32)}.json`);
      await fs.writeFile(retainedReceipt, Buffer.alloc(1_100_000, "x"), { flag: "wx", mode: 0o600 });
      await fs.utimes(retainedReceipt, new Date(0), new Date(0));
    }
    const interrupted = fixture(1, 1, 2000);
    const running = start(hook, data, endpoint, event(interrupted), { LD_PRELOAD: library,
      DECISION_OWNED_COMMIT_PHASE: phase, DECISION_OWNED_COMMIT_STATS: path.join(scoped, "stats.json"),
      DECISION_OWNED_COMMIT_SNAPSHOT: path.join(logs, "latest-decision.json"),
      DECISION_OWNED_COMMIT_EVENT: path.join(logs, "events.jsonl"),
      DECISION_OWNED_COMMIT_LOGS: logs,
      DECISION_OWNED_COMMIT_JOURNAL: path.join(logs, ".decision-publication.json") });
    if (phase === "cleanup-deferred") {
      const completed = await running.done;
      assert.equal(completed.code, 0); assert.equal(JSON.parse(completed.stdout).continue, false);
      assert.ok(completed.stderr.includes("publication cleanup deferred"));
      assert.equal((await json(path.join(logs, ".decision-publication.json"))).state, "committed");
      assert.equal((await fs.stat(retainedReceipt)).size, 1_100_000, "Retention must wait while journal cleanup is deferred");
      const next = await invoke(hook, data, endpoint, event(fixture(2, 1, 512)));
      assert.equal(next.stderr, ""); assert.equal(next.reply.continue, false);
      assert.equal((await json(path.join(scoped, "stats.json"))).completed, before.completed + 2);
      await assert.rejects(fs.stat(path.join(logs, ".decision-publication.json")), { code: "ENOENT" });
      await assert.rejects(fs.stat(retainedReceipt), { code: "ENOENT" });
      assert.deepEqual(unexpected, []);
      return { provider, phase, retained_during_deferred_cleanup: true, later_success_recovered: true, retention_resumed: true, mock_requests: requests };
    }
    await Promise.race([stopped(running.child), running.done.then(result => { throw new Error(`Hook exited before ${phase} commit barrier: ${result.code}: ${result.stderr}: ${result.stdout}`); })]);
    const journal = await json(path.join(logs, ".decision-publication.json"));
    const committed = phase === "after-commit";
    assert.equal(journal.state, committed ? "committed" : "prepared");
    const view = await readLifetimeStats(scoped);
    assert.equal(view.completed, before.completed + Number(committed), "Readers must expose only committed counters");
    let waiter;
    if (concurrent) {
      waiter = start(hook, data, endpoint, event(interrupted));
      await Promise.race([waiting(waiter.child, path.join(logs, ".lock")), waiter.done.then(() => { throw new Error("Waiter escaped held log lock"); })]);
    }
    assert.equal(running.child.kill("SIGKILL"), true);
    const killed = await running.done; assert.equal(killed.signal, "SIGKILL"); assert.equal(killed.stdout, "");
    const retry = waiter ? await waiter.done : await start(hook, data, endpoint, event(interrupted)).done;
    assert.equal(retry.code, 0); assert.equal(retry.stderr, ""); assert.equal(JSON.parse(retry.stdout).continue, false);
    const after = await json(path.join(scoped, "stats.json"));
    assert.equal(after.completed, before.completed + 1 + Number(committed));
    const events = (await fs.readFile(path.join(logs, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.filter(row => row.status === "replace").length, after.completed);
    const original = path.join(data, "outputs", hash(session).slice(0, 20), `${hash(interrupted.id).slice(0, 20)}.txt`);
    assert.equal(await fs.readFile(original, "utf8"), 'Command result metadata: {"exit_code":1}\n' + interrupted.source);
    assert.deepEqual(await json(original.replace(/\.txt$/, ".json")), interrupted.response);
    assert.equal((await json(path.join(logs, "latest-decision.json"))).status, "replace");
    await assert.rejects(fs.stat(path.join(logs, ".decision-publication.json")), { code: "ENOENT" });
    assert.equal((await fs.readdir(logs)).some(name => name.endsWith(".snapshot-before")), false);
    const scratch = (await fs.readdir(scoped,{recursive:true})).filter(name => /^\.jev-[a-f0-9-]{36}\.tmp$/.test(path.basename(name)));
    let scratchBytes=0;
    for(const name of scratch){const metadata=await fs.lstat(path.join(scoped,name));assert.ok(metadata.isFile()&&!metadata.isSymbolicLink());scratchBytes+=metadata.size;}
    assert.deepEqual(unexpected, []);
    return { provider, phase, concurrent, reader_completed_at_barrier: view.completed, after_retry_completed: after.completed,
      exact_original_pair: true, completion_events_match: true, recovered: true, retained_scratch_files: scratch.length, retained_scratch_bytes: scratchBytes, mock_requests: requests };
  } finally {
    await stopOwned();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.equal(await fs.realpath(temporary), temporary);
    for (const name of await fs.readdir(temporary, { recursive: true })) assert.equal((await fs.lstat(path.join(temporary, name))).isSymbolicLink(), false);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  assert.equal(process.platform, "linux", "Publication barriers require Linux process signals");
  const temporaryRoot = await fs.realpath(os.tmpdir()); assert.ok(!temporaryRoot.startsWith("/mnt/d"));
  const hook = path.resolve(arg("--hook", "target/verification/decision-hook"));
  requireProxyHook(await fs.readFile(hook));
  // Lab data /tmp can be noexec; an explicit owned Linux build cache may hold
  // this executable test helper while all synthetic payload fixtures stay /tmp.
  const buildRoot = path.resolve(arg("--barrier-build-root",temporaryRoot));
  assert.ok(!buildRoot.startsWith("/mnt/d"));
  await fs.mkdir(buildRoot,{recursive:true,mode:0o700});
  assert.equal(await fs.realpath(buildRoot),buildRoot);
  const temporary = await fs.mkdtemp(path.join(buildRoot, "decision-commit-barrier-build-"));
  try {
    const library = path.join(temporary, "barrier.so");
    const compile = spawnSync("cc", ["-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", path.join(__dirname, "commit-interrupt/barrier.c"), "-o", library, "-ldl"], { encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr);
    const selected = arg("--provider", "both"); assert.ok(["both", "openai", "typesafe"].includes(selected));
    const results = [];
    for (const provider of selected === "both" ? ["openai", "typesafe"] : [selected]) {
      for (const phase of ["before-stats", "after-stats", "after-snapshot", "after-event", "rollback-start", "after-commit"]) results.push(await verify(hook, library, provider, phase, false));
      results.push(await verify(hook, library, provider, "after-stats", true));
      results.push(await verify(hook, library, provider, "cleanup-deferred", false));
    }
    const out = path.resolve(arg("--out", `.local/quality/commit-interrupt-${Date.now()}`));
    await fs.mkdir(out, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(out, "summary.json"), JSON.stringify({ hook_sha256: hash(await fs.readFile(hook)), results }, null, 2) + "\n");
    console.log(JSON.stringify(results));
  } finally {
    assert.equal(await fs.realpath(temporary), temporary);
    for (const name of await fs.readdir(temporary)) assert.equal((await fs.lstat(path.join(temporary, name))).isSymbolicLink(), false);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
