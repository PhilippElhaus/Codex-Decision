//! Validated session settings and private credentials.
use super::*;

#[derive(Clone)]
pub(super) struct Config {
    pub(super) global_scope: bool,
    pub(super) output: bool,
    pub(super) test_build: bool,
    pub(super) search_listing: bool,
    pub(super) choice_gate_enabled: bool,
    pub(super) mode: String,
    pub(super) min_chars: usize,
    pub(super) max_chars: usize,
    pub(super) model: String,
    pub(super) timeout: f64,
    pub(super) allow_mcp_replacement: bool,
    pub(super) policy: BTreeMap<String, LinePolicy>,
    pub(super) search_relevance: SearchRelevancePolicy,
    pub(super) log_limit_mb: u64,
    pub(super) never_delete_logs: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SharedSettings {
    #[serde(rename = "schema_version")]
    _schema_version: u64,
    mode: String,
    line_policy: BTreeMap<String, LinePolicy>,
    search_relevance: SearchRelevancePolicy,
    choice_gate_enabled: bool,
    log_limit_mb: u64,
    never_delete_logs: bool,
}

pub(super) fn apply_shared_settings(data_dir: &Path, config: &mut Config) -> Result<(), String> {
    let path = data_dir.join("settings.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("settings stat failed".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 8192 {
        return Err("unsafe shared settings".into());
    }
    let bytes = fs::read(&path).map_err(|_| "settings read failed")?;
    let raw: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid shared settings")?;
    let settings: SharedSettings =
        serde_json::from_value(codex_jev::contract::validate("settings", &raw)?)
            .map_err(|_| "invalid shared settings")?;
    config.mode = settings.mode;
    config.policy = settings.line_policy;
    config.search_relevance = settings.search_relevance;
    config.choice_gate_enabled = settings.choice_gate_enabled;
    config.log_limit_mb = settings.log_limit_mb;
    config.never_delete_logs = settings.never_delete_logs;
    Ok(())
}

pub(super) fn config(data_dir: &Path) -> Result<Option<Config>, String> {
    check_ancestors(data_dir)?;
    let path = data_dir.join("config.json");
    match fs::symlink_metadata(&path) {
        Ok(meta) if !meta.is_file() || meta.len() > 64_000 => return Err("unsafe config".into()),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err("config stat failed".into())
        }
        _ => {}
    }
    if path.is_symlink() {
        return Err("linked config".into());
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("config read".into()),
    };
    if bytes.len() > 64_000 {
        return Err("config too large".into());
    }
    let raw: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid config")?;
    if raw.get("schema_version").and_then(Value::as_f64) != Some(2.0) {
        return Err("unsupported config version".into());
    }
    let raw = codex_jev::contract::validate("config", &raw)?;
    Ok(Some(Config {
        global_scope: raw["scope"] == "global",
        output: raw["enabled"].as_bool().unwrap(),
        test_build: raw["test_build_enabled"].as_bool().unwrap(),
        search_listing: raw["search_listing_enabled"].as_bool().unwrap(),
        choice_gate_enabled: raw["choice_gate_enabled"].as_bool().unwrap(),
        mode: raw["mode"].as_str().unwrap().into(),
        min_chars: raw["min_chars"].as_u64().unwrap() as usize,
        max_chars: raw["max_chars"].as_u64().unwrap() as usize,
        model: raw["model"].as_str().unwrap().into(),
        timeout: raw["timeout_seconds"].as_f64().unwrap(),
        allow_mcp_replacement: raw["allow_mcp_replacement"].as_bool().unwrap(),
        policy: serde_json::from_value(raw["line_policy"].clone())
            .map_err(|_| "invalid line policy")?,
        search_relevance: serde_json::from_value(raw["search_relevance"].clone())
            .map_err(|_| "invalid search relevance")?,
        log_limit_mb: raw["log_limit_mb"].as_u64().unwrap(),
        never_delete_logs: raw["never_delete_logs"].as_bool().unwrap(),
    }))
}

pub(super) fn key(data_dir: &Path) -> Result<String, String> {
    let path = data_dir.join(".env");
    let metadata = fs::symlink_metadata(&path).map_err(|_| "missing credential")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 8192 {
        return Err("unsafe credential".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("unsafe credential permissions".into());
        }
    }
    let content = fs::read_to_string(path).map_err(|_| "invalid credential encoding")?;
    let values: Vec<&str> = content
        .lines()
        .filter_map(|line| line.trim().strip_prefix("JEV_API_KEY="))
        .collect();
    if values.len() != 1 {
        return Err("missing credential".into());
    }
    let value = values[0].trim().trim_matches(['\'', '"']);
    if !(8..=4096).contains(&value.len())
        || value.chars().any(char::is_whitespace)
        || value.contains('\0')
    {
        return Err("invalid credential".into());
    }
    Ok(value.into())
}
