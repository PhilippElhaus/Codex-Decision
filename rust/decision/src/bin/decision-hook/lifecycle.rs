//! Model observations and completion review stay separate from output filtering.
use super::*;

#[path = "lifecycle/evidence.rs"]
mod evidence;

fn turn_key(event: &Value) -> Option<String> {
    let turn = event["turn_id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)?;
    let agent = event["agent_id"].as_str().unwrap_or("");
    if agent.len() > 256 {
        return None;
    }
    Some(format!(
        "{:x}",
        Sha256::digest(format!("{turn}\0{agent}").as_bytes())
    ))
}

fn emit(scoped: &Path, event: &Value, config: &Config, mut row: Value) {
    row["turn_key"] = json!(turn_key(event));
    row["mode"] = json!(config.mode);
    usage::observation(scoped, row, config.never_delete_logs);
}

pub(super) fn capture_output(
    data_dir: &Path,
    scoped: &Path,
    event: &Value,
) -> Option<&'static str> {
    if event["hook_event_name"] != "PostToolUse" {
        return None;
    }
    Some(match assistance_runtime::completion_mode(data_dir) {
        Ok(mode) if mode == "off" => "off",
        Ok(_) => evidence::capture(scoped, event).unwrap_or("unavailable"),
        Err(_) => "unavailable",
    })
}

pub(super) fn output(
    scoped: &Path,
    event: &Value,
    config: &Config,
    result: &Result<Value, String>,
    capture: Option<&'static str>,
) {
    let Some(capture) = capture else {
        return;
    };
    let prepared = PreparedResponse::new(event);
    emit(
        scoped,
        event,
        config,
        json!({"event":"tool_output","source_bytes":prepared.source().map(str::len),
        "prepared_replacement":result.as_ref().ok().is_some_and(|v|v["continue"]==false),
        "outcome":if result.is_ok(){"completed"}else{"failed"},"delivery":"unverified",
        "completion_capture":capture}),
    );
}

pub(super) fn process(
    data_dir: &Path,
    scoped: &Path,
    event: &Value,
    config: &Config,
) -> Result<Value, String> {
    match event["hook_event_name"].as_str() {
        Some("PreModelRequest") => emit(
            scoped,
            event,
            config,
            json!({"event":"model_request_start"}),
        ),
        Some("PostModelRequest") => {
            if !matches!(
                event["status"].as_str(),
                Some("completed" | "failed" | "cancelled")
            ) {
                return Ok(json!({}));
            }
            let mut reported = event["token_usage"].clone();
            if reported.get("cached_input_tokens").is_some() {
                reported["input_tokens_details"] =
                    json!({"cached_tokens":reported["cached_input_tokens"]});
            }
            emit(
                scoped,
                event,
                config,
                json!({"event":"model_request","status":event["status"],
                "usage":codex_decision::assistance::usage(Some(&reported)),"delivery":"unverified"}),
            );
        }
        Some("Stop") => return review(data_dir, scoped, event, config),
        _ => {}
    }
    Ok(json!({}))
}

fn review(data_dir: &Path, scoped: &Path, event: &Value, config: &Config) -> Result<Value, String> {
    let mode = assistance_runtime::completion_mode(data_dir)?;
    if mode == "off" || event["stop_hook_active"] != false {
        return Ok(json!({}));
    }
    let Some(turn) = turn_key(event) else {
        return Ok(json!({}));
    };
    let Some(message) = event["last_assistant_message"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 8192)
    else {
        return Ok(json!({}));
    };
    let snapshot = match evidence::load(scoped, &turn) {
        Ok(Some(snapshot)) => snapshot,
        result => {
            emit(
                scoped,
                event,
                config,
                json!({"event":"completion_review",
                "outcome":if result.is_ok(){"missing_evidence"}else{"evidence_unavailable"},
                "evidence_coverage":"unknown", "continued":false}),
            );
            return Ok(json!({}));
        }
    };
    if snapshot["continued"] == true {
        return Ok(json!({}));
    }
    let coverage = if snapshot["incomplete"] == false {
        "observed_window"
    } else {
        "incomplete"
    };
    if snapshot["evidence"].as_array().is_none_or(Vec::is_empty) {
        emit(
            scoped,
            event,
            config,
            json!({"event":"completion_review","outcome":"missing_evidence",
            "evidence_coverage":coverage, "continued":false}),
        );
        return Ok(json!({}));
    }
    let input = json!({"workflow":"verify_completion","session_id":event["session_id"],
        "claims":[message],"evidence":snapshot["evidence"]});
    let reviewed = match assistance_runtime::judge_with_config(data_dir, &input, config) {
        Ok(result) => result,
        Err(_) => {
            emit(
                scoped,
                event,
                config,
                json!({"event":"completion_review","outcome":"unavailable",
                    "evidence_coverage":coverage, "continued":false}),
            );
            return Ok(json!({}));
        }
    };
    // A tool result can arrive during the request. A stale snapshot cannot
    // continue a turn. The private marker also bounds repeated Stop callbacks.
    let disposition = if mode != "enforce" || reviewed["continuation_recommended"] != true {
        "not_requested"
    } else if snapshot["incomplete"] != false {
        "incomplete_evidence"
    } else {
        match evidence::mark_continued(scoped, &turn, &snapshot) {
            Ok(true) => "requested",
            Ok(false) => "evidence_changed",
            Err(_) => "state_unavailable",
        }
    };
    let continuation = disposition == "requested";
    emit(
        scoped,
        event,
        config,
        json!({"event":"completion_review","outcome":"reviewed",
        "evidence_coverage":coverage,"continuation_status":disposition,
        "needs_review":reviewed["needs_review"],"continued":continuation,"usage":reviewed["usage"]}),
    );
    if continuation {
        Ok(
            json!({"decision":"block","reason":"Decision found a contradiction between the completion report and the recorded tool observations. Recheck those observations, run any necessary focused verification, and correct unsupported completion or validation claims."}),
        )
    } else if reviewed["needs_review"] == true {
        Ok(
            json!({"systemMessage":"Decision completion review: the recorded evidence does not establish every completion claim. Review the claims and verification scope."}),
        )
    } else {
        Ok(json!({}))
    }
}

#[cfg(test)]
#[path = "lifecycle/tests.rs"]
mod tests;
