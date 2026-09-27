"""Evaluate labeled filter replays and propose conservative cutoff changes.

Input is an explicitly reviewed JSONL file. It is never read from private
runtime receipts automatically because those can contain user data.
"""

from __future__ import annotations

from dataclasses import replace
import argparse
import json
from math import log, sqrt
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hooks"))
from jev import Config, DEFAULT_THRESHOLDS, candidate  # noqa: E402
from search_listing import _decision  # noqa: E402
from test_build import jev_approves_omission  # noqa: E402


ROUTES = ("output", "test_build", "search_listing")


def load_cases(path: Path) -> list[dict]:
    cases = []
    with path.open(encoding="utf-8") as source:
        for number, line in enumerate(source, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if (not isinstance(row, dict) or row.get("route") not in ROUTES
                    or type(row.get("safe_to_shorten")) is not bool
                    or not isinstance(row.get("original"), str)
                    or not isinstance(row.get("visible"), str)
                    or not isinstance(row.get("required", []), list)
                    or any(not isinstance(item, str) or item not in row["original"]
                           for item in row.get("required", []))):
                raise ValueError(f"invalid quality case at line {number}")
            cases.append(row)
    if not cases:
        raise ValueError("quality dataset is empty")
    return cases


def would_shorten(row: dict, config: Config) -> bool:
    route = row["route"]
    if route == "output":
        return candidate(row["scores"], config)
    if route == "test_build":
        return jev_approves_omission(row["scores"], config)
    return _decision(row["answer"], config) != "retain"


def upper_risk(errors: int, selected: int, delta: float = 0.05) -> float:
    """Distribution-free Hoeffding bound for a fixed gate on independent cases."""
    return min(1.0, errors / selected + sqrt(log(1 / delta) / (2 * selected))) if selected else 1.0


def summarize(cases: list[dict], config: Config | None = None) -> dict:
    config = config or Config()
    routes = {}
    for route in ROUTES:
        subset = [row for row in cases if row["route"] == route]
        selected = [row for row in subset if would_shorten(row, config)]
        errors = sum(not row["safe_to_shorten"] for row in selected)
        missing = sum(any(fragment not in row["visible"] for fragment in row.get("required", []))
                      for row in subset if row["visible"] != row["original"])
        paired = [row for row in subset if type(row.get("baseline_task_success")) is bool
                  and type(row.get("filtered_task_success")) is bool]
        routes[route] = {
            "cases": len(subset), "gate_would_shorten": len(selected),
            "unsafe_gate_decisions": errors, "unsafe_risk_upper_95": round(upper_risk(errors, len(selected)), 4),
            "visible_results_missing_required_evidence": missing,
            "characters_saved": sum(max(0, len(row["original"]) - len(row["visible"])) for row in subset),
            "paired_tasks": len(paired),
            "baseline_tasks_solved": sum(row["baseline_task_success"] for row in paired),
            "filtered_tasks_solved": sum(row["filtered_task_success"] for row in paired),
        }
    return routes


def recommend(cases: list[dict], route: str, max_risk: float = 0.05) -> dict | None:
    """Only propose tighter settings; require a risk bound on held-out cases."""
    if not 0 < max_risk < 1:
        raise ValueError("max_risk must be between zero and one")
    subset = [row for row in cases if row["route"] == route]
    if len(subset) < 20:
        return None
    # A deterministic split avoids choosing and validating on the same labels.
    train = [row for index, row in enumerate(subset) if index % 3 != 0]
    holdout = [row for index, row in enumerate(subset) if index % 3 == 0]
    defaults = DEFAULT_THRESHOLDS[route]
    candidates = []
    for margin in range(0, 31, 5):
        if route == "search_listing":
            values = {name: min(100, value + margin) for name, value in defaults.items()}
        else:
            values = {name: (max(0, value - margin) if name.endswith("_max") else min(100, value + margin))
                      for name, value in defaults.items()}
        config = replace(Config(), thresholds={route: values})
        selected = [row for row in train if would_shorten(row, config)]
        errors = sum(not row["safe_to_shorten"] for row in selected)
        candidates.append((upper_risk(errors, len(selected)), -len(selected), margin, values))
    eligible = [candidate for candidate in candidates if candidate[0] <= max_risk]
    if not eligible:
        return None
    _, _, margin, values = min(eligible, key=lambda item: (item[2], item[1]))
    config = replace(Config(), thresholds={route: values})
    selected = [row for row in holdout if would_shorten(row, config)]
    errors = sum(not row["safe_to_shorten"] for row in selected)
    if upper_risk(errors, len(selected)) > max_risk:
        return None
    return {"thresholds": values, "margin": margin, "held_out_cases": len(holdout),
            "held_out_shorten": len(selected), "held_out_errors": errors,
            "held_out_risk_upper_95": round(upper_risk(errors, len(selected)), 4)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cases", type=Path, help="reviewed JSONL with route, original, visible, labels and Jev answers")
    parser.add_argument("--max-risk", type=float, default=0.05)
    args = parser.parse_args()
    cases = load_cases(args.cases)
    print(json.dumps({"quality": summarize(cases),
                      "suggested_cutoffs": {route: recommend(cases, route, args.max_risk) for route in ROUTES}},
                     indent=2))


if __name__ == "__main__":
    main()
