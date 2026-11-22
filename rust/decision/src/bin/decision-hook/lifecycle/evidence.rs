//! Opt-in, bounded evidence from this turn. Never scan private chat history.
use super::*;
const LIMIT: usize = 24_000;
const TURN_BYTES: usize = 64;
const NONCE_BYTES: usize = 32;
const GENERATION_BYTES: usize = TURN_BYTES + NONCE_BYTES;

fn filename(scoped: &Path) -> PathBuf {
    scoped.join("logs/completion-evidence.json")
}

fn generation_path(scoped: &Path) -> PathBuf {
    scoped.join("logs/.completion-generation")
}

fn read_generation(scoped: &Path) -> Result<Option<Vec<u8>>, String> {
    private_backup(&generation_path(scoped), GENERATION_BYTES)
}

fn read_locked(
    scoped: &Path,
    turn: &str,
    generation: Option<&[u8]>,
) -> Result<Option<Value>, String> {
    let Some(bytes) = private_backup(&filename(scoped), LIMIT)? else {
        return Ok(None);
    };
    let mut snapshot = strict_json::parse(&bytes).map_err(|_| "invalid completion evidence")?;
    if snapshot["version"] != 1
        || snapshot["turn_key"] != turn
        || snapshot["evidence"].as_array().is_none_or(|a| a.len() > 8)
    {
        return Ok(None);
    }
    let matches = generation.is_some_and(|current| {
        current.len() == GENERATION_BYTES
            && &current[..TURN_BYTES] == turn.as_bytes()
            && snapshot["generation"]
                .as_str()
                .is_some_and(|expected| expected.as_bytes() == &current[TURN_BYTES..])
    });
    if !matches {
        snapshot["incomplete"] = json!(true);
    }
    Ok(Some(snapshot))
}

pub(super) fn load(scoped: &Path, turn: &str) -> Result<Option<Value>, String> {
    let logs = scoped.join("logs");
    check_dir_if_exists(&logs)?;
    if !logs.is_dir() {
        return Ok(None);
    }
    let _lock = lock_completion(&logs)?;
    read_locked(scoped, turn, read_generation(scoped)?.as_deref())
}

pub(super) fn capture(scoped: &Path, event: &Value) -> Result<&'static str, String> {
    capture_with(scoped, event, |path, bytes| {
        write_private(path, bytes, true)
    })
}

pub(super) fn capture_with(
    scoped: &Path,
    event: &Value,
    write: impl Fn(&Path, &[u8]) -> Result<(), String>,
) -> Result<&'static str, String> {
    let Some(turn) = turn_key(event) else {
        return Ok("unbound");
    };
    let logs = scoped.join("logs");
    ensure_dir(&logs)?;
    let _lock = lock_completion(&logs)?;
    let previous = read_generation(scoped)?;
    let prior = read_locked(scoped, &turn, previous.as_deref())?;
    let had_capture = previous
        .as_ref()
        .is_some_and(|marker| marker.starts_with(turn.as_bytes()));
    let mut snapshot = prior.unwrap_or_else(
        || json!({"version":1,"turn_key":turn,"continued":false,"incomplete":had_capture,"evidence":[]}),
    );
    let generation = Uuid::new_v4().simple().to_string();
    if let Err(error) = write(
        &generation_path(scoped),
        format!("{turn}{generation}").as_bytes(),
    ) {
        snapshot["incomplete"] = json!(true);
        let _ = write(&filename(scoped), &serde_json::to_vec(&snapshot).unwrap());
        return Err(error);
    }
    snapshot["generation"] = json!(generation);
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
    if usable {
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
    } else {
        snapshot["incomplete"] = json!(true);
    }
    loop {
        let bytes = serde_json::to_vec(&snapshot).map_err(|_| "evidence encoding")?;
        if bytes.len() <= LIMIT {
            write(&filename(scoped), &bytes)?;
            return Ok(if snapshot["incomplete"] == false {
                "stored"
            } else {
                "incomplete"
            });
        }
        snapshot["evidence"].as_array_mut().unwrap().remove(0);
        snapshot["incomplete"] = json!(true);
    }
}

pub(super) fn mark_continued(scoped: &Path, turn: &str, expected: &Value) -> Result<bool, String> {
    let logs = scoped.join("logs");
    ensure_dir(&logs)?;
    let _lock = lock_completion(&logs)?;
    let Some(mut current) = read_locked(scoped, turn, read_generation(scoped)?.as_deref())? else {
        return Ok(false);
    };
    if &current != expected || current["continued"] != false || current["incomplete"] != false {
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
