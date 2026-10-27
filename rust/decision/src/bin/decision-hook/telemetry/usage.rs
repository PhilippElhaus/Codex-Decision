//! Best-effort metadata for retained-window audits. Never stores tool or provider text.
use super::super::*;
use std::cell::RefCell;

#[path = "usage_log.rs"]
mod log;

thread_local! {
    static CURRENT: RefCell<Option<Invocation>> = const { RefCell::new(None) };
}

struct Invocation {
    scoped: PathBuf,
    id: String,
    started: Instant,
    never_delete: bool,
    summary: Value,
    request_count: u64,
    max_chars: usize,
}

impl Invocation {
    fn emit(&self, event: &str, mut value: Value) {
        value["version"] = json!(1);
        value["event"] = json!(event);
        value["at"] = json!(Utc::now().to_rfc3339());
        value["hook_version"] = json!(env!("CARGO_PKG_VERSION"));
        value["runtime"] = json!(std::env::consts::OS);
        value["invocation_id"] = json!(self.id);
        // Metadata must never affect the filter or turn a committed replacement into an error.
        let _ = log::append(&self.scoped, &value, self.never_delete);
    }
}

pub(crate) fn start(scoped: &Path, event: &Value, config: &Config) {
    let mut summary = json!({"outcome":"skip","reason":"unrecorded",
        "source_bytes":null,"source_chars":null,"source_lines":null,
        "fallback_used":false,"lines_judged":null,"proposed_omitted":null,
        "lines_relevance_below_cutoff":null,"lines_restored_by_guards":null,"prepared_omitted_lines":null,
        "prepared_saved_chars":null,"delivery":"unverified"});
    let family = tool_family(event["tool_name"].as_str().unwrap_or(""));
    summary["tool_family"] = json!(family);
    let invocation = Invocation {
        scoped: scoped.into(),
        id: Uuid::new_v4().simple().to_string(),
        started: Instant::now(),
        never_delete: config.never_delete_logs,
        summary,
        request_count: 0,
        max_chars: config.max_chars,
    };
    invocation.emit(
        "invocation_start",
        json!({"tool_family":family,
        "mode":if config.mode == "replace" { "replace" } else { "observe" },
        "provider":config.provider.name(),"fallback_enabled":config.fallback_enabled,
        "min_chars":config.min_chars,"max_chars":config.max_chars,
        "relevance_max":config.policy.relevant_max}),
    );
    CURRENT.with(|current| *current.borrow_mut() = Some(invocation));
}

fn update(change: impl FnOnce(&mut Invocation)) {
    CURRENT.with(|current| {
        if let Some(invocation) = current.borrow_mut().as_mut() {
            change(invocation);
        }
    });
}

pub(crate) fn source(source: &str) {
    update(|invocation| {
        invocation.summary["source_bytes"] = json!(source.len());
        // Large-output skips need only the already available byte count.
        if source.len() <= invocation.max_chars && invocation.summary["source_chars"].is_null() {
            invocation.summary["source_chars"] = json!(source.chars().count());
            invocation.summary["source_lines"] = json!(
                source.bytes().filter(|b| *b == b'\n').count()
                    + usize::from(!source.is_empty() && !source.ends_with('\n'))
            );
        }
    });
}

pub(crate) fn skipped(reason: &str) {
    update(|invocation| {
        invocation.summary["outcome"] = json!("skip");
        invocation.summary["reason"] = json!(reason_code(reason));
    });
}

pub(crate) fn fallback() {
    update(|invocation| invocation.summary["fallback_used"] = json!(true));
}

pub(crate) fn completed(status: &str, reason: &str, judged: usize, omitted: usize, saved: usize) {
    update(|invocation| {
        invocation.summary["outcome"] = json!(match status {
            "replace" => "replace",
            "candidate" => "candidate",
            _ => "keep",
        });
        invocation.summary["reason"] = json!(reason_code(reason));
        invocation.summary["lines_judged"] = json!(judged);
        invocation.summary["proposed_omitted"] = json!(omitted);
        invocation.summary["prepared_saved_chars"] = json!(saved);
    });
}

pub(crate) fn line_outcomes(
    lines: &[SourceLine],
    decisions: &[codex_decision::LineDecision],
    cutoff: u8,
    replacement: bool,
) {
    update(|invocation| {
        let mut below = 0;
        let mut restored = 0;
        let mut omitted = 0;
        for (line, decision) in lines.iter().zip(decisions) {
            if decision.action == Action::Omit {
                omitted += 1;
            }
            if line.eligible
                && line.protected_reason.is_none()
                && decision.batch_id.is_some()
                && decision
                    .p_task_relevant
                    .is_some_and(|p| p <= f64::from(cutoff) / 100.0)
            {
                below += 1;
                if decision.action != Action::Omit {
                    restored += 1;
                }
            }
        }
        invocation.summary["lines_relevance_below_cutoff"] = json!(below);
        invocation.summary["lines_restored_by_guards"] = json!(restored);
        invocation.summary["prepared_omitted_lines"] = json!(if replacement { omitted } else { 0 });
    });
}

