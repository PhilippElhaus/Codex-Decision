"use strict";

// Keep the original core worker and declaration order for shared process state.
require("./activity/accounting.cases.cjs");
require("./activity/counter_reads.cases.cjs");
require("./activity/atomic_reads.cases.cjs");
require("./activity/request_ledger.cases.cjs");
require("./activity/installation_totals.cases.cjs");
require("./activity/session_defaults.cases.cjs");
require("./activity/linked_paths.cases.cjs");
require("./activity/policy.cases.cjs");
require("./activity/activity_index.cases.cjs");
require("./activity/credentials.cases.cjs");
require("./activity/hook_selection.cases.cjs");
require("./activity/paths_health.cases.cjs");
require("./activity/invalid_config.cases.cjs");
require("./activity/session_totals.cases.cjs");
require("./activity/events.cases.cjs");
