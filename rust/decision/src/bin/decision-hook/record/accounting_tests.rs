use super::*;

fn batch(id: usize, input: u64, output: u64, elapsed_ms: u64) -> BatchRecord {
    BatchRecord {
        id,
        target_numbers: vec![id],
        request: json!({}),
        response: json!({"usage":{"input_tokens":input,"output_tokens":output}}),
        elapsed_ms,
    }
}

#[test]
fn usage_and_timing_totals_reject_overflow_without_saturating_or_wrapping() {
    for records in [
        vec![batch(1, u64::MAX - 10, 0, 1), batch(2, 11, 0, 1)],
        vec![batch(1, 0, u64::MAX, 1), batch(2, 0, 1, 1)],
    ] {
        assert_eq!(
            request_totals(&records, None).unwrap_err(),
            "request usage overflow"
        );
    }
    let records = [batch(1, 0, 0, u64::MAX), batch(2, 0, 0, 1)];
    assert_eq!(
        request_totals(&records, None).unwrap_err(),
        "request timing overflow"
    );
    let gate = batch(0, u64::MAX, 0, 0);
    assert_eq!(
        request_totals(&[batch(1, 1, 0, 1)], Some(&gate)).unwrap_err(),
        "request usage overflow"
    );
    let (elapsed, usage) = request_totals(
        &[batch(1, u64::MAX - 1, u64::MAX, 1), batch(2, 1, 0, 2)],
        None,
    )
    .unwrap();
    assert_eq!(elapsed, 3);
    assert_eq!(usage["input_tokens"], u64::MAX);
    assert_eq!(usage["output_tokens"], u64::MAX);
}

#[test]
fn usage_overflow_fails_before_any_receipt_or_completion_publication() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    ensure_dir(&data).unwrap();
    fs::write(
        data.join("config.json"),
        serde_json::to_vec(
            &codex_decision::contract::validate(
                "config",
                &json!({"schema_version":5,"enabled":true,"mode":"replace",
                "relevance_policy":{"relevant_max":5}}),
            )
            .unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    let selected = config(&data).unwrap().unwrap();
    let before = json!({"calls":7,"completed":2,"replaced":1,"timed":7,"elapsedMs":70});
    let bytes = serde_json::to_vec(&before).unwrap();
    fs::write(data.join("stats.json"), &bytes).unwrap();
    let records = [batch(1, u64::MAX, 0, 1), batch(2, 1, 0, 1)];
    assert_eq!(
        record(
            &data,
            &json!({}),
            "output",
            "replace",
            "relevance_policy",
            "",
            "",
            &[],
            &[],
            &records,
            None,
            &selected,
            &"a".repeat(32),
            &"b".repeat(32)
        )
        .unwrap_err(),
        "request usage overflow"
    );
    assert_eq!(fs::read(data.join("stats.json")).unwrap(), bytes);
    assert!(
        !data.join("logs").exists(),
        "no publication or staging starts before checked totals"
    );
}
