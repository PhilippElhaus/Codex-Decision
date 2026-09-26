"""Mock Jev decisions and quantify model-visible context using synthetic output.

Install tiktoken separately for exact o200k_base counts. Without it, the
report explicitly labels a rough four-characters-per-token proxy. This does
not measure model execution or token billing in Codex.
"""

from __future__ import annotations

import json
import statistics
import time

from replay import generated_cases
from jev import Config, capsule, decide, extract_text


def token_counter():
    try:
        import tiktoken
    except ImportError:
        return "chars/4 proxy", lambda value: round(len(value) / 4)
    encoding = tiktoken.get_encoding("o200k_base")
    return "o200k_base", lambda value: len(encoding.encode(value))


def benchmark(per_category: int = 20) -> dict:
    tokenizer, tokens = token_counter()
    config = Config(enabled=True, mode="replace")
    rows = []
    cases = list(generated_cases(per_category))
    for case in cases:
        event = case["event"]
        content = extract_text(event["tool_name"], event["tool_response"])
        start = time.perf_counter()
        outcome = decide(event, config, evaluator=lambda *_: case["mock_scores"], simulate=True)
        elapsed_ms = (time.perf_counter() - start) * 1000
        replacement = capsule(content, "[saved original]") if outcome.status == "replace" else content
        original_tokens = tokens(content) if content is not None else 0
        visible_tokens = tokens(replacement) if replacement is not None else 0
        rows.append({
            "category": case["category"], "status": outcome.status,
            "local_ms": elapsed_ms, "original_tokens": original_tokens,
            "visible_tokens": visible_tokens,
        })
    replaced = [row for row in rows if row["status"] == "replace"]
    other = [row for row in rows if row["status"] != "replace"]
    total_before = sum(row["original_tokens"] for row in rows)
    total_after = sum(row["visible_tokens"] for row in rows)
    local_times = sorted(row["local_ms"] for row in rows)
    per_replaced_saved = [row["original_tokens"] - row["visible_tokens"] for row in replaced]
    return {
        "kind": "MOCKED POLICY AND CONTEXT BENCHMARK",
        "tokenizer": tokenizer,
        "cases": len(rows), "replaced": len(replaced), "kept_or_skipped": len(other),
        "false_replacements_against_synthetic_labels": sum(
            row["status"] == "replace" and not case["expected_replace"]
            for row, case in zip(rows, cases)
        ),
        "original_tokens": total_before, "visible_tokens": total_after,
        "tokens_saved": total_before - total_after,
        "context_reduction_percent": round(100 * (1 - total_after / total_before), 1),
        "replaced_output_reduction_percent": round(100 * (1 -
            sum(row["visible_tokens"] for row in replaced) /
            sum(row["original_tokens"] for row in replaced)), 1),
        "median_tokens_saved_per_replaced_output": round(statistics.median(per_replaced_saved)),
        "median_saved_per_replaced_output_as_fraction_of_128k_window_percent": round(
            100 * statistics.median(per_replaced_saved) / 128_000, 1,
        ),
        "local_gate_p50_ms": round(statistics.median(local_times), 2),
        "local_gate_p95_ms": round(local_times[int(0.95 * (len(local_times) - 1))], 2),
        "per_category": {
            category: {
                "cases": len(selected),
                "replaced": sum(row["status"] == "replace" for row in selected),
                "tokens_saved": sum(row["original_tokens"] - row["visible_tokens"] for row in selected),
            }
            for category in sorted({row["category"] for row in rows})
            if (selected := [row for row in rows if row["category"] == category])
        },
    }


if __name__ == "__main__":
    print(json.dumps(benchmark(), indent=2))
