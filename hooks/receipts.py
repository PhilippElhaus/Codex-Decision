"""Private, session-scoped Jev receipts and bounded activity logs."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile
import uuid

try:
    import fcntl
except ImportError:  # Windows hook process
    fcntl = None
    import msvcrt

DEFAULT_LOG_LIMIT_MB = 50
MAX_LOG_LIMIT_MB = 9999
INDEX_LIMIT_BYTES = 1_048_576
RECEIPT_FILTERS = ("output", "test_build", "search_listing")
RECEIPT_NAME = re.compile(r"\d{2}-\d{2}-\d{2}-(\d{3,})-(?:output|test_build|search_listing)\.json")
PANEL_CHOICES = {"filter_decision": ("filter", "keep")}
PANEL_CHECKS = ("routine_noise", "needs_exact_text", "one_off_value")
PANEL_HISTORY_LIMIT = 5
PANEL_THEMES = {"output_filter", "output_keep", "output_noul", "output_evaluated",
                "build_filter", "build_keep", "build_noul", "build_evaluated",
                "search_retain", "search_summarize", "search_drop", "search_mixed",
                "search_evaluated"}


def _panel_probability(value: object) -> float | None:
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
        return None
    return float(value)


def _panel_theme(call: dict, filter_name: str) -> str:
    raw = call.get("raw_answer")
    raw = raw if isinstance(raw, dict) else {}
    if filter_name == "search_listing":
        selected = {answer.get("choice") for name, answer in raw.items()
                    if re.fullmatch(r"group_\d+", name) and isinstance(answer, dict)
                    and answer.get("type") == "choice"
                    and answer.get("choice") in ("retain", "summarize", "drop")}
        if len(selected) == 1:
            return f"search_{next(iter(selected))}"
        return "search_mixed" if selected else "search_evaluated"
    prefix = "build" if filter_name == "test_build" else "output"
    answer = raw.get("filter_decision")
    if isinstance(answer, dict) and answer.get("type") == "choice" and answer.get("choice") in ("filter", "keep"):
        return f"{prefix}_{answer['choice']}"
    if any(isinstance(raw.get(name), dict) and raw[name].get("type") == "noul" for name in PANEL_CHECKS):
        return f"{prefix}_noul"
    return f"{prefix}_evaluated"


def _panel_history(path: Path) -> list[dict]:
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
    except OSError:
        return []
    try:
        details = os.fstat(fd)
        if not stat.S_ISREG(details.st_mode) or details.st_size > 16_384:
            return []
        with os.fdopen(fd, "rb", closefd=False) as file:
            previous = json.loads(file.read(16_385))
    except (ValueError, UnicodeError):
        return []
    finally:
        os.close(fd)
    rows = previous.get("recent") if isinstance(previous, dict) else None
    if not isinstance(rows, list):
        return []
    return [row for row in rows[-PANEL_HISTORY_LIMIT:]
            if isinstance(row, dict) and isinstance(row.get("id"), str)
            and re.fullmatch(r"[a-f0-9]{32}", row["id"])
            and row.get("theme") in PANEL_THEMES
            and type(row.get("elapsed_ms")) in (int, float)
            and math.isfinite(row["elapsed_ms"]) and 0 <= row["elapsed_ms"] <= 3_600_000]


def _panel_decision(call: dict, result, filter_name: str, at: str, count: int) -> dict:
    """Keep bounded Jev labels and probabilities for the latest request."""
    raw = call.get("raw_answer")
    raw = raw if isinstance(raw, dict) else {}
    choices = []
    allowed = {**PANEL_CHOICES, **{f"group_{index}": ("retain", "summarize", "drop")
                                         for index in range(12)}}
    for name, options in allowed.items():
        answer = raw.get(name)
        if not isinstance(answer, dict) or answer.get("type") != "choice":
            continue
        values = answer.get("probabilities")
        if (answer.get("choice") not in options or not isinstance(values, dict)
                or set(values) != set(options)):
            continue
        probabilities = {option: _panel_probability(values[option]) for option in options}
        if any(value is None for value in probabilities.values()) or not 0.97 <= sum(probabilities.values()) <= 1.03:
            continue
        choices.append({"name": name, "selected": answer["choice"], "probabilities": probabilities})
    checks = []
    scores = result.scores if isinstance(result.scores, dict) else {}
    for name in PANEL_CHECKS:
        answer = raw.get(name)
        value = answer.get("noul") if isinstance(answer, dict) and answer.get("type") == "noul" else scores.get(name)
        probability = _panel_probability(value)
        if probability is not None:
            checks.append({"name": name, "probability": probability})
    return {"version": 1, "id": uuid.uuid4().hex, "at": at, "filter": filter_name,
            "status": result.status, "call_index": count, "call_count": count,
            "choices": choices, "checks": checks}


def _private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    details = path.lstat()
    if not stat.S_ISDIR(details.st_mode) or (os.name != "nt" and stat.S_IMODE(details.st_mode) & 0o077):
        raise ValueError("unsafe Jev log directory")


@contextmanager
def _locked(storage: Path):
    if storage.is_symlink():
        raise ValueError("unsafe Jev data directory")
    _private_directory(storage)
    root = storage / "logs"
    _private_directory(root)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(root / ".lock", flags, 0o600)
    try:
        if fcntl:
            fcntl.flock(fd, fcntl.LOCK_EX)
        else:
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        yield root
    finally:
        if fcntl:
            fcntl.flock(fd, fcntl.LOCK_UN)
        else:
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        os.close(fd)


def _session_path(root: Path, event: dict, clock: datetime | None = None) -> Path:
    session = event.get("session_id") if isinstance(event, dict) else None
    if not isinstance(session, str) or not session or len(session) > 256:
        session = str(event.get("tool_use_id", uuid.uuid4().hex)) if isinstance(event, dict) else uuid.uuid4().hex
    abbreviation = hashlib.sha256(session.encode()).hexdigest()[:10]
    date = (clock or datetime.now(timezone.utc)).strftime("%Y-%m-%d")
    path = root / f"{date}-{abbreviation}"
    _private_directory(path)
    return path


def _append(path: Path, row: dict) -> None:
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as file:
        file.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def _replace_private(path: Path, contents: bytes) -> None:
    fd, temporary = tempfile.mkstemp(prefix=".jev-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(contents)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _create_private(path: Path, contents: bytes) -> None:
    fd, temporary = tempfile.mkstemp(prefix=".jev-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(contents)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, 0o600)
        os.link(temporary, path, follow_symlinks=False)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _shrink_index(root: Path) -> None:
    index = root / "events.jsonl"
    details = index.lstat()
    if not stat.S_ISREG(details.st_mode) or details.st_size <= INDEX_LIMIT_BYTES:
        return
    with index.open("rb") as file:
        file.seek(-INDEX_LIMIT_BYTES, os.SEEK_END)
        tail = file.read()
    cut = tail.find(b"\n")
    _replace_private(index, tail[cut + 1:] if cut >= 0 else b"")


def _managed_files(root: Path):
    index = root / "events.jsonl"
    if index.exists() and not index.is_symlink() and index.is_file():
        yield index
    for session in root.iterdir():
        if session.is_symlink() or not session.is_dir() or not re.fullmatch(r"\d{4}-\d{2}-\d{2}-[0-9a-f]{10}", session.name):
            continue
        for child in session.iterdir():
            if child.is_symlink() or not child.is_file():
                continue
            if (child.name == "events.jsonl" or RECEIPT_NAME.fullmatch(child.name)
                    or (child.name.startswith("receipt-") and child.suffix == ".json")):
                yield child


def _next_receipt_sequence(session: Path, time: str) -> int:
    prefix = f"{time}-"
    return 1 + max((int(match.group(1)) for child in session.iterdir()
                    if child.name.startswith(prefix)
                    if (match := RECEIPT_NAME.fullmatch(child.name))), default=0)


def _prune(root: Path, limit_mb: int, never_delete: bool) -> None:
    if never_delete:
        return
    budget = limit_mb * 1_000_000
    files = [(path.stat().st_mtime_ns, path.name, path, path.stat().st_size) for path in _managed_files(root)]
    total = sum(size for _, _, _, size in files)
    for _, _, path, size in sorted(files):
        if total <= budget:
            break
        path.unlink()
        total -= size
        if path.parent != root and not any(path.parent.iterdir()):
            path.parent.rmdir()


def _count(stats: dict, row: dict) -> None:
    status = row.get("status")
    if status == "calling":
        stats["calls"] += 1
    if status not in {"candidate", "keep", "replace"}:
        return
    stats["completed"] += 1
    if status == "replace":
        stats["replaced"] += 1
        original, capsule = row.get("original_chars"), row.get("capsule_chars")
        if (type(original) is int and type(capsule) is int and
                0 <= capsule <= original):
            stats["savedChars"] += original - capsule
    elapsed = row.get("elapsed_ms")
    if type(elapsed) in (int, float) and elapsed > 0:
        stats["timed"] += 1
        stats["elapsedMs"] += round(elapsed)


def _update_stats(storage: Path, row: dict) -> None:
    path = storage / "stats.json"
    if path.is_symlink():
        raise ValueError("unsafe Jev stats file")
    if path.exists():
        stats = json.loads(path.read_text(encoding="utf-8"))
    else:
        stats = {key: 0 for key in ("calls", "completed", "replaced", "savedChars", "timed", "elapsedMs")}
        legacy = storage / "events.jsonl"
        if legacy.is_file() and not legacy.is_symlink():
            with legacy.open(encoding="utf-8") as file:
                for line in file:
                    if len(line) > 8192:
                        continue
                    try:
                        old = json.loads(line)
                        if isinstance(old, dict):
                            _count(stats, old)
                    except (ValueError, TypeError):
                        continue
    _count(stats, row)
    _replace_private(path, (json.dumps(stats, separators=(",", ":")) + "\n").encode())


def append_event(storage: Path, event: dict, row: dict, limit_mb: int = DEFAULT_LOG_LIMIT_MB,
                 never_delete: bool = False) -> None:
    with _locked(storage) as root:
        session = _session_path(root, event)
        _append(session / "events.jsonl", row)
        _append(root / "events.jsonl", row)
        if not never_delete:
            _shrink_index(root)
        _update_stats(storage, row)
        _prune(root, limit_mb, never_delete)


def write_receipts(storage: Path, event: dict, result, calls: list[dict], filter_name: str,
                   limit_mb: int = DEFAULT_LOG_LIMIT_MB, never_delete: bool = False,
                   settings: dict | None = None, original_output: str | None = None) -> None:
    if not calls:
        return
    if filter_name not in RECEIPT_FILTERS:
        raise ValueError("unsupported Jev receipt filter")
    original = original_output if isinstance(original_output, str) else event.get("tool_response")
    if not isinstance(original, str):
        raise ValueError("unsupported Jev receipt output")
    visible = result.hook_output["reason"] if result.hook_output else original
    with _locked(storage) as root:
        clock = datetime.now(timezone.utc)
        now = clock.isoformat(timespec="microseconds")
        session = _session_path(root, event, clock)
        time = clock.strftime("%H-%M-%S")
        sequence = _next_receipt_sequence(session, time)
        for index, call in enumerate(calls, 1):
            receipt = {
                "version": 1, "at": now, "session_id": event.get("session_id"),
                "tool_use_id": event.get("tool_use_id"), "tool": event.get("tool_name"),
                "filter": filter_name, "call_index": index, "call_count": len(calls),
                "settings": settings,
                "tool_input": {"command": event.get("tool_input", {}).get("command")}
                if isinstance(event.get("tool_input"), dict) and isinstance(event["tool_input"].get("command"), str)
                else None, "initial_output": original,
                "visible_output": visible, "decision": result.to_log(str(event.get("tool_name", "")), filter_name),
                "jev_request": call.get("request", {"state": call.get("state")}),
                "jev_answer": call.get("answer"), "jev_raw_answer": call.get("raw_answer"),
                "jev_error": call.get("error"),
            }
            name = f"{time}-{sequence:03d}-{filter_name}.json"
            path = session / name
            _create_private(path, (json.dumps(receipt, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
            sequence += 1
        history = _panel_history(root / "latest-decision.json")
        for call in calls:
            elapsed = call.get("elapsed_ms")
            if type(elapsed) not in (int, float) or not math.isfinite(elapsed) or elapsed < 0:
                elapsed = result.elapsed_ms if len(calls) == 1 else 0
            history.append({"id": uuid.uuid4().hex, "theme": _panel_theme(call, filter_name),
                            "elapsed_ms": min(3_600_000, round(elapsed))})
        snapshot = _panel_decision(calls[-1], result, filter_name, now, len(calls))
        snapshot["id"] = history[-1]["id"]
        snapshot["recent"] = history[-PANEL_HISTORY_LIMIT:]
        _replace_private(root / "latest-decision.json", (json.dumps(snapshot, separators=(",", ":")) + "\n").encode("utf-8"))
        _prune(root, limit_mb, never_delete)
