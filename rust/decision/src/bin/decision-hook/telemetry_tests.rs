use super::*;

fn health(directory: &Path) -> Value {
    serde_json::from_slice(&fs::read(directory.join("logs/hook-health.json")).unwrap()).unwrap()
}

#[test]
fn error_count_persists_independently_of_requests_skips_and_successes() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    hook_health(&data, "seen", "").unwrap();
    hook_health(&data, "request", "").unwrap();
    hook_health(&data, "error", "synthetic request failure").unwrap();
    hook_health(&data, "seen", "").unwrap();
    hook_health(&data, "skip", "small").unwrap();
    hook_health(&data, "success", "").unwrap();
    hook_health(&data, "error", "synthetic publication failure").unwrap();
    let record = health(&data);
    assert_eq!(record["errors"], 2);
    assert_eq!(record["api_requests"], 1);
    assert_eq!(record["seen"], 2);
    assert_eq!(record["skipped"], 1);
    assert_eq!(record["last_error"], "synthetic publication failure");
}

#[cfg(unix)]
#[test]
fn committed_success_status_waits_for_the_bounded_cleanup_lock_after_deadline() {
    struct RestoreBudget(Option<Instant>);
    impl Drop for RestoreBudget {
        fn drop(&mut self) {
            HOOK_STARTED.with(|value| value.set(self.0));
        }
    }
    let _restore = RestoreBudget(HOOK_STARTED.with(|value| value.get()));
    HOOK_STARTED.with(|value| value.set(None));
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    hook_health(&data, "seen", "").unwrap();
    let guard = lock_logs(&data.join("logs")).unwrap();
    let held = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(450));
        drop(guard);
    });
    HOOK_STARTED.with(|value| value.set(Some(Instant::now() - Duration::from_secs(46))));
    let started = Instant::now();
    hook_health(&data, "success", "").unwrap();
    held.join().unwrap();
    assert!(started.elapsed() >= Duration::from_millis(400));
    assert!(started.elapsed() < Duration::from_secs(3));
    let record = health(&data);
    assert_eq!(record["last_success_ms"], record["last_seen_ms"]);
    assert_eq!(record["errors"], 0);
}

#[test]
fn existing_health_seeds_error_count_only_from_new_failures() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    hook_health(&data, "seen", "").unwrap();
    let path = data.join("logs/hook-health.json");
    let mut record = health(&data);
    record.as_object_mut().unwrap().remove("errors");
    record.as_object_mut().unwrap().remove("counter_scheme");
    record["last_error_ms"] = json!(1);
    record["last_error"] = json!("historical error without a count");
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    hook_health(&data, "error", "new synthetic failure").unwrap();
    assert_eq!(health(&data)["errors"], 1);
    record = health(&data);
    record["errors"] = json!(u64::MAX);
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    assert_eq!(
        hook_health(&data, "error", "overflowing synthetic failure").unwrap_err(),
        "counter overflow"
    );
    assert_eq!(
        health(&data),
        record,
        "overflow preserves the previous exact count"
    );
}

#[test]
fn fresh_counter_ledgers_are_exact_and_legacy_populated_counters_stay_partial() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("fresh");
    hook_health(&data, "seen", "").unwrap();
    let fresh = health(&data);
    assert_eq!(fresh["counter_scheme"], 1);
    assert_eq!(fresh["partial_counters"], json!([]));
    for name in HEALTH_COUNTERS {
        assert_eq!(
            fresh[*name],
            if *name == "seen" { json!(1) } else { json!(0) }
        );
    }
    let zero_stats = load_stats(&data.join("stats.json")).unwrap();
    assert_eq!(zero_stats["counter_scheme"], 1);
    for name in STATS_COUNTERS {
        assert_eq!(zero_stats[*name], 0);
    }
    let legacy = root.path().join("legacy");
    ensure_dir(&legacy.join("logs")).unwrap();
    let populated = json!({"version":1,"hook_version":"0.11.4","last_seen_ms":1,
        "seen":20,"skipped":15,"api_requests":8,"errors":2,"skip_counts":{"small":15}});
    fs::write(
        legacy.join("logs/hook-health.json"),
        serde_json::to_vec(&populated).unwrap(),
    )
    .unwrap();
    hook_health(&legacy, "seen", "").unwrap();
    let upgraded = health(&legacy);
    assert_eq!(upgraded["seen"], 21);
    assert_eq!(upgraded["api_requests"], 8);
    assert_eq!(upgraded["errors"], 2);
    assert_eq!(upgraded["partial_counters"], json!(HEALTH_COUNTERS));
    assert!(
        upgraded.get("responses_received").is_none(),
        "missing historical counters are not invented"
    );
    assert_eq!(upgraded["skip_reasons_partial"], true);
    let mut old_stats = json!({"calls":8,"completed":3,"replaced":1,"timed":8,"elapsedMs":100,
        "candidates":1,"kept":1,"linesActuallyOmitted":12,"linesRelevanceJudged":20});
    prepare_stats_counters(&mut old_stats, true).unwrap();
    for name in LEGACY_PARTIAL_STATS {
        assert_eq!(old_stats[format!("partial_{name}")], 1);
    }
    assert_eq!(old_stats["linesActuallyOmitted"], 12);
    assert!(
        old_stats.get("partial_completed").is_none(),
        "established completion totals retain their coverage"
    );
}

