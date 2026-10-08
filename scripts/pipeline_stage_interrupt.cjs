"use strict";
// Stop at a real staged batch, after originals exist, then retry the same event.
const fs = require("node:fs/promises");
const { watch } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { fixture, response } = require("../tests/fixtures/pipeline-stress.cjs");
const { start, invoke, stopOwned } = require("./pipeline-stress/process.cjs");
const { requireProxyHook } = require("./two_stage_audit.cjs");
const { verifyRollback } = require("./stage-interrupt/rollback.cjs");
const arg = (flag, fallback) => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback;
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const json = async file => JSON.parse(await fs.readFile(file, "utf8"));

async function stopped(child) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const status = await fs.readFile(`/proc/${child.pid}/status`, "utf8");
    if (/^State:\s+T\b/m.test(status)) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Owned hook did not stop at the staging barrier");
}

async function verify(hook, provider, requireRecovered) {
  assert.equal(process.platform, "linux", "Staging interruption requires Linux process signals");
  const temporaryRoot = await fs.realpath(os.tmpdir());
  assert.ok(temporaryRoot !== "/mnt/d" && !temporaryRoot.startsWith("/mnt/d/") && !/^d:[\\/]/i.test(temporaryRoot));
  const temporary = await fs.mkdtemp(path.join(temporaryRoot, "decision-stage-interrupt-"));
  let server, watcher;
  try {
    const data = path.join(temporary, "data");
    await fs.mkdir(data, { mode: 0o700 });
    const session = "pipeline-stage-interrupt";
    const scoped = path.join(data, "sessions", hash(session));
    const logs = path.join(scoped, "logs");
    await fs.writeFile(path.join(data, "config.json"), JSON.stringify({
      schema_version: 5, scope: "global", enabled: true, mode: "replace", provider,
      model: provider === "openai" ? "gpt-6-luna" : "jev-latest",
      relevance_policy: { relevant_max: 5 }, timeout_seconds: 4, never_delete_logs: true,
    }), { mode: 0o600 });
    await fs.writeFile(path.join(data, ".env"), `${provider === "openai" ? "OPENAI_API_KEY" : "JEV_API_KEY"}=synthetic-stage-key\n`, { mode: 0o600 });
    const transcript = path.join(temporary, "transcript.jsonl");
    await fs.writeFile(transcript, JSON.stringify({ type: "response_item", payload: { role: "user", content: [{
      type: "input_text", text: "Identify the failure cause and final status. Preserve their exact values.",
    }] } }) + "\n");
    let requests = 0;
    const unexpected = [];
    server = http.createServer(async (req, res) => {
      try {
        assert.equal(req.headers.authorization, "Bearer synthetic-stage-key");
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          assert.ok(bytes + 4096 <= 64000);
          chunks.push(chunk);
        }
        requests++;
        const wire = JSON.parse(Buffer.concat(chunks));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(response(wire, provider)));
      } catch (error) {
        unexpected.push(error.message);
        res.writeHead(500);
        res.end("{}");
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/`;
    const event = run => ({ hook_event_name: "PostToolUse", tool_name: run.envelope ? "exec_command" : "Bash",
      session_id: session, tool_use_id: run.id, transcript_path: transcript,
      tool_input: run.envelope ? { cmd: run.command } : { command: run.command }, tool_response: run.response });
    const seed = await invoke(hook, data, endpoint, event(fixture(0, 0, 64)));
    assert.equal(seed.stderr, "");
    assert.equal(seed.reply.continue, false);
    const before = await json(path.join(scoped, "stats.json"));
    const interrupted = fixture(1, 1, 10000);
    let reached, failed, running;
    const barrier = new Promise((resolve, reject) => { reached = resolve; failed = reject; });
    watcher = watch(logs, (_event, name) => {
      if (running && /^\.jev-batch-[a-f0-9]{32}-\d+\.pending$/.test(String(name))) {
        watcher.close();
        if (!running.child.kill("SIGSTOP")) {
          failed(new Error("Owned hook exited before it could be stopped"));
          return;
        }
        reached(String(name));
      }
    });
    watcher.once("error", failed);
    running = start(hook, data, endpoint, event(interrupted));
    let timer;
    try {
      const pending = await Promise.race([
        barrier,
        running.done.then(() => { throw new Error("Hook completed before the staging interruption barrier"); }),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Staging barrier timed out")), 48000); }),
      ]);
      await stopped(running.child);
      const panel = await json(path.join(logs, "latest-decision.json"));
      assert.equal(panel.status, "processing");
      assert.ok(pending.includes(panel.receipt_id));
      assert.deepEqual(await json(path.join(scoped, "stats.json")), before, "Publication must not have committed before the interruption");
      const original = path.join(data, "outputs", hash(session).slice(0, 20), `${hash(interrupted.id).slice(0, 20)}.txt`);
      const expected = 'Command result metadata: {"exit_code":1}\n' + interrupted.source;
      for (const file of [original, original.replace(/\.txt$/, ".json")]) {
        const metadata = await fs.lstat(file);
        assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
        assert.equal(metadata.mode & 0o077, 0);
        assert.equal(metadata.uid, process.getuid());
      }
      assert.equal(await fs.readFile(original, "utf8"), expected);
      assert.deepEqual(await json(original.replace(/\.txt$/, ".json")), interrupted.response);
      const pendingFiles = (await fs.readdir(logs)).filter(name => name.startsWith(`.jev-batch-${panel.receipt_id}-`) && name.endsWith(".pending"));
      assert.ok(pendingFiles.length > 0);
      if (process.argv.includes("--concurrent-rollback")) {
        const result = await verifyRollback({ running, hook, data, endpoint, event, interrupted, logs, scoped,
          session, before, original, expected });
        assert.deepEqual(unexpected, []);
        return { provider, ...result, exact_original_sha256: hash(expected), mock_requests: requests };
      }
      assert.equal(running.child.kill("SIGKILL"), true);
      const killed = await running.done;
      assert.equal(killed.signal, "SIGKILL");
      assert.equal(killed.stdout, "");
      const retry = await invoke(hook, data, endpoint, event(interrupted));
      const succeeded = retry.reply.continue === false;
      if (succeeded) {
        assert.equal(retry.stderr, "");
        assert.equal((await json(path.join(scoped, "stats.json"))).completed, before.completed + 1);
      } else {
        assert.deepEqual(retry.reply, {});
        assert.equal(retry.stderr, "Codex Decision hook skipped: original already exists\n");
        assert.deepEqual(await json(path.join(scoped, "stats.json")), before);
      }
      assert.equal(await fs.readFile(original, "utf8"), expected);
      assert.deepEqual(await json(original.replace(/\.txt$/, ".json")), interrupted.response);
      assert.deepEqual(unexpected, []);
      if (requireRecovered) assert.equal(succeeded, true, "The identical interrupted event must recover");
      return { provider, killed_during_staging: true, saved_originals: 2, owned_private_originals_verified: true, pending_batches: pendingFiles.length,
        same_event_retry_succeeded: succeeded, retry_error: succeeded ? null : "original already exists",
        exact_original_sha256: hash(expected), mock_requests: requests };
    } finally {
      clearTimeout(timer);
      watcher.close();
    }
  } finally {
    if (watcher) watcher.close();
    await stopOwned();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    assert.equal(await fs.realpath(temporary), temporary);
    assert.ok((await fs.lstat(temporary)).isDirectory());
    for (const entry of await fs.readdir(temporary, { recursive: true })) {
      assert.equal((await fs.lstat(path.join(temporary, entry))).isSymbolicLink(), false);
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const hook = path.resolve(arg("--hook", "target/verification/decision-hook"));
  const details = await fs.lstat(hook);
  assert.ok(details.isFile() && !details.isSymbolicLink() && details.size <= 128 * 1024 * 1024);
  requireProxyHook(await fs.readFile(hook));
  const selected = arg("--provider", "both");
  assert.ok(["both", "openai", "typesafe"].includes(selected));
  const results = [];
  for (const provider of selected === "both" ? ["openai", "typesafe"] : [selected]) results.push(await verify(hook, provider, process.argv.includes("--require-recovered")));
  const out = path.resolve(arg("--out", `.local/quality/pipeline-stage-interrupt-${Date.now()}`));
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(out, "summary.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results));
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
