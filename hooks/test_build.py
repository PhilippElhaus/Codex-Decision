"""Conservative, Jev-gated reduction of recognized test and build logs."""

from __future__ import annotations

from pathlib import Path
import re
import shlex
import time
from typing import Callable

from jev import Config, FAILURE, Result, SENSITIVE, _output_path, _valid_scores, sample, save_original, threshold


MIN_CHARS = 2048
MIN_ROUTINE_LINES = 8
MAX_FEEDBACK_CHARS = 8000
SHELL_OPERATORS = re.compile(r"[;&|<>`\r\n]|\$\(")
ANSI = re.compile(r"\x1b\[[0-9;]*m")
PASS_LINES = (
    re.compile(r"^test_[\w.-]+(?: \([^)]+\))? \.\.\. ok$"),  # unittest
    re.compile(r"^test \S+ \.\.\. ok$"),  # cargo test
    re.compile(r"^(?:✔|✓) .+$"),  # node --test
    re.compile(r"^ok \d+ - .+$"),  # TAP
    re.compile(r"^\S+::\S+ PASSED(?:\s+\[\s*\d+%\])?$"),  # pytest -v
    re.compile(r"^--- PASS: \S+ \([0-9.]+s\)$"),  # go test -v
)
BUILD_PROGRESS = (
    re.compile(r"^(?:Compiling|Building|Checking|Generating) .+$"),
    re.compile(r"^\[\d+/\d+\] (?:Building|Compiling|Linking|Generating) .+$"),
    re.compile(r"^> Task :[\w:.-]+$"),
)
COMPLETION = (
    re.compile(r"^Ran \d+ tests? in .+$"),
    re.compile(r"^(?:OK|FAILED)(?:\s|$)"),
    re.compile(r"^[#ℹ] (?:tests|pass|fail|duration_ms)\b"),
    re.compile(r"^=+ .*\b(?:passed|failed|error|errors)\b.* =+$", re.IGNORECASE),
    re.compile(r"^test result: (?:ok|FAILED)\b"),
    re.compile(r"^PASS$"),
    re.compile(r"^ok\s+\S+\s+[0-9.]+s$"),
    re.compile(r"^(?:Test Suites|Tests): .+\bpassed\b.*$"),
    re.compile(r"^Finished (?:dev|release|test) profile\b"),
    re.compile(r"^BUILD (?:SUCCESSFUL|FAILED)\b"),
    re.compile(r"^webpack .*compiled (?:successfully|with errors)\b"),
    re.compile(r"^[✓✔] built in .+$"),
)


def command_kind(tool_input: object) -> str | None:
    if not isinstance(tool_input, dict):
        return None
    command = tool_input.get("command")
    if not isinstance(command, str) or not command or len(command) > 4096 or SHELL_OPERATORS.search(command):
        return None
    try:
        words = shlex.split(command)
    except ValueError:
        return None
    if not words:
        return None
    executable = Path(words[0]).name.lower()
    args = words[1:]
    if executable in {"pytest", "py.test"} or (
        re.fullmatch(r"python(?:\d+(?:\.\d+)?)?", executable)
        and len(args) >= 2 and args[0] == "-m" and args[1] in {"pytest", "unittest"}
    ):
        return "test"
    if executable == "node" and args[:1] == ["--test"]:
        return "test"
    if executable in {"npm", "pnpm", "yarn"}:
        index = 0
        while index < len(args):
            if args[index] in {"--prefix", "--dir", "--cwd", "--workspace", "-C", "-w"}:
                index += 2
            elif args[index].startswith("-"):
                index += 1
            else:
                break
        action = args[index:] if index < len(args) else []
        if action[:1] == ["run"]:
            action = action[1:]
        return action[0] if action and action[0] in {"test", "build"} else None
    if executable in {"cargo", "go", "dotnet", "gradle", "gradlew", "mvn", "mvnw", "make"}:
        action = args[0] if args else ""
        if action == "test":
            return "test"
        if action in {"build", "package"}:
            return "build"
    if executable == "cmake" and args[:1] == ["--build"]:
        return "build"
    return None


