"""Jev-gated reduction of broad, line-oriented search and file listings."""

from __future__ import annotations

from collections import OrderedDict
import json
import os
from pathlib import Path
import re
import shlex
import stat
import time
from typing import Callable

from jev import Config, Result, SENSITIVE, _output_path, decision_method, save_original, threshold


MIN_CHARS = 4096
MIN_LINES = 35
MAX_GROUPS = 12
MAX_STATE_CHARS = 7000
MAX_REQUEST_CHARS = 10000
MAX_FEEDBACK_CHARS = 8000
SHELL_OPERATORS = re.compile(r"[;&|<>`\r\n]|\$\(")
HIT = re.compile(r"^([^\r\n:]+):(\d+):(.*)$")
PATH = re.compile(r"^[^\x00-\x1f\x7f]+$")
OPTIONS_WITH_VALUE = {"-g", "--glob", "-t", "--type", "-T", "--type-not", "--iglob"}
UNSAFE_OPTIONS = {"--json", "--null", "-0", "--multiline", "-U", "--count", "-c", "--count-matches", "--files-with-matches", "-l", "--files-without-match", "--vimgrep", "--heading", "--context", "-C", "--before-context", "-B", "--after-context", "-A", "--only-matching", "-o", "--replace", "-r"}


def command_kind(tool_input: object) -> str | None:
    if not isinstance(tool_input, dict):
        return None
    command = tool_input.get("command")
    if not isinstance(command, str) or not command or len(command) > 2048 or SHELL_OPERATORS.search(command):
        return None
    try:
        words = shlex.split(command)
    except ValueError:
        return None
    if not words:
        return None
    executable = Path(words[0]).name
    args = words[1:]
    if executable == "git" and args[:1] == ["ls-files"] and all(
        not arg.startswith("-") or arg in {"--cached", "--recurse-submodules"} for arg in args[1:]
    ):
        return "listing"
    if executable != "rg":
        return None
    if "--files" in args:
        index = 0
        while index < len(args):
            arg = args[index]
            if arg in OPTIONS_WITH_VALUE:
                index += 2
                if index > len(args):
                    return None
                continue
            if arg.startswith("-") and arg not in {"--files", "--hidden", "--no-ignore", "--no-ignore-vcs"}:
                return None
            index += 1
        return "listing"
    if not any(arg in ("-n", "--line-number") or arg.startswith("-") and "n" in arg[1:] and not arg.startswith("--") for arg in args):
        return None
    patterns = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in UNSAFE_OPTIONS or any(arg.startswith(option + "=") for option in UNSAFE_OPTIONS if option.startswith("--")):
            return None
        if arg in OPTIONS_WITH_VALUE:
            index += 2
            if index > len(args):
                return None
            continue
        if arg == "--":
            patterns.extend(args[index + 1:])
            break
        if arg.startswith("-"):
            if arg not in {"-n", "--line-number", "-i", "--ignore-case", "-F", "--fixed-strings", "-S", "--smart-case", "--hidden", "--no-ignore"}:
                return None
        else:
            patterns.append(arg)
        index += 1
    return "search" if patterns and patterns[0] not in {"", ".", "./"} else None


def _task_hint(event: dict, kind: str) -> str:
    # The command is enough for searches; listings need a recent user goal.
    command = event["tool_input"]["command"]
    transcript = event.get("transcript_path")
    if isinstance(transcript, str):
        try:
            source = Path(transcript)
            if source.is_absolute() and not source.is_symlink():
                fd = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                try:
                    info = os.fstat(fd)
                    if stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid():
                        os.lseek(fd, max(0, info.st_size - 65536), os.SEEK_SET)
                        tail = os.read(fd, 65536)
                        for line in reversed(tail.splitlines()):
                            if b'"role"' not in line or b'"user"' not in line:
                                continue
                            try:
                                row = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            payload = row.get("payload", {})
                            if row.get("type") != "response_item" or payload.get("role") != "user":
                                continue
                            parts = payload.get("content", [])
                            message = " ".join(part.get("text", "") for part in parts if isinstance(part, dict) and part.get("type") == "input_text")
                            message = " ".join(message.split())[:500]
                            if message and not SENSITIVE.search(message):
                                return message
                finally:
                    os.close(fd)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass
    return command[:300] if kind == "search" else ""


