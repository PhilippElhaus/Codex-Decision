//! Exact-line Jev decisions. Network, storage, and Codex hook I/O live in the binaries.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const MAX_REQUEST_BYTES: usize = 28_000;
pub const MAX_TARGETS_PER_BATCH: usize = 250;
pub const MAX_BATCHES: usize = 12;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct LinePolicy {
    pub omit_min: u8,
    pub exact_max: u8,
}

impl Default for LinePolicy {
    fn default() -> Self {
        Self {
            omit_min: 95,
            exact_max: 5,
        }
    }
}

impl LinePolicy {
    pub fn valid(&self) -> bool {
        self.omit_min <= 100 && self.exact_max <= 100
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceLine {
    pub number: usize,
    pub byte_start: usize,
    pub byte_end: usize,
    pub model_text: String,
    pub protected_reason: Option<String>,
    pub eligible: bool,
}

impl SourceLine {
    pub fn source<'a>(&self, source: &'a str) -> &'a str {
        &source[self.byte_start..self.byte_end]
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LineDecision {
    pub number: usize,
    pub p_can_omit: Option<f64>,
    pub p_exact_needed: Option<f64>,
    pub action: Action,
    pub protected_reason: Option<String>,
    pub batch_id: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Keep,
    Omit,
    KeepUnjudged,
}

#[derive(Clone, Debug)]
pub struct Batch {
    pub id: usize,
    pub target_numbers: Vec<usize>,
    pub request: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BatchRecord {
    pub id: usize,
    pub target_numbers: Vec<usize>,
    pub request: Value,
    pub response: Value,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug)]
pub struct Judged {
    pub lines: Vec<SourceLine>,
    pub decisions: Vec<LineDecision>,
    pub batches: Vec<BatchRecord>,
}

pub fn source_lines(source: &str) -> Vec<SourceLine> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, byte) in source.bytes().enumerate() {
        if byte == b'\n' {
            lines.push(source_line(source, lines.len() + 1, start, index + 1));
            start = index + 1;
        }
    }
    if start < source.len() {
        lines.push(source_line(source, lines.len() + 1, start, source.len()));
    }
    lines
}

fn source_line(source: &str, number: usize, start: usize, end: usize) -> SourceLine {
    let original = &source[start..end];
    let text = original.trim_end_matches(['\r', '\n']);
    let clean = strip_ansi(text);
    let lower = clean.to_ascii_lowercase();
    let reason = if clean.trim().is_empty() {
        Some("blank".into())
    } else if clean.len() > 4096 {
        Some("long_line".into())
    } else if [
        "error",
        "failed",
        "failure",
        "warning",
        "fatal",
        "panic",
        "exception",
        "traceback",
        "assertion",
        "not ok",
        "segmentation fault",
        "^c",
        "build successful",
        "test result:",
        "ran ",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        Some("diagnostic_or_completion".into())
    } else {
        None
    };
    SourceLine {
        number,
        byte_start: start,
        byte_end: end,
        model_text: clean,
        protected_reason: reason,
        eligible: true,
    }
}

pub fn strip_ansi(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut clean = String::with_capacity(text.len());
    let mut from = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b && index + 1 < bytes.len() && bytes[index + 1] == b'[' {
            clean.push_str(&text[from..index]);
            index += 2;
            while index < bytes.len() && (bytes[index].is_ascii_digit() || bytes[index] == b';') {
                index += 1;
            }
            if index < bytes.len() && bytes[index].is_ascii_alphabetic() {
                index += 1;
                from = index;
                continue;
            }
            break;
        }
        index += 1;
    }
    clean.push_str(&text[from..]);
    clean
}

