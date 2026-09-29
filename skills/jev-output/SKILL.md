---
name: jev-output
description: Help configure and verify Codex Jev's local tool-output filters when the user asks about Jev setup, shortened evidence, saved originals, settings, logs, or unexpected results. Do not activate for unrelated TypeSafe Jev applications.
---

# Codex Jev output

Codex Jev runs as a local Rust `PostToolUse` hook. This skill helps with setup and evidence review; invoking the skill does not activate a filter. New installs start with three filters disabled. The hook needs a user-provided TypeSafe AI API key and Codex trust for the current hook definition. On a surface without local hook execution, explain that limitation before recommending a setting.

## Set up or diagnose

1. Check whether `codex-jev` is installed and enabled in the current Codex environment. Identify the installed plugin's data directory before inspecting settings; do not assume a path from another marketplace installation.
2. Choose only the integration relevant to the user's tool output: output filter, test/build logs, or search/listing. Explain that eligible text is sent to TypeSafe AI's Jev API. Do not enable a filter for output that may contain secrets or other text the user has not authorized sending to that service.
3. If a key is missing, direct the user to **Connect Jev** in the optional VS Code control or to the local key setup guide. Do not ask the user to paste a key into chat. Do not print, copy, or inspect the saved key.
4. Prefer **Monitor** while evaluating unfamiliar output. Each eligible line receives independent `can_omit` and `exact_needed` Noul probabilities; local code applies both cutoffs and protects diagnostics. A change to selection, mode, or cutoffs applies to the next tool result. Treat the VS Code composer control as optional; it requires a separately installed extension and a version-pinned patch.

## Review a shortened result

Read the visible text and its omission map. If an answer depends on omitted lines, use the exact saved-original path supplied by that result, subject to the user's file access and privacy boundaries. Check the original line ranges before making a claim about missing failures, unique values, or search matches. Do not infer that omitted text is irrelevant solely from Jev's decision.

For a decision investigation, use the version 2 private receipt and its separate batch records or the activity summary without exposing raw tool output, API keys, or credentials in the response. If the hook, API, storage, or answer validation fails, the expected behavior is to keep the full result; report observed behavior without claiming that Jev shortened it. Request count and judged-line count are different. Estimated tokens saved are character-based estimates, not billed tokens.

Use the [installation guide](https://github.com/PhilippElhaus/Codex-Jev/blob/main/docs/setup/setup_installation.md) for platform-specific setup and the [data-handling guide](https://github.com/PhilippElhaus/Codex-Jev/blob/main/docs/architecture/design_data.md) for what can reach Jev and what stays local.
