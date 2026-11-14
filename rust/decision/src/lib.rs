//! Exact-line Decision decisions and shared input validation. Network and hook I/O live in the binaries.

pub mod activity_counters;
pub mod assistance;
pub mod contract;
pub mod provider;
pub mod publication_contract;
pub mod semantic;
mod source;
pub mod strict_json;
#[cfg(windows)]
pub mod windows;
pub use source::{protect_neighbors, source_lines, strip_ansi};

use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use std::collections::HashMap;
use std::fmt::Write as _;

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
            Ok(metadata) if !metadata.is_dir() || is_link(&metadata) => {
                return Err("unsafe directory path".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return Err("directory stat failed".into()),
        }
    }
    Ok(())
}

pub fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
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

fn preserve_representatives(lines: &[SourceLine], decisions: &mut [LineDecision]) {
    // Retain one representative of a repeated line when none is already kept.
    struct Representative {
        repeated: bool,
        retained: bool,
    }
    let mut counts = HashMap::new();
    for (line, decision) in lines.iter().zip(decisions.iter()) {
        let retained = decision.action != Action::Omit;
        counts
            .entry(line.model_text.as_str())
            .and_modify(|entry: &mut Representative| {
                entry.repeated = true;
                entry.retained |= retained;
            })
            .or_insert(Representative {
                repeated: false,
                retained,
            });
    }
    for (line, decision) in lines.iter().zip(decisions.iter_mut()) {
        let entry = counts.get_mut(line.model_text.as_str()).unwrap();
        if decision.action == Action::Omit && entry.repeated && !entry.retained {
            entry.retained = true;
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
        "[Codex Decision: {omitted} of {} lines omitted; full original: {original_path}]\n",
        lines.len()
    );
    let mut missing = 0;
    for (line, decision) in lines.iter().zip(decisions) {
        if decision.action == Action::Omit {
            missing += 1;
            continue;
        }
        if missing > 0 {
            // String formatting is infallible. Write directly into the result.
            let _ = writeln!(output, "[... {missing} source lines omitted ...]");
            missing = 0;
        }
        output.push_str(line.source(source));
    }
    if missing > 0 {
        let _ = writeln!(output, "[... {missing} source lines omitted ...]");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic::*;
    use std::collections::BTreeMap;
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
        let mut answers = serde_json::Map::new();
        for number in &batch.target_numbers {
            answers.insert(format!("line_{number}"), json!({"type":"noul","noul":0.99}));
        }
        // Only the model is missing; every expected answer is valid.
        let mut valid = json!({"answers":answers});
        assert!(relevance_answers(&batch, &valid).is_err());
        valid["model"] = json!("jev-1.13.0");
        assert_eq!(relevance_answers(&batch, &valid).unwrap().len(), 2);
    }
    #[test]
    fn omitted_lines_do_not_rewrite_kept_bytes() {
        let source = "one\r\ntwo\nthree";
        let mut lines = source_lines(source);
        lines[0].protected_reason = Some("fixture_evidence".into());
        let probs = BTreeMap::from([(1, 0.01), (2, 0.01), (3, 0.01)]);
        let decisions = apply_relevance(&lines, &probs, 5);
        assert!(render(source, &lines, &decisions, "/private/original").contains("one\r\n"));
        assert_eq!(decisions.last().unwrap().action, Action::Keep);
    }
    #[test]
    fn diagnostic_context_and_repeated_lines_survive_high_omit_scores() {
        let source = "Compiling alpha\r\nerror: expected true\r\n  at src/main.rs:12\r\nCompiling alpha\r\nDone\r\n";
        let mut lines = source_lines(source);
        protect_neighbors(&mut lines);
        let probabilities = (1..=lines.len()).map(|number| (number, 0.01)).collect();
        let decisions = apply_relevance(&lines, &probabilities, 5);
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
    fn protected_lines_are_context_but_not_decision_targets() {
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
}
