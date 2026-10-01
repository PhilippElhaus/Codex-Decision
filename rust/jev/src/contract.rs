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
    fn contract_rejects_drift_and_completes_partial_thresholds() {
        let raw: Value =
            serde_json::from_str(include_str!("../../../config.example.json")).unwrap();
        let validated = validate("config", &raw).unwrap();
        assert_eq!(
            validated["line_policy"],
            contract()["config"]["line_policy"]["default"]
        );
        let mut invalid = raw.clone();
        invalid["scope"] = "session".into();
        assert!(validate("config", &invalid).is_err());
        invalid = raw.clone();
        invalid["line_policy"]["output"]["exact_max"] = 101.into();
        assert!(validate("config", &invalid).is_err());
    }
}
