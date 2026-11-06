"use strict";

// Keep the original extension worker; these scenarios patch shared module state.
require("./extension/settings.cases.cjs");
require("./extension/composer.cases.cjs");
require("./extension/providers.cases.cjs");
require("./extension/health_budget.cases.cjs");
