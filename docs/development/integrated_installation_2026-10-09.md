# Integrated installation repair, 2026-10-09

Codex Decision 0.11.6 ships one VSIX for Windows VS Code with Linux x86_64 WSL. The VSIX contains the production hook, inspection tool, skill, session controls, settings, and checked patch resources. The extension ID remains `elhaus-labs.codex-decision-control` so an installed control upgrades in place. The hook and VSIX use the same release version.

## Observed failures

The installed control activated without an extension-host error. Its Decision view was enabled, but its panel container was hidden from the panel tab strip. The Codex extension had updated to `26.1007.21434`; the previous patch supported builds only through `26.1002.51308`. Hook trust remained valid. These independent UI states explain the missing controls without indicating a failed API key.

The host bridge also omitted the selected provider when forwarding key and settings actions, and rejected the current `openProvider` action. Both providers now cross the bridge unchanged. Settings replies are built after persistence and return the saved provider, model, and mode on both the home screen and a thread. Invalid provider names stop before command execution.

## Installation and recovery

Activation discovers the selected WSL environment and runs the bundled installer. An existing local Decision registration retains its identity and data path. A fresh installation uses an owned local marketplace. Exact package files update with rollback copies; credentials, settings, session flags, saved originals, unrelated files, and Codex trust records remain intact. The installer verifies the installed cache and repairs stale files even when the version has not changed.

The installer rejects duplicate or disabled registrations, downgrades, a mismatched data directory, linked paths, development repositories, and a conflicting managed marketplace. Configuration corrections and manual repair can retry a failed installation without requiring a restart.

The patch supports the observed Codex build with exact file hashes and checked insertion points. Read-only status distinguishes a pristine host, a verified current patch, and an older managed patch. Kernel locks serialize different windows. Unknown builds, altered host files, and changed rollback files stop before patch writes. A current patch causes no host rewrite. Optional reload and diagnostic notifications do not hold the repair operation open; checks and retries finish without waiting for a click. Startup and extension-change checks repair supported builds, report failures, and retain per-build rollback files.

Installation and manual repair restore the Decision panel through the public VS Code command. Existing session selections and counters still come from their own data directories. The packaged bridge handles the fresh marketplace's WSL paths and plugin images.

## Verification

The release gate includes the full Rust suite, Clippy, Node tests, Python installer and package checks, the actual composer and panel scripts in Edge, and the native VS Code panel smoke test. New regressions exercise fresh bootstrap, upgrades, cache damage, safe refusals, both providers, concurrent repair, corrected configuration, and zero-write repeated checks.

The native integrated-package smoke test unpacks the final VSIX into an isolated Windows profile and uses private Linux fixture state. It checks fresh registration, exact cached payload, automatic patching, restart idempotence, new session defaults, saved counters, the actual panel renderer under its CSP, and provider forwarding. It uses synthetic output and has no API key. The test removes only its owned profile, extension copies, and Linux fixture after its processes stop.

An installed-provider smoke check uses synthetic output. Hook trust, exact installed payload, and patch status are checked separately. An API connection test alone does not prove hook activation. A new or changed hook can still require a review in `/hooks`, and VS Code requires a window reload after host files change. Unknown future Codex builds need a verified profile; they produce a visible diagnostic.

The final package passed both native launches, with seven checks in each launch. The complete Node suite passed 132 tests, with three platform or optional-binary checks skipped in WSL; the focused Windows checks passed. Fourteen Python checks passed. The Rust suite and Clippy passed, followed by the final patch regressions. Edge and Chromium rendered the real webview scripts. The separate native panel suite passed fourteen checks.

The production hook's live synthetic check used OpenAI and validated two requests. It removed 119 of 122 lines, preserved the diagnostic and completion totals, and saved the exact readable original. The final native report records the tested VSIX SHA-256, so publication can be checked against the same artifact. Reports stay in ignored `.local/quality/`; rejected candidates remain separate from the final submission.
