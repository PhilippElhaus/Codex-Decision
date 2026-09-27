"""Bounded, verbatim evidence selection for shortened tool results."""

from __future__ import annotations

from collections import Counter
from heapq import nlargest
import re


WORDS = re.compile(r"[A-Za-z][A-Za-z0-9_]{2,}")
NUMBERS = re.compile(r"\d+(?:\.\d+)?")
PROGRESS = re.compile(
    r"^\s*(?:Compiling|Building|Checking|Generating|Processing|Downloading|"
    r"Installing|Testing|Running|Progress|Step|\[\d+/\d+\])\b", re.IGNORECASE)
SIGNAL = re.compile(
    r"\b(?:result|summary|total|completed|success|skipped|duration|exit code|"
    r"receipt|revision|commit|version|changed|saved)\b", re.IGNORECASE)
LOCATION = re.compile(r"(?:^|\s)[^\s:]+\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?(?:\s|:|$)")
STOP = {"and", "the", "for", "with", "from", "this", "that", "into", "show", "find", "file", "files"}


def template(line: str) -> str:
    """Normalize counters only in known progress formats; keep other values exact."""
    clean = line.strip()
    return NUMBERS.sub("#", clean) if PROGRESS.match(clean) else clean


def task_terms(task: str) -> set[str]:
    return {word.lower() for word in WORDS.findall(task) if word.lower() not in STOP}


def select_lines(lines: list[str], task: str = "", limit: int = 5,
                 templates: list[str] | None = None) -> list[int]:
    """Choose distinct, task-relevant lines while retaining boundaries."""
    if not lines or limit <= 0:
        return []
    if len(lines) <= limit:
        return list(range(len(lines)))
    templates = templates if templates is not None else [template(line) for line in lines]
    counts = Counter(templates)
    terms = task_terms(task)
    selected = {0, len(lines) - 1}
    candidates = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        progress = bool(PROGRESS.match(stripped))
        if progress:
            score = 0
        else:
            words = {word.lower() for word in WORDS.findall(stripped)} if terms else set()
            score = 8 * len(terms & words)
            score += 6 if SIGNAL.search(stripped) else 0
            score += 5 if LOCATION.search(stripped) else 0
            score += 3 if counts[templates[index]] == 1 else 0
        # Earlier matches break ties, but the boundaries already remain visible.
        candidates.append((score, -index, index))
    seen_templates = {templates[index] for index in selected}
    for _, _, index in nlargest(min(len(candidates), limit * 5), candidates):
        if len(selected) >= limit:
            break
        key = templates[index]
        if key in seen_templates and counts[key] > 1:
            continue
        selected.add(index)
        seen_templates.add(key)
    if len(selected) < limit:
        for index in (len(lines) // 2, len(lines) // 4, 3 * len(lines) // 4):
            selected.add(index)
            if len(selected) >= limit:
                break
    return sorted(selected)


def omission_ranges(selected: list[int], total: int) -> list[tuple[int, int]]:
    omitted = []
    previous = -1
    for index in [*selected, total]:
        if index > previous + 1:
            omitted.append((previous + 2, index))  # one-based, inclusive
        previous = index
    return omitted
