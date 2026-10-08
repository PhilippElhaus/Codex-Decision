//! Seed only retained metadata lower bounds when an older ledger is missing.
use super::*;
use std::io::{Seek, SeekFrom};

pub(super) fn retained_stats(logs: &Path) -> Result<Option<Value>, String> {
    let filename = logs.join("events.jsonl");
    let metadata = match fs::symlink_metadata(&filename) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("event history stat".into()),
    };
    // Special files are rejected at the normal event-write boundary; never open
    // them while determining whether a usable historical baseline exists.
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
        return Ok(None);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(&filename).map_err(|_| "event history open")?;
    let opened = file.metadata().map_err(|_| "event history stat")?;
    if !opened.is_file() {
        return Err("unsafe event history".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid only reads the effective process user identity.
        if opened.uid() != unsafe { libc::geteuid() }
            || opened.permissions().mode() & 0o077 != 0
            || opened.nlink() != 1
            || opened.dev() != metadata.dev()
            || opened.ino() != metadata.ino()
        {
            return Err("unsafe event history".into());
        }
    }
    let size = opened.len();
    let start = size.saturating_sub(1_048_576);
    file.seek(SeekFrom::Start(start))
        .map_err(|_| "event history seek")?;
    let mut bytes = Vec::new();
    file.take(1_048_576)
        .read_to_end(&mut bytes)
        .map_err(|_| "event history read")?;
    codex_decision::activity_counters::retained_stats_from_events(&bytes, start > 0).map(Some)
}

pub(crate) fn load_activity_stats(data_dir: &Path) -> Result<Value, String> {
    let filename = data_dir.join("stats.json");
    if filename.exists() {
        let mut stats = load_stats(&filename)?;
        prepare_stats_counters(&mut stats, true)?;
        return Ok(stats);
    }
    if let Some(stats) = retained_stats(&data_dir.join("logs"))? {
        return Ok(stats);
    }
    let mut stats = json!({});
    prepare_stats_counters(&mut stats, false)?;
    Ok(stats)
}
