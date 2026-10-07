use codex_decision::{render, source_lines, Action, LineDecision};

#[path = "render_parity/baseline.rs"]
mod baseline;

#[test]
fn every_retained_span_and_gap_marker_matches_the_baseline() {
    let text = [
        "INFO routine poll",
        "状态🌍λ",
        "\x1b[31merror detail\x1b[0m",
        "\"quoted\" \\path",
    ];
    let mut seed = 0xe541289au32;
    let mut next = || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        seed as usize
    };
    for fixture in 0..500 {
        let length = 1 + next() % 400;
        let source: String = (0..length)
            .map(|number| {
                format!(
                    "{} {number}{}",
                    text[next() % text.len()],
                    if number == length - 1 && fixture % 2 == 0 {
                        ""
                    } else if fixture % 3 == 0 {
                        "\r\n"
                    } else {
                        "\n"
                    }
                )
            })
            .collect();
        let lines = source_lines(&source);
        let decisions: Vec<_> = lines
            .iter()
            .map(|line| LineDecision {
                number: line.number,
                action: if next() % 5 < 3 {
                    Action::Omit
                } else {
                    Action::Keep
                },
                reason: "synthetic".into(),
                p_can_omit: None,
                p_exact_needed: None,
                p_task_relevant: None,
                protected_reason: None,
                batch_id: None,
            })
            .collect();
        let path = "/private synthetic/原始🌍.txt";
        assert_eq!(
            render(&source, &lines, &decisions, path),
            baseline::render(&source, &lines, &decisions, path)
        );
    }
}
