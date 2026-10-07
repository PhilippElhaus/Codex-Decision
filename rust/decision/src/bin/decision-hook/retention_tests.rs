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
