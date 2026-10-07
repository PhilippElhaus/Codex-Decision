//! Seeded complete-request parity cases for before/after builds.
use super::*;

pub(super) fn run() {
    let mut seed = 0x761ce422u32;
    let mut next = || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        seed as usize
    };
    let texts = [
        "routine worker event",
        "状态🌍λ",
        "quoted \"text\" \\path\t",
        "\x1b[32mroutine\x1b[0m",
    ];
    for fixture in 0..500 {
        let length = 1 + next() % 500;
        let source: String = (0..length)
            .map(|number| {
                format!(
                    "{} {number}\r\n",
                    texts[next() % texts.len()].repeat(1 + next() % 30)
                )
            })
            .collect();
        let mut lines = source_lines(&source);
        for line in &mut lines {
            if next() % 7 == 0 {
                line.protected_reason = Some("diagnostic_or_completion".into());
            }
            if next() % 11 == 0 {
                line.eligible = false;
            }
        }
        let task = "Find the failure and exact status λ".repeat(if fixture % 41 == 0 {
            2000
        } else {
            1 + next() % 8
        });
        for model in ["gpt-6-luna", "jev-latest"] {
            match relevance_requests(
                &task,
                "printf synthetic-output",
                "repetitive_log",
                &lines,
                model,
            ) {
                Ok(batches) => {
                    let mut digest = Sha256::new();
                    for batch in &batches {
                        digest.update(serde_json::to_vec(&batch.request).unwrap());
                        digest.update(serde_json::to_vec(&batch.target_numbers).unwrap());
                    }
                    println!(
                        "{}",
                        json!({"fixture":fixture,"model":model,"batches":batches.len(),
                        "sha256":format!("{:x}",digest.finalize())})
                    );
                }
                Err(error) => {
                    println!("{}", json!({"fixture":fixture,"model":model,"error":error}))
                }
            }
        }
    }
}
