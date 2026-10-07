use super::*;

#[test]
fn tail_reads_keep_exact_bytes_with_a_fixed_memory_bound() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("events.jsonl");
    for limit in [1, 64, 1024] {
        let bytes = "状态🌍\r\n".repeat(400);
        fs::write(&path, bytes.as_bytes()).unwrap();
        assert_eq!(
            read_private_tail(&path, limit).unwrap().unwrap(),
            bytes.as_bytes()[bytes.len() - limit..]
        );
        assert!(read_private_tail(&path, bytes.len()).unwrap().is_none());
    }
}

#[cfg(unix)]
#[test]
fn tail_reads_never_follow_links_or_wait_for_special_files() {
    use std::os::unix::ffi::OsStrExt;
    let root = tempfile::tempdir().unwrap();
    let outside = root.path().join("outside");
    fs::write(&outside, b"unrelated private content").unwrap();
    let link = root.path().join("linked.jsonl");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(read_private_tail(&link, 1).is_err());
    let fifo = root.path().join("fifo.jsonl");
    let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    // SAFETY: name is a valid, terminated path inside this private fixture.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        sender.send(read_private_tail(&fifo, 1).is_err()).unwrap();
        drop(root);
    });
    assert!(receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("tail read blocked"));
}
