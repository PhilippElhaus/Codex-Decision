//! Validate optional legacy metadata before a writer changes its snapshot.
use super::*;

// An older in-flight executable preserves unknown fields without updating them.
pub fn request_outcomes_covered(health: &Value) -> bool {
    let Some(version) = health["hook_version"].as_str() else {
        return false;
    };
    let parts: Option<Vec<u64>> = version.split('.').map(|part| part.parse().ok()).collect();
    parts.is_some_and(|parts| parts.len() == 3 && parts.as_slice() >= [0, 11, 5].as_slice())
}

pub(super) fn validate(health: &Value) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "invalid activity clock")?
        .as_millis();
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let invalid = || "invalid hook health metadata".to_string();
    if health
        .get("version")
        .is_some_and(|value| value.as_u64() != Some(1))
    {
        return Err(invalid());
    }
    if let Some(value) = health.get("hook_version") {
        let version = value.as_str().ok_or_else(invalid)?;
        let parts: Vec<_> = version.split('.').collect();
        if version.len() > 80
            || parts.len() != 3
            || parts
                .iter()
                .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return Err(invalid());
        }
    }
    for name in ["last_error", "last_skip", "last_skip_detail"] {
        if health.get(name).is_some_and(|value| {
            value
                .as_str()
                .is_none_or(|text| text.encode_utf16().count() > 80)
        }) {
            return Err(invalid());
        }
    }
    if let Some(value) = health.get("last_seen_ms") {
        let seen = value.as_u64().ok_or_else(invalid)?;
        if seen == 0 || seen > MAX_SAFE_INTEGER || u128::from(seen) > now + 300_000 {
            return Err(invalid());
        }
    }
    for name in ["last_success_ms", "last_error_ms", "last_skip_ms"] {
        if let Some(value) = health.get(name) {
            let time = value.as_u64().ok_or_else(invalid)?;
            if health["last_seen_ms"]
                .as_u64()
                .is_none_or(|seen| time > seen)
            {
                return Err(invalid());
            }
        }
    }
    Ok(())
}
