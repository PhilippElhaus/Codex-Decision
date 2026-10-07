use super::*;

fn encoded_budget(request: &Value, model: &str) -> RequestBudget {
    let wire = crate::provider::wire_request(request).unwrap();
    let questions: Vec<_> = if model == "gpt-6-luna" {
        wire["questions"].as_array().unwrap().iter().collect()
    } else {
        wire["questions"].as_object().unwrap().values().collect()
    };
    let longest = questions
        .iter()
        .map(|q| serde_json::to_vec(q).unwrap().len())
        .max()
        .unwrap();
    RequestBudget {
        state_longest_question_bound: serde_json::to_vec(
            &wire[if model == "gpt-6-luna" {
                "input"
            } else {
                "state"
            }],
        )
        .unwrap()
        .len()
            + longest
            + TOKEN_HEADROOM,
        whole_request_bound: serde_json::to_vec(&wire).unwrap().len() + TOKEN_HEADROOM,
    }
}

#[test]
fn every_window_cost_matches_the_independent_wire_encoder() {
    let texts = ["INFO routine poll", "\"quoted\" \\path\t", "状态🌍", "x"];
    let mut seed = 0xc478128au32;
    let mut next = || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        seed as usize
    };
    for fixture in 0..50 {
        let length = 1 + next() % 300;
        let source: String = (0..length)
            .map(|number| {
                let text = texts[next() % texts.len()];
                format!("{} {number}\r\n", text.repeat(1 + next() % 50))
            })
            .collect();
        let mut lines = crate::source_lines(&source);
        for (index, line) in lines.iter_mut().enumerate() {
            if index != 0 && next() % 5 == 0 {
                line.protected_reason = Some("completion".into());
            }
            if index != 0 && next() % 7 == 0 {
                line.eligible = false;
            }
        }
        let targets: Vec<_> = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| line.eligible && line.protected_reason.is_none())
            .map(|(index, _)| index)
            .collect();
        let mut anchors = BTreeSet::from([0, lines.len() - 1]);
        for _ in 0..12 {
            anchors.insert(next() % length);
        }
        let task = "Find the failure and exact values \"λ🌍\"".repeat(1 + fixture % 7);
        let command = "printf \\\"synthetic\\\" output\n";
        for model in ["gpt-6-luna", "jev-latest"] {
            let sizes = WindowSizes::new(&task, command, "repetitive_log", &lines, &targets, model)
                .unwrap();
            for _ in 0..17 {
                let start = next() % targets.len();
                let end = start + 1 + next() % (targets.len() - start);
                let request = window_request(
                    &task,
                    command,
                    "repetitive_log",
                    &lines,
                    &targets[start..end],
                    &anchors,
                    model,
                );
                let expected = encoded_budget(&request, model);
                let actual = sizes.budget(start, end, &targets, &anchors);
                assert_eq!(
                    actual.state_longest_question_bound, expected.state_longest_question_bound,
                    "state: fixture {fixture}, {model}, {start}..{end}"
                );
                assert_eq!(
                    actual.whole_request_bound, expected.whole_request_bound,
                    "request: fixture {fixture}, {model}, {start}..{end}"
                );
            }
        }
    }
}
