use super::*;
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/publication-case.json"
    )))
    .unwrap()
}

#[test]
fn shared_contract_accepts_only_bounded_complete_path_free_metadata() {
    let mut value = fixture()["prepared"].clone();
    let valid = serde_json::to_vec(&value).unwrap();
    let parsed = PublicationJournal::parse(&valid).unwrap();
    assert_eq!(parsed.state, "prepared");
    for field in ["prior_stats", "prior_snapshot", "artifacts"] {
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(PublicationJournal::parse(&serde_json::to_vec(&missing).unwrap()).is_err());
    }
    for (field, bad) in [
        ("event_offset", json!(9_007_199_254_740_991_u64)),
        ("folder", json!("2026-02-30-0123456789")),
        ("receipt_id", json!("../outside")),
    ] {
        let mut invalid = value.clone();
        invalid[field] = bad;
        assert!(PublicationJournal::parse(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
    value["artifacts"][0]["name"] = json!("../receipt.json");
    assert!(PublicationJournal::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    assert!(PublicationJournal::parse(&vec![b' '; JOURNAL_LIMIT + 1]).is_err());
}

#[test]
fn unsigned_metadata_matches_strict_node_counter_tokens() {
    for token in ["1.0", "1e0", "-0"] {
        assert!(parse_stats(format!("{{\"calls\":{token}}}").as_bytes()).is_err());
    }
    assert!(parse_stats(b"\xef\xbb\xbf{\"calls\":1}").is_err());
    assert!(parse_stats(b"{\"calls\":1,\"calls\":2}").is_err());
    assert!(parse_stats(b"{\"calls\":1}").is_ok());
}
