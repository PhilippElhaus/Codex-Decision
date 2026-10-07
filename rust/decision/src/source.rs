//! Source spans and plain model text; original bytes remain untouched.
use crate::SourceLine;
mod protection;
pub use protection::protect_neighbors;
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
