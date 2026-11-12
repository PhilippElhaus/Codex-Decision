# Tests

The [Verify workflow](../.github/workflows/verify.yml) uses stable Rust, Node 22, Python 3.12, Linux, native Windows, and Chromium. Keep Cargo, Node's built-in runner, and unittest. Tests use synthetic provider replies and UI data; offline validation needs no API key.

## Run native suites

From the repository root:

```bash
cargo test --locked -p codex-decision
cargo clippy --locked --all-targets -- -D warnings
npm test --prefix vscode-control
python -m unittest discover -s tests -p 'test_*.py'
```

Set `DECISIONCTL_TEST` to the freshly built `decisionctl` when the Cargo target directory is nonstandard. This prevents the retained-history differential check from skipping for a missing verification binary.

Use Nx for task and function-level selection:

```bash
npm ci
npm run tia:collect
npm test
npm run test:affected -- --base=main --head=HEAD
npm run test:full -- --skip-nx-cache
```

See [test impact analysis](../docs/development/test-impact.md) for coverage collection, precise native identities, baseline validity, and full-suite fallback. Rust function collection requires the active toolchain's `llvm-tools-preview` component. Main collects complete native suites. Pull requests select functions when evidence is valid. Missing, shared, dynamic, or uncertain evidence runs full suites. Browser, native Windows, provider-failure, interruption, publication, and package gates remain complete.

## Discovery and ownership

Node discovers `.test.cjs` entrypoints recursively under `tests/`, including existing `e2e`, `edge`, and `load` directories. New `end2end`, `edgecase`, and `regression` directories are also discovered. Imported `.cases.cjs` modules register once in their existing worker. Activity cases live under `tests/unit/activity/`; extension cases live under `tests/integration/extension/`. Preserve declaration order, shared globals, and the composer's ordered lifecycle. Loader mocks restore the original loader in `finally`.

Rust private tests remain beside private code. Integration targets remain under `rust/decision/tests/`. Provider encoding, models, response parity, and budget tests share the `providers` target. Process, custom-provider, and platform tests retain their boundaries. Python discovery uses `test_*.py` under `tests/`.

Advisory tests cover exact original preservation, both provider protocols, Score distributions, structured-input budgets, cache counts, MCP framing, and native Stop continuation. They also cover private Windows fixtures, incomplete/stale evidence, measurement gaps, command cancellation, and Test Explorer publication of original failures. Use synthetic loopback endpoints; no provider key is needed.

Trace hook, bridge, packaging, generated fragments, dynamic loads, and runtime file reads before narrowing a suite. File-name filters alone are not impact analysis. Keep complete coverage when the dependency boundary is uncertain.

## Mandatory boundary checks

Linux runs standard permissions and repeats telemetry contracts with `umask 077`. Native process tests cover exact originals, incomplete and failed batches, privacy, request bounds, publication/interruption recovery, configuration, trust inspection, and pinned patch lifecycle. Native Windows checks cover installers, bounded reads, credentials, private records, updates, telemetry, and atomic writes. File-link checks can skip when the platform lacks link permission; directory-junction checks remain separate.

Node covers the host/route bridges, settings, per-thread state, panel recovery, private paths, provider transport and TLS, updater verification, publication readers, and log retention. Python covers packaging, installer preservation, documentation links, and TIA fallback boundaries. Chromium renders the real composer, settings, totals, raw inspector, and panel code. Packaging verifies both production runtimes and exact source bytes.

More procedures:

- [Synthetic corpus, stress, and interruption checks](../docs/development/evaluation.md)
- [CPU, allocation, and concurrency checks](../docs/development/performance.md)
- [Browser validation and screenshots](../docs/development/browser.md)
- [Builds and packaged-runtime checks](../docs/development/builds.md)
- [Read-only usage audit](../docs/operations/measurement.md) and [telemetry audit](../docs/operations/telemetry.md)

## Native and lab-specific checks

Lab-Control containers can have a nonexecutable `/tmp`. Keep ordinary data there. Set `CODEX_DECISION_TEST_EXECUTABLE_TMP_ROOT` to an explicit executable user cache or ignored `/workspace/.local/` directory for executable fixtures. The publication barrier accepts `--barrier-build-root` for its shared library.

The noninteractive Windows package check is documented in [builds](../docs/development/builds.md). Optional desktop checks launch isolated VS Code windows:

```powershell
pwsh -NoProfile -File vscode-control/scripts/windows_integrated_smoke.ps1 `
  -Vsix .local/submission/codex-decision-0.17.1.vsix -Distro Ubuntu
pwsh -NoProfile -File vscode-control/scripts/windows_panel_smoke.ps1 -Distro Ubuntu
```

Add `-Native` to the integrated check to select Windows execution. For optional WSL publication tests, set `CODEX_DECISION_TEST_WSL_DISTRO=Ubuntu` before running Node tests from Windows. Use isolated synthetic profiles; preserve installed extensions, keys, chats, and live runtime state.
