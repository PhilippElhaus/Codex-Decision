"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const test = require("node:test");
const core = require("../../vscode-control/core");
const { readLatestPanelDecision } = require("../../vscode-control/panel-state");
const fixture = require("../fixtures/publication-case.json");

test("native Windows reads prior WSL publication until commit and survives rollback/retry", {
  skip: process.platform !== "win32" || !process.env.CODEX_DECISION_TEST_WSL_DISTRO,
  timeout: 60_000,
}, async () => {
  const distro = process.env.CODEX_DECISION_TEST_WSL_DISTRO;
  assert.match(distro, /^[A-Za-z0-9_-]+$/);
  const run = args => execFile("wsl.exe", ["-d", distro, "-e", ...args],
    { timeout: 15_000, maxBuffer: 8192 });
  const linuxRoot = (await run(["mktemp", "-d", "-p", "/tmp", "decision-wsl-publication-XXXXXXXX"])).stdout.trim();
  assert.match(linuxRoot, /^\/tmp\/decision-wsl-publication-[A-Za-z0-9]{8}$/);
  const root = `\\\\wsl.localhost\\${distro}${linuxRoot.replaceAll("/", "\\")}`;
  const session = core.sessionDirectory(root, "synthetic-publication");
  const linuxSession = `${linuxRoot}/sessions/${path.basename(session)}`;
  const encoded = Buffer.from(JSON.stringify(fixture)).toString("base64");
  const phase = state => run(["python3", "-c", String.raw`
import base64,json,os,pathlib,stat,sys
root=pathlib.Path(sys.argv[1]); data=json.loads(base64.b64decode(sys.argv[2])); phase=sys.argv[3]
assert root.is_absolute() and root.parts[1]=='tmp'
for folder in (root.parent,root,root/'logs'):
    folder.mkdir(mode=0o700,exist_ok=True); folder.chmod(0o700)
def write(name,text):
    target=root/name
    assert not target.is_symlink()
    temporary=target.with_name('.native-publication-test.tmp')
    assert not temporary.exists()
    with temporary.open('x') as stream: stream.write(text)
    temporary.chmod(0o600); os.replace(temporary,target)
journal=root/'logs/.decision-publication.json'
if phase=='rollback':
    write('stats.json',data['stats_before']); write('logs/latest-decision.json',data['snapshot_before'])
    write('logs/events.jsonl',data['events_before'])
    if journal.exists(): journal.unlink()
else:
    write('stats.json',data['stats_after']); write('logs/latest-decision.json',data['snapshot_after'])
    write('logs/events.jsonl',data['events_before']+data['event'])
    write('logs/.decision-publication-'+data['prepared']['receipt_id']+'.snapshot-before',data['snapshot_before'])
    value=data['prepared']; value['state']=phase; write('logs/.decision-publication.json',json.dumps(value))
assert all(not stat.S_ISLNK(os.lstat(p).st_mode) for p in root.rglob('*'))
`, linuxSession, encoded, state]);
  try {
    await phase("prepared");
    const cache = {};
    assert.equal((await core.readSessionActivity(session)).completed, 1);
    assert.equal((await readLatestPanelDecision(session, cache)).status, "processing");
    assert.deepEqual((await core.readRecentOutcomes(session)).map(row => row.status), ["keep"]);
    const cursor = await core.readEventCursor(session);
    await phase("committed");
    assert.equal((await core.readSessionActivity(session)).completed, 2);
    assert.equal((await readLatestPanelDecision(session, cache)).status, "replace");
    assert.deepEqual((await core.readEventsSince(session, cursor)).events.map(row => row.status), ["replace"]);
    await phase("rollback");
    assert.equal((await core.readSessionActivity(session)).completed, 1);
    assert.equal((await readLatestPanelDecision(session, cache)).status, "processing");
    await phase("prepared");
    assert.equal((await core.readSessionActivity(session)).completed, 1);
    await phase("committed");
    assert.equal((await core.readSessionActivity(session)).completed, 2);
    assert.equal((await readLatestPanelDecision(session, cache)).status, "replace");
  } finally {
    await run(["python3", "-c", String.raw`
import os,pathlib,shutil,stat,sys
root=pathlib.Path(sys.argv[1])
assert root.parent==pathlib.Path('/tmp') and root.name.startswith('decision-wsl-publication-')
assert root.resolve()==root and root.stat().st_uid==os.geteuid()
assert all(not stat.S_ISLNK(os.lstat(p).st_mode) for p in root.rglob('*'))
shutil.rmtree(root)
`, linuxRoot]);
  }
});
