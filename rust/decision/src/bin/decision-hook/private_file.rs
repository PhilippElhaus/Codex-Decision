//! Bounded reads through one opened, regular private file.
use super::*;

pub(super) fn private_backup(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= limit as u64 =>
        {
            read_bounded(path, limit)
                .map(Some)
                .map_err(|_| "state backup read".into())
        }
        _ => Err("unsafe state backup".into()),
    }
}

pub(super) fn read_bounded(path: &Path, limit: usize) -> std::io::Result<Vec<u8>> {
    let (file, metadata) = private_reader(path)?;
    if metadata.len() > limit as u64 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unsafe private file",
        ));
    }
    // Enforce the bound on the open handle: another writer may grow or
    // replace the file after a caller's initial stat check.
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unsafe private file",
        ));
    }
    Ok(bytes)
}

fn private_reader(path: &Path) -> std::io::Result<(File, fs::Metadata)> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unsafe private file",
        ));
    }
    Ok((file, metadata))
}

pub(super) fn read_private_tail(path: &Path, limit: usize) -> std::io::Result<Option<Vec<u8>>> {
    use std::io::{Seek, SeekFrom};
    let (mut file, metadata) = private_reader(path)?;
    if metadata.len() <= limit as u64 {
        return Ok(None);
    }
    file.seek(SeekFrom::End(-(limit as i64)))?;
    let mut bytes = Vec::with_capacity(limit);
    file.take(limit as u64).read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

#[cfg(test)]
#[path = "private_file_tests.rs"]
mod tests;
