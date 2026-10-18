use super::*;

#[test]
fn passing_test_identifiers_do_not_turn_healthy_records_into_diagnostics() {
    let source = "test synthetic::handles_error ... ok\r\n\
        test synthetic::error::nested ... ok\n\
        test synthetic::failed_warning_panic_exception ... ok\n";
    let mut lines = source_lines(source);
    protect_neighbors(&mut lines);
    assert!(lines.iter().all(|line| line.protected_reason.is_none()));
    assert_eq!(
        lines
            .iter()
            .map(|line| line.source(source))
            .collect::<String>(),
        source
    );
    let once = serde_json::to_value(&lines).unwrap();
    protect_neighbors(&mut lines);
    assert_eq!(once, serde_json::to_value(&lines).unwrap());
}

#[test]
fn diagnostic_outcomes_and_noncanonical_pass_records_remain_protected() {
    for source in [
        "test synthetic::handles_input ... FAILED",
        "test synthetic::handles_error ... ignored",
        "test synthetic::handles_error ... ok; ERROR: connection refused",
        "test ERROR: connection refused ... ok",
        "test synthetic:::error ... ok",
        "test result: ok. 40 passed; 0 failed",
        "panicked at src/synthetic.rs:73",
        "warning final",
        "reward error_handling still needs review",
    ] {
        assert_eq!(
            source_lines(source)[0].protected_reason.as_deref(),
            Some("diagnostic_or_completion"),
            "diagnostic evidence became eligible: {source}"
        );
    }
}

#[test]
fn only_exact_zero_counter_tokens_mask_diagnostic_words() {
    for source in [
        "INFO error_count=0 synthetic heartbeat 1",
        "INFO errors=0; failures=0, warnings=0 heartbeat",
        "INFO failed_count=0 failure_count=0 warning_count=0 heartbeat",
    ] {
        let mut lines = source_lines(source);
        protect_neighbors(&mut lines);
        assert!(lines[0].protected_reason.is_none(), "{source}");
    }
    for source in [
        "INFO error_count=1 synthetic heartbeat",
        "INFO error_count=0.1 synthetic heartbeat",
        "INFO error_count=0x1 synthetic heartbeat",
        "INFO unknown_error_count=0 synthetic heartbeat",
        "INFO error_count=0,failed_count=1 synthetic heartbeat",
        "INFO error_count=0 ERROR: retained connection detail",
        "ERROR: error_count=0 operation rejected",
        "INFO error_count=0 assertion detail",
        "INFO errors=0 failed operation",
        "INFO errors=0 test result: ok. 4 passed; 0 failed",
    ] {
        assert_eq!(
            source_lines(source)[0].protected_reason.as_deref(),
            Some("diagnostic_or_completion"),
            "diagnostic evidence became eligible: {source}"
        );
    }
}
