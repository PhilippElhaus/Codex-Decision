//! Validate every known image before recovering a killed locked producer.
use super::*;
use files::Lease;

pub(crate) fn recover(logs: &Path) -> Result<(), String> {
    let _budget = files::Budget::new();
    let Some((journal, lease)) = load(logs)? else {
        return Ok(());
    };
    resolve(logs, journal, lease, false, false)
}

pub(super) fn finalize(logs: &Path) -> Result<(), String> {
    let _budget = files::Budget::new();
    let (journal, lease) = load(logs)?.ok_or("publication journal missing")?;
    resolve(logs, journal, lease, true, false)
}

pub(super) fn rollback(logs: &Path) -> Result<(), String> {
    let _budget = files::Budget::new();
    let (journal, lease) = load(logs)?.ok_or("publication journal missing")?;
    resolve(logs, journal, lease, false, true)
}

pub(super) fn mark_committed(logs: &Path) -> Result<(), String> {
    let _budget = files::Budget::new();
    let (mut journal, lease) = load(logs)?.ok_or("publication journal missing")?;
    if journal.state != "prepared" {
        return Err("publication already committed".into());
    }
    let data = logs.parent().ok_or("invalid publication directory")?;
    let prior = journal
        .prior_stats
        .as_deref()
        .map(str::as_bytes)
        .map(Image::of);
    if !image_state(
        &data.join("stats.json"),
        prior.as_ref(),
        &journal.next_stats,
        8192,
    )?
    .post
    {
        return Err("publication postimage missing".into());
    }
    if let Some(next) = &journal.next_snapshot {
        if !image_state(
            &logs.join("latest-decision.json"),
            journal.prior_snapshot.as_ref(),
            next,
            PANEL_SNAPSHOT_MAX_BYTES,
        )?
        .post
        {
            return Err("publication postimage missing".into());
        }
    }
    if let Some(prior) = &journal.prior_snapshot {
        let mut backup =
            Lease::open(&journal.backup(logs), false, 1)?.ok_or("publication backup missing")?;
        if !backup.matches(prior)? {
            return Err("publication backup changed".into());
        }
    }
    let _artifacts = artifacts(logs, &journal, true)?;
    let mut event =
        Lease::open(&logs.join("events.jsonl"), true, 1)?.ok_or("publication event missing")?;
    if !event.event_tail(journal.event_offset, journal.commit_event.as_bytes())? {
        return Err("publication event incomplete".into());
    }
    event.sync()?;
    journal.state = "committed".into();
    journal.validate()?;
    let bytes = serde_json::to_vec(&journal).map_err(|_| "publication journal encoding")?;
    lease.verify()?;
    remaining()?;
    // This atomic marker is the final fallible publication operation.
    write_private(&logs.join(JOURNAL_NAME), &bytes, true)
}

fn load(logs: &Path) -> Result<Option<(Journal, Lease)>, String> {
    let Some(mut lease) = Lease::open(&logs.join(JOURNAL_NAME), false, 1)? else {
        return Ok(None);
    };
    let bytes = lease.bytes(JOURNAL_LIMIT)?;
    let journal = Journal::parse(&bytes)?;
    Ok(Some((journal, lease)))
}

