//! Fixed-size metadata log. Contention and unsafe/full targets simply lose telemetry.
use super::*;
use std::io::{Seek, SeekFrom};

pub(super) const LIMIT: usize = 4 * 1024 * 1024;
const RETAINED: usize = 3 * 1024 * 1024;
const ROW_LIMIT: usize = 4096;

pub(super) fn append(scoped: &Path, value: &Value, never_delete: bool) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| "telemetry encoding")?;
    if bytes.len() >= ROW_LIMIT {
        return Err("telemetry row too large".into());
    }
    bytes.push(b'\n');
    let logs = scoped.join("logs");
    ensure_dir(&logs)?;
    // Never wait for a filter transaction or extend its request deadline.
    let _lock = try_telemetry_lock(&logs)?;
    let path = logs.join("telemetry.jsonl");
    if path.is_symlink() {
        return Err("linked telemetry".into());
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let mut file = options.open(&path).map_err(|_| "telemetry open")?;
    #[cfg(windows)]
    codex_decision::windows::private(&file, 1)?;
    let metadata = file.metadata().map_err(|_| "telemetry stat")?;
    if !metadata.is_file() {
        return Err("unsafe telemetry".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid only reads this process's effective user ID.
        if metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err("unsafe telemetry permissions".into());
        }
    }
    let length = metadata.len();
    if length.saturating_add(bytes.len() as u64) > LIMIT as u64 {
        // Preserve no-delete history, but never let optional telemetry grow without a bound.
        if never_delete {
            return Err("telemetry full".into());
        }
        let tail_length = length.min(RETAINED as u64) as usize;
        file.seek(SeekFrom::End(-(tail_length as i64)))
            .map_err(|_| "telemetry seek")?;
        let mut tail = vec![0; tail_length];
        file.read_exact(&mut tail).map_err(|_| "telemetry read")?;
        let start = if length <= tail_length as u64 {
            0
        } else {
            tail.iter()
                .position(|b| *b == b'\n')
                .map_or(tail.len(), |n| n + 1)
        };
        let end = tail.iter().rposition(|b| *b == b'\n').map_or(0, |n| n + 1);
        file.seek(SeekFrom::Start(0))
            .map_err(|_| "telemetry seek")?;
        file.write_all(&tail[start.min(end)..end])
            .map_err(|_| "telemetry compact")?;
        file.set_len((end - start.min(end)) as u64)
            .map_err(|_| "telemetry truncate")?;
    }
    repair_tail(&mut file, never_delete)?;
    file.seek(SeekFrom::End(0)).map_err(|_| "telemetry seek")?;
    // No fsync: durable accounting stays in hook-health/stats. This log is best effort.
    file.write_all(&bytes)
        .map_err(|_| "telemetry append".into())
}

fn repair_tail(file: &mut File, never_delete: bool) -> Result<(), String> {
    let length = file.metadata().map_err(|_| "telemetry stat")?.len();
    if length == 0 {
        return Ok(());
    }
    file.seek(SeekFrom::End(-1)).map_err(|_| "telemetry seek")?;
    let mut last = [0];
    file.read_exact(&mut last).map_err(|_| "telemetry read")?;
    if last[0] == b'\n' {
        return Ok(());
    }
    if never_delete {
        if length >= (LIMIT - ROW_LIMIT) as u64 {
            return Err("telemetry full".into());
        }
        file.seek(SeekFrom::End(0)).map_err(|_| "telemetry seek")?;
        return file
            .write_all(b"\n")
            .map_err(|_| "telemetry delimiter".into());
    }
    let tail_length = length.min(ROW_LIMIT as u64) as usize;
    file.seek(SeekFrom::End(-(tail_length as i64)))
        .map_err(|_| "telemetry seek")?;
    let mut tail = vec![0; tail_length];
    file.read_exact(&mut tail).map_err(|_| "telemetry read")?;
    let end = match tail.iter().rposition(|b| *b == b'\n') {
        Some(n) => length - tail_length as u64 + n as u64 + 1,
        None if length <= ROW_LIMIT as u64 => 0,
        None => return Err("telemetry tail exceeds bound".into()),
    };
    file.set_len(end).map_err(|_| "telemetry truncate".into())
}
