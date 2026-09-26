# Codex Jev control for VS Code

The installed companion extension shows a `jev` status-bar indicator and
handles the composer button's private message bridge. The composer button and
status bar offer independent checkboxes for the Jev output filter,
Jev-gated test/build log filter, and broad search/listing filter. An empty
selection turns all three off. All three require the Jev credential. When selected, replacement mode is the
default. Set **Codex Jev Control: Mode**
(`codexJev.mode`) to `observe` in VS Code settings to retain full output while
recording decisions. `OBS` appears on the button and status bar in that mode.
Hovering shows the selected mode, outputs checked since this composer view opened,
and the three most recent metadata-only outcomes across tools. Routine small
tool outputs do not displace those outcomes in the tooltip. A fresh view starts
at the current end of the metadata log; reopening an old conversation or
reloading the window begins with zero and no recent outcomes. A view URL change
also resets totals. These are view-scoped counts, rather than persisted
per-conversation history. Changing a checkbox takes effect at the next
PostToolUse invocation in the same Codex session, including the completion of
a tool that was running when the checkbox changed. Each hook reads the config
at invocation, and the UI keeps its event cursor and view-scoped counts across
off/on changes. A Jev call already in progress uses its earlier selection.
The hook must already have been registered in that session; installing or
changing the plugin's hook code requires a new session.
The search/listing option uses Jev to classify path groups in broad `rg -n`,
`rg --files`, or `git ls-files` results. Uncertain groups remain exact. The
tooltip's checked/replaced/duration numbers cover all three tool-output filters.
The summary shows three signals: outputs checked, outputs replaced, and average hook
evaluation time. A replaced outcome shows estimated savings as the percentage
of original output characters omitted from the model-visible excerpt:
`(original_chars - capsule_chars) / original_chars`. This is a text-size
estimate, not a tokenizer or billed-token measurement. The panel shows only
the percentage (for example, `95%`) to keep outcomes compact. Durations from
one second upward appear as tenths of a second (for example, `1,2s`). Observe and keep
outcomes have no savings percentage because they leave the original visible.
The composer control docks immediately before the model selector, reduces to
its colored dot when the available gap narrows, and hides if even the dot
cannot fit without covering the selector. The hook remains selectable from
the VS Code status bar in that case.
Its button follows the model selector's measured height and vertical center,
including when the toolbar resizes, and uses its borderless pill shape; a keyboard focus
ring remains available for accessibility. The menu uses short use-case names
because all three selections share the same `PostToolUse` hook.

| Color | Meaning |
| --- | --- |
| Gray | No hook selected |
| Green | Jev API and cached key work |
| Blue, about 500 ms | Filter decision or health probe in progress; composer color eases in and out |
| Red | API/key health failed |

Set `codexJev.dataDirectory` to the installed plugin's absolute `PLUGIN_DATA`
folder, for example through `\\wsl.localhost\<distro>\...` on Windows. The
package has no machine-specific default. `CODEX_JEV_DATA_DIRECTORY` is an
alternative. `codexJev.credentialDirectory` defaults to the Windows user-local
DPAPI cache. The key never enters the extension process or webview. The health
check runs after selecting any filter and every five minutes. A missing or rejected key
triggers a refresh only when a local credential source is configured.

The in-composer button uses a reversible, version-pinned patch to the installed
Codex extension `26.917.62051`. It is not a supported Codex extension point.
On this Windows-to-WSL setup, the same bridge also translates this repository's
local marketplace path for `plugin/read`, so the Codex plugin detail page can
load. The translation applies only to this marketplace and its two plugins.
`patch_codex_webview.py` supports `apply`, `update`, and `restore`. `apply`
checks exact unmodified hashes; `update` checks the currently installed patch
and refreshes both the host message bridge and Jev UI asset. Both retain the
original rollback files. `restore` checks patched hashes before writing the
original files back. An updated Codex extension needs new validation before
this patch can be applied to it.
Its rollback files stay outside the repository under `%LOCALAPPDATA%`. Reload
the VS Code window after installing or restoring the patch.

To install the companion extension from source, package it with
`npx @vscode/vsce package --no-dependencies` from this directory, then run
`code --install-extension <generated-vsix> --force`. Set the data directory
before selecting the hook. For the composer button, run the patcher against
your installed Codex extension and a separate off-repository rollback path:

```bash
python3 patch_codex_webview.py update \
  --extension '/mnt/c/Users/<user>/.vscode/extensions/openai.chatgpt-26.917.62051-win32-x64' \
  --backup '/mnt/c/Users/<user>/AppData/Local/Codex/codex-jev/rollback/26.917.62051'
```

Use `apply` in place of `update` for an unmodified installation. For rollback,
use `restore` with the same paths, then reload. An extension update may remove
the composer button while leaving the status-bar extension installed.

Run `npm test` for unit/integration tests,
`python3 -m unittest discover -s tests -p 'test_*.py'`, and
`python3 scripts/browser_smoke.py`
for the headless browser test of button placement, selection, tooltip, colors,
and the VS Code message contract. [`composer-preview.html`](composer-preview.html)
is a standalone visual mock for design review.
