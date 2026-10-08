//! Bounded, path-free metadata for recoverable publication transactions.
use crate::strict_json;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const JOURNAL_NAME: &str = ".decision-publication.json";
pub const JOURNAL_LIMIT: usize = 128 * 1024;
pub const EVENT_LIMIT: usize = 32 * 1024;
pub const STATS_LIMIT: usize = 8192;
pub const SNAPSHOT_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Image {
    pub bytes: usize,
    pub sha256: String,
}

impl Image {
    pub fn of(bytes: &[u8]) -> Self {
        Self {
            bytes: bytes.len(),
            sha256: digest(bytes),
        }
    }
    pub fn matches(&self, bytes: &[u8]) -> bool {
        self.bytes == bytes.len() && self.sha256 == digest(bytes)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub name: String,
    pub bytes: usize,
    pub sha256: String,
}

impl Artifact {
    pub fn image(&self) -> Image {
        Image {
            bytes: self.bytes,
            sha256: self.sha256.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublicationJournal {
    pub version: u8,
    pub state: String,
    pub receipt_id: String,
    pub folder: String,
    pub event_offset: u64,
    pub commit_event: String,
    pub commit_sha256: String,
    pub prior_stats: Option<String>,
    pub next_stats: Image,
    pub prior_snapshot: Option<Image>,
    pub next_snapshot: Option<Image>,
    pub artifacts: Vec<Artifact>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn parse_stats(bytes: &[u8]) -> Result<serde_json::Value, String> {
    if bytes.len() > STATS_LIMIT {
        return Err("invalid publication stats".into());
    }
    let value = strict_json::parse(bytes).map_err(|_| "invalid publication stats")?;
    crate::activity_counters::validate_stats_counters(&value)?;
    Ok(value)
}

impl PublicationJournal {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > JOURNAL_LIMIT {
            return Err("publication journal too large".into());
        }
        let value = strict_json::parse(bytes).map_err(|_| "invalid publication journal")?;
        const FIELDS: &[&str] = &[
            "version",
            "state",
            "receipt_id",
            "folder",
            "event_offset",
            "commit_event",
            "commit_sha256",
            "prior_stats",
            "next_stats",
            "prior_snapshot",
            "next_snapshot",
            "artifacts",
        ];
        if value.as_object().is_none_or(|object| {
            object.len() != FIELDS.len() || FIELDS.iter().any(|field| !object.contains_key(*field))
        }) {
            return Err("invalid publication journal fields".into());
        }
        let record: Self =
            serde_json::from_value(value).map_err(|_| "invalid publication journal")?;
        record.validate()?;
        Ok(record)
    }

    pub fn backup(&self, logs: &Path) -> PathBuf {
        logs.join(format!(
            ".decision-publication-{}.snapshot-before",
            self.receipt_id
        ))
    }

    pub fn validate(&self) -> Result<(), String> {
        let image = |value: &Image, limit| value.bytes <= limit && hex(&value.sha256, 64);
        let folder = self.folder.as_bytes();
        if self.version != 1
            || !matches!(self.state.as_str(), "prepared" | "committed")
            || !hex(&self.receipt_id, 32)
            || folder.len() != 21
            || folder[4] != b'-'
            || folder[7] != b'-'
            || folder[10] != b'-'
            || !folder[..10]
                .iter()
                .enumerate()
                .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
            || chrono::NaiveDate::parse_from_str(&self.folder[..10], "%Y-%m-%d").is_err()
            || !hex(&self.folder[11..], 10)
            || self.event_offset > 9_007_199_254_740_991
            || self
                .event_offset
                .checked_add(self.commit_event.len() as u64)
                .is_none_or(|offset| offset > 9_007_199_254_740_991)
            || self.commit_event.len() > EVENT_LIMIT
            || !self.commit_event.ends_with('\n')
            || strict_json::parse(self.commit_event.as_bytes()).is_err()
            || self.commit_sha256 != digest(self.commit_event.as_bytes())
            || !image(&self.next_stats, STATS_LIMIT)
            || self
                .prior_snapshot
                .as_ref()
                .is_some_and(|value| !image(value, SNAPSHOT_LIMIT))
            || self
                .next_snapshot
                .as_ref()
                .is_some_and(|value| !image(value, SNAPSHOT_LIMIT))
            || self.next_snapshot.is_none() && self.prior_snapshot.is_some()
        {
            return Err("invalid publication journal".into());
        }
        if let Some(stats) = &self.prior_stats {
            if stats.len() > STATS_LIMIT {
                return Err("invalid publication stats".into());
            }
            parse_stats(stats.as_bytes())?;
        }
        let mut names = std::collections::BTreeSet::new();
        for artifact in &self.artifacts {
            let receipt = artifact.name == format!("receipt-{}.json", self.receipt_id);
            let batch = artifact
                .name
                .strip_prefix(&format!("batch-{}-", self.receipt_id))
                .and_then(|value| value.strip_suffix(".json"))
                .and_then(|value| {
                    value
                        .parse::<usize>()
                        .ok()
                        .filter(|number| *number <= 10_000 && number.to_string() == value)
                });
            if !receipt && batch.is_none()
                || !names.insert(&artifact.name)
                || !image(
                    &artifact.image(),
                    if receipt {
                        SNAPSHOT_LIMIT
                    } else {
                        2 * 1024 * 1024
                    },
                )
            {
                return Err("invalid publication artifact".into());
            }
        }
        if serde_json::to_vec(self)
            .map_err(|_| "publication journal encoding")?
            .len()
            > JOURNAL_LIMIT
        {
            return Err("publication journal too large".into());
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "publication_contract_tests.rs"]
mod tests;
