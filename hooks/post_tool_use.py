"""Codex command-hook adapter. Writes only Codex hook JSON to stdout."""

import json
import os
from pathlib import Path
import sys

from jev import Config, Result, append_log, decide, jev_choice_request, jev_request, jev_test_build_request, load_api_key
from search_listing import command_kind as search_kind, decide_search_listing
from test_build import command_kind, decide_test_build


def main() -> None:
    try:
        data_dir = Path(os.environ["PLUGIN_DATA"])
        config = Config.from_file(data_dir / "config.json")
        if not (config.enabled or config.test_build_enabled or config.search_listing_enabled):
            print("{}")
            return
        payload = sys.stdin.read(5_000_001)
        if len(payload) > 5_000_000:
            print("{}")
            return
        event = json.loads(payload)
        if (config.test_build_enabled and event.get("tool_name") == "Bash"
                and command_kind(event.get("tool_input")) is not None):
            def evaluate_test_build(state, settings):
                try:
                    append_log(data_dir, Result("calling", "jev_request"), "Bash", "test_build")
                except OSError:
                    pass
                return jev_test_build_request(state, settings, load_api_key(data_dir))

            outcome = decide_test_build(event, config, evaluator=evaluate_test_build, storage=data_dir)
            try:
                append_log(data_dir, outcome, str(event.get("tool_name", "")), "test_build")
            except OSError:
                pass
            print(json.dumps(outcome.hook_output or {}, ensure_ascii=False))
            return
        if (config.search_listing_enabled and event.get("tool_name") == "Bash"
                and search_kind(event.get("tool_input")) is not None):
            def evaluate_search(state, questions, settings):
                try:
                    append_log(data_dir, Result("calling", "jev_request"), "Bash", "search_listing")
                except OSError:
                    pass
                return jev_choice_request(state, questions, settings, load_api_key(data_dir))

            outcome = decide_search_listing(event, config, evaluator=evaluate_search, storage=data_dir)
            try:
                append_log(data_dir, outcome, "Bash", "search_listing")
            except OSError:
                pass
            print(json.dumps(outcome.hook_output or {}, ensure_ascii=False))
            return
        if not config.enabled:
            print("{}")
            return

        def evaluate(state, settings):
            try:
                append_log(data_dir, Result("calling", "jev_request"), str(event.get("tool_name", "")))
            except OSError:
                pass
            return jev_request(state, settings, load_api_key(data_dir))

        outcome = decide(event, config, evaluator=evaluate, storage=data_dir)
        try:
            append_log(data_dir, outcome, str(event.get("tool_name", "")))
        except OSError:
            pass
        print(json.dumps(outcome.hook_output or {}, ensure_ascii=False))
    except Exception:
        # A malformed event, config, or API outage must keep the original result.
        print("{}")


if __name__ == "__main__":
    main()
