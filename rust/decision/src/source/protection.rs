//! Diagnostic blocks and immediate diagnostic context.
use crate::SourceLine;
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
