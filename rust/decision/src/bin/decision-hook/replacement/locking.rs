//! Serialize save/publication/rollback through one permanent session inode.
use super::*;

pub(super) fn lock(directory: &Path) -> Result<File, String> {
    check_ancestors(directory)?;
    let path = directory.join(".originals.lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    if path.is_symlink() {
        return Err("unsafe original lock".into());
    }
    let file = options.open(&path).map_err(|_| "original lock open")?;
    let metadata = file.metadata().map_err(|_| "original lock stat")?;
    if !metadata.is_file() || metadata.len() != 0 {
        return Err("unsafe original lock".into());
    }
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid takes no arguments and reads the effective user ID.
        if metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err("unsafe original lock".into());
        }
        let deadline = Instant::now() + remaining()?.min(Duration::from_secs(2));
        // SAFETY: file owns the descriptor throughout this lock attempt.
        while unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::WouldBlock {
                return Err("original lock failed".into());
            }
            if Instant::now() >= deadline {
                return Err("original lock timeout".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    // Never unlink this file: waiters must all lock the same stable inode.
    Ok(file)
}
