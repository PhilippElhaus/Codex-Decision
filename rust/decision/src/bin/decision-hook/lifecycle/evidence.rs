//! Opt-in, bounded evidence from this turn. Never scan private chat history.
use super::*;
const LIMIT: usize = 24_000;

fn filename(scoped: &Path) -> PathBuf {
    scoped.join("logs/completion-evidence.json")
}

pub(super) fn load(scoped: &Path, turn: &str) -> Result<Option<Value>, String> {
    let Some(bytes) = private_backup(&filename(scoped), LIMIT)? else {
        return Ok(None);
    };
    let snapshot = strict_json::parse(&bytes).map_err(|_| "invalid completion evidence")?;
    if snapshot["version"] != 1
        || snapshot["turn_key"] != turn
        || snapshot["evidence"].as_array().is_none_or(|a| a.len() > 8)
    {
        return Ok(None);
    }
    Ok(Some(snapshot))
}

pub(super) fn capture(scoped: &Path, event: &Value) -> Result<(), String> {
    let Some(turn) = turn_key(event) else {
        return Ok(());
    };
    let prepared = PreparedResponse::new(event);
    let source = prepared
        .source()
        .filter(|s| !s.trim().is_empty() && s.len() <= 12_000);
    let command = command(event);
    let usable = source.is_some_and(|source| {
        command.len() <= 2048
            && !sensitive_source(source)
            && !sensitive_context(command)
            && !sensitive_input(event)
    });
    let logs = scoped.join("logs");
    ensure_dir(&logs)?;
    let _lock = lock_logs(&logs)?;
    let mut snapshot = load(scoped, &turn)?.unwrap_or_else(
        || json!({"version":1,"turn_key":turn,"continued":false,"incomplete":false,"evidence":[]}),
    );
    if !usable {
        snapshot["incomplete"] = json!(true);
        return write_private(
            &filename(scoped),
            &serde_json::to_vec(&snapshot).unwrap(),
            true,
        );
    }
    let source = source.unwrap();
    let item = json!({"kind":"observation","content":format!("Tool command (untrusted text): {command}\nObserved result:\n{source}")});
    let rows = snapshot["evidence"]
        .as_array_mut()
        .ok_or("invalid evidence rows")?;
    rows.push(item);
    if rows.len() > 8 {
        rows.remove(0);
        snapshot["incomplete"] = json!(true);
    }
    loop {
        let bytes = serde_json::to_vec(&snapshot).map_err(|_| "evidence encoding")?;
        if bytes.len() <= LIMIT {
            return write_private(&filename(scoped), &bytes, true);
        }
        snapshot["evidence"].as_array_mut().unwrap().remove(0);
        snapshot["incomplete"] = json!(true);
    }
}

pub(super) fn mark_continued(scoped: &Path, turn: &str, expected: &Value) -> Result<bool, String> {
    let logs = scoped.join("logs");
    ensure_dir(&logs)?;
    let _lock = lock_logs(&logs)?;
    let Some(mut current) = load(scoped, turn)? else {
        return Ok(false);
    };
    if &current != expected || current["continued"] == true || current["incomplete"] != false {
        return Ok(false);
    }
    current["continued"] = json!(true);
    write_private(
        &filename(scoped),
        &serde_json::to_vec(&current).unwrap(),
        true,
    )?;
    Ok(true)
}
