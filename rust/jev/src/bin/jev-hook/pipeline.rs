//! Fail-open hook orchestration.
use super::*;

pub(super) fn execute() -> Result<Value, String> {
    HOOK_STARTED.with(|started| started.set(Some(Instant::now())));
    let data_dir = std::env::var_os("PLUGIN_DATA")
        .map(PathBuf::from)
        .ok_or("missing plugin data")?;
    if !data_dir.is_absolute() || data_dir.is_symlink() {
        return Err("unsafe plugin data".into());
    }
    ensure_dir(&data_dir)?;
    let mut input = Vec::new();
    std::io::stdin()
        .take(16_000_001)
        .read_to_end(&mut input)
        .map_err(|_| "hook input read")?;
    if input.len() > 16_000_000 {
        return Err("hook input too large".into());
    }
    let event: Value = serde_json::from_slice(&input).map_err(|_| "invalid hook JSON")?;
    let session = event
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or("missing session id")?;
    let scoped = session_dir(&data_dir, session)?;
    check_dir_if_exists(&data_dir.join("sessions"))?;
    check_dir_if_exists(&scoped)?;
    let scoped_config = match fs::symlink_metadata(scoped.join("config.json")) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("config stat failed".into()),
    };
    let selected = (|| {
        let selected = if scoped_config {
            config(&scoped)?
        } else {
            config(&data_dir)?.filter(|global| global.global_scope)
        };
        let Some(mut config) = selected else {
            return Ok(None);
        };
        apply_shared_settings(&data_dir, &mut config)?;
        Ok::<_, String>(Some(config))
    })();
    let selected = match selected {
        Ok(selected) => selected,
        Err(error) => {
            ensure_dir(&data_dir.join("sessions"))?;
            hook_health(&scoped, "error", &error)?;
            return Err(error);
        }
    };
    let Some(config) = selected else {
        return Ok(json!({}));
    };
    if !config.enabled {
        return Ok(json!({}));
    }
    ensure_dir(&data_dir.join("sessions"))?;
    hook_health(&scoped, "seen", "")?;
    let result = process_event(&data_dir, &scoped, &event, &config);
    if let Err(error) = &result {
        if let Err(status_error) = hook_health(&scoped, "error", error) {
            eprintln!("Codex Jev status write failed: {status_error}");
        }
    }
    result
}

