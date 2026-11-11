# Advisory service

The native `decision-hook` exposes explicit workflows through `--assist` and a local stdio MCP server through `--mcp`. The VS Code companion calls the same service. Connections, credentials, TLS, redirect refusal, deadlines, strict JSON, and response identity checks reuse the filtering transport.

| Workflow | Questions | Result |
| --- | --- | --- |
| Context ranking | One Score per candidate | Stable ranking with every exact original |
| Failure triage | Cause Choice and priority Score | Advisory classification with distributions |
| Completion verification | Support and contradiction predicates per claim | Supported, contradicted, or unverified claims |

Inputs use field allowlists, bounded strings and arrays, and a 128 KiB outer byte limit. The service opens no caller-supplied path or URL. Privacy guards run before requests. Evidence instructions are treated as data. Answer validation checks exact identities, complete distributions, finite probabilities in `[0,1]`, sum tolerance, matching score means, and valid choices. Refusals and partial answers fail the workflow.

OpenAI receives `input_json` evidence after stable grounding text. An optional reference provides an explicit cache boundary. TypeSafe receives structured state. Budgets count the actual protocol projection, custom model names, framing, and questions. Existing filtering retains its text projection and streaming encoder.

Advisory calls use an `assistance/` child directory for health and metadata. They never increment parent filter counters or publish shortened output. They use the selected connection without automatic provider fallback. The configured request timeout applies, capped at ten seconds.

Model lifecycle observations are local metadata. Model-request hooks do not rewrite context or block requests. Stop continuation requires the separate completion-review mode.

Sources: [workflows](../../rust/decision/src/assistance.rs), [runtime](../../rust/decision/src/bin/decision-hook/assistance_runtime.rs), [MCP](../../rust/decision/src/bin/decision-hook/assistance_runtime/mcp.rs), [lifecycle](../../rust/decision/src/bin/decision-hook/lifecycle.rs), and [VS Code](../../vscode-control/assistance.js).
