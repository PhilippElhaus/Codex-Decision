"use strict";
const contract = require("./config-contract.json");
function defaults(kind) {
  return Object.fromEntries(Object.entries(contract[kind]).filter(([, spec]) => Object.hasOwn(spec, "default"))
    .map(([key, spec]) => [key, structuredClone(spec.default)]));
}
function validate(kind, value) {
  if ((kind === "config" && value?.schema_version === 2) ||
      (kind === "settings" && value?.schema_version === 1)) {
    const old = validate(kind === "config" ? "config_v2" : "settings_v1", value);
    const policies = Object.values(old.line_policy);
    const { test_build_enabled, search_listing_enabled, search_relevance, ...current } = old;
    current.schema_version = kind === "config" ? 3 : 2;
    if (kind === "config") current.enabled = old.enabled || test_build_enabled || search_listing_enabled;
    current.line_policy = {
      omit_min: Math.max(...policies.map((policy) => policy.omit_min)),
      exact_max: Math.min(...policies.map((policy) => policy.exact_max)),
    };
    return validate(kind, current);
  }
  if ((kind === "config" && value?.schema_version === 3) ||
      (kind === "settings" && value?.schema_version === 2)) {
    const old = validate(kind === "config" ? "config_v3" : "settings_v2", value);
    const { line_policy, choice_gate_enabled, ...current } = old;
    current.schema_version = kind === "config" ? 4 : 3;
    current.relevance_policy = { relevant_max: Math.min(5, 100 - line_policy.omit_min, line_policy.exact_max) };
    return validate(kind, current);
  }
  const fields = contract[kind];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !Object.hasOwn(fields, key))) throw new Error("Invalid Jev " + kind);
  const result = {};
  for (const [key, spec] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) {
      if (spec.required) throw new Error("Invalid Jev " + kind + ": missing " + key);
      if (Object.hasOwn(spec, "default")) result[key] = structuredClone(spec.default);
      continue;
    }
    let entered = value[key];
    if (contract[spec.type]) entered = validate(spec.type, entered);
    else {
      const valid = spec.type === "integer" ? Number.isSafeInteger(entered) :
        spec.type === "number" ? typeof entered === "number" && Number.isFinite(entered) :
        spec.type === "model" ? typeof entered === "string" && /^jev-[A-Za-z0-9._-]{1,40}$/.test(entered) :
        typeof entered === spec.type;
      if (!valid || (spec.min !== undefined && entered < spec.min) ||
          (spec.max !== undefined && entered > spec.max) ||
          (spec.values && !spec.values.includes(entered))) throw new Error("Invalid Jev " + kind + ": " + key);
    }
    result[key] = entered;
  }
  if (kind === "config" && result.min_chars > result.max_chars) throw new Error("Invalid Jev config size bounds");
  return result;
}
module.exports = { contract, defaults, validate };
