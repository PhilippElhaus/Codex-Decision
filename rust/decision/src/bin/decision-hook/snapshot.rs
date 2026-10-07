//! Live batch panels and rollback on incomplete judgments.
use super::*;
#[path = "snapshot/encoding.rs"]
mod encoding;
pub(super) use encoding::prepare_line_snapshot;

#[allow(clippy::too_many_arguments)] // A complete immutable batch record is assembled here.
#[cfg(test)]
pub(super) fn line_snapshot(
    receipt_id: &str,
    snapshot_id: &str,
    route: &str,
    status: &str,
    lines: &[SourceLine],
    decisions: &[codex_decision::LineDecision],
    batch: &BatchRecord,
    batch_number: usize,
    batch_count: usize,
    classification_requests: usize,
) -> Value {
    let seen = lines.len();
    let judged = decisions
        .iter()
        .filter(|row| row.batch_id.is_some())
        .count();
    let omitted = decisions
        .iter()
        .filter(|row| row.action == Action::Omit)
        .count();
    let protected = decisions
        .iter()
        .filter(|row| row.protected_reason.is_some())
        .count();
    let rows: Vec<Value> = lines
        .iter()
        .zip(decisions)
        .map(|(line, decision)| {
            let mut units = 0usize;
            let end = line
                .model_text
                .char_indices()
                .find_map(|(index, character)| {
                    units += character.len_utf16();
                    (units > 120).then_some(index)
                })
                .unwrap_or(line.model_text.len());
            let excerpt = &line.model_text[..end];
            json!({"line":line.number,"excerpt":excerpt,
                "action":if decision.action == Action::Omit { "omit" } else { "keep" },
                "reason":decision.reason,"can_omit":decision.p_can_omit,
                "exact_needed":decision.p_exact_needed,"task_relevant":decision.p_task_relevant,
                "protected_reason":decision.protected_reason})
        })
        .collect();
    let unjudged = lines
        .iter()
        .zip(decisions)
        .filter(|(line, decision)| {
            line.eligible && line.protected_reason.is_none() && decision.batch_id.is_none()
        })
        .count();
    let mut snapshot = json!({"version":6,"id":snapshot_id,"receipt_id":receipt_id,"at":Utc::now().to_rfc3339(),
        "filter":route,"status":status,"batch":{"number":batch_number,"count":batch_count,
            "target_count":batch.target_numbers.len()},"rows":[],
        "totals":{"seen":seen,"judged":judged,"kept":seen-omitted,"omitted":omitted,
            "protected":protected,"unjudged":unjudged,"requests":batch_number + classification_requests,
            "classification_requests":classification_requests},
        "batch_elapsed_ms":batch.elapsed_ms});
    snapshot["rows"] = Value::Array(rows);
    snapshot
}

pub(super) struct ProgressSnapshot {
    logs: PathBuf,
    receipt_id: String,
    previous: Option<Vec<u8>>,
    pub(super) last_snapshot_id: String,
    pub(super) active: bool,
    pub(super) last_published: Option<Instant>,
    pub(super) classification_requests: usize,
}

// Only the ownership fields are needed while the log lock is held. Skipping
// the rows avoids allocating a second complete panel just to inspect its owner.
#[derive(Deserialize, Default)]
struct SnapshotOwner {
    receipt_id: Option<String>,
    status: Option<String>,
}

impl ProgressSnapshot {
    pub(super) fn new(data_dir: &Path, receipt_id: String) -> Result<Self, String> {
        let logs = data_dir.join("logs");
        ensure_dir(&logs)?;
        let path = logs.join("latest-decision.json");
        if path.is_symlink() {
            return Err("linked panel snapshot".into());
        }
        match fs::symlink_metadata(&path) {
            Ok(metadata)
                if !metadata.is_file() || metadata.len() > PANEL_SNAPSHOT_MAX_BYTES as u64 =>
            {
                return Err("unsafe panel snapshot".into());
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err("panel snapshot stat".into());
            }
            _ => {}
        }
        Ok(Self {
            logs,
            receipt_id,
            previous: None,
            // A concurrent hook may own the live panel throughout this run.
            // Its final receipt still needs a valid, independent snapshot ID.
            last_snapshot_id: Uuid::new_v4().simple().to_string(),
            active: false,
            last_published: None,
            classification_requests: 1,
        })
    }

