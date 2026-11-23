//! Read a committed counter image without modifying pending transactions.
use super::*;
use codex_decision::publication_contract::{
    parse_stats, Image, PublicationJournal, EVENT_LIMIT, GENERATION_BYTES, GENERATION_NAME,
    JOURNAL_LIMIT, JOURNAL_NAME,
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
            || codex_decision::is_link(metadata)
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
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "activity publication open")?;
    #[cfg(windows)]
    if strict {
        codex_decision::windows::private(&file, 1)?;
    }
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

fn generation(directory: &Path) -> Result<Option<Vec<u8>>, String> {
    let Some(record) = load(
        &directory.join("logs").join(GENERATION_NAME),
        GENERATION_BYTES,
        true,
        None,
    )?
    else {
        return Ok(None);
    };
    if record.bytes.len() != GENERATION_BYTES
        || !record
            .bytes
            .iter()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("invalid activity publication generation".into());
    }
    Ok(Some(record.bytes))
}

fn retained_stats(directory: &Path, cutoff: Option<u64>) -> Result<Value, String> {
    let event_path = directory.join("logs/events.jsonl");
    let size = match fs::symlink_metadata(&event_path) {
        Ok(metadata) if metadata.is_file() && !codex_decision::is_link(&metadata) => {
            cutoff.map_or(metadata.len(), |cutoff| cutoff.min(metadata.len()))
        }
        Ok(_) => return Err("unsafe retained event file".into()),
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
    codex_decision::activity_counters::retained_stats_from_events(&events.bytes, start > 0)
}

fn unjournaled_stats(directory: &Path, current: Option<Record>) -> Result<(Value, bool), String> {
    if let Some(record) = current {
        Ok((parse_stats(&record.bytes)?, true))
    } else {
        Ok((retained_stats(directory, None)?, false))
    }
}

pub(super) fn read_stats(directory: &Path) -> Result<Value, String> {
    read_stats_with(directory, || {})
}

fn read_stats_with(directory: &Path, after_sample: impl Fn()) -> Result<Value, String> {
    read_ledger_with(directory, false, after_sample).map(|(value, _)| value)
}

pub(super) fn read_view_stats(directory: &Path) -> Result<(Value, bool), String> {
    read_ledger_with(directory, true, || {})
}

fn read_ledger_with(
    directory: &Path,
    view: bool,
    after_sample: impl Fn(),
) -> Result<(Value, bool), String> {
    for _ in 0..2 {
        let epoch = generation(directory)?;
        let before = pending(directory)?;
        let result = (|| -> Result<(Value, bool), String> {
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
                return unjournaled_stats(directory, current);
            };
            let post = current
                .as_ref()
                .is_some_and(|record| journal.next_stats.matches(&record.bytes));
            if journal.state == "committed" {
                if !post {
                    return Err("activity committed stats changed".into());
                }
                return Ok((parse_stats(&current.unwrap().bytes)?, true));
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
            match prior {
                Some(bytes) => Ok((parse_stats(bytes)?, true)),
                None if view => Ok((
                    retained_stats(directory, Some(journal.event_offset))?,
                    false,
                )),
                None => Ok((json!({}), false)),
            }
        })();
        after_sample();
        let after = pending(directory)?;
        if same(&before, &after) && generation(directory)? == epoch {
            if before.is_none() && result.is_ok() {
                let current = load(&directory.join("stats.json"), 8192, false, None)?;
                let second = unjournaled_stats(directory, current);
                if second != result
                    || pending(directory)?.is_some()
                    || generation(directory)? != epoch
                {
                    continue;
                }
            }
            return result;
        }
    }
    Err("activity publication changed while being read".into())
}

#[cfg(test)]
#[path = "publication_tests.rs"]
mod tests;
