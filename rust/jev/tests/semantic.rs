use codex_jev::{protect_neighbors, semantic::*, source_lines, Action};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn answer(kind: &str) -> Value {
    let distribution: serde_json::Map<String, Value> = KINDS
        .iter()
        .map(|name| {
            (
                (*name).into(),
                json!(if *name == kind { 0.98 } else { 0.02 / 7.0 }),
            )
        })
        .collect();
    json!({"model":"jev-1.13.0","answers":{"output_kind":{"type":"choice",
        "choice":kind,"confidence":0.96,"probabilities":distribution}},
        "usage":{"input_tokens":100,"output_tokens":30}})
}

#[test]
fn every_class_has_a_deterministic_safe_branch() {
    for (index, kind) in KINDS.iter().enumerate() {
        let (selected, allow) = classification(&answer(kind)).unwrap();
        assert_eq!(selected, *kind);
        assert_eq!(allow, index < 4);
    }
    for (p, confidence, allowed) in [(0.95, 0.70, true), (0.949, 0.99, false), (0.99, 0.01, true)] {
        let mut value = answer(KINDS[0]);
        value["answers"]["output_kind"]["probabilities"] = Value::Object(
            KINDS
                .iter()
                .map(|kind| {
                    (
                        (*kind).into(),
                        json!(if *kind == KINDS[0] {
                            p
                        } else if *kind == "prose" {
                            1.0 - p
                        } else {
                            0.0
                        }),
                    )
                })
                .collect(),
        );
        value["answers"]["output_kind"]["confidence"] = json!(confidence);
        assert_eq!(classification(&value).unwrap().1, allowed);
    }
}

#[test]
fn rounded_distributions_and_ambiguity_between_excerptable_classes_are_supported() {
    let mut response = answer(KINDS[0]);
    let values = [0.50, 0.45, 0.01, 0.01, 0.01, 0.01, 0.0, 0.0];
    response["answers"]["output_kind"]["probabilities"] = Value::Object(
        KINDS
            .iter()
            .zip(values)
            .map(|(kind, p)| ((*kind).into(), json!(p)))
            .collect(),
    );
    response["answers"]["output_kind"]["confidence"] = json!(0.01);
    assert!(classification(&response).unwrap().1);
    // Rounded API probabilities can sum to 0.99; normalize the branch mass.
    response["answers"]["output_kind"]["probabilities"]["progress_output"] = json!(0.46);
    assert!(classification(&response).unwrap().1);
    response["answers"]["output_kind"]["probabilities"]["progress_output"] = json!(0.42);
    assert!(classification(&response).is_err());
}