def _groups(output: str, kind: str) -> OrderedDict[str, list[str]] | None:
    lines = output.splitlines(keepends=True)
    if len(lines) < MIN_LINES or len(lines) > 20000:
        return None
    parsed = []
    for line in lines:
        content = line.rstrip("\r\n")
        if kind == "search":
            match = HIT.fullmatch(content)
            if not match or not match.group(3):
                return None
            path = match.group(1)
        else:
            path = content
        if not PATH.fullmatch(path) or path.startswith("-"):
            return None
        parsed.append((path, line))
    # Use directory buckets for broad output; preserve the original line order within each bucket.
    for depth in (4, 3, 2, 1, 0):
        groups: OrderedDict[str, list[str]] = OrderedDict()
        for path, line in parsed:
            parts = path.split("/")
            key = "/".join(parts[:depth]) if depth and len(parts) > depth else (path if depth else ".")
            groups.setdefault(key, []).append(line)
        if 2 <= len(groups) <= MAX_GROUPS and len(parsed) / len(groups) >= 25:
            return groups
    return None


def _representatives(lines: list[str]) -> list[str]:
    last = len(lines) - 1
    positions = (0, last // 4, last // 2, (last * 3) // 4, last)
    return list(dict.fromkeys(lines[index] for index in positions))


def _sample(lines: list[str]) -> str:
    return " | ".join(line.strip()[:80] for line in _representatives(lines))[:420]


def _choice_questions(groups: OrderedDict[str, list[str]]) -> dict:
    return {
        f"group_{index}": {
            "type": "choice",
            "instructions": f"For group_{index} in state.groups, how much exact search/listing evidence must remain visible for the current task? If unsure, choose retain. Only choose drop when this group is clearly irrelevant or redundant.",
            "criteria": {
                "retain": "Exact entries may be needed for the current task or next coding step.",
                "summarize": "The group may be useful, but path, count and a few verbatim examples are enough; the full original is recoverable.",
                "drop": "This group is clearly unrelated or redundant for the current task; its path and count can be omitted.",
            },
        } for index, _ in enumerate(groups)
    }


def _decision(answer: dict, config: Config | None = None) -> str:
    config = config or Config()
    options = {"retain", "summarize", "drop"}
    if not isinstance(answer, dict) or answer.get("type") != "choice" or answer.get("choice") not in options:
        raise ValueError("invalid Jev choice")
    choice = answer["choice"]
    probabilities = answer.get("probabilities")
    confidence = answer.get("confidence")
    if (not isinstance(probabilities, dict) or set(probabilities) != options
            or any(type(value) not in (int, float) or not 0 <= value <= 1 for value in probabilities.values())
            or not 0.97 <= sum(probabilities.values()) <= 1.03
            or type(confidence) not in (int, float) or not 0 <= confidence <= 1):
        raise ValueError("invalid Jev probabilities")
    probability = probabilities[choice]
    if probability < max(probabilities.values()) - 0.01:
        raise ValueError("choice disagrees with probabilities")
    if (choice == "drop" and probability >= threshold(config, "search_listing", "drop_probability_min")
            and confidence >= threshold(config, "search_listing", "drop_confidence_min")):
        return "drop"
    if (choice in {"summarize", "drop"} and probability >= threshold(config, "search_listing", "summarize_probability_min")
            and confidence >= threshold(config, "search_listing", "summarize_confidence_min")):
        return "summarize"
    return "retain"


def decide_search_listing(
    event: dict, config: Config,
    evaluator: Callable[[dict, dict, Config], dict] | None = None,
    storage: Path | None = None,
    simulate: bool = False,
) -> Result:
    started = time.perf_counter()

    def result(status: str, reason: str, size: int = 0, **kwargs) -> Result:
        return Result(status, reason, size, elapsed_ms=round((time.perf_counter() - started) * 1000), **kwargs)

    if not config.search_listing_enabled or not isinstance(event, dict) or event.get("hook_event_name") != "PostToolUse" or event.get("tool_name") != "Bash":
        return result("skip", "unsupported_event")
    if not decision_method(config, "search_listing", "choice"):
        return result("skip", "no_decision_methods")
    kind = command_kind(event.get("tool_input"))
    if kind is None:
        return result("skip", "unsupported_command")
    output = event.get("tool_response")
    if not isinstance(output, str):
        return result("skip", "unsupported_result")
    size = len(output)
    if size < MIN_CHARS or size > config.max_chars:
        return result("skip", "size", size)
    if SENSITIVE.search(output) or SENSITIVE.search(event["tool_input"]["command"]):
        return result("skip", "sensitive", size)
    groups = _groups(output, kind)
    if groups is None:
        return result("skip", "unstructured", size)
    hint = _task_hint(event, kind)
    if not hint:
        return result("skip", "missing_task", size)
    state = {"kind": kind, "task": hint, "groups": [
        {"id": f"group_{index}", "path": path[:160], "count": len(lines), "sample": _sample(lines)}
        for index, (path, lines) in enumerate(groups.items())
    ]}
    questions = _choice_questions(groups)
    if (len(json.dumps(state, ensure_ascii=False)) > MAX_STATE_CHARS
            or len(json.dumps({"state": state, "questions": questions}, ensure_ascii=False)) > MAX_REQUEST_CHARS):
        return result("skip", "state_too_large", size)
    if evaluator is None:
        return result("skip", "no_evaluator", size)
    try:
        answers = evaluator(state, questions, config)
        if set(answers) != {f"group_{index}" for index in range(len(groups))}:
            raise ValueError("missing choices")
        decisions = [_decision(answers[f"group_{index}"], config) for index in range(len(groups))]
    except (Exception,):
        return result("keep", "evaluator_unavailable", size)
    if all(choice == "retain" for choice in decisions):
        return result("keep", "jev_keep", size)
    if storage is None and not simulate:
        return result("keep", "storage_unavailable", size)
    try:
        original_path = "[replay: original retained in fixture]" if simulate else str(_output_path(storage, event))
        pieces = [f"[Codex Jev {kind}: {len(output.splitlines())} entries in {len(groups)} groups.]\n"]
        omitted = 0
        for (path, lines), choice in zip(groups.items(), decisions):
            if choice == "retain":
                pieces.extend(lines)
            elif choice == "summarize":
                examples = _representatives(lines)
                pieces.append(f"[{path}: {len(lines)} entries, {len(lines) - len(examples)} omitted]\n")
                pieces.extend(examples)
                omitted += len(lines) - len(examples)
            else:
                omitted += len(lines)
        pieces.append(f"\n[{omitted} entries omitted; full original: {original_path}]\nRead that file if exact lines are needed.\n")
        feedback = "".join(pieces)
        if len(feedback) > MAX_FEEDBACK_CHARS or len(feedback) >= size * 0.7 or size - len(feedback) < 1024:
            return result("keep", "insufficient_reduction", size)
        if config.mode == "observe":
            return result("candidate", "observe", size)
        if not simulate:
            save_original(storage, event, output)
    except (OSError, ValueError):
        return result("keep", "storage_unavailable", size)
    return result("replace", "search_listing_replace", size, capsule_chars=len(feedback), hook_output={
        "continue": False, "stopReason": "Search/listing output stored by Codex Jev", "reason": feedback,
    })
