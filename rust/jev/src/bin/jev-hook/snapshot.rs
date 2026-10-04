//! Live batch panels and rollback on incomplete judgments.
use super::*;

#[allow(clippy::too_many_arguments)] // A complete immutable batch record is assembled here.
pub(super) fn line_snapshot(
    receipt_id: &str,
    snapshot_id: &str,
    route: &str,
    status: &str,
    lines: &[SourceLine],
    decisions: &[codex_jev::LineDecision],
    batch: &BatchRecord,
    batch_number: usize,
    batch_count: usize,
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
            let excerpt: String = line
                .model_text
                .chars()
                .scan(0usize, |units, character| {
                    *units += character.len_utf16();
                    (*units <= 120).then_some(character)
                })
                .collect();
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
    json!({"version":5,"id":snapshot_id,"receipt_id":receipt_id,"at":Utc::now().to_rfc3339(),
        "filter":route,"status":status,"batch":{"number":batch_number,"count":batch_count,
            "target_count":batch.target_numbers.len()},"rows":rows,
        "totals":{"seen":seen,"judged":judged,"kept":seen-omitted,"omitted":omitted,
            "protected":protected,"unjudged":unjudged,"requests":batch_number + 1},
        "batch_elapsed_ms":batch.elapsed_ms})
}

pub(super) struct ProgressSnapshot {
    logs: PathBuf,
    receipt_id: String,
    previous: Option<Vec<u8>>,
    pub(super) last_snapshot_id: String,
    pub(super) active: bool,
    pub(super) last_published: Option<Instant>,
}

impl ProgressSnapshot {
    pub(super) fn new(data_dir: &Path, receipt_id: String) -> Result<Self, String> {
        let logs = data_dir.join("logs");
        ensure_dir(&logs)?;
        let path = logs.join("latest-decision.json");
        if path.is_symlink() {
            return Err("linked panel snapshot".into());
        }
        let previous = match fs::read(&path) {
            Ok(bytes) if bytes.len() <= PANEL_SNAPSHOT_MAX_BYTES => Some(bytes),
            Ok(_) => return Err("panel snapshot too large".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("panel snapshot read failed".into()),
        };
        Ok(Self {
            logs,
            receipt_id,
            previous,
            last_snapshot_id: String::new(),
            active: false,
            last_published: None,
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
        decisions: &[codex_jev::LineDecision],
        batch: &BatchRecord,
        batch_number: usize,
        batch_count: usize,
    ) -> Result<(), String> {
        let _lock = lock_logs(&self.logs)?;
        let id = Uuid::new_v4().simple().to_string();
        let snapshot = line_snapshot(
            &self.receipt_id,
            &id,
            route,
            "processing",
            lines,
            decisions,
            batch,
            batch_number,
            batch_count,
        );
        let bytes = serde_json::to_vec(&snapshot).map_err(|_| "snapshot encoding")?;
        if bytes.len() > PANEL_SNAPSHOT_MAX_BYTES {
            return Err("panel snapshot too large".into());
        }
        write_private(&self.logs.join("latest-decision.json"), &bytes, true)?;
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
        let current = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        if current
            .as_ref()
            .and_then(|value| value.get("receipt_id"))
            .and_then(Value::as_str)
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
