//! Inspect one session's aggregate evidence without reading raw receipts.
use super::*;
#[path = "activity/publication.rs"]
mod publication;
#[path = "activity/snapshot.rs"]
mod snapshot;

pub(super) fn summarize(data: &Path, session: &str) -> Result<Value, String> {
    summarize_with_loader(data, session, snapshot::load)
}

fn summarize_with_loader(
    data: &Path,
    session: &str,
    mut load: impl FnMut(&Path, u64) -> Result<Value, String>,
) -> Result<Value, String> {
    if !data.is_absolute() || session.is_empty() || session.len() > 4096 {
        return Err("invalid activity scope".into());
    }
    let hash = format!("{:x}", Sha256::digest(session.as_bytes()));
    let root = data.join("sessions").join(&hash);
    codex_decision::check_ancestors(&root)?;
    let stats = load(&root.join("stats.json"), 8192)?;
    codex_decision::check_ancestors(&root.join("logs"))?;
    let health_path = root.join("logs/hook-health.json");
    let mut health = load(&health_path, 4096)?;
    if codex_decision::activity_counters::counters_conflict(&stats, &health) {
        health = load(&health_path, 4096)?;
    }
    let metrics = snapshot::metrics(&stats, &health)?;
    let counts = health.get("skip_counts").cloned().unwrap_or(json!({}));
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
        json!({"version":2,"session_hash":hash,"hook_version":health.get("hook_version"),"metrics":metrics,
        "observed_results":health.get("seen"),"skipped_results":health.get("skipped"),
        "skip_counts_since_upgrade":counts,"recorded_api_requests":metrics["calls"],
        "http_responses_received":metrics["responsesReceived"],"responses_validated":metrics["responsesValidated"],
        "request_failures":metrics["requestFailures"],"request_cancelled":metrics["requestCancelled"],
        "recorded_hook_errors":metrics["errors"],"skip_details":metrics["skipDetails"],
        "partial_counters":metrics["partialCounters"],
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
    fn torn_current_health_is_retried_once_and_partial_history_is_not_reconstructed() {
        let root = tempfile::tempdir().unwrap();
        let cases: Value = serde_json::from_str(include_str!(
            "../../../../../tests/fixtures/activity-accounting.json"
        ))
        .unwrap();
        let fixture = cases
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["name"] == "current_exact")
            .unwrap();
        let mut stats = fixture["stats"].clone();
        stats["calls"] = json!(8);
        let mut old = fixture["health"].clone();
        old["api_requests"] = json!(6);
        old["responses_received"] = json!(4);
        old["responses_validated"] = json!(3);
        old["request_failures"] = json!(1);
        old["request_cancelled"] = json!(2);
        let mut newer = old.clone();
        newer["api_requests"] = json!(11);
        newer["responses_received"] = json!(9);
        newer["responses_validated"] = json!(8);
        for recovered in [true, false] {
            let mut health_reads = 0;
            let report = summarize_with_loader(root.path(), "synthetic", |path, _| {
                if path.ends_with("stats.json") {
                    return Ok(stats.clone());
                }
                health_reads += 1;
                Ok(if recovered && health_reads > 1 {
                    newer.clone()
                } else {
                    old.clone()
                })
            });
            assert_eq!(health_reads, 2);
            if recovered {
                assert_eq!(report.unwrap()["metrics"]["calls"], 11);
            } else {
                assert!(
                    report.is_err(),
                    "persistent inconsistency must not claim an exact attempt total"
                );
            }
        }
        old.as_object_mut().unwrap().remove("counter_scheme");
        old.as_object_mut().unwrap().remove("partial_counters");
        let mut health_reads = 0;
        let report = summarize_with_loader(root.path(), "synthetic", |path, _| {
            if path.ends_with("stats.json") {
                Ok(stats.clone())
            } else {
                health_reads += 1;
                Ok(old.clone())
            }
        })
        .unwrap();
        assert_eq!(health_reads, 1);
        assert_eq!(report["metrics"]["calls"], 8);
        assert!(report["metrics"]["partialCounters"]
            .as_array()
            .unwrap()
            .contains(&json!("calls")));
    }
    #[test]
    fn shared_cli_and_control_fixtures_preserve_historical_coverage() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../../../tests/fixtures/activity-accounting.json"
        ))
        .unwrap();
        for row in cases.as_array().unwrap() {
            let stats = if row["stats"].is_null() {
                json!({})
            } else {
                row["stats"].clone()
            };
            let health = if row["health"].is_null() {
                json!({})
            } else {
                row["health"].clone()
            };
            let actual = snapshot::metrics(&stats, &health).unwrap();
            for (key, expected) in row["expected"].as_object().unwrap() {
                assert_eq!(&actual[key], expected, "{}: {key}", row["name"]);
            }
        }
    }

    #[test]
    fn activity_reads_reject_ambiguous_large_and_nonregular_files() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("stats.json");
        for bytes in [b"{\"calls\":1,\"calls\":2}".to_vec(), vec![b' '; 8193]] {
            fs::write(&file, bytes).unwrap();
            assert!(snapshot::load(&file, 8192).is_err());
        }
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        assert!(snapshot::load(&file, 8192).is_err());
        fs::remove_dir(&file).unwrap();
        #[cfg(unix)]
        {
            let target = root.path().join("other.json");
            fs::write(&target, "{}").unwrap();
            std::os::unix::fs::symlink(&target, &file).unwrap();
            assert!(snapshot::load(&file, 8192).is_err());
            fs::remove_file(&file).unwrap();
            use std::os::unix::ffi::OsStrExt;
            let path = std::ffi::CString::new(file.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            assert!(
                snapshot::load(&file, 8192).is_err(),
                "FIFO is rejected without blocking"
            );
        }
    }
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
        fs::write(
            session.join("stats.json"),
            "{\"calls\":3,\"candidate_Invalid reason\":1}",
        )
        .unwrap();
        assert!(
            summarize(root.path(), "legacy").is_err(),
            "candidate reasons follow the same bounded codes as the control"
        );
    }
}
