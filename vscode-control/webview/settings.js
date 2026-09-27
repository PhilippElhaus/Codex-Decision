"use strict";

(() => {
  const vscode = acquireVsCodeApi();
  const sections = [
    ["output", "Output filter", [
      ["routine_min", "Routine noise, minimum", "Act only when Jev rates routine noise at least this high."],
      ["exact_max", "Exact text needed, maximum", "Keep output if the chance exact lines matter is higher."],
      ["unique_max", "Unique value, maximum", "Keep output if the chance of a one-time value is higher."],
    ]],
    ["test_build", "Test/build logs", [
      ["routine_min", "Routine lines, minimum", "Trim only when Jev rates omitted lines as routine."],
      ["exact_max", "Exact test text needed, maximum", "Keep lines when exact names or values may matter."],
      ["unique_max", "Unique value, maximum", "Keep lines when a unique result may be present."],
    ]],
    ["search_listing", "Search/listing", [
      ["summarize_probability_min", "Summarize probability, minimum", "Minimum probability for a group to be summarized."],
      ["summarize_confidence_min", "Summarize confidence, minimum", "Minimum confidence for summarizing a group."],
      ["drop_probability_min", "Drop probability, minimum", "Minimum probability for omitting a group."],
      ["drop_confidence_min", "Drop confidence, minimum", "Minimum confidence for omitting a group."],
    ]],
  ];
  const container = document.getElementById("thresholds");
  for (const [hook, heading, fields] of sections) {
    const title = document.createElement("h2");
    title.textContent = heading;
    container.append(title);
    for (const [name, labelText, help] of fields) {
      const row = document.createElement("div");
      row.className = "field";
      const label = document.createElement("label");
      const id = `${hook}-${name}`;
      label.htmlFor = id;
      label.textContent = `${labelText} (%)`;
      const note = document.createElement("small");
      note.textContent = help;
      label.append(note);
      const input = document.createElement("input");
      input.id = id;
      input.type = "number";
      input.min = "0";
      input.max = "100";
      input.step = "1";
      input.required = true;
      row.append(label, input);
      container.append(row);
    }
  }

  const message = document.getElementById("message");
  const key = document.getElementById("key");
  const save = document.getElementById("save");
  const test = document.getElementById("test");
  const testStatus = document.getElementById("test-status");
  let hasKey = false;
  let busy = false;
  let pendingAction = null;
  function setPageMode(onboarding) {
    document.body.dataset.onboarding = String(onboarding);
    document.getElementById("page-title").textContent = onboarding ? "Connect Jev" : "Jev settings";
    document.getElementById("intro").textContent = onboarding
      ? "Enter a Jev API key to use the selected integrations. Test it here before saving."
      : "Changes apply to the next tool result. Jev keeps the full result whenever a safety check fails.";
    save.textContent = onboarding ? "Save API key" : "Save settings";
  }
  function setKeyState(saved) {
    hasKey = saved;
    key.placeholder = saved ? "********" : "";
    document.getElementById("key-state").textContent = saved ? "An API key is saved." : "No API key is saved.";
    document.getElementById("key-help").textContent = saved
      ? "The saved key is masked. Enter a different key to replace it, or leave this field unchanged to keep it."
      : "Enter your Jev API key. It is stored in the plugin data directory.";
  }
  function testResult(value, kind = "") {
    testStatus.textContent = value;
    testStatus.className = kind;
  }
  function failureLabel(reason) {
    const names = {
      JEV_KEY_MISSING: "Missing", JEV_KEY_EXPIRED: "Expired", JEV_HTTP_401: "Invalid",
      JEV_HTTP_403: "Rejected", JEV_HTTP_429: "Rate limited", JEV_TIMEOUT: "Timed out",
      JEV_NETWORK_ERROR: "Network error", JEV_INVALID_RESPONSE: "Invalid response",
    };
    return names[reason] || (typeof reason === "string" && /^JEV_HTTP_\d{3}$/.test(reason)
      ? `HTTP ${reason.slice(-3)}` : "Connection failed");
  }
  function errorLabel(message) {
    if (typeof message !== "string") return "Check failed";
    if (/expired/i.test(message)) return "Expired";
    if (/invalid/i.test(message)) return "Invalid";
    if (/dataDirectory/i.test(message)) return "Data directory missing";
    if (/missing|no key|api key/i.test(message)) return "Missing";
    return "Check failed";
  }
  function report(value, kind = "") {
    message.textContent = value;
    message.className = kind;
  }
  function setBusy(value) {
    busy = value;
    save.disabled = value;
    test.disabled = value;
  }
  function thresholds() {
    const result = {};
    for (const [hook, , fields] of sections) {
      result[hook] = {};
      for (const [name] of fields) {
        const input = document.getElementById(`${hook}-${name}`);
        if (!input.checkValidity() || input.value.trim() === "") {
          input.focus();
          throw new Error("Enter whole percentages from 0 to 100.");
        }
        result[hook][name] = Number(input.value);
      }
    }
    return result;
  }
  test.addEventListener("click", () => {
    if (busy) return;
    report("");
    testStatus.title = "";
    if (!key.value.trim() && !hasKey) { testResult("Missing", "error"); return; }
    setBusy(true);
    pendingAction = "test";
    testResult("Checking…");
    vscode.postMessage({ action: "test", key: key.value.trim() });
  });
  key.addEventListener("input", () => { testResult(""); testStatus.title = ""; });
  save.addEventListener("click", () => {
    if (busy) return;
    try {
      const values = thresholds();
      setBusy(true);
      pendingAction = "save";
      testResult("");
      report("Saving…");
      vscode.postMessage({ action: "save", key: key.value.trim(), mode: document.getElementById("mode").value,
        thresholds: values });
    } catch (error) { report(error.message, "error"); }
  });
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.action === "ready") {
      const config = data.config || {};
      document.getElementById("mode").value = config.mode || "replace";
      setKeyState(Boolean(data.hasKey));
      for (const [hook, , fields] of sections) {
        for (const [name] of fields) {
          document.getElementById(`${hook}-${name}`).value = config.thresholds?.[hook]?.[name] ?? "";
        }
      }
      if (!hasKey) key.focus();
    } else if (data.action === "tested") {
      setBusy(false);
      pendingAction = null;
      testResult(data.result?.ok ? "OK" : failureLabel(data.result?.reason), data.result?.ok ? "ok" : "error");
      testStatus.title = data.result?.ok ? `Connected to ${data.result.model}.` : "";
    } else if (data.action === "saved") {
      setBusy(false);
      pendingAction = null;
      key.value = "";
      setKeyState(Boolean(data.hasKey));
      if (document.body.dataset.onboarding === "true" && hasKey) setPageMode(false);
      testResult("");
      report("Settings saved.", "ok");
    } else if (data.action === "error") {
      setBusy(false);
      if (pendingAction === "test") {
        testResult(errorLabel(data.message), "error");
        testStatus.title = data.message || "";
        report("");
      } else {
        report(data.message || "Jev settings failed.", "error");
      }
      pendingAction = null;
    }
  });
  setPageMode(document.body.dataset.onboarding === "true");
  vscode.postMessage({ action: "ready" });
})();
