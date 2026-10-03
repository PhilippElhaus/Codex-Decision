//! Shared wire contract, bundled with the VS Code control and embedded in Rust.
use serde_json::{Map, Value};
use std::sync::OnceLock;
pub fn contract() -> &'static Value {
    static CONTRACT: OnceLock<Value> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!("../../../vscode-control/config-contract.json"))
            .expect("checked-in contract")
    })
}
pub fn validate(kind: &str, value: &Value) -> Result<Value, String> {
    if kind == "config" && value["schema_version"] == 2
        || kind == "settings" && value["schema_version"] == 1
    {
        let mut current = validate(
            if kind == "config" {
                "config_v2"
            } else {
                "settings_v1"
            },
            value,
        )?;
        let policies = current["line_policy"]
            .as_object()
            .ok_or("invalid legacy policy")?;
        let omit_min = policies
            .values()
            .filter_map(|p| p["omit_min"].as_u64())
            .max()
            .ok_or("missing cutoff")?;
        let exact_max = policies
            .values()
            .filter_map(|p| p["exact_max"].as_u64())
            .min()
            .ok_or("missing cutoff")?;
        if kind == "config" {
            current["enabled"] = Value::Bool(
                current["enabled"] == true
                    || current["test_build_enabled"] == true
                    || current["search_listing_enabled"] == true,
            );
        }
        let object = current.as_object_mut().ok_or("invalid legacy config")?;
        for key in [
            "test_build_enabled",
            "search_listing_enabled",
            "search_relevance",
        ] {
            object.remove(key);
        }
        current["schema_version"] = Value::from(if kind == "config" { 3 } else { 2 });
        current["line_policy"] = serde_json::json!({"omit_min":omit_min,"exact_max":exact_max});
        return validate(kind, &current);
    }
    if kind == "config" && value["schema_version"] == 3
        || kind == "settings" && value["schema_version"] == 2
    {
        let old = validate(
            if kind == "config" {
                "config_v3"
            } else {
                "settings_v2"
            },
            value,
        )?;
        let cutoff = (100
            - old["line_policy"]["omit_min"]
                .as_u64()
                .ok_or("missing cutoff")?)
        .min(
            old["line_policy"]["exact_max"]
                .as_u64()
                .ok_or("missing cutoff")?,
        )
        .min(5);
        let mut current = old;
        let object = current.as_object_mut().ok_or("invalid legacy config")?;
        object.remove("line_policy");
        object.remove("choice_gate_enabled");
        current["schema_version"] = Value::from(if kind == "config" { 4 } else { 3 });
        current["relevance_policy"] = serde_json::json!({"relevant_max":cutoff});
        return validate(kind, &current);
    }
    let fields = contract()[kind].as_object().ok_or("unknown contract")?;
    let object = value.as_object().ok_or_else(|| format!("invalid {kind}"))?;
    if object.keys().any(|key| !fields.contains_key(key)) {
        return Err(format!("unknown {kind} field"));
    }
    let mut result = Map::new();
    for (key, spec) in fields {
        let Some(entered) = object.get(key) else {
            if spec["required"] == true {
                return Err(format!("missing {kind} {key}"));
            }
            if let Some(default) = spec.get("default") {
                result.insert(key.clone(), default.clone());
            }
            continue;
        };
        let t = spec["type"].as_str().ok_or("invalid contract type")?;
        let normalized = if contract().get(t).is_some() {
            validate(t, entered)?
        } else {
            let valid = match t {
                "boolean" => entered.is_boolean(),
                "string" => entered.is_string(),
                "integer" => entered.as_f64().is_some_and(|n| {
                    n.is_finite()
                        && n.fract() == 0.0
                        && (0.0..=9_007_199_254_740_991.0).contains(&n)
                }),
                "number" => entered.as_f64().is_some_and(f64::is_finite),
                "model" => entered.as_str().is_some_and(|s| {
                    s.starts_with("jev-")
                        && (5..=44).contains(&s.len())
                        && s[4..]
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
                }),
                _ => false,
            };
            if !valid
                || spec
                    .get("min")
                    .is_some_and(|min| entered.as_f64() < min.as_f64())
                || spec
                    .get("max")
                    .is_some_and(|max| entered.as_f64() > max.as_f64())
                || spec["values"]
                    .as_array()
                    .is_some_and(|values| !values.contains(entered))
            {
                return Err(format!("invalid {kind} {key}"));
            }
            if t == "integer" {
                Value::from(entered.as_f64().unwrap() as u64)
            } else {
                entered.clone()
            }
        };
        result.insert(key.clone(), normalized);
    }
    let result = Value::Object(result);
    if kind == "config" && result["min_chars"].as_u64() > result["max_chars"].as_u64() {
        return Err("invalid size bounds".into());
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_selection_and_cutoffs_migrate_conservatively() {
        for enabled in [false, true] {
            for test_build in [false, true] {
                for search_listing in [false, true] {
                    let raw = serde_json::json!({"schema_version":2,"enabled":enabled,
                        "test_build_enabled":test_build,"search_listing_enabled":search_listing,
                        "mode":"replace","line_policy":{"output":{"omit_min":80,"exact_max":20},
                            "test_build":{"omit_min":98,"exact_max":4},
                            "search_listing":{"omit_min":92,"exact_max":2}}});
                    let migrated = validate("config", &raw).unwrap();
                    assert_eq!(migrated["enabled"], enabled || test_build || search_listing);
                    assert_eq!(migrated["schema_version"], 4);
                    assert_eq!(
                        migrated["relevance_policy"],
                        serde_json::json!({"relevant_max":2})
                    );
                    assert!(migrated.get("test_build_enabled").is_none());
                    assert!(migrated.get("search_relevance").is_none());
                }
            }
        }
    }
    #[test]
    fn contract_rejects_drift_and_completes_partial_thresholds() {
        let raw: Value =
            serde_json::from_str(include_str!("../../../config.example.json")).unwrap();
        let validated = validate("config", &raw).unwrap();
        assert_eq!(
            validated["relevance_policy"],
            contract()["config"]["relevance_policy"]["default"]
        );
        let mut invalid = raw.clone();
        invalid["scope"] = "session".into();
        assert!(validate("config", &invalid).is_err());
        invalid = raw.clone();
        invalid["relevance_policy"]["relevant_max"] = 101.into();
        assert!(validate("config", &invalid).is_err());
    }
}
