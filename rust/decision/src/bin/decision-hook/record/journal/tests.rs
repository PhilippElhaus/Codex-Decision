use super::*;

const OLD_STATS: &[u8] = br#"{"completed":1,"replaced":1}"#;
const NEW_STATS: &[u8] = br#"{"completed":2,"replaced":2}"#;
const OLD_SNAPSHOT: &[u8] = br#"{"status":"processing"}"#;
const NEW_SNAPSHOT: &[u8] = br#"{"status":"replace"}"#;
const EVENT: &[u8] = b"{\"status\":\"replace\"}\n";

struct Fixture {
    root: tempfile::TempDir,
    logs: PathBuf,
    artifact: PathBuf,
    id: String,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let logs = root.path().join("logs");
        ensure_dir(&logs).unwrap();
        let folder = logs.join("2026-10-08-0123456789");
        ensure_dir(&folder).unwrap();
        let id = "a".repeat(32);
        let artifact = folder.join(format!("receipt-{id}.json"));
        write_private(&root.path().join("stats.json"), OLD_STATS, false).unwrap();
        write_private(&logs.join("latest-decision.json"), OLD_SNAPSHOT, false).unwrap();
        write_private(&logs.join("events.jsonl"), b"", false).unwrap();
        Self {
            root,
            logs,
            artifact,
            id,
        }
    }
    fn begin(&self) -> Publication {
        let image = Image::of(b"owned receipt");
        Publication::begin(
            self.root.path(),
            "2026-10-08-0123456789",
            &self.id,
            Some(OLD_STATS.to_vec()),
            NEW_STATS,
            Some((Some(OLD_SNAPSHOT.to_vec()), NEW_SNAPSHOT)),
            vec![Artifact {
                name: self.artifact.file_name().unwrap().to_str().unwrap().into(),
                bytes: image.bytes,
                sha256: image.sha256,
            }],
            0,
            EVENT,
        )
        .unwrap()
    }
    fn stage(&self, phase: usize) {
        write_private(&self.artifact, b"owned receipt", false).unwrap();
        if phase >= 1 {
            write_private(&self.root.path().join("stats.json"), NEW_STATS, true).unwrap();
        }
        if phase >= 2 {
            write_private(&self.logs.join("latest-decision.json"), NEW_SNAPSHOT, true).unwrap();
        }
        if phase >= 3 {
            let mut event = open_event_log(&self.logs).unwrap();
            event.write_all(EVENT).unwrap();
            event.sync_all().unwrap();
        }
    }
}

#[test]
fn each_uncommitted_publication_phase_restores_exact_preimages() {
    for phase in 0..4 {
        let f = Fixture::new();
        let _publication = f.begin();
        f.stage(phase);
        // No Rust guard rollback is assumed: recovery uses only durable state.
        recover(&f.logs).unwrap();
        assert_eq!(
            fs::read(f.root.path().join("stats.json")).unwrap(),
            OLD_STATS
        );
        assert_eq!(
            fs::read(f.logs.join("latest-decision.json")).unwrap(),
            OLD_SNAPSHOT
        );
        assert_eq!(fs::read(f.logs.join("events.jsonl")).unwrap(), b"");
        assert!(!f.artifact.exists());
        assert!(!f.logs.join(JOURNAL_NAME).exists());
        let retry = f.begin();
        f.stage(3);
        retry.commit().unwrap();
        recover(&f.logs).unwrap();
        assert_eq!(
            fs::read(f.root.path().join("stats.json")).unwrap(),
            NEW_STATS
        );
        assert_eq!(fs::read(&f.artifact).unwrap(), b"owned receipt");
    }
}

#[test]
fn explicit_marker_is_finalized_without_counter_rollback() {
    let f = Fixture::new();
    let publication = f.begin();
    f.stage(3);
    publication.commit().unwrap();
    recover(&f.logs).unwrap();
    assert_eq!(
        fs::read(f.root.path().join("stats.json")).unwrap(),
        NEW_STATS
    );
    assert_eq!(
        fs::read(f.logs.join("latest-decision.json")).unwrap(),
        NEW_SNAPSHOT
    );
    assert_eq!(fs::read(f.logs.join("events.jsonl")).unwrap(), EVENT);
    assert!(f.artifact.exists());
    assert!(!f.logs.join(JOURNAL_NAME).exists());
}

#[cfg(unix)]
#[test]
fn deferred_cleanup_blocks_retention_until_a_later_locked_recovery() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let publication = f.begin();
    f.stage(3);
    publication.commit().unwrap();
    let backup = f
        .logs
        .join(format!(".decision-publication-{}.snapshot-before", f.id));
    fs::set_permissions(&backup, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        !publication.committed(),
        "Retention cannot run with an unfinished journal"
    );
    assert!(f.artifact.exists());
    assert!(f.logs.join(JOURNAL_NAME).exists());
    fs::set_permissions(&backup, fs::Permissions::from_mode(0o600)).unwrap();
    drop(lock_logs(&f.logs).unwrap());
    assert!(!f.logs.join(JOURNAL_NAME).exists());
    assert!(f.artifact.exists());
}

#[test]
fn a_verified_lease_refuses_in_place_mutation_before_deletion() {
    let f = Fixture::new();
    let path = f.logs.join("lease.json");
    write_private(&path, b"private", false).unwrap();
    let mut lease = files::Lease::open(&path, false, 1).unwrap().unwrap();
    assert!(lease.matches(&Image::of(b"private")).unwrap());
    let mut writer = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&path)
        .unwrap();
    writer.write_all(b"different length").unwrap();
    writer.sync_all().unwrap();
    assert!(lease.remove().is_err());
    assert_eq!(fs::read(path).unwrap(), b"different length");
}