pub(super) fn process_event(
    data_dir: &Path,
    scoped: &Path,
    event: &Value,
    config: &Config,
) -> Result<Value, String> {
    if event.get("hook_event_name").and_then(Value::as_str) != Some("PostToolUse") {
        return skip(scoped, "unsupported_event");
    }
    let Some(route) = route(event, config) else {
        return skip(scoped, "unsupported_route");
    };
    let Some(source) = response_text(event) else {
        return skip(scoped, "unsupported_result");
    };
    if source.len() < config.min_chars {
        return skip(scoped, "small");
    }
    if source.len() > config.max_chars {
        return skip(scoped, "large");
    }
    if sensitive(&source) || sensitive(command(event)) || sensitive_input(event) {
        return skip(scoped, "sensitive");
    }
    if serde_json::to_vec(&event["tool_input"])
        .map_err(|_| "tool input encoding")?
        .len()
        > 256 * 1024
    {
        return skip(scoped, "tool_input_budget");
    }
    let user_task = match task_context(event) {
        Ok(task) => task,
        Err(()) => return skip(scoped, "unsafe_task_context"),
    };
    let has_user_task = user_task.is_some();
    let task = user_task.unwrap_or_else(|| fallback_task(event));
    let line_count =
        source.bytes().filter(|byte| *byte == b'\n').count() + usize::from(!source.ends_with('\n'));
    if line_count > MAX_SOURCE_LINES {
        return skip(scoped, "line_budget");
    }
    remaining()?;
    let mut lines = source_lines(&source);
    if lines.is_empty() {
        return skip(scoped, "structured_or_empty");
    }
    protect_neighbors(&mut lines);
    if !lines
        .iter()
        .any(|line| line.eligible && line.protected_reason.is_none())
    {
        return skip(scoped, "no_eligible_lines");
    }
    let api_key = key(data_dir)?;
    let agent = ureq::AgentBuilder::new().build();
    let request = classification_request(
        &task,
        event["tool_name"].as_str().unwrap_or(""),
        command(event),
        &event["tool_response"]["exit_code"]
            .as_i64()
            .map(Value::from)
            .unwrap_or(Value::Null),
        &lines,
        &config.model,
    );
    validate_request_budget(&request)?;
    classification_start(scoped)?;
    let before = Instant::now();
    let response = evaluate(
        &agent,
        &request,
        &api_key,
        config.timeout.min(remaining()?.as_secs_f64()),
    )?;
    let elapsed_ms = before.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    let (kind, excerptable) = classification(&response)?;
    let gate_record = BatchRecord {
        id: 0,
        target_numbers: vec![],
        request,
        response,
        elapsed_ms,
    };
    if !excerptable {
        record_gate_skip(
            scoped,
            event,
            source.chars().count(),
            &gate_record,
            &kind,
            "choice_kept_full_output",
        )?;
        return skip(scoped, "choice_kept_full_output");
    }
    if !apply_route_structure(
        output_format(event).unwrap_or("output"),
        event["tool_name"].as_str().unwrap_or(""),
        command(event),
        &mut lines,
    ) {
        record_gate_skip(
            scoped,
            event,
            source.chars().count(),
            &gate_record,
            &kind,
            "structure_guard",
        )?;
        return skip(scoped, "structure_guard");
    }
    protect_neighbors(&mut lines);
    if !lines
        .iter()
        .any(|line| line.eligible && line.protected_reason.is_none())
    {
        record_gate_skip(
            scoped,
            event,
            source.chars().count(),
            &gate_record,
            &kind,
            "no_eligible_lines",
        )?;
        return skip(scoped, "no_eligible_lines");
    }
    let batches = match relevance_requests(&task, command(event), &kind, &lines, &config.model) {
        Ok(batches) => batches,
        Err(_) => {
            record_gate_skip(
                scoped,
                event,
                source.chars().count(),
                &gate_record,
                &kind,
                "relevance_budget",
            )?;
            return skip(scoped, "relevance_budget");
        }
    };
    let receipt_id = Uuid::new_v4().simple().to_string();
    let mut progress = ProgressSnapshot::new(scoped, receipt_id.clone())?;
    let mut probabilities = BTreeMap::new();
    let mut records = Vec::new();
    let batch_count = batches.len();
    for batch in batches {
        remaining()?;
        let before = Instant::now();
        let response = evaluate(
            &agent,
            &batch.request,
            &api_key,
            config.timeout.min(remaining()?.as_secs_f64()),
        )?;
        for (number, p) in relevance_answers(&batch, &response)? {
            if probabilities.insert(number, (p, batch.id)).is_some() {
                return Err("duplicate relevance target".into());
            }
        }
        let decisions = apply_relevance_batches(&lines, &probabilities, config.policy.relevant_max);
        let record = BatchRecord {
            id: batch.id,
            target_numbers: batch.target_numbers,
            request: batch.request,
            response,
            elapsed_ms: before.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        };
        progress.publish(route, &lines, &decisions, &record, record.id, batch_count)?;
        records.push(record);
    }
    let decisions = apply_relevance_batches(&lines, &probabilities, config.policy.relevant_max);
    let omitted = decisions
        .iter()
        .filter(|row| row.action == Action::Omit)
        .count();
    let candidate = omitted > 0;
    let path = output_path(data_dir, event)?;
    let feedback = render(&source, &lines, &decisions, &path.to_string_lossy());
    let replace = candidate
        && config.mode == "replace"
        && has_user_task
        && (shell_tool(event["tool_name"].as_str().unwrap_or(""))
            && event["tool_response"].is_string()
            || !event["tool_name"]
                .as_str()
                .unwrap_or("")
                .starts_with("mcp__")
                && event["tool_response"].is_string()
            || config.allow_mcp_replacement)
        && feedback.len() + 1024 < source.len()
        && feedback.len() * 10 < source.len() * 7;
    let status = if replace {
        "replace"
    } else if candidate {
        "candidate"
    } else {
        "keep"
    };
    if replace {
        ensure_dir(data_dir)?;
        ensure_dir(&data_dir.join("outputs"))?;
        ensure_dir(path.parent().ok_or("invalid output path")?)?;
        write_private(&path, source.as_bytes(), false)?;
    }
    let visible = if replace {
        feedback.as_str()
    } else {
        source.as_str()
    };
    record(
        scoped,
        event,
        route,
        status,
        &source,
        visible,
        &lines,
        &decisions,
        &records,
        Some(&gate_record),
        config,
        &receipt_id,
        &progress.last_snapshot_id,
    )?;
    // The committed output must survive a later telemetry failure.
    if let Err(error) = hook_health(scoped, "success", "") {
        eprintln!("Codex Jev status write failed: {error}");
    }
    progress.active = false;
    if replace {
        Ok(
            json!({"continue":false,"stopReason":"Line-filtered tool output stored by Codex Jev","reason":feedback}),
        )
    } else {
        Ok(json!({}))
    }
}
