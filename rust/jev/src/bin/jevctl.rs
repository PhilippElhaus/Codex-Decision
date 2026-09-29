//! Local configuration and offline inspection for the Rust Jev hook.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

fn write_private(path: &Path, data: &[u8]) -> Result<(), String> {
    if path.is_symlink() {
        return Err("linked file".into());
    }
    let temp = path.with_extension(format!("jev-{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|error| error.to_string())?;
    let result = (|| -> Result<(), String> {
        file.write_all(data).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temp, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn migrate(data_dir: &Path) -> Result<(), String> {
    let path = data_dir.join("config.json");
    if path.is_symlink() {
        return Err("linked config".into());
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let mut raw: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if raw.get("schema_version").and_then(Value::as_u64) == Some(2) {
        return Ok(());
    }
    if raw.get("schema_version").is_some() {
        return Err("unsupported config version".into());
    }
    let config = raw.as_object_mut().ok_or("invalid config")?;
    config.remove("thresholds");
    config.remove("decision_methods");
    config.remove("precompact_enabled");
    config.insert("schema_version".into(), json!(2));
    config.insert(
        "line_policy".into(),
        json!({
        "output":{"omit_min":95,"exact_max":5},
        "test_build":{"omit_min":95,"exact_max":5},
        "search_listing":{"omit_min":95,"exact_max":5}}),
    );
    let rollback = data_dir.join(format!(
        "config.v1.{}.json",
        chrono::Utc::now().format("%Y%m%d%H%M%S")
    ));
    if rollback.exists() {
        return Err("config rollback already exists".into());
    }
    write_private(&rollback, &bytes)?;
    write_private(
        &path,
        &serde_json::to_vec_pretty(&raw).map_err(|error| error.to_string())?,
    )?;
    Ok(())
}

fn set_key(data_dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    if unsafe { libc::isatty(libc::STDIN_FILENO) } != 0 {
        return Err("pipe the key on stdin; interactive echo is disabled".into());
    }
    let mut input = String::new();
    io::stdin()
        .read_line(&mut input)
        .map_err(|error| error.to_string())?;
    let key = input.trim();
    if !(8..=4096).contains(&key.len()) || key.chars().any(char::is_whitespace) {
        return Err("invalid key".into());
    }
    let path = data_dir.join(".env");
    write_private(&path, format!("JEV_API_KEY={key}\n").as_bytes())
}

fn package(root: &Path) -> Result<(), String> {
    if !root
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("codex-jev"))
        || root.is_symlink()
        || !root.is_dir()
    {
        return Err("package root must be the canonical codex-jev directory".into());
    }
    let files = [
        ".codex-plugin/plugin.json",
        "skills/jev-output/SKILL.md",
        "hooks/hooks.json",
        "hooks/bin/linux-x86_64/jev-hook",
        "hooks/bin/linux-x86_64/jevctl",
        "assets/logo.png",
        "assets/icon.png",
        "config.example.json",
        "LICENSE",
    ];
    for relative in files {
        let mut path = root.to_path_buf();
        for component in Path::new(relative).components() {
            path.push(component);
            if path.is_symlink() {
                return Err(format!("linked package path: {relative}"));
            }
        }
        if !path.is_file() {
            return Err(format!("missing package file: {relative}"));
        }
    }
    let manifest: Value =
        serde_json::from_slice(&fs::read(root.join(files[0])).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .ok_or("manifest version missing")?;
    if manifest.get("name").and_then(Value::as_str) != Some("codex-jev")
        || version.len() > 64
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".+-_".contains(&byte))
    {
        return Err("invalid package manifest".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for binary in [files[3], files[4]] {
            if fs::metadata(root.join(binary))
                .map_err(|error| error.to_string())?
                .permissions()
                .mode()
                & 0o111
                == 0
            {
                return Err(format!("non-executable package binary: {binary}"));
            }
        }
    }
    let destination_dir = root.join(".local/submission");
    fs::create_dir_all(&destination_dir).map_err(|error| error.to_string())?;
    let destination = destination_dir.join(format!("codex-jev-{version}.zip"));
    if destination.exists() {
        return Err("package archive already exists; change cachebuster before rebuilding".into());
    }
    let stage_root = destination_dir.join("staging");
    let stage = stage_root.join("codex-jev");
    for directory in [&stage_root, &stage] {
        if directory.is_symlink() {
            return Err("linked package stage".into());
        }
        fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    }
    for relative in files {
        let mut target = stage.clone();
        for component in Path::new(relative).components() {
            target.push(component);
            if target.is_symlink() {
                return Err("linked package stage path".into());
            }
        }
        let parent = target.parent().ok_or("invalid staged file")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        fs::copy(root.join(relative), target).map_err(|error| error.to_string())?;
    }
    let args: Vec<String> = files
        .iter()
        .map(|file| format!("codex-jev/{file}"))
        .collect();
    let result = Command::new("zip")
        .current_dir(&stage_root)
        .arg("-q")
        .arg("-X")
        .arg("-9")
        .arg(&destination)
        .args(&args)
        .status()
        .map_err(|error| error.to_string())?;
    if !result.success() {
        return Err("zip failed".into());
    }
    let bytes = fs::read(&destination).map_err(|error| error.to_string())?;
    if bytes.len() > 100_000_000 {
        return Err("package exceeds 100 MB".into());
    }
    let verified = Command::new("unzip")
        .arg("-tqq")
        .arg(&destination)
        .status()
        .map_err(|error| error.to_string())?;
    if !verified.success() {
        return Err("package integrity failed".into());
    }
    println!(
        "{}\nSHA-256 {:x}\n{} allowlisted files",
        destination.display(),
        Sha256::digest(&bytes),
        files.len()
    );
    Ok(())
}

fn read_json(path: &Path, max_bytes: u64) -> Result<Value, String> {
    if path.is_symlink() {
        return Err(format!("linked input: {}", path.display()));
    }
    let details = fs::metadata(path).map_err(|error| error.to_string())?;
    if !details.is_file() || details.len() > max_bytes {
        return Err("invalid input size".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn evaluate_case(receipt: &Value, required: &[usize]) -> Result<Value, String> {
    if receipt.get("version").and_then(Value::as_u64) != Some(2) {
        return Err("expected a version 2 receipt".into());
    }
    let manifest = receipt.get("manifest").ok_or("receipt manifest missing")?;
    let seen = manifest
        .get("lines_seen")
        .and_then(Value::as_u64)
        .ok_or("line count missing")? as usize;
    let decisions = receipt
        .get("decisions")
        .and_then(Value::as_array)
        .ok_or("line decisions missing")?;
    if decisions.len() != seen {
        return Err("incomplete line decisions".into());
    }
    let mut omitted = HashSet::new();
    for (index, decision) in decisions.iter().enumerate() {
        if decision.get("number").and_then(Value::as_u64) != Some((index + 1) as u64) {
            return Err("line order mismatch".into());
        }
        if decision.get("action").and_then(Value::as_str) == Some("omit") {
            omitted.insert(index + 1);
        }
    }
    let mut labels = HashSet::new();
    for number in required {
        if *number == 0 || *number > seen || !labels.insert(*number) {
            return Err("invalid required line".into());
        }
    }
    let mut false_omissions: Vec<usize> = labels.intersection(&omitted).copied().collect();
    false_omissions.sort_unstable();
    let original = manifest
        .get("original_chars")
        .and_then(Value::as_u64)
        .ok_or("original size missing")?;
    let visible = manifest
        .get("visible_chars")
        .and_then(Value::as_u64)
        .ok_or("visible size missing")?;
    let status = manifest
        .get("status")
        .and_then(Value::as_str)
        .ok_or("status missing")?;
    Ok(
        json!({"required":labels.len(),"omitted":omitted.len(),"false_omissions":false_omissions,
        "saved_chars":if status == "replace" { original.saturating_sub(visible) } else { 0 },
        "lines_seen":seen,"lines_judged":manifest.get("lines_judged")}),
    )
}

fn evaluate_quality(cases_path: &Path) -> Result<(), String> {
    let cases = read_json(cases_path, 1_000_000)?;
    let rows = cases.as_array().ok_or("cases must be a JSON array")?;
    if rows.is_empty() || rows.len() > 1000 {
        return Err("cases must contain 1 to 1000 records".into());
    }
    let base = cases_path.parent().ok_or("cases path has no parent")?;
    let mut evaluated = Vec::new();
    for row in rows {
        let relative = row
            .get("receipt")
            .and_then(Value::as_str)
            .ok_or("receipt path missing")?;
        if relative.is_empty() || relative.len() > 4096 {
            return Err("invalid receipt path".into());
        }
        let receipt_path = if Path::new(relative).is_absolute() {
            PathBuf::from(relative)
        } else {
            base.join(relative)
        };
        let receipt = read_json(&receipt_path, 16_000_000)?;
        let required = row
            .get("required_lines")
            .and_then(Value::as_array)
            .ok_or("required lines missing")?
            .iter()
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|number| usize::try_from(number).ok())
                    .ok_or_else(|| "invalid required line".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let split = row
            .get("split")
            .and_then(Value::as_str)
            .unwrap_or("unspecified");
        if !matches!(split, "train" | "holdout" | "unspecified") {
            return Err("invalid split".into());
        }
        let mut outcome = evaluate_case(&receipt, &required)?;
        outcome["split"] = json!(split);
        outcome["case"] = json!(row.get("id").and_then(Value::as_str).unwrap_or("unnamed"));
        if let Some(solved) = row.get("task_solved").and_then(Value::as_bool) {
            outcome["task_solved"] = json!(solved);
        }
        if let Some(solved) = row.get("baseline_task_solved").and_then(Value::as_bool) {
            outcome["baseline_task_solved"] = json!(solved);
        }
        let id = receipt
            .pointer("/manifest/id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let requests = receipt
            .pointer("/manifest/requests")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) && requests <= 12 {
            let mut input_tokens = 0u64;
            let mut output_tokens = 0u64;
            let mut measured = 0u64;
            for index in 1..=requests {
                let batch = receipt_path
                    .parent()
                    .ok_or("receipt has no parent")?
                    .join(format!("batch-{id}-{index}.json"));
                if let Ok(value) = read_json(&batch, 1_000_000) {
                    let usage = value.pointer("/batch/response/usage");
                    if let (Some(input), Some(output)) = (
                        usage
                            .and_then(|row| row.get("input_tokens"))
                            .and_then(Value::as_u64),
                        usage
                            .and_then(|row| row.get("output_tokens"))
                            .and_then(Value::as_u64),
                    ) {
                        input_tokens = input_tokens.saturating_add(input);
                        output_tokens = output_tokens.saturating_add(output);
                        measured += 1;
                    }
                }
            }
            if measured == requests && measured > 0 {
                outcome["billed_input_tokens"] = json!(input_tokens);
                outcome["billed_output_tokens"] = json!(output_tokens);
            }
        }
        evaluated.push(outcome);
    }
    let mut groups = serde_json::Map::new();
    for split in ["train", "holdout", "unspecified"] {
        let selected: Vec<&Value> = evaluated
            .iter()
            .filter(|row| row["split"] == split)
            .collect();
        if selected.is_empty() {
            continue;
        }
        let false_omissions = selected
            .iter()
            .map(|row| row["false_omissions"].as_array().unwrap().len())
            .sum::<usize>();
        let saved_chars = selected
            .iter()
            .map(|row| row["saved_chars"].as_u64().unwrap())
            .sum::<u64>();
        groups.insert(split.into(), json!({"cases":selected.len(),"false_omissions":false_omissions,
            "saved_chars":saved_chars,"task_solved":selected.iter().filter(|row| row["task_solved"] == true).count(),
            "task_outcomes_labeled":selected.iter().filter(|row| row.get("task_solved").is_some()).count(),
            "baseline_task_solved":selected.iter().filter(|row| row["baseline_task_solved"] == true).count(),
            "billed_input_tokens":selected.iter().filter_map(|row| row.get("billed_input_tokens").and_then(Value::as_u64)).sum::<u64>(),
            "billed_output_tokens":selected.iter().filter_map(|row| row.get("billed_output_tokens").and_then(Value::as_u64)).sum::<u64>()}));
    }
    println!("{}", json!({"version":1,"groups":groups,"cases":evaluated}));
    Ok(())
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        return Err("usage: jevctl <migrate-config|set-key> --data-dir <absolute PLUGIN_DATA> | package --root <repository>".into());
    }
    if args[1] == "package" && args[2] == "--root" {
        return package(&PathBuf::from(&args[3]));
    }
    if args[1] == "evaluate-quality" && args[2] == "--cases" {
        return evaluate_quality(&PathBuf::from(&args[3]));
    }
    if args[2] != "--data-dir" {
        return Err("expected --data-dir".into());
    }
    let data_dir = PathBuf::from(&args[3]);
    if !data_dir.is_absolute() || data_dir.is_symlink() || !data_dir.is_dir() {
        return Err("unsafe data directory".into());
    }
    match args[1].as_str() {
        "migrate-config" => migrate(&data_dir),
        "set-key" => set_key(&data_dir),
        _ => Err("unknown command".into()),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("jevctl: {error}");
        std::process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quality_audit_counts_required_lines_lost_by_filter() {
        let receipt = json!({"version":2,
            "manifest":{"lines_seen":3,"lines_judged":3,"original_chars":100,"visible_chars":45,"status":"replace"},
            "decisions":[{"number":1,"action":"keep"},{"number":2,"action":"omit"},
                {"number":3,"action":"keep"}]});
        let result = evaluate_case(&receipt, &[1, 2]).unwrap();
        assert_eq!(result["false_omissions"], json!([2]));
        assert_eq!(result["saved_chars"], 55);
        assert!(evaluate_case(&receipt, &[4]).is_err());
    }
}
