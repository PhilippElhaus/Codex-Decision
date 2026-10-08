//! Fail-open hook orchestration.
use super::*;

#[cfg(test)]
#[path = "guard_attribution_tests.rs"]
mod guard_attribution_tests;

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
    let event = strict_json::parse(&input).map_err(|_| "invalid hook JSON")?;
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
            eprintln!("Codex Decision status write failed: {status_error}");
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
    if !json_limit::within(&event["tool_input"], 256 * 1024)? {
        return skip(scoped, "tool_input_budget");
    }
    let line_count =
        source.bytes().filter(|byte| *byte == b'\n').count() + usize::from(!source.ends_with('\n'));
    if line_count > MAX_SOURCE_LINES {
        return skip(scoped, "line_budget");
    }
    remaining()?;
    let mut lines = source_lines(&source);
    protect_response_metadata(&mut lines);
    protect_lab_streams(event, &mut lines);
    let format = format_decision(event, &mut lines);
    // An exact source read already stays local. Do not mistake source syntax
    // or an unrelated unreadable transcript for an evaluation opportunity.
    if matches!(format, FormatDecision::Keep("exact_content")) {
        return skip(scoped, "exact_content");
    }
    let privacy = if sensitive_source(&source) {
        Some("protected_output")
    } else if sensitive_context(command(event)) {
        Some("protected_command")
    } else if sensitive_input(event) {
        Some("protected_input")
    } else {
        None
    };
    if let Some(detail) = privacy {
        return skip_with_detail(scoped, "sensitive", detail);
    }
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
    if let FormatDecision::Keep(reason) = format {
        return skip(scoped, reason);
    }
    let tool = event["tool_name"].as_str().unwrap_or("");
    if config.mode == "replace"
        && !config.allow_mcp_replacement
        && mcp_tool(tool)
        && !(matches!(format, FormatDecision::Direct(_)) && supported_lab_command(event))
    {
        return skip(scoped, "mcp_replacement_disabled");
    }
    let user_task = match task_context(event) {
        Ok(task) => task,
        Err(()) => return skip(scoped, "unsafe_task_context"),
    };
    let has_user_task = user_task.is_some();
    let task = user_task.unwrap_or_else(|| fallback_task(event));
    if has_user_task && exhaustive_task(&task) {
        return skip(scoped, "exhaustive_task");
    }
    if config.mode == "replace"
        && has_user_task
        && replacement_supported(event)
        && (!preview_only(event) || matches!(format, FormatDecision::Direct(_)))
        && !savings_possible(
            &source,
            &lines,
            &output_path(data_dir, event)?,
            !event["tool_response"].is_string(),
        )
    {
        return skip(scoped, "insufficient_savings");
    }
    let api_key = key(data_dir, config.provider)?;
    let agent = decision_agent();
    classification_start(scoped, config.never_delete_logs)?;
    let (kind, gate_record) = if let FormatDecision::Direct(kind) = format {
        (kind.to_owned(), None)
    } else {
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
        let before = Instant::now();
        let (response, (kind, excerptable)) = evaluate(
            scoped,
            &agent,
            &request,
            &api_key,
            config.timeout.min(remaining()?.as_secs_f64()),
            classification,
        )?;
        let elapsed_ms = before.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
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
                config.never_delete_logs,
            )?;
            return skip(scoped, "choice_kept_full_output");
        }
        (kind, Some(gate_record))
    };
    if !lines
        .iter()
        .any(|line| line.eligible && line.protected_reason.is_none())
    {
        if let Some(gate_record) = &gate_record {
            record_gate_skip(
                scoped,
                event,
                source.chars().count(),
                gate_record,
                &kind,
                "no_eligible_lines",
                config.never_delete_logs,
            )?;
        }
        return skip(scoped, "no_eligible_lines");
    }
    let batches = match relevance_requests(&task, command(event), &kind, &lines, &config.model) {
        Ok(batches) => batches,
        Err(_) => {
            if let Some(gate_record) = &gate_record {
                record_gate_skip(
                    scoped,
                    event,
                    source.chars().count(),
                    gate_record,
                    &kind,
                    "relevance_budget",
                    config.never_delete_logs,
                )?;
            }
            return skip(scoped, "relevance_budget");
        }
    };
    let receipt_id = Uuid::new_v4().simple().to_string();
    let mut progress = ProgressSnapshot::new(scoped, receipt_id.clone())?;
    progress.classification_requests = usize::from(gate_record.is_some());
    let mut probabilities = BTreeMap::new();
    let mut records = Vec::new();
    let batch_count = batches.len();
    for batch in batches {
        remaining()?;
        let before = Instant::now();
        let (response, answers) = evaluate(
            scoped,
            &agent,
            &batch.request,
            &api_key,
            config.timeout.min(remaining()?.as_secs_f64()),
            |response| relevance_answers(&batch, response),
        )?;
        for (number, p) in answers {
            if probabilities.insert(number, (p, batch.id)).is_some() {
                return Err("duplicate relevance target".into());
            }
        }
        let record = BatchRecord {
            id: batch.id,
            target_numbers: batch.target_numbers,
            request: batch.request,
            response,
            elapsed_ms: before.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        };
        if progress.should_publish(lines.len(), record.id, batch_count) {
            let decisions =
                apply_relevance_batches(&lines, &probabilities, config.policy.relevant_max);
            progress.publish(route, &lines, &decisions, &record, record.id, batch_count)?;
        }
        records.push(record);
    }
    let decisions = apply_relevance_batches(&lines, &probabilities, config.policy.relevant_max);
    let omitted = decisions
        .iter()
        .filter(|row| row.action == Action::Omit)
        .count();
    let candidate = omitted > 0;
    let path = output_path(data_dir, event)?;
    let mut feedback = render(&source, &lines, &decisions, &path.to_string_lossy());
    if !event["tool_response"].is_string() {
        feedback.insert_str(
            0,
            &format!(
                "[Original tool envelope: {}]\n",
                path.with_extension("json").display()
            ),
        );
    }
    let blocker = replacement_blocker(
        event,
        config,
        has_user_task,
        matches!(format, FormatDecision::Direct(_)),
        &source,
        &feedback,
    );
    let replace = candidate && blocker.is_none();
    let status = if replace {
        "replace"
    } else if candidate {
        "candidate"
    } else {
        "keep"
    };
    let originals = if replace {
        ensure_dir(data_dir)?;
        ensure_dir(&data_dir.join("outputs"))?;
        ensure_dir(path.parent().ok_or("invalid output path")?)?;
        Some(SavedOriginals::save(
            &path,
            &source,
            &event["tool_response"],
        )?)
    } else {
        None
    };
    let visible = if replace {
        feedback.as_str()
    } else {
        source.as_ref()
    };
    record(
        scoped,
        event,
        route,
        status,
        if candidate {
            blocker.unwrap_or("relevance_policy")
        } else {
            "no_omissions"
        },
        &source,
        visible,
        &lines,
        &decisions,
        &records,
        gate_record.as_ref(),
        config,
        &receipt_id,
        &progress.last_snapshot_id,
    )?;
    if let Some(originals) = originals {
        originals.commit();
    }
    progress.active = false;
    // The committed output must survive a later telemetry failure.
    if let Err(error) = hook_health(scoped, "success", "") {
        eprintln!("Codex Decision status write failed: {error}");
    }
    if replace {
        Ok(
            json!({"continue":false,"stopReason":"Line-filtered tool output stored by Codex Decision","reason":feedback}),
        )
    } else {
        Ok(json!({}))
    }
}
