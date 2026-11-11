#!/usr/bin/env node
"use strict";
const path = require("node:path");
const { readDeliveryReport } = require("../vscode-control/delivery-report");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--session-dir" || !path.isAbsolute(args[1])) {
  process.stderr.write("Usage: node scripts/delivery_audit.cjs --session-dir <absolute-session-directory>\n");
  process.exitCode = 2;
} else {
  readDeliveryReport(args[1]).then(report => process.stdout.write(JSON.stringify(report, null, 2) + "\n"))
    .catch(() => { process.stderr.write("Decision measurement records could not be read safely\n"); process.exitCode = 2; });
}