#[test]
fn committed_cleanup_can_resume_after_the_prior_backup_has_been_removed() {
    let f = Fixture::new();
    let _publication = f.begin();
    f.stage(3);
    let path = f.logs.join(JOURNAL_NAME);
    let mut journal = Journal::parse(&fs::read(&path).unwrap()).unwrap();
    journal.state = "committed".into();
    write_private(&path, &serde_json::to_vec(&journal).unwrap(), true).unwrap();
    fs::remove_file(journal.backup(&f.logs)).unwrap();
    recover(&f.logs).unwrap();
    assert_eq!(
        fs::read(f.root.path().join("stats.json")).unwrap(),
        NEW_STATS
    );
    assert!(f.artifact.exists());
    assert!(!path.exists());
}

#[test]
fn descriptor_cap_and_path_rejection_happen_before_publication_mutation() {
    let f = Fixture::new();
    for descriptors in [
        vec![Artifact {
            name: "../foreign.json".into(),
            bytes: 0,
            sha256: "a".repeat(64),
        }],
        (0..2000)
            .map(|n| Artifact {
                name: format!("batch-{}-{n}.json", f.id),
                bytes: 0,
                sha256: "a".repeat(64),
            })
            .collect(),
    ] {
        assert!(Publication::begin(
            f.root.path(),
            "2026-10-08-0123456789",
            &f.id,
            Some(OLD_STATS.to_vec()),
            NEW_STATS,
            Some((Some(OLD_SNAPSHOT.to_vec()), NEW_SNAPSHOT)),
            descriptors,
            0,
            EVENT
        )
        .is_err());
        assert!(!f.logs.join(JOURNAL_NAME).exists());
        assert_eq!(
            fs::read(f.root.path().join("stats.json")).unwrap(),
            OLD_STATS
        );
    }
}

#[test]
fn known_normal_sync_failure_can_rollback_a_complete_but_uncommitted_row() {
    let f = Fixture::new();
    let publication = f.begin();
    f.stage(3);
    publication.rollback().unwrap();
    assert_eq!(
        fs::read(f.root.path().join("stats.json")).unwrap(),
        OLD_STATS
    );
    assert_eq!(fs::read(f.logs.join("events.jsonl")).unwrap(), b"");
    assert!(!f.artifact.exists());
}

#[test]
fn unknown_images_artifacts_or_event_tail_are_preserved_and_refused() {
    for kind in ["stats", "snapshot", "artifact", "event", "backup"] {
        let f = Fixture::new();
        let _publication = f.begin();
        f.stage(2);
        let target = match kind {
            "stats" => f.root.path().join("stats.json"),
            "snapshot" => f.logs.join("latest-decision.json"),
            "artifact" => f.artifact.clone(),
            "event" => f.logs.join("events.jsonl"),
            _ => f
                .logs
                .join(format!(".decision-publication-{}.snapshot-before", f.id)),
        };
        write_private(&target, b"unknown private content", true).unwrap();
        let before = fs::read(&target).unwrap();
        assert!(recover(&f.logs).is_err());
        assert_eq!(fs::read(&target).unwrap(), before);
        assert!(f.logs.join(JOURNAL_NAME).exists());
        assert!(f.artifact.exists());
    }
}

#[test]
fn missing_backup_before_mutation_and_partial_commit_row_recover() {
    let f = Fixture::new();
    let _publication = f.begin();
    fs::remove_file(
        f.logs
            .join(format!(".decision-publication-{}.snapshot-before", f.id)),
    )
    .unwrap();
    recover(&f.logs).unwrap();
    let _publication = f.begin();
    f.stage(2);
    let mut event = open_event_log(&f.logs).unwrap();
    event.write_all(&EVENT[..7]).unwrap();
    event.sync_all().unwrap();
    recover(&f.logs).unwrap();
    assert_eq!(
        fs::read(f.root.path().join("stats.json")).unwrap(),
        OLD_STATS
    );
    assert_eq!(fs::read(f.logs.join("events.jsonl")).unwrap(), b"");
}

#[cfg(unix)]
#[test]
fn public_symlink_hardlink_and_fifo_journals_never_get_changed() {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{symlink, PermissionsExt};
    for kind in ["public", "symlink", "hardlink", "fifo"] {
        let f = Fixture::new();
        let _publication = f.begin();
        let journal = f.logs.join(JOURNAL_NAME);
        let foreign = f.logs.join("foreign.json");
        let original = fs::read(&journal).unwrap();
        fs::remove_file(&journal).unwrap();
        write_private(&foreign, &original, false).unwrap();
        match kind {
            "public" => {
                fs::write(&journal, &original).unwrap();
                fs::set_permissions(&journal, fs::Permissions::from_mode(0o644)).unwrap();
            }
            "symlink" => symlink(&foreign, &journal).unwrap(),
            "hardlink" => fs::hard_link(&foreign, &journal).unwrap(),
            _ => {
                let name = std::ffi::CString::new(journal.as_os_str().as_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            }
        }
        assert!(recover(&f.logs).is_err());
        assert_eq!(fs::read(&foreign).unwrap(), original);
        assert!(fs::symlink_metadata(&journal).is_ok());
    }
}
