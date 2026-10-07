use codex_decision::{protect_neighbors, semantic::apply_relevance_batches, source_lines, Action};
use serde_json::to_value;
use std::collections::BTreeMap;

#[path = "source_parity/baseline.rs"]
mod baseline;

#[test]
fn source_spans_diagnostics_and_representatives_match_the_frozen_baseline() {
    let text = [
        "INFO routine poll",
        "info routine poll",
        "状态🌍λ",
        "",
        "\t ",
        "\x1b[31merror detail\x1b[0m",
        "\x1b[?25lunsupported",
        "\x1b[31;",
        "warning final",
        "WARN",
        "reward",
        "panicked at file.rs:73",
        "    frame 1",
        "Traceback (most recent call last):",
        "test routine ... ok",
        "Not OK",
        "Ran 3 checks",
    ];
    let mut seed = 0x3e7652a9u32;
    let mut next = || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        seed as usize
    };
    for fixture in 0..500 {
        let count = next() % 250;
        let source: String = (0..count)
            .map(|index| {
                let line = if index == 0 && fixture % 7 == 0 {
                    "λ🌍".repeat(900)
                } else {
                    text[next() % text.len()].to_owned()
                };
                format!(
                    "{line}{}",
                    if fixture % 2 == 0 && index == count - 1 {
                        ""
                    } else if fixture % 3 == 0 {
                        "\r\n"
                    } else {
                        "\n"
                    }
                )
            })
            .collect();
        let mut actual = source_lines(&source);
        let mut expected = baseline::source_lines(&source);
        assert_eq!(
            to_value(&actual).unwrap(),
            to_value(&expected).unwrap(),
            "spans {fixture}"
        );
        protect_neighbors(&mut actual);
        baseline::protect_neighbors(&mut expected);
        assert_eq!(
            to_value(&actual).unwrap(),
            to_value(&expected).unwrap(),
            "protection {fixture}"
        );
        // Format guards can add protection before the second neighbor pass.
        for (a, b) in actual.iter_mut().zip(&mut expected) {
            if next() % 13 == 0 {
                a.protected_reason = Some("format_guard".into());
                b.protected_reason = a.protected_reason.clone();
            }
            if next() % 17 == 0 {
                a.eligible = false;
                b.eligible = false;
            }
        }
        protect_neighbors(&mut actual);
        baseline::protect_neighbors(&mut expected);
        assert_eq!(
            to_value(&actual).unwrap(),
            to_value(&expected).unwrap(),
            "second pass {fixture}"
        );
        let probabilities: BTreeMap<_, _> = actual
            .iter()
            .filter_map(|line| {
                if next() % 5 != 0 {
                    Some((
                        line.number,
                        (if next() % 3 == 0 { 0.95 } else { 0.01 }, 1 + next() % 8),
                    ))
                } else {
                    None
                }
            })
            .collect();
        let decisions = apply_relevance_batches(&actual, &probabilities, 5);
        let mut oracle = decisions.clone();
        for (line, row) in actual.iter().zip(&mut oracle) {
            row.protected_reason = line.protected_reason.clone();
            let (action, reason) = if !line.eligible || line.protected_reason.is_some() {
                (Action::KeepUnjudged, "protected")
            } else if let Some((p, _)) = probabilities.get(&line.number) {
                if *p <= 0.05 {
                    (Action::Omit, "irrelevant")
                } else {
                    (Action::Keep, "task_relevant")
                }
            } else {
                (Action::KeepUnjudged, "budget_unjudged")
            };
            row.action = action;
            row.reason = reason.into();
        }
        baseline::preserve_representatives(&expected, &mut oracle);
        assert_eq!(
            to_value(&decisions).unwrap(),
            to_value(&oracle).unwrap(),
            "representatives {fixture}"
        );
    }
}
