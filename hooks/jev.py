"""Codex Jev's conservative PostToolUse output filter. No third-party dependencies."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time
from typing import Callable
from urllib import request


ENDPOINT = "https://api.typesafe.ai/v1/systemone"
SCORE_NAMES = ("routine_noise", "needs_exact_text", "one_off_value")
FILTER_KEYS = (*SCORE_NAMES, "filter_approved", "filter_confidence")
SENSITIVE = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|"
    r"(?:api[_-]?key|access[_-]?token|client[_-]?secret|authorization|password|passwd|secret|token)\s*[:=]|"
    r"\bBearer\s+[A-Za-z0-9._~-]{12,}|"
    r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opsu]_[A-Za-z0-9_]{20,})\b|"
    r"(?:^|[/\\])\.env(?:\.[\w-]+)?(?:$|\s|[/\\])",
    re.IGNORECASE | re.MULTILINE,
)
FAILURE = re.compile(
    r"\b(?:error|failed|failure|warning|fatal|panic|exception|traceback)\b|"
    r"\b(?:not ok|assertionerror|segmentation fault)\b|^\s*at\s+\S+\s*\(",
    re.IGNORECASE | re.MULTILINE,
)
SAFE_KEY = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
# A serialized byte is a conservative upper bound for a text token. Keep the
# entire request below Jev's 32k state + longest-question limit, with headroom.
MAX_JEV_REQUEST_BYTES = 28_000
CHUNK_JSON_BYTES = 20_000
MAX_CHUNKS = 128
CHUNK_WORKERS = 12
DEFAULT_THRESHOLDS = {
    "output": {"routine_min": 90, "exact_max": 12, "unique_max": 10, "confidence_min": 70},
    "test_build": {"routine_min": 90, "exact_max": 20, "unique_max": 20, "confidence_min": 70},
    "search_listing": {"summarize_probability_min": 78, "summarize_confidence_min": 70,
                       "drop_probability_min": 92, "drop_confidence_min": 85},
}
DEFAULT_DECISION_METHODS = {
    "output": {"noul": True, "choice": True},
    "test_build": {"noul": True, "choice": True},
    "search_listing": {"choice": True},
}
_REQUEST_CAPTURE: ContextVar[dict | None] = ContextVar("jev_request_capture", default=None)


@contextmanager
def capture_request(record: dict):
    """Collect request and answer data without the Authorization header."""
    token = _REQUEST_CAPTURE.set(record)
    try:
        yield
    finally:
        _REQUEST_CAPTURE.reset(token)


def load_api_key(data_dir: Path) -> str:
    """Read the installed plugin's private .env without evaluating shell syntax."""
    path = data_dir / ".env"
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        details = os.fstat(fd)
        if not stat.S_ISREG(details.st_mode):
            raise ValueError("Jev credential is not a regular file")
        if os.name != "nt" and stat.S_IMODE(details.st_mode) & 0o077:
            raise ValueError("Jev credential must be owner-only")
        with os.fdopen(fd, "rb", closefd=False) as file:
            contents = file.read(8193)
        if len(contents) > 8192:
            raise ValueError("Jev credential file is too large")
    finally:
        os.close(fd)
    values = []
    for line in contents.decode("utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, value = line.partition("=")
        if separator and name.strip() == "JEV_API_KEY":
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values.append(value)
    if len(values) != 1 or not 8 <= len(values[0]) <= 4096 or re.search(r"\s|\x00", values[0]):
        raise ValueError("Jev API key is missing or invalid")
    return values[0]


@dataclass(frozen=True)
class Config:
    enabled: bool = False
    test_build_enabled: bool = False
    search_listing_enabled: bool = False
    mode: str = "replace"
    min_chars: int = 8192
    max_chars: int = 2_000_000
    sample_chars: int = 12_000
    timeout_seconds: float = 3.0
    model: str = "jev-1.13.0"
    allow_mcp_replacement: bool = False
    log_limit_mb: int = 50
    never_delete_logs: bool = False
    thresholds: dict[str, dict[str, int]] = field(default_factory=lambda: {
        hook: dict(values) for hook, values in DEFAULT_THRESHOLDS.items()})
    decision_methods: dict[str, dict[str, bool]] = field(default_factory=lambda: {
        hook: dict(values) for hook, values in DEFAULT_DECISION_METHODS.items()})

    @classmethod
    def from_file(cls, path: Path) -> Config:
        if not path.is_file():
            return cls()
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("invalid config fields")
        raw = dict(raw)
        # An installed earlier release can leave this inert key behind.
        if "precompact_enabled" in raw:
            if type(raw.pop("precompact_enabled")) is not bool:
                raise ValueError("invalid legacy config")
        if set(raw) - set(cls.__dataclass_fields__):
            raise ValueError("invalid config fields")
        config = cls(**raw)
        if (
            type(config.enabled) is not bool
            or type(config.test_build_enabled) is not bool
            or type(config.search_listing_enabled) is not bool
            or config.mode not in ("observe", "replace")
            or type(config.min_chars) is not int
            or type(config.max_chars) is not int
            or type(config.sample_chars) is not int
            or not 1024 <= config.min_chars <= config.max_chars <= 2_000_000
            or not 1000 <= config.sample_chars <= 24_000
            or type(config.timeout_seconds) not in (int, float)
            or not 0.1 <= config.timeout_seconds <= 4.0
            or not isinstance(config.model, str)
            or not re.fullmatch(r"jev-[\w.-]{1,40}", config.model)
            or type(config.allow_mcp_replacement) is not bool
            or type(config.log_limit_mb) is not int or not 1 <= config.log_limit_mb <= 9999
            or type(config.never_delete_logs) is not bool
            or not isinstance(config.thresholds, dict)
            or set(config.thresholds) - set(DEFAULT_THRESHOLDS)
            or any(not isinstance(values, dict) or set(values) - set(DEFAULT_THRESHOLDS[hook])
                   or any(type(value) is not int or not 0 <= value <= 100 for value in values.values())
                   for hook, values in config.thresholds.items())
            or not isinstance(config.decision_methods, dict)
            or set(config.decision_methods) - set(DEFAULT_DECISION_METHODS)
            or any(not isinstance(values, dict) or set(values) - set(DEFAULT_DECISION_METHODS[hook])
                   or any(type(value) is not bool for value in values.values())
                   for hook, values in config.decision_methods.items())
        ):
            raise ValueError("invalid config values")
        return config


def threshold(config: Config, hook: str, name: str) -> float:
    return config.thresholds.get(hook, {}).get(name, DEFAULT_THRESHOLDS[hook][name]) / 100


def decision_method(config: Config, hook: str, method: str) -> bool:
    return config.decision_methods.get(hook, {}).get(method, DEFAULT_DECISION_METHODS[hook][method])


@dataclass(frozen=True)
class Result:
    status: str
    reason: str
    original_chars: int = 0
    capsule_chars: int = 0
    elapsed_ms: int = 0
    scores: dict[str, float | bool | None] | None = None
    hook_output: dict | None = None

    def to_log(self, tool_name: str, filter_name: str = "output") -> dict:
        return {
            "tool": tool_name,
            "filter": filter_name,
            "status": self.status,
            "reason": self.reason,
            "original_chars": self.original_chars,
            "capsule_chars": self.capsule_chars,
            "elapsed_ms": self.elapsed_ms,
            "scores": self.scores,
        }


def extract_text(tool_name: str, response: object) -> str | None:
    if tool_name == "Bash":
        return response if isinstance(response, str) else None
    if not tool_name.startswith("mcp__") or not isinstance(response, dict):
        return None
    if response.get("isError") is True or response.get("is_error") is True:
        return None
    if "structuredContent" in response or "structured_content" in response:
        return None
    content = response.get("content")
    if not isinstance(content, list) or not content:
        return None
    texts = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "text" or not isinstance(item.get("text"), str):
            return None
        texts.append(item["text"])
    return "\n".join(texts)


def repetitive_fraction(output: str) -> float:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if len(lines) < 30:
        return 0.0
    # Distinct paths and file:line hits are evidence, not progress counters.
    normalized = {
        line if "/" in line or "\\" in line else re.sub(r"\d+", "#", line)
        for line in lines
    }
    return 1.0 - len(normalized) / len(lines)


def sample(output: str, limit: int) -> str:
    if len(output) <= limit:
        return output
    part = limit // 3
    center = len(output) // 2
    return (
        output[:part]
        + "\n[... middle omitted ...]\n"
        + output[center - part // 2 : center + part // 2]
        + "\n[... tail omitted ...]\n"
        + output[-part:]
    )


def jev_request(state: dict, config: Config, api_key: str) -> dict[str, float | bool | None]:
    questions = {
        "routine_noise": {
            "type": "noul",
            "instructions": "Is `output_sample` mostly repeated routine progress or listing noise, with no unique result or diagnostic in it?",
            "criteria": {
                "true": "Mostly repeated progress or listing text; no detail in this portion is needed.",
                "false": "Contains substantive facts, diagnostic detail, search matches, or data that may matter individually.",
            },
        },
        "needs_exact_text": {
            "type": "noul",
            "instructions": "Would a coding agent likely need exact lines from `output_sample` to decide what to inspect or change next?",
            "criteria": {
                "true": "Exact lines or values are needed for the next step.",
                "false": "The details are routine repetition; a concise excerpt is sufficient.",
            },
        },
        "one_off_value": {
            "type": "noul",
            "instructions": "Does `output_sample` contain a unique, one-time result or value whose exact content could matter later?",
            "criteria": {
                "true": "Contains a one-time code, URL, identifier, result, or other nonrepeatable value.",
                "false": "Contains only repeatable progress or listing text.",
            },
        },
        "filter_decision": {
            "type": "choice",
            "instructions": "Should `output_sample` be shortened for a coding agent?",
            "criteria": {
                "filter": "It is routine repetition; a brief excerpt preserves what matters for the next step.",
                "keep": "The full result may contain a useful exact line, diagnostic, search match, or one-time value.",
            },
        },
    }
    return _request_nouls(state, config, api_key, questions, "output")


def jev_test_build_request(state: dict, config: Config, api_key: str) -> dict[str, float | bool | None]:
    """Ask Jev whether known pass/progress lines are safe to omit for this run."""
    questions = {
        "routine_noise": {
            "type": "noul",
            "instructions": "Are the lines in `omitted_sample` routine passing-test or build-progress entries whose omission leaves the run outcome clear in `retained_sample`?",
            "criteria": {
                "true": "They are routine passes or progress; the retained summary and diagnostics communicate the outcome.",
                "false": "They contain substantive results, diagnostics, or facts needed to understand this run.",
            },
        },
        "needs_exact_text": {
            "type": "noul",
            "instructions": "Would a coding agent likely need the exact omitted test names, progress lines, or values in `omitted_sample` for its next step, given `retained_sample`?",
            "criteria": {
                "true": "The omitted lines identify important cases, files, values, or diagnostics for the next step.",
                "false": "The retained text is enough for the next step; the exact omitted lines are unlikely to matter.",
            },
        },
        "one_off_value": {
            "type": "noul",
            "instructions": "Does `omitted_sample` contain a unique result or nonrepeatable value that should remain visible, beyond ordinary passing-test names or routine build progress?",
            "criteria": {
                "true": "A unique result, identifier, measurement, or diagnostic is present in the omitted lines.",
                "false": "The omitted lines contain only ordinary pass/progress entries; their exact text remains recoverable from the saved original.",
            },
        },
        "filter_decision": {
            "type": "choice",
            "instructions": "Can `omitted_sample` be removed while `retained_sample` still explains this test or build run?",
            "criteria": {
                "filter": "Omitted lines are routine passes or progress; retained text preserves the outcome and diagnostics.",
                "keep": "Omitted lines may contain a useful exact test name, result, value, or diagnostic.",
            },
        },
    }
    return _request_nouls(state, config, api_key, questions, "test_build")


def _request_nouls(state: dict, config: Config, api_key: str, questions: dict, hook: str) -> dict[str, float | bool | None]:
    use_noul = decision_method(config, hook, "noul")
    use_choice = decision_method(config, hook, "choice")
    if not use_noul and not use_choice:
        raise ValueError("No Jev decision method is enabled")
    active_questions = {name: question for name, question in questions.items()
                        if (name == "filter_decision" and use_choice) or (name != "filter_decision" and use_noul)}
    answers = _request_answers(state, config, api_key, active_questions)
    scores = {}
    for name in SCORE_NAMES:
        if not use_noul:
            scores[name] = None
            continue
        answer = answers.get(name)
        value = answer.get("noul") if isinstance(answer, dict) and answer.get("type") == "noul" else None
        if type(value) not in (int, float) or not 0 <= value <= 1:
            raise ValueError("invalid noul answer")
        scores[name] = float(value)
    if use_choice:
        decision = answers.get("filter_decision")
        if not _valid_choice_answer(decision, {"filter", "keep"}):
            raise ValueError("invalid filter decision")
        scores["filter_approved"] = decision["choice"] == "filter"
        scores["filter_confidence"] = float(decision["confidence"])
    else:
        scores["filter_approved"] = None
        scores["filter_confidence"] = None
    return scores


def _valid_choice_answer(answer: object, options: set[str]) -> bool:
    if not isinstance(answer, dict):
        return False
    probabilities = answer.get("probabilities")
    confidence = answer.get("confidence")
    return (answer.get("type") == "choice" and answer.get("choice") in options
            and isinstance(probabilities, dict) and set(probabilities) == options
            and all(type(value) in (int, float) and 0 <= value <= 1 for value in probabilities.values())
            and 0.97 <= sum(probabilities.values()) <= 1.03
            and probabilities[answer["choice"]] >= max(probabilities.values()) - 0.01
            and type(confidence) in (int, float) and 0 <= confidence <= 1)


def jev_choice_request(state: dict, questions: dict, config: Config, api_key: str) -> dict[str, dict]:
    """Evaluate bounded independent Choice questions in one Jev request."""
    answers = _request_answers(state, config, api_key, questions)
    if set(answers) != set(questions):
        raise ValueError("missing choice answers")
    for name, question in questions.items():
        answer = answers[name]
        options = set(question["criteria"])
        if not _valid_choice_answer(answer, options):
            raise ValueError("invalid choice answer")
    return answers


def _request_answers(state: dict, config: Config, api_key: str, questions: dict) -> dict:
    if not api_key:
        raise ValueError("Jev API key is missing")
    message = {"state": state, "model": config.model, "questions": questions}
    payload = json.dumps(message, ensure_ascii=False).encode()
    if len(payload) > MAX_JEV_REQUEST_BYTES:
        raise ValueError("Jev request exceeds safe context budget")
    capture = _REQUEST_CAPTURE.get()
    if capture is not None:
        capture["request"] = message
    req = request.Request(
        ENDPOINT,
        data=payload,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    with request.urlopen(req, timeout=config.timeout_seconds) as response:
        body = json.load(response)
    answers = body.get("answers")
    if not isinstance(answers, dict):
        raise ValueError("missing answers")
    if capture is not None:
        capture["raw_answer"] = answers
    return answers


def candidate(scores: dict[str, float | bool | None], config: Config | None = None) -> bool:
    config = config or Config()
    use_noul = decision_method(config, "output", "noul")
    use_choice = decision_method(config, "output", "choice")
    return ((use_noul or use_choice)
            and (not use_noul or (scores["routine_noise"] >= threshold(config, "output", "routine_min")
                                  and scores["needs_exact_text"] <= threshold(config, "output", "exact_max")
                                  and scores["one_off_value"] <= threshold(config, "output", "unique_max")))
            and (not use_choice or (scores["filter_approved"] is True
                                    and scores["filter_confidence"] >= threshold(config, "output", "confidence_min"))))


def _output_path(storage: Path, event: dict) -> Path:
    session = str(event.get("session_id", ""))
    call = str(event.get("tool_use_id", ""))
    if not SAFE_KEY.fullmatch(session) or not SAFE_KEY.fullmatch(call):
        raise ValueError("invalid session or tool id")
    session_hash = hashlib.sha256(session.encode()).hexdigest()[:20]
    call_hash = hashlib.sha256(call.encode()).hexdigest()[:20]
    return storage / "outputs" / session_hash / f"{call_hash}.txt"


def save_original(storage: Path, event: dict, output: str) -> Path:
    path = _output_path(storage, event)
    if storage.is_symlink() or (storage / "outputs").is_symlink():
        raise ValueError("unsafe storage directory")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if (
        path.parent.is_symlink()
        or not stat.S_ISDIR(path.parent.stat().st_mode)
        or stat.S_IMODE(path.parent.stat().st_mode) & 0o077
    ):
        raise ValueError("unsafe output directory")
    if path.exists() or path.is_symlink():
        raise FileExistsError("output already recorded")
    fd, temporary = tempfile.mkstemp(prefix=".jev-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.write(output)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, 0o600)
        os.link(temporary, path, follow_symlinks=False)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return path


def capsule(output: str, original_path: str) -> str:
    head = output[:350].strip()
    tail = output[-350:].strip()
    return (
        f"{head}\n[... repetitive middle omitted by Codex Jev ...]\n{tail}\n"
        f"Full original: {original_path}\n"
        "Read that file if exact lines are needed."
    )


def _output_chunks(output: str) -> list[str] | None:
    """Cover every character in bounded, JSON-safe pieces; reject excessive fan-out."""
    chunks = []
    start = 0
    while start < len(output):
        low, high = start + 1, min(len(output), start + CHUNK_JSON_BYTES)
        end = low
        while low <= high:
            middle = (low + high) // 2
            size = len(json.dumps(output[start:middle], ensure_ascii=False).encode())
            if size <= CHUNK_JSON_BYTES:
                end = middle
                low = middle + 1
            else:
                high = middle - 1
        if end == start:
            return None
        chunks.append(output[start:end])
        if len(chunks) > MAX_CHUNKS:
            return None
        start = end
    return chunks


def _valid_scores(scores: dict[str, float | bool | None], config: Config | None = None, hook: str = "output") -> bool:
    config = config or Config()
    if not isinstance(scores, dict) or set(scores) != set(FILTER_KEYS):
        return False
    use_noul = decision_method(config, hook, "noul")
    use_choice = decision_method(config, hook, "choice")
    return ((all(type(scores[name]) in (float, int) and 0 <= scores[name] <= 1 for name in SCORE_NAMES)
             if use_noul else all(scores[name] is None for name in SCORE_NAMES))
            and ((type(scores["filter_approved"]) is bool
                  and type(scores["filter_confidence"]) in (float, int)
                  and 0 <= scores["filter_confidence"] <= 1)
                 if use_choice else scores["filter_approved"] is None and scores["filter_confidence"] is None))


def _evaluate_output(state: dict, output: str, config: Config,
                     evaluator: Callable[[dict, Config], dict[str, float | bool | None]]) -> dict[str, float | bool | None] | None:
    # The short path preserves the single-request behavior for ordinary results.
    if len(json.dumps(output, ensure_ascii=False).encode()) <= CHUNK_JSON_BYTES:
        scores = evaluator(state, config)
        if not _valid_scores(scores, config):
            raise ValueError("invalid evaluator scores")
        return scores
    chunks = _output_chunks(output)
    if chunks is None:
        return None
    count = len(chunks)

    def evaluate(item: tuple[int, str]) -> dict[str, float | bool | None]:
        index, chunk = item
        chunk_state = {**state, "output_sample": chunk, "chunk_index": index + 1,
                       "chunk_count": count}
        scores = evaluator(chunk_state, config)
        if not _valid_scores(scores, config):
            raise ValueError("invalid evaluator scores")
        return scores

    with ThreadPoolExecutor(max_workers=CHUNK_WORKERS) as pool:
        scores_by_chunk = list(pool.map(evaluate, enumerate(chunks)))
    return {
        "routine_noise": min(scores["routine_noise"] for scores in scores_by_chunk) if decision_method(config, "output", "noul") else None,
        "needs_exact_text": max(scores["needs_exact_text"] for scores in scores_by_chunk) if decision_method(config, "output", "noul") else None,
        "one_off_value": max(scores["one_off_value"] for scores in scores_by_chunk) if decision_method(config, "output", "noul") else None,
        "filter_approved": all(scores["filter_approved"] for scores in scores_by_chunk) if decision_method(config, "output", "choice") else None,
        "filter_confidence": min(scores["filter_confidence"] for scores in scores_by_chunk) if decision_method(config, "output", "choice") else None,
    }


def decide(
    event: dict,
    config: Config,
    evaluator: Callable[[dict, Config], dict[str, float | bool | None]] | None = None,
    storage: Path | None = None,
    simulate: bool = False,
) -> Result:
    started = time.perf_counter()

    def result(status: str, reason: str, original_chars: int = 0, **kwargs) -> Result:
        return Result(status, reason, original_chars, elapsed_ms=round((time.perf_counter() - started) * 1000), **kwargs)

    if not config.enabled:
        return result("skip", "disabled")
    if not any(config.decision_methods.get("output", {}).get(name, True) for name in ("noul", "choice")):
        return result("skip", "no_decision_methods")
    if not isinstance(event, dict) or event.get("hook_event_name") != "PostToolUse":
        return result("skip", "unsupported_event")
    tool = event.get("tool_name")
    output = extract_text(tool, event.get("tool_response")) if isinstance(tool, str) else None
    if output is None:
        return result("skip", "unsupported_result")
    size = len(output)
    if size < config.min_chars:
        return result("skip", "small", size)
    if size > config.max_chars:
        return result("skip", "oversize", size)
    tool_input = event.get("tool_input")
    try:
        input_text = json.dumps(tool_input, ensure_ascii=False)[:4000]
    except (TypeError, ValueError):
        return result("skip", "unsupported_input", size)
    if SENSITIVE.search(output) or SENSITIVE.search(input_text):
        return result("skip", "sensitive", size)
    if FAILURE.search(output):
        return result("skip", "diagnostic", size)
    if repetitive_fraction(output) < 0.6:
        return result("skip", "not_repetitive", size)
    if evaluator is None:
        return result("skip", "no_evaluator", size)
    state = {
        "tool": tool,
        "input_excerpt": input_text[:400],
        "output_sample": sample(output, config.sample_chars),
        "output_chars": size,
    }
    try:
        scores = _evaluate_output(state, output, config, evaluator)
    except Exception:
        return result("keep", "evaluator_unavailable", size)
    if scores is None:
        return result("skip", "too_many_chunks", size)
    if not candidate(scores, config):
        return result("keep", "jev_keep", size, scores=scores)
    if config.mode == "observe":
        return result("candidate", "observe", size, scores=scores)
    if tool != "Bash" and not config.allow_mcp_replacement:
        return result("candidate", "mcp_observe_only", size, scores=scores)
    if storage is None and not simulate:
        return result("keep", "storage_unavailable", size, scores=scores)
    try:
        original_path = "[replay: original retained in fixture]" if simulate else str(_output_path(storage, event))
        feedback = capsule(output, original_path)
        if len(feedback) >= size // 5:
            return result("keep", "insufficient_reduction", size, scores=scores)
        if not simulate:
            save_original(storage, event, output)
    except (OSError, ValueError):
        return result("keep", "storage_unavailable", size, scores=scores)
    hook_output = {
        "continue": False,
        "stopReason": "Repetitive tool output stored by Codex Jev",
        "reason": feedback,
    }
    return result("replace", "jev_replace", size, capsule_chars=len(feedback), scores=scores, hook_output=hook_output)


def append_log(storage: Path, result: Result, tool_name: str, filter_name: str = "output",
               event: dict | None = None, config: Config | None = None) -> None:
    from receipts import append_event
    settings = config or Config()
    append_event(storage, event or {}, result.to_log(tool_name, filter_name),
                 settings.log_limit_mb, settings.never_delete_logs)
