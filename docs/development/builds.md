# Build and verify packages

Build from the repository root. Production packages need fresh Windows x86_64 and Linux x86_64 binaries from the same source revision.

1. On Windows, use an existing MSVC Rust toolchain:

   ```powershell
   pwsh -NoProfile -File scripts/build_hook_windows.ps1
   ```

2. On Linux x86_64 or WSL, build both packages:

   ```bash
   ./scripts/build_submission.sh
   ./scripts/build_control.sh
   ```

Linux builds use the user-local Cargo cache unless `CARGO_TARGET_DIR` is set. Archives go to `.local/submission/`. Existing same-version archives are retained. Advance the release version before rebuilding an existing archive.

The ZIP contains the standalone hook, CLI, skill, and assets. The VSIX also contains the control, webviews, installers, and patch fragments. The control build pins VSCE 4.0.0. Both paths call [verify_packages.py](../../scripts/verify_packages.py). It checks exact entries, source bytes, manifest versions, ELF/PE headers, and compiled versions.

The `verification` Cargo profile uses optimized packing with debug assertions and synthetic loopback support. Release packaging builds a separate production profile with the test endpoint disabled.

CI builds Windows binaries in its Windows job. The package job downloads those binaries from the same run, builds Linux production binaries, and verifies both archives. Validation artifacts remain available for seven days. CI does not publish a release.

Before a Windows release, run the noninteractive packaged-runtime check:

```powershell
pwsh -NoProfile -File vscode-control/scripts/windows_background_smoke.ps1 `
  -Vsix .local/submission/codex-decision-0.17.1.vsix `
  -HostExtension '<absolute-installed-Codex-extension>'
```

Optional desktop checks launch isolated VS Code windows. Run them when an interactive check is authorized. Use [browser checks](browser.md) for background rendering validation. See [installation](../setup/installation.md) for trust and installed-hook verification.

The background check supports reviewed host profiles `26.1007.21434`, `26.1021.22027`, and `26.51021.22027`. It copies verified originals into an isolated temporary profile. It checks native installation, restart and concurrent reuse, both PowerShell hook launchers, panel readers, MCP discovery, completion settings, measurement reporting, and exact patch apply/restore. It leaves the installed host and user credentials unchanged.

## Publish and deploy

After source, native Windows, browser, TIA, and production-package checks pass, commit the source and matching binaries. Push that commit and verify the complete **Verify** workflow. A failed job must pass before publishing.

Publish a stable GitHub release with the matching `v<version>` tag. Attach the verified standalone ZIP and integrated VSIX. Record SHA-256 hashes with the release assets. Keep archive versions aligned with the plugin, Cargo, and control manifests.

Install the verified VSIX with `code --install-extension <archive> --force`. Verify the installed version. Reload the extension host to activate new code. The integrated installer refreshes the matching plugin and retains cached paths used by existing threads. Verify integration and review changed hooks in `/hooks`. Preserve runtime recovery files. Register MCP through **Decision: Register MCP Tools in Codex** when those tools are wanted. Completion verification remains off until configured.
