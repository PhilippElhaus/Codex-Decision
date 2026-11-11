# Privacy and safeguards

Decision sends eligible tool output and task context to the selected provider while the thread is enabled. The connection test sends only a synthetic readiness question. Hosted tools and calls that do not emit local PostToolUse events are outside this hook.

## What can leave the machine

Explicit context-ranking and failure-triage commands send the supplied source blocks, query, or failure output to the selected provider. Claim-verification commands send the supplied claims and evidence. These commands do not read arbitrary referenced files or URLs. Automatic completion verification starts off. When enabled, it sends a bounded current-turn evidence snapshot and the latest completion message. Privacy guards run before these requests, but pattern guards cannot prove absence of secrets. See [completion verification](completion-verification.md).

Unknown formats first send a bounded classification sample: the latest safe task cue, tool, bounded command, available exit code, line count, up to 21 distributed samples, and up to 12 diagnostic samples. Each sample is limited to 240 characters. Known independent-line formats skip classification.

Relevance batches contain complete candidate text, source order, nearby context, and bounded diagnostic/boundary anchors. Context-only text is capped at 500 characters per line. Protected rows can appear as context. The provider sees ANSI-cleaned text; retained output copies exact original UTF-8 spans and line endings. Several questions share each request.

Built-in providers receive only their matching key in an HTTPS Authorization header. Custom providers receive the same eligible evidence at their configured full endpoint. Custom authentication can use bearer, Basic, or a named header. HTTPS is required except on loopback; redirects are rejected. Public CA trust is scoped to that custom connection. See [provider setup](../setup/providers.md).

Built-in fallback starts off. Enabling it permits one complete retry with the alternate provider, so eligible text can reach both services. Local safety and storage failures do not trigger fallback. Custom providers never use fallback.

## Local checks before requests

Short, sensitive, mixed-media, mutating, unsupported, exact-source, exhaustive, and coupled structured results stay complete. Sensitive-field checks inspect common credential delimiters, plain text, JSON, XML, bounded decoded JSON strings, and command metadata. These are conservative pattern checks, not a proof that every secret is detected.

The transcript reader uses the latest safe user task. It does not replace a rejected latest record with an older task. It reads a 64 KiB tail first and can scan transcripts up to 50 MB. Serialized user records are bounded to 16 MB and extracted task text to 64 KiB. Missing task context permits preview, never replacement. Inputs above 10,000 physical lines or 256 KiB of serialized tool input stay complete before provider evaluation.

Request packing uses conservative local byte budgets and complete target text. Invalid answers, budget failures, deadlines, and later-batch failures keep the complete result. See [filtering](filtering.md) and [provider bounds](../architecture/providers.md#api-context-budgets).

## What stays local

Keys live in private `PLUGIN_DATA/.env`. Saved secrets do not return to the webview or enter receipts, health records, or telemetry. Connection settings and credentials are shared by the installation; thread enablement is independent. Windows and WSL have separate stores.

Receipts and batch evidence can contain tool text and task cues. Saved originals contain exact output. Keep the data directory private. Directory-chain checks reject linked roots and managed paths. Unix files and directories use private permissions. These checks do not replace OS access controls or eliminate every race with another process using the same account.

**Show skipped output** is a separate local opt-in. Captures include original tool input and response, including content that a provider guard rejected. They are never sent to the provider by this inspector. Capture starts with future skips and retains at most 20 calls and 4 MiB. Oversized or unavailable payloads are marked explicitly. Disabling capture stops new records; existing records remain subject to retention.

Managed logs obey per-session retention. Saved originals remain until manually removed. Content-free telemetry has a separate bounded log and can contain gaps. See [storage](../architecture/storage.md) and [telemetry](../operations/telemetry.md).

## Updates and delivery

The updater contacts the fixed public GitHub repository and release-asset hosts. It sends no chat content, tool output, provider credentials, or GitHub token. Downloads remain temporary until size/SHA-256 verification and installation finish. Set `codexDecision.autoUpdate` to `false` to stop automatic requests.

Code-mode hook feedback does not replace the nested JavaScript return value. Prepared removals and payload estimates do not establish delivered context or financial savings. See [measurement](../operations/measurement.md).
