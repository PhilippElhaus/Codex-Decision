# Documentation

These guides describe the checked-in application. Version authorities are the plugin, Cargo, and VS Code manifests. Historical investigations remain in Git history. They are not current acceptance evidence.

| Concern | Guide |
| --- | --- |
| Install, update, and recover | [Installation](setup/installation.md) |
| Keys, custom endpoints, authentication, and CA trust | [Providers](setup/providers.md) |
| Composer, settings, panel, and raw inspector | [Using Decision](reference/usage.md) |
| Defaults and configuration precedence | [Configuration](reference/configuration.md) |
| Eligible output, judgments, and failures | [Filtering](reference/filtering.md) |
| Ranked source blocks and Codex MCP registration | [Context ranking](reference/context-ranking.md) |
| Advisory failure reviews in Test Explorer | [Failure triage](reference/failure-triage.md) |
| Claim checks and bounded Stop continuation | [Completion verification](reference/completion-verification.md) |
| External data and local safeguards | [Privacy](reference/privacy.md) |
| Component ownership and execution flow | [Application architecture](architecture/overview.md) |
| Provider wire contracts | [Provider adapters](architecture/providers.md) |
| Shared advisory workflows and native MCP service | [Advisory architecture](architecture/assistance.md) |
| Thread routing, bridge, and patch profiles | [VS Code integration](architecture/vscode.md) |
| Records, retention, and atomic publication | [Storage](architecture/storage.md) |
| Activity counts and effectiveness limits | [Measurement](operations/measurement.md) |
| Content-free request records | [Telemetry](operations/telemetry.md) |
| Native tests, CI, and discovery | [Test entry point](../tests/README.md) |
| Nx and function-level selection | [Test impact analysis](development/test-impact.md) |
| Synthetic corpora and interruption checks | [Evaluation](development/evaluation.md) |
| CPU, allocation, and concurrent hook processes | [Performance](development/performance.md) |
| Browser validation and screenshots | [Browser checks](development/browser.md) |
| Production build and package validation | [Builds](development/builds.md) |

Use source and tests to resolve a disagreement. Update the owning guide when behavior changes. Keep release narratives and local runtime observations out of setup instructions.
