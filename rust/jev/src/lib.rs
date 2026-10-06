//! Exact-line Jev decisions and shared input validation. Network and hook I/O live in the binaries.

pub mod contract;
pub mod semantic;

use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

pub fn check_ancestors(path: &std::path::Path) -> Result<(), String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| "current directory unavailable")?
            .join(path)
    };
    let mut current = std::path::PathBuf::new();
    for component in absolute.components() {
        if matches!(component, std::path::Component::ParentDir) {
            if !current.pop() {
                return Err("unsafe directory path".into());
            }
            continue;
        }
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err("unsafe directory path".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return Err("directory stat failed".into()),
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct LinePolicy {
    pub omit_min: u8,
    pub exact_max: u8,
}

impl Default for LinePolicy {
    fn default() -> Self {
        Self {
            omit_min: contract::contract()["thresholds"]["omit_min"]["default"]
                .as_u64()
                .unwrap() as u8,
            exact_max: contract::contract()["thresholds"]["exact_max"]["default"]
                .as_u64()
                .unwrap() as u8,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct SearchRelevancePolicy {
    pub guard_enabled: bool,
    pub relevant_max: u8,
}

impl Default for SearchRelevancePolicy {
    fn default() -> Self {
        Self {
            guard_enabled: contract::contract()["search_relevance"]["guard_enabled"]["default"]
                .as_bool()
                .unwrap(),
            relevant_max: contract::contract()["search_relevance"]["relevant_max"]["default"]
                .as_u64()
                .unwrap() as u8,
        }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p_can_omit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p_exact_needed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p_task_relevant: Option<f64>,
    pub action: Action,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protected_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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

pub type LineProbabilities = (f64, f64, Option<f64>, usize);

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
    } else if lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|word| word == "warn")
        || [
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
            let escape_start = index;
            index += 2;
            while index < bytes.len() && (bytes[index].is_ascii_digit() || bytes[index] == b';') {
                index += 1;
            }
            if index < bytes.len() && bytes[index].is_ascii_alphabetic() {
                index += 1;
                from = index;
                continue;
            }
            // Keep an unsupported sequence verbatim without appending its
            // already-copied prefix a second time.
            from = escape_start;
            break;
        }
        index += 1;
    }
    clean.push_str(&text[from..]);
    clean
}

pub fn protect_neighbors(lines: &mut [SourceLine]) {
    let mut block = 0usize;
    let mut diagnostic_block = false;
    for line in lines.iter_mut() {
        let lower = line.model_text.to_ascii_lowercase();
        let indented = line.model_text.starts_with(char::is_whitespace);
        if lower.contains("traceback")
            || lower.contains("assertionerror")
            || lower.contains("panic!")
            || lower.contains("panicked at")
            || lower.starts_with("panic:")
            || lower.contains("stack backtrace:")
            || lower.contains("error:")
            || lower.contains("failed:")
        {
            block = 24;
            diagnostic_block = true;
        } else if line.model_text.trim().is_empty()
            || lower.starts_with("test ") && lower.contains(" ... ok")
        {
            block = 0;
            diagnostic_block = false;
        } else if block == 0 && !indented {
            diagnostic_block = false;
        }
        // Long backtraces have no fixed frame count. Keep their indented
        // continuation after the short context allowance is exhausted.
        if block > 0 || diagnostic_block && indented {
            if line.protected_reason.is_none() {
                line.protected_reason = Some("diagnostic_block".into());
            }
            block = block.saturating_sub(1);
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

pub fn apply_probabilities(
    lines: &[SourceLine],
    probabilities: &BTreeMap<usize, LineProbabilities>,
    policy: &LinePolicy,
    relevance: &SearchRelevancePolicy,
) -> Vec<LineDecision> {
    let mut decisions: Vec<LineDecision> = lines
        .iter()
        .map(|line| {
            let judged = probabilities.get(&line.number);
            let (omit, exact, relevant, batch) = judged
                .map(|(omit, exact, relevant, batch)| {
                    (Some(*omit), Some(*exact), *relevant, Some(*batch))
                })
                .unwrap_or((None, None, None, None));
            let (action, reason) = if line.protected_reason.is_some() || !line.eligible {
                (Action::KeepUnjudged, "protected")
            } else if let Some((p_omit, p_exact, p_relevant, _)) = judged {
                if *p_omit < f64::from(policy.omit_min) / 100.0 {
                    (Action::Keep, "below_omit_cutoff")
                } else if *p_exact > f64::from(policy.exact_max) / 100.0 {
                    (Action::Keep, "exact_text")
                } else if relevance.guard_enabled
                    && p_relevant
                        .is_some_and(|value| value > f64::from(relevance.relevant_max) / 100.0)
                {
                    (Action::Keep, "task_relevant")
                } else {
                    (Action::Omit, "confident_omission")
                }
            } else {
                (Action::KeepUnjudged, "budget_unjudged")
            };
            LineDecision {
                number: line.number,
                p_can_omit: omit,
                p_exact_needed: exact,
                p_task_relevant: relevant,
                action,
                reason: reason.into(),
                protected_reason: line.protected_reason.clone(),
                batch_id: batch,
            }
        })
        .collect();
    preserve_representatives(lines, &mut decisions);
    decisions
}

fn preserve_representatives(lines: &[SourceLine], decisions: &mut [LineDecision]) {
    // Retain one representative of a repeated line when none is already kept.
    let mut counts = HashMap::new();
    for line in lines {
        *counts.entry(line.model_text.as_str()).or_insert(0usize) += 1;
    }
    let mut seen: HashSet<&str> = lines
        .iter()
        .zip(decisions.iter())
        .filter(|(_, decision)| decision.action != Action::Omit)
        .map(|(line, _)| line.model_text.as_str())
        .collect();
    for (line, decision) in lines.iter().zip(decisions.iter_mut()) {
        if decision.action == Action::Omit
            && counts[&line.model_text.as_str()] > 1
            && seen.insert(line.model_text.as_str())
        {
            decision.action = Action::Keep;
            decision.reason = "representative".into();
            decision.protected_reason = Some("representative".into());
        }
    }
    if let Some(last) = decisions.last_mut() {
        if last.action == Action::Omit {
            last.action = Action::Keep;
            last.reason = "last_line".into();
            last.protected_reason = Some("last_line".into());
        }
    }
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
    use crate::semantic::*;
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
    fn unsupported_ansi_sequences_do_not_duplicate_model_evidence() {
        for suffix in ["?25l", "31;", "", "🌍"] {
            let text = format!("INFO α prefix \x1b[{suffix}");
            assert_eq!(strip_ansi(&text), text);
        }
        let text = "INFO \x1b[32mgreen\x1b[0m \x1b[?25lremaining 🌍";
        assert_eq!(strip_ansi(text), "INFO green \x1b[?25lremaining 🌍");
        let lines = source_lines(text);
        assert_eq!(lines[0].source(text), text);
    }
    #[test]
    fn rejects_missing_or_invalid_answers() {
        let lines = source_lines("first\nsecond\n");
        let batch = relevance_requests("test", "echo", "repetitive_log", &lines, "jev-latest")
            .unwrap()
            .remove(0);
        assert!(relevance_answers(&batch, &json!({"answers":{}})).is_err());
        let mut answers = serde_json::Map::new();
        for number in &batch.target_numbers {
            answers.insert(format!("line_{number}"), json!({"type":"noul","noul":0.99}));
        }
        let valid = json!({"model":"jev-1.13.0","answers":answers});
        assert_eq!(relevance_answers(&batch, &valid).unwrap().len(), 2);
    }
    #[test]
    fn omitted_lines_do_not_rewrite_kept_bytes() {
        let source = "one\r\ntwo\nthree";
        let mut lines = source_lines(source);
        lines[0].protected_reason = Some("fixture_evidence".into());
        let probs = BTreeMap::from([
            (1, (0.99, 0.01, None, 1)),
            (2, (0.99, 0.01, None, 1)),
            (3, (0.99, 0.01, None, 1)),
        ]);
        let decisions = apply_probabilities(
            &lines,
            &probs,
            &LinePolicy::default(),
            &SearchRelevancePolicy::default(),
        );
        assert!(render(source, &lines, &decisions, "/private/original").contains("one\r\n"));
        assert_eq!(decisions.last().unwrap().action, Action::Keep);
    }
    #[test]
    fn every_batch_target_is_unique_and_bounded() {
        let source = (0..300)
            .map(|index| format!("Compiling module {index:03} ... done\n"))
            .collect::<String>();
        let lines = source_lines(&source);
        let batches = relevance_requests(
            "Check build status",
            "cargo build",
            "repetitive_log",
            &lines,
            "jev-latest",
        )
        .unwrap();
        let mut targets = HashSet::new();
        for batch in &batches {
            validate_request_budget(&batch.request).unwrap();
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
            .map(|number| (number, (0.99, 0.01, None, 1)))
            .collect();
        let decisions = apply_probabilities(
            &lines,
            &probabilities,
            &LinePolicy::default(),
            &SearchRelevancePolicy::default(),
        );
        let visible = render(source, &lines, &decisions, "/private/original");
        assert!(visible.contains("error: expected true\r\n  at src/main.rs:12\r\n"));
        assert!(visible.contains("Compiling alpha\r\n"));
        assert!(visible.ends_with("Done\r\n"));
    }

    #[test]
    fn deep_indented_backtraces_keep_every_frame_and_end_at_routine_output() {
        for heading in [
            "Traceback (most recent call last):",
            "thread 'main' panicked at src/main.rs:12: synthetic panic",
        ] {
            let frames = (0..100)
                .map(|index| {
                    format!(
                        "    frame {index}: synthetic caller at source.rs:{}\n",
                        index + 1
                    )
                })
                .collect::<String>();
            let source = format!("{heading}\n{frames}INFO routine work resumed\nDone\n");
            let mut lines = source_lines(&source);
            protect_neighbors(&mut lines);
            let probabilities = (1..=lines.len()).map(|number| (number, 0.01)).collect();
            let decisions = apply_relevance(&lines, &probabilities, 5);
            let visible = render(&source, &lines, &decisions, "/private/original");
            assert!(visible.contains(&frames), "{heading}");
            assert_eq!(decisions[101].action, Action::Omit);
        }
    }

    #[test]
    fn protected_lines_are_context_but_not_jev_targets() {
        let mut lines = source_lines(
            &("error: build failed\nnearby evidence\n".to_owned()
                + &"routine progress\n".repeat(40)),
        );
        protect_neighbors(&mut lines);
        let batches = relevance_requests(
            "Find the failure",
            "cargo build",
            "repetitive_log",
            &lines,
            "jev-latest",
        )
        .unwrap();
        let targets: Vec<usize> = batches
            .iter()
            .flat_map(|batch| batch.target_numbers.iter().copied())
            .collect();
        assert!(!targets.contains(&1));
        assert!(!targets.contains(&2));
        assert!(batches.iter().all(|batch| batch.request["state"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["text"] == "error: build failed" && row["protected"] == true)));
    }

    #[test]
    fn search_relevance_is_independent_and_only_guards_when_enabled() {
        let mut lines = source_lines("src/irrelevant.rs:12:unrelated symbol\nsrc/evidence.rs:8:needed value\nsearch completed\n");
        lines[2].protected_reason = Some("completion".into());
        // Legacy receipt replay still uses its recorded omission/exact/relevance fields.
        let probabilities = BTreeMap::from([
            (1, (0.99, 0.01, Some(0.01), 1)),
            (2, (0.99, 0.01, Some(0.91), 1)),
        ]);
        let preview = apply_probabilities(
            &lines,
            &probabilities,
            &LinePolicy::default(),
            &SearchRelevancePolicy::default(),
        );
        assert_eq!(preview[1].reason, "confident_omission");
        let guarded = apply_probabilities(
            &lines,
            &probabilities,
            &LinePolicy::default(),
            &SearchRelevancePolicy {
                guard_enabled: true,
                relevant_max: 5,
            },
        );
        assert_eq!(guarded[0].action, Action::Omit);
        assert_eq!(guarded[1].action, Action::Keep);
        assert_eq!(guarded[1].reason, "task_relevant");
    }
}
