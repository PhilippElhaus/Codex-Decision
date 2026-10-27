# Maintenance changes in 0.15.2

This release removes repeated local work and adds measurements for future
usage audits. It preserves provider requests, relevance thresholds, protected
evidence, and the full-output failure behavior.

## Changes

1. Settings read the credential file once. Provider-key presence and the
   selected key length come from that same snapshot. The extension does not
   cache secrets between requests. Custom authentication keeps its endpoint
   binding and no-auth behavior.
2. Completed telemetry separates judged lines below the inclusive relevance
   cutoff, lines restored by final guards, proposed removals, and prepared
   removals. Failed evaluations leave these measurements unknown. The legacy
   omission counter keeps its original meaning.
3. A prepared response owns the parsed command and Lab output views for one
   hook invocation. Source projection, boundary protection, replacement checks,
   and provider fallback reuse those views. Another invocation starts with a
   new prepared response.
4. Composer and panel activity reads share unchanged snapshots. File identity,
   modification time, change time, and size invalidate the cache. The logs
   directory also identifies transient publication changes. Active
   publication journals use the existing transactional reader. Each caller
   receives a separate copy, so installation totals cannot alter session data.

The release also includes the [October 27 usage audit](usage_effectiveness_2026-10-27.md)
and private bounded telemetry. See [data handling](../architecture/design_data.md)
for collection, retention, coverage, and delivery limits. Source audit scripts
remain in the repository; the installed runtime records their input metadata.

These changes remove duplicate reads and parsing by construction. They do not
claim a measured production latency or delivered-context improvement.

## Validation

- Linux: 311 Rust tests passed, with one ignored fixture. Formatting and
  all-target Clippy passed. The Node suite passed 238 tests, with four optional
  or platform skips. All 16 Python checks passed.
- Windows: 36 Rust tests passed. The Node subset for credentials, activity,
  publication, and the shared cache passed 59 tests, with two platform skips.
- New regressions verify a single credential snapshot, current relevance
  counts, reused response views, typed stderr, shared unchanged reads, cache
  invalidation, isolated copies, and transient publication journals.
- Both production runtimes were built with locked dependencies. The package
  checks compare exact entries, source bytes, versions, and ELF/PE targets.

The installed hook retains its existing trust definition. Reload the VS Code
window after installing the VSIX so the running control loads the new modules.
