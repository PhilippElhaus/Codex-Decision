# Function-level test impact analysis

This repository has one test project. A small native launcher coordinates Cargo, Node's built-in runner, and Python unittest. It has no npm dependencies. The selectors use recorded per-test function coverage; file-name matching alone never establishes impact.

## Commands

Run from the repository root with Node 22 or newer, Python, Git, and Rust available:

```bash
npm test
npm run test:full
npm run tia:collect
npm run test:affected -- --base=main --head=HEAD
```

`npm test` builds the native test runtime, then runs all three selectors concurrently. `test:full` always executes the complete native suites. Verdicts are not cached. `tia:collect` runs the suites sequentially and replaces function evidence only after successful validation.

`test:affected` compares committed Git revisions. An empty comparison does no work. A changed or unavailable comparison runs all native selectors and the complete browser, quality/interruption, and package gates. Use `npm test` for uncommitted work. The repository is one coupled project, so there is no separate project graph.

Set `PYTHON` to an explicit interpreter path when needed. The launcher places bytecode under `.cache/python`. Cargo defaults to `.cache/cargo`; `CARGO_TARGET_DIR` selects a different native build directory. Baselines live under `.cache/tia`. Instrumented Rust builds use `.cache/cargo-coverage`. Shared dependency download caches remain user-local.

Rust coverage requires `rustup component add llvm-tools-preview` for the active toolchain. Inspect plans without executing tests:

```bash
python scripts/tia/run.py node --plan
python scripts/tia/run.py python --plan
python scripts/tia/run.py rust --plan
```

Plans show the selection reason and exact test identities. Each selector compares the complete source snapshot with its baseline. Collection can include uncommitted work, but source changes during collection prevent baseline replacement.

## Function evidence

| Runner | Collection | Selection |
| --- | --- | --- |
| Node | V8 function coverage around each top-level test; initialization and file hooks apply to every test in that worker | Escaped native name patterns per entrypoint |
| Python | Function-call tracing per unittest method; discovery and class fixtures apply to every method | Fully qualified unittest method identities |
| Rust | LLVM instrumentation per native test process, including instrumented hook/CLI children | Rebuild test targets, then run exact native test names |

Nested Node cases retain their parent lifecycle. Imported `.cases.cjs` files register once in their existing worker. Rust private tests remain beside private code. Rustdoc checks remain complete. Python discovery remains recursive under `tests/`.

Selection maps changed lines to the smallest recorded containing function and selects every test that executed it. Explicit source-file reads also select their cases, including VM and packaging consumers. Child-process cases remain selected because child imports can be unavailable to the parent collector. Source hashes, runtime versions, platform, native CLI bytes, and execution settings validate the evidence.

## Full-suite fallback

Missing, corrupt, incompatible, or incomplete coverage runs the full relevant suite. Added/deleted files, module-level changes, unmapped functions, fixtures, configuration, generated assets, and cross-language changes also run complete suites. A failed collection cannot overwrite a successful baseline.

Cargo integration targets always accompany selected Rust unit cases because child processes can clear instrumentation settings. Browser, provider-failure, interruption/publication, native Windows, and production-package checks retain their complete CI boundaries. Documentation changes still reach Python's link and package checks.

Baselines contain synthetic source/test evidence. They are ignored caches and never enter release payloads. CI restores only a matching main-branch baseline. Main collects complete native suites. Pull requests select functions where valid evidence exists and otherwise run complete suites. See [CI](../../.github/workflows/verify.yml).