pub fn protect_neighbors(lines: &mut [SourceLine]) {
    let mut block = 0usize;
    for line in lines.iter_mut() {
        let lower = line.model_text.to_ascii_lowercase();
        if lower.contains("traceback")
            || lower.contains("assertionerror")
            || lower.contains("panic!")
            || lower.contains("error:")
            || lower.contains("failed:")
        {
            block = 24;
        } else if line.model_text.trim().is_empty()
            || lower.starts_with("test ") && lower.contains(" ... ok")
        {
            block = 0;
        }
        if block > 0 {
            if line.protected_reason.is_none() {
                line.protected_reason = Some("diagnostic_block".into());
            }
            block -= 1;
        }
    }
    let critical: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.protected_reason.as_deref() == Some("diagnostic_or_completion"))
        .map(|(index, _)| index)
        .collect();
    for index in critical {
        for neighbor in index.saturating_sub(1)..=(index + 1).min(lines.len() - 1) {
            if lines[neighbor].protected_reason.is_none() {
                lines[neighbor].protected_reason = Some("diagnostic_context".into());
            }
        }
    }
}

fn request(
    route: &str,
    task: &str,
    command: &str,
    lines: &[SourceLine],
    numbers: &[usize],
    model: &str,
) -> Value {
    let state_lines: Vec<Value> = numbers
        .iter()
        .map(|number| {
            let line = &lines[*number - 1];
            let context = |neighbor: Option<&SourceLine>| -> String {
                neighbor
                    .map(|row| row.model_text.chars().take(100).collect())
                    .unwrap_or_default()
            };
            json!({"id": format!("L{}", number), "text": line.model_text,
            "before": context(number.checked_sub(2).and_then(|index| lines.get(index))),
            "after": context(lines.get(*number))})
        })
        .collect();
    let mut questions = serde_json::Map::new();
    for (index, number) in numbers.iter().enumerate() {
        questions.insert(format!("omit_{number}"), json!({"type":"noul",
            "instructions":format!("Can `state.lines[{index}].text` be omitted without losing task-relevant evidence, a diagnostic, or necessary context?"),
            "criteria":{"true":"The line adds no information needed for this task and its removal is safe.",
                "false":"The line may contain useful evidence, a result, a diagnostic, or required context."}}));
        questions.insert(format!("exact_{number}"), json!({"type":"noul",
            "instructions":format!("Is the exact text or value of `state.lines[{index}].text` needed to understand or verify this result for `state.task`?"),
            "criteria":{"true":"Its exact content may be needed for action or verification.",
                "false":"No unique fact or exact value in this line is needed."}}));
    }
    json!({"model":model, "state":{"task":task,"command":command,"route":route,
        "policy":"Keep diagnostics, results, unique values, and context needed for the task.",
        "lines":state_lines}, "questions":questions})
}

pub fn pack_batches(
    route: &str,
    task: &str,
    command: &str,
    lines: &[SourceLine],
    model: &str,
) -> Vec<Batch> {
    let mut batches = Vec::new();
    let mut current = Vec::new();
    for line in lines.iter().filter(|line| {
        line.eligible
            && line.protected_reason.as_deref() != Some("blank")
            && line.protected_reason.as_deref() != Some("long_line")
    }) {
        let mut proposed = current.clone();
        proposed.push(line.number);
        let oversized = proposed.len() > MAX_TARGETS_PER_BATCH
            || serde_json::to_vec(&request(route, task, command, lines, &proposed, model))
                .map_or(true, |bytes| bytes.len() > MAX_REQUEST_BYTES);
        if oversized && !current.is_empty() {
            batches.push(Batch {
                id: batches.len() + 1,
                request: request(route, task, command, lines, &current, model),
                target_numbers: current,
            });
            current = vec![line.number];
        } else if !oversized {
            current = proposed;
        }
        if batches.len() >= MAX_BATCHES {
            break;
        }
        if serde_json::to_vec(&request(route, task, command, lines, &current, model))
            .map_or(true, |bytes| bytes.len() > MAX_REQUEST_BYTES)
        {
            current.clear(); // One large line is explicitly kept unjudged.
        }
    }
    if !current.is_empty() && batches.len() < MAX_BATCHES {
        batches.push(Batch {
            id: batches.len() + 1,
            request: request(route, task, command, lines, &current, model),
            target_numbers: current,
        });
    }
    batches
}

