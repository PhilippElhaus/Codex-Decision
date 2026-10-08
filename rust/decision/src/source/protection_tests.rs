//! Reapplying protection must not grow or change the protected evidence.
use super::*;
use crate::source_lines;

#[test]
fn diagnostic_protection_is_idempotent_across_seeded_source_and_adapter_flags() {
    let samples = [
        "INFO ordinary record 73",
        "ERROR: connection example.invalid:8443 failed",
        "Traceback (most recent call last):",
        "  File \"synthetic.py\", line 9, in run",
        "    retry(session)",
        "AssertionError: expected 73, actual 72",
        "stack backtrace:",
        "    21: synthetic::run",
        "test synthetic::check ... ok",
        "test result: FAILED. 20 passed; 1 failed",
        "",
        "    ",
        "\u{1b}[31mERROR: colored diagnostic\u{1b}[0m",
        "INFO UTF-8 résumé 東京",
        "Command result stream: stderr",
        "{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"synthetic.rs\"}}}",
    ];
    for seed in 0..2_000_u64 {
        let mut random = seed.wrapping_add(1);
        let count = seed as usize % 161;
        let mut source = String::new();
        for index in 0..count {
            random = random
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            source.push_str(samples[(random >> 32) as usize % samples.len()]);
            if index + 1 < count || random & 1 == 0 {
                source.push_str(if random & 2 == 0 { "\n" } else { "\r\n" });
            }
        }
        let mut lines = source_lines(&source);
        for (index, line) in lines.iter_mut().enumerate() {
            if (index + seed as usize).is_multiple_of(19) {
                line.eligible = false;
            }
            if (index + seed as usize).is_multiple_of(23) {
                line.protected_reason = Some("stderr_output".into());
            }
            if (index + seed as usize).is_multiple_of(29) {
                line.protected_reason = Some("tool_metadata".into());
            }
        }
        protect_neighbors(&mut lines);
        let once = serde_json::to_value(&lines).unwrap();
        protect_neighbors(&mut lines);
        assert_eq!(once, serde_json::to_value(&lines).unwrap(), "seed {seed}");
        assert_eq!(
            lines
                .iter()
                .map(|line| line.source(&source))
                .collect::<String>(),
            source,
            "source spans changed for seed {seed}"
        );
    }
}

#[test]
fn repeated_protection_keeps_a_long_backtrace_and_its_original_spans() {
    let source = format!(
        "INFO before\nERROR: run failed\nstack backtrace:\n{}\nINFO after\n",
        (0..80)
            .map(|frame| format!("    {frame}: synthetic::frame\n"))
            .collect::<String>()
    );
    let mut lines = source_lines(&source);
    protect_neighbors(&mut lines);
    assert!(lines
        .iter()
        .filter(|line| line.model_text.starts_with("    "))
        .all(|line| line.protected_reason.is_some()));
    let once = serde_json::to_value(&lines).unwrap();
    protect_neighbors(&mut lines);
    assert_eq!(once, serde_json::to_value(&lines).unwrap());
}
