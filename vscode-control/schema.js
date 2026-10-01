"use strict";
const contract = require("./config-contract.json");
function defaults(kind) {
  return Object.fromEntries(Object.entries(contract[kind]).filter(([, spec]) => Object.hasOwn(spec, "default"))
    .map(([key, spec]) => [key, structuredClone(spec.default)]));
}
function validate(kind, value) {
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
