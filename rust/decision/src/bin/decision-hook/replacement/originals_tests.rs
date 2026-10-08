use super::*;

fn fixture() -> (tempfile::TempDir, PathBuf, Value) {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    ensure_dir(&data).unwrap();
    (
        root,
        data.join("call.txt"),
        json!({"exit_code":1,"output":"exact synthetic output\r\n"}),
    )
}

#[cfg(unix)]
#[test]
fn complete_matching_pair_is_leased_and_never_removed_by_rollback() {
    let (_root, path, envelope) = fixture();
    let source = "exact synthetic output\r\n";
    SavedOriginals::save(&path, source, &envelope)
        .unwrap()
        .commit();
    let before = fs::metadata(&path).unwrap().modified().unwrap();
    let saved = SavedOriginals::save(&path, source, &envelope).unwrap();
    assert!(saved.created.is_empty());
    assert_eq!(saved.leases.len(), 2);
    drop(saved);
    assert_eq!(fs::read(&path).unwrap(), source.as_bytes());
    assert_eq!(
        fs::read(path.with_extension("json")).unwrap(),
        serde_json::to_vec(&envelope).unwrap()
    );
    assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), before);
}

#[cfg(unix)]
#[test]
fn partial_matching_pair_creates_only_missing_envelope_and_preserves_leased_text() {
    let (_root, path, envelope) = fixture();
    let source = "exact synthetic output\r\n";
    write_private(&path, source.as_bytes(), false).unwrap();
    let saved = SavedOriginals::save(&path, source, &envelope).unwrap();
    assert_eq!(saved.created, vec![path.with_extension("json")]);
    assert_eq!(saved.leases.len(), 1);
    drop(saved);
    assert_eq!(fs::read(&path).unwrap(), source.as_bytes());
    assert!(!path.with_extension("json").exists());
    SavedOriginals::save(&path, source, &envelope)
        .unwrap()
        .commit();
    assert_eq!(
        fs::read(path.with_extension("json")).unwrap(),
        serde_json::to_vec(&envelope).unwrap()
    );
}

#[test]
fn different_original_content_is_preserved_and_never_replaced() {
    for typed in [false, true] {
        let (_root, path, envelope) = fixture();
        let target = if typed {
            path.with_extension("json")
        } else {
            path.clone()
        };
        write_private(&target, b"different private content", false).unwrap();
        assert!(SavedOriginals::save(&path, "exact synthetic output\r\n", &envelope).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"different private content");
        if typed {
            assert!(!path.exists());
        } else {
            assert!(!path.with_extension("json").exists());
        }
    }
}

#[cfg(unix)]
#[test]
fn original_lock_inode_survives_rollback_and_unknown_lock_content_is_preserved() {
    use std::os::unix::fs::MetadataExt;
    let (_root, path, envelope) = fixture();
    let source = "exact synthetic output\r\n";
    let saved = SavedOriginals::save(&path, source, &envelope).unwrap();
    let lock = path.parent().unwrap().join(".originals.lock");
    let inode = fs::metadata(&lock).unwrap().ino();
    drop(saved);
    assert!(!path.exists());
    assert_eq!(fs::metadata(&lock).unwrap().ino(), inode);
    SavedOriginals::save(&path, source, &envelope)
        .unwrap()
        .commit();
    assert_eq!(fs::metadata(&lock).unwrap().ino(), inode);

    let (_other, other_path, other_envelope) = fixture();
    let other_lock = other_path.parent().unwrap().join(".originals.lock");
    write_private(&other_lock, b"unknown private content", false).unwrap();
    assert!(SavedOriginals::save(&other_path, source, &other_envelope).is_err());
    assert_eq!(fs::read(other_lock).unwrap(), b"unknown private content");
    assert!(!other_path.exists());

    let (_linked, linked_path, linked_envelope) = fixture();
    let linked_lock = linked_path.parent().unwrap().join(".originals.lock");
    let foreign_lock = linked_path.with_file_name("foreign.lock");
    write_private(&foreign_lock, b"", false).unwrap();
    fs::hard_link(&foreign_lock, &linked_lock).unwrap();
    assert!(SavedOriginals::save(&linked_path, source, &linked_envelope).is_err());
    assert_eq!(fs::metadata(&foreign_lock).unwrap().nlink(), 2);
    assert!(!linked_path.exists());
}

#[cfg(unix)]
#[test]
fn public_linked_directory_and_fifo_paths_stay_untouched() {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{symlink, PermissionsExt};
    for kind in ["public", "link", "hardlink", "directory", "fifo"] {
        let (_root, path, envelope) = fixture();
        let source = "exact synthetic output\r\n";
        let foreign = path.with_file_name("foreign.txt");
        write_private(&foreign, source.as_bytes(), false).unwrap();
        match kind {
            "public" => {
                fs::write(&path, source).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            }
            "link" => symlink(&foreign, &path).unwrap(),
            "hardlink" => fs::hard_link(&foreign, &path).unwrap(),
            "directory" => fs::create_dir(&path).unwrap(),
            "fifo" => {
                let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
                // SAFETY: name is NUL-terminated and remains live for this call.
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            }
            _ => unreachable!(),
        }
        let before = fs::symlink_metadata(&path).unwrap();
        assert!(SavedOriginals::save(&path, source, &envelope).is_err());
        let after = fs::symlink_metadata(&path).unwrap();
        assert_eq!(before.file_type(), after.file_type());
        assert_eq!(before.permissions().mode(), after.permissions().mode());
        assert_eq!(fs::read(&foreign).unwrap(), source.as_bytes());
        assert!(!path.with_extension("json").exists());
        if kind == "public" {
            assert_eq!(fs::read(&path).unwrap(), source.as_bytes());
        }
    }
}
