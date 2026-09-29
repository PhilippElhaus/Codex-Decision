# Codex Jev 0.4 release notes

The local hook now asks Jev for two independent Noul probabilities per eligible source line: whether it can be omitted and whether its exact text is needed. Code applies conservative per-line thresholds and retains diagnostics, completion totals, nearby context, and unjudged lines. It keeps the exact original in private storage before replacing a result. A failed batch leaves the full result intact.

The Linux x86_64 plugin package contains a Rust executable and requires no Python at hook runtime. The paired VS Code control 0.3.0 shows five recent judged lines and the latest line's two animated probability bars. Config schema 2 keeps integration selections, mode, and key while replacing old whole-output thresholds. The composer patch remains a separate version-pinned local tool.
