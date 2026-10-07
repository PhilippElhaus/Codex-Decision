# Decision integration

One session `enabled` flag controls supported local tool output. Known independent-line formats proceed directly to relevance judgments. Unknown formats use a conservative classification request first. Code keeps exact source, coupled structures, diagnostics, completion evidence, and exhaustive results intact.

## Providers and wire formats

OpenAI Decisions is the default. TypeSafe Jev is an explicit alternative. Both providers use HTTPS bearer authentication and return typed probabilities. The Rust provider adapter owns their wire formats; routing, protection, omission thresholds, publication, and rollback use the same validated evidence pipeline.

| Contract | OpenAI Decisions | TypeSafe Jev |
| --- | --- | --- |
| Endpoint | `https://api.openai.com/v1/decisions` | `https://api.typesafe.ai/v1/systemone` |
| Default model | `gpt-6-luna` | `jev-latest` |
| Private key field | `OPENAI_API_KEY` | `JEV_API_KEY` |
| Shared evidence | `input`: JSON-encoded text | `state`: JSON object |
| Questions | Ordered array with unique `name` | Object keyed by question ID |
| Relevance question | `predicate`; rubric appended to instructions | `noul`; structured criteria |
| Classification choices | Array of `{value, description}` | `criteria` object |
| Answers | Ordered array with echoed `name` | Object keyed by question ID |
| Relevance value | `probability` | `noul` |
| Choice distribution | Array of `{value, probability}` | Probability object |

The adapter encodes the complete shared state as text for OpenAI. It preserves task, command, source order, complete target text, and context. It appends the existing true/false rubric to each predicate’s instructions. Classification retains all eight classes and their descriptions. Question order is deterministic, including names such as `line_10` and `line_2`.

A minimal OpenAI relevance request uses this wire shape:

```json
{
  "model": "gpt-6-luna",
  "input": "{\"task\":\"Find the failure\",\"lines\":[{\"line\":2,\"text\":\"INFO routine progress\",\"target\":true}]}",
  "questions": [{
    "name": "line_2",
    "type": "predicate",
    "instructions": "Does source line 2 contain a concrete finding needed for task? Routine progress is not a finding."
  }]
}
```

The matching answer is `{"name":"line_2","type":"predicate","probability":0.01}` inside `answers`. The adapter converts wire answers to the existing named evidence representation. It rejects wrong counts, wrong names, reordered answers, duplicate choice values, provider/model mismatches, refusals, and unexpected types. The pipeline then verifies finite probabilities in `[0,1]` and complete classification distributions. Duplicate JSON fields are rejected before normalization. Normalized batch evidence and receipts remain compatible with the existing quality replay and panel readers.

## Classification and relevance

Classification selects one of eight output classes. Only the first four permit independent excerpts: repetitive logs, operation progress, independent search matches, and independent records. Exact content, prose, coupled payloads, and unknown mixed content remain complete. The excerptable classes must contain at least 95% of the normalized distribution. The selected class must be a maximum-probability class, and the full distribution must sum within 0.02 of one.

Each unprotected candidate line receives an independent task-relevance probability. Values at or below the configured cutoff, 5% by default, can be omitted. Protected context, representative duplicates, and the final line remain. A predicate or Noul probability is a relevance estimate; it is not a separate confidence score.

## API context budgets

Both providers use local bounds of 32,000 units for shared evidence plus the longest question and 64,000 for the complete request. These conservative caps originate in the documented Jev limits. They are local caps for OpenAI, not a claim about OpenAI’s maximum context. Each bound counts actual serialized UTF-8 bytes as potential tokens and includes 4,096 units of framing headroom. OpenAI budgeting includes the JSON text encoding, ordered names, and appended rubric. No four-characters-per-token estimate is used.

The packer includes complete targets and nearby context. It adapts batch sizes without a candidate-line or batch-count cap. Every eligible line belongs to exactly one batch. Inputs above the existing 10,000 physical-line bound remain intact. An unpackable target, failed request, malformed answer, or later-batch failure rolls back progress and leaves the full original visible.

## Configuration and evaluation

New configs use schema 5; shared settings use schema 4. They record `provider` and `model`. Legacy schemas migrate conservatively and retain TypeSafe. Provider and model must agree. Shared provider settings apply installation-wide; session enablement stays independent. There is no automatic provider fallback.

The same synthetic quality runner accepts `--provider openai` or `--provider typesafe`. It exercises the real debug hook, panel parser, saved originals, and quality replay. Live mode uses the selected saved key only in proxy memory. It records HTTP and complete-output latency separately. It limits calls and usage tokens and sends only reviewed synthetic data. See [provider benchmarks](../development/provider_benchmarks_2026-10-07.md) for measured results and limitations.

Official contracts: [OpenAI Decisions](https://developers.openai.com/api/reference/typescript/resources/decisions/methods/create), [TypeSafe HTTP API](https://docs.typesafe.ai/api).
