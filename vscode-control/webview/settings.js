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
  let busy = false;
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
    setBusy(true);
    report("Testing Jev connection…");
    vscode.postMessage({ action: "test", key: key.value.trim() });
  });
  save.addEventListener("click", () => {
    if (busy) return;
    try {
      const values = thresholds();
      setBusy(true);
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
      document.getElementById("key-state").textContent = data.hasKey ? "An API key is saved." : "No usable API key is saved.";
      for (const [hook, , fields] of sections) {
        for (const [name] of fields) {
          document.getElementById(`${hook}-${name}`).value = config.thresholds?.[hook]?.[name] ?? "";
        }
      }
    } else if (data.action === "tested") {
      setBusy(false);
      report(data.result?.ok ? `API key works with ${data.result.model}.` :
        `Connection check failed: ${String(data.result?.reason || "unknown").replace(/^JEV_/, "").replaceAll("_", " ")}.`,
      data.result?.ok ? "ok" : "error");
    } else if (data.action === "saved") {
      setBusy(false);
      key.value = "";
      document.getElementById("key-state").textContent = data.hasKey ? "An API key is saved." : "No usable API key is saved.";
      report("Settings saved.", "ok");
    } else if (data.action === "error") {
      setBusy(false);
      report(data.message || "Jev settings failed.", "error");
    }
  });
  vscode.postMessage({ action: "ready" });
})();
