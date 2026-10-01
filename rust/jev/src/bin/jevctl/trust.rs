use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

fn hook_status(result: &Value, wanted: Option<&str>) -> Result<(String, String), String> {
    let entries = result["data"]
        .as_array()
        .ok_or("Codex returned invalid hook status")?;
    let matching: Vec<&Value> = entries
        .iter()
        .filter_map(|entry| entry["hooks"].as_array())
        .flat_map(|hooks| hooks.iter())
        .filter(|hook| {
            let id = hook["pluginId"].as_str().unwrap_or("");
            hook["source"] == "plugin"
                && hook["eventName"] == "postToolUse"
                && wanted.map_or_else(|| id.starts_with("codex-jev@"), |wanted| id == wanted)
        })
        .collect();
    if matching.len() != 1 {
        return Err("expected one installed Jev PostToolUse hook".into());
    }
    let hook = matching[0];
    if hook["handlerType"] != "command" {
        return Err("Jev PostToolUse is not a command hook".into());
    }
    let id = hook["pluginId"].as_str().ok_or("hook plugin ID missing")?;
    let status = if hook["enabled"] == true {
        hook["trustStatus"].as_str().unwrap_or("unknown")
    } else {
        "disabled"
    };
    Ok((id.to_owned(), status.to_owned()))
}

pub fn check_hook_trust(cwd: &Path, plugin_id: Option<&str>) -> Result<(), String> {
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err("invalid working directory".into());
    }
    let mut child = Command::new("codex")
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Codex app-server failed: {error}"))?;
    let result = (|| -> Result<Value, String> {
        let input = child.stdin.as_mut().ok_or("Codex stdin unavailable")?;
        for message in [
            json!({"method":"initialize","id":1,"params":{"clientInfo":{
                "name":"codex_jev_trust_check","title":"Codex Jev Trust Check","version":"0.1.0"}}}),
            json!({"method":"initialized","params":{}}),
            json!({"method":"hooks/list","id":2,"params":{"cwds":[cwd]}}),
        ] {
            writeln!(input, "{message}").map_err(|error| error.to_string())?;
        }
        input.flush().map_err(|error| error.to_string())?;
        let output = child.stdout.take().ok_or("Codex stdout unavailable")?;
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output.take(2_000_001));
            let mut total = 0usize;
            let answer = loop {
                let mut line = Vec::new();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) => break Err("Codex did not return hook status".into()),
                    Ok(length) => {
                        total += length;
                        if total > 2_000_000 {
                            break Err("Codex hook status response is too large".into());
                        }
                        match serde_json::from_slice::<Value>(&line) {
                            Ok(value) if value["id"] == 2 => {
                                if value.get("error").is_some() || !value["result"].is_object() {
                                    break Err("Codex could not list hooks".into());
                                }
                                break Ok(value["result"].clone());
                            }
                            Ok(_) => {}
                            Err(_) => break Err("Codex returned invalid hook JSON".into()),
                        }
                    }
                    Err(error) => break Err(format!("Codex hook read failed: {error}")),
                }
            };
            let _ = sender.send(answer);
        });
        receiver
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "Codex did not return hook status before timeout".to_owned())?
    })();
    let _ = child.kill();
    let _ = child.wait();
    let (id, status) = hook_status(&result?, plugin_id)?;
    if status != "trusted" {
        return Err(format!("{id} PostToolUse is {status}. Open /hooks in Codex, review and trust it, then start a new thread."));
    }
    println!("{id} PostToolUse is trusted and enabled.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_requires_one_trusted_matching_command_hook() {
        let entry = json!({"data":[{"hooks":[{"source":"plugin","eventName":"postToolUse",
            "pluginId":"codex-jev@personal","handlerType":"command","enabled":true,
            "trustStatus":"trusted"}]}]});
        assert_eq!(hook_status(&entry, None).unwrap().1, "trusted");
        assert_eq!(
            hook_status(&entry, Some("codex-jev@personal")).unwrap().1,
            "trusted"
        );
        assert!(hook_status(&entry, Some("codex-jev@other")).is_err());
        let mut disabled = entry.clone();
        disabled["data"][0]["hooks"][0]["enabled"] = json!(false);
        assert_eq!(hook_status(&disabled, None).unwrap().1, "disabled");
    }
}
