//! Opt-in, bounded local inspection of skipped tool payloads. Never sent to a provider.
use super::*;

const MAX_STORE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PAYLOAD_BYTES: usize = 512 * 1024;
const MAX_ENTRIES: usize = 20;

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Store {
    version: u8,
    entries: Vec<Entry>,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    id: String,
    at: String,
    reason: String,
    detail: Option<String>,
    tool_name: String,
    tool_use_id: Option<String>,
    payload: Option<Payload>,
    payload_unavailable: Option<String>,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    // JSON strings preserve integer tokens beyond JavaScript's exact numeric range.
    tool_input_json: String,
    tool_response_json: String,
}

pub(super) fn skip_event(data_dir: &Path, event: &Value, reason: &str) -> Result<Value, String> {
    let answer = skip(data_dir, reason)?;
    usage::skipped(reason);
    // Optional inspection must not alter filtering, the original response, or skip accounting.
    let _ = capture(data_dir, event, reason, None);
    Ok(answer)
}

pub(super) fn skip_event_with_detail(
    data_dir: &Path,
    event: &Value,
    reason: &str,
    detail: &str,
) -> Result<Value, String> {
    let answer = skip_with_detail(data_dir, reason, detail)?;
    usage::skipped(reason);
    let _ = capture(data_dir, event, reason, Some(detail));
    Ok(answer)
}

fn read_optional_private(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("skipped payload stat failed".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit as u64 {
        return Err("unsafe skipped payload file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.nlink() != 1 || metadata.permissions().mode() & 0o077 != 0 {
            return Err("unsafe skipped payload permissions".into());
        }
    }
    read_bounded(path, limit)
        .map(Some)
        .map_err(|_| "skipped payload read failed".into())
}

fn preference(data_dir: &Path) -> Result<Option<bool>, String> {
    check_dir_if_exists(data_dir)?;
    let logs = data_dir.join("logs");
    check_dir_if_exists(&logs)?;
    let Some(bytes) = read_optional_private(&logs.join("skipped-raw-enabled.json"), 256)? else {
        return Ok(None);
    };
    let value = strict_json::parse(&bytes).map_err(|_| "invalid skipped payload preference")?;
    if value["version"] != 1 || value.as_object().map_or(0, |object| object.len()) != 2 {
        return Err("invalid skipped payload preference".into());
    }
    value["enabled"]
        .as_bool()
        .map(Some)
        .ok_or_else(|| "invalid skipped payload preference".into())
}

fn enabled(data_dir: &Path) -> Result<bool, String> {
    if let Some(value) = preference(data_dir)? {
        return Ok(value);
    }
    let Some(sessions) = data_dir.parent() else {
        return Ok(false);
    };
    let valid_session = data_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.len() == 64
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
    if sessions.file_name().and_then(|name| name.to_str()) != Some("sessions") || !valid_session {
        return Ok(false);
    }
    check_dir_if_exists(sessions)?;
    match sessions.parent() {
        Some(root) => Ok(preference(root)?.unwrap_or(false)),
        None => Ok(false),
    }
}

fn capture(
    data_dir: &Path,
    event: &Value,
    reason: &str,
    detail: Option<&str>,
) -> Result<(), String> {
    let logs = data_dir.join("logs");
    if !enabled(data_dir)? {
        return Ok(());
    }
    ensure_dir(&logs)?;
    let _lock = lock_logs(&logs)?;
    // A second read respects a pause while another hook held the log lock.
    if !enabled(data_dir)? {
        return Ok(());
    }
    let path = logs.join("skipped-raw.json");
    let mut store = match read_optional_private(&path, MAX_STORE_BYTES)? {
        Some(bytes) => {
            let raw = strict_json::parse(&bytes).map_err(|_| "invalid skipped payloads")?;
            let store: Store =
                serde_json::from_value(raw).map_err(|_| "invalid skipped payloads")?;
            if store.version != 1 || store.entries.len() > MAX_ENTRIES {
                return Err("invalid skipped payloads".into());
            }
            store
        }
        None => Store {
            version: 1,
            entries: vec![],
        },
    };
    let payload_fits = json_limit::within(&event["tool_input"], MAX_PAYLOAD_BYTES)?
        && json_limit::within(&event["tool_response"], MAX_PAYLOAD_BYTES)?;
    let mut payload = if payload_fits {
        Some(Payload {
            tool_input_json: serde_json::to_string_pretty(&event["tool_input"])
                .map_err(|_| "skipped input encoding failed")?,
            tool_response_json: serde_json::to_string_pretty(&event["tool_response"])
                .map_err(|_| "skipped response encoding failed")?,
        })
    } else {
        None
    };
    if payload.as_ref().is_some_and(|value| {
        serde_json::to_vec(value).map_or(true, |bytes| bytes.len() > MAX_PAYLOAD_BYTES)
    }) {
        payload = None;
    }
    let payload_unavailable = payload.is_none().then(|| "size_limit".into());
    store.entries.push(Entry {
        id: Uuid::new_v4().simple().to_string(),
        at: Utc::now().to_rfc3339(),
        reason: reason.into(),
        detail: detail.map(str::to_owned),
        tool_name: event["tool_name"]
            .as_str()
            .unwrap_or("unknown")
            .chars()
            .take(256)
            .collect(),
        tool_use_id: event["tool_use_id"]
            .as_str()
            .map(|id| id.chars().take(128).collect()),
        payload,
        payload_unavailable,
    });
    while store.entries.len() > MAX_ENTRIES {
        store.entries.remove(0);
    }
    loop {
        let bytes = serde_json::to_vec(&store).map_err(|_| "skipped payload encoding failed")?;
        if bytes.len() <= MAX_STORE_BYTES {
            return write_private(&path, &bytes, true);
        }
        store.entries.remove(0);
    }
}

#[cfg(test)]
#[path = "raw_skips_tests.rs"]
mod tests;
