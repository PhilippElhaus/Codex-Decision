//! Frozen source and representative oracle from commit 4b24210.
use codex_decision::{Action, LineDecision, SourceLine};
use std::collections::{HashMap, HashSet};
pub fn source_lines(source: &str) -> Vec<SourceLine> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, byte) in source.bytes().enumerate() {
        if byte == b'\n' {
            lines.push(source_line(source, lines.len() + 1, start, index + 1));
            start = index + 1;
        }
    }
    if start < source.len() {
        lines.push(source_line(source, lines.len() + 1, start, source.len()));
    }
    lines
}

fn source_line(source: &str, number: usize, start: usize, end: usize) -> SourceLine {
    let original = &source[start..end];
    let text = original.trim_end_matches(['\r', '\n']);
    let clean = strip_ansi(text);
    let lower = clean.to_ascii_lowercase();
    let reason = if clean.trim().is_empty() {
        Some("blank".into())
    } else if clean.len() > 4096 {
        Some("long_line".into())
    } else if lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|word| word == "warn")
        || [
            "error",
            "failed",
            "failure",
            "warning",
            "fatal",
            "panic",
            "exception",
            "traceback",
            "assertion",
            "not ok",
            "segmentation fault",
            "^c",
            "build successful",
            "test result:",
            "ran ",
        ]
        .iter()
        .any(|word| lower.contains(word))
    {
        Some("diagnostic_or_completion".into())
    } else {
        None
    };
    SourceLine {
        number,
        byte_start: start,
        byte_end: end,
        model_text: clean,
        protected_reason: reason,
        eligible: true,
    }
}

pub fn strip_ansi(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut clean = String::with_capacity(text.len());
    let mut from = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b && index + 1 < bytes.len() && bytes[index + 1] == b'[' {
            clean.push_str(&text[from..index]);
            let escape_start = index;
            index += 2;
            while index < bytes.len() && (bytes[index].is_ascii_digit() || bytes[index] == b';') {
                index += 1;
            }
            if index < bytes.len() && bytes[index].is_ascii_alphabetic() {
                index += 1;
                from = index;
                continue;
            }
            // Keep an unsupported sequence verbatim without appending its
            // already-copied prefix a second time.
            from = escape_start;
            break;
        }
        index += 1;
    }
    clean.push_str(&text[from..]);
    clean
}

pub fn protect_neighbors(lines: &mut [SourceLine]) {
    let mut block = 0usize;
    let mut diagnostic_block = false;
    for line in lines.iter_mut() {
        let lower = line.model_text.to_ascii_lowercase();
        let indented = line.model_text.starts_with(char::is_whitespace);
        if lower.contains("traceback")
            || lower.contains("assertionerror")
            || lower.contains("panic!")
            || lower.contains("panicked at")
            || lower.starts_with("panic:")
            || lower.contains("stack backtrace:")
            || lower.contains("error:")
            || lower.contains("failed:")
        {
            block = 24;
            diagnostic_block = true;
        } else if line.model_text.trim().is_empty()
            || lower.starts_with("test ") && lower.contains(" ... ok")
        {
            block = 0;
            diagnostic_block = false;
        } else if block == 0 && !indented {
            diagnostic_block = false;
        }
        // Long backtraces have no fixed frame count. Keep their indented
        // continuation after the short context allowance is exhausted.
        if block > 0 || diagnostic_block && indented {
            if line.protected_reason.is_none() {
                line.protected_reason = Some("diagnostic_block".into());
            }
            block = block.saturating_sub(1);
        }
    }
    let critical: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.protected_reason.as_deref() == Some("diagnostic_or_completion"))
        .map(|(index, _)| index)
        .collect();
    for index in critical {
        for neighbor in index.saturating_sub(1)..=(index + 1).min(lines.len() - 1) {
            if lines[neighbor].protected_reason.is_none() {
                lines[neighbor].protected_reason = Some("diagnostic_context".into());
            }
        }
    }
}

pub fn preserve_representatives(lines: &[SourceLine], decisions: &mut [LineDecision]) {
    // Retain one representative of a repeated line when none is already kept.
    let mut counts = HashMap::new();
    for line in lines {
        *counts.entry(line.model_text.as_str()).or_insert(0usize) += 1;
    }
    let mut seen: HashSet<&str> = lines
        .iter()
        .zip(decisions.iter())
        .filter(|(_, decision)| decision.action != Action::Omit)
        .map(|(line, _)| line.model_text.as_str())
        .collect();
    for (line, decision) in lines.iter().zip(decisions.iter_mut()) {
        if decision.action == Action::Omit
            && counts[&line.model_text.as_str()] > 1
            && seen.insert(line.model_text.as_str())
        {
            decision.action = Action::Keep;
            decision.reason = "representative".into();
            decision.protected_reason = Some("representative".into());
        }
    }
    if let Some(last) = decisions.last_mut() {
        if last.action == Action::Omit {
            last.action = Action::Keep;
            last.reason = "last_line".into();
            last.protected_reason = Some("last_line".into());
        }
    }
}
