//! Inspect one session's aggregate evidence without reading raw receipts.
use super::*;

pub(super) fn summarize(data: &Path, session: &str) -> Result<Value, String> {
    if !data.is_absolute() || session.is_empty() || session.len() > 4096 {
        return Err("invalid activity scope".into());
    }
    let hash = format!("{:x}", Sha256::digest(session.as_bytes()));
    let root = data.join("sessions").join(&hash);
    codex_jev::check_ancestors(&root)?;
    let load = |path: PathBuf, limit| -> Result<Value, String> {
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(json!({})),
            Err(_) => Err("activity stat failed".into()),
            Ok(_) => read_json(&path, limit),
        }
    };
    let stats = load(root.join("stats.json"), 8192)?;
    let health = load(root.join("logs/hook-health.json"), 4096)?;
    if !stats.is_object()
        || stats
            .as_object()
            .unwrap()
            .values()
            .any(|v| v.as_u64().is_none())
        || !health.is_object()
    {
        return Err("invalid activity counters".into());
    }
    let counts = health.get("skip_counts").cloned().unwrap_or(json!({}));
    if !counts.is_object()
        || counts.as_object().unwrap().iter().any(|(reason, count)| {
            reason.len() > 80
                || !reason.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                || count.as_u64().is_none()
        })
    {
        return Err("invalid activity skip counters".into());
    }
    let candidate_reasons: serde_json::Map<String, Value> = [
        "observe",
        "missing_task_context",
        "unsupported_command",
        "mcp_replacement_disabled",
        "unsupported_envelope",
        "insufficient_savings",
    ]
    .iter()
    .filter_map(|reason| {
        stats
            .get(format!("candidate_{reason}"))
            .map(|count| ((*reason).into(), count.clone()))
    })
    .collect();
    Ok(
        json!({"version":1,"session_hash":hash,"hook_version":health.get("hook_version"),
        "observed_results":health.get("seen"),"skipped_results":health.get("skipped"),
        "skip_counts_since_upgrade":counts,"recorded_api_requests":stats.get("calls"),
        "line_decision_results":stats.get("completed"),"replaced_results":stats.get("replaced"),
        "candidate_results_since_upgrade":stats.get("candidates"),"candidate_reasons_since_upgrade":candidate_reasons,
        "kept_results_since_upgrade":stats.get("kept"),
        "saved_chars":stats.get("savedChars"),"proposed_omitted_lines":stats.get("linesOmitted"),
        "actual_omitted_lines_since_upgrade":stats.get("linesActuallyOmitted"),
        "judged_lines":stats.get("linesRelevanceJudged"),"last_skip":health.get("last_skip"),
        "last_error":health.get("last_error")}),
    )
}

pub(super) fn run(data: &Path, session: &str) -> Result<(), String> {
    println!("{}", summarize(data, session)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_proposals_from_actual_savings_and_scopes_the_session() {
        let root = tempfile::tempdir().unwrap();
        let session = root
            .path()
            .join("sessions")
            .join(format!("{:x}", Sha256::digest(b"synthetic")));
        fs::create_dir_all(session.join("logs")).unwrap();
        fs::write(
            session.join("stats.json"),
            json!({"calls":8,"completed":5,"candidates":3,
            "replaced":1,"savedChars":1900,"linesOmitted":220,"linesActuallyOmitted":60})
            .to_string(),
        )
        .unwrap();
        fs::write(
            session.join("logs/hook-health.json"),
            json!({"seen":10,"skipped":5,
            "skip_counts":{"small":3,"exact_content":2}})
            .to_string(),
        )
        .unwrap();
        let report = summarize(root.path(), "synthetic").unwrap();
        assert_eq!(report["proposed_omitted_lines"], 220);
        assert_eq!(report["actual_omitted_lines_since_upgrade"], 60);
        assert_eq!(report["recorded_api_requests"], 8);
        assert_eq!(report["skip_counts_since_upgrade"]["exact_content"], 2);
        assert!(summarize(root.path(), "another-thread").unwrap()["replaced_results"].is_null());
        assert!(report.get("initial_output").is_none());
    }
    #[test]
    fn legacy_unknown_counters_and_invalid_files_are_not_invented() {
        let root = tempfile::tempdir().unwrap();
        let session = root
            .path()
            .join("sessions")
            .join(format!("{:x}", Sha256::digest(b"legacy")));
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("stats.json"), "{\"calls\":3,\"replaced\":0}").unwrap();
        let report = summarize(root.path(), "legacy").unwrap();
        assert!(report["observed_results"].is_null());
        assert!(report["actual_omitted_lines_since_upgrade"].is_null());
        fs::write(session.join("stats.json"), "{\"calls\":\"invalid\"}").unwrap();
        assert!(summarize(root.path(), "legacy").is_err());
    }
}
