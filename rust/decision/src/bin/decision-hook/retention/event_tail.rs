//! Repair only an interrupted metadata append before the next event.
use super::*;
use std::io::{Seek, SeekFrom};

pub(super) fn repair(path: &Path, never_delete: bool) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(path).map_err(|_| "event tail open")?;
    let metadata = file.metadata().map_err(|_| "event tail stat")?;
    verify(path, &metadata)?;
    let size = metadata.len();
    if size == 0 {
        return Ok(());
    }
    file.seek(SeekFrom::End(-1))
        .map_err(|_| "event tail seek")?;
    let mut last = [0];
    file.read_exact(&mut last).map_err(|_| "event tail read")?;
    if last[0] == b'\n' {
        return Ok(());
    }
    if never_delete {
        verify(path, &file.metadata().map_err(|_| "event tail stat")?)?;
        file.seek(SeekFrom::End(0)).map_err(|_| "event tail seek")?;
        file.write_all(b"\n").map_err(|_| "event tail delimiter")?;
    } else {
        let length = size.min(EVENT_LOG_LIMIT as u64) as usize;
        file.seek(SeekFrom::End(-(length as i64)))
            .map_err(|_| "event tail seek")?;
        let mut tail = vec![0; length];
        file.read_exact(&mut tail).map_err(|_| "event tail read")?;
        let end = match tail.iter().rposition(|byte| *byte == b'\n') {
            Some(position) => size - length as u64 + position as u64 + 1,
            None if size <= EVENT_LOG_LIMIT as u64 => 0,
            None => return Err("event tail exceeds repair bound".into()),
        };
        verify(path, &file.metadata().map_err(|_| "event tail stat")?)?;
        file.set_len(end).map_err(|_| "event tail truncate")?;
    }
    file.sync_all().map_err(|_| "event tail sync".into())
}

pub(super) fn verify(path: &Path, opened: &fs::Metadata) -> Result<(), String> {
    let current = fs::symlink_metadata(path).map_err(|_| "event tail changed")?;
    for metadata in [&current, opened] {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("unsafe event tail".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            // SAFETY: geteuid reads this process's effective user ID.
            if metadata.uid() != unsafe { libc::geteuid() }
                || metadata.permissions().mode() & 0o077 != 0
                || metadata.nlink() != 1
            {
                return Err("unsafe event tail".into());
            }
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if current.dev() != opened.dev() || current.ino() != opened.ino() {
            return Err("event tail changed".into());
        }
    }
    Ok(())
}
