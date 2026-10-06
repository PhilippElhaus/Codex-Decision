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
        let Ok(length) = reader.by_ref().take(65_537).read_until(b'\n', &mut row) else {
            return Ok(None);
        };
        if length == 0 {
            break;
        }
        if row.len() > 65_536 {
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
    if sensitive(&message) {
        return Err(());
    }
    let text = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if !text.is_empty() {
        return Ok(Some(text));
    }
    Err(())
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

    #[cfg(unix)]
    #[test]
    fn transcript_rotation_cannot_change_the_opened_task() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("transcript.jsonl");
        let backup = root.path().join("opened.jsonl");
        let replacement = root.path().join("replacement.jsonl");
        let noise = json!({"type":"response_item","payload":{"role":"assistant",
            "content":"x".repeat(200_000)}})
        .to_string();
        for kind in ["regular", "symlink", "fifo"] {
            fs::write(&path, user("Inspect the opened task") + &noise).unwrap();
            let file = File::open(&path).unwrap();
            fs::rename(&path, &backup).unwrap();
            fs::write(&replacement, user("Inspect a different task")).unwrap();
            match kind {
                "regular" => fs::rename(&replacement, &path).unwrap(),
                "symlink" => std::os::unix::fs::symlink(&replacement, &path).unwrap(),
                _ => {
                    use std::os::unix::ffi::OsStrExt;
                    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
                    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
                }
            }
            assert_eq!(
                task_from_file(file).unwrap(),
                Some("Inspect the opened task".into())
            );
            fs::remove_file(&path).unwrap();
            fs::remove_file(&backup).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn nonregular_transcripts_are_rejected_without_waiting_for_a_writer() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("transcript.fifo");
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let event = json!({"transcript_path":path});
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || sender.send(task_context(&event)).unwrap());
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("transcript read blocked"),
            Ok(None)
        );
        assert_eq!(
            task_context(&json!({"transcript_path":root.path()})),
            Ok(None)
        );
    }

    #[test]
    fn task_requirements_after_the_old_cue_limit_remain_available() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("transcript.jsonl");
        let prefix = "Inspect the synthetic observations. ".repeat(25);
        for requirement in [
            "Return every record verbatim.",
            "Report the exact primary and fallback endpoint values.",
        ] {
            fs::write(&path, user(&(prefix.clone() + requirement))).unwrap();
            let task = task_context(&json!({"transcript_path":path}))
                .unwrap()
                .unwrap();
            assert!(task.ends_with(requirement));
        }
    }

    #[test]
    fn an_unusable_latest_user_record_cannot_reuse_an_older_task() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("transcript.jsonl");
        let records = [
            user("   \t  "),
            json!({"type":"response_item","payload":{"role":"user","content":[]}}).to_string(),
            json!({"type":"response_item","payload":{"role":"user",
                "content":[{"type":"input_image","image_url":"https://synthetic.invalid/image.png"}]}}).to_string(),
            json!({"type":"response_item","payload":{"role":"user","content":"unsupported"}}).to_string(),
            "{\"type\":\"response_item\",\"payload\":{\"role\":\"user\",\"content\":[".into(),
            json!({"type":"response_item","payload":{"role":"user","content":[
                {"type":"input_text","text":"Inspect the observations."},
                {"type":"input_text","text":17}]}}).to_string(),
            json!({"type":"response_item","payload":{"role":"user","content":[
                {"type":"input_text","text":"Inspect the observations."},
                {"type":"input_text","text":null}]}}).to_string(),
            json!({"type":"response_item","payload":{"role":"user","content":[
                {"type":"input_text","text":"Inspect the observations."},
                {"type":"input_text"}]}}).to_string(),
        ];
        for record in records {
            fs::write(&path, user("Check the build") + &record + "\n").unwrap();
            assert!(task_context(&json!({"transcript_path":path})).is_err());
            fs::write(
                &path,
                user("Check the build") + &record + "\n" + &user("Inspect the newest result"),
            )
            .unwrap();
            assert_eq!(
                task_context(&json!({"transcript_path":path})).unwrap(),
                Some("Inspect the newest result".into())
            );
        }
    }

    #[test]
    fn oversized_user_records_with_json_whitespace_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("transcript.jsonl");
        for padding in [1, 65_550, 131_072] {
            let spaces = " ".repeat(padding);
            let oversized = format!(
                "{{\"type\":\"response_item\",\"payload\":{{\"role\"{spaces}:{spaces}\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"{}\"}}]}}}}\n",
                "x".repeat(200_000)
            );
            fs::write(&path, user("Check the build") + &oversized).unwrap();
            assert!(task_context(&json!({"transcript_path":path})).is_err());
        }
        let assistant = json!({"type":"response_item","payload":{"role":"assistant",
            "content": "\"role\" : \"user\" ".repeat(20_000)}})
        .to_string();
        fs::write(&path, user("Check the build") + &assistant).unwrap();
        assert_eq!(
            task_context(&json!({"transcript_path":path})).unwrap(),
            Some("Check the build".into())
        );
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
            "Identify failing install paths.",
            "Report the small values relevant to this setting.",
            "Recall paths from cache when investigating the failed lookup.",
        ] {
            assert!(!exhaustive_task(task), "{task}");
        }
    }
}
