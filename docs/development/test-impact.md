# Nx and function-level test impact analysis

Nx 24 orchestrates this repository. It is pinned in the root package manifest and lockfile. Cargo, `node:test`, and unittest remain the test runners. There is no workspace above this repository.

Nx selects affected tasks from declared inputs. The native-test tasks then select individual tests from recorded function coverage. File-name matching alone is not used as impact evidence.

## Commands

Run from the repository root with Node 22 or newer, Python, Git, and Rust available:

```bash
npm ci
npm run tia:collect
npm run test:affected -- --base=main --head=HEAD
npm test
npm run test:full
```

`tia:collect` runs all three native suites and writes baselines under `.local/tia/`. Rust collection requires `rustup component add llvm-tools-preview` for the active toolchain. Instrumented Cargo output stays in the user-local `~/.cache/codex-decision/tia-target`. Dependency caches remain in their normal user locations.

Use `npm test` for current working-tree changes. It always reaches the native selectors. `nx affected` uses Git's changed-file set to select tasks, then each selector compares the complete current source snapshot with its baseline. Specify the correct base for a feature branch. A baseline can include uncommitted work; collection verifies that source did not change during the run.

Inspect a plan without executing tests:

```bash
python scripts/tia/run.py node --plan
python scripts/tia/run.py python --plan
python scripts/tia/run.py rust --plan
```

Plans state the reason, selection mode, and exact native test identities. Selective tasks are not cached by Nx because their output depends on local coverage evidence. Complete native-test targets can use Nx's local task cache. Pass `--skip-nx-cache` when fresh execution is required.

## Function evidence

| Runner | Collection | Selection |
| --- | --- | --- |
| Node | Precise V8 function coverage around each top-level test; initialization and file hooks apply to every test in that worker | Escaped native name patterns per entrypoint |
| Python | Function-call tracing per unittest method; discovery and class fixtures apply to every method | Fully qualified unittest method identities |
| Rust | LLVM instrumentation per native test process, including instrumented hook/CLI children | Rebuild all test targets, then run exact test names in their native executable |

Nested Node cases stay with their parent lifecycle. Existing `.cases.cjs` imports register once in their existing worker. Sequential globals and the ordered composer scenario remain intact. Rust private tests stay beside private code. Rustdoc checks remain complete. Python discovery remains recursive under `tests/`.

Selection compares changed source lines with the smallest recorded containing function. Every test that executed that function is selected. Explicit source-file reads also select their cases, including VM and packaging consumers that do not call the changed function. Cases that launch child processes remain selected because their child imports can be unavailable to the parent collector. Source paths, content hashes, all three runtime versions, platform, native CLI bytes, and relevant execution settings validate the evidence.

## Full-suite fallback

Missing, corrupt, incompatible, or incomplete coverage selects the full relevant suite. So do added/deleted inputs, module-level changes, unmapped or uncovered functions, fixtures, configuration, lockfiles, generated assets, and cross-language changes. A source change during collection prevents baseline replacement. Failed collection cannot overwrite a successful baseline.

Dynamic bridge and browser behavior remains covered by complete browser checks. Cargo integration targets always accompany a Rust function selection because child processes can clear instrumentation settings. Provider faults, interruption/publication checks, native Windows checks, and production package validation remain mandatory CI gates. Function selection does not replace those boundaries. Documentation changes still run Python's link and package checks.

Baselines contain synthetic test/source evidence. They are ignored generated files, not release payloads. CI restores only a matching main-branch baseline. Main runs complete native collections. Pull requests use selection where evidence is valid and run full suites otherwise. See [CI](../../.github/workflows/verify.yml).

Nx uses broad cross-component inputs because hook, CLI, bridge, installers, webviews, and package contracts share files through imports, generated fragments, and runtime reads. The lower layer supplies the function-level reduction. An unknown dependency never means no impact.