#[test]
fn malformed_or_inconsistent_classification_never_allows_filtering() {
    let mutations = [
        ("/model", json!(null)),
        ("/model", json!("other")),
        ("/answers/output_kind/type", json!("noul")),
        ("/answers/output_kind/choice", json!("invented")),
        ("/answers/output_kind/confidence", json!(1.01)),
        ("/answers/output_kind/confidence", json!("0.99")),
        (
            "/answers/output_kind/probabilities/repetitive_log",
            json!(0.4),
        ),
        ("/answers/output_kind/probabilities/prose", json!(-0.1)),
        ("/usage/input_tokens", json!(-1)),
    ];
    for (path, value) in mutations {
        let mut response = answer(KINDS[0]);
        *response.pointer_mut(path).unwrap() = value;
        assert!(classification(&response).is_err(), "{path}");
    }
    for field in ["type", "choice", "confidence", "probabilities"] {
        let mut response = answer(KINDS[0]);
        response["answers"]["output_kind"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(classification(&response).is_err());
    }
    let mut response = answer(KINDS[0]);
    response["answers"]["unexpected"] = json!({});
    assert!(classification(&response).is_err());
}

#[test]
fn classification_samples_cover_ends_middle_and_sparse_diagnostics() {
    for length in [1, 2, 5, 20, 21, 22, 100, 1000] {
        let source = (1..=length)
            .map(|n| format!("routine {n}\n"))
            .collect::<String>();
        let request = classification_request(
            "task",
            "Bash",
            "command",
            &json!(1),
            &source_lines(&source),
            "jev-latest",
        );
        let sample = request["state"]["sample"].as_array().unwrap();
        assert_eq!(sample.first().unwrap()["line"], 1);
        assert_eq!(sample.last().unwrap()["line"], length);
        assert!(sample.len() <= 33);
        assert!(validate_request_budget(&request).is_ok());
    }
    let mut lines = source_lines(&"routine\n".repeat(100));
    lines[37].protected_reason = Some("diagnostic_or_completion".into());
    let request = classification_request("task", "Bash", "cmd", &json!(null), &lines, "jev-latest");
    assert!(request["state"]["sample"]
        .as_array()
        .unwrap()
        .iter()
        .any(|line| line["line"] == 38));
}

#[test]
fn batches_cover_all_targets_exactly_once_without_a_line_cap() {
    for length in [1, 2, 20, 120, 250, 251, 400, 1000, 10000] {
        let source = (1..=length)
            .map(|n| format!("routine item {n}\n"))
            .collect::<String>();
        let lines = source_lines(&source);
        let batches = relevance_requests("task", "cmd", KINDS[0], &lines, "jev-latest").unwrap();
        let mut targets = Vec::new();
        for (index, batch) in batches.iter().enumerate() {
            assert_eq!(batch.id, index + 1);
            assert_eq!(
                batch.request["questions"].as_object().unwrap().len(),
                batch.target_numbers.len()
            );
            validate_request_budget(&batch.request).unwrap();
            for number in &batch.target_numbers {
                let row = batch.request["state"]["lines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["line"] == *number)
                    .unwrap();
                assert_eq!(row["text"], lines[number - 1].model_text);
                assert_eq!(row["target"], true);
            }
            targets.extend(batch.target_numbers.iter().copied());
        }
        assert_eq!(targets, (1..=length).collect::<Vec<_>>());
        if length > 250 {
            assert!(batches.len() > 1);
        }
    }
}

#[test]
fn packing_adapts_when_successive_windows_shrink_and_grow() {
    let source = (1..=420)
        .map(|number| {
            let text = if (141..=280).contains(&number) {
                "状态 正常 🌍 ".repeat(180)
            } else {
                "routine poll".to_owned()
            };
            format!("{text} {number}\n")
        })
        .collect::<String>();
    let lines = source_lines(&source);
    let batches = relevance_requests("task", "cmd", KINDS[0], &lines, "jev-latest").unwrap();
    let mut targets = Vec::new();
    let mut sizes = Vec::new();
    for batch in batches {
        validate_request_budget(&batch.request).unwrap();
        sizes.push(batch.target_numbers.len());
        for number in &batch.target_numbers {
            let row = batch.request["state"]["lines"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["line"] == *number)
                .unwrap();
            assert_eq!(row["text"], lines[number - 1].model_text);
        }
        targets.extend(batch.target_numbers);
    }
    assert_eq!(targets, (1..=420).collect::<Vec<_>>());
    assert!(sizes.windows(2).any(|pair| pair[0] > pair[1]));
    assert!(sizes.windows(2).any(|pair| pair[0] < pair[1]));
}

#[test]
fn both_api_budgets_have_exact_boundaries_and_count_utf8_and_question_overhead() {
    let mut request = json!({"model":"jev-latest","state":"", "questions":{"q":{"type":"noul","instructions":"needed?"}}});
    let empty = request_budget(&request).unwrap();
    let n = JEV_STATE_QUESTION_TOKENS - empty.state_longest_question_bound;
    request["state"] = json!("x".repeat(n));
    assert_eq!(
        validate_request_budget(&request)
            .unwrap()
            .state_longest_question_bound,
        JEV_STATE_QUESTION_TOKENS
    );
    request["state"] = json!("x".repeat(n + 1));
    assert!(validate_request_budget(&request).is_err());
    request["state"] = json!("状态🌍".repeat(100));
    let utf8 = request_budget(&request).unwrap();
    assert_eq!(
        utf8.state_longest_question_bound - empty.state_longest_question_bound,
        "状态🌍".repeat(100).len()
    );
    request["state"] = json!("");
    request["questions"] = json!({});
    for index in 0..64 {
        request["questions"][format!("q{index}")] =
            json!({"type":"noul","instructions":"x".repeat(800)});
    }
    let used = request_budget(&request).unwrap().whole_request_bound;
    let text = request["questions"]["q0"]["instructions"]
        .as_str()
        .unwrap()
        .to_owned();
    request["questions"]["q0"]["instructions"] =
        json!(text + &"x".repeat(JEV_REQUEST_TOKENS - used));
    assert_eq!(
        validate_request_budget(&request)
            .unwrap()
            .whole_request_bound,
        JEV_REQUEST_TOKENS
    );
    let text = request["questions"]["q0"]["instructions"]
        .as_str()
        .unwrap()
        .to_owned();
    request["questions"]["q0"]["instructions"] = json!(text + "x");
    assert!(validate_request_budget(&request).is_err());
}

#[test]
fn long_targets_split_and_protected_context_never_becomes_a_question() {
    for text in [
        "x".repeat(4000),
        "状态 🌍 λ".repeat(200),
        "\"\\ escaped\t".repeat(100),
    ] {
        let lines = source_lines(&(text.clone() + "\n").repeat(40));
        let batches = relevance_requests("task", "cmd", KINDS[0], &lines, "jev-latest").unwrap();
        assert!(batches.len() > 1);
        assert_eq!(
            batches
                .iter()
                .map(|batch| batch.target_numbers.len())
                .sum::<usize>(),
            40
        );
        assert!(batches
            .iter()
            .all(|batch| validate_request_budget(&batch.request).is_ok()));
    }
    let mut lines = source_lines(&"routine\n".repeat(500));
    lines[213].protected_reason = Some("diagnostic_or_completion".into());
    let batches = relevance_requests("task", "cmd", KINDS[0], &lines, "jev-latest").unwrap();
    assert!(batches
        .iter()
        .all(|batch| !batch.target_numbers.contains(&214)));
    assert!(batches.iter().all(|batch| batch.request["state"]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["line"] == 214 && row["protected"] == true)));
    assert!(
        relevance_requests("task", &"x".repeat(64000), KINDS[0], &lines, "jev-latest").is_err()
    );
}

#[test]
fn relevance_requires_exact_ids_types_and_finite_probabilities() {
    let lines = source_lines("first\nsecond\nlast\n");
    let batch = relevance_requests("task", "cmd", KINDS[0], &lines, "jev-latest")
        .unwrap()
        .remove(0);
    let valid = json!({"model":"jev-1.13.0","answers":{"line_1":{"type":"noul","noul":0.01},
        "line_2":{"type":"noul","noul":0.5},"line_3":{"type":"noul","noul":1.0}}});
    assert_eq!(relevance_answers(&batch, &valid).unwrap().len(), 3);
    for bad in [json!(-0.1), json!(1.1), json!(null), json!("0.01")] {
        let mut response = valid.clone();
        response["answers"]["line_2"]["noul"] = bad;
        assert!(relevance_answers(&batch, &response).is_err());
    }
    let mut response = valid.clone();
    response["answers"]
        .as_object_mut()
        .unwrap()
        .remove("line_2");
    assert!(relevance_answers(&batch, &response).is_err());
    response["answers"]["line_4"] = json!({"type":"noul","noul":0.01});
    assert!(relevance_answers(&batch, &response).is_err());
    let mut response = valid;
    response["answers"]["line_1"]["confidence"] = json!(0.99);
    assert!(relevance_answers(&batch, &response).is_err());
}

#[test]
fn cumulative_decisions_preserve_real_batch_ids_and_global_keep_rules() {
    let lines = source_lines("routine\nroutine\nunique value 73\nfinal status\n");
    let probabilities = BTreeMap::from([
        (1, (0.01, 1)),
        (2, (0.01, 2)),
        (3, (0.95, 2)),
        (4, (0.01, 3)),
    ]);
    let decisions = apply_relevance_batches(&lines, &probabilities, 5);
    assert_eq!(
        decisions
            .iter()
            .map(|row| row.batch_id.unwrap())
            .collect::<Vec<_>>(),
        vec![1, 2, 2, 3]
    );
    assert_eq!(decisions[0].reason, "representative");
    assert_eq!(decisions[1].action, Action::Omit);
    assert_eq!(decisions[2].action, Action::Keep);
    assert_eq!(decisions[3].reason, "last_line");
}

#[test]
fn relevance_keeps_uncertainty_protection_unique_bytes_and_representatives() {
    let source="重复 routine\r\n重复 routine\r\nunique value α=73\r\nuncertain context\r\n\x1b[31merror: synthetic failure\x1b[0m\r\nfinished\r\n";
    let mut lines = source_lines(source);
    protect_neighbors(&mut lines);
    let probabilities = BTreeMap::from([
        (1, 0.01),
        (2, 0.01),
        (3, 0.99),
        (4, 0.5),
        (5, 0.0),
        (6, 0.0),
    ]);
    let decisions = apply_relevance(&lines, &probabilities, 5);
    assert_eq!(decisions[0].reason, "representative");
    assert_eq!(decisions[1].action, Action::Omit);
    assert!(decisions[2..].iter().all(|row| row.action != Action::Omit));
    assert_eq!(lines[2].source(source), "unique value α=73\r\n");
    assert!(decisions
        .iter()
        .all(|row| row.p_can_omit.is_none() && row.p_exact_needed.is_none()));
    let unknown = apply_relevance(&lines, &BTreeMap::new(), 5);
    assert!(unknown.iter().all(|row| row.action != Action::Omit));
}

#[test]
fn five_percent_cutoff_is_inclusive_and_does_not_round_scores() {
    let lines = source_lines("first routine\nsecond routine\nthird routine\nfinal\n");
    let scores = BTreeMap::from([(1, 0.05), (2, 0.05001), (3, 0.06)]);
    let decisions = apply_relevance(&lines, &scores, 5);
    assert_eq!(decisions[0].action, Action::Omit);
    assert_eq!(decisions[1].action, Action::Keep);
    assert_eq!(decisions[2].action, Action::Keep);
    assert_eq!(decisions[1].p_task_relevant, Some(0.05001));
}
