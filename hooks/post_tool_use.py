"""Codex command-hook adapter. Writes only Codex hook JSON to stdout."""

import json
import os
from pathlib import Path
import sys

from jev import Config, DEFAULT_DECISION_METHODS, DEFAULT_THRESHOLDS, Result, append_log, capture_request, decide, extract_text, jev_choice_request, jev_request, jev_test_build_request, load_api_key
from receipts import write_receipts
from search_listing import command_kind as search_kind, decide_search_listing
from test_build import command_kind, decide_test_build


def main() -> None:
    try:
        data_dir = Path(os.environ["PLUGIN_DATA"])
        config = Config.from_file(data_dir / "config.json")
        if not (config.enabled or config.test_build_enabled or config.search_listing_enabled):
            print("{}")
            return
        payload = sys.stdin.read(16_000_001)
        if len(payload) > 16_000_000:
            print("{}")
            return
        event = json.loads(payload)
        calls = []

        def finish(outcome, filter_name):
            try:
                append_log(data_dir, outcome, str(event.get("tool_name", "")), filter_name, event, config)
            except (OSError, ValueError, TypeError):
                pass
            try:
                write_receipts(data_dir, event, outcome,
                               sorted(calls, key=lambda call: call["state"].get("chunk_index", 1)),
                               filter_name, config.log_limit_mb, config.never_delete_logs,
                               {"mode": config.mode,
                                "decision_methods": {
                                    **DEFAULT_DECISION_METHODS[filter_name], **config.decision_methods.get(filter_name, {})},
                                "cutoffs": {**DEFAULT_THRESHOLDS[filter_name], **config.thresholds.get(filter_name, {})}},
                               extract_text(str(event.get("tool_name", "")), event.get("tool_response")))
            except (OSError, ValueError, TypeError):
                pass
            print(json.dumps(outcome.hook_output or {}, ensure_ascii=False))

        if (config.test_build_enabled and event.get("tool_name") == "Bash"
                and command_kind(event.get("tool_input")) is not None):
            def evaluate_test_build(state, settings):
                try:
                    append_log(data_dir, Result("calling", "jev_request"), "Bash", "test_build", event, config)
                except (OSError, ValueError):
                    pass
                call = {"state": state}
                try:
                    with capture_request(call):
                        answer = jev_test_build_request(state, settings, load_api_key(data_dir))
                    call["answer"] = answer
                    calls.append(call)
                    return answer
                except Exception as error:
                    call["error"] = type(error).__name__
                    calls.append(call)
                    raise

            outcome = decide_test_build(event, config, evaluator=evaluate_test_build, storage=data_dir)
            finish(outcome, "test_build")
            return
        if (config.search_listing_enabled and event.get("tool_name") == "Bash"
                and search_kind(event.get("tool_input")) is not None):
            def evaluate_search(state, questions, settings):
                try:
                    append_log(data_dir, Result("calling", "jev_request"), "Bash", "search_listing", event, config)
                except (OSError, ValueError):
                    pass
                call = {"state": state, "questions": questions}
                try:
                    with capture_request(call):
                        answer = jev_choice_request(state, questions, settings, load_api_key(data_dir))
                    call["answer"] = answer
                    calls.append(call)
                    return answer
                except Exception as error:
                    call["error"] = type(error).__name__
                    calls.append(call)
                    raise

            outcome = decide_search_listing(event, config, evaluator=evaluate_search, storage=data_dir)
            finish(outcome, "search_listing")
            return
        if not config.enabled:
            print("{}")
            return

        def evaluate(state, settings):
            try:
                append_log(data_dir, Result("calling", "jev_request"), str(event.get("tool_name", "")), "output", event, config)
            except (OSError, ValueError):
                pass
            call = {"state": state}
            try:
                with capture_request(call):
                    answer = jev_request(state, settings, load_api_key(data_dir))
                call["answer"] = answer
                calls.append(call)
                return answer
            except Exception as error:
                call["error"] = type(error).__name__
                calls.append(call)
                raise

        outcome = decide(event, config, evaluator=evaluate, storage=data_dir)
        finish(outcome, "output")
    except Exception:
        # A malformed event, config, or API outage must keep the original result.
        print("{}")


if __name__ == "__main__":
    main()
