# Filtering behavior

One session `enabled` flag controls supported local tool output. Known independent-line formats proceed directly to relevance judgments. Unknown formats use a conservative classification request first. Code keeps exact source, coupled structures, diagnostics, completion evidence, and exhaustive results intact.

## Validated coverage contracts

Command results can include a single text block and duplicate `structuredContent`.
Decision accepts that wrapper only when both values describe the same known
command result and all envelope fields pass validation. Code-mode `exec` and
`wait` also accept serialized homogeneous command-result arrays and fulfilled
`Promise.allSettled` arrays. Optional indexes must match source order. Rejected
entries, mismatched duplicates, unknown fields, mixed media, and coupled
structured members keep the complete batch. Each accepted member retains its
metadata and output boundaries. The saved typed original contains the complete
transport envelope. A failed later relevance batch rolls back the whole result.

Diagnostic protection recognizes exact passing Cargo test records and reviewed
zero-valued diagnostic counters. It still protects real diagnostics on the same
line, nonzero or malformed counters, completion totals, and unknown diagnostic
formats. Path-list commands can return scalar-looking filenames such as `123`
or `true`; objects and arrays retain the structure guard. Explicit log reads
accept case-insensitive `.log` and numeric rotations such as `.log.1`.

The reviewed MCP read actions `list_commits`, `get_deployment_status`, and
`lookup_merge_conflicts` can pass routing despite mutation words in their
resource names. Credential checks and the saved generic MCP replacement policy
still apply. A read-only action name alone does not enable generic MCP
replacement.

## Classification and relevance

Classification selects one of eight output classes. Only the first four permit independent excerpts: repetitive logs, operation progress, independent search matches, and independent records. Exact content, prose, coupled payloads, and unknown mixed content remain complete. The excerptable classes must contain at least 95% of the normalized distribution. The selected class must be a maximum-probability class, and the full distribution must sum within 0.02 of one.

Each unprotected candidate line receives an independent task-relevance probability. Values at or below the configured cutoff, 5% by default, can be omitted. Protected context, representative duplicates, and the final line remain. A predicate or Noul probability is a relevance estimate; it is not a separate confidence score.


## Failure behavior

A failed request, invalid answer, local safety refusal, or storage failure keeps the complete result. A later-batch failure discards the incomplete evaluation. Built-in fallback, when enabled, retries the complete evaluation once within the same deadline. Custom providers never use fallback.

## Code-mode delivery

The [official code-mode hook contract](https://learn.chatgpt.com/docs/hooks#tool-calls-from-code-mode) applies hook decisions to nested tools. Decision returns `continue: false` with its prepared feedback. Codex documents that feedback as model-visible while the nested JavaScript promise remains resolved. A wrapper can therefore print the original return value. Changing the hook to block would reject that promise and change script behavior.

The [measurement guide](../operations/measurement.md) verifies preserved originals and measures prepared hook payloads. It does not establish delivered context or billed-token savings. Request attempts, outputs that reached API evaluation, classification keeps, line evaluations, previews, and replacements are distinct measures.
