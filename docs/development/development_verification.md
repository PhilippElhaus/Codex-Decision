# Verify a change

Use the release checks in [tests/README.md](../../tests/README.md). Run the Rust process suite after hook or storage changes, Node tests after control changes, and the Edge browser smoke test after any composer or settings change. Build with `./scripts/build_submission.sh`, which writes Cargo artifacts in the user cache and the plugin ZIP in `.local/submission/`. The packaging command checks the exact files in the archive.

Before deployment, check the plugin ZIP and VSIX, then install the changed components. Run `jevctl check-hook-trust --cwd <repository>` against the installed hook. Codex binds trust to a hook definition hash, so a hook upgrade is incomplete until `/hooks` shows the current definition as trusted and enabled. Start a new thread and run an eligible local command. Verify that its three filters are selected and that a fresh hook-health record and decision appear for that session. Repeat from a second Codex window: its filters should be selected independently, its counters should start empty, and changing its switches should not change the first window. Navigate between existing threads without reloading the webview to confirm that the control follows Codex's internal router.

The hook returns the full original result on a failed Jev request, invalid answer, unsafe task, or storage error. `logs/hook-health.json` identifies the last invocation, skip, success, and error without storing the key or tool text. The indicator reports only the API check; a hook error appears in the session tooltip. Normal skips include short, structured, unsupported, and sensitive results. Keep the `/hooks` check in every release procedure; Jev never edits Codex's trust database.

For reviewed quality cases, create a private JSON array such as:

```json
[{"id":"failing-test-1","split":"holdout","receipt":"/private/receipt.json","required_lines":[5,6,9],"task_solved":true,"baseline_task_solved":true}]
```

Run `jevctl evaluate-quality --cases <private-cases.json>`. It reports required lines lost, characters saved, and gate trials per route and split. These trials do not change settings or prove future task success. Receipts may contain private tool output; keep cases outside the repository. The optional ignored live Rust test makes a small number of real Jev requests with synthetic output and a private key file.
