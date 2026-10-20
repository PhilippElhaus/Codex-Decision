//! Validated session settings and private credentials.
use super::*;

#[derive(Clone)]
pub(super) struct Config {
    pub(super) global_scope: bool,
    pub(super) enabled: bool,
    pub(super) mode: String,
    pub(super) min_chars: usize,
    pub(super) max_chars: usize,
    pub(super) model: String,
    pub(super) provider: codex_decision::provider::Provider,
    pub(super) custom_provider: Option<codex_decision::provider::CustomProvider>,
    pub(super) fallback_enabled: bool,
    pub(super) fallback_from: Option<(codex_decision::provider::Provider, String)>,
    pub(super) timeout: f64,
    pub(super) allow_mcp_replacement: bool,
    pub(super) policy: RelevancePolicy,
    pub(super) log_limit_mb: u64,
    pub(super) never_delete_logs: bool,
}

impl Config {
    pub(super) fn actual_model(&self) -> &str {
        self.custom_provider
            .as_ref()
            .filter(|_| self.provider == codex_decision::provider::Provider::Custom)
            .map_or(self.model.as_str(), |custom| custom.model.as_str())
    }
}

#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RelevancePolicy {
    pub(super) relevant_max: u8,
}

impl Default for RelevancePolicy {
    fn default() -> Self {
        Self { relevant_max: 5 }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SharedSettings {
    #[serde(rename = "schema_version")]
    _schema_version: u64,
    mode: String,
    relevance_policy: RelevancePolicy,
    log_limit_mb: u64,
    never_delete_logs: bool,
    provider: String,
    custom_provider: Option<codex_decision::provider::CustomProvider>,
    fallback_enabled: bool,
    model: String,
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
    let bytes = read_bounded(&path, 8192).map_err(|_| "settings read failed")?;
    let raw = strict_json::parse(&bytes).map_err(|_| "invalid shared settings")?;
    let settings: SharedSettings =
        serde_json::from_value(codex_decision::contract::validate("settings", &raw)?)
            .map_err(|_| "invalid shared settings")?;
    config.mode = settings.mode;
    config.policy = settings.relevance_policy;
    config.log_limit_mb = settings.log_limit_mb;
    config.never_delete_logs = settings.never_delete_logs;
    config.provider = codex_decision::provider::Provider::parse(&settings.provider)?;
    config.custom_provider = settings.custom_provider;
    config.fallback_enabled = settings.fallback_enabled;
    config.model = settings.model;
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
    let bytes = match read_bounded(&path, 64_000) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("config read".into()),
    };
    if bytes.len() > 64_000 {
        return Err("config too large".into());
    }
    let raw = strict_json::parse(&bytes).map_err(|_| "invalid config")?;
    if !matches!(
        raw.get("schema_version").and_then(Value::as_u64),
        Some(2..=5)
    ) {
        return Err("unsupported config version".into());
    }
    let raw = codex_decision::contract::validate("config", &raw)?;
    Ok(Some(Config {
        global_scope: raw["scope"] == "global",
        enabled: raw["enabled"].as_bool().unwrap(),
        mode: raw["mode"].as_str().unwrap().into(),
        min_chars: raw["min_chars"].as_u64().unwrap() as usize,
        max_chars: raw["max_chars"].as_u64().unwrap() as usize,
        model: raw["model"].as_str().unwrap().into(),
        provider: codex_decision::provider::Provider::parse(raw["provider"].as_str().unwrap())?,
        custom_provider: raw
            .get("custom_provider")
            .map(|value| {
                serde_json::from_value(value.clone()).map_err(|_| "invalid custom provider")
            })
            .transpose()?,
        fallback_enabled: raw["fallback_enabled"].as_bool().unwrap(),
        fallback_from: None,
        timeout: raw["timeout_seconds"].as_f64().unwrap(),
        allow_mcp_replacement: raw["allow_mcp_replacement"].as_bool().unwrap(),
        policy: serde_json::from_value(raw["relevance_policy"].clone())
            .map_err(|_| "invalid line policy")?,
        log_limit_mb: raw["log_limit_mb"].as_u64().unwrap(),
        never_delete_logs: raw["never_delete_logs"].as_bool().unwrap(),
    }))
}

pub(super) fn key(
    data_dir: &Path,
    provider: codex_decision::provider::Provider,
) -> Result<String, String> {
    let entered = credential_value(data_dir, provider.key_name())?;
    let value = entered.trim().trim_matches(['\'', '"']);
    if !(8..=4096).contains(&value.len())
        || value.chars().any(char::is_whitespace)
        || value.contains('\0')
    {
        return Err("invalid credential".into());
    }
    Ok(value.into())
}

pub(super) fn credential_value(data_dir: &Path, name: &str) -> Result<String, String> {
    credential_values(data_dir, &[name]).map(|mut values| values.remove(0))
}

pub(super) fn credential_values(data_dir: &Path, names: &[&str]) -> Result<Vec<String>, String> {
    let path = data_dir.join(".env");
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "missing credential"
        } else {
            "credential stat failed"
        }
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16384 {
        return Err("unsafe credential".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("unsafe credential permissions".into());
        }
    }
    let content =
        String::from_utf8(read_bounded(&path, 16384).map_err(|_| "invalid credential encoding")?)
            .map_err(|_| "invalid credential encoding")?;
    names
        .iter()
        .map(|name| {
            let prefix = format!("{name}=");
            let values: Vec<&str> = content
                .lines()
                .filter_map(|line| line.trim_start().strip_prefix(&prefix))
                .collect();
            if values.is_empty() {
                return Err("missing credential".into());
            }
            if values.len() != 1 {
                return Err("invalid credential".into());
            }
            Ok(values[0].into())
        })
        .collect()
}
