use super::*;

#[cfg(unix)]
#[test]
fn concurrent_initialization_creates_only_private_directory_components() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    for iteration in 0..32 {
        let path = root.path().join(format!("session-{iteration}"));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let path = path.join("sessions/thread/logs");
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    ensure_dir(&path)
                })
            })
            .collect();
        for thread in threads {
            assert!(thread.join().unwrap().is_ok());
        }
        for relative in ["", "sessions", "sessions/thread", "sessions/thread/logs"] {
            assert_eq!(
                fs::metadata(path.join(relative))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o077,
                0
            );
        }
    }
    let existing = root.path().join("existing-user-directory");
    fs::create_dir(&existing).unwrap();
    fs::set_permissions(&existing, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(ensure_dir(&existing).unwrap_err(), "directory permissions");
    assert_eq!(
        fs::metadata(existing).unwrap().permissions().mode() & 0o777,
        0o755
    );
}
