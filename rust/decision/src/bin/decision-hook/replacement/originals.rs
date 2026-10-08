//! Keep exact owned originals available after an interrupted publication.
use super::*;

#[path = "locking.rs"]
mod locking;

pub(crate) struct SavedOriginals {
    created: Vec<PathBuf>,
    leases: Vec<File>,
    _lock: File,
}

impl SavedOriginals {
    pub(crate) fn save(path: &Path, source: &str, envelope: &Value) -> Result<Self, String> {
        let mut saved = Self {
            created: Vec::with_capacity(2),
            leases: Vec::with_capacity(2),
            _lock: locking::lock(path.parent().ok_or("invalid output path")?)?,
        };
        saved.save_file(path, source.as_bytes())?;
        if !envelope.is_string() {
            let bytes = serde_json::to_vec(envelope).map_err(|_| "original envelope encoding")?;
            saved.save_file(&path.with_extension("json"), &bytes)?;
        }
        Ok(saved)
    }

    fn save_file(&mut self, path: &Path, expected: &[u8]) -> Result<(), String> {
        remaining()?;
        if let Some(file) = matching_original(path, expected)? {
            self.leases.push(file);
            return Ok(());
        }
        match write_private(path, expected, false) {
            Ok(()) => self.created.push(path.to_owned()),
            Err(error) if error == "original already exists" => {
                // Another invocation may publish the same exact original
                // between the absent-file check and the atomic link.
                self.leases
                    .push(matching_original(path, expected)?.ok_or(error)?);
            }
            Err(error) => return Err(error),
        }
        Ok(())
    }

    pub(crate) fn commit(mut self) {
        self.created.clear();
    }
}

impl Drop for SavedOriginals {
    fn drop(&mut self) {
        // Leased files predate this attempt. Rollback removes only the files
        // created by this attempt, including a newly completed partial pair.
        for path in &self.created {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(unix)]
fn matching_original(path: &Path, expected: &[u8]) -> Result<Option<File>, String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    let initial = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("original already exists".into()),
    };
    // SAFETY: geteuid takes no arguments and reads this process's effective ID.
    let uid = unsafe { libc::geteuid() };
    let private = |metadata: &fs::Metadata| {
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.len() == expected.len() as u64
            && metadata.nlink() == 1
            && metadata.uid() == uid
            && metadata.permissions().mode() & 0o077 == 0
    };
    if !private(&initial) {
        return Err("original already exists".into());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "original already exists")?;
    let opened = file.metadata().map_err(|_| "original already exists")?;
    if !private(&opened) || opened.dev() != initial.dev() || opened.ino() != initial.ino() {
        return Err("original already exists".into());
    }
    let mut buffer = [0; 8192];
    let mut offset = 0;
    loop {
        remaining()?;
        let limit = buffer.len().min(expected.len().saturating_sub(offset) + 1);
        let count = match file.read(&mut buffer[..limit]) {
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("original already exists".into()),
        };
        if count == 0 {
            break;
        }
        if expected.get(offset..offset + count) != Some(&buffer[..count]) {
            return Err("original already exists".into());
        }
        offset += count;
    }
    let current = fs::symlink_metadata(path).map_err(|_| "original already exists")?;
    let finished = file.metadata().map_err(|_| "original already exists")?;
    if offset != expected.len()
        || !private(&current)
        || !private(&finished)
        || current.dev() != opened.dev()
        || current.ino() != opened.ino()
        || current.modified().ok() != opened.modified().ok()
        || finished.modified().ok() != opened.modified().ok()
    {
        return Err("original already exists".into());
    }
    Ok(Some(file))
}

#[cfg(not(unix))]
fn matching_original(path: &Path, _expected: &[u8]) -> Result<Option<File>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        _ => Err("original already exists".into()),
    }
}

#[cfg(test)]
#[path = "originals_tests.rs"]
mod tests;
