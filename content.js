// Slides Prompt Copier  (v0.15)
// Copies the text after a configurable label (default "PROMPT:") on the current
// slide to your clipboard.
//   - Slideshow view (/present): always-visible round button over the slide.
//   - Preview view  (/preview): button in the footer bar after the menu.
//   - Edit view:                 no button (intentionally hidden).
// Click the button (or press Alt+C) to copy.
// LONG-PRESS the button to open settings: change the label ("slug") and pick
// which corner the slideshow button sits in. Settings are saved per-deck, and a
// new deck inherits your last-used settings.
//
// NOTE: this file is deliberately ASCII-only in its code (regexes are built from
// escape sequences) so that copy/paste or file-sync can't corrupt it.

(function () {
  "use strict";

  var VERSION = "0.15";
  var REPO_URL = "https://github.com/eluhrs/google-slides-copy-button";
  var BTN_ID = "sp-copy-btn";
  var PANEL_ID = "sp-settings-panel";
  var BAR_COLOR = "#444746";     // toolbar-gray icon (preview)
  var PRESENT_COLOR = "#ffffff"; // white icon on dark overlay (slideshow)

  // Settings (with defaults). 'corner' is one of tl, tr, bl, br.
  var settings = { slug: "PROMPT", corner: "tr" };

  // Regexes that depend on the slug are (re)built by rebuildTrigger().
  var triggerRe;
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function rebuildTrigger() { triggerRe = new RegExp(escapeRe(String(settings.slug || "").trim()) + "\\s*:", "i"); }
  rebuildTrigger();

  // Line/paragraph separators incl. U+2028/U+2029, built from escapes.
  var splitRe = new RegExp("[\\r\\n\\u000B\\u000C\\u2028\\u2029]+");
  // Keyboard-shortcut hint tokens Slides appends to slide text. Escaped symbols
  // are Cmd (U+2318), Option (U+2325), Control (U+2303), Shift (U+21E7).
  var noiseRe = new RegExp("[\\u2318\\u2325\\u2303\\u21E7]|\\b(?:Shift|Ctrl|Cmd|Command|Alt|Option|Fn)\\s*\\+|\\bEsc\\b");

  // --- Persistence (per-deck override + global "default" for new decks) -------
  function deckKey() {
    var m = location.pathname.match(/\/d\/([^/]+)/);
    return "deck:" + (m ? m[1] : "unknown");
  }
  function hasStorage() {
    try { return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local; }
    catch (e) { return false; }
  }
  function loadSettings(done) {
    if (!hasStorage()) { done(); return; }
    try {
      chrome.storage.local.get([deckKey(), "default"], function (res) {
        var s = (res && (res[deckKey()] || res["default"])) || null;
        if (s) {
          if (s.slug) settings.slug = String(s.slug).trim();
          if (s.corner) settings.corner = s.corner;
          rebuildTrigger();
        }
        done();
      });
    } catch (e) { done(); }
  }
  function saveSettings() {
    if (!hasStorage()) return;
    try {
      var rec = { slug: settings.slug, corner: settings.corner };
      var obj = {}; obj[deckKey()] = rec; obj["default"] = rec;
      chrome.storage.local.set(obj);
    } catch (e) {}
  }

  // --- Read slide text -------------------------------------------------------
  // Present mode keeps the previous/next slides in the DOM (off-screen) so we must
  // read only what is actually VISIBLE on screen -- otherwise the button could copy
  // a neighbouring slide's prompt. This returns true only for elements rendered in
  // their window's viewport.
  function isElVisible(el) {
    var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    if (r.bottom <= 0 || r.top >= win.innerHeight || r.right <= 0 || r.left >= win.innerWidth) return false;
    if (el.checkVisibility) { try { if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false; } catch (e) {} }
    return true;
  }

  // Slides renders the slide as vectors and exposes its text via SVG <text>/<tspan>
  // and aria-labels. We read only text INSIDE the slide's <svg> (and only visible),
  // which scopes to the current slide and excludes Google's HTML UI chrome (account
  // chip, status text, filmstrip, etc.) that would otherwise pollute the labels.
  function collectDocText(doc) {
    if (!doc || !doc.body) return "";
    var parts = [];
    try {
      doc.querySelectorAll("svg text, svg tspan, svg [aria-label]").forEach(function (el) {
        if (!isElVisible(el)) return;
        var aria = el.getAttribute && el.getAttribute("aria-label");
        if (aria) parts.push(aria);
        var tc = el.textContent;
        if (tc) parts.push(tc);
      });
    } catch (e) {}
    return parts.join("\n");
  }

  function getAllSlideText() {
    var text = collectDocText(document);
    var frames = document.querySelectorAll("iframe");
    for (var i = 0; i < frames.length; i++) {
      try {
        if (frames[i].contentDocument) text += "\n" + collectDocText(frames[i].contentDocument);
      } catch (e) {}
    }
    return text;
  }

  function trimUiNoise(s) {
    var m = s.match(noiseRe);
    if (m) s = s.slice(0, m.index);
    return s.trim();
  }

  // Take the text after the label, bounded by a line break, an [END] marker, or a
  // keyboard-shortcut hint. (We do NOT stop at the next "word:" -- prompts legibly
  // contain colons, e.g. "fields: name".) If the label appears more than once,
  // keep the longest result. This is the version that worked reliably for copy.
  function extractPrompt() {
    rebuildTrigger(); // always match against the CURRENT label (never stale)
    var full = getAllSlideText();
    var slug = String(settings.slug || "").trim();

    // In full-screen, the label and its content can land on SEPARATE lines, so we
    // can't stop at the first line break. Instead we stop at the next *other* label
    // that begins a line (the start of the next box), or [END], or a shortcut hint.
    // We do NOT stop at mid-line "word:" (e.g. "fields:") inside a prompt.
    var others = scanLabels().filter(function (l) { return l.toLowerCase() !== slug.toLowerCase(); });
    var boundaryRe = null;
    if (others.length) {
      var alt = others.map(escapeRe).join("|");
      boundaryRe = new RegExp("[\\r\\n\\u000B\\u000C\\u2028\\u2029]\\s*(?:" + alt + ")\\s*:");
    }

    // Slides' own UI (filmstrip of thumbnails, speaker-notes placeholder,
    // screen-reader hints) sits in the same document and can follow the LAST box,
    // regardless of which box is last (box order is Slides' internal order, not the
    // visible layout). Stop at the first such marker: a number-only line (filmstrip)
    // or one of Slides' fixed UI phrases. \s+ tolerates one-word-per-line rendering.
    var junkRe = new RegExp(
      "[\\r\\n\\u000B\\u000C\\u2028\\u2029]\\s*\\d{1,4}\\s*(?=[\\r\\n\\u000B\\u000C\\u2028\\u2029])" +
      "|To\\s+enable\\s+screen\\s+reader" +
      "|Turn\\s+on\\s+screen\\s+reader" +
      "|Click\\s+to\\s+add\\s+speaker\\s+notes" +
      "|HTML\\s+view\\s+of\\s+the\\s+presentation" +
      "|Banner\\s+hidden" +
      "|Document\\s+content" +
      "|press\\s+(?:Ctrl|Cmd|Command)\\s*\\+",
      "i"
    );

    var re = new RegExp(triggerRe.source, "gi");
    var best = null, m;
    while ((m = re.exec(full)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      var after = full.slice(m.index + m[0].length);
      var cut = after.length, idx;
      idx = after.search(/\[END\]/i); if (idx !== -1 && idx < cut) cut = idx;
      var nm = after.match(noiseRe); if (nm && nm.index < cut) cut = nm.index;
      if (boundaryRe) { var bi = after.search(boundaryRe); if (bi !== -1 && bi < cut) cut = bi; }
      var ji = after.search(junkRe); if (ji !== -1 && ji < cut) cut = ji;
      var cand = after.slice(0, cut).trim();
      if (cand && (!best || cand.length > best.length)) best = cand;
    }
    return best;
  }

  // --- Clipboard with fallback ---
  function copyText(text) {
    return navigator.clipboard.writeText(text).then(function () { return true; }, function () {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    });
  }

  // --- Icons (built via DOM; Slides enforces Trusted Types, so no innerHTML) ---
  var SVGNS = "http://www.w3.org/2000/svg";
  var COPY_PATH = "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z";
  var CHECK_PATH = "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z";

  function makeIcon(path, size) {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "currentColor");
    var p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", path);
    svg.appendChild(p);
    return svg;
  }
  function setIcon(btn, path) {
    var old = btn.querySelector("svg");
    if (old) old.remove();
    btn.appendChild(makeIcon(path, btn._iconSize || 18));
  }

  // Diagonal arrow pointing to the given corner (tl, tr, bl, br). Built from an
  // up-right arrow rotated into place. SVG markup is pure ASCII.
  function makeArrow(corner) {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    var p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", "M6 18 L18 6 M11 6 H18 V13"); // up-right arrow (tr)
    svg.appendChild(p);
    var rot = corner === "tr" ? 0 : corner === "br" ? 90 : corner === "bl" ? 180 : 270;
    if (rot) svg.style.transform = "rotate(" + rot + "deg)";
    return svg;
  }

  function flash(btn, state) {
    if (state === "copied") { setIcon(btn, CHECK_PATH); btn.style.color = "#34a853"; btn.title = "Copied!"; }
    else if (state === "fail") { btn.style.color = "#ea4335"; btn.title = "Copy failed"; }
    else { btn.style.color = "#fbbc04"; btn.title = "No '" + settings.slug + ":' on this slide"; }
    clearTimeout(btn._spT);
    btn._spT = setTimeout(function () {
      setIcon(btn, COPY_PATH);
      btn.style.color = btn._baseColor || BAR_COLOR;
      btn.title = baseTitle();
    }, 1300);
  }

  function baseTitle() { return "Copy '" + settings.slug + ":'  (long-press for settings, v" + VERSION + ")"; }

  // Brief on-screen message near the slide (also visible in full-screen) so the
  // result of a copy is obvious and reportable.
  function toast(msg, ok) {
    var t = document.getElementById("sp-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "sp-toast";
      Object.assign(t.style, {
        position: "fixed", left: "50%", bottom: "9%", transform: "translateX(-50%)",
        zIndex: "2147483647", padding: "8px 14px", borderRadius: "8px",
        font: "13px Arial, sans-serif", color: "#fff", maxWidth: "72%",
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)", pointerEvents: "none", textAlign: "center"
      });
    }
    t.style.background = ok ? "rgba(24,128,56,0.96)" : "rgba(180,40,30,0.96)";
    t.textContent = msg;
    currentHost().appendChild(t);
    clearTimeout(t._tT);
    t._tT = setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 1100);
  }

  function handleCopy(btn) {
    var prompt = extractPrompt();
    if (!prompt) {
      flash(btn, "none");
      toast("No '" + settings.slug + ":' on this slide", false);
      return;
    }
    copyText(prompt).then(function (ok) {
      flash(btn, ok ? "copied" : "fail");
      toast(ok ? ("Copied " + settings.slug) : ("Failed to copy " + settings.slug), ok);
    });
  }

  // --- Corner geometry ---
  function cornerStyle(corner, offset) {
    var o = { top: "", bottom: "", left: "", right: "" };
    if (corner === "tr") { o.top = offset; o.right = "14px"; }
    else if (corner === "tl") { o.top = offset; o.left = "14px"; }
    else if (corner === "br") { o.bottom = offset; o.right = "14px"; }
    else { o.bottom = offset; o.left = "14px"; } // bl
    return o;
  }

  // --- Per-mode styling ---
  function hoverBg(btn) {
    return btn.dataset.mode === "present" ? "rgba(32,33,36,0.80)" : "rgba(60,64,67,0.10)";
  }
  function idleBg(btn) {
    return btn.dataset.mode === "present" ? "rgba(32,33,36,0.55)" : "transparent";
  }
  function applyBarStyle(btn) {
    btn._baseColor = BAR_COLOR; btn._iconSize = 18;
    Object.assign(btn.style, {
      position: "static", margin: "0 0 0 6px", top: "", right: "", left: "", bottom: "",
      zIndex: "", width: "28px", height: "28px", borderRadius: "4px",
      color: BAR_COLOR, background: "transparent", boxShadow: ""
    });
  }
  function applyPresentStyle(btn) {
    btn._baseColor = PRESENT_COLOR; btn._iconSize = 20;
    var c = cornerStyle(settings.corner, "14px");
    Object.assign(btn.style, {
      position: "fixed", top: c.top, right: c.right, left: c.left, bottom: c.bottom, margin: "0",
      zIndex: "2147483647", width: "40px", height: "40px", borderRadius: "50%",
      color: PRESENT_COLOR, background: "rgba(32,33,36,0.55)", boxShadow: "0 1px 4px rgba(0,0,0,0.4)"
    });
    setIcon(btn, COPY_PATH);
  }

  // --- Settings panel ----------------------------------------------------------
  // Find "LABEL:" tags on the current slide (a word immediately followed by a
  // colon and then some text).
  function scanLabels() {
    var full = getAllSlideText();
    // Find "WORD:" tags anywhere (not just at line starts), so labels packed onto
    // one line are all detected.
    var re = /(?:^|\s)([A-Za-z0-9_]{1,40})\s*:\s*\S/g;
    var seen = {}, out = [], m;
    while ((m = re.exec(full)) !== null) {
      if (!/^\d+$/.test(m[1]) && !seen[m[1]]) { seen[m[1]] = 1; out.push(m[1]); } // skip pure-number "labels"
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    if (settings.slug && !seen[settings.slug]) out.push(settings.slug);
    return out;
  }

  // Apply a new label everywhere (live regex, storage, button tooltip).
  function applySlug(v) {
    v = String(v || "").trim();
    if (!v) return;
    settings.slug = v;
    rebuildTrigger();
    saveSettings();
    var b = document.getElementById(BTN_ID);
    if (b) b.title = baseTitle();
  }

  function styleCornerBtn(b, active) {
    Object.assign(b.style, {
      width: "34px", height: "28px", border: "1px solid #c7cdd6", borderRadius: "5px",
      background: active ? "#1a73e8" : "#fff", color: active ? "#fff" : "#444",
      cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center"
    });
  }

  function placePanel(panel) {
    var c = cornerStyle(settings.corner, "64px"); // sit just inside the button
    Object.assign(panel.style, { top: c.top, right: c.right, left: c.left, bottom: c.bottom });
  }

  function buildPanel() {
    var panel = document.createElement("div");
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: "fixed", zIndex: "2147483647", width: "230px", padding: "12px",
      background: "#ffffff", color: "#1f1f1f", border: "1px solid #dadce0",
      borderRadius: "10px", boxShadow: "0 2px 12px rgba(0,0,0,0.35)",
      font: "13px Arial, sans-serif", boxSizing: "border-box"
    });
    // don't let clicks/keys reach the slide
    ["click", "mousedown", "pointerdown", "dblclick", "keydown"].forEach(function (ev) {
      panel.addEventListener(ev, function (e) { e.stopPropagation(); });
    });

    var title = document.createElement("div");
    Object.assign(title.style, { fontWeight: "700", marginBottom: "8px" });
    title.appendChild(document.createTextNode("Copy button settings ("));
    var vlink = document.createElement("a");
    vlink.textContent = "v" + VERSION;
    vlink.href = REPO_URL;
    vlink.target = "_blank";
    vlink.rel = "noopener noreferrer";
    vlink.title = "View project on GitHub";
    vlink.style.color = "#1a73e8";
    vlink.addEventListener("click", function (e) { e.stopPropagation(); }); // open link, don't reach slide
    title.appendChild(vlink);
    title.appendChild(document.createTextNode(")"));
    panel.appendChild(title);

    // Label dropdown: choose which "LABEL:" on the slide to copy.
    var selLab = document.createElement("div");
    selLab.textContent = "Select Label to Copy:";
    Object.assign(selLab.style, { marginBottom: "4px", color: "#5f6368" });
    panel.appendChild(selLab);

    var select = document.createElement("select");
    select.id = "sp-slug-select";
    Object.assign(select.style, {
      width: "100%", padding: "6px 8px", boxSizing: "border-box",
      border: "1px solid #c7cdd6", borderRadius: "6px", marginBottom: "8px", font: "13px Arial"
    });
    var labels = scanLabels().slice().sort(function (a, b) { return a.localeCompare(b); });
    labels.forEach(function (lab) {
      var opt = document.createElement("option");
      opt.value = lab; opt.textContent = lab;
      if (lab === settings.slug) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("click", function (e) { e.stopPropagation(); });
    select.addEventListener("change", function (e) {
      e.stopPropagation();
      applySlug(select.value);
    });
    Object.assign(select.style, { marginBottom: "12px" });
    panel.appendChild(select);

    var posLab = document.createElement("div");
    posLab.textContent = "Select button corner:";
    Object.assign(posLab.style, { marginBottom: "6px", color: "#5f6368" });
    panel.appendChild(posLab);

    var grid = document.createElement("div");
    Object.assign(grid.style, { display: "grid", gridTemplateColumns: "34px 34px", gap: "6px", marginBottom: "10px", justifyContent: "start" });
    var corners = [["tl", "TL"], ["tr", "TR"], ["bl", "BL"], ["br", "BR"]];
    corners.forEach(function (pair) {
      var b = document.createElement("button");
      b.type = "button";
      b.title = pair[1]; // TL / TR / BL / BR tooltip
      b.appendChild(makeArrow(pair[0]));
      b.dataset.corner = pair[0];
      styleCornerBtn(b, settings.corner === pair[0]);
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        settings.corner = pair[0];
        saveSettings();
        ensureButton();          // re-place the button
        placePanel(panel);       // keep panel near the new corner
        refreshCornerButtons(panel);
      });
      grid.appendChild(b);
    });
    panel.appendChild(grid);

    var row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "8px", justifyContent: "flex-end" });
    var done = document.createElement("button");
    done.type = "button"; done.textContent = "Done";
    Object.assign(done.style, { padding: "6px 12px", border: "none", borderRadius: "6px", background: "#1a73e8", color: "#fff", cursor: "pointer", font: "600 13px Arial" });
    done.addEventListener("click", function (e) { e.stopPropagation(); closePanel(); });
    row.appendChild(done);
    panel.appendChild(row);

    return panel;
  }

  function refreshCornerButtons(panel) {
    var btns = panel.querySelectorAll("button[data-corner]");
    for (var i = 0; i < btns.length; i++) styleCornerBtn(btns[i], btns[i].dataset.corner === settings.corner);
  }

  function currentHost() {
    var fs = document.fullscreenElement || document.webkitFullscreenElement || null;
    return fs || document.documentElement;
  }

  function openSettings() {
    closePanel();
    var panel = buildPanel();
    placePanel(panel);
    currentHost().appendChild(panel); // same host as button -> visible in full-screen
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
  }

  // --- Button ------------------------------------------------------------------
  function createButton() {
    var btn = document.createElement("div");
    btn.id = BTN_ID;
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "Copy prompt");
    btn.title = baseTitle();
    btn._iconSize = 18;
    btn._baseColor = BAR_COLOR;
    Object.assign(btn.style, {
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      cursor: "pointer", boxSizing: "border-box", verticalAlign: "middle"
    });
    setIcon(btn, COPY_PATH);

    btn.addEventListener("mouseenter", function () { if (btn.title.indexOf("Copy") === 0) btn.style.background = hoverBg(btn); });
    btn.addEventListener("mouseleave", function () { btn.style.background = idleBg(btn); });

    // Long-press opens settings; a normal click copies. Keep both away from the slide.
    var lpTimer = null, lpFired = false;
    function cancelLp() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }
    btn.addEventListener("pointerdown", function (e) {
      e.stopPropagation();
      lpFired = false;
      cancelLp();
      lpTimer = setTimeout(function () { lpFired = true; openSettings(); }, 500);
    });
    btn.addEventListener("pointerup", function (e) { e.stopPropagation(); cancelLp(); });
    btn.addEventListener("pointerleave", function () { cancelLp(); });
    btn.addEventListener("pointercancel", function () { cancelLp(); });
    // preventDefault on mousedown keeps focus on the slide, so the slideshow's
    // own arrow/nav controls keep working after a copy (no need to click the slide).
    btn.addEventListener("mousedown", function (e) { e.stopPropagation(); e.preventDefault(); });
    btn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (lpFired) { lpFired = false; return; } // long-press already handled
      handleCopy(btn);
      // Hand focus straight back to the slideshow so its nav controls respond
      // immediately (don't make the user click the slide first).
      try { if (document.body && document.body.focus) document.body.focus({ preventScroll: true }); } catch (e2) {}
    });
    return btn;
  }

  function isPresentMode() { return /\/present\b/.test(location.pathname); }

  // Slideshow/full-screen -> floating button; preview -> footer bar; edit -> none.
  function ensureButton() {
    var fs = document.fullscreenElement || document.webkitFullscreenElement || null;
    var present = isPresentMode() || !!fs;
    var navbar = present ? null : document.querySelector(".punch-viewer-navbar");
    var group = navbar && navbar.firstElementChild;
    var mode = present ? "present" : (group ? "bar" : "none");

    var btn = document.getElementById(BTN_ID);

    if (mode === "none") { if (btn) btn.remove(); closePanel(); return; }

    if (!btn) btn = createButton();

    // Apply styling only on an actual change (re-styling every tick would swap
    // the icon and trigger the MutationObserver in a loop).
    if (btn.dataset.mode !== mode) {
      btn.dataset.mode = mode;
      if (mode === "present") { applyPresentStyle(btn); btn._appliedCorner = settings.corner; }
      else applyBarStyle(btn);
    } else if (mode === "present" && btn._appliedCorner !== settings.corner) {
      // corner changed -> just move it (no icon churn)
      var cc = cornerStyle(settings.corner, "14px");
      Object.assign(btn.style, { top: cc.top, right: cc.right, left: cc.left, bottom: cc.bottom });
      btn._appliedCorner = settings.corner;
    }

    if (mode === "bar") {
      if (group && btn.parentElement !== group) group.appendChild(btn);
    } else {
      var host = fs || document.documentElement;
      if (btn.parentElement !== host) host.appendChild(btn);
    }
  }

  // Keyboard shortcut: Alt+C
  document.addEventListener("keydown", function (e) {
    if (e.altKey && (e.key === "c" || e.key === "C")) {
      var btn = document.getElementById(BTN_ID);
      if (btn) handleCopy(btn);
    }
  });

  // Re-place the button when entering/leaving full-screen slideshow.
  document.addEventListener("fullscreenchange", function () { ensureButton(); });
  document.addEventListener("webkitfullscreenchange", function () { ensureButton(); });

  // Live-sync settings across all open tabs of any deck: when one tab saves a new
  // label/corner, every other tab updates immediately (no reload needed).
  if (hasStorage() && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "local") return;
        // Only react to THIS deck's saved settings. (Don't adopt the global
        // "default" here -- that's only a seed for brand-new decks at load time;
        // reacting to it would let another deck's label overwrite this one.)
        var dk = deckKey();
        var rec = changes[dk] && changes[dk].newValue;
        if (!rec) return;
        if (rec.slug && String(rec.slug).trim() !== settings.slug) { settings.slug = String(rec.slug).trim(); rebuildTrigger(); }
        if (rec.corner) settings.corner = rec.corner;
        var btn = document.getElementById(BTN_ID);
        if (btn) btn.title = baseTitle();
        ensureButton();
      });
    } catch (e) {}
  }

  // Load saved settings, then start. The interval is a cheap self-heal.
  loadSettings(function () {
    ensureButton();
    var obs = new MutationObserver(function () { ensureButton(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(ensureButton, 1000);
  });
})();
