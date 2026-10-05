//! Bounded access to the latest user task, including long turns.
use super::*;

pub(super) fn task_context(event: &Value) -> Result<Option<String>, ()> {
    let Some(path) = event.get("transcript_path").and_then(Value::as_str) else {
        return Ok(None);
    };
    let path = Path::new(path);
    if !path.is_absolute() || path.is_symlink() {
        return Ok(None);
    }
    let Ok(metadata) = fs::metadata(path) else {
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
    let Ok(mut file) = File::open(path) else {
        return Ok(None);
    };
    use std::io::{Seek, SeekFrom};
    if file
        .seek(SeekFrom::End(-(metadata.len().min(65_536) as i64)))
        .is_err()
    {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    if file.take(65_536).read_to_end(&mut bytes).is_err() {
        return Ok(None);
    }
    let tail = String::from_utf8_lossy(&bytes);
    for raw in tail.lines().rev() {
        if let Some(task) = user_task(raw)? {
            return Ok(Some(task));
        }
    }
    // Long turns can push the latest prompt outside the tail. Scan bounded
    // records instead of silently losing the task and disabling replacement.
    use std::io::BufRead;
    let Ok(file) = File::open(path) else {
        return Ok(None);
    };
    let mut reader = std::io::BufReader::new(file.take(metadata.len()));
    let mut latest = Ok(None);
    loop {
        let mut row = Vec::new();
        let Ok(length) = reader.by_ref().take(65_537).read_until(b'\n', &mut row) else {
            return Ok(None);
        };
        if length == 0 {
            break;
        }
        if row.len() > 65_536 {
            // An oversized user record cannot supply a safely inspected task.
            let mut oversized_user = user_role_fragment(&row);
            let mut seam = row[row.len().saturating_sub(32)..].to_vec();
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
                    seam.extend_from_slice(&buffer[..amount]);
                    oversized_user |= user_role_fragment(&seam);
                    seam = seam[seam.len().saturating_sub(32)..].to_vec();
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

fn user_role_fragment(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    text.contains("\"role\":\"user\"") || text.contains("\"role\": \"user\"")
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
    .any(|phrase| task.contains(phrase))
}

fn user_task(raw: &str) -> Result<Option<String>, ()> {
    if !raw.contains("response_item") || !raw.contains("user") {
        return Ok(None);
    }
    let Ok(row) = serde_json::from_str::<Value>(raw) else {
        return Ok(None);
    };
    if row.get("type").and_then(Value::as_str) != Some("response_item")
        || row.pointer("/payload/role").and_then(Value::as_str) != Some("user")
    {
        return Ok(None);
    }
    let Some(parts) = row.pointer("/payload/content").and_then(Value::as_array) else {
        return Ok(None);
    };
    let message = parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("input_text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    if sensitive(&message) {
        return Err(());
    }
    let text: String = message
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(500)
        .collect();
    if !text.is_empty() {
        return Ok(Some(text));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(text: &str) -> String {
        json!({"type":"response_item","payload":{"role":"user",
            "content":[{"type":"input_text","text":text}]}})
        .to_string()
            + "\n"
    }

    #[test]
    fn latest_task_survives_a_long_turn_and_large_tool_records() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("transcript.jsonl");
        let noise = json!({"type":"response_item","payload":{"role":"assistant",
            "content":"x".repeat(200_000)}})
        .to_string()
            + "\n";
        fs::write(
            &path,
            user("Inspect password=synthetic-old-sensitive-task")
                + &user("Check the build and preserve every failure")
                + &noise.repeat(3),
        )
        .unwrap();
        let event = json!({"transcript_path":path});
        assert_eq!(
            task_context(&event).unwrap().unwrap(),
            "Check the build and preserve every failure"
        );
        fs::write(
            &path,
            user("Check the build") + &user("Inspect password=synthetic-sensitive-task") + &noise,
        )
        .unwrap();
        assert!(task_context(&event).is_err());
    }

    #[test]
    fn oversized_latest_user_record_cannot_reuse_an_older_task() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("transcript.jsonl");
        fs::write(&path, user("Check the build") + &user(&"x".repeat(200_000))).unwrap();
        assert!(task_context(&json!({"transcript_path":path})).is_err());
    }
    #[test]
    fn explicit_exhaustive_requests_keep_full_output_without_matching_all_warnings() {
        for task in [
            "Return EVERY matching line verbatim.",
            "Print every file path.",
            "Read the complete output.",
            "Use all these values.",
        ] {
            assert!(exhaustive_task(task));
        }
        for task in [
            "Find all warnings and the failed assertion.",
            "Preserve every failure.",
            "Use Jev appropriately for every call.",
        ] {
            assert!(!exhaustive_task(task));
        }
    }
}
