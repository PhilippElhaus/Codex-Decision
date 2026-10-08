//! Typed Go test events keep decoded diagnostic continuation and measurements.
use super::*;

#[derive(Default)]
pub(super) struct GoEvents {
    traces: BTreeMap<(String, String), Trace>,
}

#[derive(Default)]
struct Trace {
    context_left: usize,
    diagnostic: bool,
    panicking: bool,
}

impl GoEvents {
    pub(super) fn apply(&mut self, line: &mut SourceLine) -> Option<bool> {
        let row = strict_json::parse(line.model_text.as_bytes()).ok()?;
        let object = row.as_object()?;
        let action = object.get("Action")?.as_str()?;
        let package = object.get("Package")?.as_str()?;
        if !matches!(
            action,
            "start" | "run" | "pause" | "cont" | "pass" | "bench" | "fail" | "skip" | "output"
        ) {
            return None;
        }
        for name in ["Test", "Output", "OutputType", "FailedBuild"] {
            if object.get(name).is_some_and(|value| !value.is_string()) {
                return None;
            }
        }
        if object.get("Time").is_some_and(|value| {
            value
                .as_str()
                .is_none_or(|time| chrono::DateTime::parse_from_rfc3339(time).is_err())
        }) || object.get("Elapsed").is_some_and(|value| {
            value
                .as_f64()
                .is_none_or(|elapsed| !elapsed.is_finite() || elapsed < 0.0)
        }) || object.get("OutputType").is_some_and(|value| {
            !matches!(
                value.as_str(),
                Some("" | "frame" | "error" | "error-continue")
            )
        }) || action == "output" && object.get("Output").and_then(Value::as_str).is_none()
        {
            return None;
        }
        let test = object.get("Test").and_then(Value::as_str).unwrap_or("");
        let key = (package.to_owned(), test.to_owned());
        if matches!(action, "start" | "run" | "pass" | "bench" | "fail" | "skip") {
            self.traces.remove(&key);
            if test.is_empty() && matches!(action, "start" | "pass" | "fail" | "skip") {
                self.traces
                    .retain(|(known_package, _), _| known_package != package);
            }
        }
        if action == "bench" || test.starts_with("Benchmark") && action == "output" {
            line.protected_reason = Some("benchmark_result".into());
        }
        if matches!(action, "fail" | "skip") {
            line.protected_reason = Some("diagnostic_json".into());
        }
        if let Some(output) = object.get("Output").and_then(Value::as_str) {
            let output_type = object
                .get("OutputType")
                .and_then(Value::as_str)
                .unwrap_or("");
            let trace = self.traces.entry(key).or_default();
            let mut protected = trace.panicking
                || sensitive(output)
                || matches!(output_type, "error" | "error-continue");
            for text in output.lines() {
                let lower = text.to_ascii_lowercase();
                let indented = text.starts_with(char::is_whitespace);
                // Runtime stacks include blank separators and unindented
                // function rows. Their exact test's output stays protected
                // until its terminal event, independently of interleaved tests.
                trace.panicking |= lower.starts_with("panic:") || lower.starts_with("fatal error:");
                if trace_marker(&lower) || matches!(output_type, "error" | "error-continue") {
                    trace.context_left = 24;
                    trace.diagnostic = true;
                } else if text.trim().is_empty() {
                    trace.context_left = 0;
                    trace.diagnostic = false;
                } else if trace.context_left == 0 && !indented {
                    trace.diagnostic = false;
                }
                protected |=
                    trace.panicking || trace.context_left > 0 || trace.diagnostic && indented;
                // A cursor can begin at a complete event halfway through a
                // runtime stack. These frame shapes carry diagnostic evidence
                // even when this chunk contains no preceding panic marker.
                protected |= runtime_frame(text);
                trace.context_left = trace.context_left.saturating_sub(1);
                protected |= ["error", "panic", "failed", "assert"]
                    .iter()
                    .any(|word| lower.contains(word));
                if text.trim_start().starts_with("Benchmark") {
                    line.protected_reason = Some("benchmark_result".into());
                }
            }
            if protected && line.protected_reason.as_deref() != Some("benchmark_result") {
                line.protected_reason = Some("diagnostic_json".into());
            }
        }
        let complete = matches!(action, "pass" | "fail") && object.get("Test").is_none();
        if complete {
            line.protected_reason = Some("completion".into());
        }
        Some(complete)
    }
}

