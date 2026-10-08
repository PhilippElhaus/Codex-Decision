use super::*;

#[test]
fn retention_removes_oldest_private_records_with_stable_path_ties() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("2026-10-07-session");
    ensure_dir(&folder).unwrap();
    let now = std::time::SystemTime::now();
    let paths: Vec<_> = [('a', 30), ('b', 20), ('c', 20), ('d', 10)]
        .into_iter()
        .map(|(id, age)| {
            let path = folder.join(format!("receipt-{}.json", id.to_string().repeat(32)));
            write_private(&path, b"1234567890", false).unwrap();
            File::open(&path)
                .unwrap()
                .set_modified(now - Duration::from_secs(age))
                .unwrap();
            path
        })
        .collect();
    prune(root.path(), 20);
    assert!(!paths[0].exists());
    assert!(!paths[1].exists());
    assert!(paths[2].is_file());
    assert!(paths[3].is_file());
}

#[test]
fn retention_preserves_unknown_public_and_linked_content() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("2026-10-07-session");
    ensure_dir(&folder).unwrap();
    let managed = folder.join(format!("batch-{}-0.json", "a".repeat(32)));
    write_private(&managed, b"managed", false).unwrap();
    let names = [
        "receipt-user-notes.json".to_owned(),
        format!("batch-{}-01.json", "b".repeat(32)),
        format!("batch-{}-+1.json", "b".repeat(32)),
        format!("batch-{}-.json", "b".repeat(32)),
        format!("batch-{}-10001.json", "c".repeat(32)),
        "notes.json".into(),
    ];
    for name in &names {
        write_private(&folder.join(name), b"user content", false).unwrap();
    }
    #[cfg(unix)]
    let public = {
        use std::os::unix::fs::PermissionsExt;
        let path = folder.join(format!("receipt-{}.json", "d".repeat(32)));
        write_private(&path, b"copied user content", false).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        path
    };
    #[cfg(unix)]
    let link = {
        let path = folder.join(format!("receipt-{}.json", "e".repeat(32)));
        std::os::unix::fs::symlink(folder.join(&names[0]), &path).unwrap();
        path
    };
    prune(root.path(), 0);
    assert!(!managed.exists());
    for name in &names {
        assert_eq!(fs::read(folder.join(name)).unwrap(), b"user content");
    }
    #[cfg(unix)]
    {
        assert!(public.is_file());
        assert!(link.is_symlink());
    }
}

#[test]
fn event_compaction_keeps_only_complete_tail_records_and_ignores_links() {
    let root = tempfile::tempdir().unwrap();
    let index = root.path().join("events.jsonl");
    let lines: String = (0..80000).map(|n| format!("{{\"event\":{n}}}\n")).collect();
    write_private(&index, lines.as_bytes(), false).unwrap();
    prune(root.path(), 0);
    let actual = fs::read(&index).unwrap();
    let tail = &lines.as_bytes()[lines.len() - 1_048_576..];
    let first = tail.iter().position(|byte| *byte == b'\n').unwrap();
    assert_eq!(actual, &tail[first + 1..]);
    for line in std::str::from_utf8(&actual).unwrap().lines() {
        assert!(serde_json::from_str::<Value>(line).is_ok());
    }
    #[cfg(unix)]
    {
        let outside = root.path().join("outside.jsonl");
        fs::rename(&index, &outside).unwrap();
        std::os::unix::fs::symlink(&outside, &index).unwrap();
        prune(root.path(), 0);
        assert!(index.is_symlink());
        assert_eq!(fs::read(outside).unwrap(), actual);
    }
}

#[test]
fn event_compaction_reserves_the_incoming_row_and_drops_interrupted_rows() {
    let root = tempfile::tempdir().unwrap();
    let index = root.path().join("events.jsonl");
    let rows: String = (0..80_000)
        .map(|sequence| format!("{{\"event\":{sequence}}}\n"))
        .collect();
    let broken = format!("{rows}{{\"interrupted\":");
    write_private(&index, broken.as_bytes(), false).unwrap();
    let incoming = 900_000;
    compact_events_before_append(root.path(), incoming, false).unwrap();
    let actual = fs::read(&index).unwrap();
    assert!(actual.len() + incoming <= EVENT_LOG_LIMIT);
    assert!(actual.ends_with(b"\n"));
    for row in std::str::from_utf8(&actual).unwrap().lines() {
        assert!(serde_json::from_str::<Value>(row).is_ok());
    }
    let previous = actual.clone();
    assert!(compact_events_before_append(root.path(), EVENT_LOG_LIMIT + 1, false).is_err());
    assert_eq!(
        fs::read(&index).unwrap(),
        previous,
        "an oversized event cannot silently exceed the cap"
    );
    compact_events_before_append(root.path(), EVENT_LOG_LIMIT + 1, true).unwrap();
    assert_eq!(
        fs::read(&index).unwrap(),
        previous,
        "explicit never-delete skips compaction"
    );
}

#[test]
fn small_interrupted_tail_preserves_complete_prefix_and_isolates_the_new_event() {
    let prefix = b"{\"synthetic\":1}\n";
    let partial = b"{\"interrupted\":";
    let incoming = b"{\"new_event\":2}\n";
    for never_delete in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let index = root.path().join("events.jsonl");
        let previous = [prefix.as_slice(), partial.as_slice()].concat();
        write_private(&index, &previous, false).unwrap();
        compact_events_before_append(root.path(), incoming.len(), never_delete).unwrap();
        open_event_log(root.path())
            .unwrap()
            .write_all(incoming)
            .unwrap();
        let actual = fs::read(&index).unwrap();
        assert!(actual.starts_with(prefix));
        assert_eq!(
            std::str::from_utf8(&actual)
                .unwrap()
                .lines()
                .last()
                .unwrap(),
            "{\"new_event\":2}"
        );
        let expected = if never_delete {
            [previous.as_slice(), b"\n", incoming.as_slice()].concat()
        } else {
            [prefix.as_slice(), incoming.as_slice()].concat()
        };
        assert_eq!(actual,expected,"never-delete preserves every existing byte; normal retention removes only the interrupted suffix");
    }
}