pub(crate) fn finish(result: &Result<Value, String>) {
    CURRENT.with(|current| {
        if let Some(mut invocation) = current.borrow_mut().take() {
            if let Err(error) = result {
                invocation.summary["outcome"] = json!("error");
                invocation.summary["reason"] = json!(error_code(error));
            }
            invocation.summary["elapsed_ms"] = json!(milliseconds(invocation.started));
            invocation.summary["request_count"] = json!(invocation.request_count);
            invocation.emit("invocation", invocation.summary.clone());
        }
    });
}

pub(crate) fn milliseconds(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[allow(clippy::too_many_arguments)] // Only scalar, content-free request measurements cross this boundary.
pub(crate) fn request(
    request: &Value,
    provider: &'static str,
    protocol: &'static str,
    elapsed_ms: u64,
    request_bytes: usize,
    response_bytes: usize,
    http_status: Option<u16>,
    received: bool,
    cancelled: bool,
    error: Option<&str>,
    usage: Option<&Value>,
) {
    update(|invocation| {
        invocation.request_count = invocation.request_count.saturating_add(1);
        let outcome = if cancelled {
            "cancelled"
        } else if http_status.is_some_and(|status| !(200..300).contains(&status)) {
            "http_error"
        } else if error.is_none() {
            "validated"
        } else if !received {
            "transport_error"
        } else {
            "invalid_response"
        };
        invocation.emit("request", json!({"request_index":invocation.request_count,
            "stage":if request.pointer("/questions/output_kind/type").and_then(Value::as_str) == Some("choice")
                { "classification" } else { "relevance" },
            "provider":provider,
            "protocol":protocol,"elapsed_ms":elapsed_ms,
            "request_bytes":request_bytes,"response_bytes":response_bytes,"http_status":http_status,
            "outcome":outcome,"error_code":error.map(error_code),
            "input_tokens":usage.and_then(|u| u["input_tokens"].as_u64()),
            "output_tokens":usage.and_then(|u| u["output_tokens"].as_u64())}));
    });
}

fn tool_family(tool: &str) -> &'static str {
    let tool = tool.strip_prefix("functions.").unwrap_or(tool);
    match tool {
        "Bash" | "exec_command" | "write_stdin" => "shell",
        "exec" | "wait" => "code_mode",
        _ if tool.starts_with("mcp__lab_control__") => "native_lab",
        _ if tool.starts_with("mcp__") => "other_mcp",
        _ => "other",
    }
}

fn reason_code(reason: &str) -> &'static str {
    match reason {
        "unsupported_event" => "unsupported_event",
        "unsupported_route" => "unsupported_route",
        "unsupported_result" => "unsupported_result",
        "small" => "small",
        "large" => "large",
        "tool_input_budget" => "tool_input_budget",
        "line_budget" => "line_budget",
        "exact_content" => "exact_content",
        "sensitive" => "sensitive",
        "structured_or_empty" => "structured_or_empty",
        "no_eligible_lines" => "no_eligible_lines",
        "structure_guard" => "structure_guard",
        "mcp_replacement_disabled" => "mcp_replacement_disabled",
        "unsafe_task_context" => "unsafe_task_context",
        "exhaustive_task" => "exhaustive_task",
        "insufficient_savings" => "insufficient_savings",
        "choice_kept_full_output" => "choice_kept_full_output",
        "relevance_budget" => "relevance_budget",
        "relevance_policy" => "relevance_policy",
        "no_omissions" => "no_omissions",
        "observe" => "observe",
        "missing_task_context" => "missing_task_context",
        "unsupported_command" => "unsupported_command",
        "unsupported_envelope" => "unsupported_envelope",
        _ => "unrecorded",
    }
}

fn error_code(error: &str) -> &'static str {
    match error {
        "hook deadline" => "hook_deadline",
        "missing credential" => "missing_credential",
        "Decision request failed" => "request_failed",
        "Decision response read failed" => "response_read_failed",
        "Decision response too large" => "response_too_large",
        "invalid decision response" => "invalid_json",
        "Decision context budget" => "request_budget",
        "log lock timeout" => "log_lock_timeout",
        // This branch deliberately does not persist free-form validation or filesystem errors.
        _ => "local_or_validation_error",
    }
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