pub fn parse_probabilities(
    batch: &Batch,
    response: &Value,
) -> Result<BTreeMap<usize, (f64, f64)>, String> {
    let answers = response
        .get("answers")
        .and_then(Value::as_object)
        .ok_or("missing answers")?;
    let expected: HashSet<String> = batch
        .target_numbers
        .iter()
        .flat_map(|number| [format!("omit_{number}"), format!("exact_{number}")])
        .collect();
    if answers.keys().cloned().collect::<HashSet<_>>() != expected {
        return Err("answer ids do not match".into());
    }
    let mut result = BTreeMap::new();
    for number in &batch.target_numbers {
        let read = |prefix: &str| -> Result<f64, String> {
            let answer = answers
                .get(&format!("{prefix}_{number}"))
                .ok_or("missing answer")?;
            if answer.get("type").and_then(Value::as_str) != Some("noul") {
                return Err("answer type changed".into());
            }
            let value = answer
                .get("noul")
                .and_then(Value::as_f64)
                .ok_or("invalid noul")?;
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                return Err("noul out of range".into());
            }
            Ok(value)
        };
        result.insert(*number, (read("omit")?, read("exact")?));
    }
    Ok(result)
}

pub fn apply_probabilities(
    lines: &[SourceLine],
    probabilities: &BTreeMap<usize, (f64, f64, usize)>,
    policy: &LinePolicy,
) -> Vec<LineDecision> {
    let mut decisions: Vec<LineDecision> = lines
        .iter()
        .map(|line| {
            let judged = probabilities.get(&line.number);
            let (omit, exact, batch) = judged
                .map(|(omit, exact, batch)| (Some(*omit), Some(*exact), Some(*batch)))
                .unwrap_or((None, None, None));
            let action = if let Some((p_omit, p_exact, _)) = judged {
                if line.protected_reason.is_none()
                    && *p_omit >= f64::from(policy.omit_min) / 100.0
                    && *p_exact <= f64::from(policy.exact_max) / 100.0
                {
                    Action::Omit
                } else {
                    Action::Keep
                }
            } else {
                Action::KeepUnjudged
            };
            LineDecision {
                number: line.number,
                p_can_omit: omit,
                p_exact_needed: exact,
                action,
                protected_reason: line.protected_reason.clone(),
                batch_id: batch,
            }
        })
        .collect();
    // Retain one representative of a repeated line when none is already kept.
    let mut counts = HashMap::new();
    for line in lines {
        *counts.entry(line.model_text.as_str()).or_insert(0usize) += 1;
    }
    let mut seen: HashSet<String> = lines
        .iter()
        .zip(&decisions)
        .filter(|(_, decision)| decision.action != Action::Omit)
        .map(|(line, _)| line.model_text.clone())
        .collect();
    for (line, decision) in lines.iter().zip(decisions.iter_mut()) {
        if decision.action == Action::Omit
            && counts[&line.model_text.as_str()] > 1
            && seen.insert(line.model_text.clone())
        {
            decision.action = Action::Keep;
            decision.protected_reason = Some("representative".into());
        }
    }
    if let Some(last) = decisions.last_mut() {
        if last.action == Action::Omit {
            last.action = Action::Keep;
            last.protected_reason = Some("last_line".into());
        }
    }
    decisions
}