def _clean(line: str) -> str:
    return ANSI.sub("", line).strip()


def _routine(line: str, kind: str) -> bool:
    cleaned = _clean(line)
    if FAILURE.search(cleaned):
        return False
    patterns = PASS_LINES if kind == "test" else BUILD_PROGRESS
    return any(pattern.fullmatch(cleaned) for pattern in patterns)


def _has_completion(lines: list[str]) -> bool:
    return any(pattern.search(_clean(line)) for line in lines for pattern in COMPLETION)


def jev_approves_omission(scores: dict[str, float | bool], config: Config | None = None) -> bool:
    # Candidate lines have already matched pass/progress formats; Jev judges
    # whether this run gives those otherwise routine lines special value.
    config = config or Config()
    return (scores["routine_noise"] >= threshold(config, "test_build", "routine_min")
            and scores["needs_exact_text"] <= threshold(config, "test_build", "exact_max")
            and scores["one_off_value"] <= threshold(config, "test_build", "unique_max")
            and scores["filter_approved"] is True
            and scores["filter_confidence"] >= threshold(config, "test_build", "confidence_min"))


def decide_test_build(
    event: dict, config: Config,
    evaluator: Callable[[dict, Config], dict[str, float | bool]] | None = None,
    storage: Path | None = None, simulate: bool = False,
) -> Result:
    started = time.perf_counter()

    def result(status: str, reason: str, size: int = 0, **kwargs) -> Result:
        return Result(status, reason, size, elapsed_ms=round((time.perf_counter() - started) * 1000), **kwargs)

    if not config.test_build_enabled:
        return result("skip", "disabled")
    if not isinstance(event, dict) or event.get("hook_event_name") != "PostToolUse" or event.get("tool_name") != "Bash":
        return result("skip", "unsupported_event")
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
    lines = output.splitlines(keepends=True)
    if not _has_completion(lines):
        return result("skip", "no_completion", size)
    omitted = [line for line in lines if _routine(line, kind)]
    routine_count = len(omitted)
    if routine_count < MIN_ROUTINE_LINES:
        return result("skip", "few_routine_lines", size)
    retained = "".join(line for line in lines if not _routine(line, kind)).rstrip("\r\n")
    try:
        original_path = "[replay: original retained in fixture]" if simulate else (
            str(_output_path(storage, event)) if storage is not None else ""
        )
    except ValueError:
        return result("keep", "storage_unavailable", size)
    if not original_path:
        return result("keep", "storage_unavailable", size)
    feedback = (
        f"[Codex Jev {kind} log: {routine_count} routine lines omitted.]\n"
        f"{retained}\n"
        f"Full original: {original_path}\n"
        "Read that file if exact lines are needed."
    )
    if len(feedback) > MAX_FEEDBACK_CHARS or len(feedback) >= size * 0.7 or size - len(feedback) < 1024:
        return result("keep", "insufficient_reduction", size)
    if evaluator is None:
        return result("skip", "no_evaluator", size)
    state = {
        "kind": kind,
        "command": event["tool_input"]["command"][:400],
        "omitted_count": routine_count,
        "omitted_sample": sample("".join(omitted), min(config.sample_chars, 6000)),
        "retained_sample": sample(retained, min(config.sample_chars, 4000)),
        "original_chars": size,
        "visible_chars": len(feedback),
    }
    try:
        scores = evaluator(state, config)
        if not _valid_scores(scores):
            raise ValueError("invalid Jev scores")
    except Exception:
        return result("keep", "evaluator_unavailable", size)
    if not jev_approves_omission(scores, config):
        return result("keep", "jev_keep", size, scores=scores)
    if config.mode == "observe":
        return result("candidate", "observe", size, scores=scores)
    try:
        if not simulate:
            save_original(storage, event, output)
    except (OSError, ValueError):
        return result("keep", "storage_unavailable", size, scores=scores)
    return result(
        "replace", "test_build_replace", size, capsule_chars=len(feedback), scores=scores,
        hook_output={
            "continue": False,
            "stopReason": "Test/build output stored by Codex Jev",
            "reason": feedback,
        },
    )
