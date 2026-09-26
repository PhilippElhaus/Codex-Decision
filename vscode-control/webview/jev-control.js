/* Local Codex composer control. The host bridge returns metadata only. */
(() => {
  const acquire = window.acquireVsCodeApi;
  if (typeof acquire !== "function") return;
  window.acquireVsCodeApi = function (...args) {
    const api = acquire.apply(this, args);
    window.__codexJevApi = api;
    return api;
  };

  let state = { enabled: false, health: null, busy: false, mode: "replace", recent: "No decision recorded yet", history: [], stats: {} };
  let root;
  let pending = 0;
  let menuOpen = false;
  let layoutObserver;
  let observed = [];
  let positionScheduled = false;
  let viewId = newViewId();
  let viewLocation = window.location.href;
  const sentViews = new Map();
  const colors = { off: "#9a9a9a", healthy: "#87cda4", failed: "#e99490", busy: "#83bcf7" };

  function newViewId() {
    return `view-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }

  function currentViewId() {
    if (window.location.href !== viewLocation) {
      viewLocation = window.location.href;
      viewId = newViewId();
      state = { ...state, busy: false, recent: "No decision recorded yet", history: [], stats: {} };
      render();
    }
    return viewId;
  }

  function send(action, enabled) {
    const api = window.__codexJevApi;
    if (!api) return;
    const id = ++pending;
    const current = currentViewId();
    sentViews.set(id, current);
    if (sentViews.size > 50) sentViews.delete(sentViews.keys().next().value);
    api.postMessage({ type: "codex-jev", action, enabled, viewId: current, id });
  }

  function create() {
    if (root) return root;
    const style = document.createElement("style");
    style.textContent = `
      #codex-jev { position: fixed; z-index: 2147483600; display: none; font-family: inherit; }
      #codex-jev * { box-sizing: border-box; }
      #codex-jev-button { display: inline-flex; align-items: center; gap: 7px; padding: 5px 8px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: #9a9a9a; font-family: inherit; font-size: 14px; font-weight: 600; line-height: 18px; cursor: pointer; transition: color 220ms ease-in-out; }
      #codex-jev[data-compact="true"] #codex-jev-button { gap: 0; padding: 6px; }
      #codex-jev[data-compact="true"] #codex-jev-label { display: none; }
      #codex-jev-observe { display: none; margin-left: 2px; padding: 1px 3px; border: 1px solid #9a9a9a77; border-radius: 3px; color: #bdbdbd; font-size: 9px; font-weight: 700; line-height: 12px; letter-spacing: .04em; }
      #codex-jev[data-observe="true"] #codex-jev-observe { display: inline-block; }
      #codex-jev[data-compact="true"] #codex-jev-observe { margin-left: 2px; padding: 0 2px; }
      #codex-jev-button:hover, #codex-jev-button[aria-expanded="true"] { background: #ffffff12; border-color: #ffffff26; }
      #codex-jev-button:focus-visible, #codex-jev-option:focus-visible { outline: 2px solid #83bcf7; outline-offset: 2px; }
      #codex-jev-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 15%, transparent); transition: box-shadow 220ms ease-in-out; }
      #codex-jev-menu, #codex-jev-tip { position: absolute; bottom: calc(100% + 9px); right: 0; border: 1px solid #454545; border-radius: 11px; background: #292929; color: #dedede; box-shadow: 0 12px 30px #0009; }
      #codex-jev-menu { display: none; width: min(285px, calc(100vw - 24px)); padding: 10px; }
      #codex-jev-menu[data-open="true"] { display: block; }
      #codex-jev-menu h2 { margin: 3px 8px 8px; color: #aaa; font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .08em; }
      #codex-jev-option { display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px 8px; border: 0; border-radius: 7px; background: transparent; color: #e5e5e5; text-align: left; font: inherit; cursor: pointer; }
      #codex-jev-option:hover { background: #ffffff12; }
      #codex-jev-check { display: grid; place-items: center; width: 16px; height: 16px; border: 1px solid #777; border-radius: 4px; flex: none; font-size: 12px; }
      #codex-jev-option[aria-checked="true"] #codex-jev-check { background: #87cda4; border-color: #87cda4; color: #1b281e; }
      #codex-jev-option[aria-checked="true"] #codex-jev-check::after { content: "✓"; }
      #codex-jev-option strong { display: block; font-size: 13px; font-weight: 600; }
      #codex-jev-option small { display: block; color: #aaa; font-size: 11px; margin-top: 2px; }
      #codex-jev-menu p { color: #999; font-size: 11px; margin: 8px 8px 2px; }
      #codex-jev-tip { display: none; width: min(340px, calc(100vw - 24px)); padding: 11px 13px; pointer-events: none; font-size: 12px; line-height: 1.45; white-space: normal; }
      #codex-jev:hover #codex-jev-tip { display: block; }
      #codex-jev[data-menu="true"] #codex-jev-tip { display: none; }
      #codex-jev-tip strong { color: #fff; }
      #codex-jev-tip span { display: block; color: #aaa; margin-top: 3px; }
      #codex-jev-stats { color: #d4d4d4; }
      #codex-jev-tip h3 { margin: 10px 0 4px; color: #aaa; font-size: 11px; font-weight: 650; letter-spacing: .04em; }
      #codex-jev-history { margin: 0; padding-left: 18px; color: #d4d4d4; }
      #codex-jev-history li { margin-top: 3px; }
      #codex-jev-empty { margin: 0; color: #888; }
    `;
    document.head.appendChild(style);
    root = document.createElement("div");
    root.id = "codex-jev";
    root.innerHTML = `
      <button id="codex-jev-button" type="button" aria-label="Jev hooks" aria-expanded="false" aria-controls="codex-jev-menu"><span id="codex-jev-dot"></span><span id="codex-jev-label">jev</span><span id="codex-jev-observe">OBS</span></button>
      <div id="codex-jev-tip" role="tooltip"><strong></strong><span id="codex-jev-mode"></span><h3 id="codex-jev-session-heading">Since this view opened</h3><div id="codex-jev-stats"></div><h3 id="codex-jev-history-heading">Recent Jev outcomes</h3><ol id="codex-jev-history"></ol><p id="codex-jev-empty">None yet</p></div>
      <div id="codex-jev-menu" role="group" aria-label="Jev hooks" data-open="false"><h2>Jev hooks</h2><button id="codex-jev-option" type="button" role="checkbox" aria-checked="false"><span id="codex-jev-check"></span><span><strong>PostToolUse · output filter</strong><small>Check repetitive tool output with Jev</small></span></button><p>Select none to turn Jev off.</p></div>`;
    document.body.appendChild(root);
    root.querySelector("#codex-jev-button").addEventListener("click", (event) => {
      event.stopPropagation();
      menuOpen = !menuOpen;
      render();
    });
    root.querySelector("#codex-jev-option").addEventListener("click", (event) => {
      event.stopPropagation();
      send("setSelection", !state.enabled);
      menuOpen = false;
      render();
    });
    document.addEventListener("click", (event) => {
      if (menuOpen && !root.contains(event.target)) { menuOpen = false; render(); }
    });
    document.addEventListener("keydown", (event) => {
      if (menuOpen && event.key === "Escape") { menuOpen = false; render(); }
    });
    render();
    return root;
  }

  function render() {
    if (!root) return;
    const button = root.querySelector("#codex-jev-button");
    const visual = !state.enabled ? "off" : state.busy ? "busy" :
      state.health?.ok === true ? "healthy" : state.health?.ok === false ? "failed" : "off";
    button.style.color = colors[visual];
    root.dataset.observe = String(state.enabled && state.mode === "observe");
    button.setAttribute("aria-expanded", String(menuOpen));
    root.dataset.menu = String(menuOpen);
    root.querySelector("#codex-jev-menu").dataset.open = String(menuOpen);
    root.querySelector("#codex-jev-option").setAttribute("aria-checked", String(state.enabled));
    const status = !state.enabled ? "Jev off" : state.health?.ok === true ? "Jev connected" :
      state.health?.ok === false ? "Jev unavailable" : "Checking Jev connection";
    root.querySelector("#codex-jev-tip strong").textContent = status;
    root.querySelector("#codex-jev-mode").textContent = state.enabled ?
      `PostToolUse · ${state.mode}` : "No hooks selected. Click to choose.";
    const stats = state.stats || {};
    const calls = Number(stats.calls) || 0;
    const completed = Number(stats.completed) || 0;
    const average = completed ? Math.round((Number(stats.elapsedMs) || 0) / completed) : 0;
    const totals = `${calls} calls · ${Number(stats.candidates) || 0} candidates · ${Number(stats.kept) || 0} kept` +
      (Number(stats.replaced) ? ` · ${Number(stats.replaced)} replaced` : "");
    root.querySelector("#codex-jev-stats").textContent = state.enabled ?
      `${totals}\n${(Number(stats.checkedChars) || 0).toLocaleString()} chars checked · ${average} ms avg` : "";
    root.querySelector("#codex-jev-stats").style.whiteSpace = "pre-line";
    root.querySelector("#codex-jev-session-heading").style.display = state.enabled ? "block" : "none";
    root.querySelector("#codex-jev-history-heading").style.display = state.enabled ? "block" : "none";
    const history = Array.isArray(state.history) ? state.history.slice(0, 3) : [];
    const list = root.querySelector("#codex-jev-history");
    list.replaceChildren(...history.map((line) => {
      const item = document.createElement("li");
      item.textContent = String(line);
      return item;
    }));
    root.querySelector("#codex-jev-empty").style.display = state.enabled && !history.length ? "block" : "none";
    button.setAttribute("aria-label", `${status}. Since this view opened: ${totals}. ${history.join(". ") || state.recent}. Select Jev hooks`);
  }

  function visibleRect(element) {
    const rect = element?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function findAnchor() {
    if (!document.body) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!/^(Full access|Workspace write|Read-only)$/i.test(node.textContent.trim())) continue;
      if (root?.contains(node)) continue;
      const element = node.parentElement?.closest('button,[role="button"]') || node.parentElement;
      const rect = visibleRect(element);
      if (rect && rect.bottom > window.innerHeight / 2 && rect.bottom < window.innerHeight) {
        return { element, rect };
      }
    }
    return null;
  }

  function findModel(anchor) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    let nearest = null;
    while ((node = walker.nextNode())) {
      const label = node.textContent.trim();
      if (!label || /^(Full access|Workspace write|Read-only)$/i.test(label) ||
          /^(IDE context|Context)$/i.test(label) || root?.contains(node)) continue;
      const element = node.parentElement?.closest('button,[role="button"]') || node.parentElement;
      const rect = visibleRect(element);
      if (!rect || rect.left <= anchor.rect.right || rect.left >= (nearest?.rect.left ?? window.innerWidth)) continue;
      const overlap = Math.min(rect.bottom, anchor.rect.bottom) - Math.max(rect.top, anchor.rect.top);
      if (overlap < Math.min(rect.height, anchor.rect.height) / 2) continue;
      nearest = { element, rect };
    }
    return nearest;
  }

  function commonAncestor(first, second) {
    for (let element = first; element; element = element.parentElement) {
      if (element.contains(second)) return element;
    }
    return document.body;
  }

  function observeLayout(anchor, model) {
    if (!layoutObserver) return;
    const elements = [anchor.element, model.element, commonAncestor(anchor.element, model.element)];
    if (observed.length === elements.length && observed.every((element, index) => element === elements[index])) return;
    layoutObserver.disconnect();
    observed = elements;
    for (const element of new Set(elements)) layoutObserver.observe(element);
  }

  function alignPopup(element, width, buttonLeft, rightEdge) {
    const actualWidth = Math.min(width, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rightEdge - actualWidth, window.innerWidth - actualWidth - 12));
    element.style.left = `${Math.round(left - buttonLeft)}px`;
    element.style.right = "auto";
  }

  function position() {
    const item = create();
    const anchor = findAnchor();
    const model = anchor && findModel(anchor);
    if (!model) { item.style.display = "none"; return; }
    observeLayout(anchor, model);
    const leftEdge = anchor.rect.right + 7;
    const rightEdge = model.rect.left - 8;
    const available = rightEdge - leftEdge;
    const button = item.querySelector("#codex-jev-button");
    item.style.display = "block";
    item.style.visibility = "hidden";
    item.dataset.compact = "false";
    const fullWidth = button.getBoundingClientRect().width;
    item.dataset.compact = String(available < fullWidth);
    const width = button.getBoundingClientRect().width;
    if (available < width) { item.style.display = "none"; return; }
    const buttonLeft = rightEdge - width;
    item.style.left = "auto";
    item.style.right = `${Math.round(window.innerWidth - rightEdge)}px`;
    item.style.top = `${Math.round(anchor.rect.top + anchor.rect.height / 2 - button.getBoundingClientRect().height / 2)}px`;
    alignPopup(item.querySelector("#codex-jev-menu"), 285, buttonLeft, rightEdge);
    alignPopup(item.querySelector("#codex-jev-tip"), 340, buttonLeft, rightEdge);
    item.style.visibility = "";
  }

  function schedulePosition() {
    if (positionScheduled) return;
    positionScheduled = true;
    setTimeout(() => { positionScheduled = false; position(); }, 0);
  }

  function start() {
    create();
    position();
    if (typeof ResizeObserver === "function") layoutObserver = new ResizeObserver(schedulePosition);
    const observer = new MutationObserver(schedulePosition);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, true);
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "codex-jev-reply") return;
      const sentView = sentViews.get(event.data.id);
      sentViews.delete(event.data.id);
      if (!sentView || sentView !== currentViewId()) return;
      if (event.data.status && typeof event.data.status === "object") {
        state = event.data.status;
        render();
      }
    });
    setInterval(() => send("status"), 120);
    setInterval(schedulePosition, 300);
    send("status");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