#[test]
fn older_writer_cannot_leave_new_request_outcomes_falsely_exact() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    hook_health(&data, "seen", "").unwrap();
    let path = data.join("logs/hook-health.json");
    let mut old = health(&data);
    // The baseline 0.11.4 writer loads and preserves unknown scheme fields,
    // counts its request/error, and never records a request_result outcome.
    old["hook_version"] = json!("0.11.4");
    old["api_requests"] = json!(1);
    old["errors"] = json!(1);
    fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
    assert_eq!(old["partial_counters"], json!([]));
    let partial = codex_decision::activity_counters::partial_metric_names(&json!({}), &old, true);
    for name in [
        "requestCancelled",
        "responsesReceived",
        "responsesValidated",
        "requestFailures",
    ] {
        assert!(
            partial.contains(name),
            "readers immediately recognize lost coverage: {name}"
        );
    }
    assert!(
        !partial.contains("calls"),
        "the old writer still increments durable intent correctly"
    );
    hook_health(&data, "seen", "").unwrap();
    let repaired = health(&data);
    assert_eq!(repaired["hook_version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(
        repaired["partial_counters"],
        json!(codex_decision::activity_counters::REQUEST_OUTCOME_COUNTERS)
    );
    hook_health(&data, "request", "").unwrap();
    request_result(&data, false, false).unwrap();
    let later = health(&data);
    assert_eq!(later["api_requests"], 2);
    assert_eq!(later["request_failures"], 1);
    assert_eq!(
        later["partial_counters"], repaired["partial_counters"],
        "lost history stays partial after recovery"
    );
}

#[test]
fn events_only_legacy_history_seeds_retained_minima_and_keeps_coverage_partial() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    ensure_dir(&data.join("logs")).unwrap();
    write_private(&data.join("logs/events.jsonl"),b"{\"status\":\"replace\",\"reason\":\"filtered\",\"requests\":2,\"elapsed_ms\":1000,\"original_chars\":200,\"capsule_chars\":100}\n",false).unwrap();
    hook_health(&data, "seen", "").unwrap();
    let current = health(&data);
    assert_eq!(current["seen"], 1);
    assert_eq!(current["api_requests"], 2);
    assert_eq!(current["partial_counters"], json!(HEALTH_COUNTERS));
    let stats = load_activity_stats(&data).unwrap();
    assert_eq!(stats["completed"], 1);
    assert_eq!(stats["calls"], 2);
    assert_eq!(stats["savedChars"], 100);
    for name in STATS_COUNTERS {
        assert_eq!(stats[format!("partial_{name}")], 1);
    }
    assert!(stats.get("linesActuallyOmitted").is_none());
    // A second observation reuses the ledger; retained history is never counted twice.
    hook_health(&data, "seen", "").unwrap();
    assert_eq!(load_activity_stats(&data).unwrap()["completed"], 1);
    assert_eq!(health(&data)["seen"], 2);
}

