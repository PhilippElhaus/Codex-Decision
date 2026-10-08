//! Private filesystem access and process locks.
use super::*;

pub(super) fn ensure_dir(path: &Path) -> Result<(), String> {
    check_ancestors(path)?;
    if path.is_symlink() {
        return Err("linked directory".into());
    }
    if !path.exists() {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            // Apply private permissions at creation. Concurrent first hooks
            // must never observe a public directory before a later chmod.
            builder.mode(0o700);
        }
        builder
            .create(path)
            .map_err(|_| "directory create failed")?;
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "directory stat failed")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("unsafe directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("directory permissions".into());
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;

pub(super) fn check_dir_if_exists(path: &Path) -> Result<(), String> {
    check_ancestors(path)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("directory stat failed".into()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("unsafe directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("directory permissions".into());
        }
    }
    Ok(())
}

pub(super) fn write_private(path: &Path, bytes: &[u8], replace: bool) -> Result<(), String> {
    if path.is_symlink() {
        return Err("linked file".into());
    }
    let temp = path.with_file_name(format!(".jev-{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|_| "file create failed")?;
    let operation = (|| -> Result<(), String> {
        file.write_all(bytes).map_err(|_| "file write failed")?;
        file.sync_all().map_err(|_| "file sync failed")?;
        if replace {
            fs::rename(&temp, path).map_err(|_| "file rename failed")?;
        } else {
            fs::hard_link(&temp, path).map_err(|_| "original already exists")?;
            // The destination is committed. Scratch cleanup must not report a
            // failed write after creating an artifact its caller cannot track.
            let _ = fs::remove_file(&temp);
        }
        Ok(())
    })();
    if operation.is_err() {
        let _ = fs::remove_file(&temp);
    }
    operation
}

pub(super) fn lock_logs(logs: &Path) -> Result<File, String> {
    lock_logs_with_timeout(logs, remaining()?.min(Duration::from_secs(2)))
}

pub(super) fn open_event_log(logs: &Path) -> Result<File, String> {
    let path = logs.join("events.jsonl");
    if path.is_symlink() {
        return Err("linked event log".into());
    }
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A FIFO must fail promptly before any model request or write. The
        // opened handle, rather than an earlier path stat, defines the target.
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| "event log")?;
    if !file.metadata().map_err(|_| "event log stat")?.is_file() {
        return Err("unsafe event log".into());
    }
    Ok(file)
}

// Rollback and error reporting must still run after the invocation budget expires.
pub(super) fn cleanup_log_lock(logs: &Path) -> Result<File, String> {
    lock_logs_with_timeout(logs, Duration::from_secs(2))
}

fn lock_logs_with_timeout(logs: &Path, timeout: Duration) -> Result<File, String> {
    let path = logs.join(".lock");
    if path.is_symlink() {
        return Err("linked log lock".into());
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| "log lock open")?;
    if !file.metadata().map_err(|_| "log lock stat")?.is_file() {
        return Err("unsafe log lock".into());
    }
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let deadline = Instant::now() + timeout;
        // SAFETY: file owns a valid descriptor for the duration of this lock attempt.
        while unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::WouldBlock {
                return Err("log lock failed".into());
            }
            if Instant::now() >= deadline {
                return Err("log lock timeout".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    // The permanent log inode serializes recovery and every producer write.
    recover_publication(logs)?;
    Ok(file)
}

// A small, private signal that the control can inspect without reading tool text or credentials.
// The log lock prevents concurrent hooks from replacing a newer signal with an older one.
pub(super) fn session_dir(data_dir: &Path, session: &str) -> Result<PathBuf, String> {
    if session.is_empty()
        || session.len() > 128
        || !session
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err("invalid session id".into());
    }
    Ok(data_dir
        .join("sessions")
        .join(format!("{:x}", Sha256::digest(session.as_bytes()))))
}

pub(super) fn output_path(data_dir: &Path, event: &Value) -> Result<PathBuf, String> {
    let valid = |key: &str| {
        key.len() <= 128
            && !key.is_empty()
            && key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    };
    let session = event
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or("missing session id")?;
    let call = event
        .get("tool_use_id")
        .and_then(Value::as_str)
        .ok_or("missing tool id")?;
    if !valid(session) || !valid(call) {
        return Err("invalid tool id".into());
    }
    let hash = |text: &str| format!("{:x}", Sha256::digest(text.as_bytes()))[..20].to_owned();
    Ok(data_dir
        .join("outputs")
        .join(hash(session))
        .join(format!("{}.txt", hash(call))))
}
