//! Read a committed counter image without modifying pending transactions.
use super::*;
use codex_decision::publication_contract::{
    parse_stats, Image, PublicationJournal, EVENT_LIMIT, JOURNAL_LIMIT, JOURNAL_NAME,
};
use std::io::{Seek, SeekFrom};

struct Record {
    bytes: Vec<u8>,
    fingerprint: String,
    size: u64,
}
struct Pending {
    journal: PublicationJournal,
    record: Record,
}

fn load(
    path: &Path,
    limit: usize,
    strict: bool,
    range: Option<(u64, usize)>,
) -> Result<Option<Record>, String> {
    codex_decision::check_ancestors(path.parent().ok_or("invalid publication scope")?)?;
    let metadata = match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("activity publication stat".into()),
        Ok(metadata) => metadata,
    };
    let check = |metadata: &fs::Metadata| -> Result<(), String> {
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || range.is_none() && metadata.len() > limit as u64
        {
            return Err("unsafe activity publication file".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            // SAFETY: geteuid reads the current process's effective user ID.
            if strict
                && (metadata.uid() != unsafe { libc::geteuid() }
                    || metadata.permissions().mode() & 0o077 != 0
                    || metadata.nlink() != 1)
            {
                return Err("unsafe activity publication file".into());
            }
        }
        Ok(())
    };
    check(&metadata)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "activity publication open")?;
    let opened = file.metadata().map_err(|_| "activity publication stat")?;
    check(&opened)?;
    let fingerprint = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            format!(
                "{}:{}:{}:{}:{}:{}:{}",
                opened.dev(),
                opened.ino(),
                opened.len(),
                opened.mtime(),
                opened.mtime_nsec(),
                opened.ctime(),
                opened.ctime_nsec()
            )
        }
        #[cfg(not(unix))]
        {
            format!(
                "{}:{:?}:{:?}",
                opened.len(),
                opened.modified().ok(),
                opened.created().ok()
            )
        }
    };
    let (offset, length) = range.unwrap_or((0, limit + 1));
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| "activity publication seek")?;
    let mut bytes = Vec::new();
    file.take(length as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "activity publication read")?;
    if range.is_none() && bytes.len() > limit {
        return Err("activity publication too large".into());
    }
    Ok(Some(Record {
        bytes,
        fingerprint,
        size: opened.len(),
    }))
}

fn pending(directory: &Path) -> Result<Option<Pending>, String> {
    load(
        &directory.join("logs").join(JOURNAL_NAME),
        JOURNAL_LIMIT,
        true,
        None,
    )?
    .map(|record| {
        PublicationJournal::parse(&record.bytes).map(|journal| Pending { journal, record })
    })
    .transpose()
}

fn same(before: &Option<Pending>, after: &Option<Pending>) -> bool {
    match (before, after) {
        (None, None) => true,
        (Some(before), Some(after)) => {
            before.record.fingerprint == after.record.fingerprint
                && before.record.bytes == after.record.bytes
        }
        _ => false,
    }
}

pub(super) fn read_stats(directory: &Path) -> Result<Value, String> {
    for _ in 0..2 {
        let before = pending(directory)?;
        let result = (|| -> Result<Value, String> {
            let journal = before.as_ref().map(|value| &value.journal);
            if let Some(journal) = journal {
                let bytes = journal.commit_event.as_bytes();
                let event = load(
                    &directory.join("logs/events.jsonl"),
                    EVENT_LIMIT + 1,
                    true,
                    Some((journal.event_offset, bytes.len() + 1)),
                )?
                .ok_or("activity publication event missing")?;
                let tail = event
                    .size
                    .checked_sub(journal.event_offset)
                    .ok_or("activity publication event changed")?;
                if tail > bytes.len() as u64
                    || event.bytes.len() > bytes.len()
                    || !bytes.starts_with(&event.bytes)
                    || journal.state == "committed"
                        && (tail != bytes.len() as u64 || event.bytes != bytes)
                {
                    return Err("activity publication event changed".into());
                }
            }
            let current = load(&directory.join("stats.json"), 8192, journal.is_some(), None)?;
            let Some(journal) = journal else {
                if let Some(record) = current {
                    return parse_stats(&record.bytes);
                }
                let event_path = directory.join("logs/events.jsonl");
                let size = match fs::symlink_metadata(&event_path) {
                    Ok(metadata) => metadata.len(),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(json!({})),
                    Err(_) => return Err("activity retained event stat".into()),
                };
                if size == 0 {
                    return Ok(json!({}));
                }
                let start = size.saturating_sub(1_048_576);
                let events = load(
                    &event_path,
                    1_048_576,
                    false,
                    Some((start, (size - start) as usize)),
                )?
                .ok_or("activity retained events missing")?;
                return codex_decision::activity_counters::retained_stats_from_events(
                    &events.bytes,
                    start > 0,
                );
            };
            let post = current
                .as_ref()
                .is_some_and(|record| journal.next_stats.matches(&record.bytes));
            if journal.state == "committed" {
                if !post {
                    return Err("activity committed stats changed".into());
                }
                return parse_stats(&current.unwrap().bytes);
            }
            let prior = journal.prior_stats.as_deref().map(str::as_bytes);
            let pre = match (&current, prior) {
                (None, None) => true,
                (Some(record), Some(bytes)) => Image::of(bytes).matches(&record.bytes),
                _ => false,
            };
            if !pre && !post {
                return Err("activity pending stats changed".into());
            }
            prior.map_or(Ok(json!({})), parse_stats)
        })();
        let after = pending(directory)?;
        if same(&before, &after) {
            return result;
        }
    }
    Err("activity publication changed while being read".into())
}

#[cfg(test)]
#[path = "publication_tests.rs"]
mod tests;
