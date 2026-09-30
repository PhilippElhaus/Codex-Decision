# Verify a change

Use the release checks in [tests/README.md](../../tests/README.md). Run the Rust process suite after hook or storage changes, Node tests after control changes, and the Edge browser smoke test after any composer or settings change. Build with `./scripts/build_submission.sh`, which writes Cargo artifacts in the user cache and the plugin ZIP in `.local/submission/`. The packaging command checks the exact files in the archive.

Before deployment, check the plugin ZIP and VSIX, then install the new plugin and control. Run `python3 scripts/check_hook_trust.py` against the installed hook. Codex binds trust to a hook definition hash, so the upgrade is incomplete until `/hooks` shows the current definition as trusted and enabled. Start a new thread and run an eligible local command. Verify a fresh hook-health record and a decision for that session. Repeat from a second Codex window: its switches and counters should start empty, and enabling it should not change the first window.

The hook returns the full original result on a failed Jev request, invalid answer, unsafe task, or storage error. `logs/hook-health.json` identifies the last invocation, skip, success, and error without storing the key or tool text. The control reports an unreadable status file as an error and an unobserved hook as amber. Normal skips include short, structured, unsupported, and sensitive results. Keep the `/hooks` check in every release procedure; Jev never edits Codex's trust database.

For reviewed quality cases, create a private JSON array such as:

```json
[{"id":"failing-test-1","split":"holdout","receipt":"/private/receipt.json","required_lines":[5,6,9],"task_solved":true,"baseline_task_solved":true}]
```

Run `jevctl evaluate-quality --cases <private-cases.json>`. It reports required lines lost, characters saved, and gate trials per route and split. These trials do not change settings or prove future task success. Receipts may contain private tool output; keep cases outside the repository. The optional ignored live Rust test makes a small number of real Jev requests with synthetic output and a private key file.
