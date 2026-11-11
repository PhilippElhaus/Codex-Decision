# Failure triage

Run **Decision: Triage Test Failure** with selected failure output in an editor. Another extension can call `codexDecision.triageFailure` with:

```json
{"name": "parser case", "output": "assertion failed: left 1, right 2"}
```

The provider returns a likely cause and a review priority. Causes are application, test, environment, dependency, and unknown. Priority ranges from 0 to 2: no demonstrated user impact, failed feature with a workaround, and blocked core functionality or data correctness risk.

The result opens as JSON. The **Decision failure reviews** Test Explorer controller also publishes the original supplied failure. It labels the cause and priority as advisory. Cause confidence below 0.5 displays as uncertain. These thresholds are presentation choices, not measured guarantees of model accuracy.

The controller retains at most 64 imported items in memory. It does not execute tests or discover another extension's private results. Review results retain the supplied failure status and exact failure text. They are not persisted as native test runs. Use the native runner to establish a new pass or failure.

The `triage_failure` MCP tool accepts `{"failure":{"name":"...","output":"..."}}`. Names are bounded to 512 bytes and output to 24,000 bytes. Provider budgets can impose a smaller total bound. Both built-in protocols and compatible custom endpoints use the same validation.

Function coverage remains responsible for [test selection](../development/test-impact.md). Model judgments never skip tests.
