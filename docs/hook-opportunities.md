# Codex Jev: possible next hooks

Research checked on 2026-09-26. Priority 1 is now implemented as an independent
use case within Jev's existing `PostToolUse` hook. Savings from other projects are not a forecast
for this plugin or for billed Codex tokens.

| Priority | Hook | Opportunity | Boundary and test before enabling |
| --- | --- | --- | --- |
| 1 — implemented | `PostToolUse` test/build log filter | Locally proposes known passing-test and progress lines, then asks Jev whether omitting them is safe. It preserves failures, totals, exit status, and a path to the exact original. | Explicit command allowlist, Jev judgment, completion and reduction gates, mock safety tests, and real Jev-backed command-output smoke. Downstream reread frequency remains unmeasured. |
| 2 | `PreToolUse` for Bash commands | Rewrite a small allowlist of verbose read-only commands to compact equivalents before execution. RTK demonstrates this command-specific approach. | Never rewrite compound commands or user-authored commands without an exact safe parse. Measure command equivalence, output size, and whether Codex asks for the full output again. Keep this opt-in. |
| 3 | `SessionStart` on `compact` or `resume` | Inject a short index of retained Jev outputs and task state after compaction so Codex can retrieve exact evidence without repeating a broad search. | This adds tokens on each injection, so require a strict size cap and prove fewer rereads in an end-to-end task. Do not inject full logs or stale notes. |

An indexed lookup tool for saved originals could complement the first two hooks:
return only matching lines and a recovery path, instead of making Codex reopen
an entire saved result. It would be an MCP tool, not an extra hook. Existing
Jev output replacement already preserves the complete original.

The former `PreCompact` handoff was removed. Codex currently allows that hook
to stop compaction, but its documented output cannot rewrite the compaction
input or summary. The third live use case instead filters broad search and
file-listing results at `PostToolUse`, before they enter the conversation.

Sources:

- [Codex hook contracts and event coverage](https://learn.chatgpt.com/docs/hooks),
  including `updatedInput`, `PostToolUse` replacement, and `SessionStart` after
  compaction.
- [RTK](https://github.com/rtk-ai/rtk) and its
  [quick start](https://github.com/rtk-ai/rtk/blob/develop/docs/guide/getting-started/quick-start.md):
  command-specific filtering and pre-execution rewriting.
- [context-compress](https://github.com/Open330/context-compress): indexed
  retrieval and the distinction between recoverable indexed output and
  response-only filtering.
- [Codex hook runtime](https://github.com/openai/codex/blob/main/codex-rs/core/src/hook_runtime.rs):
  actual lifecycle integration in the open-source implementation.
