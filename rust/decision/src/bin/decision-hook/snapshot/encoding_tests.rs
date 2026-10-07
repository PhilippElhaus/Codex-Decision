use super::*;

#[path = "../../../../tests/support/snapshot_baseline.rs"]
pub(crate) mod baseline;

#[test]
fn borrowed_panels_match_every_frozen_row_total_and_canonical_byte() {
    let text = [
        "INFO routine",
        "状态🌍λ",
        "\"quoted\" \\path\t",
        "",
        "ERROR: synthetic failure",
        "    frame",
    ];
    let mut seed = 0x7492f561u32;
    let mut next = || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        seed as usize
    };
    for fixture in 0..300 {
        let count = if fixture == 299 { 10000 } else { next() % 200 };
        let source: String = (0..count)
            .map(|index| {
                format!(
                    "{} {}\r\n",
                    text[next() % text.len()],
                    "λ🌍".repeat(index % 47)
                )
            })
            .collect();
        let mut lines = source_lines(&source);
        let decisions: Vec<_> = lines
            .iter_mut()
            .map(|line| {
                line.eligible = next() % 11 != 0;
                codex_decision::LineDecision {
                    number: line.number,
                    action: match next() % 3 {
                        0 => Action::Omit,
                        1 => Action::Keep,
                        _ => Action::KeepUnjudged,
                    },
                    batch_id: (next() % 3 != 0).then_some(1 + next() % 9),
                    p_can_omit: (next() % 2 == 0).then_some(-0.0),
                    p_exact_needed: (next() % 2 == 0).then_some(0.05001),
                    p_task_relevant: (next() % 2 == 0).then_some(0.95),
                    protected_reason: line.protected_reason.clone(),
                    reason: "required \"value\" λ🌍".into(),
                }
            })
            .collect();
        let batch = BatchRecord {
            id: 1 + next() % 9,
            target_numbers: vec![1, 2, 99],
            elapsed_ms: next() as u64,
            request: json!({}),
            response: json!({}),
        };
        let number = 1 + next() % 9;
        let count = number + next() % 5;
        let classification = next() % 2;
        let timestamp = if fixture % 2 == 0 {
            "2026-10-07T10:09:11+00:00"
        } else {
            "2026-10-07T10:09:11.123456789+00:00"
        };
        let expected = baseline::line_snapshot(
            "receipt",
            "snapshot",
            "output",
            "processing",
            &lines,
            &decisions,
            &batch,
            number,
            count,
            classification,
            timestamp,
        );
        let actual = prepare_line_snapshot(
            "receipt",
            "snapshot",
            "output",
            "processing",
            &lines,
            &decisions,
            &batch,
            number,
            count,
            classification,
        )
        .unwrap()
        .finish(timestamp)
        .unwrap();
        assert_eq!(
            actual,
            serde_json::to_vec(&expected).unwrap(),
            "fixture {fixture}"
        );
    }
}

#[test]
fn panel_encoding_stops_oversized_rows_before_publication() {
    let lines = source_lines("routine\n");
    let mut decisions = apply_relevance_batches(&lines, &BTreeMap::new(), 5);
    decisions[0].reason = "\0".repeat(PANEL_SNAPSHOT_MAX_BYTES / 6 + 1);
    let batch = BatchRecord {
        id: 1,
        target_numbers: vec![1],
        elapsed_ms: 1,
        request: json!({}),
        response: json!({}),
    };
    assert_eq!(
        prepare_line_snapshot(
            "receipt", "snapshot", "output", "keep", &lines, &decisions, &batch, 1, 1, 0
        )
        .err()
        .unwrap(),
        "panel snapshot too large"
    );
}