pub fn render(
    source: &str,
    lines: &[SourceLine],
    decisions: &[LineDecision],
    original_path: &str,
) -> String {
    let omitted = decisions
        .iter()
        .filter(|row| row.action == Action::Omit)
        .count();
    let mut output = format!(
        "[Codex Jev: {omitted} of {} lines omitted; full original: {original_path}]\n",
        lines.len()
    );
    let mut missing = 0;
    for (line, decision) in lines.iter().zip(decisions) {
        if decision.action == Action::Omit {
            missing += 1;
            continue;
        }
        if missing > 0 {
            output.push_str(&format!("[... {missing} source lines omitted ...]\n"));
            missing = 0;
        }
        output.push_str(line.source(source));
    }
    if missing > 0 {
        output.push_str(&format!("[... {missing} source lines omitted ...]\n"));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_unicode_crlf_and_unterminated_line() {
        let source = "α\r\nβ\nlast";
        let lines = source_lines(source);
        assert_eq!(
            lines
                .iter()
                .map(|line| line.source(source))
                .collect::<String>(),
            source
        );
        assert_eq!(
            lines.iter().map(|line| line.byte_start).collect::<Vec<_>>(),
            vec![0, 4, 7]
        );
    }
    #[test]
    fn rejects_missing_or_invalid_answers() {
        let lines = source_lines("first\nsecond\n");
        let batch = pack_batches("output", "test", "echo", &lines, "jev-latest").remove(0);
        assert!(parse_probabilities(&batch, &json!({"answers":{}})).is_err());
        let mut answers = serde_json::Map::new();
        for number in &batch.target_numbers {
            answers.insert(format!("omit_{number}"), json!({"type":"noul","noul":0.99}));
            answers.insert(
                format!("exact_{number}"),
                json!({"type":"noul","noul":0.01}),
            );
        }
        let valid = json!({"answers":answers});
        assert_eq!(parse_probabilities(&batch, &valid).unwrap().len(), 2);
    }
    #[test]
    fn omitted_lines_do_not_rewrite_kept_bytes() {
        let source = "one\r\ntwo\nthree";
        let mut lines = source_lines(source);
        lines[0].protected_reason = Some("fixture_evidence".into());
        let probs = BTreeMap::from([
            (1, (0.99, 0.01, 1)),
            (2, (0.99, 0.01, 1)),
            (3, (0.99, 0.01, 1)),
        ]);
        let decisions = apply_probabilities(&lines, &probs, &LinePolicy::default());
        assert!(render(source, &lines, &decisions, "/private/original").contains("one\r\n"));
        assert_eq!(decisions.last().unwrap().action, Action::Keep);
    }
    #[test]
    fn every_batch_target_is_unique_and_bounded() {
        let source = (0..300)
            .map(|index| format!("Compiling module {index:03} ... done\n"))
            .collect::<String>();
        let lines = source_lines(&source);
        let batches = pack_batches(
            "output",
            "Check build status",
            "cargo build",
            &lines,
            "jev-latest",
        );
        let mut targets = HashSet::new();
        for batch in &batches {
            assert!(batch.target_numbers.len() <= MAX_TARGETS_PER_BATCH);
            assert!(serde_json::to_vec(&batch.request).unwrap().len() <= MAX_REQUEST_BYTES);
            for number in &batch.target_numbers {
                assert!(targets.insert(*number));
            }
        }
        assert_eq!(targets.len(), 300);
    }
    #[test]
    fn diagnostic_context_and_repeated_lines_survive_high_omit_scores() {
        let source = "Compiling alpha\r\nerror: expected true\r\n  at src/main.rs:12\r\nCompiling alpha\r\nDone\r\n";
        let mut lines = source_lines(source);
        protect_neighbors(&mut lines);
        let probabilities = (1..=lines.len())
            .map(|number| (number, (0.99, 0.01, 1)))
            .collect();
        let decisions = apply_probabilities(&lines, &probabilities, &LinePolicy::default());
        let visible = render(source, &lines, &decisions, "/private/original");
        assert!(visible.contains("error: expected true\r\n  at src/main.rs:12\r\n"));
        assert!(visible.contains("Compiling alpha\r\n"));
        assert!(visible.ends_with("Done\r\n"));
    }
}
