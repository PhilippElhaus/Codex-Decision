"use strict";
// A stopped creator holds the permanent output lock while a same-event waiter arrives.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { start } = require("../pipeline-stress/process.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const json = async file => JSON.parse(await fs.readFile(file, "utf8"));

async function waitingForOutputLock(child, lock) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    for (const name of await fs.readdir(`/proc/${child.pid}/fd`)) {
      const target = await fs.readlink(`/proc/${child.pid}/fd/${name}`).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (target === lock) return;
    }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Same-event waiter never reached the held output lock");
}

async function verifyRollback({ running, hook, data, endpoint, event, interrupted, logs, scoped,
  session, before, original, expected }) {
  const panel = await json(path.join(logs, "latest-decision.json"));
  const folder = path.join(logs, `${new Date().toISOString().slice(0, 10)}-${hash(session).slice(0, 10)}`);
  // A private directory at A's exact receipt path forces its normal publication
  // failure. Only this fixture-owned obstruction is created.
  await fs.mkdir(path.join(folder, `receipt-${panel.receipt_id}.json`), { mode: 0o700 });
  const lock = path.join(path.dirname(original), ".originals.lock");
  const inode = (await fs.lstat(lock)).ino;
  const waiter = start(hook, data, endpoint, event(interrupted));
  await Promise.race([
    waitingForOutputLock(waiter.child, lock),
    waiter.done.then(() => { throw new Error("Waiter completed while the creator still held its originals"); }),
  ]);
  assert.deepEqual(await json(path.join(scoped, "stats.json")), before);
  assert.equal(running.child.kill("SIGCONT"), true);
  const failed = await running.done;
  assert.equal(failed.code, 0);
  assert.deepEqual(JSON.parse(failed.stdout), {});
  assert.equal(failed.stderr, "Codex Decision hook skipped: original already exists\n");
  const completed = await waiter.done;
  assert.equal(completed.code, 0);
  assert.equal(completed.stderr, "");
  assert.equal(JSON.parse(completed.stdout).continue, false);
  assert.equal((await json(path.join(scoped, "stats.json"))).completed, before.completed + 1);
  assert.equal(await fs.readFile(original, "utf8"), expected);
  assert.deepEqual(await json(original.replace(/\.txt$/, ".json")), interrupted.response);
  assert.equal((await fs.lstat(lock)).ino, inode, "The output lock inode must survive rollback");
  return { concurrent_creator_rollback: true, waiter_committed_exact_pair: true, stable_output_lock_inode: true };
}

module.exports = { verifyRollback };
