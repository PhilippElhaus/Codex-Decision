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
fn image_records_preserve_only_the_bounded_latest_text_task() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("transcript.jsonl");
    let image = json!({"type":"input_image", "image_url":
        format!("data:image/png;base64,{}", "a".repeat(800_000))});
    for parts in [
        json!([{"type":"input_text","text":"Inspect the screenshot and test logs"}, image]),
        json!([image, {"type":"input_text","text":"Inspect the screenshot and test logs"}]),
    ] {
        let record =
            json!({"type":"response_item","payload":{"role":"user","content":parts}}).to_string();
        fs::write(&path, user("An older task") + &record + "\n").unwrap();
        assert_eq!(
            task_context(&json!({"transcript_path":path})).unwrap(),
            Some("Inspect the screenshot and test logs".into())
        );
    }
    for text in [
        "password=synthetic-sentinel".into(),
        "x".repeat(MAX_TASK_TEXT_BYTES + 1),
    ] {
        let record = json!({"type":"response_item","payload":{"role":"user","content":[
            {"type":"input_text","text":text}, image]}})
        .to_string();
        fs::write(&path, user("An older task") + &record + "\n").unwrap();
        assert!(task_context(&json!({"transcript_path":path})).is_err());
    }
}

#[test]
fn image_only_and_over_budget_records_do_not_reuse_an_older_task() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("transcript.jsonl");
    for size in [800_000, MAX_TASK_RECORD_BYTES + 1] {
        let record = json!({"type":"response_item","payload":{"role":"user","content":[
            {"type":"input_image","image_url":"a".repeat(size)}]}})
        .to_string();
        fs::write(&path, user("An older task") + &record + "\n").unwrap();
        assert!(task_context(&json!({"transcript_path":path})).is_err());
    }
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
            "content":[{"type":"input_image","image_url":"https://synthetic.invalid/image.png"}]}})
        .to_string(),
        json!({"type":"response_item","payload":{"role":"user","content":"unsupported"}})
            .to_string(),
        "{\"type\":\"response_item\",\"payload\":{\"role\":\"user\",\"content\":[".into(),
        json!({"type":"response_item","payload":{"role":"user","content":[
            {"type":"input_text","text":"Inspect the observations."},
            {"type":"input_text","text":17}]}})
        .to_string(),
        json!({"type":"response_item","payload":{"role":"user","content":[
            {"type":"input_text","text":"Inspect the observations."},
            {"type":"input_text","text":null}]}})
        .to_string(),
        json!({"type":"response_item","payload":{"role":"user","content":[
            {"type":"input_text","text":"Inspect the observations."},
            {"type":"input_text"}]}})
        .to_string(),
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
        "Use Decision appropriately for every call.",
        "Identify failing install paths.",
        "Report the small values relevant to this setting.",
        "Recall paths from cache when investigating the failed lookup.",
    ] {
        assert!(!exhaustive_task(task), "{task}");
    }
}
