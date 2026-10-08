//! Prepare, publish and recover immutable batch evidence.
use super::*;

// Immutable API evidence can be encoded and synced without the session lock.
// Publication links the same verified bytes while the existing transaction owns
// the lock. Dropping the preparation removes only its own pending paths.
pub(super) struct PreparedBatches {
    files: Vec<(usize, PathBuf, journal::Image)>,
}

impl PreparedBatches {
    pub(super) fn new(
        logs: &Path,
        receipt_id: &str,
        gate: Option<&BatchRecord>,
        batches: &[BatchRecord],
    ) -> Result<Self, String> {
        let mut prepared = Self { files: Vec::new() };
        for batch in gate.into_iter().chain(batches.iter()) {
            remaining()?;
            let bytes = encode_batch(receipt_id, batch)?;
            let path = logs.join(format!(".jev-batch-{receipt_id}-{}.pending", batch.id));
            write_private(&path, &bytes, false)?;
            prepared
                .files
                .push((batch.id, path, journal::Image::of(&bytes)));
        }
        Ok(prepared)
    }

    pub(super) fn publish(
        &self,
        folder: &Path,
        receipt_id: &str,
        created: &mut Vec<PathBuf>,
    ) -> Result<(), String> {
        for (batch_id, source, _) in &self.files {
            remaining()?;
            let target = folder.join(format!("batch-{receipt_id}-{batch_id}.json"));
            if source.is_symlink() || target.is_symlink() {
                return Err("linked file".into());
            }
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            let mut file = options.open(source).map_err(|_| "batch stage open")?;
            if !file.metadata().map_err(|_| "batch stage stat")?.is_file() {
                return Err("unsafe staged batch".into());
            }
            match fs::hard_link(source, &target) {
                Ok(()) => {
                    created.push(target);
                    file.set_modified(std::time::SystemTime::now())
                        .map_err(|_| "batch timestamp")?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
                    // A mounted log folder can use another filesystem. Keep
                    // its existing private, atomic write behavior.
                    let mut bytes = Vec::new();
                    Read::by_ref(&mut file)
                        .take(2 * 1024 * 1024 + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|_| "batch stage read")?;
                    if bytes.len() > 2 * 1024 * 1024 {
                        return Err("batch record too large".into());
                    }
                    write_private(&target, &bytes, false)?;
                    created.push(target);
                }
                Err(_) => return Err("original already exists".into()),
            }
        }
        Ok(())
    }

    pub(super) fn artifacts(&self, receipt_id: &str) -> Vec<journal::Artifact> {
        self.files
            .iter()
            .map(|(number, _, image)| journal::Artifact {
                name: format!("batch-{receipt_id}-{number}.json"),
                bytes: image.bytes,
                sha256: image.sha256.clone(),
            })
            .collect()
    }
}

impl Drop for PreparedBatches {
    fn drop(&mut self) {
        for (_, path, _) in &self.files {
            let _ = fs::remove_file(path);
        }
    }
}

// A terminated invocation cannot run Drop. Recover only private, recognized
// pending batches older than the hook's entire 60-second outer timeout.
pub(super) fn cleanup_pending_batches(logs: &Path) {
    let Ok(entries) = fs::read_dir(logs) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name
            .to_str()
            .and_then(|name| name.strip_prefix(".jev-batch-"))
            .and_then(|name| name.strip_suffix(".pending"))
        else {
            continue;
        };
        let Some((id, number)) = name.split_once('-') else {
            continue;
        };
        if id.len() != 32
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !number
                .parse::<usize>()
                .is_ok_and(|value| value <= MAX_SOURCE_LINES && value.to_string() == number)
        {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file()
            || metadata.len() > 2 * 1024 * 1024
            || !metadata.modified().is_ok_and(|time| {
                time.elapsed()
                    .is_ok_and(|age| age >= Duration::from_secs(60))
            })
        {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            // SAFETY: geteuid takes no arguments and reads this process's effective ID.
            if metadata.uid() != unsafe { libc::geteuid() }
                || metadata.permissions().mode() & 0o077 != 0
            {
                continue;
            }
        }
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
#[path = "staging_tests.rs"]
mod staging_tests;
