//! Recover process-killed publications before a producer mutates session state.
use super::*;
pub(crate) use codex_decision::publication_contract::{Artifact, Image};
use codex_decision::publication_contract::{
    PublicationJournal as Journal, JOURNAL_LIMIT, JOURNAL_NAME,
};

#[path = "journal/files.rs"]
mod files;
#[path = "journal/recovery.rs"]
mod recovery;
pub(crate) use recovery::recover;

pub(crate) struct Publication {
    logs: PathBuf,
}

impl Publication {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn begin(
        data_dir: &Path,
        folder_name: &str,
        receipt_id: &str,
        prior_stats: Option<Vec<u8>>,
        next_stats: &[u8],
        snapshot: Option<(Option<Vec<u8>>, &[u8])>,
        artifacts: Vec<Artifact>,
        event_offset: u64,
        event_bytes: &[u8],
    ) -> Result<Self, String> {
        let logs = data_dir.join("logs");
        let (prior_snapshot, next_snapshot, backup) = match snapshot {
            Some((prior, next)) => (
                prior.as_deref().map(Image::of),
                Some(Image::of(next)),
                prior,
            ),
            None => (None, None, None),
        };
        let journal = Journal {
            version: 1,
            state: "prepared".into(),
            receipt_id: receipt_id.into(),
            folder: folder_name.into(),
            event_offset,
            commit_event: String::from_utf8(event_bytes.to_vec())
                .map_err(|_| "publication event encoding")?,
            commit_sha256: format!("{:x}", Sha256::digest(event_bytes)),
            prior_stats: prior_stats
                .map(String::from_utf8)
                .transpose()
                .map_err(|_| "publication stats encoding")?,
            next_stats: Image::of(next_stats),
            prior_snapshot,
            next_snapshot,
            artifacts,
        };
        journal.validate()?;
        let mut commit_check = journal.clone();
        commit_check.state = "committed".into();
        commit_check.validate()?;
        let encoded = serde_json::to_vec(&journal).map_err(|_| "publication journal encoding")?;
        if encoded.len() > JOURNAL_LIMIT {
            return Err("publication journal too large".into());
        }
        expect_prior(
            &data_dir.join("stats.json"),
            journal.prior_stats.as_deref().map(str::as_bytes),
            8192,
        )?;
        if journal.next_snapshot.is_some() {
            expect_prior(
                &logs.join("latest-decision.json"),
                backup.as_deref(),
                PANEL_SNAPSHOT_MAX_BYTES,
            )?;
        }
        let event = files::Lease::open(&logs.join("events.jsonl"), true, 1)?
            .ok_or("publication event missing")?;
        if event.size()? != event_offset {
            return Err("publication event changed".into());
        }
        // Prove the cap and absence of collision targets before any mutation.
        for artifact in &journal.artifacts {
            absent(
                &logs.join(&journal.folder).join(&artifact.name),
                "original already exists",
            )?;
        }
        absent(&journal.backup(&logs), "publication backup exists")?;
        write_private(&logs.join(JOURNAL_NAME), &encoded, false)?;
        if let Some(bytes) = backup {
            if let Err(error) = write_private(&journal.backup(&logs), &bytes, false) {
                recover(&logs)?;
                return Err(error);
            }
        }
        Ok(Self { logs })
    }

    pub(crate) fn rollback(&self) -> Result<(), String> {
        recovery::rollback(&self.logs)
    }

    pub(crate) fn commit(&self) -> Result<(), String> {
        recovery::mark_committed(&self.logs)
    }

    // The marker is already committed. Cleanup cannot cancel the output and
    // retention must wait until all journal/backup cleanup has completed.
    pub(crate) fn committed(&self) -> bool {
        let result = recovery::finalize(&self.logs);
        if let Err(error) = result {
            eprintln!("Codex Decision publication cleanup deferred: {error}");
        }
        matches!(fs::symlink_metadata(self.logs.join(JOURNAL_NAME)), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    }
}

fn absent(path: &Path, collision: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(collision.into()),
        Err(_) => Err("publication file stat".into()),
    }
}

fn expect_prior(path: &Path, prior: Option<&[u8]>, limit: usize) -> Result<(), String> {
    match (files::Lease::open(path, false, 1)?, prior) {
        (None, None) => Ok(()),
        (Some(mut lease), Some(bytes)) => {
            if bytes.len() <= limit && lease.matches(&Image::of(bytes))? {
                Ok(())
            } else {
                Err("publication image changed".into())
            }
        }
        _ => Err("publication image changed".into()),
    }
}

#[cfg(test)]
#[path = "journal/tests.rs"]
mod tests;
