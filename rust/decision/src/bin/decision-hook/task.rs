//! Bounded access to the latest user task, including long turns.
use super::*;

const MAX_TASK_TEXT_BYTES: usize = 65_536;
// A screenshot can make a small user task a large serialized record. Bound
// the record separately; only input_text parts can become provider context.
const MAX_TASK_RECORD_BYTES: usize = 16_000_000;

pub(super) fn task_context(event: &Value) -> Result<Option<String>, ()> {
    let Some(path) = event.get("transcript_path").and_then(Value::as_str) else {
        return Ok(None);
    };
    let path = Path::new(path);
    if !path.is_absolute() || path.is_symlink() {
        return Ok(None);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let Ok(file) = options.open(path) else {
        return Ok(None);
    };
    task_from_file(file)
}

fn task_from_file(mut file: File) -> Result<Option<String>, ()> {
    let Ok(metadata) = file.metadata() else {
        return Ok(None);
    };
    if !metadata.is_file() || metadata.len() > 50_000_000 {
        return Ok(None);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Ok(None);
        }
    }
    use std::io::{Seek, SeekFrom};
    if file
        .seek(SeekFrom::End(-(metadata.len().min(65_536) as i64)))
        .is_err()
    {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    if Read::by_ref(&mut file)
        .take(65_536)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return Ok(None);
    }
    let tail = String::from_utf8_lossy(&bytes);
    // A tail window can begin inside a screenshot record, whose trailing
    // role/type fields still look like a user message. Rescan complete records
    // instead of treating that partial JSON fragment as an unsafe new task.
    let tail = if metadata.len() > 65_536 {
        tail.split_once('\n').map_or("", |(_, rest)| rest)
    } else {
        &tail
    };
    for raw in tail.lines().rev() {
        if let Some(task) = user_task(raw)? {
            return Ok(Some(task));
        }
    }
    // Long turns can push the latest prompt outside the tail. Scan bounded
    // records instead of silently losing the task and disabling replacement.
    use std::io::BufRead;
    if file.seek(SeekFrom::Start(0)).is_err() {
        return Ok(None);
    }
    let mut reader = std::io::BufReader::new(file.take(metadata.len()));
    let mut latest = Ok(None);
    let mut row = Vec::new();
    loop {
        row.clear();
        let Ok(length) = reader
            .by_ref()
            .take((MAX_TASK_RECORD_BYTES + 1) as u64)
            .read_until(b'\n', &mut row)
        else {
            return Ok(None);
        };
        if length == 0 {
            break;
        }
        if row.len() > MAX_TASK_RECORD_BYTES {
            // An oversized user record cannot supply a safely inspected task.
            let mut role_cursor = 0;
            let mut oversized_user = user_role_fragment(&row, &mut role_cursor);
            if !row.ends_with(b"\n") {
                loop {
                    let Ok(buffer) = reader.fill_buf() else {
                        return Ok(None);
                    };
                    if buffer.is_empty() {
                        break;
                    }
                    let boundary = buffer.iter().position(|byte| *byte == b'\n');
                    let amount = boundary.map_or(buffer.len(), |index| index + 1);
                    if !oversized_user {
                        oversized_user = user_role_fragment(&buffer[..amount], &mut role_cursor);
                    }
                    reader.consume(amount);
                    if boundary.is_some() {
                        break;
                    }
                }
            }
            if oversized_user {
                latest = Err(());
            }
            continue;
        }
        match user_task(&String::from_utf8_lossy(&row)) {
            Ok(Some(task)) => latest = Ok(Some(task)),
            Err(()) => latest = Err(()),
            Ok(None) => {}
        }
    }
    latest
}

fn user_role_fragment(bytes: &[u8], cursor: &mut usize) -> bool {
    // Inspect oversized records without allocating them. Retain the parser
    // state across buffers, including arbitrary JSON whitespace at the colon.
    const PATTERN: &[u8] = b"\"role\":\"user\"";
    for &byte in bytes {
        if matches!(*cursor, 6 | 7) && byte.is_ascii_whitespace() {
            continue;
        }
        if byte == PATTERN[*cursor] {
            *cursor += 1;
            if *cursor == PATTERN.len() {
                return true;
            }
        } else {
            *cursor = usize::from(byte == b'"');
        }
    }
    false
}

pub(super) fn exhaustive_task(task: &str) -> bool {
    let task = task.to_ascii_lowercase();
    [
        "verbatim",
        "byte for byte",
        "byte-for-byte",
        "do not omit",
        "every record",
        "every line",
        "every matching",
        "every file",
        "every path",
        "every entry",
        "every object",
        "every measurement",
        "all paths",
        "all files",
        "all matches",
        "all values",
        "all measurements",
        "all these values",
        "complete output",
        "complete result",
    ]
    .iter()
    .any(|phrase| {
        task.match_indices(phrase).any(|(index, _)| {
            // "install paths" and "small values" are ordinary task text,
            // not requests for "all paths" or "all values".
            !task[..index]
                .chars()
                .next_back()
                .is_some_and(|character| character.is_alphanumeric() || character == '_')
        })
    })
}

fn user_task(raw: &str) -> Result<Option<String>, ()> {
    if !raw.contains("response_item") || !raw.contains("user") {
        return Ok(None);
    }
    let Ok(row) = strict_json::parse(raw.as_bytes()) else {
        return if user_role_fragment(raw.as_bytes(), &mut 0) {
            Err(())
        } else {
            Ok(None)
        };
    };
    if row.get("type").and_then(Value::as_str) != Some("response_item")
        || row.pointer("/payload/role").and_then(Value::as_str) != Some("user")
    {
        return Ok(None);
    }
    let Some(parts) = row.pointer("/payload/content").and_then(Value::as_array) else {
        return Err(());
    };
    let message = parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("input_text"))
        .map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Option<Vec<_>>>()
        .ok_or(())?
        .join(" ");
    if message.len() > MAX_TASK_TEXT_BYTES || sensitive(&message) {
        return Err(());
    }
    let text = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if !text.is_empty() {
        return Ok(Some(text));
    }
    Err(())
}

#[cfg(test)]
#[path = "task_tests.rs"]
mod tests;
