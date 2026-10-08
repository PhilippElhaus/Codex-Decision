use super::*;

fn health(directory: &Path) -> Value {
    serde_json::from_slice(&fs::read(directory.join("logs/hook-health.json")).unwrap()).unwrap()
}

#[test]
fn error_count_persists_independently_of_requests_skips_and_successes() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    hook_health(&data, "seen", "").unwrap();
    hook_health(&data, "request", "").unwrap();
    hook_health(&data, "error", "synthetic request failure").unwrap();
    hook_health(&data, "seen", "").unwrap();
    hook_health(&data, "skip", "small").unwrap();
    hook_health(&data, "success", "").unwrap();
    hook_health(&data, "error", "synthetic publication failure").unwrap();
    let record = health(&data);
    assert_eq!(record["errors"], 2);
    assert_eq!(record["api_requests"], 1);
    assert_eq!(record["seen"], 2);
    assert_eq!(record["skipped"], 1);
    assert_eq!(record["last_error"], "synthetic publication failure");
}

#[test]
fn existing_health_seeds_error_count_only_from_new_failures() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    hook_health(&data, "seen", "").unwrap();
    let path = data.join("logs/hook-health.json");
    let mut record = health(&data);
    record.as_object_mut().unwrap().remove("errors");
    record["last_error_ms"] = json!(1);
    record["last_error"] = json!("historical error without a count");
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    hook_health(&data, "error", "new synthetic failure").unwrap();
    assert_eq!(health(&data)["errors"], 1);
    record = health(&data);
    record["errors"] = json!(u64::MAX);
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    hook_health(&data, "error", "saturated synthetic failure").unwrap();
    assert_eq!(health(&data)["errors"], u64::MAX);
}