fn runtime_frame(text: &str) -> bool {
    let trimmed = text.trim();
    if let Some(rest) = trimmed.strip_prefix("goroutine ") {
        return rest.split_once(" [").is_some_and(|(number, state)| {
            !number.is_empty()
                && number.bytes().all(|byte| byte.is_ascii_digit())
                && state.len() > 2
                && state.ends_with("]:")
        });
    }
    if let Some(rest) = trimmed.strip_prefix("created by ") {
        let (name, number) = rest.split_once(" in goroutine ").unwrap_or((rest, "0"));
        return frame_name(name)
            && !number.is_empty()
            && number.bytes().all(|byte| byte.is_ascii_digit());
    }
    if text.starts_with('\t') {
        let (location, offset) = trimmed.split_once(" +0x").unwrap_or((trimmed, "0"));
        if location.rsplit_once(':').is_some_and(|(path, number)| {
            (path.ends_with(".go") || path.ends_with(".s") || path.ends_with("<autogenerated>"))
                && !number.is_empty()
                && number.bytes().all(|byte| byte.is_ascii_digit())
        }) && !offset.is_empty()
            && offset.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return true;
        }
    }
    let Some(arguments) = trimmed.strip_suffix(')') else {
        return false;
    };
    arguments.rsplit_once('(').is_some_and(|(name, values)| {
        frame_name(name)
            && values.chars().all(|c| {
                c.is_ascii_hexdigit()
                    || matches!(
                        c,
                        'x' | ',' | ' ' | '{' | '}' | '[' | ']' | '?' | '.' | '…' | '-' | '_'
                    )
            })
    })
}

fn frame_name(name: &str) -> bool {
    name.contains('.')
        && !name.chars().any(char::is_whitespace)
        && !name.starts_with(['"', '{', '['])
}

fn trace_marker(lower: &str) -> bool {
    [
        "traceback",
        "assertionerror",
        "panic!",
        "panicked at",
        "stack backtrace:",
        "error:",
        "failed:",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || lower.starts_with("panic:")
}

#[cfg(test)]
mod frame_tests {
    use super::runtime_frame;

    #[test]
    fn runtime_frame_shapes_preserve_canonical_frames_without_blanket_indentation() {
        for text in [
            "main.main()",
            "synthetic.example/pkg.(*Worker).Run(0xc000012345, {0x1, 0x2}, ...)",
            "runtime.goexit({})",
            "main.synthetic(_, 0x1?)",
            "\t/synthetic/main.go:42 +0x1a",
            "\t/synthetic/asm.s:17 +0xff",
            "\t<autogenerated>:1",
            "goroutine 19 [running]:",
            "goroutine 2 [chan receive, 4 minutes]:",
            "created by main.synthetic in goroutine 1",
            "created by main.synthetic",
        ] {
            assert!(runtime_frame(text), "canonical frame unprotected: {text}");
        }
        for text in [
            "    INFO normal indented event",
            "\tINFO normal indented event",
            "INFO routine synthetic.foo()",
            "main.synthetic(value)",
            "main.synthetic(private_value)",
            "goroutine normal observation",
            "goroutine x [running]:",
            "created by normal prose in goroutine 1",
            "\t/synthetic/main.go:unknown +0x1a",
            "\t/synthetic/main.go:42 +0xnothex",
        ] {
            assert!(
                !runtime_frame(text),
                "ordinary log acquired a frame contract: {text}"
            );
        }
    }
}
