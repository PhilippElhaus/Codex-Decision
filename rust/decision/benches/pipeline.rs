//! Offline pipeline CPU and allocation measurements; no network or credentials.
use codex_decision::{protect_neighbors, render, semantic::*, source_lines, SourceLine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::hint::black_box;

#[path = "common/measure.rs"]
mod measurement;
use measurement::{measure, measure_input};

fn evidence(lines: &[SourceLine], model: &str) -> Vec<codex_decision::Batch> {
    relevance_requests(
        "Find the failure and final status",
        "printf synthetic-output",
        "repetitive_log",
        lines,
        model,
    )
    .unwrap()
}

#[path = "pipeline/equivalence.rs"]
mod equivalence;
#[path = "pipeline/wire.rs"]
mod wire;

fn main() {
    let selected = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    if selected == "equivalence" {
        equivalence::run();
        return;
    }
    if selected == "all" || selected == "representatives" {
        for count in [1000, 10000] {
            let source: String = (0..count)
                .map(|n| format!("INFO repeated group {}\n", n % 97))
                .collect();
            let lines = source_lines(&source);
            for mode in ["omit", "mixed", "keep"] {
                let probabilities = lines
                    .iter()
                    .map(|line| {
                        (
                            line.number,
                            (
                                if mode == "keep" || mode == "mixed" && line.number % 3 == 0 {
                                    0.95
                                } else {
                                    0.01
                                },
                                1,
                            ),
                        )
                    })
                    .collect();
                measure(&format!("representatives-{count}-{mode}"), || {
                    apply_relevance_batches(&lines, &probabilities, 5)
                });
                println!(
                    "{}",
                    json!({"fixture":format!("representatives-{count}-{mode}"),
                    "decisions_sha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&apply_relevance_batches(&lines,&probabilities,5)).unwrap()))})
                );
            }
        }
    }
    let (prefix, suffix) = match selected.as_str() {
        "source-colored" => ("\u{1b}[31m", "\u{1b}[0m"),
        "source-unsupported" => ("\u{1b}[?25l", ""),
        _ => ("", ""),
    };
    for (count, width) in [(100, 16), (1000, 64), (10000, 16), (1000, 2048)] {
        let source: String = (0..count)
            .map(|n| format!("{prefix}INFO {} {n}{suffix}\n", "x".repeat(width)))
            .collect();
        let lines = source_lines(&source);
        if matches!(
            selected.as_str(),
            "all" | "source" | "source-colored" | "source-unsupported"
        ) {
            measure(&format!("source-{count}-{width}"), || {
                source_lines(black_box(&source))
            });
            measure_input(
                &format!("protection-{count}-{width}"),
                || lines.clone(),
                |mut lines| {
                    protect_neighbors(&mut lines);
                    lines
                },
            );
            println!(
                "{}",
                json!({"fixture":format!("source-{count}-{width}"),
                "source_sha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&lines).unwrap()))})
            );
        }
        for model in ["gpt-6-luna", "jev-latest"] {
            if selected != "all" && selected != model {
                continue;
            }
            let batches = evidence(&lines, model);
            let mut digest = Sha256::new();
            for batch in &batches {
                let bytes = serde_json::to_vec(&batch.request).unwrap();
                digest.update(&bytes);
                validate_request_budget(&batch.request).unwrap();
            }
            println!(
                "{}",
                json!({"fixture":format!("{model}-{count}-{width}"),
                "batches":batches.len(),"targets":batches.iter().map(|b|b.target_numbers.len()).sum::<usize>(),
                "request_sha256":format!("{:x}",digest.finalize())})
            );
            measure(&format!("budget-{model}-{count}-{width}"), || {
                request_budget(black_box(&batches[0].request)).unwrap()
            });
            wire::run(&batches[0].request, &lines, model, count, width);
            measure(&format!("packing-{model}-{count}-{width}"), || {
                evidence(black_box(&lines), model)
            });
            if model == "gpt-6-luna" {
                let request = &batches[0].request;
                let wire = codex_decision::provider::wire_request(request).unwrap();
                let answers: Vec<_> = wire["questions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|q| json!({"name":q["name"],"type":"predicate","probability":0.01}))
                    .collect();
                let response = json!({"model":model,"answers":answers,"usage":{"input_tokens":100,"output_tokens":0,"total_tokens":100}});
                measure_input(
                    &format!("normalize-{model}-{count}-{width}"),
                    || response.clone(),
                    |response| {
                        codex_decision::provider::normalize_response(request, response).unwrap()
                    },
                );
            }
        }
        if selected == "all" || selected == "render" {
            let probabilities = lines.iter().map(|line| (line.number, (0.01, 1))).collect();
            let decisions = apply_relevance_batches(&lines, &probabilities, 5);
            measure(&format!("decisions-{count}-{width}"), || {
                apply_relevance_batches(black_box(&lines), black_box(&probabilities), 5)
            });
            measure(&format!("render-{count}-{width}"), || {
                render(
                    black_box(&source),
                    black_box(&lines),
                    black_box(&decisions),
                    "/synthetic/original.txt",
                )
            });
            let mut alternating = decisions.clone();
            for (index, row) in alternating.iter_mut().enumerate() {
                row.action = if index % 2 == 0 {
                    codex_decision::Action::Omit
                } else {
                    codex_decision::Action::Keep
                };
            }
            measure(&format!("render-alternating-{count}-{width}"), || {
                render(&source, &lines, &alternating, "/synthetic/original.txt")
            });
            let bytes = render(&source, &lines, &decisions, "/synthetic/original.txt");
            let fingerprint: Value = json!({"fixture":format!("render-{count}-{width}"),
                "render_sha256":format!("{:x}",Sha256::digest(bytes.as_bytes()))});
            println!("{fingerprint}");
        }
    }
}
