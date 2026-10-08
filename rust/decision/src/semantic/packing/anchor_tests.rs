use super::*;
use crate::source_lines;

#[test]
fn typed_diagnostics_and_benchmark_facts_supply_context_to_distant_batches() {
    let source = (0..240)
        .map(|index| format!("INFO ordinary background event {index}\n"))
        .collect::<String>();
    let mut lines = source_lines(&source);
    lines[120].model_text=r#"{"reason":"compiler-message","message":{"level":"note","message":"required diagnosis: worker latency configured incorrectly"}}"#.into();
    lines[120].protected_reason = Some("diagnostic_json".into());
    lines[180].model_text = "BenchmarkSynthetic-8 100 12.345 ns/op 42 B/op 2 allocs/op".into();
    lines[180].protected_reason = Some("benchmark_result".into());
    lines[239].model_text = "Build failed".into();
    lines[239].protected_reason = Some("completion".into());
    let batches = relevance_requests(
        "Explain the worker latency diagnosis and benchmark measurements.",
        "cargo build --message-format=json",
        "repetitive_log",
        &lines,
        "jev-1.13.0",
    )
    .unwrap();
    assert!(batches.len() > 2);
    for batch in batches {
        let rows = batch
            .request
            .pointer("/state/lines")
            .unwrap()
            .as_array()
            .unwrap();
        for index in [120, 180] {
            let row = rows
                .iter()
                .find(|row| row["line"] == lines[index].number)
                .unwrap_or_else(|| {
                    panic!(
                        "batch{} lacks typed context line{}",
                        batch.id, lines[index].number
                    )
                });
            assert_eq!(row["text"], lines[index].model_text);
            assert_eq!(row["protected"], true);
            assert_eq!(row["target"], false);
            assert!(!batch.target_numbers.contains(&lines[index].number));
        }
    }
}