#[test]
fn protection_details_record_only_bounded_codes_and_clear_stale_detail() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    skip_with_detail(&data, "sensitive", "protected_output").unwrap();
    skip_with_detail(&data, "sensitive", "protected_input").unwrap();
    skip_with_detail(&data, "sensitive", "protected_output").unwrap();
    let record = health(&data);
    assert_eq!(record["skipped"], 3);
    assert_eq!(record["skip_counts"]["sensitive"], 3);
    assert_eq!(record["skip_details"]["protected_output"], 2);
    assert_eq!(record["skip_details"]["protected_input"], 1);
    assert_eq!(record["last_skip_detail"], "protected_output");
    assert!(skip_with_detail(&data, "sensitive", "arbitrary payload").is_err());
    skip(&data, "small").unwrap();
    let record = health(&data);
    assert!(record.get("last_skip_detail").is_none());
    assert_eq!(record["skip_details"]["protected_output"], 2);
}

#[test]
fn malformed_health_counters_are_preserved_and_never_silently_reset() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    hook_health(&data, "seen", "").unwrap();
    let path = data.join("logs/hook-health.json");
    let initial = health(&data);
    for (name, invalid) in [
        ("api_requests", json!("one")),
        ("seen", json!(-1)),
        ("request_cancelled", json!(1.5)),
        ("skip_counts", json!({"small":"one"})),
        ("skip_details", json!([1])),
    ] {
        let mut broken = initial.clone();
        broken[name] = invalid;
        let bytes = serde_json::to_vec(&broken).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(hook_health(&data, "seen", "").is_err(), "{name}");
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    let duplicate = br#"{"api_requests":1,"api_requests":2}"#;
    fs::write(&path, duplicate).unwrap();
    assert!(hook_health(&data, "request", "").is_err());
    assert_eq!(fs::read(&path).unwrap(), duplicate);
    let stats = data.join("stats.json");
    fs::write(&stats, br#"{"calls":1,"calls":2}"#).unwrap();
    assert!(load_stats(&stats).is_err());
}

#[test]
fn optional_health_metadata_is_validated_before_and_after_mutation() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    hook_health(&data, "seen", "").unwrap();
    let path = data.join("logs/hook-health.json");
    let initial = health(&data);
    for (name, invalid) in [
        ("version", json!(2)),
        ("hook_version", json!(true)),
        ("hook_version", json!("0.11")),
        ("last_error", json!({"unexpected":"object"})),
        ("last_skip_detail", json!("x".repeat(81))),
        ("last_seen_ms", json!(i64::MAX)),
        ("last_seen_ms", json!(0)),
        (
            "last_seen_ms",
            json!(Utc::now().timestamp_millis() + 600_000),
        ),
        ("last_error_ms", json!(-1)),
        (
            "last_skip_ms",
            json!(initial["last_seen_ms"].as_u64().unwrap() + 1),
        ),
    ] {
        let mut broken = initial.clone();
        broken[name] = invalid;
        let bytes = serde_json::to_vec(&broken).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(hook_health(&data, "seen", "").is_err(), "{name}");
        assert_eq!(
            fs::read(&path).unwrap(),
            bytes,
            "invalid metadata is preserved for diagnosis"
        );
    }
    let bytes = serde_json::to_vec(&initial).unwrap();
    fs::write(&path, &bytes).unwrap();
    for (outcome, reason) in [
        ("skip", "Invalid reason"),
        ("error", "x".repeat(81).as_str()),
    ] {
        assert!(hook_health(&data, outcome, reason).is_err());
        assert_eq!(
            fs::read(&path).unwrap(),
            bytes,
            "invalid new metadata is not published"
        );
    }
}

#[test]
fn request_results_distinguish_received_validated_failed_and_cancelled_attempts() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    for (received, validated) in [(true, true), (true, false), (false, false)] {
        hook_health(&data, "request", "").unwrap();
        request_result(&data, received, validated).unwrap();
    }
    hook_health(&data, "request", "").unwrap();
    hook_health(&data, "request_cancelled", "hook deadline before send").unwrap();
    let result = health(&data);
    assert_eq!(result["api_requests"], 4);
    assert_eq!(result["responses_received"], 2);
    assert_eq!(result["responses_validated"], 1);
    assert_eq!(result["request_failures"], 2);
    assert_eq!(result["request_cancelled"], 1);
    assert_eq!(
        result["errors"], 0,
        "request outcomes do not duplicate invocation errors"
    );
    assert!(request_result(&data, false, true).is_err());
    assert_eq!(health(&data), result);
}