    pub(super) fn should_publish(
        &self,
        line_count: usize,
        batch_number: usize,
        batch_count: usize,
    ) -> bool {
        // Large cumulative panels otherwise rebuild thousands of unchanged rows
        // for each fast API batch. Always publish the first and final batches.
        line_count < 1000
            || batch_number == batch_count
            || self
                .last_published
                .is_none_or(|last| last.elapsed() >= Duration::from_secs(1))
    }

    pub(super) fn publish(
        &mut self,
        route: &str,
        lines: &[SourceLine],
        decisions: &[codex_decision::LineDecision],
        batch: &BatchRecord,
        batch_number: usize,
        batch_count: usize,
    ) -> Result<(), String> {
        // Row assembly is immutable work. Keep it outside the session lock;
        // ownership, rollback state and publication time remain locked below.
        let id = Uuid::new_v4().simple().to_string();
        let snapshot = prepare_line_snapshot(
            &self.receipt_id,
            &id,
            route,
            "processing",
            lines,
            decisions,
            batch,
            batch_number,
            batch_count,
            self.classification_requests,
        )?;
        let _lock = lock_logs(&self.logs)?;
        let path = self.logs.join("latest-decision.json");
        let current = private_backup(&path, PANEL_SNAPSHOT_MAX_BYTES)?;
        let owner = current
            .as_deref()
            .and_then(|bytes| serde_json::from_slice::<SnapshotOwner>(bytes).ok())
            .unwrap_or_default();
        if owner.receipt_id.as_deref() != Some(&self.receipt_id) {
            // Do not replace another in-flight hook's panel or retain it as a
            // rollback target. That hook may fail before we need to roll back.
            if owner.status.as_deref() == Some("processing") {
                self.last_published = Some(Instant::now());
                return Ok(());
            }
            // Capture the newest completed state at publication time, under
            // the lock, including completions that arrived between batches.
            self.previous = current;
        }
        let bytes = snapshot.finish(&Utc::now().to_rfc3339())?;
        remaining()?;
        write_private(&path, &bytes, true)?;
        self.last_snapshot_id = id;
        self.active = true;
        self.last_published = Some(Instant::now());
        Ok(())
    }
}

impl Drop for ProgressSnapshot {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let Ok(_lock) = cleanup_log_lock(&self.logs) else {
            return;
        };
        let path = self.logs.join("latest-decision.json");
        let current = private_backup(&path, PANEL_SNAPSHOT_MAX_BYTES)
            .ok()
            .flatten()
            .and_then(|bytes| serde_json::from_slice::<SnapshotOwner>(&bytes).ok());
        if current
            .as_ref()
            .and_then(|owner| owner.receipt_id.as_deref())
            != Some(self.receipt_id.as_str())
        {
            return;
        }
        if let Some(previous) = &self.previous {
            let _ = write_private(&path, previous, true);
        } else {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod excerpt_tests {
    use super::*;
    #[test]
    fn excerpts_keep_the_same_unicode_scalar_and_utf16_boundaries() {
        for text in [
            "a".repeat(300),
            "🌍".repeat(100),
            "λ🌍x".repeat(100),
            "状态\r\n".repeat(50),
        ] {
            let lines = source_lines(&text);
            let probabilities = lines.iter().map(|line| (line.number, (0.01, 1))).collect();
            let decisions = apply_relevance_batches(&lines, &probabilities, 5);
            let batch = BatchRecord {
                id: 1,
                target_numbers: vec![1],
                request: json!({}),
                response: json!({}),
                elapsed_ms: 1,
            };
            let snapshot = line_snapshot(
                "receipt",
                "snapshot",
                "output",
                "processing",
                &lines,
                &decisions,
                &batch,
                1,
                1,
                0,
            );
            for (line, row) in lines.iter().zip(snapshot["rows"].as_array().unwrap()) {
                let expected: String = line
                    .model_text
                    .chars()
                    .scan(0usize, |units, ch| {
                        *units += ch.len_utf16();
                        (*units <= 120).then_some(ch)
                    })
                    .collect();
                assert_eq!(row["excerpt"], expected);
            }
        }
    }
}
