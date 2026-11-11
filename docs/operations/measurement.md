# Measure activity and effectiveness

A provider request, evaluated output, line evaluation, and prepared replacement are different events. Keep their denominators separate.

| Measure | What it establishes |
| --- | --- |
| Enabled invocation | The hook selected an enabled thread and recorded an invocation |
| Request intent or attempt | A local provider call was attempted; provider receipt is unverified |
| Received response | A response reached the client; it can still fail validation |
| Classification keep | The API judged the format and kept the complete output |
| Line evaluation | All required relevance answers completed and passed validation |
| Monitor preview | Proposed omissions were recorded; the full result stayed visible |
| Committed replacement | Saved originals and prepared shortened feedback were published |
| Host delivery | Requires consumer evidence; a receipt does not establish it |

Several requests can belong to one output. Fallback adds attempts. Classification-only outputs already used the API. Do not label `line evaluations / invocations` as API participation. Partial or interrupted history can support only lower bounds or unknown counts. The panel uses `≥` and `—` for these states.

## Read-only audits

Run from the repository root:

```bash
node scripts/usage_effectiveness_audit.cjs --data-dir <PLUGIN_DATA> \
  --codex-sessions <CODEX_HOME/sessions> --observation-date YYYY-MM-DD
node scripts/telemetry_audit.cjs --data-dir <absolute-PLUGIN_DATA>
```

Both accept `--since <UTC-ISO-timestamp>` for a retained-window slice. The usage audit compares durable activity, recorded provider usage, prepared payloads, and available session evidence. The telemetry audit reads content-free metadata only. Neither contacts a provider or reads provider credentials. See [telemetry](telemetry.md) for gaps and retention limits.

Record the source revision, hook/control versions, observation window, invocation coverage, distinct evaluated outputs, request attempts, classification keeps, completed evaluations, previews, and committed replacements. Report missing history explicitly. A recent retained slice is not lifetime coverage.

## Delivery and cost limits

Run **Decision: Show Usage Measurements** for the selected chat. The equivalent offline command is:

```bash
node scripts/delivery_audit.cjs --session-dir /absolute/plugin-data/sessions/session-hash
```

The report joins retained tool-output observations and model-request attempts by a hashed turn-and-agent key. It counts retries, failed attempts, cancellations, missing usage, prepared replacements, reported input/output tokens, and cache reads. A turn whose mode changes is unattributed. Missing turn IDs remain unattributed. Missing files, invalid rows, partial writes, and numeric overflow are reported as gaps.

Monitor and Filter have separate cohorts. Their difference in mean reported input tokens per observed attempt is an observational comparison. Use equivalent tasks, models, settings, and evidence for controlled comparisons. The report does not infer causality from dissimilar tasks or claim that every prepared replacement reached a model request.

Provider cache-read and cache-write counts are subsets of reported input tokens; they are never added to the input total. Missing cache measurements remain unknown. Advisory accounting stays separate from filtering activity. Dollar cost and causal savings remain null: the report does not assume prices, billing tiers, or a causal counterfactual.

The [official code-mode contract](https://learn.chatgpt.com/docs/hooks#tool-calls-from-code-mode) distinguishes hook feedback from the nested JavaScript return value. Decision returns `continue: false`. The nested promise still resolves, so a wrapper can print the complete original. A committed replacement does not prove reduced downstream context or billed tokens.

Prepared bytes saved, provider tokens consumed, latency, delivered context, and task quality need separate measurements. Synthetic fixtures establish behavior for their labels and inputs. They do not establish a general error rate, workload participation, or net financial benefit. Historical reports remain in Git history.

Use [synthetic evaluation](../development/evaluation.md) for reproducible runs. A low participation rate alone does not justify weaker privacy or evidence guards.
