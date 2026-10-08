use super::*;
use sha2::{Digest, Sha256};

#[test]
fn shared_retained_fixtures_reject_ambiguous_rows_and_preserve_exact_u64() {
    let cases: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/retained-activity.json"
    )))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let mut source = case["source"].as_str().unwrap_or("").to_owned();
        if let Some(count) = case["repeat_reason"].as_u64() {
            source = format!(
                "{{\"status\":\"replace\",\"reason\":\"{}\",\"requests\":1}}\n",
                "λ".repeat(count as usize)
            );
        }
        if let Some(count) = case["prefix_repeat"].as_u64() {
            source = "{\"status\":\"keep\",\"reason\":\"kept\",\"requests\":1}\n"
                .repeat(count as usize)
                + &source;
        }
        let mut bytes = source.into_bytes();
        if let Some(valid) = case["journal_valid"].as_bool() {
            let fixture: Value = serde_json::from_str(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../tests/fixtures/publication-case.json"
            )))
            .unwrap();
            let mut journal = fixture["prepared"].clone();
            journal["commit_event"] = case["source"].clone();
            journal["commit_sha256"] = json!(format!("{:x}", Sha256::digest(&bytes)));
            assert_eq!(
                crate::publication_contract::PublicationJournal::parse(
                    &serde_json::to_vec(&journal).unwrap()
                )
                .is_ok(),
                valid,
                "{}: journal Unicode",
                case["id"]
            );
        }
        if case["invalid_utf8"] == true {
            let index = bytes
                .windows(9)
                .position(|value| value == b"synthetic")
                .unwrap();
            bytes[index] = 0xff;
        }
        let start = bytes.len().saturating_sub(1_048_576);
        let actual = retained_stats_from_events(&bytes[start..], start > 0).unwrap();
        for name in [
            "calls",
            "completed",
            "replaced",
            "savedChars",
            "timed",
            "elapsedMs",
        ] {
            let expected = case["expected"][name].as_u64().unwrap_or(0);
            assert_eq!(actual[name], expected, "{}: {name}", case["id"]);
            assert_eq!(actual[format!("partial_{name}")], 1);
        }
    }
}
