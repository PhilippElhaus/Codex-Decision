# Runtime activity and protected lines, 2026-10-04

Plugin 0.10.6 and control 0.9.9 repair missing calls for shell scripts and
missing kept lines in the decision panel.

## Confirmed causes

Two active VS Code threads used the WSL Codex 0.160.0 executable from
extension 26.930.41038. The plugin was enabled and trusted. Its data path
and private permissions were correct.

One thread had no API calls and more than 400 `unsupported_route` skips.
The other had 11 classification calls that kept full output, but no line
decisions. The strict shell parser rejected heredocs, redirections, mixed
command groups, and transforming pipelines before classification. These
forms accounted for many real calls. The existing code-mode routing fix
did not cover the underlying shell events. A classification-only result
also left the panel empty, which concealed those 11 requests.

The parser now controls replacement eligibility. Unknown shell forms can
receive classification and line previews while their complete result
stays intact. Existing sensitive-text, task-context, structured-payload,
and request-budget guards remain active. Before the first line decision,
the panel shows API request counts, skipped outputs, and the latest skip
or hook error. Classification that keeps full output has an explicit
explanation.

The reported `3 / 72 kept` result had 69 judged lines and three protected
diagnostic lines. The header counted all 72 lines, but the version-4
snapshot included only the latest batch's target lines. It omitted both
protected lines and judgments from earlier batches. The missing three
were retained in the receipt and original output.

Version-5 snapshots now contain every source line in order. They include
all completed judgments, protected lines, and pending lines. The reader
checks row counts against totals and accepts at most 10,000 lines and
8 MiB. Protected and pending rows show `—` with a keep reason. They do not
receive an invented relevance probability. Historical version-3/4
snapshots remain readable with their original contents.

## Validation

- All 73 Rust tests passed. Formatting and Clippy passed.
- Node reported 64 passes and one native-Windows-only skip on Linux.
- All four Python checks passed.
- The offline, holdout, and batching corpora passed 145 cases and 432 mock
  calls with no required evidence loss. Failed later batches restored the
  previous snapshot and kept full output.
- The 72-line regression renders 69 omissions and all three protected
  keeps. It checks source order, header counts, visible diagnostics,
  completion evidence, pending rows, and absent scores.
- Chromium and native Edge passed narrow and wide panel checks. An
  isolated native VS Code host passed the same 72-line case under the
  real webview CSP, three reloads, hide/reopen, thread switching, and the
  classification-only activity message.
- Six additional Chromium rounds rendered real hook-produced snapshots
  with 242 and 10,000 rows. All six settled-score checks and three reloads
  passed with no page errors. The measured render p95 was 4.12 seconds
  for this small run, which included the largest supported output.
- A live heredoc through the installed hook made two Jev requests. The
  parsed snapshot contained all 72 lines, including three protected rows
  with null probabilities. The exact 3,892-byte original stayed intact.
  In this rerun, the model scored all 69 judged lines above the cutoff and
  kept all 72. The deterministic `3 / 72` fixture verifies the reported
  omission case independently.
- The Linux binaries, plugin ZIP, and VSIX passed exact-content,
  source-byte, target, and version checks. The installed control matches
  the validated source files. The installed hook is trusted and enabled.

## Local deployment

The personal marketplace source was updated from the verified package,
then installed with `codex plugin add codex-jev@personal`. The Windows
control was installed from its VSIX. The pinned composer patch was
updated against extension 26.930.41038. Settings, keys, session choices,
and runtime data were preserved.

Codex removes previous version cache directories during installation.
Existing threads retain their old absolute hook paths. This repair keeps
the original 0.10.4 cache path and the intermediate 0.10.5 path populated
with the exact 0.10.6 package so those threads can continue. Retain these
compatibility paths until the corresponding threads stop. The registered
package path is 0.10.6.

Run **Developer: Reload Window** in each VS Code window to load control
0.9.9 and its renderer. The hook repair already applies to continuing
threads. New decisions include all source lines; old snapshots retain
the data originally recorded.

Rollback packages and deployment metadata are under
`~/.local/state/codex-jev/rollback/0.10.6-20261004/`. The original 0.10.4
package is preserved in the preceding 0.10.5 rollback directory. These
backups contain package files only. Private runtime data and keys were
not copied.

Evidence is retained in ignored
`.local/quality/runtime-repair-0.10.6-20261004/`. Release archives are in
`.local/submission/`.