#[cfg(unix)]
#[test]
fn failed_classification_stats_publication_does_not_append_a_success_event() {
    use std::os::unix::fs::PermissionsExt;
    // Root can bypass directory permissions; the normal-user case exercises
    // a real write failure after successful state reads and log-lock access.
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    ensure_dir(&data).unwrap();
    let logs = data.join("logs");
    ensure_dir(&logs).unwrap();
    let path = data.join("stats.json");
    let stats = json!({"calls":4,"completed":1,"replaced":0,"timed":4,"elapsedMs":100});
    let stats_bytes = serde_json::to_vec(&stats).unwrap();
    write_private(&path, &stats_bytes, false).unwrap();
    let index = logs.join("events.jsonl");
    write_private(&index, b"existing synthetic event\n", false).unwrap();
    let gate = BatchRecord {
        id: 0,
        target_numbers: vec![],
        request: json!({}),
        response: json!({"answers":{"output_kind":{"choice":"prose"}}}),
        elapsed_ms: 10,
    };
    fs::set_permissions(&data, fs::Permissions::from_mode(0o500)).unwrap();
    let result = record_gate_skip(
        &data,
        &json!({"tool_name":"Bash"}),
        1000,
        &gate,
        "prose",
        "choice_kept_full_output",
        false,
    );
    fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    assert_eq!(fs::read(&path).unwrap(), stats_bytes);
    assert_eq!(fs::read(&index).unwrap(), b"existing synthetic event\n");
}

#[test]
fn classification_only_activity_enforces_event_retention_without_line_completion() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let logs = data.join("logs");
    ensure_dir(&logs).unwrap();
    let index = logs.join("events.jsonl");
    let previous: String = (0..80_000)
        .map(|sequence| format!("{{\"synthetic\":{sequence}}}\n"))
        .collect();
    write_private(&index, previous.as_bytes(), false).unwrap();
    let before = fs::metadata(&index).unwrap().len();
    classification_start(&data, false).unwrap();
    let after = fs::metadata(&index).unwrap().len();
    assert!(
        after <= 1_048_576,
        "classification-only log exceeded its bound: before={before} after={after}"
    );
}

#[test]
fn kept_and_failed_streams_compact_metadata_without_touching_stats_or_originals() {
    for (kept, never_delete_logs) in [(true, false), (false, false), (true, true), (false, true)] {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let logs = data.join("logs");
        ensure_dir(&logs).unwrap();
        let index = logs.join("events.jsonl");
        let previous: String = (0..80_000)
            .map(|sequence| format!("{{\"synthetic\":{sequence}}}\n"))
            .collect();
        write_private(&index, previous.as_bytes(), false).unwrap();
        let original = data.join("saved-original.txt");
        write_private(&original, b"synthetic original", false).unwrap();
        let folder = logs.join("2026-10-08-synthetic");
        ensure_dir(&folder).unwrap();
        let receipt = folder.join(format!("receipt-{}.json", "a".repeat(32)));
        write_private(&receipt, b"synthetic retained receipt", false).unwrap();
        let gate = BatchRecord {
            id: 0,
            target_numbers: vec![],
            request: json!({}),
            response: json!({"answers":{"output_kind":{"choice":"prose"}}}),
            elapsed_ms: 10,
        };
        for _ in 0..8 {
            classification_start(&data, never_delete_logs).unwrap();
            if kept {
                record_gate_skip(
                    &data,
                    &json!({"tool_name":"Bash"}),
                    1000,
                    &gate,
                    "prose",
                    "choice_kept_full_output",
                    never_delete_logs,
                )
                .unwrap();
            }
            // Failed requests have no gate completion or line publication.
            if !never_delete_logs {
                assert!(fs::metadata(&index).unwrap().len() <= EVENT_LOG_LIMIT as u64);
            }
        }
        let actual = fs::read(&index).unwrap();
        if never_delete_logs {
            assert!(actual.starts_with(previous.as_bytes()));
        }
        for line in std::str::from_utf8(&actual).unwrap().lines() {
            assert!(serde_json::from_str::<Value>(line).is_ok());
        }
        if kept {
            let stats = load_stats(&data.join("stats.json")).unwrap();
            assert_eq!(stats["calls"], 8);
            assert_eq!(stats["completed"], 0);
            assert_eq!(stats["timed"], 8);
        } else {
            assert!(!data.join("stats.json").exists());
        }
        assert_eq!(fs::read(original).unwrap(), b"synthetic original");
        assert_eq!(
            fs::read(receipt).unwrap(),
            b"synthetic retained receipt",
            "event retention does not scan or prune receipts"
        );
    }
}