fn resolve(
    logs: &Path,
    journal: Journal,
    journal_lease: Lease,
    require_commit: bool,
    force_rollback: bool,
) -> Result<(), String> {
    let data = logs.parent().ok_or("invalid publication directory")?;
    let stats_path = data.join("stats.json");
    let snapshot_path = logs.join("latest-decision.json");
    let prior_stats = journal.prior_stats.as_deref().map(str::as_bytes);
    let stats = image_state(
        &stats_path,
        prior_stats.map(Image::of).as_ref(),
        &journal.next_stats,
        8192,
    )?;
    let snapshot = match &journal.next_snapshot {
        Some(next) => Some(image_state(
            &snapshot_path,
            journal.prior_snapshot.as_ref(),
            next,
            PANEL_SNAPSHOT_MAX_BYTES,
        )?),
        None => None,
    };
    let mut backup = Lease::open(&journal.backup(logs), false, 1)?;
    if let Some(lease) = &mut backup {
        let expected = journal
            .prior_snapshot
            .as_ref()
            .ok_or("unexpected publication backup")?;
        if !lease.matches(expected)? {
            return Err("publication backup changed".into());
        }
    }
    let prior_snapshot = if journal.state == "committed" {
        None
    } else {
        match (&journal.prior_snapshot, &snapshot) {
            (Some(image), Some(state)) => {
                if let Some(lease) = &mut backup {
                    Some(lease.bytes(PANEL_SNAPSHOT_MAX_BYTES)?)
                } else if !state.post {
                    let mut lease = Lease::open(&snapshot_path, false, 1)?
                        .ok_or("publication snapshot missing")?;
                    let bytes = lease.bytes(PANEL_SNAPSHOT_MAX_BYTES)?;
                    if !image.matches(&bytes) {
                        return Err("publication snapshot changed".into());
                    }
                    Some(bytes)
                } else {
                    return Err("publication backup missing".into());
                }
            }
            _ => None,
        }
    };
    let mut event =
        Lease::open(&logs.join("events.jsonl"), true, 1)?.ok_or("publication event missing")?;
    let complete = event.event_tail(journal.event_offset, journal.commit_event.as_bytes())?;
    if force_rollback && journal.state == "committed" {
        return Err("publication already committed".into());
    }
    let committed = journal.state == "committed" && !force_rollback;
    if (journal.state == "committed" || require_commit) && (!committed || !complete) {
        return Err("publication commit changed".into());
    }
    let (artifacts, pending) = artifacts(logs, &journal, committed)?;
    if committed {
        if !stats.post || snapshot.as_ref().is_some_and(|s| !s.post) {
            return Err("publication committed images changed".into());
        }
        // The marker was published only after every image and event fsync.
        event.sync()?;
        for lease in &pending {
            lease.remove()?;
        }
    } else {
        // Unknown mutations have already been rejected. Every intermediate
        // recovery image remains a recognized preimage/postimage after a kill.
        if let Some(bytes) = prior_stats {
            write_private(&stats_path, bytes, true)?;
        } else if let Some(lease) = stats.lease {
            lease.remove()?;
        }
        if snapshot.is_some() {
            if let Some(bytes) = prior_snapshot {
                write_private(&snapshot_path, &bytes, true)?;
            } else if let Some(lease) = snapshot.and_then(|s| s.lease) {
                lease.remove()?;
            }
        }
        event.truncate(journal.event_offset)?;
        for lease in &artifacts {
            lease.remove()?;
        }
        for lease in &pending {
            lease.remove()?;
        }
    }
    if let Some(lease) = backup {
        lease.remove()?;
    }
    journal_lease.remove()?;
    Ok(())
}

struct State {
    post: bool,
    lease: Option<Lease>,
}

fn image_state(
    path: &Path,
    prior: Option<&Image>,
    post: &Image,
    limit: usize,
) -> Result<State, String> {
    let lease = Lease::open(path, false, 1)?;
    let Some(mut lease) = lease else {
        if prior.is_none() {
            return Ok(State {
                post: false,
                lease: None,
            });
        }
        return Err("publication image missing".into());
    };
    if lease.matches(post)? {
        return Ok(State {
            post: true,
            lease: Some(lease),
        });
    }
    if let Some(prior) = prior {
        if prior.bytes <= limit && lease.matches(prior)? {
            return Ok(State {
                post: false,
                lease: Some(lease),
            });
        }
    }
    Err("publication image changed".into())
}

fn artifacts(
    logs: &Path,
    journal: &Journal,
    committed: bool,
) -> Result<(Vec<Lease>, Vec<Lease>), String> {
    let folder = logs.join(&journal.folder);
    check_dir_if_exists(&folder)?;
    let mut published = Vec::new();
    let mut pending = Vec::new();
    for artifact in &journal.artifacts {
        let path = folder.join(&artifact.name);
        let batch_number = artifact
            .name
            .strip_prefix(&format!("batch-{}-", journal.receipt_id))
            .and_then(|s| s.strip_suffix(".json"));
        let staged = if let Some(number) = batch_number {
            let source = logs.join(format!(
                ".jev-batch-{}-{number}.pending",
                journal.receipt_id
            ));
            let mut lease = Lease::open(&source, false, 2)?;
            if let Some(lease) = &mut lease {
                if !lease.matches(&artifact.image())? {
                    return Err("publication staged artifact changed".into());
                }
            }
            lease
        } else {
            None
        };
        if let Some(mut lease) =
            Lease::open(&path, false, if batch_number.is_some() { 2 } else { 1 })?
        {
            if !lease.matches(&artifact.image())? {
                return Err("publication artifact changed".into());
            }
            if lease.links()? == 2
                && !staged
                    .as_ref()
                    .is_some_and(|source| source.same_inode(&lease).unwrap_or(false))
            {
                return Err("publication artifact linked".into());
            }
            published.push(lease);
        } else if committed {
            return Err("publication artifact missing".into());
        }
        if let Some(lease) = staged {
            pending.push(lease);
        }
    }
    Ok((published, pending))
}
