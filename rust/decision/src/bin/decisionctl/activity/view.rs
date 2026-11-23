//! Read the same activity ledger for the companion's live and installation views.
use super::*;
use codex_decision::activity_counters::counters_conflict;
use std::collections::BTreeSet;

const SAFE: u64 = 9_007_199_254_740_991;
const TOTALS: &[&str] = &["calls", "completed", "replaced", "timed", "elapsedMs"];
const MAPS: &[&str] = &["skipCounts", "skipDetails", "candidateReasons"];

fn enforce_safe_numbers(value: &Value) -> Result<(), String> {
    match value {
        Value::Number(number) if number.as_u64().is_none_or(|number| number > SAFE) => {
            Err("Decision activity exceeds the exact numeric range".into())
        }
        Value::Object(values) => values.values().try_for_each(enforce_safe_numbers),
        Value::Array(values) => values.iter().try_for_each(enforce_safe_numbers),
        _ => Ok(()),
    }
}

fn health(directory: &Path) -> Result<Value, String> {
    let path = directory.join("logs/hook-health.json");
    codex_decision::check_ancestors(&directory.join("logs"))?;
    let value = snapshot::load(&path, 4096)?;
    if value["version"] != 1
        || value["hook_version"].as_str().is_none()
        || value["last_seen_ms"].as_u64().is_none()
    {
        if value == json!({})
            && fs::symlink_metadata(&path)
                .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
        {
            return Ok(value);
        }
        return Err("invalid Decision hook health".into());
    }
    enforce_safe_numbers(&value)?;
    Ok(value)
}

fn session(directory: &Path) -> Result<Value, String> {
    codex_decision::check_ancestors(directory)?;
    let (stats, recorded) = publication::read_view_stats(directory)?;
    enforce_safe_numbers(&stats)?;
    if recorded && TOTALS.iter().any(|name| stats[name].as_u64().is_none()) {
        return Err("invalid Decision stats file".into());
    }
    let mut hook = health(directory)?;
    if counters_conflict(&stats, &hook) {
        hook = health(directory)?;
    }
    let mut view = snapshot::metrics(&stats, &hook)?;
    for name in &TOTALS[1..] {
        // Older UI records display retained completion minima as zero if no
        // complete event is available. Coverage still marks them partial.
        view[*name] = json!(stats[name].as_u64().unwrap_or(0));
    }
    view["savedChars"] = if !recorded
        && stats["completed"].as_u64().unwrap_or(0) == 0
        && (stats != json!({}) || hook != json!({}))
    {
        Value::Null
    } else {
        view["savedChars"].take()
    };
    view["estimatedTokensSaved"] = estimate_tokens(&view["savedChars"]);
    view["overflowCounters"] = json!([]);
    view["hookHealth"] = if hook == json!({}) { Value::Null } else { hook };
    Ok(view)
}

fn estimate_tokens(characters: &Value) -> Value {
    characters.as_u64().map_or(Value::Null, |value| {
        json!(value / 4 + u64::from(value % 4 >= 2))
    })
}

fn sum(a: &Value, b: &Value, overflow: &mut BTreeSet<String>, name: &str) -> Value {
    let (Some(a), Some(b)) = (a.as_u64(), b.as_u64()) else {
        return Value::Null;
    };
    if let Some(count) = a.checked_add(b).filter(|count| *count <= SAFE) {
        return json!(count);
    }
    overflow.insert(name.into());
    Value::Null
}

fn installation(directory: &Path) -> Result<Value, String> {
    let mut totals = session(directory)?;
    let values = totals
        .as_object_mut()
        .ok_or("invalid Decision activity totals")?;
    values.remove("hookHealth");
    let sessions = directory.join("sessions");
    codex_decision::check_ancestors(&sessions)?;
    let entries = match fs::read_dir(&sessions) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(totals),
        Err(_) => return Err("Decision sessions could not be read".into()),
    };
    let mut partial = BTreeSet::new();
    let mut overflow = BTreeSet::new();
    for (index, entry) in entries.enumerate() {
        if index >= 10_000 {
            return Err("Too many Decision sessions".into());
        }
        let entry = entry.map_err(|_| "Decision sessions could not be read")?;
        let name = entry.file_name();
        if !name.to_str().is_some_and(|name| {
            name.len() == 64
                && name
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        }) {
            continue;
        }
        let next = session(&entry.path())?;
        for (key, value) in values.iter_mut() {
            match key.as_str() {
                "partialCounters" => {
                    partial.extend(
                        value
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(str::to_owned),
                    );
                    partial.extend(
                        next[key]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(str::to_owned),
                    );
                }
                "overflowCounters" | "averageMs" | "estimatedTokensSaved" => {}
                "skipReasonsPartial" | "skipDetailsPartial" => {
                    *value = json!(*value == true || next[key] == true);
                }
                key if MAPS.contains(&key) => {
                    let map = value
                        .as_object_mut()
                        .ok_or("invalid Decision activity map")?;
                    for (reason, count) in next[key]
                        .as_object()
                        .ok_or("invalid Decision activity map")?
                    {
                        let previous = map.entry(reason).or_insert(json!(0));
                        *previous = sum(previous, count, &mut overflow, &format!("{key}.{reason}"));
                    }
                }
                key => *value = sum(value, &next[key], &mut overflow, key),
            }
        }
    }
    partial.extend(
        totals["partialCounters"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned),
    );
    totals["averageMs"] = match (totals["elapsedMs"].as_u64(), totals["timed"].as_u64()) {
        (Some(elapsed), Some(timed))
            if !["averageMs", "elapsedMs", "timed"]
                .iter()
                .any(|name| partial.contains(*name)) =>
        {
            json!(snapshot::rounded_average(elapsed, timed))
        }
        _ => Value::Null,
    };
    totals["estimatedTokensSaved"] = estimate_tokens(&totals["savedChars"]);
    if overflow.contains("savedChars") {
        overflow.insert("estimatedTokensSaved".into());
    }
    if overflow.contains("elapsedMs") || overflow.contains("timed") {
        overflow.insert("averageMs".into());
    }
    totals["partialCounters"] = json!(partial);
    totals["overflowCounters"] = json!(overflow);
    Ok(totals)
}

pub(in crate::activity) fn read_directory(action: &str, directory: &Path) -> Result<Value, String> {
    if !directory.is_absolute() {
        return Err("invalid Decision activity scope".into());
    }
    match action {
        "--session-directory" => session(directory),
        "--installation" => installation(directory),
        _ => Err("invalid Decision activity view".into()),
    }
}

pub(crate) fn run(action: &str, directory: &Path) -> Result<(), String> {
    let result = read_directory(action, directory)?;
    println!("{}", json!({"version":1,"activity":result}));
    Ok(())
}
