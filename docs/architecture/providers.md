# Provider contracts

OpenAI Decisions and TypeSafe Jev use HTTPS bearer authentication and return typed probabilities. The Rust provider adapter owns their wire formats; routing, protection, omission thresholds, publication, and rollback use the same validated evidence pipeline.

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


## API context budgets

Advisory workflows add Score questions. OpenAI encodes ordered `levels` with numeric labels and validates returned labels, numeric positions, distributions, confidence, and score means. TypeSafe uses ordered `criteria` and position-keyed probabilities. These workflows use native structured evidence: OpenAI `input_json` parts and TypeSafe `state`. Existing output filtering retains the text representation described above.

OpenAI assistance requests use a stable workflow cache key. Without an explicit reference, implicit caching remains active. Optional stable reference text carries an explicit breakpoint before dynamic evidence. OpenAI requires an identical reusable prefix of at least 1,024 tokens; questions are outside that shared prefix. Cache reads and writes are recorded when reported, without adding them to total input tokens. See the [official Decisions guide](https://developers.openai.com/api/docs/guides/decisions#reuse-shared-input-with-prompt-caching).

The assistance budget measures the actual wire projection even when a custom endpoint uses a custom model name. Oversized structured inputs fail before sending. Both providers share the same local byte caps below.

Both providers use local bounds of 32,000 units for shared evidence plus the longest question and 64,000 for the complete request. These conservative caps originate in the documented Jev limits. They are local caps for OpenAI, not a claim about OpenAI’s maximum context. Each bound counts actual serialized UTF-8 bytes as potential tokens and includes 4,096 units of framing headroom. OpenAI budgeting includes the JSON text encoding, ordered names, and appended rubric. No four-characters-per-token estimate is used.

The packer includes complete targets and nearby context. It adapts batch sizes without a candidate-line or batch-count cap. Every eligible line belongs to exactly one batch. Inputs above the existing 10,000 physical-line bound remain intact. An unpackable target, failed request, malformed answer, or later-batch failure rolls back progress and leaves the full original visible.

Window fitting measures borrowed source rows once and uses exact prefix costs for later probes. It builds only the selected requests. A separate final serialized-size check remains active. OpenAI size measurement counts the second JSON escaping layer without constructing a wire buffer. Execution serializes borrowed OpenAI question and choice views directly into the outgoing buffer. TypeSafe serializes its existing request. These changes preserve the emitted request bytes, question wording, complete targets, and context.


Implementations: [Rust adapters](../../rust/decision/src/provider.rs), [control providers](../../vscode-control/providers.js), and [transport](../../vscode-control/provider-transport.js).
