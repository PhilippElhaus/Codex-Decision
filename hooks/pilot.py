"""Conservative, opt-in PostToolUse output experiment. No third-party dependencies."""

from __future__ import annotations

from dataclasses import dataclass
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time
from typing import Callable
from urllib import request


ENDPOINT = "https://api.typesafe.ai/v1/systemone"
SCORE_NAMES = ("routine_noise", "needs_exact_text", "one_off_value")
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


@dataclass(frozen=True)
class Config:
    enabled: bool = False
    mode: str = "observe"
    min_chars: int = 8192
    max_chars: int = 2_000_000
    sample_chars: int = 12_000
    timeout_seconds: float = 3.0
    model: str = "jev-1.13.0"
    allow_mcp_replacement: bool = False

    @classmethod
    def from_file(cls, path: Path) -> Config:
        if not path.is_file():
            return cls()
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or set(raw) - set(cls.__dataclass_fields__):
            raise ValueError("invalid config fields")
        config = cls(**raw)
        if (
            type(config.enabled) is not bool
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
        ):
            raise ValueError("invalid config values")
        return config


@dataclass(frozen=True)
class Result:
    status: str
    reason: str
    original_chars: int = 0
    capsule_chars: int = 0
    elapsed_ms: int = 0
    scores: dict[str, float] | None = None
    hook_output: dict | None = None

    def to_log(self, tool_name: str) -> dict:
        return {
            "tool": tool_name,
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


def jev_request(state: dict, config: Config, api_key: str) -> dict[str, float]:
    questions = {
        "routine_noise": {
            "type": "noul",
            "instructions": "Is `output_sample` mostly repeated routine progress or listing noise, while the essential outcome remains clear from its beginning and end?",
            "criteria": {
                "true": "Mostly repeated progress; a short beginning/end excerpt conveys the outcome.",
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
    }
    payload = json.dumps({"state": state, "model": config.model, "questions": questions}).encode()
    if api_key:
        req = request.Request(
            ENDPOINT,
            data=payload,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(req, timeout=config.timeout_seconds) as response:
            body = json.load(response)
    else:
        body = _bridge_request(payload, config.timeout_seconds)
    answers = body.get("answers")
    if not isinstance(answers, dict):
        raise ValueError("missing answers")
    scores = {}
    for name in SCORE_NAMES:
        answer = answers.get(name)
        value = answer.get("noul") if isinstance(answer, dict) and answer.get("type") == "noul" else None
        if type(value) not in (int, float) or not 0 <= value <= 1:
            raise ValueError("invalid noul answer")
        scores[name] = float(value)
    return scores


def _bridge_request(payload: bytes, timeout_seconds: float) -> dict:
    command = [
        "pwsh.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-Command",
        r"& (Join-Path $env:LOCALAPPDATA 'Codex\jev-output-pilot\invoke_jev.ps1')",
    ]
    completed = subprocess.run(
        command,
        input=base64.b64encode(payload) + b"\n",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=min(timeout_seconds + 1, 4.5),
        check=False,
    )
    if completed.returncode != 0 or len(completed.stdout) > 262_144:
        raise RuntimeError("Jev bridge unavailable")
    body = json.loads(completed.stdout.decode("utf-8-sig"))
    if not isinstance(body, dict):
        raise ValueError("Jev bridge returned invalid JSON")
    return body


def candidate(scores: dict[str, float]) -> bool:
    return (
        scores["routine_noise"] >= 0.90
        and scores["needs_exact_text"] <= 0.12
        and scores["one_off_value"] <= 0.10
    )


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
    fd, temporary = tempfile.mkstemp(prefix=".pilot-", dir=path.parent)
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
        f"{head}\n[... repetitive middle omitted by Jev Output Pilot ...]\n{tail}\n"
        f"Full original: {original_path}\n"
        "Read that file if exact lines are needed."
    )


def decide(
    event: dict,
    config: Config,
    evaluator: Callable[[dict, Config], dict[str, float]] | None = None,
    storage: Path | None = None,
    simulate: bool = False,
) -> Result:
    started = time.perf_counter()

    def result(status: str, reason: str, original_chars: int = 0, **kwargs) -> Result:
        return Result(status, reason, original_chars, elapsed_ms=round((time.perf_counter() - started) * 1000), **kwargs)

    if not config.enabled:
        return result("skip", "disabled")
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
        scores = evaluator(state, config)
        if set(scores) != set(SCORE_NAMES) or any(type(v) not in (float, int) or not 0 <= v <= 1 for v in scores.values()):
            raise ValueError("invalid evaluator scores")
    except Exception:
        return result("keep", "evaluator_unavailable", size)
    if not candidate(scores):
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
        "stopReason": "Repetitive tool output stored by Jev Output Pilot",
        "reason": feedback,
    }
    return result("replace", "jev_replace", size, capsule_chars=len(feedback), scores=scores, hook_output=hook_output)


def append_log(storage: Path, result: Result, tool_name: str) -> None:
    storage.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = storage / "events.jsonl"
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as file:
        file.write(json.dumps(result.to_log(tool_name), separators=(",", ":")) + "\n")
