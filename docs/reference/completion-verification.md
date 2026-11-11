# Completion verification

Decision compares claims with supplied evidence. It reports support and contradiction separately. Missing evidence is unverified; it is not a contradiction or a successful check.

**Decision: Verify Completion Claims** accepts a command argument or selected JSON:

```json
{
  "claims": ["All parser tests passed"],
  "evidence": [{"kind":"test","content":"parser test failed: expected 2, got 1"}]
}
```

Evidence kinds are `diff`, `test`, and `observation`. Supply 1–16 claims and 1–32 evidence records. Claims are bounded to 8,192 bytes each and evidence content to 24,000 bytes each. Complete requests must fit provider budgets. The `verify_completion` MCP tool accepts the same object.

## Automatic Stop review

Run **Decision: Configure Completion Verification**:

| Mode | Behavior |
| --- | --- |
| Off, the default | Do not capture or send completion evidence |
| Observe | Review available current-turn evidence and show a diagnostic for unverified claims |
| Enforce | Also request one continuation for an explicit contradiction with probability at least 0.95 |

The installation stores the choice in private `PLUGIN_DATA/assistance.json`, separately from filtering settings:

```json
{"version":1,"completion_verification":"observe"}
```

The mode applies to enabled Decision sessions. Capture retains at most eight recent eligible tool observations in one private snapshot of at most 24,000 serialized bytes. Each source result must fit 12,000 bytes. Sensitive, oversized, or unsupported results are not captured. Older observations can fall outside this window. Diff and test commands are reviewed through observed tool results; Stop does not run Git, execute tests, scan chat history, or infer unrecorded success.

The snapshot belongs to the exact turn and agent. Stop supplies its latest assistant message as one claim, bounded to 8,192 bytes. A missing turn ID, missing evidence, already active Stop continuation, changed evidence, provider failure, or budget failure cannot request a continuation. A private marker permits at most one Decision continuation for that turn, including repeated callbacks. The continuation asks Codex to recheck observations and correct the report. It does not grant permissions or execute a repair.

The 0.95 threshold is a conservative local policy, not measured proof of model accuracy. Evaluate it in Observe mode on representative work. Review does not replace native tests, human review, or deployment verification.

Evidence records are chronological. Later verification can supersede an earlier failure within its actual scope. A skipped capture or a trimmed evidence window marks the snapshot incomplete. Incomplete snapshots can produce advisory review, but they cannot request a continuation based on older observations.

Disabling the mode stops new capture. The last private snapshot remains until overwritten by a later captured turn or manually removed. Credentials, filtering settings, and saved originals remain independent.
