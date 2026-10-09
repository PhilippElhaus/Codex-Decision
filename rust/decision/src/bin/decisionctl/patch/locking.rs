//! One kernel lock protects status and mutations without writing a lock file.
use super::*;
use std::fs::File;

pub(super) fn reject_links(path: &Path) -> Result<(), String> {
    for ancestor in path
        .ancestors()
        .filter(|ancestor| !ancestor.as_os_str().is_empty())
    {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
                    return Err("Decision patch paths must not contain links".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_: &fs::Metadata) -> bool {
    false
}

pub(super) fn acquire(backup: &Path) -> Result<File, String> {
    let parent = backup.parent().ok_or("rollback parent missing")?;
    reject_links(parent)?;
    if !parent.is_dir() {
        return Err("rollback parent must be an existing directory".into());
    }
    let file = File::open(parent).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        // The existing directory handle owns this nonblocking lock until drop.
        // No durable marker survives a crash, and status remains read-only.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            return Err(if error.kind() == std::io::ErrorKind::WouldBlock {
                "Decision patch is busy; retry later".into()
            } else {
                format!("Decision patch lock failed: {error}")
            });
        }
        Ok(file)
    }
    #[cfg(not(unix))]
    {
        let _ = file;
        Err("Decision patch requires the WSL or Unix executable".into())
    }
}

pub(super) fn paths(repo: &Path, extension: &Path, backup: &Path) -> Result<(), String> {
    for path in [repo, extension, backup] {
        reject_links(path)?;
    }
    if !repo.is_dir() || !extension.is_dir() || !extension.is_absolute() || !backup.is_absolute() {
        return Err("invalid Decision patch paths".into());
    }
    let extension = fs::canonicalize(extension).map_err(|error| error.to_string())?;
    let backup_parent = fs::canonicalize(backup.parent().ok_or("rollback parent missing")?)
        .map_err(|_| "rollback parent must be an existing directory")?;
    for path in [&extension, &backup_parent] {
        let text = path.to_string_lossy().to_ascii_lowercase();
        if text == "/mnt/d" || text.starts_with("/mnt/d/") || text.starts_with("d:\\") {
            return Err("extension and rollback must be valid paths off D:".into());
        }
    }
    Ok(())
}
