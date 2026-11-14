---
name: decision-output
description: Help configure and verify Codex Decision's local tool-output filters when the user asks about Decision setup, shortened evidence, saved originals, settings, logs, or unexpected results. Do not activate for unrelated decision applications.
---

# Codex Decision output

Use this skill for setup and evidence review. Invoking it does not enable filtering or authorize sending private evidence to a provider.

Decision evaluates supported local tool output through a Rust PostToolUse hook. The integrated VS Code control enables a new local thread once and preserves its later on/off choice. A standalone installation starts disabled. Windows and WSL keep separate settings, credentials, and activity.

## Setup and diagnosis

Identify the installed plugin, selected Codex runtime, plugin data directory, and active thread before reading state. Do not assume that another window uses the same runtime or thread.

- Click **decision** to change the selected thread's enabled flag. Shared settings control Monitor/Filter mode, relevance cutoff, provider, and retention.
- Configure the connection through **Connect Decision** or **Codex settings → Decision**. Never ask for a key in chat or print a saved credential.
- Review changed hooks in `/hooks` when Codex requests trust. API reachability does not establish hook activity or trust. The integrated installer preserves Codex's trust database.
- Run **Decision: Check Integration** or **Decision: Repair Integration** for missing controls. Unknown or modified Codex builds require a reviewed patch profile. Do not bypass asset verification.
- Clear a mismatched `codexDecision.dataDirectory` override before repairing automatic discovery. Preserve each runtime's data and credentials.
- Preserve active plugin caches and patch recovery files. Existing threads can retain recorded hook paths. Do not delete a settings lock until its owner has stopped.

Temporary installation failures retry within bounded limits. Read the safe phase diagnostic in **Decision Integration**. Deterministic registration, metadata, or host-build refusals need their underlying cause corrected.

Use the [installation guide](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/setup/installation.md) for exact commands, recovery, and supported-platform behavior.

## Providers and privacy

OpenAI Decisions and TypeSafe Jev have separate saved keys. A custom connection must implement one of their decision schemas; an ordinary chat-completions endpoint needs an adapter.

A custom connection accepts an endpoint, request model, optional exact response model, authentication method, and optional public PEM CA certificate. Trust applies only to that connection and retains hostname verification. Changing its endpoint, authentication identity, or certificate requires fresh credentials. Never infer a credential or connection change from a diagnostic task.

Built-in provider fallback starts off. Enabling it authorizes eligible evidence to reach the alternate provider after a missing primary key or provider failure. Custom connections do not use automatic fallback. Local safety and storage failures do not trigger fallback.

Only send evidence covered by the user's task and provider authorization. Privacy guards supplement that boundary. On a surface without local hook execution, explain the limitation before suggesting settings.

See [provider setup](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/setup/providers.md) and [data handling](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/reference/privacy.md).

## Review shortened output

Prefer Monitor while evaluating unfamiliar output. Known independent-line formats proceed to relevance judgments. Unknown formats first require at least 95% combined probability for an excerptable class. The default omission cutoff is inclusive: relevance at or below 5% can qualify.

Local guards preserve diagnostics, exact source and diffs, exhaustive requests, completion evidence, representative repeated lines, and the last line. Batches contain complete targets. A failed request, invalid answer, incomplete batch, or storage failure keeps the full result. Do not weaken guards merely to increase participation.

The **Decision** panel shows the selected thread's latest saved line decision, current hook activity, and request/skip counters. Totals distinguishes exact counts, lower bounds, and unknown history. A saved decision can predate a later skip or error. Protected and pending rows have no relevance probability.

Read the omission map. If a claim depends on omitted lines, inspect the exact saved-original path and needed ranges within the user's access boundaries. Supported typed results also save their complete transport as an adjacent JSON file.

**Show skipped output** enables bounded private capture for future skips. It does not send captured records to a provider. Capture can contain sensitive tool input and output; inspect only records needed for the task.

A prepared replacement is not proof of model-context reduction or billed-token savings. Code-mode wrappers can still print an original nested return value. Report delivery and cost as unverified without consumer evidence.

Use `decisionctl evaluate-quality --cases <reviewed-cases.json>` for labeled evidence-loss checks and current relevance-cutoff trials. Historical receipts remain inspectable; the retired dual-score engine is not replayed. See [filtering](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/reference/filtering.md) and [measurement](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/operations/measurement.md).

## Advisory workflows

**Decision: Register MCP Tools in Codex** registers `rank_context`, `triage_failure`, and `verify_completion`. Start a new chat to load them. Ranking returns every exact original. Failure triage is advisory; native coverage selects tests.

**Decision: Show Usage Measurements** reports observed tokens and cache counts. It does not establish causal savings.

**Decision: Configure Completion Verification** selects Off, Observe, or Enforce. It starts Off and applies to enabled sessions. Enforce can request one continuation for an explicit contradiction only when current-turn evidence is complete and unchanged. It grants no additional permissions. Do not enable automatic review or send private evidence without task authorization.

See [advisory architecture](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/architecture/assistance.md) and [completion verification](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/reference/completion-verification.md).
