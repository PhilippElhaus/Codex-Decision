# Submission status

The 0.4 line-level release includes a **Linux x86_64 build** and an optional VS Code control. It is published on GitHub, but has not been submitted to the public plugin directory. Representative reviewed line labels and paired coding-task outcomes are still needed before a public quality claim. Other hook execution platforms also need native binaries.

Build the archive with `./scripts/build_submission.sh`. It writes an allowlisted ZIP under ignored `.local/submission/`, containing the Rust hook, `jevctl`, skill, manifest, icons, config example, and license. The archive contains no API key, private output, or VSIX. The optional VS Code extension is packaged separately.

The 0.3.3 public submission text and earlier benchmark remain historical. The 2026-09-26 benchmark measured coarse decisions and does not quantify this migration. [Data handling](../architecture/design_data.md) describes the new line contract.
