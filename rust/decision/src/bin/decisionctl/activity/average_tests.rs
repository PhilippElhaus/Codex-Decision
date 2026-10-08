use super::*;

#[test]
fn average_rounding_is_exact_for_shared_ties_odd_divisors_and_u64_boundaries() {
    let fixtures: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/average-ratios.json"
    )))
    .unwrap();
    for row in fixtures.as_array().unwrap() {
        let elapsed = row["elapsed"].as_str().unwrap().parse::<u64>().unwrap();
        let timed = row["timed"].as_str().unwrap().parse::<u64>().unwrap();
        let expected = row["expected"].as_str().unwrap().parse::<u64>().unwrap();
        assert_eq!(rounded_average(elapsed, timed), expected, "{row}");
        let stats = json!({"counter_scheme":1,"calls":0,"completed":0,"replaced":0,
            "timed":timed,"elapsedMs":elapsed});
        assert_eq!(
            metrics(&stats, &json!({})).unwrap()["averageMs"],
            expected,
            "{row}"
        );
        let mut partial = stats.clone();
        partial["partial_timed"] = json!(1);
        assert_eq!(
            metrics(&partial, &json!({})).unwrap()["averageMs"],
            Value::Null
        );
    }
}
