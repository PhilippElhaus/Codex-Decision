# Windows and WSL verification for 0.15.0

Date: 2026-10-24.

Codex `26.1021.22027` moved its image and router code into separate modules.
The previous exact-version guard refused that build. This release adds the four
reviewed asset hashes, updates the router binding, and retains the refusal for
unknown or modified builds.

The integrated VSIX now includes Windows x86_64 and Linux x86_64 runtimes.
Windows execution uses the VS Code Node host for installation and native Rust
binaries for filtering and repair. It needs no Python or WSL. The control follows
the Codex Windows/WSL setting and Remote-WSL behavior. Each runtime retains its
own registration, credentials, settings, and session data. A successful repair
adopts a verified canonical data directory for later runtime switches. An
unverified override from another runtime requires correction.

The path fixes cover copied Linux settings, mixed-slash and extended WSL UNC
paths, distro names with dots, Windows path case, and `CODEX_HOME` inherited
from another runtime. Credential writes now use the same no-follow WSL
permission helper as other private records. A permission failure preserves the
previous credential file.

Native storage accepts Administrators ownership only when it matches the current
token’s default owner. It retains foreign-owner rejection. It uses private
Windows ACLs, file identities, reparse and hardlink checks, and kernel locks. A real synthetic provider test found a missing
timestamp-write permission on staged batches. The corrected Windows handle
supports completed publication and repeated calls with exact readable and typed
originals.

## Validation

- Linux: 301 Rust tests passed, with one ignored subprocess fixture. Formatting
  and Clippy passed.
- Windows: 36 Rust tests passed. Native library and binary Clippy passed. The
  process tests include concurrent hook calls, invalid configuration, synthetic
  relevance requests, exact originals, completed panels, and repeated
  publication.
- Node: 207 tests passed on Linux, with four platform skips. The Windows
  integration subset passed 60 tests, with one Linux-only skip.
- Python: all 16 package, installer, documentation, and defaults checks passed.
- Chromium and Edge exercised the real composer, settings, panel, and skipped
  output scripts. These checks used synthetic data.
- The background native package check passed against the final VSIX. It used
  the real Codex CLI, isolated private state, native hook stdin under PowerShell
  7 and Windows PowerShell 5.1, the native panel reader, and four real copied
  Codex assets. Installation, exact cache contents, single registration,
  concurrent and repeated checks, repair, and restoration passed.
- The earlier WSL desktop candidate passed both isolated launches, including
  actual rendering and restart recovery. A native desktop candidate passed
  installation, hook execution, patching, and settings, then deferred rendering
  because its minimized document was hidden. The reader and queue diagnostics
  confirmed the intended hidden-document behavior. Desktop launches were
  stopped at the user's request. Final checks used background processes.

The final VSIX SHA-256 is
`52638f18450213b1a58fdc51489e15f104a093500963c7cf63ba306f8599d2af`.
The standalone ZIP SHA-256 is
`62eb45d47f26bd3278ce58a659a95f7c0b8f7f3cd224d9d6255e1e912d0e96c0`.
Both archives passed exact-entry, source-byte, version, ELF, PE, and production
binary checks. Reports remain in ignored `.local/quality/` directories.

The new Windows command uses Codex's documented
[`commandWindows` override](https://learn.chatgpt.com/docs/hooks). Review the
updated hook in `/hooks` after installation. The installer preserves trust
records; it does not approve the changed definition.
