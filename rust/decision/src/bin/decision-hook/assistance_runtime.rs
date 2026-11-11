//! Native service used by MCP, VS Code commands, and bounded Stop review.
use super::*;
use codex_decision::assistance;
use codex_decision::provider::Provider;
use std::io::{BufRead, BufReader};

#[path = "assistance_runtime/mcp.rs"]
mod protocol;
pub(super) use protocol::mcp;

pub(super) fn data_directory() -> Result<PathBuf, String> {
    let directory = PathBuf::from(std::env::var_os("PLUGIN_DATA").ok_or("missing plugin data")?);
    if !directory.is_absolute() {
        return Err("unsafe plugin data".into());
    }
    ensure_dir(&directory)?;
    Ok(directory)
}

pub(super) fn selected_config(data_dir: &Path, session: Option<&str>) -> Result<Config, String> {
    let scoped = session.map(|s| session_dir(data_dir, s)).transpose()?;
    let mut selected = match scoped.as_ref() {
        Some(s) => config(s)?,
        None => None,
    };
    if selected.is_none() {
        selected = config(data_dir)?;
    }
    let mut config = selected.unwrap_or(Config {
        global_scope: false,
        enabled: false,
        mode: "replace".into(),
        min_chars: 256,
        max_chars: 2_000_000,
        model: "gpt-6-luna".into(),
        provider: Provider::OpenAi,
        custom_provider: None,
        fallback_enabled: false,
        fallback_from: None,
        timeout: 3.0,
        allow_mcp_replacement: false,
        policy: RelevancePolicy::default(),
        log_limit_mb: 50,
        never_delete_logs: false,
    });
    apply_shared_settings(data_dir, &mut config)?;
    Ok(config)
}

pub(super) fn judge(data_dir: &Path, input: &Value) -> Result<Value, String> {
    HOOK_STARTED.with(|s| s.set(Some(Instant::now())));
    let session = input
        .get("session_id")
        .map(|s| s.as_str().ok_or("invalid session id"))
        .transpose()?;
    let config = selected_config(data_dir, session)?;
    judge_with_config(data_dir, input, &config)
}

pub(super) fn judge_with_config(
    data_dir: &Path,
    input: &Value,
    config: &Config,
) -> Result<Value, String> {
    let serialized = serde_json::to_string(input).map_err(|_| "invalid assistance input")?;
    if sensitive_source(&serialized) || sensitive_context(&serialized) {
        return Err("protected assistance evidence".into());
    }
    let connection = Connection::load(data_dir, config)?;
    let prepared = assistance::prepare(input, &config.model, connection.protocol())?;
    // Advisory calls have their own health ledger. They never inflate output
    // filtering participation or prepared-savings counters.
    let scoped = match input["session_id"].as_str() {
        Some(s) => session_dir(data_dir, s)?.join("assistance"),
        None => data_dir.join("assistance"),
    };
    ensure_dir(&scoped)?;
    let started = Instant::now();
    let result = evaluate(
        &scoped,
        &connection.agent(),
        &prepared.request,
        &connection,
        config.timeout.min(10.0),
        |r| prepared.finish(r),
    )
    .map_err(|e| e.reason);
    let metadata = match &result {
        Ok((_, r)) => json!({"event":"assistance_request","workflow":prepared.workflow,
            "outcome":"validated","elapsed_ms":usage::milliseconds(started),"usage":r["usage"]}),
        Err(_) => json!({"event":"assistance_request","workflow":prepared.workflow,
            "outcome":"failed","elapsed_ms":usage::milliseconds(started)}),
    };
    usage::observation(&scoped, metadata, config.never_delete_logs);
    result.map(|(_, r)| r)
}

pub(super) fn completion_mode(data_dir: &Path) -> Result<String, String> {
    let Some(bytes) = private_backup(&data_dir.join("assistance.json"), 4096)? else {
        return Ok("off".into());
    };
    let value = strict_json::parse(&bytes).map_err(|_| "invalid assistance settings")?;
    validate_settings(&value)?;
    Ok(value["completion_verification"].as_str().unwrap().into())
}

fn validate_settings(value: &Value) -> Result<(), String> {
    if value.as_object().is_none_or(|o| o.len() != 2)
        || value["version"] != 1
        || !matches!(
            value["completion_verification"].as_str(),
            Some("off" | "observe" | "enforce")
        )
    {
        return Err("invalid assistance settings".into());
    }
    Ok(())
}

pub(super) fn command(argument: &str) -> Result<(), String> {
    let data_dir = data_directory()?;
    let mut bytes = Vec::new();
    std::io::stdin()
        .take((assistance::MAX_INPUT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "assistance input")?;
    if bytes.len() > assistance::MAX_INPUT {
        return Err("assistance input too large".into());
    }
    let input = strict_json::parse(&bytes).map_err(|_| "invalid assistance input")?;
    let result = if argument == "--assistance-settings" {
        validate_settings(&input)?;
        let _lock = lock_logs(&data_dir)?;
        write_private(
            &data_dir.join("assistance.json"),
            &serde_json::to_vec(&input).unwrap(),
            true,
        )?;
        input
    } else {
        judge(&data_dir, &input)?
    };
    println!("{result}");
    Ok(())
}
