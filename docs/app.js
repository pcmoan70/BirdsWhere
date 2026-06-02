/**
 * BirdNET Geomodel – Interactive Web Demo
 *
 * Runs the ONNX FP16 model entirely client-side via ONNX Runtime Web.
 * Four modes:
 *   1. Range Map    – species probability heatmap on a Leaflet map
 *   2. Richness Map – predicted species count per cell
 *   3. Species List – click a location to see predicted species
 *   4. Bar Charts   – click a location to see 48-week phenology bars
 *
 * The model input is (batch, 3) = [lat, lon, week] and output is
 * (batch, n_species) sigmoid probabilities.
 */

(function () {
  "use strict";

  // ---- Configuration -------------------------------------------------------
  var MODEL_URL = "geomodel_fp16.onnx";
  var LABELS_URL = "labels.txt";
  var TAX_URL = "taxonomy.csv";

  // ---- i18n / species names ------------------------------------------------
  var lang = "en";            // current UI + species-name language code
  var langTaxCol = "com_name"; // taxonomy.csv column for current language
  var taxByCode = {};          // species_code -> { com_name, class_name, common_name_xx, ... }
  var secondLang = "";         // optional 2nd species-name language ("" = off)
  var secondTaxCol = "";       // taxonomy column for the 2nd language
  var showSci = true;          // show the scientific-name column in lists

  function t(key, vars) { return window.GeoI18N.t(lang, key, vars); }

  // Common name for a label in language `code` (taxonomy column `taxCol`),
  // falling back to the English common name then the scientific name. When the
  // language column is missing/empty or merely repeats the English name, the
  // English name is shown in brackets to flag it as unresolved, e.g.
  // "[Barn Swallow]". The scientific-name fallback is never bracketed.
  function nameInCol(label, code, taxCol) {
    var row = label && taxByCode[label.key];
    if (row) {
      var en = row.com_name || "";
      var loc = row[taxCol] || "";
      if (code === "en") return en || loc || (label && (label.common || label.sci || label.key)) || "";
      if (loc && (!en || loc.toLowerCase() !== en.toLowerCase())) return loc;
      if (en) return "[" + en + "]";
      if (loc) return "[" + loc + "]";
    }
    if (label && label.common) return code === "en" ? label.common : "[" + label.common + "]";
    return (label && (label.sci || label.key)) || "";
  }

  function speciesName(label) { return nameInCol(label, lang, langTaxCol); }

  // Name in the optional second language ("" when the feature is off).
  function secondName(label) { return secondLang ? nameInCol(label, secondLang, secondTaxCol) : ""; }
  function setSecondLang(code) {
    secondLang = code || "";
    secondTaxCol = secondLang ? window.GeoI18N.langByCode(secondLang).taxCol : "";
  }
  // Toggle the scientific-name column on the species-list table via a class
  // (CSS hides .sci cells + the header when present). Pure presentation.
  function applyShowSci() {
    var tbl = document.getElementById("species-list-table");
    if (tbl) tbl.classList.toggle("hide-sci", !showSci);
  }

  // ---- Species-group filter (taxonomic class) ------------------------------
  // Groups present in the model: aves, mammalia, amphibia, insecta.
  var speciesGroup = "all";   // "all" or a class_name value
  var hiResFactor = 0;        // detail offset in zoom levels / H3 resolutions (0 = auto, ±N = coarser/finer)
  var distMapToken = 0;       // guards against stale distribution-map fetches
  var recentToken = 0;        // guards against stale recent-detections fetches
  var labelClass = [];        // class_name per label index (built after load)

  function buildLabelClass() {
    labelClass = labels.map(function (l) {
      var row = taxByCode[l.key];
      return (row && row.class_name) || "";
    });
  }

  // Is the species at label index `i` in the active group?
  function inGroup(i) { return speciesGroup === "all" || labelClass[i] === speciesGroup; }

  // Richness cache key — distinct per group so counts don't collide.
  function richKey() { return "__richness__@" + speciesGroup; }

  // The header (settings) icon reflects the active species group. All icons are
  // monochrome SVGs in one style (currentColor; small details in deep teal),
  // not emoji — so they match the app palette.
  var EYE = "#0b3a3a";   // deep-teal detail (eyes/nose) on the white silhouette
  var GROUP_ICON = {
    // Binoculars (All) — line style.
    all: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="6.7" cy="14.6" r="4.3"/><circle cx="17.3" cy="14.6" r="4.3"/>' +
      '<path d="M3.7 11.8 L5.4 5.4 A1.2 1.2 0 0 1 6.6 4.5 H8.6 A1 1 0 0 1 9.6 5.5 V11"/>' +
      '<path d="M20.3 11.8 L18.6 5.4 A1.2 1.2 0 0 0 17.4 4.5 H15.4 A1 1 0 0 0 14.4 5.5 V11"/>' +
      '<line x1="9.6" y1="8" x2="14.4" y2="8"/></g>',
    // Songbird (Birds) — side profile: round head + body, beak, cocked tail, legs.
    aves: '<g fill="currentColor">' +
      '<circle cx="8.5" cy="8.5" r="4"/>' +
      '<ellipse cx="13" cy="14" rx="6.5" ry="5"/>' +
      '<polygon points="5,7.2 1.8,8.6 5,9.8"/>' +
      '<polygon points="17,10 23,5.6 19,13"/>' +
      '<path d="M11 18.4 L10.4 22 M14 18.6 L14.6 22" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/>' +
      '</g>' +
      '<circle cx="8" cy="7.6" r="1.2" fill="' + EYE + '"/>',
    // Fox (Mammals) — pointed ears + triangular face, eyes + nose.
    mammalia: '<g fill="currentColor"><polygon points="3,4 9.2,9 5.2,11"/><polygon points="21,4 14.8,9 18.8,11"/>' +
      '<path d="M5,8.6 H19 L12,21 Z"/></g>' +
      '<circle cx="9" cy="12" r="1.15" fill="' + EYE + '"/><circle cx="15" cy="12" r="1.15" fill="' + EYE + '"/>' +
      '<circle cx="12" cy="17.4" r="1.3" fill="' + EYE + '"/>',
    // Bee (Insects) — head + antennae + wings + striped abdomen (3 bars).
    insecta: '<g fill="currentColor"><circle cx="12" cy="6.3" r="2.4"/>' +
      '<path d="M10.4 4.7 L8.8 2.6 M13.6 4.7 L15.2 2.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" fill="none"/>' +
      '<ellipse cx="7.4" cy="10.2" rx="2.4" ry="3.2" transform="rotate(-28 7.4 10.2)"/>' +
      '<ellipse cx="16.6" cy="10.2" rx="2.4" ry="3.2" transform="rotate(28 16.6 10.2)"/>' +
      '<rect x="8.4" y="9.6" width="7.2" height="2.4" rx="1.2"/>' +
      '<rect x="8.4" y="13" width="7.2" height="2.4" rx="1.2"/>' +
      '<rect x="9.6" y="16.4" width="4.8" height="2.4" rx="1.2"/></g>',
    // Frog (Amphibians) — two eye bumps on top + wide body + front legs.
    amphibia: '<g fill="currentColor"><circle cx="8.4" cy="7" r="3"/><circle cx="15.6" cy="7" r="3"/>' +
      '<path d="M3 15.5 a9 7 0 0 1 18 0 q0 3 -3 3 H6 q-3 0 -3 -3 Z"/>' +
      '<path d="M6.5 18 l-2 3 M17.5 18 l2 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></g>' +
      '<circle cx="8.4" cy="7" r="1.15" fill="' + EYE + '"/><circle cx="15.6" cy="7" r="1.15" fill="' + EYE + '"/>',
  };
  function settingsIconHtml(group) {
    return '<svg class="bird-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      (GROUP_ICON[group] || GROUP_ICON.all) + "</svg>";
  }
  function updateSettingsIcon() {
    var btn = document.getElementById("settings-toggle");
    if (btn) btn.innerHTML = settingsIconHtml(speciesGroup);
  }

  // The banner is fixed; publish its height so the page content and the
  // full-screen overlays (Species List / Checklist) start below it.
  function syncHeaderHeight() {
    var h = document.getElementById("site-header");
    if (h) document.documentElement.style.setProperty("--header-h", h.offsetHeight + "px");
  }

  // Stretch the map from its current top down to the bottom of the viewport so
  // it uses the full screen height (overrides the CSS aspect-ratio sizing). The
  // top is read live, so it adapts to the controls bar wrapping or mode changes.
  function fitMapHeight() {
    var el = document.getElementById("demo-map");
    if (!el || el.offsetParent === null) return;   // not visible yet
    var top = el.getBoundingClientRect().top;
    el.style.aspectRatio = "auto";
    el.style.maxHeight = "none";
    el.style.height = Math.max(320, Math.round(window.innerHeight - top - 8)) + "px";
    if (map) { map.invalidateSize(); updateWorldMinZoom(); }
  }
  // Set minZoom so the most zoomed-out view shows the whole world exactly once —
  // you can zoom out until the world fits, but no further (no tiny/repeated map).
  function updateWorldMinZoom() {
    if (!map) return;
    var size = map.getSize();
    if (!size || size.x < 50 || size.y < 50) return;   // not laid out yet
    // World size in pixels at zoom 0 (CRS-aware; ~256 for the default CRS).
    var w = Math.abs(map.project([0, 180], 0).x - map.project([0, -180], 0).x) || 256;
    var h = Math.abs(map.project([-85.0511, 0], 0).y - map.project([85.0511, 0], 0).y) || 256;
    // Whole world visible = the limiting dimension fills the view (not floored
    // to the H3 ladder — flooring would allow one extra step of zoom-out).
    var fit = Math.min(Math.log(size.x / w) / Math.LN2, Math.log(size.y / h) / Math.LN2);
    var mz = Math.max(0, fit);
    if (Math.abs(map.getMinZoom() - mz) > 0.01) map.setMinZoom(mz);
  }
  var animCtrlEl = null;   // the on-map migration-animation control container
  var h3CtrlEl = null;     // the on-map H3 detail (+/-) control container
  // Step the H3 detail offset (range/richness overlay) finer/coarser, -2..+2.
  function adjustH3Detail(delta) {
    var v = Math.max(-2, Math.min(2, (hiResFactor | 0) + delta));
    if (v === hiResFactor) return;
    hiResFactor = v;
    window.GeoState.save({ hiResOffset: hiResFactor });
    updateH3DetailButtons();
    if (currentMode === "range" || currentMode === "richness") { clearOverlay(); triggerRender(); }
  }
  function updateH3DetailButtons() {
    if (!h3CtrlEl) return;
    var finer = h3CtrlEl.querySelector(".h3-finer"), coarser = h3CtrlEl.querySelector(".h3-coarser");
    if (finer) finer.classList.toggle("leaflet-disabled", hiResFactor >= 2);
    if (coarser) coarser.classList.toggle("leaflet-disabled", hiResFactor <= -2);
  }
  // Circular arrow to start the animation; pause bars while it's playing.
  function animIconSvg(playing) {
    return playing
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/></svg>';
  }
  function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  function fsIconSvg() {
    // Outward arrows when normal (→ expand), inward when already full-screen.
    return isFullscreen()
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  }
  function toggleFullscreen() {
    var d = document, el = d.documentElement;
    if (!isFullscreen()) { var req = el.requestFullscreen || el.webkitRequestFullscreen; if (req) req.call(el); }
    else { var ex = d.exitFullscreen || d.webkitExitFullscreen; if (ex) ex.call(d); }
  }
  // In-page prompt/confirm replacements. Native window.prompt/confirm drop the
  // browser out of full-screen, so the point-list dialogs use these instead.
  function uiDialog(opts) {
    return new Promise(function (resolve) {
      var ov = document.createElement("div");
      ov.className = "ui-modal-overlay";
      var box = document.createElement("div");
      box.className = "ui-modal";
      var msg = document.createElement("div");
      msg.className = "ui-modal-msg";
      msg.textContent = opts.message || "";
      box.appendChild(msg);
      var input = null;
      if (opts.input) {
        input = document.createElement("input");
        input.type = "text"; input.className = "ui-modal-input"; input.value = opts.value || "";
        box.appendChild(input);
      }
      var btns = document.createElement("div");
      btns.className = "ui-modal-btns";
      var cancel = document.createElement("button");
      cancel.type = "button"; cancel.className = "demo-btn demo-btn-light"; cancel.textContent = t("btn.cancel");
      var ok = document.createElement("button");
      ok.type = "button"; ok.className = "demo-btn"; ok.textContent = t("popup.ok");
      btns.appendChild(cancel); btns.appendChild(ok);
      box.appendChild(btns); ov.appendChild(box);
      document.body.appendChild(ov);
      function close(val) { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener("keydown", onKey, true); resolve(val); }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); close(opts.input ? null : false); }
        else if (e.key === "Enter") { e.preventDefault(); close(opts.input ? input.value : true); }
      }
      cancel.addEventListener("click", function () { close(opts.input ? null : false); });
      ok.addEventListener("click", function () { close(opts.input ? input.value : true); });
      ov.addEventListener("click", function (e) { if (e.target === ov) close(opts.input ? null : false); });
      document.addEventListener("keydown", onKey, true);
      if (input) { input.focus(); input.select(); }
    });
  }
  function modalPrompt(message, value) { return uiDialog({ message: message, input: true, value: value }); }
  function modalConfirm(message) { return uiDialog({ message: message, input: false }); }

  // Grid resolution per zoom level (degrees per cell). Finer cells at deeper
  // zoom keep the heatmap detailed without exploding the cell count.
  var ZOOM_STEP = { 2: 3, 3: 2, 4: 1, 5: 0.5, 6: 0.5, 7: 0.25, 8: 0.25, 9: 0.125, 10: 0.0625, 11: 0.03125,
    12: 0.015625, 13: 0.0078125, 14: 0.00390625, 15: 0.001953125, 16: 0.0009765625, 17: 0.00048828125, 18: 0.000244140625 };
  var MAX_ZOOM = 18;
  // Snap the map's zoom to steps of ~2.65x (log2 ≈ 1.404) — one H3 resolution
  // per zoom level — so the chosen H3 cell size stays constant on screen as you
  // zoom (H3 resolutions are ~2.65x apart, vs the usual 2x per zoom level).
  var H3_ZOOM_STEP = (typeof window !== "undefined" && window.h3)
    ? Math.log(window.h3.getHexagonEdgeLengthAvg(5, "m") ? window.h3.getHexagonEdgeLengthAvg(4, "m") / window.h3.getHexagonEdgeLengthAvg(5, "m") : 2.6458) / Math.LN2
    : 1.404;

  // Perceptual scaling: gamma < 1 stretches low values for visibility
  var DISPLAY_GAMMA = 0.5;

  // Preselected species (species code for quick access)
  // Curated to showcase: long-distance migrants, year-round residents,
  // pelagic seabirds, island endemics, raptors, and non-bird taxa.
  var FEATURED_SPECIES = [
    // Long-distance migrants
    { key: "barswa",  sci: "Hirundo rustica",        common: "Barn Swallow" },
    { key: "arcter",  sci: "Sterna paradisaea",      common: "Arctic Tern" },
    { key: "comcuc",  sci: "Cuculus canorus",         common: "Common Cuckoo" },
    { key: "rthhum",  sci: "Archilochus colubris",   common: "Ruby-throated Hummingbird" },
    { key: "eubeat1", sci: "Merops apiaster",         common: "European Bee-eater" },
    // Year-round residents
    { key: "gretit1", sci: "Parus major",             common: "Great Tit" },
    { key: "norcar",  sci: "Cardinalis cardinalis",   common: "Northern Cardinal" },
    { key: "supfai1", sci: "Malurus cyaneus",         common: "Superb Fairywren" },
    { key: "greroa",  sci: "Geococcyx californianus", common: "Greater Roadrunner" },
    // Pelagic seabirds
    { key: "bripet",  sci: "Hydrobates pelagicus",    common: "European Storm-Petrel" },
    { key: "wispet",  sci: "Oceanites oceanicus",     common: "Wilson\u2019s Storm-Petrel" },
    { key: "atlpuf",  sci: "Fratercula arctica",      common: "Atlantic Puffin" },
    { key: "bkbalb",  sci: "Thalassarche melanophris",common: "Black-browed Albatross" },
    // Island endemics
    { key: "hawgoo",  sci: "Branta sandvicensis",     common: "Hawaiian Goose (N\u0113n\u0113)" },
    { key: "kea1",    sci: "Nestor notabilis",        common: "Kea" },
    { key: "galhaw1", sci: "Buteo galapagoensis",     common: "Gal\u00e1pagos Hawk" },
    { key: "galpen1", sci: "Spheniscus mendiculus",   common: "Gal\u00e1pagos Penguin" },
    { key: "kagu1",   sci: "Rhynochetos jubatus",     common: "Kagu" },
    // Nocturnal species
    { key: "tawowl1", sci: "Strix aluco",             common: "Tawny Owl" },
    { key: "grhowl",  sci: "Bubo virginianus",        common: "Great Horned Owl" },
    { key: "eurnig1", sci: "Caprimulgus europaeus",   common: "Eurasian Nightjar" },
    { key: "compot1", sci: "Nyctibius griseus",       common: "Common Potoo" },
    // Non-bird taxa
    { key: "42069",   sci: "Vulpes vulpes",           common: "Red Fox" },
    { key: "41663",   sci: "Procyon lotor",           common: "Common Raccoon" },
    { key: "46001",   sci: "Sciurus vulgaris",        common: "Eurasian Red Squirrel" },
  ];

  // ---- Colormap ------------------------------------------------------------
  var COLORMAP = (function () {
    var stops = [
      [0.0,   0,   0,   4],
      [0.14, 31,  12,  72],
      [0.28, 85,  15, 109],
      [0.42, 136,  8,  79],
      [0.56, 186, 54,  36],
      [0.70, 227, 105,  5],
      [0.84, 249, 174,  10],
      [1.0,  252, 255, 164],
    ];
    var ramp = new Array(256);
    for (var i = 0; i < 256; i++) {
      var t = i / 255;
      var lo = stops[0], hi = stops[stops.length - 1];
      for (var s = 0; s < stops.length - 1; s++) {
        if (t >= stops[s][0] && t <= stops[s + 1][0]) {
          lo = stops[s]; hi = stops[s + 1]; break;
        }
      }
      var f = (t - lo[0]) / (hi[0] - lo[0] || 1);
      ramp[i] = [
        Math.round(lo[1] + f * (hi[1] - lo[1])),
        Math.round(lo[2] + f * (hi[2] - lo[2])),
        Math.round(lo[3] + f * (hi[3] - lo[3])),
      ];
    }
    return ramp;
  })();

  function colormapLookup(p) {
    var idx = Math.max(0, Math.min(255, Math.round(p * 255)));
    return COLORMAP[idx] || [0, 0, 0];
  }

  // ---- Utilities -----------------------------------------------------------
  function perceptualNorm(raw, maxVal) {
    var out = new Float32Array(raw.length);
    if (maxVal > 0) {
      for (var i = 0; i < raw.length; i++)
        out[i] = Math.pow(raw[i] / maxVal, DISPLAY_GAMMA);
    }
    return out;
  }

  function wrapLon(v) { return ((((v + 180) % 360) + 360) % 360) - 180; }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // Mode-appropriate guidance shown in the status line when there's no active
  // selection — so the text below the controls always matches the current mode.
  function modeHint() {
    if (currentMode === "list") return t("status.hintList");
    if (currentMode === "richness") return t("status.hintRichness");
    if (currentMode === "barchart") return t("status.hintBarchart");
    return t("status.selectSpecies");   // range default
  }
  function setStatus(msg) {
    var el = document.getElementById("demo-status");
    if (el) el.textContent = msg;
  }

  function weekText(w) {
    var months = window.GeoI18N.months(lang);
    var period = window.GeoI18N.periods(lang);
    var mi = Math.floor((w - 1) / 4);
    var pi = (w - 1) % 4;
    return t("week.fmt", { w: w, period: period[pi], month: months[mi] || months[11] });
  }

  // Format a grid step (degrees) for the status line — keep significant digits
  // for the fine steps used at deep zoom (so it never shows "0°").
  function fmtStep(s) { return s >= 0.1 ? (Math.round(s * 100) / 100) : +s.toPrecision(2); }

  // Current BirdNET week (1–48) for today's date.
  function weekOfToday() {
    var now = new Date();
    var dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / 86400000) + 1;
    return Math.max(1, Math.min(48, Math.floor((dayOfYear - 1) / 365 * 48) + 1));
  }

  // ---- State ---------------------------------------------------------------
  var worker = null;
  var inferenceId = 0;
  var pendingInferences = new Map();
  var labels = [];
  var labelsByKey = {};
  var map = null;
  var overlayCanvas = null;
  var offscreenCanvas = null;   // small one-texel-per-cell buffer for smoothing
  var cachedRender = null;
  var renderCache = new Map();
  var RENDER_CACHE_MAX = 50;
  // Species-Range H3 cell-value cache: "speciesCode:week" -> { h3index: rawProb }.
  // Accumulates cells across every zoom/pan so revisiting an area needs no new
  // inference; merged on render. Persisted to localStorage, capped (MB) via a
  // Settings control; oldest (species,week) tags are evicted to fit the cap.
  var h3RangeCache = new Map();
  var H3_CACHE_KEY = "geomodel-h3cache-v1";
  var h3CacheMB = 2;          // localStorage budget for the range cache (0 = off)
  var h3SaveTimer = null;
  function h3RangeCacheFor(tag) {
    var m = h3RangeCache.get(tag);
    if (!m) { m = {}; h3RangeCache.set(tag, m); if (h3RangeCache.size > 600) h3RangeCache.delete(h3RangeCache.keys().next().value); }
    return m;
  }
  function loadH3Cache() {
    if (h3CacheMB <= 0) return;
    try {
      var obj = JSON.parse(localStorage.getItem(H3_CACHE_KEY) || "{}");
      Object.keys(obj).forEach(function (tag) { h3RangeCache.set(tag, obj[tag]); });   // insertion order = oldest first
    } catch (e) { /* corrupt / unavailable — ignore */ }
  }
  function h3CacheToJson() {
    var obj = {};
    h3RangeCache.forEach(function (cells, tag) {
      var o = {};
      for (var c in cells) { var v = cells[c]; o[c] = v < 0.0001 ? 0 : +v.toFixed(4); }   // round to shrink
      obj[tag] = o;
    });
    return obj;
  }
  function scheduleH3Save() {
    if (h3SaveTimer) clearTimeout(h3SaveTimer);
    h3SaveTimer = setTimeout(saveH3Cache, 2500);
  }
  function saveH3Cache() {
    h3SaveTimer = null;
    if (h3CacheMB <= 0) { try { localStorage.removeItem(H3_CACHE_KEY); } catch (e) {} return; }
    var capChars = h3CacheMB * 1e6;   // ~1 char ≈ 1 byte for this ascii/numeric data
    var obj = h3CacheToJson(), str = JSON.stringify(obj);
    // Evict oldest tags (Map order) until within the cap.
    while (str.length > capChars && Object.keys(obj).length > 1) {
      delete obj[Object.keys(obj)[0]];
      str = JSON.stringify(obj);
    }
    try { localStorage.setItem(H3_CACHE_KEY, str); }
    catch (e) {   // quota exceeded — drop half the tags and retry once
      var keys = Object.keys(obj); for (var i = 0; i < keys.length / 2; i++) delete obj[keys[i]];
      try { localStorage.setItem(H3_CACHE_KEY, JSON.stringify(obj)); } catch (e2) { try { localStorage.removeItem(H3_CACHE_KEY); } catch (e3) {} }
    }
  }
  var marker = null;
  // Drop (or move) the single location pin so the map always shows which point
  // the Species List / Migration page is computed for. No-op if it's already
  // there, so click-driven renders don't flicker the marker.
  function setPointMarker(lat, lon) {
    if (!map || !isFinite(lat) || !isFinite(lon)) return;
    if (marker) {
      var ll = marker.getLatLng();
      if (Math.abs(ll.lat - lat) < 1e-6 && Math.abs(ll.lng - lon) < 1e-6) return;
      map.removeLayer(marker);
    }
    marker = L.marker([lat, lon]).addTo(map);
  }
  // Position indicators: a red plus marks where you were when you tapped the
  // crosshairs (a snapshot); a blue plus follows the live GPS position.
  var posMarker = null, posFixedMarker = null, posWatching = false, posCentered = false;
  function livePosIcon(kind) {
    return L.divIcon({
      className: "live-pos live-pos-" + kind,
      html: '<svg viewBox="0 0 28 28" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">' +
        '<line x1="14" y1="1" x2="14" y2="9"/><line x1="14" y1="19" x2="14" y2="27"/>' +
        '<line x1="1" y1="14" x2="9" y2="14"/><line x1="19" y1="14" x2="27" y2="14"/>' +
        '<circle cx="14" cy="14" r="3" fill="currentColor" stroke="none"/></svg>',
      iconSize: [28, 28], iconAnchor: [14, 14]
    });
  }
  function toggleLiveLocate() {
    var btn = document.querySelector(".geo-locate-btn");
    if (posWatching) {   // turn tracking off
      posWatching = false;
      try { map.stopLocate(); } catch (e) {}
      if (posMarker) { map.removeLayer(posMarker); posMarker = null; }
      if (posFixedMarker) { map.removeLayer(posFixedMarker); posFixedMarker = null; }
      if (btn) btn.classList.remove("is-active");
      return;
    }
    posWatching = true; posCentered = false;
    if (btn) btn.classList.add("is-active");
    map.locate({ watch: true, enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
  }
  var currentMode = "range";
  var fieldData = null;       // current probability-ranked species for the field checklist
  var fieldQuery = "";        // fuzzy filter text for the field checklist
  var fieldFilter = "all";    // checklist row filter: "all" | "seen" | "missing"
  var fieldPlaceToken = 0;    // guards against stale field-place lookups
  var fieldLat = 0, fieldLon = 0;   // current field-checklist point
  var fieldKey = null;        // listId (placeKey@day) of the field checklist currently open
  var fieldNameCache = {};    // placeKey -> resolved place name (auto-title for new lists)
  var fieldGeoWatch = null;   // geolocation watch id while a checklist is open
  var fieldGeoLast = null;    // freshest device position {lat,lon,ts} while a checklist is open
  var entryEditKey = null;    // species whose observations the entry-edit page is showing
  var rendering = false;
  var renderGeneration = 0;
  var moveEndTimer = null;
  var lastCsvData = null;   // { filename, content } for current data product
  var lastSpeciesPdf = null;   // { name2Head, cmpHead, rows } for the species-list PDF

  // Migration animation state
  var animateAll = false;   // when true, range/richness precompute all 48 weeks
  var animating = false;    // animation playback in progress
  var animReady = false;    // all 48 weeks cached → progress bar stays scrubbable
  var animTimer = null;
  var ANIM_INTERVAL = 350;  // ms between animation frames

  // Location-analysis state (Timeline / Probability / Arrivals / Scatter)
  var analysisData = null;  // { lat, lon, allProbs:Float32Array, nSpecies }
  var analysisTab = "timeline";
  var scatterSort = { column: "arrival", dir: "desc" };

  // Species the user has chosen to hide ("Do not show"). species_code -> true.
  var hiddenSpecies = {};
  var interestingSpecies = {};
  // Species-list filter mode, cycled by clicking the "Species" column header:
  // "" (default — exclude hidden) → "interesting" (only ★ tagged) → "hidden"
  // (only species the user has hidden — lets the list show them for review).
  var speciesListFilter = "";
  // Age threshold (days since most recent detection) for the species list, cycled
  // by clicking the "Age" column header: 0 (off) → 1 → 3 → 7 → 14 → 21 → 28 → 0.
  var speciesAgeFilterDays = 0;
  // Active sort for the per-point species list. Default is the natural model
  // ranking (prob desc, set by the render function). Clicking the Scientific
  // name or # column header overrides it and toggles asc/desc.
  var speciesListSort = { col: "", dir: "" };
  var menuKey = null, menuName = "", menuSci = "";  // species the menu targets

  function isHidden(key) { return !!hiddenSpecies[key]; }
  function loadHidden() {
    hiddenSpecies = {};
    (window.GeoState.get("hidden", []) || []).forEach(function (k) { hiddenSpecies[k] = true; });
  }
  function persistHidden() { window.GeoState.save({ hidden: Object.keys(hiddenSpecies) }); }
  function hideSpecies(key) {
    if (!key) return;
    hiddenSpecies[key] = true;
    persistHidden(); refreshHiddenUI(); refreshCurrentView();
  }
  function unhideSpecies(key) {
    delete hiddenSpecies[key];
    persistHidden(); refreshHiddenUI(); refreshCurrentView();
  }

  // ★ Interesting — a user-tagged set persisted alongside the hidden list. Used
  // to filter species lists and the field checklist down to the ones flagged.
  function isInteresting(key) { return !!interestingSpecies[key]; }
  function loadInteresting() {
    interestingSpecies = {};
    (window.GeoState.get("interesting", []) || []).forEach(function (k) { interestingSpecies[k] = true; });
  }
  function persistInteresting() { window.GeoState.save({ interesting: Object.keys(interestingSpecies) }); }
  function toggleInteresting(key) {
    if (!key) return;
    if (interestingSpecies[key]) delete interestingSpecies[key]; else interestingSpecies[key] = true;
    persistInteresting(); refreshCurrentView();
  }

  // "★ " prefix for species the user has tagged as interesting (lists/cards).
  // Wrapped in a styled span so the star is visually distinct from the name.
  function interestingStar(key) { return isInteresting(key) ? '<span class="int-star" aria-label="interesting">★</span> ' : ""; }
  // Header label for the "Species" column reflecting the active filter mode.
  function speciesHeadLabel() {
    if (speciesListFilter === "interesting") return "★ " + t("th.species");
    if (speciesListFilter === "hidden") return "🚫 " + t("th.species");
    return t("th.species");
  }
  // Should a row be kept under the current filter mode? Encapsulates the rule
  // so renderSpeciesList and renderSpeciesInCountry stay consistent.
  function passSpeciesFilter(key) {
    if (speciesListFilter === "interesting") return isInteresting(key);
    if (speciesListFilter === "hidden") return isHidden(key);
    return !isHidden(key);
  }
  // Header label for the "Age" column reflecting the current threshold.
  function ageHeadLabel() {
    if (speciesAgeFilterDays === -1) return ">0 ▾";   // any species with an observation
    return speciesAgeFilterDays ? "≤" + speciesAgeFilterDays + "d ▾" : t("th.nd");
  }
  // Refresh the sort-arrow indicator on the sortable column headers.
  function updateSortIndicators() {
    var pairs = [["sci", "sp-sci-head", "th.sci"]];
    pairs.forEach(function (p) {
      var el = document.getElementById(p[1]); if (!el) return;
      var arrow = speciesListSort.col === p[0] ? (speciesListSort.dir === "asc" ? " ▲" : " ▼") : "";
      el.textContent = t(p[2]) + arrow;
    });
  }
  // Sort the rendered species-list rows in place by the active column, keeping
  // the existing filters intact (we only reorder rows, never remove or hide).
  function sortSpeciesList() {
    var tbody = document.getElementById("sp-tbody");
    if (!tbody || !speciesListSort.col) return;
    var agg = tbody._sightingsAgg || {};
    // Keep "not in model" rows anchored at the bottom; only sort the model rows.
    var all = Array.prototype.slice.call(tbody.children);
    var extras = all.filter(function (tr) { return tr.classList.contains("sp-extra"); });
    var rows = all.filter(function (tr) { return !tr.classList.contains("sp-extra"); });
    rows.sort(function (a, b) {
      var ka, kb;
      if (speciesListSort.col === "sci") {
        ka = (a.children[2].textContent || "").toLowerCase();
        kb = (b.children[2].textContent || "").toLowerCase();
      } else {   // "count"
        var sa = a.querySelector(".sp-link"), sb = b.querySelector(".sp-link");
        var keyA = sa && sa.getAttribute("data-key"), keyB = sb && sb.getAttribute("data-key");
        ka = (agg[keyA] && agg[keyA].count) || 0;
        kb = (agg[keyB] && agg[keyB].count) || 0;
      }
      var cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
      return speciesListSort.dir === "asc" ? cmp : -cmp;
    });
    var frag = document.createDocumentFragment();
    rows.forEach(function (tr) { frag.appendChild(tr); });
    extras.forEach(function (tr) { frag.appendChild(tr); });   // uncovered species stay at the bottom
    tbody.appendChild(frag);
  }
  function cycleSpeciesListSort(col) {
    if (!currentSpView || currentSpView.mode !== "point") return;
    // Default direction is column-appropriate (alphabetical asc / numerical
    // desc). Each column cycles: default → opposite → off → default → ...
    var defaultDir = (col === "sci") ? "asc" : "desc";
    var oppositeDir = defaultDir === "asc" ? "desc" : "asc";
    if (speciesListSort.col === col) {
      if (speciesListSort.dir === defaultDir) speciesListSort.dir = oppositeDir;
      else { speciesListSort.col = ""; speciesListSort.dir = ""; }
    } else {
      speciesListSort.col = col;
      speciesListSort.dir = defaultDir;
    }
    updateSortIndicators();
    if (speciesListSort.col) sortSpeciesList();
    else refreshCurrentView();   // off → re-render gives the natural prob desc ranking
  }
  // Apply the age filter to the per-point species list. Operates on the cached
  // sightings aggregation stored on the tbody so toggling the filter is instant
  // (no re-fetch). Rows with no detection or older than the threshold get
  // display:none; everything else is shown.
  function applyAgeFilter() {
    var tbody = document.getElementById("sp-tbody");
    if (!tbody) return;
    var agg = tbody._sightingsAgg, days = speciesAgeFilterDays;
    Array.prototype.forEach.call(tbody.querySelectorAll("tr"), function (tr) {
      if (!days || !agg) { tr.style.display = ""; return; }
      // ">0": keep only species that have at least one observation (any age).
      if (days === -1) {
        if (tr.classList.contains("sp-extra")) { tr.style.display = ""; return; }   // extras are observed by definition
        var slX = tr.querySelector(".sp-link"), kX = slX && slX.getAttribute("data-key");
        var eX = kX && agg[kX];
        tr.style.display = (eX && eX.count > 0) ? "" : "none";
        return;
      }
      // sp-extra rows carry their age directly (no sp-link / agg entry).
      if (tr.classList.contains("sp-extra")) {
        var d = parseInt(tr.getAttribute("data-age-days"), 10);
        tr.style.display = (!isNaN(d) && d <= days) ? "" : "none";
        return;
      }
      var sl = tr.querySelector(".sp-link"), key = sl && sl.getAttribute("data-key");
      var entry = key && agg[key];
      if (!entry || !entry.latestTs) { tr.style.display = "none"; return; }
      tr.style.display = (Math.round((Date.now() - entry.latestTs) / 86400000) <= days) ? "" : "none";
    });
  }
  // Clickable species-name span (opens the species menu). Prepends ★ when the
  // species is tagged interesting; data-name keeps the bare name (no star).
  function nameLinkHtml(label) {
    var n = escapeHtml(speciesName(label));
    return '<span class="sp-link" data-key="' + escapeHtml(label.key) + '" data-name="' + n +
           '" data-sci="' + escapeHtml(label.sci || "") + '">' + interestingStar(label.key) + n + "</span>";
  }

  function openExternal(url) { window.open(url, "_blank", "noopener"); }

  // ---- In-app screen history (browser/phone Back button) ------------------
  // Each full-screen page or modal that opens pushes a history entry and
  // registers a DOM-only close(). The browser Back button (popstate) closes
  // the top-most open screen. Every explicit close (on-screen Back/Close
  // button or programmatic) goes through navClose(id), which hides the screen
  // now and quietly rewinds the matching history entry.
  var navStack = [];      // [{ id, close }]
  var navSuppress = 0;    // popstate events to ignore (from our own history.back)
  function navOpen(id, close) {
    for (var i = 0; i < navStack.length; i++) {
      if (navStack[i].id === id) { navStack[i].close = close; return; }   // already open (re-render) — don't double-push
    }
    navStack.push({ id: id, close: close });
    try { history.pushState({ nav: id }, ""); } catch (e) {}
  }
  function navClose(id) {
    for (var i = navStack.length - 1; i >= 0; i--) {
      if (navStack[i].id === id) {
        var ent = navStack.splice(i, 1)[0];
        navSuppress++;
        try { history.back(); } catch (e) { navSuppress--; }
        try { ent.close(); } catch (e) {}
        return true;
      }
    }
    return false;
  }
  function navCloseTop() { if (navStack.length) { try { history.back(); } catch (e) {} } }   // same as pressing Back
  function onNavPop() {
    if (navSuppress > 0) { navSuppress--; return; }
    if (!navStack.length) return;
    var top = navStack.pop();
    try { top.close(); } catch (e) {}
  }
  // Hide whichever full-screen page (species list / migration / checklist) is
  // open and return to the map. Used as the registered close for the "page" slot.
  function closeAnyFullPage() {
    var fp = document.getElementById("field-page");
    if (fp && fp.style.display !== "none") {
      if (typeof hideFcPicker === "function") hideFcPicker();
      if (typeof hidePlacePicker === "function") hidePlacePicker();
      if (typeof stopFieldGeoWatch === "function") stopFieldGeoWatch();
      fp.style.display = "none";
    }
    var sp = document.getElementById("species-panel");
    if (sp && sp.classList.contains("as-page")) { sp.classList.remove("as-page"); sp.style.display = "none"; }
    var bc = document.getElementById("barchart-panel");
    if (bc && bc.classList.contains("as-page")) { bc.classList.remove("as-page"); bc.style.display = "none"; }
    saveSession({ page: "" });
    if (map) map.invalidateSize();
  }

  // Wikipedia article (chosen language) for a species; scientific name is the
  // most reliable search term and resolves to the localized article.
  function wikipediaUrl(sci) {
    var wl = lang === "zh-CN" ? "zh" : lang;
    return "https://" + wl + ".wikipedia.org/wiki/Special:Search?search=" + encodeURIComponent(sci);
  }

  // Open the species' Wikipedia article in the UI language, falling back to the
  // English article when the locale-language Wikipedia has no page for it.
  // The tab is opened synchronously (preserving the user gesture) and its URL
  // is set once the locale page's existence is known.
  function openWikipedia(sci) {
    var wl = lang === "zh-CN" ? "zh" : lang;
    var enUrl = "https://en.wikipedia.org/wiki/Special:Search?search=" + encodeURIComponent(sci);
    if (wl === "en") { openExternal(enUrl); return; }
    var w = window.open("about:blank", "_blank");
    var go = function (url) { if (w) { w.location.href = url; } else { openExternal(url); } };
    fetch("https://" + wl + ".wikipedia.org/w/api.php?origin=*&format=json&action=query&redirects=1&titles=" + encodeURIComponent(sci))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var pages = j.query && j.query.pages;
        var page = pages && pages[Object.keys(pages)[0]];
        var exists = page && page.missing === undefined && page.pageid !== undefined;
        go(exists ? "https://" + wl + ".wikipedia.org/wiki/" + encodeURIComponent(String(page.title || sci).replace(/ /g, "_")) : enUrl);
      })
      .catch(function () { go(enUrl); });
  }

  // Macaulay Library media catalog: eBird taxon code for birds (label keys are
  // eBird codes), else a free-text search by scientific name.
  function macaulayUrl(key, sci) {
    if (/^[a-z]/i.test(key) && !/^\d+$/.test(key)) {
      return "https://search.macaulaylibrary.org/catalog?taxonCode=" + encodeURIComponent(key);
    }
    return "https://search.macaulaylibrary.org/catalog?q=" + encodeURIComponent(sci);
  }

  // Xeno-canto audio recordings — search by scientific name (graceful for any
  // taxon, vs. a species page that would 404 on a naming mismatch).
  function xenoCantoUrl(sci) {
    return "https://xeno-canto.org/explore?query=" + encodeURIComponent(String(sci || "").trim());
  }
  // National observation sites by ISO-3166 alpha-2 country code — homepage
  // URLs plus the i18n key for each label. We append the scientific name as a
  // hash so the species is visible in the address bar for copy/paste into the
  // site's own search; the sites don't reliably take a search query string.
  // GB and IE share BirdTrack. Single source of truth for both the map-click
  // chooser and the saved-point popup.
  var NAT_LIST_URLS = {
    NO: "https://www.artsobservasjoner.no/",
    SE: "https://www.artportalen.se/",
    DK: "https://dofbasen.dk/",
    FI: "https://www.tiira.fi/",
    DE: "https://www.ornitho.de/",
    AT: "https://www.ornitho.at/",
    CH: "https://www.ornitho.ch/",
    FR: "https://www.faune-france.org/",
    IT: "https://www.ornitho.it/",
    LU: "https://www.ornitho.lu/",
    PL: "https://www.ornitho.pl/",
    HR: "https://www.fauna.hr/",
    NL: "https://waarneming.nl/",
    BE: "https://waarnemingen.be/",
    GB: "https://www.bto.org/our-science/projects/birdtrack",
    IE: "https://www.bto.org/our-science/projects/birdtrack",
    LV: "https://dabasdati.lv/",
    CZ: "https://avif.birds.cz/",
    SK: "https://aves.vtaky.sk/",
    ES: "https://ebird.org/spain/home",
    PT: "https://ebird.org/portugal/home",
    EE: "https://elurikkus.ee/",
    LT: "https://birdlife.lt/",
    SI: "https://www.ptice.si/",
    HU: "https://map.mme.hu/",
    GR: "https://www.ornithologiki.gr/",
    TR: "https://ebird.org/region/TR",
    MT: "https://birdlifemalta.org/",
    RO: "https://openbirdmaps.ro/",
    BG: "https://smartbirds.org/",
    UA: "https://ukrbin.com/",
    RS: "https://pticesrbije.rs/",
    ME: "https://czip.me/",
    MK: "https://mes.org.mk/",
    AL: "https://aos-alb.org/",
    BA: "https://naseptice.ba/",
    CA: "https://ebird.org/canada/home",
    US: "https://ebird.org/home",
    AU: "https://ebird.org/australia/home",
    NZ: "https://ebird.org/newzealand/home"
  };
  var NAT_LIST_KEY = {
    NO: "menu.artsobs", SE: "menu.artportalen", DK: "menu.dofbasen", FI: "menu.tiira",
    DE: "menu.ornithode", AT: "menu.ornithoat", CH: "menu.ornithoch", FR: "menu.faunefr",
    IT: "menu.ornithoit", LU: "menu.ornitholu", PL: "menu.ornithopl", HR: "menu.faunahr",
    NL: "menu.waarnemingnl", BE: "menu.waarnemingenbe", GB: "menu.birdtrack", IE: "menu.birdtrack",
    LV: "menu.dabasdati", CZ: "menu.avif", SK: "menu.avessk",
    ES: "menu.ebirdes", PT: "menu.portugalaves", EE: "menu.elurikkus", LT: "menu.birdlifelt",
    SI: "menu.dopps", HU: "menu.mme", GR: "menu.hos", TR: "menu.ebirdtr", MT: "menu.birdlifemt",
    RO: "menu.openbirdmaps", BG: "menu.smartbirds", UA: "menu.ukrbin", RS: "menu.pticesrbije",
    ME: "menu.czip", MK: "menu.mesmk", AL: "menu.aosal", BA: "menu.naseptice",
    CA: "menu.ebirdca", US: "menu.ebirdus", AU: "menu.ebirdau", NZ: "menu.ebirdnz"
  };
  function natListUrl(cc, sci) {
    var base = NAT_LIST_URLS[cc]; if (!base) return null;
    var name = String(sci || "").trim();
    return name ? base + "#species=" + encodeURIComponent(name) : base;
  }
  function urlHostLabel(u) {
    try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return String(u || "").slice(0, 40); }
  }
  // The shipped defaults as a flat [{cc, url}] list, in declaration order.
  function builtinCountryLinks() {
    return Object.keys(NAT_LIST_URLS).map(function (cc) { return { cc: cc, url: NAT_LIST_URLS[cc] }; });
  }
  // The effective national-database list. The built-in defaults are ALWAYS
  // present (so the leading national portals can never be accidentally lost by
  // editing) and the user's saved / legacy custom entries are layered on top,
  // de-duplicated by cc+url.
  function effectiveCountryLinks() {
    var out = builtinCountryLinks(), seen = {};
    out.forEach(function (e) { seen[e.cc.toUpperCase() + "|" + e.url] = 1; });
    var extra = (window.GeoState.get("countryLinks", []) || [])
      .concat(window.GeoState.get("customCountryUrls", []) || [])
      .filter(function (c) { return c && c.cc && c.url; });
    extra.forEach(function (c) {
      var key = String(c.cc).toUpperCase() + "|" + c.url;
      if (!seen[key]) { seen[key] = 1; out.push({ cc: String(c.cc).toUpperCase(), url: c.url }); }
    });
    return out;
  }
  function saveCountryLinks(arr) { window.GeoState.save({ countryLinks: arr }); }
  // A built-in entry keeps its localised brand label; user/custom entries show
  // the URL hostname.
  function labelForLink(e) {
    if (NAT_LIST_URLS[e.cc] === e.url && NAT_LIST_KEY[e.cc]) return t(NAT_LIST_KEY[e.cc]);
    return urlHostLabel(e.url);
  }
  // Settings UI: one editable row per (cc, url) pair.
  function cuRowHtml(cc, url) {
    // Inline widths so the layout can't be overridden by the panel's generic
    // input[type=text]{width:100%} rule (which previously stretched the CC box
    // and hid the URL field). Inline style beats any stylesheet selector.
    return '<div class="cu-row" style="display:flex;gap:4px;align-items:center;width:100%">' +
      '<input type="text" class="cu-cc" maxlength="3" value="' + escapeHtml(cc || "") + '" placeholder="' + escapeHtml(t("ph.cc")) + '" style="flex:0 0 auto;width:3.2em;text-align:center;text-transform:uppercase">' +
      '<input type="url" class="cu-url" value="' + escapeHtml(url || "") + '" placeholder="' + escapeHtml(t("ph.url")) + '" style="flex:1 1 auto;min-width:0;width:auto">' +
      '<button type="button" class="cu-del" aria-label="remove" style="flex:0 0 auto;width:26px">×</button>' +
    '</div>';
  }
  function renderCustomUrls() {
    var list = document.getElementById("custom-urls-list"); if (!list) return;
    list.innerHTML = effectiveCountryLinks().map(function (c) { return cuRowHtml(c.cc, c.url); }).join("");
  }
  // Read the editable rows back out (DOM is the source of truth while editing);
  // only complete cc+url pairs are persisted.
  function collectCustomUrls() {
    var arr = [];
    document.querySelectorAll("#custom-urls-list .cu-row").forEach(function (row) {
      var cc = (row.querySelector(".cu-cc").value || "").trim().toUpperCase();
      var url = (row.querySelector(".cu-url").value || "").trim();
      // Persist only true additions — built-in defaults are always reapplied by
      // effectiveCountryLinks(), so storing them again would just risk staleness.
      if (cc && url && NAT_LIST_URLS[cc] !== url) arr.push({ cc: cc, url: url });
    });
    return arr;
  }
  // All observation/registration links to offer for a country, from the
  // effective (possibly user-edited) list. Returns [{ label, url }]. When a
  // country has no entry at all, fall back to its eBird region page
  // (ebird.org/region/<CC>) — eBird has a page for essentially every country.
  function natServicesFor(cc) {
    var out = effectiveCountryLinks()
      .filter(function (e) { return String(e.cc).toUpperCase() === cc; })
      .map(function (e) { return { label: labelForLink(e), url: e.url }; });
    if (!out.length && /^[A-Z]{2}$/.test(cc || "")) {
      out.push({ label: "eBird (" + cc + ")", url: "https://ebird.org/region/" + cc });
    }
    return out;
  }

  // eBird species page (label keys are eBird taxon codes) — shows recent
  // sightings and a map; falls back to a search for non-code keys.
  function ebirdUrl(key, sci) {
    if (/^[a-z]/i.test(key) && !/^\d+$/.test(key)) return "https://ebird.org/species/" + encodeURIComponent(key);
    return "https://ebird.org/species/search?q=" + encodeURIComponent(String(sci || "").trim());
  }

  // Best-effort direct factsheet slug (works only when BirdLife's genus matches
  // eBird's); used as a no-JS fallback href and last resort.
  function slugify(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
  function birdlifeUrl(en, sci) {
    return "https://datazone.birdlife.org/species/factsheet/" + slugify(en) + "-" + slugify(sci);
  }

  // Open the species' BirdLife DataZone factsheet. BirdLife uses its own
  // taxonomy (e.g. Sandhill Crane is Grus canadensis there, Antigone canadensis
  // in eBird), so a slug built from eBird names can 404 / hit the wrong species.
  // Instead we look up the species' numeric BirdLife ID from Wikidata
  // (property P5257) and open /species/factsheet/<id>, which redirects to the
  // correct factsheet. The tab is opened synchronously (user gesture) and its
  // URL is set once the ID is fetched; falls back to the slug on any failure.
  function openBirdLife(en, sci) {
    var w = window.open("about:blank", "_blank");
    var done = false;
    var go = function (url) { if (done) return; done = true; if (w) { w.location.href = url; } else { openExternal(url); } };
    var fallback = birdlifeUrl(en, sci);
    setTimeout(function () { go(fallback); }, 6000);   // don't leave a blank tab if Wikidata is slow
    var wd = "https://www.wikidata.org/w/api.php?origin=*&format=json&action=";
    fetch(wd + "wbsearchentities&type=item&language=en&search=" + encodeURIComponent(sci))
      .then(function (r) { return r.json(); })
      .then(function (s) {
        var qid = s.search && s.search[0] && s.search[0].id;
        if (!qid) { go(fallback); return; }
        return fetch(wd + "wbgetclaims&property=P5257&entity=" + qid)
          .then(function (r) { return r.json(); })
          .then(function (c) {
            var cl = c.claims && c.claims.P5257;
            var v = cl && cl[0] && cl[0].mainsnak.datavalue && cl[0].mainsnak.datavalue.value;
            go(v ? "https://datazone.birdlife.org/species/factsheet/" + encodeURIComponent(v) : fallback);
          });
      })
      .catch(function () { go(fallback); });
  }
  function isBirdKey(key) { return /^aves$/i.test((taxByCode[key] || {}).class_name || ""); }

  // Normalize a taxonomic class/iconic-taxon string (from GBIF "class" or
  // iNat "iconic_taxon_name") to a canonical bucket we render badges for.
  // Returns "" when the value looks like junk we shouldn't show.
  function normClass(s) {
    if (!s) return "";
    var k = String(s).toLowerCase();
    if (/^aves\b|\bbird/.test(k)) return "Aves";
    if (/^mammal/.test(k)) return "Mammalia";
    if (/^insect/.test(k)) return "Insecta";
    if (/^reptil/.test(k)) return "Reptilia";
    if (/^amphib/.test(k)) return "Amphibia";
    if (/^actinopt|^chondri|^pisces|^osteicht|\bfish\b/.test(k)) return "Pisces";
    if (/^arachn/.test(k)) return "Arachnida";
    if (/^mollusc|^gastropod|^bivalv|^cephalopod/.test(k)) return "Mollusca";
    if (/^plantae|^magnolio|^liliop|^plant/.test(k)) return "Plantae";
    if (/^fungi|^basidiom|^ascomy/.test(k)) return "Fungi";
    // Unknown but non-empty — pass through so it still shows somewhere.
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }
  // Short glyph for a normalised class — used as a tiny inline badge so the
  // user can tell a record's taxonomic group at a glance.
  var CLASS_GLYPH = {
    Aves: "🐦", Mammalia: "🦊", Insecta: "🦋", Reptilia: "🦎",
    Amphibia: "🐸", Pisces: "🐟", Arachnida: "🕷",
    Mollusca: "🐚", Plantae: "🌿", Fungi: "🍄"
  };
  function classGlyph(c) { return CLASS_GLYPH[c] || (c ? "•" : ""); }

  // ---- Recent detections pop-up (iNaturalist) -----------------------------
  function hideRecent() { document.getElementById("recent-modal").style.display = "none"; }

  // WKT bounding box of radius ~km around a point (longitude scaled by latitude),
  // counter-clockwise as GBIF expects.
  function gbifGeometry(lat, lon, km) {
    var dLat = km / 111.32;
    var cos = Math.cos(lat * Math.PI / 180);
    var dLon = km / (111.32 * (cos > 0.01 ? cos : 0.01));
    var s = Math.max(-90, lat - dLat), n = Math.min(90, lat + dLat), w = lon - dLon, e = lon + dLon;
    return "POLYGON((" + w + " " + s + "," + e + " " + s + "," + e + " " + n + "," + w + " " + n + "," + w + " " + s + "))";
  }
  // ISO-3166 alpha-2 → Fatbirder country page (continent/slug). Fatbirder uses
  // each country's full official name (Kingdom of …, Republic of …, …), so we
  // bundle a map rather than try to derive it. Countries not in the map fall
  // back to a Fatbirder site search.
  var FB_COUNTRY = {
    AD:"europe/principality-of-andorra",AL:"europe/albanian-republic",AM:"europe/republic-of-armenia",
    AR:"south-america/argentine-republic",AT:"europe/republic-of-austria",AU:"oceania/commonwealth-of-australia",
    AZ:"europe/republic-of-azerbaijan",BA:"europe/bosnia-and-herzegovina",BE:"europe/kingdom-of-belgium",
    BG:"europe/republic-of-bulgaria",BO:"south-america/plurinational-state-of-bolivia",
    BR:"south-america/federative-republic-of-brazil",BW:"africa/republic-of-botswana",
    BY:"europe/republic-of-belarus",CA:"north-america/canada",CL:"south-america/republic-of-chile",
    CN:"asia/peoples-republic-of-china",CO:"south-america/republic-of-colombia",
    CY:"europe/republic-of-cyprus",CZ:"europe/czech-republic",DE:"europe/federal-republic-of-germany",
    DK:"europe/kingdom-of-denmark",EC:"south-america/republic-of-ecuador",EE:"europe/republic-of-estonia",
    EG:"africa/arab-republic-of-egypt",ES:"europe/kingdom-of-spain",
    ET:"africa/federal-democratic-republic-of-ethiopia",FI:"europe/republic-of-finland",
    FR:"europe/french-republic",GB:"europe/united-kingdom",GE:"europe/georgia",
    GI:"europe/gibraltar",GR:"europe/hellenic-republic",HR:"europe/republic-of-croatia",
    HU:"europe/hungary",ID:"asia/republic-of-indonesia",IE:"europe/irish-republic",
    IL:"asia/state-of-israel",IN:"asia/republic-of-india",IR:"asia/islamic-republic-of-iran",
    IS:"europe/iceland",IT:"europe/italian-republic",JP:"asia/japan",
    KE:"africa/republic-of-kenya",KR:"asia/republic-of-korea",
    LI:"europe/principality-of-liechtenstein",LT:"europe/lithuania",
    LU:"europe/grand-duchy-of-luxembourg",LV:"europe/republic-of-latvia",
    MA:"africa/kingdom-of-morocco",MC:"europe/principality-of-monaco",
    MD:"europe/republic-of-moldova",ME:"europe/montenegro",
    MK:"europe/republic-of-north-macedonia",MT:"europe/republic-of-malta",
    MX:"north-america/united-mexican-states",MY:"asia/malaysia",
    NA:"africa/republic-of-namibia",NL:"europe/netherlands",
    NO:"europe/kingdom-of-norway",NZ:"oceania/new-zealand",
    PE:"south-america/republic-of-peru",PH:"asia/republic-of-the-philippines",
    PL:"europe/republic-of-poland",PT:"europe/portuguese-republic",
    RO:"europe/romania",RS:"europe/republic-of-serbia",
    RU:"europe/russian-federation",SA:"asia/kingdom-of-saudi-arabia",
    SE:"europe/kingdom-of-sweden",SG:"asia/republic-of-singapore",
    SI:"europe/republic-of-slovenia",SK:"europe/slovak-republic",
    SM:"europe/republic-of-san-marino",TH:"asia/kingdom-of-thailand",
    TR:"europe/republic-of-turkey",TZ:"africa/united-republic-of-tanzania",
    UA:"europe/ukraine",UG:"africa/republic-of-uganda",
    AE:"asia/united-arab-emirates",US:"north-america/united-states-of-america",
    VE:"south-america/bolivarian-republic-of-venezuela",
    VN:"asia/socialist-republic-of-vietnam",ZA:"africa/republic-of-south-africa"
  };
  function fatbirderUrl(cc, name) {
    if (cc && FB_COUNTRY[cc]) return "https://fatbirder.com/world-birding/" + FB_COUNTRY[cc] + "/";
    return "https://fatbirder.com/?s=" + encodeURIComponent(name || cc || "");
  }
  // BirdLife DataZone factsheet for a country. Their canonical URL uses the
  // English country name lowercased and hyphen-separated (verified: monaco,
  // norway, united-kingdom, united-states-of-america all resolve).
  function birdLifeCountryUrl(cc, name) {
    if (!name) return "https://datazone.birdlife.org/";
    var slug = String(name).toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
    return "https://datazone.birdlife.org/country/factsheet/" + slug + "/";
  }

  // Reverse-geocode the ISO-3166 alpha-2 country code for a point (cached).
  var countryCache = {};   // key -> { cc, name }
  function countryInfo(lat, lon) {
    var k = lat.toFixed(2) + "," + lon.toFixed(2);
    if (countryCache[k] !== undefined) return Promise.resolve(countryCache[k]);
    return fetch("https://nominatim.openstreetmap.org/reverse?format=json&zoom=3&addressdetails=1&accept-language=en&lat=" + lat + "&lon=" + lon, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var addr = (j && j.address) || {};
        var info = { cc: (addr.country_code || "").toUpperCase(), name: addr.country || "" };
        countryCache[k] = info; return info;
      })
      .catch(function () { var info = { cc: "", name: "" }; countryCache[k] = info; return info; });
  }
  function countryCode(lat, lon) { return countryInfo(lat, lon).then(function (i) { return i.cc; }); }

  // GBIF occurrences in a 25 km box over a date range. GBIF has no server-side
  // date sort, so we page the date-filtered results (up to ~900) and sort
  // client-side, returning the 100 most recent.
  async function gbifRecent(sci, lat, lon, range, radiusKm) {
    var base = "https://api.gbif.org/v1/occurrence/search?hasCoordinate=true&limit=300&scientificName=" +
      encodeURIComponent(sci) + "&geometry=" + encodeURIComponent(gbifGeometry(lat, lon, radiusKm || 25)) +
      "&eventDate=" + encodeURIComponent(range);
    var all = [], offset = 0, total = Infinity, pages = 0;
    while (offset < total && pages < 3) {
      var j = await (await fetch(base + "&offset=" + offset)).json();
      total = j.count || 0;
      var res = j.results || [];
      for (var i = 0; i < res.length; i++) all.push(res[i]);
      offset += 300; pages++;
      if (res.length < 300) break;
    }
    all.sort(function (a, b) { return String(b.eventDate || "").localeCompare(String(a.eventDate || "")); });
    return all.slice(0, 100).map(function (o) {
      return {
        src: "GBIF",
        origin: o.datasetName || "",   // the underlying dataset GBIF aggregated
        cls: normClass(o.class),
        dt: o.eventDate || "",
        date: (o.eventDate || "").slice(0, 10) || "—",
        lat: o.decimalLatitude != null ? o.decimalLatitude : null,
        lon: o.decimalLongitude != null ? o.decimalLongitude : null,
        place: o.locality || o.verbatimLocality || o.stateProvince || o.county || o.country || "",
        who: (Array.isArray(o.recordedBy) ? o.recordedBy.join(", ") : o.recordedBy) || o.datasetName || "",
        note: o.occurrenceRemarks || "",
        url: o.key ? "https://www.gbif.org/occurrence/" + o.key : ""
      };
    });
  }

  // iNaturalist observations (live everywhere) for the same window, newest first.
  async function inatRecent(sci, lat, lon, d1, d2, radiusKm) {
    var url = "https://api.inaturalist.org/v1/observations?verifiable=true&order_by=observed_on&order=desc&per_page=100" +
      "&d1=" + d1 + "&d2=" + d2 + "&taxon_name=" + encodeURIComponent(sci) +
      "&lat=" + lat.toFixed(4) + "&lng=" + lon.toFixed(4) + "&radius=" + (radiusKm || 25);
    var j = await (await fetch(url)).json();
    return ((j && j.results) || []).map(function (o) {
      // Coordinates: geojson is [lon, lat]; fall back to the "lat,lon" string.
      var la = null, lo = null;
      if (o.geojson && o.geojson.coordinates) { lo = o.geojson.coordinates[0]; la = o.geojson.coordinates[1]; }
      else if (o.location) { var pr = String(o.location).split(","); la = parseFloat(pr[0]); lo = parseFloat(pr[1]); }
      return {
        src: "iNaturalist",
        cls: normClass((o.taxon && o.taxon.iconic_taxon_name) || ""),
        dt: o.time_observed_at || o.observed_on || "",
        date: o.observed_on || (o.time_observed_at || "").slice(0, 10) || "—",
        lat: isFinite(la) ? la : null,
        lon: isFinite(lo) ? lo : null,
        place: o.place_guess || "",
        who: (o.user && (o.user.login || o.user.name)) || "",
        note: o.description || "",
        url: "https://www.inaturalist.org/observations/" + o.id
      };
    });
  }

  // Configured search radius (km) for the merged recent-sightings list across
  // GBIF / eBird / iNaturalist. eBird's API caps dist at 50 km, so values
  // above that affect GBIF/iNat only.
  function recentRadiusKm() { return +window.GeoState.get("recentRadiusKm", 25) || 25; }

  // ---- All-species sightings (for per-point species-list augmentation) ------
  // Fetch GBIF + iNaturalist + (with key) eBird detections at the clicked
  // point WITHOUT a species filter, then aggregate by the model's species key
  // so each row in the Species List can show count + days-since-most-recent.
  var sciByLower = null;
  function ensureSciIndex() {
    if (sciByLower) return sciByLower;
    sciByLower = Object.create(null);
    labels.forEach(function (l) { if (l.sci) sciByLower[l.sci.toLowerCase()] = l; });
    return sciByLower;
  }
  var allSightingsCache = {};   // "lat,lon" rounded -> Promise<aggregated map>
  async function fetchGbifAll(lat, lon, range, rkm) {
    var base = "https://api.gbif.org/v1/occurrence/search?hasCoordinate=true&limit=300&geometry=" +
      encodeURIComponent(gbifGeometry(lat, lon, rkm)) + "&eventDate=" + encodeURIComponent(range);
    var all = [], offset = 0;
    for (var pages = 0; pages < 4; pages++) {
      var j = await (await fetch(base + "&offset=" + offset)).json();
      var res = j.results || []; all = all.concat(res);
      if (res.length < 300) break;
      offset += 300;
    }
    return all;
  }
  async function fetchInatAll(lat, lon, d1, d2, rkm) {
    var base = "https://api.inaturalist.org/v1/observations?verifiable=true&order_by=observed_on&order=desc&per_page=200&d1=" +
      d1 + "&d2=" + d2 + "&lat=" + lat.toFixed(4) + "&lng=" + lon.toFixed(4) + "&radius=" + rkm;
    var all = [];
    for (var page = 1; page <= 4; page++) {
      var j = await (await fetch(base + "&page=" + page)).json();
      var res = (j && j.results) || []; all = all.concat(res);
      if (res.length < 200) break;
    }
    return all;
  }
  async function fetchEbirdAll(lat, lon, tok, rkm) {
    var dist = Math.max(1, Math.min(50, rkm));
    var url = "https://api.ebird.org/v2/data/obs/geo/recent?lat=" + lat.toFixed(4) + "&lng=" + lon.toFixed(4) +
      "&dist=" + dist + "&back=30&maxResults=10000&includeProvisional=true";
    var r = await fetch(url, { headers: { "X-eBirdApiToken": tok } });
    return r.ok ? await r.json() : [];
  }
  function aggregateSightings(gbif, inat, ebird) {
    var sci = ensureSciIndex();
    var agg = Object.create(null);     // model species: key -> { count, latestTs }
    var extras = Object.create(null);  // species the model doesn't cover: sciLower -> { sci, name, count, latestTs }
    var MP_ROWS = 25;   // per-species coordinate cap (enough to plot, bounded memory)
    function pushRow(arr, row) { if (row && row.lat != null && row.lon != null && arr.length < MP_ROWS) arr.push(row); }
    function bump(key, dt, row) {
      if (!key) return;
      if (!agg[key]) agg[key] = { count: 0, latestTs: 0, rows: [] };
      agg[key].count++;
      pushRow(agg[key].rows, row);
      var t = Date.parse(dt); if (!isNaN(t) && t > agg[key].latestTs) agg[key].latestTs = t;
    }
    function bumpExtra(sciName, commonName, dt, cls, row) {
      if (!sciName) return;
      var k = sciName.toLowerCase();
      if (!extras[k]) extras[k] = { sci: sciName, name: commonName || "", cls: cls || "", count: 0, latestTs: 0, rows: [] };
      if (!extras[k].name && commonName) extras[k].name = commonName;
      if (!extras[k].cls && cls) extras[k].cls = cls;
      extras[k].count++;
      pushRow(extras[k].rows, row);
      var t = Date.parse(dt); if (!isNaN(t) && t > extras[k].latestTs) extras[k].latestTs = t;
    }
    var inatLatLon = function (o) {
      if (o.geojson && o.geojson.coordinates) return { lat: +o.geojson.coordinates[1], lon: +o.geojson.coordinates[0] };
      if (o.location) { var pr = String(o.location).split(","); return { lat: parseFloat(pr[0]), lon: parseFloat(pr[1]) }; }
      return { lat: null, lon: null };
    };
    (gbif || []).forEach(function (o) {
      // Drop higher-rank identifications (ORDER, FAMILY, GENUS, …). Without
      // this filter "Passeriformes" or "Passer" — observations the recorder
      // wouldn't commit to a species — end up as separate species-list rows.
      var rank = String(o.taxonRank || "").toUpperCase();
      if (rank && rank !== "SPECIES" && rank !== "SUBSPECIES" && rank !== "VARIETY" && rank !== "FORM") return;
      var sciName = o.species || o.scientificName; if (!sciName) return;
      // Strip the author citation GBIF often appends ("Genus species Author, year").
      sciName = sciName.replace(/\s+\([^)]*\)\s*/g, " ").replace(/,\s*\d{4}.*$/, "").trim();
      // Skip leftovers that are clearly not binomials (one word = genus or above).
      if (!/\s/.test(sciName)) return;
      var row = { lat: o.decimalLatitude != null ? +o.decimalLatitude : null, lon: o.decimalLongitude != null ? +o.decimalLongitude : null, date: (o.eventDate || "").slice(0, 10), src: "GBIF", url: o.key ? "https://www.gbif.org/occurrence/" + o.key : "" };
      var lbl = sci[sciName.toLowerCase()];
      if (lbl) bump(lbl.key, o.eventDate, row);
      else bumpExtra(sciName, "", o.eventDate, normClass(o.class), row);
    });
    (inat || []).forEach(function (o) {
      var tax = o.taxon || {};
      var rank = String(tax.rank || "").toLowerCase();
      if (rank && rank !== "species" && rank !== "subspecies" && rank !== "variety" && rank !== "form") return;
      var sciName = tax.name; if (!sciName) return;
      if (!/\s/.test(sciName)) return;   // genus-only name slipped through
      var ll = inatLatLon(o);
      var row = { lat: isFinite(ll.lat) ? ll.lat : null, lon: isFinite(ll.lon) ? ll.lon : null, date: o.observed_on || (o.time_observed_at || "").slice(0, 10), src: "iNaturalist", url: o.id ? "https://www.inaturalist.org/observations/" + o.id : "" };
      var lbl = sci[sciName.toLowerCase()];
      if (lbl) bump(lbl.key, o.observed_on || o.time_observed_at, row);
      else bumpExtra(sciName, tax.preferred_common_name || "", o.observed_on || o.time_observed_at, normClass(tax.iconic_taxon_name), row);
    });
    (ebird || []).forEach(function (o) {
      var row = { lat: o.lat != null ? +o.lat : null, lon: o.lng != null ? +o.lng : null, date: (o.obsDt || "").slice(0, 10), src: "eBird", url: o.subId ? "https://ebird.org/checklist/" + o.subId : "" };
      if (labelsByKey[o.speciesCode]) bump(o.speciesCode, o.obsDt, row);
      else bumpExtra(o.sciName || "", o.comName || "", o.obsDt, "Aves", row);
    });
    return { agg: agg, extras: extras };
  }
  // Cached fetch of every species' recent detections at a point (last 30 days).
  function fetchAllSightingsAt(lat, lon) {
    var rkm = recentRadiusKm();
    var ck = lat.toFixed(2) + "," + lon.toFixed(2) + ":" + rkm;
    if (allSightingsCache[ck]) return allSightingsCache[ck];
    var to = new Date(), from = new Date(); from.setDate(from.getDate() - 30);
    var fmtD = function (d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); };
    var d1 = fmtD(from), d2 = fmtD(to), range = d1 + "," + d2;
    var tok = ebirdKey();
    var pr = Promise.all([
      fetchGbifAll(lat, lon, range, rkm).catch(function () { return []; }),
      fetchInatAll(lat, lon, d1, d2, rkm).catch(function () { return []; }),
      tok ? fetchEbirdAll(lat, lon, tok, rkm).catch(function () { return []; }) : Promise.resolve([])
    ]).then(function (r) { return aggregateSightings(r[0], r[1], r[2]); });
    allSightingsCache[ck] = pr;
    return pr;
  }
  // Populate the per-point species-list rows with count + days-since-most-recent
  // from the cached all-species fetch. Cells stay blank for species without any
  // detection in the last 30 days; counts >0 become clickable.
  function augmentRowsWithSightings(lat, lon) {
    var token = lat.toFixed(4) + "," + lon.toFixed(4);
    var tbody = document.getElementById("sp-tbody");
    if (tbody) tbody.dataset.sightingsToken = token;   // supersede if another click arrives
    fetchAllSightingsAt(lat, lon).then(function (result) {
      if (!tbody || tbody.dataset.sightingsToken !== token) return;
      var agg = result.agg, extras = result.extras;
      tbody._sightingsAgg = agg;
      tbody.querySelectorAll(".det-nd").forEach(function (td) {
        var key = td.getAttribute("data-key"); if (!key) return;   // skip extras rows
        var entry = agg[key];
        if (!entry || !entry.count) { td.textContent = ""; return; }
        var days = entry.latestTs ? Math.max(0, Math.round((Date.now() - entry.latestTs) / 86400000)) : null;
        td.innerHTML = '<button type="button" class="det-count-btn" data-key="' + escapeHtml(key) + '">' + entry.count + "</button>" +
          (days != null ? '<span class="det-d">(' + days + ")</span>" : "");
      });
      prependExtraSightings(tbody, extras);
      // Re-apply the active age filter and sort once data has arrived.
      applyAgeFilter();
      if (speciesListSort.col) sortSpeciesList();
    }).catch(function () { /* keep "…" placeholders silently */ });
  }
  // Append species the model doesn't cover (matched only via GBIF/iNat/eBird
  // sci-name) BELOW the model rows so the prediction-ranked species stay at the
  // top and the "observed but not predicted" tail sits at the bottom. Capped at
  // 30 to keep lists readable.
  function prependExtraSightings(tbody, extras) {
    Array.prototype.slice.call(tbody.querySelectorAll("tr.sp-extra")).forEach(function (tr) { tr.remove(); });
    var keys = Object.keys(extras || {});
    if (!keys.length) return;
    // Respect the active species-group filter: when the user is in "Birds"
    // (or any specific class) mode, hide extras from other classes — those
    // are what produced the "plants and trees in the bird list" surprise.
    // normClass returns capitalised class names ("Aves"), speciesGroup is
    // lowercase ("aves"); compare case-insensitively. Drop unknown-class
    // extras too, so a junk row without provenance can't slip through.
    if (speciesGroup !== "all") {
      var want = String(speciesGroup).toLowerCase();
      keys = keys.filter(function (k) {
        var c = extras[k] && extras[k].cls;
        return c && String(c).toLowerCase() === want;
      });
      if (!keys.length) return;
    }
    keys.sort(function (a, b) { return (extras[b].count - extras[a].count) || (extras[b].latestTs - extras[a].latestTs); });
    keys = keys.slice(0, 30);
    var frag = document.createDocumentFragment();
    keys.forEach(function (k) {
      var e = extras[k], name = e.name || e.sci;
      var days = e.latestTs ? Math.max(0, Math.round((Date.now() - e.latestTs) / 86400000)) : null;
      var tr = document.createElement("tr");
      tr.className = "sp-extra";
      tr.setAttribute("data-age-days", days != null ? days : "");
      var clsBadge = e.cls ? '<span class="sp-extra-cls" title="' + escapeHtml(e.cls) + '">' + classGlyph(e.cls) + "</span> " : "";
      tr.innerHTML = '<td>' + clsBadge + '<span class="sp-extra-name" title="' + escapeHtml(t("sp.extraHint")) + '">' + escapeHtml(name) + '</span></td>' +
        '<td class="name2"></td>' +
        '<td class="sci">' + escapeHtml(e.sci) + '</td>' +
        '<td class="prob-cell prob-na">—</td>' +
        '<td class="num det-nd"><button type="button" class="det-count-btn det-count-extra" data-sci="' + escapeHtml(e.sci) + '" data-name="' + escapeHtml(name) + '">' + e.count + '</button>' +
          (days != null ? '<span class="det-d">(' + days + ")</span>" : "") + '</td>' +
        '<td></td>';
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  // User's personal eBird API token (kept in localStorage; never shared).
  // The eBird token lives in its own localStorage entry (not the shared app
  // state) so it always persists across reloads. Older builds stored it inside
  // GeoState — migrate that on first read.
  var EBIRD_KEY_LS = "geomodel-ebird-key";
  function ebirdKey() {
    try {
      var k = localStorage.getItem(EBIRD_KEY_LS);
      if (k == null) {
        var old = window.GeoState.get("ebirdKey", "");
        if (old) { localStorage.setItem(EBIRD_KEY_LS, String(old).trim()); return String(old).trim(); }
        return "";
      }
      return String(k).trim();
    } catch (e) { return ""; }
  }
  function setEbirdKey(v) { try { localStorage.setItem(EBIRD_KEY_LS, (v || "").trim()); } catch (e) { /* storage blocked */ } }

  // ---- Cross-device share: Export / Import the user's data ------------------
  // Settings, checklists, eBird key, interesting/hidden lists, plotted points —
  // anything held in our two localStorage entries. The H3 range cache is left
  // out (large, fully reconstructible). Imports MERGE checklists by id and
  // append log entries (deduped by entry id), so observations made on either
  // device survive a round-trip.
  // The full transportable snapshot of the user's data — shared by the file
  // Export and the Google Drive sync. `state.updatedAt` (stamped by GeoState on
  // every write) rides along as the local "version" used to order sync writes.
  function buildPayload() {
    var state = {};
    try { state = JSON.parse(localStorage.getItem("geomodel-explorer-v1") || "{}"); } catch (e) {}
    return {
      app: "migration_calendar",
      version: 1,
      exportedAt: new Date().toISOString(),
      state: state,
      ebirdKey: localStorage.getItem(EBIRD_KEY_LS) || ""
    };
  }
  function exportAppData() {
    downloadCsv("migration_calendar_" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(buildPayload(), null, 2));
  }
  function mergeChecklists(local, incoming) {
    var out = {}; Object.keys(local || {}).forEach(function (k) { out[k] = local[k]; });
    Object.keys(incoming || {}).forEach(function (id) {
      var inc = incoming[id]; if (!inc) return;
      if (!out[id]) { out[id] = inc; return; }
      var loc = out[id];
      // Merge log: append entries from incoming that we don't already have (by id).
      var ids = Object.create(null); (loc.log || []).forEach(function (e) { if (e && e.id) ids[e.id] = 1; });
      (inc.log || []).forEach(function (e) { if (e && e.id && !ids[e.id]) { (loc.log = loc.log || []).push(e); ids[e.id] = 1; } });
      if (loc.log) loc.log.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      // Union the seen-flags map.
      loc.seen = loc.seen || {}; Object.keys(inc.seen || {}).forEach(function (k) { if (inc.seen[k]) loc.seen[k] = true; });
      // Prefer the more recently accessed side's title + accessedAt.
      if ((inc.accessedAt || 0) > (loc.accessedAt || 0)) {
        if (inc.title) loc.title = inc.title;
        loc.accessedAt = inc.accessedAt;
      } else if (!loc.title && inc.title) { loc.title = inc.title; }
      // Carry country-list rows through if local doesn't have them.
      if (inc.rows && !loc.rows) loc.rows = inc.rows;
      if (inc.kind === "country" && !loc.kind) loc.kind = inc.kind;
      out[id] = loc;
    });
    return out;
  }
  // Loose (unsaved) pins for a stored state = the working set, but only when no
  // named list is active (an active working set IS that list, already in sets).
  function loosePointsOf(state) {
    if (!state || state.mapPointSetActive) return [];
    return Array.isArray(state.mapPoints) ? state.mapPoints : [];
  }
  // Union two pin arrays, de-duping by id (idempotent re-imports don't pile up).
  function mergePins(a, b) {
    var seen = Object.create(null), out = [];
    (a || []).concat(b || []).forEach(function (p) {
      if (!p || !isFinite(p.lat) || !isFinite(p.lon)) return;
      var id = p.id || (p.lat + "," + p.lon + "|" + (p.name || ""));
      if (seen[id]) return; seen[id] = 1; out.push(p);
    });
    return out;
  }
  // Merge incoming named lists into local: same-named lists ask the user to
  // merge (union the pins) or overwrite (replace with the imported list).
  // `interactive` false (background Drive sync) skips the prompt and always
  // unions — a sync must never silently drop a device's pins.
  function mergePointSets(localSets, incSets, interactive) {
    var out = (Array.isArray(localSets) ? localSets : []).map(function (c) { return { name: c.name, points: (c.points || []).slice() }; });
    var byName = Object.create(null); out.forEach(function (c) { byName[c.name] = c; });
    (Array.isArray(incSets) ? incSets : []).forEach(function (inc) {
      if (!inc || !inc.name) return;
      var cur = byName[inc.name];
      if (!cur) { var added = { name: inc.name, points: (inc.points || []).slice() }; out.push(added); byName[inc.name] = added; return; }
      if (!interactive || confirm(t("sync.listMergePrompt", { name: inc.name }))) cur.points = mergePins(cur.points, inc.points);
      else cur.points = (inc.points || []).slice();
    });
    return out;
  }
  // Merge a parsed payload into local storage and return a summary of the merge.
  // Collections (checklists, loose pins, named lists) are ALWAYS unioned so no
  // observation is ever lost, regardless of direction. Scalar settings follow
  // `opts.incomingWins`: true → incoming overrides local (file import, and Drive
  // pulls where the remote copy is newer); false → local is kept (Drive pushes
  // where the local copy is newer). `opts.interactive` gates the same-named
  // list merge/replace prompt (off for background sync). Writes straight to
  // localStorage (bypassing GeoState) so it does not re-trigger a sync push.
  function applyRemote(data, opts) {
    opts = opts || {};
    if (!data || data.app !== "migration_calendar") throw new Error(t("sync.notBackup"));
    var local = {}; try { local = JSON.parse(localStorage.getItem("geomodel-explorer-v1") || "{}"); } catch (e) {}
    var incoming = data.state || {};
    var mergedCl = mergeChecklists(local.fieldChecklists, incoming.fieldChecklists);
    // Map points: merge rather than overwrite. Loose pins from both sides are
    // unioned into the working set; named lists are merged/overwritten by name.
    var mergedLoose = mergePins(loosePointsOf(local), loosePointsOf(incoming));
    var mergedSets = mergePointSets(local.mapPointSets, incoming.mapPointSets, opts.interactive);
    // Scalar settings: the winning side overrides, the other fills any gaps.
    var primary = opts.incomingWins ? incoming : local;
    var secondary = opts.incomingWins ? local : incoming;
    var newState = {}; Object.keys(secondary).forEach(function (k) { newState[k] = secondary[k]; });
    Object.keys(primary).forEach(function (k) { newState[k] = primary[k]; });
    // The merged collections override either side's copy.
    newState.fieldChecklists = mergedCl;
    newState.mapPoints = mergedLoose;
    newState.mapPointSets = mergedSets;
    newState.mapPointSetActive = "";   // show the merged unsaved set after import
    try { localStorage.setItem("geomodel-explorer-v1", JSON.stringify(newState)); } catch (e) { throw new Error("storage write failed: " + e.message); }
    // eBird key: adopt incoming only when it should win, or when we have none.
    if (data.ebirdKey && (opts.incomingWins || !ebirdKey())) setEbirdKey(data.ebirdKey);
    return {
      checklistsIncoming: Object.keys(incoming.fieldChecklists || {}).length,
      checklistsTotal: Object.keys(mergedCl).length,
      pointsTotal: mergedLoose.length,
      listsTotal: mergedSets.length,
      hadKey: !!data.ebirdKey
    };
  }
  function importAppData(jsonText) {
    var data; try { data = JSON.parse(jsonText); } catch (e) { throw new Error("Invalid JSON"); }
    return applyRemote(data, { incomingWins: true, interactive: true });
  }

  // Surface the data layer for the Google Drive sync module (gdrive-sync.js),
  // which lives outside this IIFE. It builds the payload and merges remote
  // copies through the exact same code path as the file Export/Import.
  window.AppData = {
    buildPayload: buildPayload,
    applyRemote: applyRemote,
    ebirdKey: ebirdKey,
    setEbirdKey: setEbirdKey
  };

  // Recent eBird observations of one species near a point. The app's species
  // keys ARE eBird species codes, so this is a single call. eBird caps the
  // lookback at 30 days and the radius at 50 km. Needs the user's API token.
  async function ebirdRecent(key, lat, lon, radiusKm) {
    var tok = ebirdKey();
    if (!tok || !key) return [];
    var dist = Math.max(1, Math.min(50, radiusKm || 25));   // eBird caps dist at 50 km
    var url = "https://api.ebird.org/v2/data/obs/geo/recent/" + encodeURIComponent(key) +
      "?lat=" + lat.toFixed(4) + "&lng=" + lon.toFixed(4) + "&dist=" + dist + "&back=30&maxResults=100&includeProvisional=true";
    var r = await fetch(url, { headers: { "X-eBirdApiToken": tok } });
    if (!r.ok) return [];
    var j = await r.json();
    return ((j && j.length) ? j : []).map(function (o) {
      return {
        src: "eBird",
        cls: "Aves",   // eBird's API is bird-only
        dt: o.obsDt || "",
        date: (o.obsDt || "").slice(0, 10) || "—",
        lat: o.lat != null ? o.lat : null,
        lon: o.lng != null ? o.lng : null,
        place: o.locName || "",
        who: (o.howMany != null ? "×" + o.howMany : ""),
        note: "",   // the basic geo/recent endpoint carries no observer comments
        url: o.subId ? "https://ebird.org/checklist/" + o.subId : ""
      };
    });
  }

  var lastRecentRows = [], lastRecentMeta = null;
  // Short label for a GBIF origin dataset name (e.g. "Observation.org, Nature
  // data…" -> "Observation.org"); the full name stays in the badge tooltip/CSV.
  function shortOrigin(s) {
    var t = String(s || "").split(/,| – | - |\(/)[0].trim();
    return t || String(s || "");
  }
  // CSV of the merged sightings list (one row per observation, all sources).
  // The "origin" column is GBIF's underlying dataset (else the source itself).
  function recentCsv() {
    var m = lastRecentMeta || {};
    var lines = ["# " + (m.name || "") + " (" + (m.sci || "") + ") | " + (m.lat != null ? m.lat.toFixed(4) + "°, " + m.lon.toFixed(4) + "°" : "")];
    lines.push("date,source,class,origin,lat,lon,place,observer_or_count,notes,url");
    lastRecentRows.forEach(function (r) {
      lines.push([csvEsc(r.date), r.src, csvEsc(r.cls || ""), csvEsc(r.origin || r.src), r.lat != null ? r.lat : "", r.lon != null ? r.lon : "",
        csvEsc(r.place), csvEsc(r.who), csvEsc(r.note || ""), csvEsc(r.url)].join(","));
    });
    return lines.join("\n");
  }

  // Show recent observations of a species near the clicked location: GBIF,
  // iNaturalist and (with the user's eBird key, for birds) eBird, fetched in
  // parallel and merged into one list sorted by time, most recent first.
  // Downloadable as CSV. eBird's window is 30 days; GBIF/iNaturalist use ~2 months.
  async function showRecent(name, sci, lat, lon, key) {
    var body = document.getElementById("recent-body");
    document.getElementById("recent-title").textContent = name;
    body.innerHTML = '<div class="spinner" style="margin:24px auto"></div>';
    document.getElementById("recent-modal").style.display = "flex";
    navOpen("recent", hideRecent);
    var token = ++recentToken;

    var to = new Date(), from = new Date(); from.setMonth(from.getMonth() - 2);
    var fmtD = function (d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); };
    var d1 = fmtD(from), d2 = fmtD(to), range = d1 + "," + d2;

    var inatWeb = "https://www.inaturalist.org/observations?taxon_name=" + encodeURIComponent(sci) +
      "&lat=" + lat.toFixed(4) + "&lng=" + lon.toFixed(4) + "&radius=25&d1=" + d1 + "&d2=" + d2 + "&order_by=observed_on&order=desc";
    var gbifBase = "https://www.gbif.org/occurrence/search?q=" + encodeURIComponent(sci) +
      "&geometry=" + encodeURIComponent(gbifGeometry(lat, lon, 12.5));
    var countryParam = "";
    var ebLink = (key && isBirdKey(key)) ? '<a href="' + escapeHtml(ebirdUrl(key, sci)) + '" target="_blank" rel="noopener">eBird</a> · ' : "";
    var links = function () {
      return '<div class="recent-links">' + ebLink + '<a class="recent-gbif" href="' + escapeHtml(gbifBase + countryParam) + '" target="_blank" rel="noopener">GBIF</a>' +
        ' · <a href="' + escapeHtml(inatWeb) + '" target="_blank" rel="noopener">' + escapeHtml(t("recent.viewall")) + '</a></div>';
    };
    countryCode(lat, lon).then(function (cc) {
      if (!cc) return;
      countryParam = "&country=" + cc;
      if (token !== recentToken) return;
      var a = document.querySelector("#recent-body .recent-gbif");
      if (a) a.setAttribute("href", gbifBase + countryParam);
    });

    var srcSlug = function (s) { return s === "iNaturalist" ? "inat" : (s || "").toLowerCase(); };
    function render(rows) {
      if (token !== recentToken) return;
      if (!rows.length) { body.innerHTML = '<p class="recent-none">' + escapeHtml(t("recent.none")) + "</p>" + links(); return; }
      var counts = {};
      rows.forEach(function (r) { counts[r.src] = (counts[r.src] || 0) + 1; });
      var cap = Object.keys(counts).map(function (s) { return s + " " + counts[s]; }).join(" · ");
      var html = rows.map(function (r) {
        var place = r.place || "(map)";
        var cell = r.url ? '<a href="' + escapeHtml(r.url) + '" target="_blank" rel="noopener">' + escapeHtml(place) + "</a>" : escapeHtml(place);
        // GBIF aggregates many datasets — badge such rows by their origin dataset.
        var label = (r.src === "GBIF" && r.origin) ? shortOrigin(r.origin) : r.src;
        var badge = '<span class="rc-src rc-src-' + srcSlug(r.src) + '" title="' + escapeHtml(r.origin || r.src) + '">' + escapeHtml(label || "") + "</span>";
        var clsBadge = r.cls ? '<span class="rc-cls" title="' + escapeHtml(r.cls) + '">' + classGlyph(r.cls) + "</span> " : "";
        return '<tr><td class="rc-date">' + escapeHtml(r.date) + '</td><td class="rc-srccell">' + badge + '</td><td class="rc-place">' + clsBadge + cell + '</td><td class="rc-who">' + escapeHtml(r.who) + "</td></tr>";
      }).join("");
      body.innerHTML = '<div class="recent-head"><span class="recent-src">' + escapeHtml(cap + " · " + d1 + " – " + d2 + " · " + recentRadiusKm() + " km") + "</span>" +
        '<span class="recent-head-btns"><button type="button" id="recent-map">' + escapeHtml(t("btn.showInMap")) + "</button>" +
        '<button type="button" id="recent-dl">' + escapeHtml(t("recent.download")) + "</button></span></div>" +
        '<table class="recent-table"><tbody>' + html + "</tbody></table>" + links();
    }

    try {
      var rkm = recentRadiusKm();
      var wantEbird = key && isBirdKey(key) && ebirdKey();
      var results = await Promise.all([
        gbifRecent(sci, lat, lon, range, rkm).catch(function () { return []; }),
        inatRecent(sci, lat, lon, d1, d2, rkm).catch(function () { return []; }),
        wantEbird ? ebirdRecent(key, lat, lon, rkm).catch(function () { return []; }) : Promise.resolve([])
      ]);
      if (token !== recentToken) return;
      var rows = results[0].concat(results[1], results[2]);
      rows.sort(function (a, b) { return String(b.dt || b.date || "").localeCompare(String(a.dt || a.date || "")); });
      lastRecentRows = rows;
      lastRecentMeta = { key: key, name: name, sci: sci, lat: lat, lon: lon };
      render(rows);
    } catch (e) {
      if (token !== recentToken) return;
      body.innerHTML = '<p class="recent-none">' + escapeHtml(t("recent.none")) + "</p>" + links();
    }
  }

  // ---- Distribution-map pop-up --------------------------------------------
  // Look up a range/distribution map image for a species on Wikipedia
  // (English has the broadest coverage). We fetch the rendered article and
  // scan its <img> tags: range maps are usually named with "distribution",
  // "range", "map", "ebird" or "IUCN", but some are just an SVG named after
  // the species — so we also fuzzy-match the Latin and English names and
  // treat a species-named SVG as a likely range map. Returns {thumb, full}.
  function distMapName(s) {
    if (!s) return [];
    var l = s.toLowerCase();
    return [l.replace(/[^a-z0-9]+/g, "_"), l.replace(/[^a-z0-9]+/g, "")].filter(function (x) { return x.length > 3; });
  }
  function distMapFile(src) {
    try { return decodeURIComponent(src.split("?")[0].split("/").pop()).toLowerCase(); }
    catch (e) { return src.toLowerCase(); }
  }
  async function wikiRangeImage(sci, en) {
    var r = await fetch("https://en.wikipedia.org/w/api.php?origin=*&format=json&redirects=1&action=parse&prop=text&page=" + encodeURIComponent(sci));
    var j = await r.json();
    var html = j.parse && j.parse.text && j.parse.text["*"];
    if (!html) return null;
    var nameTok = distMapName(sci).concat(distMapName(en));
    var re = /<img\b[^>]*>/gi, m, best = null, bestScore = 0;
    while ((m = re.exec(html))) {
      var src = (m[0].match(/\bsrc="([^"]+)"/) || [])[1];
      if (!src || !/\.(png|svg|jpe?g)/i.test(src)) continue;
      var alt = (m[0].match(/\balt="([^"]*)"/) || [])[1] || "";
      var fn = distMapFile(src);            // filename only (URL path always has /wikipedia/commons/)
      var l = fn + " " + alt.toLowerCase();
      // Site chrome / status & locator icons — never a range map.
      if (/commons-logo|ambox|oojs|edit-ltr|status[_ ]?iucn|loudspeaker|symbol|poster|sound|question|padlock|pencil|magnify|increase|decrease|steady|gnome|crystal|wiki(media|pedia)/.test(l)) continue;
      var s = 0;
      if (l.indexOf("distribution") >= 0) s += 10;
      if (l.indexOf("range") >= 0) s += 6;
      if (l.indexOf("ebird") >= 0) s += 6;
      if (l.indexOf("occurrence") >= 0 || l.indexOf("occurence") >= 0) s += 6;
      if (l.indexOf("iucn") >= 0) s += 6;
      if (/[_ \-]map[_.\-]|map\.(png|svg|jpe?g)/.test(l)) s += 4;
      if (/locator|globe|blank/.test(l)) s -= 5;
      var nameHit = nameTok.some(function (tk) { return fn.indexOf(tk) >= 0; });
      if (nameHit) s += 3;
      var mapish = /distribution|range|ebird|occurrence|occurence|iucn/.test(l) || /[_ \-]map[_.\-]|map\.(png|svg|jpe?g)/.test(l);
      var svgName = /\.svg/.test(fn) && nameHit;   // species-named SVG → likely the range map
      if ((mapish || svgName) && s > bestScore) { bestScore = s; best = src; }
    }
    if (!best) return null;
    if (best.indexOf("//") === 0) best = "https:" + best;
    // `best` is the page's own thumbnail (already generated, so it loads
    // reliably). The full image is the un-thumbnailed original. We avoid
    // requesting an arbitrary thumbnail width — Wikimedia won't always
    // generate one on demand, which left the inline image broken.
    var full = best.replace(/\/thumb\/(.+)\/[^\/]+$/, "/$1");
    return { thumb: best, full: full };
  }

  function hideDistMap() { document.getElementById("distmap-modal").style.display = "none"; }
  function hideAbout() { document.getElementById("about-modal").style.display = "none"; }

  function showDistMap(name, sci, key) {
    var modal = document.getElementById("distmap-modal");
    var body = document.getElementById("distmap-body");
    document.getElementById("distmap-title").textContent = name;
    body.innerHTML = '<div class="spinner" style="margin:24px auto"></div>';
    modal.style.display = "flex";
    navOpen("distmap", hideDistMap);
    var lbl = key && labelsByKey[key];
    var en = (lbl && lbl.common) || name;   // English common name helps match filenames
    var bird = key && isBirdKey(key);
    // Reference links shown in the pop-up: Wikipedia, plus BirdLife (birds only).
    function refLinks(fullUrl) {
      var h = "";
      if (fullUrl) h += '<a href="' + escapeHtml(fullUrl) + '" target="_blank" rel="noopener">' + escapeHtml(t("distmap.download")) + '</a> · ';
      h += '<a class="dm-wiki" data-sci="' + escapeHtml(sci) + '" href="' + escapeHtml(wikipediaUrl(sci)) + '" target="_blank" rel="noopener">Wikipedia</a>';
      if (bird) h += ' · <a class="dm-birdlife" data-en="' + escapeHtml(en) + '" data-sci="' + escapeHtml(sci) + '" href="' + escapeHtml(birdlifeUrl(en, sci)) + '" target="_blank" rel="noopener">BirdLife</a>';
      return h;
    }
    function showNone() {
      body.innerHTML = '<p class="distmap-none">' + escapeHtml(t("distmap.none")) + '</p>' +
        '<div class="distmap-links">' + refLinks(null) + '</div>';
    }
    var token = ++distMapToken;
    wikiRangeImage(sci, en).then(function (res) {
      if (token !== distMapToken) return;   // a newer request superseded this
      if (res) {
        body.innerHTML = '<div class="distmap-links">' + refLinks(res.full) + '</div>';
        // Display the full original (loads reliably; CSS scales it to fit),
        // falling back to the page's own thumbnail if the original fails.
        var img = document.createElement("img");
        img.className = "distmap-img";
        img.alt = name;
        img.onerror = function () {
          if (img.src !== res.thumb) { img.src = res.thumb; }    // fall back to page thumbnail
          else { img.style.display = "none"; }                   // both failed: keep links only
        };
        img.src = res.full;
        body.insertBefore(img, body.firstChild);
      } else {
        showNone();
      }
    }).catch(function () {
      if (token !== distMapToken) return;
      showNone();
    });
  }

  // "Filter" action: drop the name into the analysis filter box and apply it.
  function applyNameFilter(name) {
    var f = document.getElementById("an-filter");
    if (f) f.value = name;
    if (currentMode === "barchart" && analysisData) renderActiveTab();
  }

  // Base map tile layers
  var baseLayer = null;
  var CARTO_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>';
  var BASEMAPS = {
    dark:  { url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",  attribution: CARTO_ATTR, subdomains: "abcd", maxNativeZoom: 20 },
    light: { url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", attribution: CARTO_ATTR, subdomains: "abcd", maxNativeZoom: 20 },
    // Street/political (standard OpenStreetMap)
    streets: { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
               attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', subdomains: "abc", maxNativeZoom: 19 },
    // Topographic / terrain (contours + relief)
    topo:  { url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
             attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)', subdomains: "abc", maxNativeZoom: 17 },
    // Satellite imagery
    satellite: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
                 attribution: 'Imagery &copy; <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics', maxNativeZoom: 19 } };

  // Capture script location at parse time (before DOMContentLoaded fires)
  var SCRIPT_BASE = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src : window.location.href;

  // ---- Bootstrap -----------------------------------------------------------
  document.addEventListener("DOMContentLoaded", init);

  // Shortcut URL: ?here=1 opens the per-point species list at the device's
  // current GPS position on load. Skips the point-chooser popup that a normal
  // map click would show — the user explicitly asked for the species list.
  function maybeUrlAutoLocate() {
    var qs;
    try { qs = new URLSearchParams(window.location.search); } catch (e) { return; }
    if (qs.get("here") !== "1") return;
    if (!navigator.geolocation || !map) { setStatus(t("status.locateError")); return; }
    var modeSel = document.getElementById("mode-select");
    if (modeSel && modeSel.value !== "list") {
      modeSel.value = "list";
      modeSel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      if (marker) map.removeLayer(marker);
      marker = L.marker([lat, lon]).addTo(map);
      map.setView([lat, lon], Math.max(map.getZoom() || 0, 11));
      renderSpeciesList(lat, lon);
    }, function () { setStatus(t("status.locateError")); },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }

  async function init() {
    var root = document.getElementById("demo-root");
    if (!root) return;

    root.innerHTML =
      '<div id="demo-loading"><div class="spinner"></div><span data-i18n="app.loading">Loading\u2026</span></div>' +
      '<div id="demo-app" style="display:none">' +
        '<div id="demo-controls">' +
          '<div class="ctrl-group" id="mode-wrap">' +
            '<label for="mode-select" data-i18n="ctrl.mode">Mode</label>' +
            '<select id="mode-select">' +
              '<option value="list" data-i18n="mode.list">📍 Species List</option>' +
              '<option value="barchart" data-i18n="mode.barchart">📍 Migration</option>' +
              '<option value="range" data-i18n="mode.range">Species Range</option>' +
              '<option value="richness" data-i18n="mode.richness">Species Richness</option>' +
            '</select>' +
          '</div>' +
          '<div class="ctrl-group" id="species-search-wrap">' +
            '<label for="species-search" data-i18n="ctrl.species">Species</label>' +
            '<input id="species-search" type="text" autocomplete="off" data-i18n-ph="ph.species" placeholder="Search species\u2026" />' +
            '<div id="species-results"></div>' +
          '</div>' +
          '<div class="ctrl-group ctrl-group-btn" id="play-btn-wrap">' +
            '<button id="play-btn" class="demo-btn" data-i18n="btn.play">\u25b6 Play migration</button>' +
          '</div>' +
          '<div class="ctrl-group" id="hidden-wrap" style="display:none">' +
            '<label data-i18n="ctrl.hidden">Hidden species</label>' +
            '<button type="button" id="hidden-btn" class="dd-toggle"><span id="hidden-btn-text"></span><span class="dd-caret" aria-hidden="true">▾</span></button>' +
            '<div id="hidden-panel" class="dd-panel" style="display:none"></div>' +
          '</div>' +
          '<div class="ctrl-group" id="checklists-wrap" style="display:none">' +
            '<button type="button" id="checklists-toggle" class="hdr-icon-btn" aria-haspopup="true" title="Checklists" aria-label="Checklists">' +
              '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                '<path d="M9 5h11M9 12h11M9 19h11"/><path d="M4 5l1 1 2-2M4 12l1 1 2-2M4 19l1 1 2-2"/></svg>' +
              '<span id="checklists-btn-text" class="hdr-count"></span>' +
            '</button>' +
            '<div id="checklists-panel" class="dd-panel" style="display:none"></div>' +
          '</div>' +
          '<div class="ctrl-group" id="mp-wrap">' +
            '<button type="button" id="mp-toggle" class="hdr-icon-btn" aria-haspopup="true" data-i18n-title="points.title" title="Points" aria-label="Points">' +
              '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                '<path d="M12 22s-7-7.58-7-13a7 7 0 1 1 14 0c0 5.42-7 13-7 13z"/><circle cx="12" cy="9" r="2.5"/></svg>' +
              '<span id="mp-btn-text" class="hdr-count"></span>' +
            '</button>' +
            '<div id="mp-panel" class="dd-panel" style="display:none"></div>' +
          '</div>' +
          '<div class="ctrl-group" id="settings-wrap">' +
            '<button type="button" id="settings-toggle" class="settings-icon-btn" aria-haspopup="true" aria-label="Settings" title="Settings"></button>' +
            '<div id="settings-panel" class="dd-panel settings-panel" style="display:none">' +
              '<div class="ctrl-group">' +
                '<label for="lang-select" data-i18n="ctrl.language">Language</label>' +
                '<select id="lang-select"></select>' +
              '</div>' +
              '<div class="ctrl-group" id="secondlang-wrap" style="display:none">' +
                '<label for="secondlang-select" data-i18n="ctrl.secondlang">2nd name</label>' +
                '<select id="secondlang-select"></select>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label class="ctrl-check"><input type="checkbox" id="show-sci-toggle" checked> <span data-i18n="ctrl.showsci">Scientific names</span></label>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="group-select" data-i18n="ctrl.group">Species group</label>' +
                '<select id="group-select">' +
                  '<option value="all" data-i18n="group.all">All groups</option>' +
                  '<option value="aves" data-i18n="group.aves">Birds</option>' +
                  '<option value="mammalia" data-i18n="group.mammalia">Mammals</option>' +
                  '<option value="amphibia" data-i18n="group.amphibia">Amphibians</option>' +
                  '<option value="insecta" data-i18n="group.insecta">Insects</option>' +
                '</select>' +
              '</div>' +
              '<div class="ctrl-group" id="week-select-wrap">' +
                '<label for="week-select" data-i18n="ctrl.week">Week</label>' +
                '<select id="week-select"></select>' +
              '</div>' +
              '<div class="ctrl-group" id="compare-wrap" style="display:none">' +
                '<label for="compare-select" data-i18n="ctrl.compare">Compare to</label>' +
                '<select id="compare-select">' +
                  '<option value="" data-i18n="compare.none">\u2014 none \u2014</option>' +
                  '<option value="prev" data-i18n="compare.prev">Previous week</option>' +
                  '<option value="next" data-i18n="compare.next">Next week</option>' +
                  '<option value="mean" data-i18n="compare.mean">Annual mean</option>' +
                  '<option value="annualmax" data-i18n="compare.max">Annual max</option>' +
                  '<option value="annualtop" selected data-i18n="compare.annualtop">Annual Top</option>' +
                '</select>' +
              '</div>' +
              '<div class="ctrl-group" id="maptype-wrap">' +
                '<label for="maptype-select" data-i18n="ctrl.basemap">Map type</label>' +
                '<select id="maptype-select">' +
                  '<option value="dark" data-i18n="basemap.dark">Dark</option>' +
                  '<option value="light" data-i18n="basemap.light">Light</option>' +
                  '<option value="streets" data-i18n="basemap.streets">Streets</option>' +
                  '<option value="topo" data-i18n="basemap.topo">Topographic</option>' +
                  '<option value="satellite" data-i18n="basemap.satellite">Satellite</option>' +
                '</select>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="h3cache-mb" data-i18n="ctrl.cachemb">Map data cache</label>' +
                '<select id="h3cache-mb">' +
                  '<option value="0" data-i18n="opt.off">Off</option><option value="1">1 MB</option><option value="2">2 MB</option><option value="5">5 MB</option>' +
                '</select>' +
              '</div>' +
              '<div class="ctrl-group" id="ebird-key-wrap">' +
                '<label for="ebird-key" data-i18n="ctrl.ebirdkey">eBird API key</label>' +
                '<input id="ebird-key" type="text" autocomplete="off" spellcheck="false" />' +
                '<a id="ebird-key-link" href="https://ebird.org/api/keygen" target="_blank" rel="noopener" data-i18n="ctrl.ebirdkeyget">Get a free key</a>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="hotspot-min" data-i18n="ctrl.hotspotmin">Hotspot min. species</label>' +
                '<select id="hotspot-min">' +
                  '<option value="0" data-i18n="opt.off">Off</option><option value="25">25+</option><option value="50">50+</option><option value="100">100+</option><option value="200">200+</option>' +
                '</select>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="country-res" data-i18n="ctrl.countryres">Country sampling resolution</label>' +
                '<select id="country-res">' +
                  '<option value="3">3 · ~60 km</option><option value="4">4 · ~22 km</option><option value="5">5 · ~8 km</option><option value="6">6 · ~3 km</option>' +
                '</select>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="recent-radius" data-i18n="ctrl.recentradius">Sightings radius</label>' +
                '<select id="recent-radius">' +
                  '<option value="5">5 km</option><option value="10">10 km</option><option value="25">25 km</option><option value="50">50 km</option><option value="100">100 km</option>' +
                '</select>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<details id="custom-urls-wrap">' +
                  '<summary data-i18n="ctrl.customurls">National databases</summary>' +
                  '<p class="cu-hint" data-i18n="ctrl.customurlsHint">Open extra sites for a country in the map popups. Country code = ISO-3166 (e.g. NO, GB).</p>' +
                  '<div id="custom-urls-list"></div>' +
                  '<div class="cu-actions">' +
                    '<button type="button" id="custom-urls-add" class="demo-btn" data-i18n="ctrl.customurlsAdd">+ Add</button>' +
                    '<button type="button" id="custom-urls-reset" class="demo-btn demo-btn-light" data-i18n="ctrl.customurlsReset">Reset</button>' +
                  '</div>' +
                '</details>' +
              '</div>' +
              '<div class="ctrl-group" id="barchart-threshold-wrap" style="display:none">' +
                '<label data-i18n="ctrl.bcthreshold">Probability range</label>' +
                '<div id="prob-range">' +
                  '<div class="pr-track"></div>' +
                  '<input type="range" id="prob-min" min="0" max="100" step="1" value="5" />' +
                  '<input type="range" id="prob-max" min="0" max="100" step="1" value="100" />' +
                '</div>' +
                '<div id="prob-range-vals"><span id="prob-min-val">5%</span> – <span id="prob-max-val">100%</span></div>' +
              '</div>' +
              '<div class="settings-divider"></div>' +
              '<div class="ctrl-group" id="sync-wrap">' +
                '<label data-i18n="ctrl.syncData">Share between devices</label>' +
                '<div class="sync-row">' +
                  '<button type="button" id="sync-export" class="demo-btn" data-i18n="sync.export">⬇ Export</button>' +
                  '<button type="button" id="sync-import" class="demo-btn" data-i18n="sync.import">⬆ Import</button>' +
                  '<input type="file" id="sync-file" accept=".json,application/json" style="display:none" />' +
                '</div>' +
                '<div class="sync-row" id="gdrive-row">' +
                  '<button type="button" id="gd-connect" class="demo-btn" data-i18n="gdrive.connect">☁ Connect Google Drive</button>' +
                  '<button type="button" id="gd-sync" class="demo-btn" data-i18n="gdrive.syncNow" style="display:none">⟳ Sync now</button>' +
                  '<button type="button" id="gd-disconnect" class="demo-btn" data-i18n="gdrive.disconnect" style="display:none">Disconnect</button>' +
                '</div>' +
                '<input type="text" id="gd-clientid" autocomplete="off" spellcheck="false" data-i18n-ph="gdrive.clientIdPh" placeholder="Google OAuth client ID" style="display:none" />' +
                '<div id="gd-status" class="cu-hint"></div>' +
                '<p class="cu-hint" data-i18n="gdrive.hint">Syncs settings, checklists and points to your private Google Drive app folder. Deletions don’t sync between devices.</p>' +
              '</div>' +
              '<div class="ctrl-group" id="points-kml-wrap">' +
                '<label data-i18n="ctrl.exportPoints">Map points</label>' +
                '<button type="button" id="points-kml-export" class="demo-btn" data-i18n="btn.exportPointsKml">⬇ Export KML</button>' +
              '</div>' +
              '<div class="ctrl-group" id="offline-wrap">' +
                '<label for="offline-zoom" data-i18n="ctrl.offlineZoom">Download max zoom</label>' +
                '<select id="offline-zoom">' +
                  '<option value="11">11 · regional</option><option value="13">13 · town</option>' +
                  '<option value="15">15 · street</option><option value="17" selected>17 · detailed (full)</option>' +
                '</select>' +
                '<p class="cu-hint" data-i18n="offline.hint">Use the ⬇ button on the map to download the current view.</p>' +
                '<div id="offline-list"></div>' +
              '</div>' +
              '<button type="button" id="about-open" class="settings-about" data-i18n="ctrl.about">About &amp; how it works</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div id="demo-status">&nbsp;</div>' +
        '<div id="map-top-row">' +
          '<div id="range-species" style="display:none"></div>' +
          '<div id="play-progress" style="display:none"><div class="pp-fill"></div><div class="pp-marker"></div><div class="pp-months"></div></div>' +
        '</div>' +
        '<div id="demo-map-wrap">' +
          '<div id="demo-map"></div>' +
          '<div id="demo-computing" style="display:none">' +
            '<div class="spinner"></div>' +
            '<div id="computing-text">Computing\u2026</div>' +
            '<div id="computing-progress-wrap"><div id="computing-progress-bar"></div></div>' +
          '</div>' +
          '<div id="demo-legend"></div>' +
        '</div>' +
        '<div id="csv-btn-wrap" style="display:none">' +
          '<button id="csv-download-btn" class="demo-btn" data-i18n="btn.csv" title="Download CSV">\u2b07 CSV</button>' +
        '</div>' +
        '<div id="species-panel">' +
          '<div class="sp-page-bar">' +
            '<button id="sp-back" class="fp-back" title="Back to map">‹</button>' +
            '<h3 id="sp-title" data-i18n="panel.spTitle">Species at location</h3>' +
          '</div>' +
          '<div class="sp-coords" id="sp-coords"></div>' +
          '<div class="sp-actions">' +
            '<button id="sp-checklist-btn" class="demo-btn" data-i18n="btn.checklist">✓ Checklist</button>' +
            '<button id="sp-map-btn" class="demo-btn demo-btn-light" data-i18n="btn.showInMap" title="Plot all observations on the map">📍 Map</button>' +
            '<button id="sp-pdf-btn" class="demo-btn demo-btn-light" title="Download PDF">⬇ PDF</button>' +
          '</div>' +
          '<table id="species-list-table">' +
            '<thead><tr><th id="sp-species-head" data-i18n="th.species">Species</th><th class="name2" id="sp-name2-head"></th><th id="sp-sci-head" class="clickable-head" data-i18n="th.sci">Scientific name</th><th id="sp-prob-head" data-i18n="th.prob">Probability</th><th id="sp-nd-head" class="num clickable-head" data-i18n="th.nd">n(d)</th><th id="sp-delta-head"></th></tr></thead>' +
            '<tbody id="sp-tbody"></tbody>' +
          '</table>' +
        '</div>' +
        '<div id="field-page" style="display:none">' +
          '<div class="field-page-bar">' +
            '<button id="field-back" class="fp-back" title="Back to map">‹</button>' +
            '<button id="field-nearby" class="fp-nearby" title="Nearby places" aria-label="Nearby places">▾</button>' +
            '<input id="field-coords" class="field-place" type="text" autocomplete="off" data-i18n-ph="ph.fieldtitle" placeholder="Location name" />' +
            '<button type="button" id="field-far" class="fp-far" style="display:none" aria-label="!">!</button>' +
            '<span class="field-seen" id="field-seen"></span>' +
            '<span class="field-actions">' +
              '<span class="fp-dl-wrap">' +
                '<button id="field-dl-btn" class="demo-btn" data-i18n-title="btn.actions" title="Actions">⋮</button>' +
                '<div id="field-dl-menu" class="fp-dl-menu" style="display:none">' +
                  '<button id="field-pdf" class="fp-dl-item">⬇ PDF</button>' +
                  '<button id="field-csv" class="fp-dl-item" data-i18n="btn.csv">⬇ CSV</button>' +
                  '<button id="field-log" class="fp-dl-item" data-i18n="btn.logcsv">⬇ Log</button>' +
                  '<div class="fp-dl-sep"></div>' +
                  '<button id="field-map" class="fp-dl-item" data-i18n="btn.showMap">📍 Map</button>' +
                  '<button id="field-review" class="fp-dl-item" data-i18n="btn.review">⬆ Upload</button>' +
                  '<div class="fp-dl-sep"></div>' +
                  '<button id="field-clear" class="fp-dl-item fp-dl-danger" data-i18n="btn.clear">Clear</button>' +
                '</div>' +
              '</span>' +
            '</span>' +
          '</div>' +
          '<div id="field-far-msg" class="fp-far-msg" data-i18n="chk.farWarn" style="display:none"></div>' +
          '<div class="fc-filterbar">' +
            '<span class="fc-search-wrap">' +
              '<input id="field-search" type="text" autocomplete="off" data-i18n-ph="ph.filter" placeholder="Filter species…" />' +
              '<button type="button" id="field-search-clear" class="fc-search-clear" data-i18n-title="btn.clear" title="Clear" aria-label="Clear" hidden>×</button>' +
            '</span>' +
            '<button type="button" id="field-filter-cycle" class="chk-filter-cycle" data-ff="all" title="Filter species">All</button>' +
          '</div>' +
          '<div id="field-list"></div>' +
          '<div id="fc-picker" style="display:none">' +
            '<div class="fcp-head"><span id="fcp-name"></span><button type="button" id="fcp-close" aria-label="Close">×</button></div>' +
            '<div class="fcp-step-row">' +
              '<button type="button" class="fcp-step" data-step="-25">−25</button>' +
              '<button type="button" class="fcp-step" data-step="-10">−10</button>' +
              '<button type="button" class="fcp-step" data-step="-1">−</button>' +
              '<span class="fcp-val" id="fcp-val">0</span>' +
              '<button type="button" class="fcp-step" data-step="1">+</button>' +
              '<button type="button" class="fcp-step" data-step="10">+10</button>' +
              '<button type="button" class="fcp-step" data-step="25">+25</button>' +
            '</div>' +
          '</div>' +
          '<div id="fc-act-picker" style="display:none">' +
            '<div class="fcp-head"><span id="fca-name"></span><button type="button" id="fca-close" aria-label="Close">×</button></div>' +
            '<input id="fca-search" type="text" autocomplete="off" data-i18n-ph="chk.actSearch" placeholder="Search or write…" />' +
            '<div id="fca-list"></div>' +
          '</div>' +
          '<div id="place-picker" style="display:none">' +
            '<div class="fcp-head"><span data-i18n="place.nearby">Nearby places</span><button type="button" id="place-close" aria-label="Close">×</button></div>' +
            '<div id="place-list"></div>' +
          '</div>' +
        '</div>' +
        '<div id="entry-page" style="display:none">' +
          '<div class="field-page-bar">' +
            '<button id="entry-back" class="fp-back" title="Back">‹</button>' +
            '<span id="entry-title" class="field-place"></span>' +
            '<span class="field-actions">' +
              '<button id="entry-merge" class="demo-btn" data-i18n="chk.merge">Merge</button>' +
            '</span>' +
          '</div>' +
          '<div id="entry-list"></div>' +
        '</div>' +
        '<div id="review-page" style="display:none">' +
          '<div class="field-page-bar">' +
            '<button id="review-back" class="fp-back" title="Back">‹</button>' +
            '<span id="review-title" class="field-place" data-i18n="review.title">Review &amp; upload</span>' +
            '<span class="field-actions">' +
              '<button id="review-new" class="demo-btn" data-i18n="review.newGroup">+ Checklist</button>' +
            '</span>' +
          '</div>' +
          '<div id="review-list"></div>' +
        '</div>' +
        '<div id="barchart-panel">' +
          '<div class="sp-page-bar">' +
            '<button id="bc-back" class="fp-back" title="Back to map">‹</button>' +
            '<h3 id="bc-title" data-i18n="panel.bcTitle">Location analysis</h3>' +
          '</div>' +
          '<div class="sp-coords" id="bc-coords"></div>' +
          '<div id="an-tabs">' +
            '<button class="an-tab" data-tab="timeline" data-i18n="tab.timeline">Timeline</button>' +
            '<button class="an-tab" data-tab="prob" data-i18n="tab.prob">Probability</button>' +
            '<button class="an-tab" data-tab="arrival" data-i18n="tab.arrival">Arrivals</button>' +
            '<button class="an-tab" data-tab="focus" data-i18n="tab.focus">Focus</button>' +
            '<button class="an-tab" data-tab="scatter" data-i18n="tab.scatter">Scatter</button>' +
          '</div>' +
          '<div id="an-controls">' +
            '<input id="an-filter" type="text" autocomplete="off" data-i18n-ph="ph.filter" placeholder="Filter species…" />' +
            '<label id="an-topn-wrap"><span data-i18n="ctrl.topN">Top N</span> ' +
              '<input id="an-topn" type="number" min="1" max="500" value="55" /> ' +
              '<span data-i18n="ctrl.rankby">Rank by</span> ' +
              '<select id="an-rankby">' +
                '<option value="arrival" data-i18n="rank.arrival">Arrivals</option>' +
                '<option value="prob" data-i18n="rank.prob">Probability</option>' +
                '<option value="both" data-i18n="rank.both">Both</option>' +
              '</select></label>' +
          '</div>' +
          '<div id="bc-container"></div>' +
        '</div>' +
        '<div id="sp-menu" style="display:none">' +
          '<button type="button" class="sp-menu-item sp-menu-app" data-act="apprange" data-i18n="menu.apprange">Species distribution</button>' +
          '<button type="button" class="sp-menu-item sp-menu-app" data-act="appmig" data-i18n="menu.appmig">Migration</button>' +
          '<button type="button" class="sp-menu-item" data-act="recent" data-i18n="menu.recent">Recent detections</button>' +
          '<button type="button" class="sp-menu-item" data-act="distmap" data-i18n="menu.distmap">Distribution map</button>' +
          '<button type="button" class="sp-menu-item" data-act="wiki" data-i18n="menu.wiki">Wikipedia</button>' +
          '<button type="button" class="sp-menu-item" data-act="birdlife" data-i18n="menu.birdlife">BirdLife</button>' +
          '<button type="button" class="sp-menu-item" data-act="macaulay" data-i18n="menu.macaulay">Macaulay Library</button>' +
          '<button type="button" class="sp-menu-item" data-act="xeno" data-i18n="menu.xeno">Xeno-canto (audio)</button>' +
          '<button type="button" class="sp-menu-item" data-act="interesting" data-i18n="menu.interestingAdd">★ Mark interesting</button>' +
          '<button type="button" class="sp-menu-item" data-act="hide" data-i18n="menu.hide">Do not show</button>' +
        '</div>' +
        '<div id="distmap-modal" style="display:none"><div id="distmap-box">' +
          '<button type="button" id="distmap-close" aria-label="Close">×</button>' +
          '<h3 id="distmap-title"></h3>' +
          '<div id="distmap-body"></div>' +
        '</div></div>' +
        '<div id="recent-modal" style="display:none"><div id="recent-box">' +
          '<button type="button" id="recent-close" aria-label="Close">×</button>' +
          '<h3 id="recent-title"></h3>' +
          '<div id="recent-body"></div>' +
        '</div></div>' +
        '<div id="about-modal" style="display:none"><div id="about-box">' +
          '<button type="button" id="about-close" aria-label="Close">×</button>' +
          '<h3 data-i18n="about.title">About the model &amp; how values are computed</h3>' +
          '<div id="about-body"></div>' +
        '</div></div>' +
        '<div id="perf-modal" style="display:none"><div id="perf-modal-box">' +
          '<h2 class="perf-title" data-i18n="popup.title">Species distributions and checklists</h2>' +
          '<p data-i18n="popup.perf"></p>' +
          '<p class="perf-feedback"><span data-i18n="popup.feedback"></span> <a href="mailto:vesmir09@gmail.com">vesmir09@gmail.com</a></p>' +
          '<p class="perf-attrib" data-i18n="footer.attrib"></p>' +
          '<button id="perf-modal-ok" class="demo-btn" data-i18n="popup.ok">OK</button>' +
        '</div></div>' +
      '</div>';

    // Restore saved language before building the UI text.
    setLang(window.GeoState.get("lang", defaultLang()), true);

    try {
      await Promise.all([initWorker(), loadLabels(), loadTaxonomy()]);
      buildLabelClass();
      document.getElementById("demo-loading").style.display = "none";
      document.getElementById("demo-app").style.display = "block";
      // The header banner holds the bird (settings) icon, the Mode dropdown and
      // the Checklist dropdown.
      var hdr = document.getElementById("site-header");
      var sw = document.getElementById("settings-wrap");
      if (hdr && sw) hdr.appendChild(sw);
      var modeWrap = document.getElementById("mode-wrap");
      if (hdr && modeWrap) hdr.appendChild(modeWrap);
      var chkWrap = document.getElementById("checklists-wrap");
      if (hdr && chkWrap) hdr.appendChild(chkWrap);
      var mpWrap = document.getElementById("mp-wrap");
      if (hdr && mpWrap) hdr.appendChild(mpWrap);
      syncHeaderHeight();
      window.addEventListener("resize", function () { syncHeaderHeight(); fitMapHeight(); });
      populateLangSelect();
      populateWeekSelect();
      restoreControls();
      populateSecondLangSelect();
      updateAnalysisControls();
      applyI18n();
      initMap();
      bindControls();
      refreshHiddenUI();
      refreshChecklists();
      setStatus(modeHint());
      fitMapHeight();
      showLastChange();
      showPerfModal();
      initOfflineIndicator();
      var hasHere = false; try { hasHere = new URLSearchParams(location.search).has("here"); } catch (e) {}
      if (!hasHere) restoreSession();   // return to the view we left (reload-safe)
      maybeUrlAutoLocate();   // ?here=1 → geolocate + open species list
      // Start Google Drive sync last, after all init-time GeoState writes, so
      // its open-time pull isn't fooled into thinking local is newer.
      if (window.GDriveSync) window.GDriveSync.init();
    } catch (e) {
      document.getElementById("demo-loading").innerHTML =
        '<span style="color:red">' + t("app.failed", { msg: e.message }) + '</span>';
      console.error(e);
    }
  }

  // Small badge shown only while the browser is offline, reassuring the user
  // the app is running from its cache. Re-localized on language change via the
  // data-i18n attribute picked up by applyI18n().
  function initOfflineIndicator() {
    var badge = document.createElement("div");
    badge.id = "offline-badge";
    badge.setAttribute("data-i18n", "status.offline");
    badge.textContent = t("status.offline");
    document.body.appendChild(badge);
    function sync() {
      badge.classList.toggle("show", !navigator.onLine);
    }
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    sync();
  }

  // ---- Model & labels ------------------------------------------------------
  async function initWorker() {
    setStatus("Loading ONNX model\u2026");
    worker = new Worker(new URL("inference-worker.js", SCRIPT_BASE).href);
    worker.onerror = function (err) { console.error("Worker error:", err); };

    await new Promise(function (resolve, reject) {
      worker.onmessage = function (e) {
        if (e.data.type === "init") {
          if (e.data.ok) resolve();
          else reject(new Error(e.data.error || "Worker init failed"));
        }
      };
      worker.postMessage({ type: "init", modelUrl: new URL(MODEL_URL, SCRIPT_BASE).href });
    });

    worker.onmessage = function (e) {
      var msg = e.data;
      if (msg.type !== "infer") return;
      var p = pendingInferences.get(msg.id);
      if (!p) return;
      pendingInferences.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(new Float32Array(msg.data));
    };
  }

  async function loadLabels() {
    var resp = await fetch(new URL(LABELS_URL, SCRIPT_BASE).href);
    var text = await resp.text();
    labels = text.trim().split("\n").map(function (line, i) {
      var parts = line.split("\t");
      return { key: parts[0], sci: parts[1] || "", common: parts[2] || parts[1] || "", index: i };
    });
    labelsByKey = {};
    labels.forEach(function (l) { labelsByKey[l.key] = l; });
  }

  // ---- Taxonomy (multilingual common names) --------------------------------
  // Parses taxonomy.csv into taxByCode keyed by species_code (== labels key).
  async function loadTaxonomy() {
    var resp = await fetch(new URL(TAX_URL, SCRIPT_BASE).href);
    var text = await resp.text();
    var rows = parseCsv(text);
    if (!rows.length) return;
    var header = rows[0];
    var codeCol = header.indexOf("species_code");
    if (codeCol < 0) return;
    // Only retain columns we actually use (com_name + class_name + languages).
    var wanted = { com_name: true, class_name: true };
    window.GeoI18N.LANGS.forEach(function (L) { wanted[L.taxCol] = true; });
    var keep = [];
    for (var c = 0; c < header.length; c++) if (wanted[header[c]]) keep.push(c);
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      var code = row[codeCol];
      if (!code) continue;
      var obj = {};
      for (var k = 0; k < keep.length; k++) {
        var ci = keep[k];
        if (row[ci]) obj[header[ci]] = row[ci];
      }
      taxByCode[code] = obj;
    }
  }

  // Minimal RFC-4180-ish CSV parser (handles quoted fields, commas, newlines).
  function parseCsv(text) {
    var rows = [], row = [], field = "", inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field); field = "";
      } else if (ch === "\n") {
        row.push(field); field = ""; rows.push(row); row = [];
      } else if (ch === "\r") {
        /* ignore */
      } else {
        field += ch;
      }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  // ---- Language & i18n -----------------------------------------------------
  function defaultLang() {
    // English by default — most users start here; auto-detect only complicates
    // first-impression QA. The language picker still saves their choice for
    // next visit.
    return "en";
  }

  function setLang(code, skipRefresh) {
    var L = window.GeoI18N.langByCode(code);
    lang = L.code;
    langTaxCol = L.taxCol;
    document.documentElement.setAttribute("lang", lang);
    if (skipRefresh) return;
    window.GeoState.save({ lang: lang });
    applyI18n();
    populateWeekSelect();   // re-label weeks in the new language
    populateSecondLangSelect();   // re-localize the "(none)" option
    refreshHiddenUI();      // re-localize hidden-species chip names
    refreshChecklists();    // re-localize the "Checklist (N)" button text
    if (document.getElementById("field-page").style.display === "flex") renderFieldList();  // re-localize activity labels if open
    if (window.__refreshFilterCycle) window.__refreshFilterCycle();   // cycle-button text isn't covered by data-i18n
    if (typeof refreshDetections === "function") refreshDetections();   // re-localize plotted "Show in map" species names + legend
    refreshCurrentView();   // re-render species names in the active panel
  }

  function populateLangSelect() {
    var sel = document.getElementById("lang-select");
    // Fully-translated (★) languages first, then the rest; alphabetical by
    // displayed name within each group.
    var ordered = window.GeoI18N.LANGS.slice().sort(function (a, b) {
      if (!!a.full !== !!b.full) return a.full ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    sel.innerHTML = ordered.map(function (L) {
      // ★ marks languages whose interface is fully translated (others fall
      // back to English for UI text).
      var label = L.name + (L.full ? " ★" : "");
      return '<option value="' + L.code + '"' + (L.code === lang ? " selected" : "") + ">" + label + "</option>";
    }).join("");
  }

  // Second-name language selector: "(none)" + every language.
  function populateSecondLangSelect() {
    var sel = document.getElementById("secondlang-select");
    var html = '<option value="">' + escapeHtml(t("compare.none")) + "</option>";
    html += window.GeoI18N.LANGS.map(function (L) {
      return '<option value="' + L.code + '"' + (L.code === secondLang ? " selected" : "") + ">" + L.name + "</option>";
    }).join("");
    sel.innerHTML = html;
  }

  // Apply translations to every [data-i18n] / [data-i18n-ph] element.
  function applyI18n() {
    var els = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < els.length; i++) els[i].textContent = t(els[i].getAttribute("data-i18n"));
    var phs = document.querySelectorAll("[data-i18n-ph]");
    for (var j = 0; j < phs.length; j++) phs[j].setAttribute("placeholder", t(phs[j].getAttribute("data-i18n-ph")));
    var tts = document.querySelectorAll("[data-i18n-title]");
    for (var k = 0; k < tts.length; k++) tts[k].setAttribute("title", t(tts[k].getAttribute("data-i18n-title")));
    var selSp = document.getElementById("species-search");
    if (selSp && selSp.dataset.selectedKey && labelsByKey[selSp.dataset.selectedKey]) {
      var lbl = labelsByKey[selSp.dataset.selectedKey];
      selSp.setAttribute("placeholder", speciesName(lbl) + " (" + lbl.sci + ")");
    }
    renderAboutBody();
    updateLegend();
  }
  // The About panel ends with a footer holding the visit counter and the
  // "Last change" timestamp. Rebuilt on language change and when the timestamp
  // resolves, so both survive re-renders.
  var lastChangeText = "";
  function renderAboutBody() {
    var about = document.getElementById("about-body");
    if (!about) return;
    about.innerHTML = t("about.html") +   // raw HTML doc, localized
      '<div id="about-footer">' +
        '<div id="visit-counter"><img src="https://api.visitorbadge.io/api/visitors?path=https%3A%2F%2Fpcmoan70.github.io%2Fmigration_calendar&label=page%20visits&labelColor=%230f1b24&countColor=%232f6f4f" alt="page visits" /></div>' +
        (lastChangeText ? '<div id="last-change">' + escapeHtml(t("footer.lastchange", { t: lastChangeText })) + "</div>" : "") +
      "</div>";
  }

  // Build the 48-week dropdown with localized labels.
  function populateWeekSelect() {
    var sel = document.getElementById("week-select");
    var cur = +sel.value || 1;
    var html = "";
    for (var w = 1; w <= 48; w++) html += '<option value="' + w + '">' + weekText(w) + "</option>";
    sel.innerHTML = html;
    sel.value = cur;
  }

  // Re-render whatever panel/overlay is currently shown (after a language change).
  function refreshCurrentView() {
    if (currentSpView && currentSpView.mode === "country" && document.getElementById("species-panel").style.display !== "none") {
      renderSpeciesInCountry(currentSpView.lat, currentSpView.lon); return;
    }
    if (currentMode === "list" && marker) {
      var ll = marker.getLatLng();
      renderSpeciesList(ll.lat, ll.lng);
    } else if (currentMode === "barchart" && analysisData) {
      renderActiveTab();
    } else if ((currentMode === "range" || currentMode === "richness") && cachedRender) {
      showCachedWeek();
    }
    // Field-list re-render so the chk-filter buttons reflect interesting set changes.
    if (document.getElementById("field-page").style.display === "flex") renderFieldList();
  }

  // ---- Map setup -----------------------------------------------------------
  function initMap() {
    var view = window.GeoState.get("view", null);
    var center = (view && view.lat != null) ? [view.lat, view.lon] : [30, 0];
    var zoom = (view && view.zoom != null) ? view.zoom : 2;
    // Constrain to a single world copy so panning can't yield out-of-range
    // longitudes (e.g. a click returning lon = 635) and the range overlay
    // always projects onto the visible map.
    map = L.map("demo-map", {
      center: center, zoom: zoom,
      // Keep min/max zoom on the H3 step ladder (multiples of H3_ZOOM_STEP) so
      // the clamped end stops don't land off-grid with larger cells.
      minZoom: window.h3 ? Math.ceil(2 / H3_ZOOM_STEP) * H3_ZOOM_STEP : 2,
      maxZoom: window.h3 ? Math.floor(MAX_ZOOM / H3_ZOOM_STEP) * H3_ZOOM_STEP : MAX_ZOOM,
      worldCopyJump: true,
      // Mouse wheel zooms on devices with a precise pointer (PC). On touch
      // (coarse pointer) it stays off — zoom there is via the +/− icons / pinch,
      // and page scrolling isn't hijacked.
      scrollWheelZoom: !!(window.matchMedia && window.matchMedia("(pointer: fine)").matches),
      // Soft bounds (viscosity 0) so they snap back after a gesture instead of
      // hard-blocking it — a solid bound (1.0) fights pinch-zoom-out on touch.
      maxBounds: [[-90, -180], [90, 180]], maxBoundsViscosity: 0.0,
      // Zoom in ~2.65x steps (one H3 resolution per level) so hex cells keep a
      // constant on-screen size; only when the H3 overlay is available.
      zoomSnap: window.h3 ? H3_ZOOM_STEP : 1,
      zoomDelta: window.h3 ? H3_ZOOM_STEP : 1,
    });

    setBasemap(window.GeoState.get("basemap", "light"));

    // Whenever the map is resized (invalidateSize from any source), make sure
    // you can still zoom out to the whole world on the current screen.
    map.on("resize", updateWorldMinZoom);
    map.whenReady(updateWorldMinZoom);
    // Offline: if the view isn't cached but a downloaded area covers it, offer it.
    map.on("moveend zoomend", scheduleOfflineCheck);
    window.addEventListener("offline", scheduleOfflineCheck);
    window.addEventListener("online", refreshOfflineZoomCap);   // reconnected → fetch full-res deep tiles again
    window.addEventListener("popstate", onNavPop);   // browser/phone Back closes the top in-app screen

    L.control.scale({ position: "bottomleft", imperial: false, maxWidth: 140 }).addTo(map);

    map.on("click", onMapClick);

    // "Locate me" crosshair control — zooms to the device's current location.
    var LocateControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var c = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        var a = L.DomUtil.create("a", "geo-locate-btn", c);
        a.href = "#";
        a.title = t("ctrl.locate");
        a.setAttribute("aria-label", t("ctrl.locate"));
        a.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
          '<circle cx="12" cy="12" r="6"/><line x1="12" y1="1" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="23"/>' +
          '<line x1="1" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/></svg>';
        L.DomEvent.on(a, "click", function (e) {
          L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e);
          toggleLiveLocate();
        });
        return c;
      }
    });
    map.addControl(new LocateControl());
    map.on("locationerror", function () { setStatus(t("status.locateError")); });

    // Place (location-name) search — a map-pointer button below the crosshairs
    // that expands into a search box. The panel itself lives in the map wrapper
    // (above the map) so it's never clipped/stacked behind the tiles.
    var psPanel = L.DomUtil.create("div", "place-search-panel", document.getElementById("demo-map-wrap"));
    psPanel.style.display = "none";
    psPanel.innerHTML = '<input id="place-search" type="text" autocomplete="off" data-i18n-ph="ph.place" placeholder="' + escapeHtml(t("ph.place")) + '" />' +
      '<div id="place-results"></div>';
    function togglePlaceSearch() {
      var btn = document.querySelector(".place-search-btn");
      var wrap = document.getElementById("demo-map-wrap");
      if (!btn || !wrap) return;
      if (psPanel.style.display === "none") {
        var br = btn.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
        psPanel.style.left = Math.round(br.right - wr.left + 6) + "px";
        psPanel.style.top = Math.round(br.top - wr.top) + "px";
        psPanel.style.display = "block";
        btn.classList.add("is-open");
        var inp = document.getElementById("place-search"); if (inp) { inp.focus(); inp.select(); }
      } else {
        psPanel.style.display = "none";
        btn.classList.remove("is-open");
        var res = document.getElementById("place-results"); if (res) res.style.display = "none";
      }
    }
    var PlaceSearchControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var c = L.DomUtil.create("div", "leaflet-bar leaflet-control place-search-ctrl");
        L.DomEvent.disableClickPropagation(c);
        var a = L.DomUtil.create("a", "place-search-btn", c);
        a.href = "#"; a.title = t("ctrl.placeSearch"); a.setAttribute("aria-label", t("ctrl.placeSearch"));
        a.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 22s-7-7.58-7-13a7 7 0 1 1 14 0c0 5.42-7 13-7 13z"/><circle cx="12" cy="9" r="2.5"/></svg>';
        L.DomEvent.on(a, "click", function (e) { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); togglePlaceSearch(); });
        return c;
      }
    });
    map.addControl(new PlaceSearchControl());

    // Migration animation toggle — an on-map button (shown in Species
    // distribution / richness) that plays the range across the 48 weeks.
    var AnimControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var c = L.DomUtil.create("div", "leaflet-bar leaflet-control anim-ctrl");
        L.DomEvent.disableClickPropagation(c);
        var a = L.DomUtil.create("a", "anim-btn", c);
        a.href = "#"; a.title = t("btn.play"); a.setAttribute("aria-label", t("btn.play"));
        a.innerHTML = animIconSvg(false);
        L.DomEvent.on(a, "click", function (e) { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); toggleAnimation(); });
        animCtrlEl = c;
        c.style.display = (currentMode === "range" || currentMode === "richness") ? "" : "none";
        return c;
      }
    });
    map.addControl(new AnimControl());

    // H3 detail level — hexagon +/- buttons (left side), shown only with an
    // overlay (Species distribution / richness). + = finer (more tiles), - =
    // coarser; each step is one H3 resolution.
    var DetailControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var c = L.DomUtil.create("div", "leaflet-bar leaflet-control h3-detail-ctrl");
        L.DomEvent.disableClickPropagation(c);
        var mkBtn = function (cls, delta, sym, titleKey) {
          var a = L.DomUtil.create("a", "h3-detail-btn " + cls, c);
          a.href = "#"; a.title = t(titleKey); a.setAttribute("aria-label", t(titleKey));
          a.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-linecap="round">' +
            '<polygon points="12,2.5 20.5,7.25 20.5,16.75 12,21.5 3.5,16.75 3.5,7.25" stroke-width="1.5"/>' +
            (sym === "+" ? '<line x1="12" y1="8.5" x2="12" y2="15.5" stroke-width="2"/><line x1="8.5" y1="12" x2="15.5" y2="12" stroke-width="2"/>'
                         : '<line x1="8.5" y1="12" x2="15.5" y2="12" stroke-width="2"/>') + "</svg>";
          L.DomEvent.on(a, "click", function (e) { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); adjustH3Detail(delta); });
          return a;
        };
        mkBtn("h3-finer", 1, "+", "ctrl.detailFiner");
        mkBtn("h3-coarser", -1, "-", "ctrl.detailCoarser");
        h3CtrlEl = c;
        c.style.display = (currentMode === "range" || currentMode === "richness") ? "" : "none";
        setTimeout(updateH3DetailButtons, 0);
        return c;
      }
    });
    map.addControl(new DetailControl());

    // Full-screen toggle — expands the whole page (collapsing the browser's
    // address bar). Only added where the Fullscreen API is available.
    if (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen) {
      var FullscreenControl = L.Control.extend({
        options: { position: "topright" },
        onAdd: function () {
          var c = L.DomUtil.create("div", "leaflet-bar leaflet-control");
          var a = L.DomUtil.create("a", "fs-toggle-btn", c);
          a.href = "#"; a.title = t("ctrl.fullscreen"); a.setAttribute("aria-label", t("ctrl.fullscreen"));
          a.innerHTML = fsIconSvg();
          L.DomEvent.on(a, "click", function (e) { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); toggleFullscreen(); });
          return c;
        }
      });
      map.addControl(new FullscreenControl());
      document.addEventListener("fullscreenchange", function () {
        var b = document.querySelector(".fs-toggle-btn"); if (b) b.innerHTML = fsIconSvg();
        fitMapHeight();
      });
    }

    // Download the current view for offline use — a save-map button on the right.
    var DownloadControl = L.Control.extend({
      options: { position: "topright" },
      onAdd: function () {
        var c = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        L.DomEvent.disableClickPropagation(c);
        var a = L.DomUtil.create("a", "map-dl-btn", c);
        a.href = "#"; a.title = t("ctrl.downloadView"); a.setAttribute("aria-label", t("ctrl.downloadView"));
        a.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 3v10"/><path d="M8 11l4 4 4-4"/><path d="M4 19h16"/></svg>';
        L.DomEvent.on(a, "click", function (e) { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); openAreaDialog(map.getBounds()); });
        return c;
      }
    });
    map.addControl(new DownloadControl());

    // Live position: keep the plus marker on the current location. On the first
    // fix, centre the map and populate the click-driven modes at that point;
    // later fixes just move the plus (no re-centring, no re-querying).
    map.on("locationfound", function (e) {
      if (!posWatching) return;
      // Blue plus follows the live position.
      if (posMarker) posMarker.setLatLng(e.latlng);
      else posMarker = L.marker(e.latlng, { icon: livePosIcon("blue"), interactive: false, keyboard: false, zIndexOffset: 1100 }).addTo(map);
      if (!posCentered) {
        posCentered = true;
        // Red plus marks the current location at the moment of the click.
        posFixedMarker = L.marker(e.latlng, { icon: livePosIcon("red"), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
        map.setView(e.latlng, Math.max(map.getZoom() || 0, 11));
        if (["list", "barchart", "range"].indexOf(currentMode) >= 0) onMapClick(e);
      }
    });

    setupAreaOverlays();   // protected/priority-area overlay toggles (off by default)
    loadDetections();      // restore any "Show in map" detection points
    loadMapPoints();       // user-added pins + saved named lists (from localStorage)
    ensureMpLayer();
    renderMapPoints();
    map.on("contextmenu", onMapContextMenu);   // right-click / long-press → add point dialog
    map.on("movestart zoomstart click", clearSpider);   // collapse the fan-out when the view changes / map is clicked
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") clearSpider(); });

    map.on("moveend", function () {
      var c = map.getCenter();
      window.GeoState.save({ view: { lat: c.lat, lon: c.lng, zoom: map.getZoom() } });
      // Re-rank an open species search by likelihood at the new centre.
      var sRes = document.getElementById("species-results"), sInp = document.getElementById("species-search");
      if (sRes && sInp && sRes.style.display === "block") showSearch(sInp, sRes);
      if (currentMode !== "range" && currentMode !== "richness") return;
      if (animating) return;   // don't re-render mid-animation
      paintOverlay();
      clearTimeout(moveEndTimer);
      moveEndTimer = setTimeout(triggerRender, 300);
    });

    // Initial render for map modes (renders richness, or range if a species
    // was restored; range without a species is a no-op).
    if (currentMode === "range" || currentMode === "richness") triggerRender();
  }

  function triggerRender() {
    if (currentMode === "richness") renderRichness();
    else if (currentMode === "range") renderRangeMap();
  }

  function setBasemap(which) {
    var cfg = BASEMAPS[which] || BASEMAPS.dark;
    if (baseLayer) map.removeLayer(baseLayer);
    // subdomains must not be undefined — Leaflet reads .length even when the
    // URL has no {s} placeholder (e.g. the Esri satellite layer).
    baseLayer = L.tileLayer(cfg.url, { attribution: cfg.attribution, maxZoom: MAX_ZOOM, maxNativeZoom: cfg.maxNativeZoom || MAX_ZOOM, subdomains: cfg.subdomains || "abc", noWrap: true });
    baseLayer._origMaxNative = cfg.maxNativeZoom || MAX_ZOOM;   // restore target when online / leaving an area
    baseLayer.on("tileerror", scheduleOfflineCheck);   // offline + uncached → suggest a downloaded area
    baseLayer.addTo(map);
    baseLayer.bringToBack();
    refreshOfflineZoomCap();   // if offline inside a shallow download, upscale instead of fetching missing tiles
    document.body.setAttribute("data-basemap", which);
    var sel = document.getElementById("maptype-select");
    if (sel) sel.value = which;
    window.GeoState.save({ basemap: which });
  }

  // ---- Offline map areas ----------------------------------------------------
  // Download the basemap + active overlay tiles for a drawn rectangle into a
  // pinned cache (kept until the user deletes it). The SW serves them offline.
  var OFFLINE_TILE_BYTES = 22000;   // rough per-tile size for the estimate
  var OFFLINE_MAX_TILES = 12000;    // guard against an unreasonably huge download
  var offlineMaxZoom = 17;          // max zoom for area downloads — the app's deepest tile zoom (set in Settings)
  var offlineFramesLayer = null;    // thin frames showing downloaded areas
  function getOfflineAreas() { return window.GeoState.get("offlineAreas", []) || []; }
  function saveOfflineAreas(a) { window.GeoState.save({ offlineAreas: a }); }
  function tileRangeFor(bounds, z) {
    var n = Math.pow(2, z);
    var lon2x = function (lon) { return (lon + 180) / 360 * n; };
    var lat2y = function (lat) { var r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n; };
    var clamp = function (v) { return Math.max(0, Math.min(n - 1, Math.floor(v))); };
    return { xMin: clamp(lon2x(bounds.getWest())), xMax: clamp(lon2x(bounds.getEast())),
             yMin: clamp(lat2y(bounds.getNorth())), yMax: clamp(lat2y(bounds.getSouth())) };
  }
  function activeOverlayLayers() {
    return (typeof arcOverlays !== "undefined" ? arcOverlays : []).filter(function (o) {
      return o.layer && o.layer._base && map.hasLayer(o.layer);
    }).map(function (o) { return o.layer; });
  }
  function offlineLayers() { return [baseLayer].concat(activeOverlayLayers()).filter(Boolean); }
  // Generate the exact tile URL Leaflet would request for (x,y,z) — set the
  // layer's tileZoom so the base layer's getTileUrl uses z, not its live zoom.
  function layerTileUrl(layer, x, y, z) {
    var c = L.point(x, y); c.z = z;
    var prev = layer._tileZoom; layer._tileZoom = z;
    var u = null; try { u = layer.getTileUrl(c); } catch (e) {}
    layer._tileZoom = prev;
    return u;
  }
  // The integer tile zooms the app actually requests = round(zoom-snap steps).
  // zoomSnap is one H3 resolution, so it skips some integers (e.g. 16) — only
  // cache the levels the map will ever ask for, else offline tiles never match.
  function offlineZoomLevels(zStart, zMax) {
    var step = window.h3 ? H3_ZOOM_STEP : 1;
    var maxZ = map.getMaxZoom(), seen = {}, out = [];
    for (var m = 0; m <= maxZ + 1e-6; m += step) {
      var tz = Math.round(m);
      if (tz < zStart || tz > zMax || seen[tz]) continue;
      seen[tz] = 1; out.push(tz);
    }
    if (!out.length) out.push(zStart);
    return out;
  }
  function offlineTileCount(bounds, zStart, zMax) {
    var n = 0;
    offlineZoomLevels(zStart, zMax).forEach(function (z) { var r = tileRangeFor(bounds, z); n += (r.xMax - r.xMin + 1) * (r.yMax - r.yMin + 1); });
    return n;
  }
  function buildOfflineUrls(bounds, zStart, zMax, layers) {
    var urls = [];
    offlineZoomLevels(zStart, zMax).forEach(function (z) {
      var r = tileRangeFor(bounds, z);
      for (var x = r.xMin; x <= r.xMax; x++) for (var y = r.yMin; y <= r.yMax; y++) {
        for (var li = 0; li < layers.length; li++) { var u = layerTileUrl(layers[li], x, y, z); if (u) urls.push(u); }
      }
    });
    return urls;
  }
  // Fetch one tile for caching. Cross-origin tiles fetched no-cors come back as
  // *opaque* responses, which browsers pad to a fixed ~7 MB each against the
  // storage quota — a deep area would blow the quota and start failing puts.
  // The tile CDNs send `Access-Control-Allow-Origin: *`, so try a real CORS
  // fetch first (stored at true size) and only fall back to opaque for hosts
  // (some overlays) that don't allow CORS.
  function cacheOneTile(cache, url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw 0;
      return cache.put(url, res);
    }).catch(function () {
      return fetch(url, { mode: "no-cors" }).then(function (res) { return cache.put(url, res); });
    });
  }
  function downloadOfflineArea(bounds, zStart, zMax, layers, name, onProgress, isAborted) {
    var id = "area-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    var urls = buildOfflineUrls(bounds, zStart, zMax, layers);
    var total = urls.length, done = 0, ok = 0;
    function aborted() { return !!(isAborted && isAborted()); }
    return caches.open("pinned-" + id).then(function (cache) {
      return new Promise(function (resolve) {
        var i = 0, active = 0, CONC = 6;
        function pump() {
          if ((i >= urls.length || aborted()) && active === 0) { resolve(); return; }
          while (active < CONC && i < urls.length && !aborted()) {
            var url = urls[i++]; active++;
            cacheOneTile(cache, url).then(function () { ok++; })
              .catch(function () {})
              .then(function () { active--; done++; if (onProgress) onProgress(done, total); pump(); });
          }
        }
        pump();
      });
    }).then(function () {
      if (aborted()) { return caches.delete("pinned-" + id).then(function () { return -1; }); }
      var areas = getOfflineAreas();
      areas.push({ id: id, name: name, basemap: window.GeoState.get("basemap", "light"),
                   bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
                   zStart: zStart, zMax: zMax, tiles: ok, bytes: ok * OFFLINE_TILE_BYTES, createdAt: Date.now() });
      saveOfflineAreas(areas);
      return ok;
    });
  }
  function deleteOfflineArea(id) {
    return caches.delete("pinned-" + id).then(function () {
      saveOfflineAreas(getOfflineAreas().filter(function (a) { return a.id !== id; }));
      renderOfflineAreas();
    });
  }
  function openAreaDialog(bounds) {
    var layers = offlineLayers();
    // Cap at the app's max tile zoom and the basemap's native max; the chosen
    // depth comes from the Settings "Download max zoom" option.
    var appMaxZoom = Math.round(map.getMaxZoom());
    var baseMaxNative = Math.min((baseLayer && baseLayer.options.maxNativeZoom) || MAX_ZOOM, appMaxZoom);
    var zStart = Math.max(0, Math.min(baseMaxNative, Math.round(map.getZoom())));
    var zMax = Math.max(zStart, Math.min(baseMaxNative, offlineMaxZoom));
    var tiles = offlineTileCount(bounds, zStart, zMax) * layers.length;
    var ov = document.createElement("div"); ov.className = "ui-modal-overlay";
    var box = document.createElement("div"); box.className = "ui-modal area-dl";
    box.innerHTML =
      '<div class="ui-modal-msg">' + escapeHtml(t("offline.title")) + "</div>" +
      '<div class="area-dl-row">' + escapeHtml(t("offline.maxzoom")) + ": <b>" + zMax + "</b></div>" +
      '<div class="area-dl-est" id="area-est"></div>' +
      '<input class="ui-modal-input" id="area-name" type="text" placeholder="' + escapeHtml(t("offline.namePh")) + '">' +
      '<div class="area-dl-prog" id="area-prog" style="display:none"></div>' +
      '<div class="ui-modal-btns"><button type="button" class="demo-btn demo-btn-light" id="area-cancel">' + escapeHtml(t("btn.cancel")) + '</button>' +
        '<button type="button" class="demo-btn" id="area-go">' + escapeHtml(t("offline.download")) + "</button></div>";
    document.body.appendChild(ov); ov.appendChild(box);
    var est = box.querySelector("#area-est");
    est.textContent = t("offline.estimate", { n: tiles.toLocaleString(), mb: (tiles * OFFLINE_TILE_BYTES / 1048576).toFixed(tiles * OFFLINE_TILE_BYTES < 10485760 ? 1 : 0) });
    est.classList.toggle("area-dl-warn", tiles > OFFLINE_MAX_TILES);
    // Suggest the most specific place name at the view centre (locality, not
    // country) — unless the user starts typing their own.
    var nameInput = box.querySelector("#area-name");
    nameInput.addEventListener("input", function () { nameInput.dataset.user = "1"; });
    var ctr = bounds.getCenter();
    detailedPlaceName(ctr.lat, ctr.lng).then(function (nm) {
      if (nm && !nameInput.dataset.user && !nameInput.value) nameInput.value = nm;
    });
    var downloading = false, aborted = false;
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    // Cancel must always work — before a download it just closes; during one it
    // aborts the in-flight transfer (the button is never disabled).
    box.querySelector("#area-cancel").addEventListener("click", function () {
      if (downloading) aborted = true;
      close();
    });
    box.querySelector("#area-go").addEventListener("click", function () {
      if (tiles > OFFLINE_MAX_TILES) { modalConfirm(t("offline.tooMany", { n: tiles.toLocaleString() })).then(function (okc) { if (okc) run(zMax); }); }
      else run(zMax);
    });
    function run(zMax) {
      var name = (box.querySelector("#area-name").value || "").trim() || (t("offline.area") + " " + (getOfflineAreas().length + 1));
      var prog = box.querySelector("#area-prog"); prog.style.display = "block";
      box.querySelector("#area-go").disabled = true;
      downloading = true;
      downloadOfflineArea(bounds, zStart, zMax, layers, name, function (d, total) {
        prog.textContent = t("offline.downloading", { done: d.toLocaleString(), total: total.toLocaleString() });
      }, function () { return aborted; }).then(function (res) {
        if (aborted) return;
        close(); renderOfflineAreas();
        if (res === 0) setStatus(t("offline.failed", { name: name }));
        else setStatus(t("offline.saved", { name: name }));
      });
    }
  }
  function renderOfflineAreas() {
    var list = document.getElementById("offline-list"); if (!list) return;
    var areas = getOfflineAreas();
    if (!areas.length) { list.innerHTML = '<p class="dd-empty">' + escapeHtml(t("offline.empty")) + "</p>"; return; }
    list.innerHTML = areas.map(function (a) {
      var mb = (a.bytes / 1048576).toFixed(a.bytes < 10485760 ? 1 : 0);
      return '<div class="offline-row"><span class="offline-name" title="z' + a.zStart + "–" + a.zMax + '">' + escapeHtml(a.name) + "</span>" +
        '<span class="offline-meta">' + a.tiles.toLocaleString() + " · ~" + mb + " MB</span>" +
        '<button type="button" class="dd-del offline-del" data-id="' + escapeHtml(a.id) + '" aria-label="' + escapeHtml(t("offline.delete")) + '">×</button></div>';
    }).join("");
    list.querySelectorAll(".offline-del").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = this.getAttribute("data-id"), a = getOfflineAreas().filter(function (x) { return x.id === id; })[0];
        modalConfirm(t("offline.deletePrompt", { name: a ? a.name : "" })).then(function (ok) { if (ok) deleteOfflineArea(id); });
      });
    });
    renderOfflineFrames();
  }
  // Thin frames on the map marking which areas have been downloaded.
  function renderOfflineFrames() {
    if (!map || !L.rectangle) return;
    if (!offlineFramesLayer) offlineFramesLayer = L.layerGroup().addTo(map);
    offlineFramesLayer.clearLayers();
    getOfflineAreas().forEach(function (a) {
      if (!a.bbox) return;
      L.rectangle([[a.bbox[1], a.bbox[0]], [a.bbox[3], a.bbox[2]]],
        { className: "offline-frame", color: "#0b3a3a", weight: 0.6, opacity: 0.7, dashArray: "4 4", fill: false, interactive: false }).addTo(offlineFramesLayer);
    });
  }
  // When offline and the current view has no cached tiles, but a downloaded
  // area covers this spot, offer to switch to one of those cached maps.
  var offlinePromptBusy = false, offlineCheckTimer = null;
  // Downloaded areas covering the map centre that use a given basemap.
  function coveringAreas(basemap) {
    if (!map) return [];
    var c = map.getCenter();
    return getOfflineAreas().filter(function (a) {
      return a.bbox && (basemap == null || (a.basemap || "light") === basemap) &&
        c.lng >= a.bbox[0] && c.lng <= a.bbox[2] && c.lat >= a.bbox[1] && c.lat <= a.bbox[3];
    });
  }
  // When offline inside a downloaded area, cap the basemap's native zoom to the
  // deepest cached level so Leaflet upscales those tiles (smooth/pixelated zoom)
  // instead of requesting missing deep tiles and leaving broken holes. Restored
  // to the layer's real native max when online or outside any download.
  function refreshOfflineZoomCap() {
    if (!baseLayer) return;
    var cap = baseLayer._origMaxNative || MAX_ZOOM;
    if (!navigator.onLine) {
      var here = coveringAreas(window.GeoState.get("basemap", "light"));
      if (here.length) cap = here.reduce(function (m, a) { return Math.max(m, a.zMax || 0); }, 0);
    }
    if (baseLayer.options.maxNativeZoom !== cap) {
      baseLayer.options.maxNativeZoom = cap;
      baseLayer.redraw();
    }
  }
  function scheduleOfflineCheck() {
    refreshOfflineZoomCap();   // immediate: upscale cached tiles rather than fetch missing ones
    if (navigator.onLine) return;
    clearTimeout(offlineCheckTimer);
    offlineCheckTimer = setTimeout(checkOfflineCoverage, 600);
  }
  function checkOfflineCoverage() {
    if (navigator.onLine || offlinePromptBusy || !map || !window.caches) return;
    var covering = coveringAreas(null);
    if (!covering.length) return;
    var curBase = window.GeoState.get("basemap", "light");
    // The current basemap is downloaded here → its tiles upscale (handled by the
    // zoom cap); don't interrupt with a prompt. Only offer a switch when *only*
    // a different basemap covers this view.
    if (covering.some(function (a) { return (a.basemap || "light") === curBase; })) return;
    promptOfflineAreas(covering, curBase);
  }
  function promptOfflineAreas(areas, curBase) {
    offlinePromptBusy = true;
    var ov = document.createElement("div"); ov.className = "ui-modal-overlay";
    var box = document.createElement("div"); box.className = "ui-modal";
    box.innerHTML = '<div class="ui-modal-msg">' + escapeHtml(t("offline.coverPrompt")) + "</div>" +
      '<div class="offline-pick">' + areas.map(function (a) {
        var bm = a.basemap && a.basemap !== curBase ? " (" + escapeHtml(t("basemap." + a.basemap) || a.basemap) + ")" : "";
        return '<button type="button" class="demo-btn offline-pick-btn" data-id="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + bm + "</button>";
      }).join("") + "</div>" +
      '<div class="ui-modal-btns"><button type="button" class="demo-btn demo-btn-light" id="offc-cancel">' + escapeHtml(t("btn.cancel")) + "</button></div>";
    document.body.appendChild(ov); ov.appendChild(box);
    function close() { offlinePromptBusy = false; if (ov.parentNode) ov.parentNode.removeChild(ov); }
    box.querySelector("#offc-cancel").addEventListener("click", close);
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    box.querySelectorAll(".offline-pick-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var a = getOfflineAreas().filter(function (x) { return x.id === this.getAttribute("data-id"); }.bind(this))[0];
        close();
        if (!a) return;
        if (a.basemap && a.basemap !== window.GeoState.get("basemap", "light")) setBasemap(a.basemap);
        try { map.fitBounds([[a.bbox[1], a.bbox[0]], [a.bbox[3], a.bbox[2]]], { maxZoom: a.zMax }); } catch (e) {}
      });
    });
  }

  // ---- Protected / priority area overlays ----------------------------------
  // Shown as the official providers' map tiles (display only — geometry is
  // never downloaded or bundled, which keeps within each source's licence).
  // Each layer carries the attribution it requires; Leaflet shows it while the
  // layer is active. Non-commercial use; see the i18n "About" note.
  //   WDPA   — UNEP-WCMC & IUCN, Protected Planet (national parks, reserves,
  //            marine areas, IUCN category/designation/status).
  //   Ramsar — the Ramsar-designated subset of WDPA (wetlands).
  //   Natura 2000 — EEA (EU Birds-Directive SPAs + Habitats-Directive sites).
  //   OSM    — OpenStreetMap protected areas via Overpass (open fallback).
  var WDPA_EXPORT = "https://data-gis.unep-wcmc.org/server/rest/services/ProtectedPlanet/WDPCA/MapServer/export";
  var N2K_EXPORT = "https://bio.discomap.eea.europa.eu/arcgis/rest/services/ProtectedSites/Natura2000_Dyna_WM/MapServer/export";
  var RAMSAR_DEF = "desig_eng='Wetland of International Importance (Ramsar Site)'";
  var WDPA_ATTR = 'Protected areas &copy; <a href="https://www.protectedplanet.net" target="_blank" rel="noopener">UNEP-WCMC &amp; IUCN — Protected Planet (WDPA)</a>';
  var EEA_ATTR = 'Natura 2000 &copy; <a href="https://www.eea.europa.eu" target="_blank" rel="noopener">European Environment Agency</a>';
  var OSM_PA_ATTR = 'Protected areas &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  var EBIRD_HS_ATTR = 'Hotspots &copy; <a href="https://ebird.org" target="_blank" rel="noopener">eBird</a> / Cornell Lab';

  // A Leaflet tile layer backed by an ArcGIS MapServer "export" endpoint: each
  // 256-px tile is requested as a rendered PNG for its Web-Mercator bbox.
  var ArcGISExportLayer = L.TileLayer.extend({
    initialize: function (base, options) { this._base = base; L.TileLayer.prototype.initialize.call(this, "", options || {}); },
    getTileUrl: function (coords) {
      var ts = this.getTileSize(), nwP = coords.scaleBy(ts), seP = nwP.add(ts);
      var a = L.CRS.EPSG3857.project(this._map.unproject(nwP, coords.z));
      var b = L.CRS.EPSG3857.project(this._map.unproject(seP, coords.z));
      var bbox = Math.min(a.x, b.x) + "," + Math.min(a.y, b.y) + "," + Math.max(a.x, b.x) + "," + Math.max(a.y, b.y);
      var u = this._base + "?f=image&format=png32&transparent=true&dpi=96&bboxSR=3857&imageSR=3857" +
        "&size=" + ts.x + "," + ts.y + "&bbox=" + bbox;
      if (this.options.arcLayers) u += "&layers=" + encodeURIComponent(this.options.arcLayers);
      if (this.options.layerDefs) u += "&layerDefs=" + encodeURIComponent(this.options.layerDefs);
      return u;
    }
  });

  // OpenStreetMap protected areas (Overpass) as outlines — refreshed on pan
  // while active, and only when zoomed in enough to keep the query small.
  function osmProtectedLayer() {
    var grp = L.layerGroup(), active = false, token = 0;
    function load() {
      if (map.getZoom() < 9) { grp.clearLayers(); return; }
      var b = map.getBounds();
      var bbox = b.getSouth().toFixed(4) + "," + b.getWest().toFixed(4) + "," + b.getNorth().toFixed(4) + "," + b.getEast().toFixed(4);
      var q = "[out:json][timeout:25];(way[\"leisure\"=\"nature_reserve\"](" + bbox + ");relation[\"leisure\"=\"nature_reserve\"](" + bbox +
        ");way[\"boundary\"=\"protected_area\"](" + bbox + ");relation[\"boundary\"=\"protected_area\"](" + bbox + "););out geom;";
      var mine = ++token;
      fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (mine !== token || !active) return;
          grp.clearLayers();
          var style = { color: "#1f8a3b", weight: 1.5, opacity: 0.9, fillColor: "#1f8a3b", fillOpacity: 0.08 };
          (j.elements || []).forEach(function (el) {
            var nm = (el.tags && el.tags.name) || t("layer.osmpa");
            var add = function (pts, closed) {
              if (pts.length < 2) return;
              var lyr = closed ? L.polygon(pts, style) : L.polyline(pts, style);
              lyr.bindTooltip(nm, { sticky: true, className: "area-tip" }); grp.addLayer(lyr);
            };
            if (el.type === "way" && el.geometry) {
              var p = el.geometry.map(function (g) { return [g.lat, g.lon]; });
              add(p, p.length > 2 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]);
            } else if (el.type === "relation" && el.members) {
              el.members.forEach(function (m) { if (m.geometry) add(m.geometry.map(function (g) { return [g.lat, g.lon]; }), false); });
            }
          });
        }).catch(function () { /* offline / rate-limited — leave as-is */ });
    }
    grp.on("add", function () { active = true; map.attributionControl.addAttribution(OSM_PA_ATTR); load(); });
    grp.on("remove", function () { active = false; map.attributionControl.removeAttribution(OSM_PA_ATTR); });
    map.on("moveend", function () { if (active) load(); });
    return grp;
  }

  // Minimum all-time species for a hotspot to be shown ("real hotspots" filter).
  function hotspotMin() { return +window.GeoState.get("hotspotMin", 200) || 0; }
  // eBird birding hotspots near the view, as clickable markers (name + all-time
  // species count + last-seen). Uses the user's eBird key; refreshes on pan.
  // Filtered by all-time species count; richer hotspots get larger markers.
  function ebirdHotspotLayer() {
    var grp = L.layerGroup(), active = false, tok = 0;
    function load() {
      var key = ebirdKey();
      if (!key) { grp.clearLayers(); setStatus(t("layer.hotspotsKey")); return; }
      if (map.getZoom() < 6.5) { grp.clearLayers(); setStatus(t("layer.hotspotsZoom")); return; }
      var c = map.getCenter(), b = map.getBounds();
      // eBird caps dist at 500 km; cover the viewport (centre→corner) up to that.
      var radius = Math.max(2, Math.min(500, Math.round(haversineKm(c.lat, c.lng, b.getNorth(), b.getEast()))));
      var url = "https://api.ebird.org/v2/ref/hotspot/geo?lat=" + c.lat.toFixed(4) + "&lng=" + c.lng.toFixed(4) + "&dist=" + radius + "&fmt=json";
      var mine = ++tok, minSp = hotspotMin();
      fetch(url, { headers: { "X-eBirdApiToken": key } })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (rows) {
        if (mine !== tok || !active) return;
        grp.clearLayers();
        (rows || []).forEach(function (h) {
          if (h.lat == null || h.lng == null) return;
          var n = h.numSpeciesAllTime || 0;
          if (minSp && n < minSp) return;   // skip trivial hotspots
          var m = L.circleMarker([h.lat, h.lng], { radius: 4 + Math.min(7, Math.round(n / 40)), color: "#8a4b12", weight: 1.5, fillColor: "#f0992e", fillOpacity: 0.85 });
          var sp = h.numSpeciesAllTime != null ? " · " + n + " " + t("layer.species") : "";
          var last = h.latestObsDt ? " · " + String(h.latestObsDt).slice(0, 10) : "";
          m.bindTooltip("<b>" + escapeHtml(h.locName || "") + "</b><span class='area-tip-sub'>" + escapeHtml(sp + last) + "</span>", { direction: "top", className: "area-tip" });
          m.on("click", function () { openExternal("https://ebird.org/hotspot/" + h.locId); });
          grp.addLayer(m);
        });
        if (!grp.getLayers().length) setStatus(t("layer.hotspotsNone"));
      }).catch(function (e) { if (active) setStatus(t("status.error", { msg: "eBird hotspots " + e.message })); });
    }
    grp._reload = function () { if (active) load(); };
    grp.on("add", function () { active = true; map.attributionControl.addAttribution(EBIRD_HS_ATTR); load(); });
    grp.on("remove", function () { active = false; map.attributionControl.removeAttribution(EBIRD_HS_ATTR); });
    map.on("moveend", function () { if (active) load(); });
    return grp;
  }

  // ---- "Show in map": plotted detections (per species, coloured + legend) ---
  // From the Recent-detections list, plot a species' located observations as
  // coloured points; repeatable for many species. Points click through to the
  // source record. Persisted so they survive a reload; a legend lists/removes
  // each species.
  var DET_COLORS = ["#e6194B", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#469990", "#9A6324", "#800000", "#808000", "#000075", "#a9a9a9", "#fabed4", "#bfef45"];
  var detPlot = {};     // speciesKey -> { key, name (fallback), color, rows, group }
  var detLegend = null;
  // Legend-driven visibility: when empty, every species is drawn muted (grey).
  // Click a legend row to "select" it — selected species draw in their colour
  // and the unselected ones are hidden entirely.
  var detSelected = {};
  var mapClickGuardUntil = 0;   // onMapClick ignores clicks before this time; each accepted click re-arms it (200 ms debounce), legend re-renders set a longer window
  function detSelectionActive() { return Object.keys(detSelected).some(function (k) { return detPlot[k]; }); }
  function detIsVisible(key) { return !detSelectionActive() || !!detSelected[key]; }
  function detIsMuted(key) { return !detSelectionActive(); }   // no selection → all grey
  var DET_MUTE_COLOR = "#9aa3a0";
  function detSlim(rows) {
    return (rows || []).filter(function (r) { return r.lat != null && r.lon != null; })
      .map(function (r) { return { lat: +r.lat, lon: +r.lon, url: r.url || "", date: r.date || "", src: r.src || "", place: r.place || "" }; });
  }
  // Localized display name for a plotted species (re-derived from the key so it
  // follows the UI language); falls back to the name stored at plot time.
  function detName(e) { var lbl = labelsByKey[e.key]; return (lbl && speciesName(lbl)) || e.name || e.key; }
  // Recency filter (days) for plotted detections. 0 = no filter.
  function detRecencyDays() { return +window.GeoState.get("detRecencyDays", 30); }
  function recentEnough(dateStr, maxDays) {
    if (!maxDays) return true;            // 0/"All" = no filter
    if (!dateStr) return false;           // unknown date → exclude when filtering
    var t = Date.parse(dateStr); if (isNaN(t)) return false;
    return (Date.now() - t) / 86400000 <= maxDays;
  }
  function detTooltipHtml(name, r) {
    return "<b>" + escapeHtml(name) + "</b><span class='area-tip-sub'>" + escapeHtml([r.src, r.date, r.place].filter(Boolean).join(" · ")) + "</span>";
  }
  function renderDetGroup(name, rows, color, muted) {
    var g = L.layerGroup(), maxDays = detRecencyDays(), visible = 0;
    var fill = muted ? DET_MUTE_COLOR : color;
    var fillOp = muted ? 0.35 : 0.9, strokeOp = muted ? 0.4 : 0.9;
    rows.forEach(function (r) {
      if (!recentEnough(r.date, maxDays)) return;
      visible++;
      var m = L.circleMarker([r.lat, r.lon], { radius: 5, color: "#1a1a1a", weight: 1, opacity: strokeOp, fillColor: fill, fillOpacity: fillOp, bubblingMouseEvents: false });
      m.bindTooltip(detTooltipHtml(name, r), { direction: "top", className: "area-tip" });
      // Metadata for the fan-out so it can reconstruct clones in place. Keep
      // the true species colour too, so fanned clones are distinguishable even
      // when the map is in the muted/grey (no-selection) state.
      m._detRow = r; m._detName = name; m._detColor = fill; m._detTrueColor = color;
      // Click a lone dot → open its observation source. Click a dot that hides
      // others underneath → fan the cluster out (sticky) so each can be reached.
      m.on("click", function (e) {
        if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
        var overlaps = findOverlapsAt(m.getLatLng(), 10);
        if (overlaps.length >= 2) { clearSpider(); spiderOut(m.getLatLng(), overlaps); return; }
        if (r.url) openExternal(r.url);
      });
      g.addLayer(m);
    });
    g._visibleCount = visible;
    return g;
  }
  // Union two slim-row arrays, de-duping by position+date+source so re-pinning
  // the same observations is idempotent (no piling-up of identical dots).
  function mergeDetRows(a, b) {
    var seen = Object.create(null), out = [];
    (a || []).concat(b || []).forEach(function (r) {
      if (!r) return;
      var id = r.lat + "," + r.lon + "|" + (r.date || "") + "|" + (r.url || "") + "|" + (r.src || "");
      if (seen[id]) return; seen[id] = 1; out.push(r);
    });
    return out;
  }
  function plotDetections(key, name, rows, fit, defer) {
    var slim = detSlim(rows);
    if (!slim.length) { if (!defer) setStatus(t("det.none")); return; }
    var prev = detPlot[key];
    var color = (prev && prev.color) || DET_COLORS[Object.keys(detPlot).length % DET_COLORS.length];
    // Accumulate: re-pinning a species ADDS its new observations to whatever is
    // already on the map (deduped) instead of replacing them — so pinning at
    // several places/searches builds up the full set of dots. No cap.
    var merged = prev ? mergeDetRows(prev.rows, slim) : slim;
    if (prev && prev.group) map.removeLayer(prev.group);
    var e = { key: key, name: (name || (prev && prev.name)), color: color, rows: merged, group: null };
    detPlot[key] = e;
    if (detIsVisible(key)) { e.group = renderDetGroup(detName(e), merged, color, detIsMuted(key)); e.group.addTo(map); }
    if (!defer) { updateDetLegend(); saveDetections(); }   // batch when plotting many at once
    if (fit && e.group) { try { map.fitBounds(e.group.getBounds().pad(0.25)); } catch (err) { /* single point / bad bounds */ } }
  }
  // Rebuild every detection layer from the current selection state (called when
  // a legend row is toggled). Hidden species get no layer; visible ones are
  // muted (grey) when nothing is selected, coloured when selected.
  function rebuildDetLayers() {
    clearSpider();
    Object.keys(detPlot).forEach(function (k) {
      var e = detPlot[k];
      if (e.group) { map.removeLayer(e.group); e.group = null; }
      if (!detIsVisible(k)) return;
      e.group = renderDetGroup(detName(e), e.rows, e.color, detIsMuted(k));
      e.group.addTo(map);
    });
  }
  // Plot every species' nearby observations from the cached all-species fetch
  // (GBIF + iNaturalist + eBird) on the map, one coloured layer per species.
  // Capped at 40 species (by count) to keep the legend and CPU sane.
  function plotAllSightings() {
    if (!currentSpView || currentSpView.mode !== "point") { setStatus(t("det.none")); return; }
    setStatus(t("sp.plotting"));
    fetchAllSightingsAt(currentSpView.lat, currentSpView.lon).then(function (result) {
      // Respect the active species-group filter so e.g. "Birds" mode doesn't
      // plot insects / reptiles / plants picked up from GBIF / iNaturalist.
      var grp = speciesGroup;
      function modelKeyInGroup(key) { return grp === "all" || ((taxByCode[key] || {}).class_name || "").toLowerCase() === grp; }
      function extraInGroup(cls) { return grp === "all" || (cls && String(cls).toLowerCase() === grp); }
      var entries = [];
      Object.keys(result.agg).forEach(function (key) {
        var a = result.agg[key];
        if (a.rows && a.rows.length && modelKeyInGroup(key)) entries.push({ key: key, name: (labelsByKey[key] && speciesName(labelsByKey[key])) || key, rows: a.rows, count: a.count });
      });
      Object.keys(result.extras).forEach(function (k) {
        var ex = result.extras[k];
        if (ex.rows && ex.rows.length && extraInGroup(ex.cls)) entries.push({ key: "x:" + k, name: ex.name || ex.sci, rows: ex.rows, count: ex.count });
      });
      if (!entries.length) { setStatus(t("det.none")); return; }
      entries.sort(function (a, b) { return b.count - a.count; });
      var CAP = 40, capped = entries.length > CAP;
      // Fresh plot: drop any previously-plotted layers (incl. ones restored from
      // localStorage or from an earlier, unfiltered plot) so the result reflects
      // only the current group filter.
      clearDetections();
      entries.slice(0, CAP).forEach(function (e) { plotDetections(e.key, e.name, e.rows, false, true); });
      updateDetLegend(); saveDetections();   // one batch update after the loop
      var bounds = L.latLngBounds([]);
      Object.keys(detPlot).forEach(function (k) { var g = detPlot[k] && detPlot[k].group; if (g) { try { bounds.extend(g.getBounds()); } catch (e2) {} } });
      if (bounds.isValid()) { try { map.fitBounds(bounds.pad(0.2)); } catch (e3) {} }
      // Surface the map so the user sees the plotted points.
      document.getElementById("species-panel").style.display = "none";
      if (map) map.invalidateSize();
      setStatus(capped ? t("sp.plottedCapped", { n: CAP }) : t("sp.plotted", { n: entries.slice(0, CAP).length }));
    }).catch(function () { setStatus(t("det.none")); });
  }
  // Plot every per-entry GPS fix from the open field checklist on the map,
  // grouped by species — reuses the detPlot legend / recency filter / spider,
  // so it shows up exactly like an imported recent-detections layer.
  function plotChecklistOnMap() {
    var rec = curFieldRecord(false);
    if (!rec || !rec.log || !rec.log.length) { setStatus(t("review.empty")); return; }
    var bySpecies = {};
    rec.log.forEach(function (e) {
      if (e.lat == null || e.lon == null) return;
      var parts = [];
      if (e.count != null && e.count !== "") parts.push("×" + e.count);
      if (e.sex) parts.push(sexGlyph(e.sex));
      var al = actLabel(e.act); if (al) parts.push(al);
      if (e.note) parts.push("“" + e.note + "”");
      parts.push(fmtClock(e.ts));
      (bySpecies[e.key] || (bySpecies[e.key] = [])).push({
        lat: +e.lat, lon: +e.lon,
        date: e.ts ? new Date(e.ts).toISOString().slice(0, 10) : "",
        src: t("btn.checklist").replace(/^[^\wÀ-ɏ]+\s*/, ""),
        place: parts.join(" · "),
        url: ""
      });
    });
    var keys = Object.keys(bySpecies);
    if (!keys.length) { setStatus(t("det.none")); return; }
    keys.forEach(function (k) {
      var nm = (labelsByKey[k] && speciesName(labelsByKey[k])) || k;
      plotDetections(k, nm, bySpecies[k], false);
    });
    // Fit to the union of all plotted points.
    var bounds = L.latLngBounds([]);
    keys.forEach(function (k) {
      if (detPlot[k] && detPlot[k].group) {
        try { bounds.extend(detPlot[k].group.getBounds()); } catch (err) { /* empty */ }
      }
    });
    if (bounds.isValid()) try { map.fitBounds(bounds.pad(0.25)); } catch (e) { /* single point */ }
    // Surface the map: close the full-screen field page so the user can see it.
    stopFieldGeoWatch();
    document.getElementById("field-page").style.display = "none";
    navClose("page");
    if (map) map.invalidateSize();
  }
  function removeDetection(key) { if (detPlot[key]) { clearSpider(); if (detPlot[key].group) map.removeLayer(detPlot[key].group); delete detPlot[key]; delete detSelected[key]; updateDetLegend(); saveDetections(); } }
  function clearDetections() { clearSpider(); Object.keys(detPlot).forEach(function (k) { if (detPlot[k].group) map.removeLayer(detPlot[k].group); }); detPlot = {}; detSelected = {}; updateDetLegend(); saveDetections(); }
  // Re-render plotted points + legend in the current language (called on lang change).
  function refreshDetections() {
    rebuildDetLayers();
    updateDetLegend();
  }
  function saveDetections() {
    var out = {}; Object.keys(detPlot).forEach(function (k) { var e = detPlot[k]; out[k] = { key: e.key, name: e.name, color: e.color, rows: e.rows }; });
    window.GeoState.save({ mapDetections: out });
  }
  function loadDetections() {
    var saved = window.GeoState.get("mapDetections", {}) || {};
    Object.keys(saved).forEach(function (sk) {
      var d = saved[sk]; if (!d || !d.rows || !d.rows.length) return;
      var key = d.key || sk;   // older builds keyed by display name and had no .key
      var e = { key: key, name: d.name || sk, color: d.color, rows: d.rows, group: null };
      detPlot[key] = e;
      e.group = renderDetGroup(detName(e), d.rows, d.color, detIsMuted(key)); e.group.addTo(map);
    });
    updateDetLegend();
  }
  // Collapsed/expanded state for the detection legend. Session-only — the
  // legend is re-created each time detections come back, so there's nothing
  // worth persisting.
  var detLegendMini = false;
  function updateDetLegend() {
    var keys = Object.keys(detPlot);
    if (!keys.length) { if (detLegend) { map.removeControl(detLegend); detLegend = null; } return; }
    if (!detLegend) {
      detLegend = L.control({ position: "bottomleft" });
      detLegend.onAdd = function () { var d = L.DomUtil.create("div", "det-legend"); d.id = "det-legend"; L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d); return d; };
      detLegend.addTo(map);
    }
    var el = document.getElementById("det-legend");
    el.classList.toggle("det-legend-mini", detLegendMini);
    // Collapsed: a single pill in the corner showing the species count.
    if (detLegendMini) {
      el.innerHTML = '<button type="button" class="det-restore" title="' + escapeHtml(t("det.expand")) + '">📍 ' + keys.length + "</button>";
      el.querySelector(".det-restore").addEventListener("click", function () { mapClickGuardUntil = Date.now() + 250; detLegendMini = false; updateDetLegend(); });
      return;
    }
    var rDays = detRecencyDays();
    var recOpts = [[1, "1"], [7, "7"], [14, "14"], [30, "30"], [0, ""]]
      .map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === rDays ? " selected" : "") + ">" + (o[0] ? o[1] + " " + escapeHtml(t("det.days")) : escapeHtml(t("det.allTime"))) + "</option>"; })
      .join("");
    el.innerHTML = '<div class="det-legend-head">' +
        '<button type="button" class="det-min" title="' + escapeHtml(t("det.minimise")) + '" aria-label="' + escapeHtml(t("det.minimise")) + '">−</button>' +
        '<button type="button" class="det-clear">' + escapeHtml(t("det.clearAll")) + "</button>" +
        '<select id="det-recency" title="' + escapeHtml(t("det.recency")) + '">' + recOpts + "</select>" +
      "</div>" +
      keys.map(function (k) {
        var e = detPlot[k], nm = escapeHtml(detName(e));
        var vis = (e.group && e.group._visibleCount != null) ? e.group._visibleCount : e.rows.length;
        var ct = (vis === e.rows.length) ? String(vis) : (vis + "/" + e.rows.length);
        // When a selection is active, non-selected rows show a grey swatch and
        // dimmed text so it's clear they're hidden on the map.
        var selActive = detSelectionActive(), sel = !!detSelected[k];
        var rowCls = "det-row det-row-click" + (selActive && !sel ? " det-row-off" : "") + (sel ? " det-row-on" : "");
        var sw = (selActive && !sel) ? DET_MUTE_COLOR : e.color;
        return '<div class="' + rowCls + '" data-key="' + escapeHtml(k) + '"><span class="det-sw" style="background:' + sw + '"></span><span class="det-nm" title="' + nm + '">' + interestingStar(e.key) + nm + '</span><span class="det-ct">' + ct + '</span><button type="button" class="det-del" data-key="' + escapeHtml(k) + '" aria-label="remove">×</button></div>';
      }).join("");
    el.querySelector(".det-clear").addEventListener("click", clearDetections);
    el.querySelector(".det-min").addEventListener("click", function () { mapClickGuardUntil = Date.now() + 250; detLegendMini = true; updateDetLegend(); });
    el.querySelectorAll(".det-del").forEach(function (b) { b.addEventListener("click", function (e) { e.stopPropagation(); removeDetection(this.getAttribute("data-key")); }); });
    // Click a row to toggle its visibility selection. Stop the click here so it
    // can't leak to the map and pop the point-options popup at the legend's spot.
    el.querySelectorAll(".det-row-click").forEach(function (row) {
      row.addEventListener("click", function (e) {
        e.stopPropagation();
        mapClickGuardUntil = Date.now() + 250;
        var k = this.getAttribute("data-key");
        if (detSelected[k]) delete detSelected[k]; else detSelected[k] = true;
        rebuildDetLayers();
        updateDetLegend();
      });
    });
    el.querySelector("#det-recency").addEventListener("change", function () {
      window.GeoState.save({ detRecencyDays: +this.value });
      rebuildDetLayers();   // re-render with the new recency filter (no refetch)
      updateDetLegend();
    });
  }

  // ---- Map points (user-added pins + named lists) ---------------------------
  // Storage: GeoState.mapPoints = [{ id, lat, lon, name, tags[], note, source, createdAt }]
  // Filter:  GeoState.mapPointsFilter = [tag, ...]; "" means the "(no tag)" chip.
  // Markers live in mpLayer (a single Leaflet layerGroup) so we can rebuild
  // cheaply on edit/filter changes without touching the rest of the map.
  var mapPoints = [];
  var mpFilter = [];
  var mpShown = true;   // master visibility toggle — hides all markers but keeps the data
  var mpLayer = null;
  // Named collections — saveable/retrievable point lists (e.g. "Owl nests",
  // "Spring trip"). mpActiveName is the loaded list; edits to the working set
  // auto-sync into it. Shape: GeoState.mapPointSets = [{ name, points[] }].
  var mpCollections = [];
  var mpActiveName = "";

  var MP_COLORS = ["#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd","#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf"];
  function mpHashColor(tag) {
    if (!tag) return "#888";
    var h = 0; for (var i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
    return MP_COLORS[Math.abs(h) % MP_COLORS.length];
  }
  function mpColorFor(p) { return mpHashColor((p.tags && p.tags[0]) || ""); }
  // Comma-separated free-form tag input → clean, deduped lowercase-trimmed array.
  function mpParseTags(s) {
    return String(s || "").split(",").map(function (t) { return t.trim(); }).filter(function (t, i, a) { return t && a.indexOf(t) === i; });
  }
  function mpUid() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function loadMapPoints() {
    mapPoints = (window.GeoState.get("mapPoints", []) || []).filter(function (p) { return p && isFinite(p.lat) && isFinite(p.lon); });
    mpFilter = window.GeoState.get("mapPointsFilter", []) || [];
    mpShown = window.GeoState.get("mapPointsShown", true) !== false;
    mpCollections = (window.GeoState.get("mapPointSets", []) || []).filter(function (c) { return c && c.name; });
    mpActiveName = window.GeoState.get("mapPointSetActive", "") || "";
  }
  function saveMapPoints() {
    // Keep the loaded collection in lock-step with the working set so a list
    // stays current as the user adds/edits/removes pins after loading it.
    if (mpActiveName) {
      var c = mpCollections.filter(function (x) { return x.name === mpActiveName; })[0];
      if (c) c.points = mapPoints.slice();
    }
    window.GeoState.save({ mapPoints: mapPoints, mapPointsFilter: mpFilter, mapPointsShown: mpShown, mapPointSets: mpCollections, mapPointSetActive: mpActiveName });
  }
  // Snapshot the current pins under a name (overwrites a list of the same name).
  function saveCollection(name) {
    name = String(name || "").trim(); if (!name) return;
    var c = mpCollections.filter(function (x) { return x.name === name; })[0];
    if (c) c.points = mapPoints.slice();
    else mpCollections.push({ name: name, points: mapPoints.slice() });
    mpActiveName = name;
    saveMapPoints(); renderMapPoints();
  }
  // Replace the working set with a named list and make it the active list.
  function loadCollection(name) {
    var c = mpCollections.filter(function (x) { return x.name === name; })[0]; if (!c) return;
    mapPoints = (c.points || []).map(function (p) { return Object.assign({}, p); });
    mpActiveName = name; mpFilter = [];
    saveMapPoints(); renderMapPoints();
    var pts = mapPoints.filter(function (p) { return isFinite(p.lat) && isFinite(p.lon); });
    if (pts.length && map) { try { map.fitBounds(L.latLngBounds(pts.map(function (p) { return [p.lat, p.lon]; })).pad(0.2)); } catch (e) {} }
  }
  // Forget a named list. The pins currently on the map are left untouched.
  function deleteCollection(name) {
    mpCollections = mpCollections.filter(function (x) { return x.name !== name; });
    if (mpActiveName === name) mpActiveName = "";
    saveMapPoints(); renderMapPoints();
  }
  // "Unsaved" = pins on the map that aren't captured by any named list. Happens
  // when no list is active (a loaded list auto-syncs, so it's always saved).
  function mpHasUnsaved() { return !mpActiveName && mapPoints.length > 0; }
  // Export every pin to plain, interoperable KML (opens in Google Earth etc.):
  // named lists become <Folder>s, loose pins sit at the document root. Just
  // name / description / Point — no app-specific extensions.
  function buildPointsKml() {
    var xml = function (s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
    var loose = mpActiveName ? [] : mapPoints;
    var parts = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2">', "<Document>", "<name>Map points</name>"];
    var placemark = function (p) {
      var desc = String(p.note || "");
      var tags = (p.tags || []).join(", ");
      if (tags) desc += (desc ? "\n" : "") + "Tags: " + tags;
      parts.push("<Placemark>");
      parts.push("<name>" + xml(p.name || "Point") + "</name>");
      if (desc) parts.push("<description>" + xml(desc) + "</description>");
      parts.push("<Point><coordinates>" + Number(p.lon).toFixed(6) + "," + Number(p.lat).toFixed(6) + ",0</coordinates></Point>");
      parts.push("</Placemark>");
    };
    mpCollections.forEach(function (c) {
      parts.push("<Folder><name>" + xml(c.name) + "</name>");
      (c.points || []).forEach(placemark);
      parts.push("</Folder>");
    });
    loose.forEach(placemark);
    parts.push("</Document>", "</kml>");
    return parts.join("\n");
  }
  function exportPointsKml() {
    var hasAny = (mpActiveName ? 0 : mapPoints.length) + mpCollections.reduce(function (n, c) { return n + ((c.points && c.points.length) || 0); }, 0);
    if (!hasAny) { setStatus(t("points.exportEmpty")); return; }
    downloadCsv("map_points_" + new Date().toISOString().slice(0, 10) + ".kml", buildPointsKml());
  }
  function addMapPoint(p) {
    p.id = p.id || mpUid();
    p.createdAt = p.createdAt || new Date().toISOString();
    mapPoints.push(p);
    saveMapPoints();
    renderMapPoints();
  }
  function updateMapPoint(id, patch) {
    var p = mapPoints.filter(function (x) { return x.id === id; })[0]; if (!p) return;
    Object.assign(p, patch);
    saveMapPoints();
    renderMapPoints();
  }
  function deleteMapPoint(id) {
    mapPoints = mapPoints.filter(function (x) { return x.id !== id; });
    saveMapPoints();
    renderMapPoints();
  }
  function clearMapPoints() {
    // Detach first so we don't sync the now-empty working set onto the saved
    // list — the named list survives "Delete"; only the live pins are cleared.
    mpActiveName = ""; mapPoints = []; mpFilter = []; saveMapPoints(); renderMapPoints();
  }
  // Distinct tag pool across all stored points, alphabetically sorted.
  function mpAllTags() {
    var s = {};
    mapPoints.forEach(function (p) { (p.tags || []).forEach(function (t) { if (t) s[t] = true; }); });
    return Object.keys(s).sort();
  }
  // OR-filter: when no tags active, show everything; otherwise show points
  // whose tag list intersects mpFilter. "(no tag)" is represented by "".
  function mpVisible(p) {
    if (!mpFilter.length) return true;
    var tags = p.tags || [];
    if (!tags.length) return mpFilter.indexOf("") >= 0;
    for (var i = 0; i < tags.length; i++) if (mpFilter.indexOf(tags[i]) >= 0) return true;
    return false;
  }

  function ensureMpLayer() { if (!mpLayer) { mpLayer = L.layerGroup(); if (map) mpLayer.addTo(map); } return mpLayer; }
  // Rebuild every marker. Cheap enough for hundreds; if it ever becomes slow we
  // can switch to a per-point patch model.
  function renderMapPoints() {
    if (!map) return;
    ensureMpLayer().clearLayers();
    // Master toggle off → keep the data and the panel, but draw nothing.
    if (!mpShown) { refreshMpPanel(); updateMpBadge(); return; }
    mapPoints.forEach(function (p) {
      if (!mpVisible(p)) return;
      var m = L.circleMarker([p.lat, p.lon], {
        radius: 7, color: "#111", weight: 1, opacity: 0.9,
        fillColor: mpColorFor(p), fillOpacity: 0.9
      });
      m.bindTooltip(mpTipHtml(p), { direction: "top", className: "area-tip" });
      // Stop propagation so clicks on the marker don't open the species-list
      // popup behind it.
      m.on("click", function (e) {
        if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
        openPointEditor(p);
      });
      mpLayer.addLayer(m);
    });
    refreshMpPanel();
    updateMpBadge();
  }
  function mpTipHtml(p) {
    var name = escapeHtml(p.name || "(point)");
    var tags = (p.tags && p.tags.length) ? '<span class="area-tip-sub">' + escapeHtml(p.tags.join(" · ")) + "</span>" : "";
    return "<b>" + name + "</b>" + tags;
  }
  function updateMpBadge() {
    var el = document.getElementById("mp-btn-text"); if (el) el.textContent = mapPoints.length ? String(mapPoints.length) : "";
    var wrap = document.getElementById("mp-wrap"); if (wrap) wrap.classList.toggle("mp-off", !mpShown);
  }

  // ---- Add / edit popup ----
  // "edit" mode is determined by the presence of an id on the passed object,
  // NOT just by it being non-null — a fresh add still passes {lat,lon,...} so
  // truthiness would mis-detect it as an edit and silently no-op the save.
  function openPointEditor(existing) {
    var p = existing || { lat: null, lon: null, name: "", tags: [], note: "" };
    var isEdit = !!(existing && existing.id);
    // Re-use a single working popup; close any other detail popups first.
    if (mpEditPopup) map.closePopup(mpEditPopup);
    var html = mpEditorHtml(p, isEdit);
    var pop = L.popup({ closeButton: true, autoClose: false, maxWidth: 280, className: "mp-popup" })
      .setLatLng([p.lat, p.lon]).setContent(html);
    mpEditPopup = pop; pop.openOn(map);
    setTimeout(function () { wireEditorPopup(p, isEdit); }, 0);
  }
  var mpEditPopup = null;
  function mpEditorHtml(p, isEdit) {
    var esc = escapeHtml;
    // New points get a "Save to list" picker; the choice (the active list) is
    // remembered, so subsequent points drop straight into the same list.
    var listSel = isEdit ? "" :
      '<label>' + esc(t("points.saveToList")) +
        '<select id="mp-listsel">' +
          '<option value=""' + (mpActiveName ? "" : " selected") + ">" + esc(t("points.listNone")) + "</option>" +
          mpCollections.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (c) {
            return '<option value="' + esc(c.name) + '"' + (c.name === mpActiveName ? " selected" : "") + ">" + esc(c.name) + "</option>";
          }).join("") +
          '<option value="__new__">' + esc(t("points.listNew")) + "</option>" +
        "</select>" +
      "</label>";
    return '<div class="mp-form">' +
      '<label>' + esc(t("points.name")) + '<input type="text" id="mp-name" value="' + esc(p.name || "") + '" /></label>' +
      '<label>' + esc(t("points.tags")) + '<input type="text" id="mp-tags" value="' + esc((p.tags || []).join(", ")) + '" placeholder="' + esc(t("points.tagsPh")) + '" /></label>' +
      '<label>' + esc(t("points.note")) + '<textarea id="mp-note" rows="2">' + esc(p.note || "") + '</textarea></label>' +
      listSel +
      '<div class="mp-meta">' + p.lat.toFixed(5) + ", " + p.lon.toFixed(5) + "</div>" +
      '<div id="mp-natlist" class="mp-natlist" style="display:none"></div>' +
      '<div class="mp-actions">' +
        '<button type="button" id="mp-save" class="demo-btn">' + esc(t("points.save")) + '</button>' +
        (isEdit ? '<button type="button" id="mp-del" class="demo-btn demo-btn-light">' + esc(t("btn.delete")) + '</button>' : "") +
      '</div>' +
    '</div>';
  }
  // Make `name` the list new points are saved to (the active list), without
  // moving the map. "" = unsaved/loose. Resolves false if the user cancels.
  function activateTargetList(name) {
    return new Promise(function (resolve) {
      if (name === mpActiveName) { resolve(true); return; }
      var doSwitch = function () {
        if (!name) { mpActiveName = ""; }
        else {
          var ex = mpCollections.filter(function (x) { return x.name === name; })[0];
          mapPoints = ex ? (ex.points || []).map(function (q) { return Object.assign({}, q); }) : [];
          if (!ex) mpCollections.push({ name: name, points: [] });
          mpActiveName = name; mpFilter = [];
        }
        saveMapPoints(); renderMapPoints(); resolve(true);
      };
      if (mpHasUnsaved()) modalConfirm(t("points.discardUnsavedPrompt")).then(function (ok) { if (ok) doSwitch(); else resolve(false); });
      else doSwitch();
    });
  }
  function resolveTargetList(target) {   // handles the "+ New list…" option
    if (target !== "__new__") return activateTargetList(target);
    return modalPrompt(t("points.saveAsPrompt"), "").then(function (n) {
      n = (n || "").trim();
      return n ? activateTargetList(n) : false;
    });
  }
  function wireEditorPopup(p, isEdit) {
    var save = document.getElementById("mp-save"); if (!save) return;
    save.addEventListener("click", function () {
      var name = (document.getElementById("mp-name").value || "").trim();
      var tags = mpParseTags(document.getElementById("mp-tags").value);
      var note = (document.getElementById("mp-note").value || "").trim();
      if (isEdit) { updateMapPoint(p.id, { name: name, tags: tags, note: note }); map.closePopup(); return; }
      var sel = document.getElementById("mp-listsel");
      Promise.resolve(sel ? resolveTargetList(sel.value) : true).then(function (ok) {
        if (ok === false) return;   // cancelled list choice — keep the editor open
        addMapPoint({ lat: p.lat, lon: p.lon, name: name, tags: tags, note: note, source: "manual" });
        map.closePopup();
      });
    });
    var del = document.getElementById("mp-del");
    if (del) del.addEventListener("click", function () { deleteMapPoint(p.id); map.closePopup(); });
    // Country links (built-in national service + the user's custom links).
    // Hidden until the reverse-geocode resolves.
    countryCode(p.lat, p.lon).then(function (cc) {
      var slot = document.getElementById("mp-natlist"); if (!slot) return;
      var svcs = natServicesFor(cc);
      if (!svcs.length) return;
      slot.style.display = "";
      slot.innerHTML = svcs.map(function (s) {
        return '<a href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener">' + escapeHtml(s.label) + " ↗</a>";
      }).join("");
    }).catch(function () { /* leave hidden */ });
  }
  // Right-click on desktop, long-press on touch — Leaflet fires both as "contextmenu".
  function onMapContextMenu(e) {
    // A long-press fires contextmenu then often a trailing click — re-arm the
    // debounce so that click doesn't also open the point-options popup.
    mapClickGuardUntil = Date.now() + 200;
    var lat = Math.max(-90, Math.min(90, e.latlng.lat));
    var lon = wrapLon(e.latlng.lng);
    openPointEditor({ lat: lat, lon: lon, name: "", tags: [], note: "" });
  }

  // ---- Points dropdown panel ----
  function refreshMpPanel() {
    var panel = document.getElementById("mp-panel"); if (!panel) return;
    var allTags = mpAllTags();
    var hasUntagged = mapPoints.some(function (p) { return !p.tags || !p.tags.length; });
    var center = map && map.getCenter();
    var rows = mapPoints.slice().sort(function (a, b) {
      if (!center) return 0;
      return haversineKm(center.lat, center.lng, a.lat, a.lon) - haversineKm(center.lat, center.lng, b.lat, b.lon);
    });
    var chipsHtml = allTags.map(function (tag) {
      var active = mpFilter.indexOf(tag) >= 0;
      return '<button type="button" class="mp-chip' + (active ? " is-active" : "") + '" data-tag="' + escapeHtml(tag) + '" style="--mp-c:' + mpHashColor(tag) + '">' + escapeHtml(tag) + "</button>";
    }).join("");
    if (hasUntagged) {
      var actNoTag = mpFilter.indexOf("") >= 0;
      chipsHtml += '<button type="button" class="mp-chip' + (actNoTag ? " is-active" : "") + '" data-tag="">' + escapeHtml(t("points.notag")) + "</button>";
    }
    var listHtml = rows.length ? rows.map(function (p) {
      var dist = center ? haversineKm(center.lat, center.lng, p.lat, p.lon) : null;
      var dt = dist == null ? "" : (dist < 1 ? Math.round(dist * 1000) + " m" : dist.toFixed(1) + " km");
      var tagText = (p.tags || []).slice(0, 3).map(function (x) { return '<span class="mp-row-tag" style="--mp-c:' + mpHashColor(x) + '">' + escapeHtml(x) + "</span>"; }).join("");
      return '<div class="dd-row mp-row" data-id="' + escapeHtml(p.id) + '">' +
        '<button type="button" class="dd-name mp-fly" data-id="' + escapeHtml(p.id) + '"><span class="mp-sw" style="background:' + mpColorFor(p) + '"></span>' + escapeHtml(p.name || "(point)") + '</button>' +
        '<span class="mp-row-meta">' + tagText + '<span class="mp-dist">' + escapeHtml(dt) + "</span></span>" +
        '<button type="button" class="dd-del mp-del" data-id="' + escapeHtml(p.id) + '" aria-label="remove">×</button>' +
      "</div>";
    }).join("") : '<p class="dd-empty">' + escapeHtml(t("points.empty")) + "</p>";
    var collOpts = '<option value="">' + escapeHtml(t("points.collection")) + "</option>" +
      mpCollections.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (c) {
        return '<option value="' + escapeHtml(c.name) + '"' + (c.name === mpActiveName ? " selected" : "") + ">" +
          escapeHtml(c.name) + " (" + ((c.points && c.points.length) || 0) + ")</option>";
      }).join("");
    panel.innerHTML =
      '<div class="mp-head">' +
        '<label class="mp-show-label" title="' + escapeHtml(t("points.showOnMap")) + '">' +
          '<input type="checkbox" id="mp-show"' + (mpShown ? " checked" : "") + '>' +
          escapeHtml(t("points.show")) +
        "</label>" +
        '<button type="button" id="mp-coll-save" class="demo-btn">' + escapeHtml(t("points.save")) + "</button>" +
        '<button type="button" id="mp-clear" class="demo-btn demo-btn-light">' + escapeHtml(t("points.clear")) + "</button>" +
      "</div>" +
      (mpCollections.length ?
        '<div class="mp-coll">' +
          '<select id="mp-coll-select" title="' + escapeHtml(t("points.collection")) + '">' + collOpts + "</select>" +
          '<button type="button" id="mp-coll-del" class="mp-coll-del"' + (mpActiveName ? "" : " disabled") + ' title="' + escapeHtml(t("points.deleteColl")) + '" aria-label="' + escapeHtml(t("points.deleteColl")) + '">×</button>' +
        "</div>" : "") +
      (mpHasUnsaved() ? '<div class="mp-unsaved">' + escapeHtml(t("points.unsaved", { n: mapPoints.length })) + "</div>" : "") +
      (chipsHtml ? '<div class="mp-chips">' + chipsHtml + "</div>" : "") +
      '<div class="mp-list">' + listHtml + "</div>";
    // Wire interactions
    panel.querySelectorAll(".mp-chip").forEach(function (b) {
      b.addEventListener("click", function () {
        var tag = this.getAttribute("data-tag");
        var i = mpFilter.indexOf(tag);
        if (i >= 0) mpFilter.splice(i, 1); else mpFilter.push(tag);
        saveMapPoints();
        renderMapPoints();
      });
    });
    panel.querySelectorAll(".mp-fly").forEach(function (b) {
      b.addEventListener("click", function () {
        var p = mapPoints.filter(function (x) { return x.id === this.getAttribute("data-id"); }.bind(this))[0]; if (!p) return;
        map.setView([p.lat, p.lon], Math.max(map.getZoom() || 0, 11));
        openPointEditor(p);
      });
    });
    panel.querySelectorAll(".mp-del").forEach(function (b) {
      b.addEventListener("click", function () { deleteMapPoint(this.getAttribute("data-id")); });
    });
    var sh = panel.querySelector("#mp-show");
    if (sh) sh.addEventListener("change", function () { mpShown = !!this.checked; saveMapPoints(); renderMapPoints(); });
    var clr = panel.querySelector("#mp-clear");
    if (clr) clr.addEventListener("click", function () {
      if (!mapPoints.length) return;
      var msg = mpHasUnsaved() ? t("points.clearUnsavedPrompt") : t("points.clearAllPrompt");
      modalConfirm(msg).then(function (ok) { if (ok) clearMapPoints(); });
    });
    // Pick a list from the dropdown to load it (warn first if it would discard
    // unsaved pins; revert the selection on cancel).
    var collSel = panel.querySelector("#mp-coll-select");
    if (collSel) collSel.addEventListener("change", function () {
      var name = this.value, selEl = this;
      if (!name || name === mpActiveName) return;
      if (mpHasUnsaved()) {
        modalConfirm(t("points.discardUnsavedPrompt")).then(function (ok) {
          if (ok) loadCollection(name); else selEl.value = mpActiveName || "";
        });
      } else loadCollection(name);
    });
    // The × deletes the selected list (after confirming).
    var collDel = panel.querySelector("#mp-coll-del");
    if (collDel) collDel.addEventListener("click", function () {
      var name = (collSel && collSel.value) || mpActiveName;
      if (!name) return;
      modalConfirm(t("points.deleteCollPrompt", { name: name })).then(function (ok) { if (ok) deleteCollection(name); });
    });
    var collSave = panel.querySelector("#mp-coll-save");
    if (collSave) collSave.addEventListener("click", function () {
      modalPrompt(t("points.saveAsPrompt"), mpActiveName || "").then(function (n) {
        if (!n || !n.trim()) return;
        var name = n.trim();
        var exists = mpCollections.some(function (x) { return x.name === name; });
        if (exists && name !== mpActiveName) {
          modalConfirm(t("points.overwritePrompt", { name: name })).then(function (ok) { if (ok) saveCollection(name); });
        } else saveCollection(name);
      });
    });
  }

  // ---- Sticky fan-out for overlapping detection markers ---------------------
  // Clicking a detection dot that sits over others (same/near coordinates)
  // fans the cluster out around the point on a circle. It STAYS open so each
  // clone can be hovered (tooltip) and clicked (→ its observation source).
  // Dismisses on map-background click, pan, zoom, or Escape.
  var spiderLayer = null, spiderHidden = [];
  function clearSpider() {
    if (!spiderLayer) return;
    spiderHidden.forEach(function (m) { try { m.setStyle({ opacity: 0.9, fillOpacity: 0.9 }); } catch (e) {} });
    spiderHidden = [];
    map.removeLayer(spiderLayer); spiderLayer = null;
  }
  function findOverlapsAt(latlng, pxRadius) {
    pxRadius = pxRadius || 10;
    var center = map.latLngToContainerPoint(latlng), out = [];
    Object.keys(detPlot).forEach(function (k) {
      var entry = detPlot[k];
      if (!entry.group || !map.hasLayer(entry.group)) return;
      entry.group.eachLayer(function (m) {
        if (!m._detRow) return;
        var p = map.latLngToContainerPoint(m.getLatLng());
        if (Math.hypot(p.x - center.x, p.y - center.y) <= pxRadius) out.push(m);
      });
    });
    return out;
  }
  function spiderOut(centerLatLng, overlaps) {
    var centerPt = map.latLngToContainerPoint(centerLatLng);
    var n = overlaps.length, radius = Math.min(70, 24 + n * 4);
    var g = L.layerGroup();
    overlaps.forEach(function (orig, i) {
      var angle = -Math.PI / 2 + (i / n) * 2 * Math.PI;
      var pt = L.point(centerPt.x + Math.cos(angle) * radius, centerPt.y + Math.sin(angle) * radius);
      var ll = map.containerPointToLatLng(pt);
      g.addLayer(L.polyline([centerLatLng, ll], { color: "#666", weight: 1, opacity: 0.55, interactive: false }));
      var clone = L.circleMarker(ll, { radius: 6, color: "#1a1a1a", weight: 1, opacity: 0.95, fillColor: orig._detTrueColor || orig._detColor, fillOpacity: 0.95, bubblingMouseEvents: false });
      var r = orig._detRow;
      // Permanent tooltip on hover; click → the observation's source page.
      clone.bindTooltip(detTooltipHtml(orig._detName, r), { direction: "top", className: "area-tip" });
      clone.on("click", function (ev) {
        if (ev && ev.originalEvent) L.DomEvent.stopPropagation(ev.originalEvent);   // keep the fan open
        if (r.url) openExternal(r.url);
      });
      g.addLayer(clone);
      orig.setStyle({ opacity: 0, fillOpacity: 0 });   // hide the stacked original while fanned
      spiderHidden.push(orig);
    });
    g.addTo(map); spiderLayer = g;
  }

  var arcOverlays = [];   // active-overlay refs for hover identify: {layer, kind, defs}
  var hotspotsLayer = null;
  function setupAreaOverlays() {
    if (!map || !window.L) return;
    var wdpa = new ArcGISExportLayer(WDPA_EXPORT, { opacity: 0.5, attribution: WDPA_ATTR, maxZoom: MAX_ZOOM });
    var ramsar = new ArcGISExportLayer(WDPA_EXPORT, { opacity: 0.6, attribution: WDPA_ATTR, maxZoom: MAX_ZOOM,
      arcLayers: "show:0,1", layerDefs: JSON.stringify({ 0: RAMSAR_DEF, 1: RAMSAR_DEF }) });
    var n2k = new ArcGISExportLayer(N2K_EXPORT, { opacity: 0.5, attribution: EEA_ATTR, maxZoom: MAX_ZOOM });
    arcOverlays = [{ layer: wdpa, kind: "wdpa" },
      { layer: ramsar, kind: "wdpa", defs: ramsar.options.layerDefs },
      { layer: n2k, kind: "natura" }];
    var overlays = {};
    overlays[t("layer.wdpa")] = wdpa;
    overlays[t("layer.ramsar")] = ramsar;
    overlays[t("layer.natura2000")] = n2k;
    hotspotsLayer = ebirdHotspotLayer();
    overlays[t("layer.hotspots")] = hotspotsLayer;
    overlays[t("layer.osmpa")] = osmProtectedLayer();
    L.control.layers(null, overlays, { collapsed: true, position: "topright" }).addTo(map);
    setupAreaHover();
  }

  // Hover over an active raster overlay → ArcGIS "identify" at the cursor → a
  // tooltip with the area's name and designation/category. Debounced; the OSM
  // vector layer already carries its own per-feature tooltips.
  function setupAreaHover() {
    var tip = L.tooltip({ direction: "top", offset: [0, -4], opacity: 0.96, className: "area-tip" });
    var timer = null, tok = 0;
    var hide = function () { if (map.hasLayer(tip)) map.removeLayer(tip); };
    var pick = function (a, keys) { for (var i = 0; i < keys.length; i++) { var v = a[keys[i]]; if (v != null && v !== "" && String(v).toLowerCase() !== "null") return v; } return ""; };
    function label(results) {
      return (results || []).slice(0, 3).map(function (rs) {
        var a = rs.attributes || {};
        var name = pick(a, ["name", "NAME", "sitename", "SITENAME", "orig_name", "ORIG_NAME"]) || rs.layerName || "";
        var bits = [];
        var desig = pick(a, ["desig_eng", "DESIG_ENG"]); if (desig) bits.push(desig);
        var iucn = pick(a, ["iucn_cat", "IUCN_CAT"]); if (iucn && String(iucn).indexOf("Not") < 0) bits.push("IUCN " + iucn);
        var st = pick(a, ["sitetype", "SITETYPE"]); if (st) bits.push(({ A: "SPA · Birds Directive", B: "SCI/SAC · Habitats", C: "SPA + SCI/SAC" })[st] || st);
        var code = pick(a, ["sitecode", "SITECODE"]); if (code) bits.push(code);
        var status = pick(a, ["status", "STATUS"]); if (status) bits.push(status);
        if (!name && !bits.length) return "";
        return "<b>" + escapeHtml(String(name)) + "</b>" + (bits.length ? "<br><span class='area-tip-sub'>" + escapeHtml(bits.join(" · ")) + "</span>" : "");
      }).filter(Boolean).join("<span class='area-tip-sep'></span>");
    }
    function identify(o, latlng) {
      var sz = map.getSize(), b = map.getBounds();
      var sw = L.CRS.EPSG3857.project(b.getSouthWest()), ne = L.CRS.EPSG3857.project(b.getNorthEast());
      var pt = L.CRS.EPSG3857.project(latlng);
      var u = o.layer._base.replace(/\/export$/, "/identify") +
        "?f=json&returnGeometry=false&sr=3857&geometryType=esriGeometryPoint&tolerance=5" +
        "&geometry=" + pt.x + "," + pt.y + "&mapExtent=" + sw.x + "," + sw.y + "," + ne.x + "," + ne.y +
        "&imageDisplay=" + sz.x + "," + sz.y + ",96&layers=all";
      if (o.defs) u += "&layerDefs=" + encodeURIComponent(o.defs);
      return fetch(u).then(function (r) { return r.json(); }).then(function (j) { return j.results || []; });
    }
    map.on("mousemove", function (e) {
      var active = arcOverlays.filter(function (o) { return map.hasLayer(o.layer); });
      if (!active.length) { hide(); return; }
      clearTimeout(timer);
      var ll = e.latlng, my = ++tok;
      timer = setTimeout(function () {
        Promise.all(active.map(function (o) { return identify(o, ll).catch(function () { return []; }); })).then(function (lists) {
          if (my !== tok) return;
          var html = lists.map(label).filter(Boolean).join("<span class='area-tip-sep'></span>");
          if (html) { tip.setLatLng(ll).setContent(html); if (!map.hasLayer(tip)) tip.addTo(map); } else hide();
        });
      }, 280);
    });
    map.on("mouseout movestart zoomstart", hide);
  }

  // ---- Controls ------------------------------------------------------------
  // Show/hide controls and panels appropriate to the active mode.
  function updateModeVisibility() {
    var isRange = currentMode === "range";
    var isMap = currentMode === "range" || currentMode === "richness";
    document.getElementById("species-search-wrap").style.display = isRange ? "" : "none";
    // Species List + Species Range both produce a per-point species list (which
    // uses "Compare to" and the 2nd-name column), so show these in both.
    var listish = currentMode === "list" || currentMode === "range";
    document.getElementById("compare-wrap").style.display = listish ? "" : "none";
    document.getElementById("secondlang-wrap").style.display = listish ? "" : "none";
    // The probability min–max slider (in Settings) applies to the Species List,
    // the checklist (derived from it), the analysis tabs and the field checklist.
    var probVisible = (currentMode === "range" || currentMode === "list" || currentMode === "barchart");
    document.getElementById("barchart-threshold-wrap").style.display = probVisible ? "" : "none";
    // Week applies in every mode (incl. Migration timeline, where it sets the
    // "current week" used by the Probability / Arrivals / Scatter tabs).
    document.getElementById("week-select-wrap").style.display = "";
    // The migration animation now runs from an on-map button (range/richness),
    // so keep the controls-bar play button out of the bar.
    document.getElementById("play-btn-wrap").style.display = "none";
    if (animCtrlEl) animCtrlEl.style.display = isMap ? "" : "none";
    // H3 detail control only affects (and shows with) the range/richness overlay.
    if (h3CtrlEl) { h3CtrlEl.style.display = isMap ? "" : "none"; updateH3DetailButtons(); }
    // In Range the linked species name above the map is the only label we need,
    // so hide the status line (its "(step°) [cached]" detail just took space).
    document.getElementById("demo-status").style.display = isRange ? "none" : "";
    updateRangeSpecies();   // clickable species name + week above the map (range only)
    relocateCsvButton();
    // In Species distribution the bar holds only the search box, so drop the
    // card chrome and sit it tight under the header.
    document.getElementById("demo-controls").classList.toggle("controls-bare", isRange);
    updateControlsBarVisibility();
    fitMapHeight();         // controls/mode changes shift the map's top edge
  }

  // Hide the controls-bar card entirely when nothing in it is visible (e.g.
  // Species List mode, where its controls live in the header) so it doesn't sit
  // as an empty card between the header and the map.
  function updateControlsBarVisibility() {
    var bar = document.getElementById("demo-controls");
    if (!bar) return;
    bar.style.display = "";   // show so children's visibility can be measured
    var anyVisible = Array.prototype.some.call(bar.children, function (ch) { return ch.offsetParent !== null; });
    bar.style.display = anyVisible ? "" : "none";
  }

  // Show the "Last change" timestamp (written into last-change.txt by the
  // pre-commit hook on every commit/push to main).
  function showLastChange() {
    fetch("last-change.txt", { cache: "no-store" }).then(function (r) {
      return r.ok ? r.text() : "";
    }).then(function (txt) {
      lastChangeText = (txt || "").trim();
      if (lastChangeText) renderAboutBody();   // fold it into the About footer
    }).catch(function () { /* offline — leave blank */ });
  }

  // One-time performance note shown over the page on load.
  function showPerfModal() {
    var m = document.getElementById("perf-modal");
    if (m) m.style.display = "flex";
  }
  function hidePerfModal() {
    var m = document.getElementById("perf-modal");
    if (m) m.style.display = "none";
  }

  // In Species List mode the CSV button sits next to the "＋ Checklist" button;
  // in every other mode it lives directly below the map.
  function relocateCsvButton() {
    var wrap = document.getElementById("csv-btn-wrap");
    if (!wrap) return;
    if (currentMode === "list") {
      var sa = document.querySelector("#species-panel .sp-actions");
      if (sa && wrap.parentNode !== sa) sa.appendChild(wrap);
    } else {
      // Below the map (the map-controls bar was removed when its controls
      // moved into Settings).
      var anchor = document.getElementById("demo-map-wrap");
      if (anchor && wrap.previousElementSibling !== anchor) {
        anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
      }
    }
  }

  function bindControls() {
    var modeEl = document.getElementById("mode-select");
    modeEl.addEventListener("change", function () {
      stopAnimation();
      currentMode = modeEl.value;
      window.GeoState.save({ mode: currentMode });
      saveSession({ mode: currentMode, page: "" });   // switching mode closes any open page
      updateModeVisibility();
      var spPanel = document.getElementById("species-panel");
      spPanel.classList.remove("as-page");
      spPanel.style.display = "none";
      var bcPanel = document.getElementById("barchart-panel");
      bcPanel.classList.remove("as-page");
      bcPanel.style.display = "none";
      document.getElementById("field-page").style.display = "none";
      stopFieldGeoWatch();
      navClose("page");   // drop the page's Back-history entry (it was just closed)
      hideCsvBtn();
      if (cachedRender) clearOverlay();
      if (marker) { map.removeLayer(marker); marker = null; }
      updateLegend();
      setStatus(modeHint());   // show mode-appropriate guidance until an action overrides it
      if (currentMode === "range" || currentMode === "richness") triggerRender();
    });

    document.getElementById("lang-select").addEventListener("change", function () {
      setLang(this.value);
    });

    document.getElementById("secondlang-select").addEventListener("change", function () {
      setSecondLang(this.value);
      window.GeoState.save({ secondLang: secondLang });
      rerenderPointList();
    });

    // Scientific-name column toggle — pure CSS show/hide on the live table,
    // no re-render needed.
    document.getElementById("show-sci-toggle").addEventListener("change", function () {
      showSci = !!this.checked;
      window.GeoState.save({ showSci: showSci });
      applyShowSci();
    });

    // National-database list: add / edit / remove rows; the whole list (built-in
    // defaults seeded + user edits) is persisted as countryLinks once touched.
    var cuList = document.getElementById("custom-urls-list");
    cuList.addEventListener("input", function () { saveCountryLinks(collectCustomUrls()); });
    cuList.addEventListener("click", function (e) {
      var del = e.target.closest && e.target.closest(".cu-del");
      if (del) { del.closest(".cu-row").remove(); saveCountryLinks(collectCustomUrls()); }
    });
    document.getElementById("custom-urls-add").addEventListener("click", function () {
      cuList.insertAdjacentHTML("beforeend", cuRowHtml("", ""));
      var rows = cuList.querySelectorAll(".cu-row");
      rows[rows.length - 1].querySelector(".cu-cc").focus();
    });
    document.getElementById("custom-urls-reset").addEventListener("click", function () {
      window.GeoState.save({ countryLinks: null, customCountryUrls: null });   // revert to built-in defaults
      renderCustomUrls();
    });
    // Persist the National-databases section's open/closed state (default closed).
    var natDetails = document.getElementById("custom-urls-wrap");
    natDetails.open = window.GeoState.get("natdbOpen", false) === true;
    natDetails.addEventListener("toggle", function () { window.GeoState.save({ natdbOpen: natDetails.open }); });



    // Range cache budget (MB) → persist to localStorage; 0 disables and clears.
    h3CacheMB = +window.GeoState.get("h3CacheMB", 2) || 0;
    document.getElementById("h3cache-mb").value = String(h3CacheMB);
    loadH3Cache();
    document.getElementById("h3cache-mb").addEventListener("change", function () {
      h3CacheMB = +this.value || 0;
      window.GeoState.save({ h3CacheMB: h3CacheMB });
      saveH3Cache();   // re-fit to the new cap (or clear when Off)
    });

    // Personal eBird API key (enables eBird recent-sightings in the Recent panel).
    var ebKeyEl = document.getElementById("ebird-key");
    ebKeyEl.value = ebirdKey();
    // Bump the change-stamp so a key edit marks local as newer and rides along
    // on the next Drive sync (the key lives outside GeoState).
    var saveEbKey = function () { setEbirdKey(ebKeyEl.value); window.GeoState.touch(); };
    ebKeyEl.addEventListener("input", saveEbKey);    // save as typed/pasted, not only on blur
    ebKeyEl.addEventListener("change", saveEbKey);

    var hsMinEl = document.getElementById("hotspot-min");
    hsMinEl.value = String(+window.GeoState.get("hotspotMin", 200) || 0);
    hsMinEl.addEventListener("change", function () {
      window.GeoState.save({ hotspotMin: +this.value || 0 });
      if (hotspotsLayer && hotspotsLayer._reload) hotspotsLayer._reload();   // re-filter if shown
    });

    var crEl = document.getElementById("country-res");
    crEl.value = String(+window.GeoState.get("countryRes", 3) || 3);
    crEl.addEventListener("change", function () { window.GeoState.save({ countryRes: +this.value || 4 }); });

    var rrEl = document.getElementById("recent-radius");
    rrEl.value = String(+window.GeoState.get("recentRadiusKm", 25) || 25);
    rrEl.addEventListener("change", function () { window.GeoState.save({ recentRadiusKm: +this.value || 25 }); });

    document.getElementById("sync-export").addEventListener("click", exportAppData);
    document.getElementById("points-kml-export").addEventListener("click", exportPointsKml);
    document.getElementById("offline-zoom").addEventListener("change", function () {
      offlineMaxZoom = +this.value || 17;
      window.GeoState.save({ offlineMaxZoom: offlineMaxZoom });
    });
    renderOfflineAreas();
    var syncFile = document.getElementById("sync-file");
    document.getElementById("sync-import").addEventListener("click", function () { syncFile.click(); });
    syncFile.addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var s = importAppData(rd.result);
          setStatus(t("sync.imported", { n: s.checklistsIncoming, total: s.checklistsTotal }));
          setTimeout(function () { location.reload(); }, 1000);
        } catch (err) { setStatus(t("sync.importFailed", { msg: err.message || "" })); }
        e.target.value = "";
      };
      rd.readAsText(f);
    });

    // Google Drive sync controls. The transport lives in window.GDriveSync; here
    // we just reflect its state into the buttons and forward user gestures.
    if (window.GDriveSync) {
      var gdConnect = document.getElementById("gd-connect");
      var gdSync = document.getElementById("gd-sync");
      var gdDisconnect = document.getElementById("gd-disconnect");
      var gdClientId = document.getElementById("gd-clientid");
      var gdStatus = document.getElementById("gd-status");
      try { gdClientId.value = localStorage.getItem("gdrive-client-id") || ""; } catch (e) {}

      var renderGd = function (st) {
        var needId = !st.hasClientId;
        gdClientId.style.display = needId ? "" : "none";
        gdConnect.style.display = (!needId && !st.connected) ? "" : "none";
        gdSync.style.display = st.connected ? "" : "none";
        gdDisconnect.style.display = st.connected ? "" : "none";
        gdSync.disabled = !!st.busy;
        var msg = "";
        if (st.status === "syncing") msg = t("gdrive.syncing");
        else if (st.status === "reconnect") msg = t("gdrive.reconnect");
        else if (st.status === "error") msg = t("gdrive.error");
        else if (st.connected) msg = t("gdrive.synced");
        gdStatus.textContent = msg;
      };
      window.GDriveSync.onStatus(renderGd);

      gdConnect.addEventListener("click", function () { window.GDriveSync.connect().catch(function () {}); });
      gdSync.addEventListener("click", function () { window.GDriveSync.syncNow(); });
      gdDisconnect.addEventListener("click", function () { window.GDriveSync.disconnect(); });
      var saveClientId = function () { window.GDriveSync.setClientId(gdClientId.value); };
      gdClientId.addEventListener("change", saveClientId);
    }

    document.getElementById("maptype-select").addEventListener("change", function () {
      setBasemap(this.value);
    });

    document.getElementById("perf-modal-ok").addEventListener("click", hidePerfModal);
    document.getElementById("perf-modal").addEventListener("click", function (e) {
      if (e.target === this) hidePerfModal();   // click outside the box
    });
    document.getElementById("distmap-close").addEventListener("click", function () { navClose("distmap"); });
    document.getElementById("distmap-modal").addEventListener("click", function (e) {
      if (e.target === this) navClose("distmap");
    });
    document.getElementById("recent-close").addEventListener("click", function () { navClose("recent"); });
    document.getElementById("recent-modal").addEventListener("click", function (e) {
      if (e.target === this) navClose("recent");
    });
    document.getElementById("recent-modal").addEventListener("click", function (e) {
      if (!e.target.closest) return;
      if (e.target.closest("#recent-dl")) {
        if (!lastRecentRows.length) return;
        var nm = (lastRecentMeta && lastRecentMeta.name) || "sightings";
        downloadCsv("sightings_" + String(nm).replace(/[^\w-]+/g, "_") + ".csv", recentCsv());
      } else if (e.target.closest("#recent-map")) {
        if (!lastRecentRows.length || !lastRecentMeta) return;
        plotDetections(lastRecentMeta.key, lastRecentMeta.name, lastRecentRows, true);   // plot + zoom to points
        navClose("recent");
      }
    });
    // Pop-up reference links: Wikipedia uses the locale→English fallback;
    // BirdLife resolves the factsheet via its numeric ID.
    document.getElementById("distmap-body").addEventListener("click", function (e) {
      if (!e.target.closest) return;
      var wk = e.target.closest(".dm-wiki");
      if (wk) { e.preventDefault(); openWikipedia(wk.getAttribute("data-sci")); return; }
      var bl = e.target.closest(".dm-birdlife");
      if (bl) { e.preventDefault(); openBirdLife(bl.getAttribute("data-en"), bl.getAttribute("data-sci")); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { hidePerfModal(); navCloseTop(); }
    });

    document.getElementById("group-select").addEventListener("change", function () {
      speciesGroup = this.value;
      window.GeoState.save({ group: speciesGroup });
      updateSettingsIcon();
      // Re-render whatever depends on the species set.
      if (currentMode === "richness") triggerRender();
      else if (currentMode === "barchart" && analysisData) renderActiveTab();
      else rerenderPointList();   // list or range (per-point list)
      // Refresh an open species-search dropdown.
      var resEl = document.getElementById("species-results");
      if (resEl && resEl.style.display === "block") showSearch(document.getElementById("species-search"), resEl);
    });

    // Analysis tab bar
    var tabs = document.querySelectorAll("#an-tabs .an-tab");
    for (var ti = 0; ti < tabs.length; ti++) {
      tabs[ti].addEventListener("click", function () {
        analysisTab = this.getAttribute("data-tab");
        window.GeoState.save({ analysisTab: analysisTab });
        updateAnalysisControls();
        renderActiveTab();
      });
    }
    // Field checklist: fuzzy filter, in-row entry, export, clear.
    var fSearch = document.getElementById("field-search");
    var fSearchClear = document.getElementById("field-search-clear");
    function syncSearchClear() { fSearchClear.hidden = !fSearch.value; }
    fSearch.addEventListener("input", function () {
      fieldQuery = this.value; syncSearchClear(); renderFieldList();
    });
    fSearchClear.addEventListener("click", function () {
      fSearch.value = ""; fieldQuery = ""; syncSearchClear(); renderFieldList(); fSearch.focus();
    });
    // Single cycle button: All → Seen → Missing → Interesting → All.
    var FILTER_CYCLE = ["all", "seen", "missing", "interesting"];
    function filterCycleLabel(f) {
      return f === "interesting" ? t("chk.interesting") : t("chk." + f);
    }
    window.__refreshFilterCycle = function () {
      var b = document.getElementById("field-filter-cycle"); if (!b) return;
      b.setAttribute("data-ff", fieldFilter);
      b.textContent = filterCycleLabel(fieldFilter);
      b.classList.toggle("is-active", fieldFilter !== "all");
    };
    document.getElementById("field-filter-cycle").addEventListener("click", function () {
      var i = FILTER_CYCLE.indexOf(fieldFilter); if (i < 0) i = 0;
      fieldFilter = FILTER_CYCLE[(i + 1) % FILTER_CYCLE.length];
      window.__refreshFilterCycle();
      renderFieldList();
    });
    // Compose-line edits: the checkbox commits/clears the "seen" flag; the
    // activity and note inputs update the (uncommitted) compose draft.
    function fieldRowUpdate(el) {
      var key = el.getAttribute && el.getAttribute("data-key");
      if (!key) return;
      var card = el.closest(".fc-card");
      if (el.classList.contains("fc-note")) {
        cd(key).note = el.value;
        if (card) card.classList.toggle("fc-note-on", !!el.value);
      }
      updateFieldSeen();
    }
    var fieldList = document.getElementById("field-list");
    fieldList.addEventListener("input", function (e) { fieldRowUpdate(e.target); });
    fieldList.addEventListener("change", function (e) { fieldRowUpdate(e.target); });
    // ＋ commits the compose draft; the # opens the count picker; tapping the
    // recent-entries area opens the edit page; tapping empty card reveals note.
    fieldList.addEventListener("click", function (e) {
      if (!e.target.closest) return;
      var add = e.target.closest(".fc-add");
      if (add) { fcCommitCompose(add.getAttribute("data-key")); renderFieldList(); return; }
      var ents = e.target.closest(".fc-entries");
      if (ents) { openEntryEdit(ents.getAttribute("data-key")); return; }
      var btn = e.target.closest(".fc-count");
      if (btn) {
        var card0 = btn.closest(".fc-card"), nm = card0 && card0.querySelector(".fc-name");
        openFcPicker(btn.getAttribute("data-key"), nm ? nm.textContent : "");
        return;
      }
      var actBtn = e.target.closest(".fc-act-btn");
      if (actBtn) {
        var cardA = actBtn.closest(".fc-card"), nmA = cardA && cardA.querySelector(".fc-name");
        openFcActPicker(actBtn.getAttribute("data-key"), nmA ? nmA.textContent : "");
        return;
      }
      // Sex toggle: tap cycles none → ♂ → ♀ → ⚥ → ♀? → none.
      var sexBtn = e.target.closest(".fc-sex-btn");
      if (sexBtn) {
        var sKey = sexBtn.getAttribute("data-key");
        setFcSex(sKey, nextSex(cd(sKey).sex));
        return;
      }
      if (e.target.closest(".fc-act-btn") || e.target.closest(".fc-sex-btn") || e.target.closest(".fc-note") || e.target.closest(".fc-add")) return;
      var card = e.target.closest(".fc-card");
      if (card) { card.classList.add("fc-note-on"); var note = card.querySelector(".fc-note"); if (note) note.focus(); }
    });
    fieldList.addEventListener("scroll", function () { hideFcPicker(); hideFcActPicker(); });
    var fcap = document.getElementById("fc-act-picker");
    fcap.addEventListener("click", function (e) {
      var it = e.target.closest && e.target.closest(".fca-item");
      if (it) { setFcAct(fcActKey, it.getAttribute("data-act")); hideFcActPicker(); return; }
      if (e.target.id === "fca-close") hideFcActPicker();
    });
    var fcaSearch = document.getElementById("fca-search");
    fcaSearch.addEventListener("input", renderFcActList);
    fcaSearch.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); setFcAct(fcActKey, resolveActQuery(this.value)); hideFcActPicker(); }
      else if (e.key === "Escape") { hideFcActPicker(); }
    });
    document.addEventListener("click", function (e) {
      var p = document.getElementById("fc-act-picker");
      if (!p || p.style.display === "none") return;
      if (e.target.closest("#fc-act-picker") || e.target.closest(".fc-act-btn")) return;
      hideFcActPicker();
    });
    var fcp = document.getElementById("fc-picker");
    fcp.addEventListener("click", function (e) {
      var st = e.target.closest && e.target.closest(".fcp-step");
      if (st) {
        var delta = +st.getAttribute("data-step") || 0;
        if (delta && fcPickerKey) setFcCount(fcPickerKey, countNum(cd(fcPickerKey).count) + delta);
        return;
      }
      if (e.target.id === "fcp-close") hideFcPicker();
    });
    document.addEventListener("click", function (e) {
      var p = document.getElementById("fc-picker");
      if (!p || p.style.display === "none") return;
      if (e.target.closest("#fc-picker") || e.target.closest(".fc-count")) return;
      hideFcPicker();
    });
    // Download menu: PDF / CSV / Log hidden behind a single ⬇ button.
    function hideDlMenu() { var m = document.getElementById("field-dl-menu"); if (m) m.style.display = "none"; }
    document.getElementById("field-dl-btn").addEventListener("click", function (e) {
      e.stopPropagation();
      var m = document.getElementById("field-dl-menu");
      m.style.display = m.style.display === "none" ? "" : "none";
    });
    document.getElementById("field-csv").addEventListener("click", function () {
      hideDlMenu(); downloadCsv("field_checklist.csv", fieldChecklistCsv());
    });
    document.getElementById("field-log").addEventListener("click", function () {
      hideDlMenu(); downloadCsv("field_checklist_log.csv", fieldLogCsv());
    });
    document.getElementById("field-pdf").addEventListener("click", function () {
      hideDlMenu(); exportFieldPdf();
    });
    document.addEventListener("click", function (e) {
      var m = document.getElementById("field-dl-menu");
      if (!m || m.style.display === "none") return;
      if (e.target.closest("#field-dl-menu") || e.target.closest("#field-dl-btn")) return;
      hideDlMenu();
    });
    document.getElementById("field-review").addEventListener("click", function () { hideDlMenu(); openReviewPage(); });
    document.getElementById("field-map").addEventListener("click", function () { hideDlMenu(); plotChecklistOnMap(); });
    document.getElementById("field-clear").addEventListener("click", function () {
      hideDlMenu(); fcClear(); renderFieldList();
    });

    // ---- Review page wiring -------------------------------------------------
    document.getElementById("review-back").addEventListener("click", closeReviewPage);
    document.getElementById("review-new").addEventListener("click", function () {
      // Allocate the next free group letter and seed its upload meta so the
      // empty group shows up. The user then moves entries into it via the
      // species-row "Move to…" menus.
      var rec = getFieldRecord(REVIEW_RECID); if (!rec) return;
      var k = nextGroupKey(rec);
      rec.upload = rec.upload || {};
      rec.upload[k] = rec.upload[k] || {};
      putFieldRecord(rec);
      renderReviewPage();
    });
    var rlist = document.getElementById("review-list");
    // Field changes (meta inputs, species count/note, breeding-code select,
    // move-entry selects) all delegate to one handler.
    rlist.addEventListener("change", function (e) {
      var rec = getFieldRecord(REVIEW_RECID); if (!rec) return;
      var el = e.target;
      if (el.classList.contains("rv-m")) {
        var grp = el.getAttribute("data-grp"), f = el.getAttribute("data-f");
        var v = el.value;
        if (f === "duration" || f === "observers") v = v === "" ? "" : Math.max(0, +v || 0);
        else if (f === "distance" || f === "area") v = v === "" ? "" : Math.max(0, +v || 0);
        var patch = {}; patch[f] = v;
        writeGroupMeta(rec, grp, patch);
        if (f === "protocol") renderReviewPage();   // toggles the distance row
        return;
      }
      if (el.classList.contains("rv-count")) {
        var grp1 = el.getAttribute("data-grp"), key1 = el.getAttribute("data-key");
        var raw = el.value.trim();
        var val = raw === "" || raw.toUpperCase() === "X" ? null : (/^[0-9]+$/.test(raw) ? +raw : raw);
        reviewEditSpecies(rec, grp1, key1, { count: val });
        return;
      }
      if (el.classList.contains("rv-code")) {
        var grp2 = el.getAttribute("data-grp"), key2 = el.getAttribute("data-key");
        reviewEditSpecies(rec, grp2, key2, { code: el.value });
        return;
      }
      if (el.classList.contains("rv-note")) {
        var grp3 = el.getAttribute("data-grp"), key3 = el.getAttribute("data-key");
        reviewEditSpecies(rec, grp3, key3, { note: el.value });
        return;
      }
      if (el.classList.contains("rv-move")) {
        var eid = el.getAttribute("data-eid"), target = el.value;
        if (target) {
          reviewMoveEntry(rec, eid, target);
          renderReviewPage();
        }
        return;
      }
    });
    rlist.addEventListener("click", function (e) {
      var x = e.target.closest && e.target.closest(".rv-expand");
      if (x) {
        var sp = x.closest(".rv-sp"); if (!sp) return;
        var sl = sp.querySelector(".rv-src-list"); if (!sl) return;
        sl.hidden = !sl.hidden;
        x.textContent = sl.hidden ? "▾" : "▴";
        return;
      }
      var dl = e.target.closest && e.target.closest(".rv-dl");
      if (dl) {
        var rec = getFieldRecord(REVIEW_RECID); if (!rec) return;
        var grp = dl.getAttribute("data-grp");
        var fname = "ebird_" + (rec.day || todayStr()) + "_" + grp + ".csv";
        var out = ebirdRecordCsv(rec, grp);
        downloadCsv(fname, out.csv);
        if (out.skipped) setStatus(t("review.csvBirdsOnly", { n: out.skipped }));
        return;
      }
      var api = e.target.closest && e.target.closest(".rv-api");
      if (api) {
        var rec2 = getFieldRecord(REVIEW_RECID); if (!rec2) return;
        ebirdSubmitGroup(rec2, api.getAttribute("data-grp"));
        return;
      }
    });
    // "Nearby places" picker for the title.
    document.getElementById("field-nearby").addEventListener("click", function (e) { e.stopPropagation(); openPlacePicker(); });
    document.getElementById("place-close").addEventListener("click", hidePlacePicker);
    document.getElementById("place-list").addEventListener("click", function (e) {
      if (!e.target.closest) return;
      var merge = e.target.closest(".pp-merge");
      if (merge) { fcMerge(merge.getAttribute("data-id")); hidePlacePicker(); renderFieldList(); setStatus(t("chk.merged")); return; }
      var it = e.target.closest(".pp-item");
      if (it && it.getAttribute("data-name")) { setFieldTitle(it.getAttribute("data-name")); hidePlacePicker(); }
    });

    // Editable location title — persist into the field-checklist record.
    document.getElementById("field-coords").addEventListener("change", function () {
      persistFieldTitle(this.value.trim());
    });

    // Back: close the full-screen field page and return to the map.
    document.getElementById("field-back").addEventListener("click", function () { navClose("page"); });
    // Tap the red "!" to toggle the short "far from this location" explanation.
    document.getElementById("field-far").addEventListener("click", function (e) {
      e.stopPropagation();
      var m = document.getElementById("field-far-msg");
      m.style.display = m.style.display === "none" ? "" : "none";
    });

    // Entry-edit page: back, per-entry edits, delete, and merge selected.
    document.getElementById("entry-back").addEventListener("click", closeEntryEdit);
    var entryList = document.getElementById("entry-list");
    entryList.addEventListener("change", function (e) {
      var el = e.target, id = el.getAttribute && el.getAttribute("data-id"); if (!id) return;
      if (el.classList.contains("ent-count")) { var v = el.value.trim(); fcUpdateEntry(id, { count: v === "" ? null : (/^[0-9]+$/.test(v) ? +v : v) }); }
      else if (el.classList.contains("ent-act")) fcUpdateEntry(id, { act: el.value || "" });
      else if (el.classList.contains("ent-sex")) fcUpdateEntry(id, { sex: el.value || "" });
      else if (el.classList.contains("ent-note")) fcUpdateEntry(id, { note: el.value });
    });
    entryList.addEventListener("click", function (e) {
      var del = e.target.closest && e.target.closest(".ent-del");
      if (!del) return;
      fcDeleteEntry(del.getAttribute("data-id"));
      var rec = curFieldRecord(false);
      if (!rec || !fcEntriesFor(rec, entryEditKey).length) closeEntryEdit(); else renderEntryEdit();
    });
    document.getElementById("entry-merge").addEventListener("click", function () {
      var ids = Array.prototype.map.call(document.querySelectorAll("#entry-list .ent-sel:checked"), function (c) { return c.getAttribute("data-id"); });
      if (ids.length < 2) { setStatus(t("chk.mergehint")); return; }
      fcMergeEntries(ids); renderEntryEdit();
    });

    // Back from the full-screen Species-List page to the map.
    document.getElementById("sp-back").addEventListener("click", function () { navClose("page"); });
    // Back from the full-screen Migration analysis page to the map.
    document.getElementById("bc-back").addEventListener("click", function () { navClose("page"); });

    document.getElementById("an-filter").addEventListener("input", function () { renderActiveTab(); });
    document.getElementById("an-topn").addEventListener("input", function () {
      if (analysisTab === "scatter") renderActiveTab();
    });
    document.getElementById("an-rankby").addEventListener("change", function () {
      window.GeoState.save({ scatterRankBy: this.value });
      if (analysisTab === "scatter") renderActiveTab();
    });

    document.getElementById("week-select").addEventListener("change", function () {
      window.GeoState.save({ week: +this.value });
      if (currentMode === "range" || currentMode === "richness") showCachedWeek();  // re-filter cached cells
      if (currentMode === "barchart" && analysisData) renderActiveTab();
      updateRangeSpecies();   // keep the "· Week N" label in sync
      rerenderPointList();   // update the per-point list (list or range with a marker)
      updateLegend();
    });

    document.getElementById("compare-select").addEventListener("change", function () {
      window.GeoState.save({ compare: this.value });
      rerenderPointList();
    });

    // Two-sided probability range (min/max) shared by the Species List and the
    // analysis tabs (and used when building a checklist).
    function onProbRange(e) {
      var loEl = document.getElementById("prob-min"), hiEl = document.getElementById("prob-max");
      var lo = +loEl.value, hi = +hiEl.value;
      // Keep min ≤ max by pushing whichever handle the user is dragging.
      if (lo > hi) { if (e && e.target === loEl) hiEl.value = lo, hi = lo; else loEl.value = hi, lo = hi; }
      document.getElementById("prob-min-val").textContent = lo + "%";
      document.getElementById("prob-max-val").textContent = hi + "%";
      window.GeoState.save({ probMin: lo, probMax: hi });
      if (currentMode === "barchart" && analysisData) { renderActiveTab(); return; }
      // Range: re-filter the cached overlay (no re-inference — the filter is
      // applied at draw time).
      if (currentMode === "range" && cachedRender) paintOverlay();
      // Country list: re-evaluate the merge vs the eBird country list at the
      // new threshold (cached aggs/cells/spp — instant, no inference). Must
      // come before rerenderPointList so the per-point path doesn't clobber it.
      if (currentSpView && currentSpView.mode === "country" && document.getElementById("species-panel").style.display !== "none") {
        renderSpeciesInCountry(currentSpView.lat, currentSpView.lon);
        return;
      }
      rerenderPointList();
    }
    document.getElementById("prob-min").addEventListener("input", onProbRange);
    document.getElementById("prob-max").addEventListener("input", onProbRange);

    document.getElementById("play-btn").addEventListener("click", toggleAnimation);

    // Scrub the migration progress bar to jump to any week/date. Dragging
    // pauses playback (the bar stays visible while an animation is cached).
    (function () {
      var pp = document.getElementById("play-progress");
      var dragging = false;
      pp.addEventListener("pointerdown", function (e) {
        if (animating) stopAnimation();
        dragging = true;
        try { pp.setPointerCapture(e.pointerId); } catch (_) {}
        scrubToWeek(e.clientX);
        e.preventDefault();
      });
      pp.addEventListener("pointermove", function (e) { if (dragging) scrubToWeek(e.clientX); });
      function endDrag() { dragging = false; }
      pp.addEventListener("pointerup", endDrag);
      pp.addEventListener("pointercancel", endDrag);
    })();

    // Stop the migration animation when the tab is hidden so it never runs
    // unattended in a backgrounded window; also flush the range cache.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && animating) stopAnimation();
      if (document.hidden && h3SaveTimer) saveH3Cache();
    });
    window.addEventListener("pagehide", function () { if (h3SaveTimer) saveH3Cache(); });

    // Dropdown popovers (Hidden species, Saved locations).
    function wireDropdown(btnId, panelId) {
      document.getElementById(btnId).addEventListener("click", function (e) {
        e.stopPropagation();
        var p = document.getElementById(panelId);
        var willOpen = p.style.display === "none";
        closeDropdowns();
        p.style.display = willOpen ? "block" : "none";
      });
    }
    wireDropdown("hidden-btn", "hidden-panel");
    wireDropdown("checklists-toggle", "checklists-panel");
    wireDropdown("mp-toggle", "mp-panel");
    // Re-render the panel after open so distances reflect the current map centre.
    document.getElementById("mp-toggle").addEventListener("click", function () {
      setTimeout(refreshMpPanel, 0);
    });
    wireDropdown("settings-toggle", "settings-panel");

    // About (model & methodology) opens from the Settings dropdown as a modal.
    document.getElementById("about-open").addEventListener("click", function () {
      closeDropdowns();
      document.getElementById("about-modal").style.display = "flex";
      navOpen("about", hideAbout);
    });
    document.getElementById("about-close").addEventListener("click", function () { navClose("about"); });
    document.getElementById("about-modal").addEventListener("click", function (e) {
      if (e.target === this) navClose("about");
    });

    // Checklist actions
    // Open the tickable Checklist for the current point (from the Species list).
    document.getElementById("sp-checklist-btn").addEventListener("click", function () {
      if (currentSpView && currentSpView.mode === "country") {
        renderCountryChecklist(currentSpView.cc, currentSpView.name, currentSpView.lat, currentSpView.lon, currentSpView.results);
        return;
      }
      if (!marker) return;
      var ll = marker.getLatLng();
      renderFieldChecklist(ll.lat, ll.lng);
    });
    document.getElementById("sp-pdf-btn").addEventListener("click", exportSpeciesPdf);
    document.getElementById("sp-map-btn").addEventListener("click", plotAllSightings);

    // Click a count cell in the per-point species list to open the recent-
    // sightings panel for that species (multi-source merge with Show in map).
    // Extras (not in model) have no species code → query by sci name only.
    document.getElementById("sp-tbody").addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest(".det-count-btn");
      if (!btn) return;
      if (!currentSpView || currentSpView.mode !== "point") return;
      if (btn.classList.contains("det-count-extra")) {
        showRecent(btn.getAttribute("data-name") || btn.getAttribute("data-sci"), btn.getAttribute("data-sci"), currentSpView.lat, currentSpView.lon, "");
        return;
      }
      var key = btn.getAttribute("data-key"), lbl = labelsByKey[key];
      if (!lbl) return;
      showRecent(speciesName(lbl), lbl.sci, currentSpView.lat, currentSpView.lon, key);
    });

    // Click Scientific name / # column headers to sort the per-point species
    // list by that column (toggling asc → desc → off, where off returns to the
    // natural Probability-descending ranking).
    document.getElementById("sp-sci-head").addEventListener("click", function () { cycleSpeciesListSort("sci"); });
    // Click the combined "n(d)" column header to cycle a filter:
    // off → >0 (any observation) → 1d → 3d → 1w → 2w → 3w → 4w → off. Applies live against the
    // cached sightings aggregation (no re-fetch). Filtering is the only
    // interaction on this column now — count-sort was retired with the
    // separate # column.
    document.getElementById("sp-nd-head").addEventListener("click", function () {
      if (!currentSpView || currentSpView.mode !== "point") return;
      var seq = [0, -1, 1, 3, 7, 14, 21, 28];   // off → >0 → ≤1d → … → ≤4w → off
      speciesAgeFilterDays = seq[(seq.indexOf(speciesAgeFilterDays) + 1) % seq.length];
      this.textContent = ageHeadLabel();
      applyAgeFilter();
    });

    // Click the "Species" column header to cycle the list filter through three
    // states: default → only ★ interesting → only 🚫 hidden → default. Lets
    // the user surface hidden species (normally excluded everywhere) for
    // review without having to open the Hidden dropdown.
    document.getElementById("sp-species-head").addEventListener("click", function () {
      var seq = ["", "interesting", "hidden"];
      speciesListFilter = seq[(seq.indexOf(speciesListFilter) + 1) % seq.length];
      this.textContent = speciesHeadLabel();
      refreshCurrentView();
    });

    // Click the "Probability" column header in country view to cycle the
    // aggregation: max → 90th percentile → median → max. Cached, so it just
    // re-renders without re-running inference.
    document.getElementById("sp-prob-head").addEventListener("click", function () {
      if (!currentSpView || currentSpView.mode !== "country") return;
      if (!this.classList.contains("clickable-head")) return;
      var modes = ["max", "p90", "median"];
      countryAgg = modes[(modes.indexOf(countryAgg) + 1) % modes.length];
      window.GeoState.save({ countryAgg: countryAgg });
      renderSpeciesInCountry(currentSpView.lat, currentSpView.lon);
    });

    document.getElementById("csv-download-btn").addEventListener("click", function () {
      if (lastCsvData) downloadCsv(lastCsvData.filename, lastCsvData.content);
    });

    // Species-name context menu: clicking a name (in any list/table) opens a
    // small menu with "Filter" and "Do not show".
    var spMenu = document.getElementById("sp-menu");
    document.addEventListener("click", function (e) {
      var link = e.target.closest ? e.target.closest(".sp-link") : null;
      if (link) {
        e.preventDefault();
        menuKey = link.getAttribute("data-key");
        menuName = link.getAttribute("data-name");
        menuSci = link.getAttribute("data-sci") || "";
        // BirdLife DataZone covers birds only — hide for other groups.
        var bird = isBirdKey(menuKey);
        var blBtn = spMenu.querySelector('[data-act="birdlife"]');
        if (blBtn) blBtn.style.display = bird ? "" : "none";
        // Dynamic label on the Interesting item — add vs remove based on state.
        var intBtn = spMenu.querySelector('[data-act="interesting"]');
        if (intBtn) intBtn.textContent = t(isInteresting(menuKey) ? "menu.interestingRemove" : "menu.interestingAdd");
        spMenu.style.left = e.pageX + "px";
        spMenu.style.top = e.pageY + "px";
        spMenu.style.display = "block";
        return;
      }
      if (!spMenu.contains(e.target)) spMenu.style.display = "none";
      // Close the dropdown popovers when clicking outside a panel/toggle.
      if (!e.target.closest(".dd-panel") && !e.target.closest(".dd-toggle")) closeDropdowns();
    });
    spMenu.querySelectorAll(".sp-menu-item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var act = this.getAttribute("data-act");
        if (act === "hide") hideSpecies(menuKey);
        else if (act === "interesting") toggleInteresting(menuKey);
        else if (act === "apprange") showSpeciesRange(menuKey);
        else if (act === "appmig") showSpeciesMigration(menuKey);
        else if (act === "filter") applyNameFilter(menuName);
        else if (act === "wiki") openWikipedia(menuSci || menuName);
        else if (act === "birdlife") openBirdLife((labelsByKey[menuKey] && labelsByKey[menuKey].common) || menuName, menuSci || menuName);
        else if (act === "macaulay") openExternal(macaulayUrl(menuKey, menuSci || menuName));
        else if (act === "xeno") openExternal(xenoCantoUrl(menuSci || menuName));
        else if (act === "distmap") showDistMap(menuName, menuSci || menuName, menuKey);
        else if (act === "recent") { var rl = marker ? marker.getLatLng() : map.getCenter(); showRecent(menuName, menuSci || menuName, rl.lat, rl.lng, menuKey); }
        spMenu.style.display = "none";
      });
    });

    var searchEl = document.getElementById("species-search");
    var resultsEl = document.getElementById("species-results");
    var selIdx = -1;

    searchEl.addEventListener("focus", function () { showSearch(searchEl, resultsEl); });
    searchEl.addEventListener("input", function () { selIdx = -1; showSearch(searchEl, resultsEl); });
    searchEl.addEventListener("keydown", function (e) {
      var items = resultsEl.querySelectorAll(".sr-item");
      if (e.key === "ArrowDown") { e.preventDefault(); selIdx = Math.min(selIdx + 1, items.length - 1); highlightItem(items, selIdx); }
      else if (e.key === "ArrowUp") { e.preventDefault(); selIdx = Math.max(selIdx - 1, 0); highlightItem(items, selIdx); }
      else if (e.key === "Enter" && selIdx >= 0 && items[selIdx]) { e.preventDefault(); items[selIdx].click(); }
      else if (e.key === "Escape") { resultsEl.style.display = "none"; }
    });
    document.addEventListener("click", function (e) {
      if (!resultsEl.contains(e.target) && e.target !== searchEl) resultsEl.style.display = "none";
    });

    wirePlaceSearch();
  }

  // ---- Place (location) search — geocode within the current map view --------
  // Uses Nominatim with a viewbox of the current bounds + bounded=1 so results
  // stay within what's on screen, matching the user's intent.
  var placeMarker = null;
  // Keep only genuine placenames (settlements, regions, natural features) — drop
  // businesses/POIs (shops, offices, amenities…) and personal/house addresses.
  var PLACE_CATEGORIES = { place: 1, boundary: 1, natural: 1, waterway: 1, water: 1 };
  function isPlaceName(r) {
    if (!r || !PLACE_CATEGORIES[r.category]) return false;
    return r.type !== "house" && r.type !== "houses" && r.type !== "address";
  }
  function wirePlaceSearch() {
    var inp = document.getElementById("place-search");
    var res = document.getElementById("place-results");
    if (!inp || !res) return;
    var selIdx = -1, timer = null, reqTok = 0;
    var run = function () {
      var q = inp.value.trim();
      if (q.length < 2) { res.style.display = "none"; res.innerHTML = ""; return; }
      var b = map.getBounds();
      var vb = [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].map(function (n) { return n.toFixed(6); }).join(",");
      var url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=20&addressdetails=0&bounded=1&viewbox=" +
        vb + "&accept-language=" + encodeURIComponent(lang) + "&q=" + encodeURIComponent(q);
      var my = ++reqTok;
      fetch(url, { headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (list) {
          if (my !== reqTok) return;   // a newer query superseded this one
          selIdx = -1;
          renderPlaceResults(res, (Array.isArray(list) ? list : []).filter(isPlaceName).slice(0, 8));
        })
        .catch(function () { if (my === reqTok) { res.style.display = "none"; } });
    };
    inp.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(run, 350); });
    inp.addEventListener("focus", function () { if (res.innerHTML) res.style.display = "block"; });
    inp.addEventListener("keydown", function (e) {
      var items = res.querySelectorAll(".sr-item");
      if (e.key === "ArrowDown") { e.preventDefault(); selIdx = Math.min(selIdx + 1, items.length - 1); highlightItem(items, selIdx); }
      else if (e.key === "ArrowUp") { e.preventDefault(); selIdx = Math.max(selIdx - 1, 0); highlightItem(items, selIdx); }
      else if (e.key === "Enter") { e.preventDefault(); if (selIdx >= 0 && items[selIdx]) items[selIdx].click(); else { clearTimeout(timer); run(); } }
      else if (e.key === "Escape") { res.style.display = "none"; }
    });
    document.addEventListener("click", function (e) {
      if (!res.contains(e.target) && e.target !== inp) res.style.display = "none";
    });
  }
  function renderPlaceResults(res, list) {
    if (!list.length) { res.innerHTML = '<div class="sr-empty">' + escapeHtml(t("place.none")) + "</div>"; res.style.display = "block"; return; }
    res.innerHTML = list.map(function (r) {
      return '<div class="sr-item" data-lat="' + (+r.lat) + '" data-lon="' + (+r.lon) + '">' + escapeHtml(r.display_name || "") + "</div>";
    }).join("");
    res.style.display = "block";
    res.querySelectorAll(".sr-item").forEach(function (el) {
      el.addEventListener("click", function () {
        gotoPlace(+el.dataset.lat, +el.dataset.lon, el.textContent);
        res.style.display = "none";
      });
    });
  }
  // Pan to a found place and drop the same interactive pin a map click makes
  // (with the Species list / Checklist options, or the mode's action). Close
  // the search panel so the pin's popup is unobstructed.
  function gotoPlace(lat, lon, label) {
    if (!isFinite(lat) || !isFinite(lon) || !map) return;
    map.panTo([lat, lon]);
    var pan = document.querySelector(".place-search-panel");
    if (pan) pan.style.display = "none";
    var btn = document.querySelector(".place-search-btn");
    if (btn) btn.classList.remove("is-open");
    selectMapPoint(lat, lon);
  }

  // Per-species probabilities at the current map centre/week, used to rank the
  // species search by local likelihood. Computed lazily (one inference) and
  // cached; a centre/week change triggers a recompute that refreshes the
  // open dropdown (also re-run on map moveend).
  var searchProbs = null, searchProbsKey = null, searchProbsPending = null;
  function searchKeyNow() {
    if (!map) return null;
    var c = map.getCenter();
    return c.lat.toFixed(2) + "," + c.lng.toFixed(2) + ":" + (document.getElementById("week-select") || {}).value;
  }
  function searchProbsCurrent() {
    var key = searchKeyNow();
    if (searchProbs && searchProbsKey === key) return searchProbs;
    if (key && searchProbsPending !== key) {
      searchProbsPending = key;
      var c = map.getCenter(), wk = +document.getElementById("week-select").value;
      runInference(new Float32Array([c.lat, c.lng, wk]), 1).then(function (out) {
        searchProbs = out; searchProbsKey = key; searchProbsPending = null;
        var inp = document.getElementById("species-search"), res = document.getElementById("species-results");
        if (inp && res && res.style.display === "block") showSearch(inp, res);
      }).catch(function () { searchProbsPending = null; });
    }
    return null;
  }

  function showSearch(inputEl, resultsEl) {
    var q = inputEl.value.trim().toLowerCase();
    var probs = searchProbsCurrent();   // rank by likelihood at the map centre
    var matches;
    if (q.length === 0) {
      matches = FEATURED_SPECIES.map(function (f) { return labelsByKey[f.key]; })
        .filter(Boolean).filter(function (l) { return inGroup(l.index); });
    } else {
      matches = labels.filter(function (l) {
        if (!inGroup(l.index)) return false;
        return speciesName(l).toLowerCase().includes(q) ||
               l.common.toLowerCase().includes(q) ||
               l.sci.toLowerCase().includes(q) || l.key.includes(q);
      });
    }
    if (probs) matches.sort(function (a, b) { return (probs[b.index] || 0) - (probs[a.index] || 0); });
    matches = matches.slice(0, 30);
    resultsEl.innerHTML = matches.map(function (l) {
      return '<div class="sr-item" data-key="' + l.key + '">' + interestingStar(l.key) + escapeHtml(speciesName(l)) + ' <span class="sr-sci">' + escapeHtml(l.sci) + '</span></div>';
    }).join("");
    resultsEl.style.display = matches.length ? "block" : "none";
    resultsEl.querySelectorAll(".sr-item").forEach(function (el) {
      el.addEventListener("click", function () {
        selectSpecies(el.dataset.key);
        inputEl.value = "";
        resultsEl.style.display = "none";
      });
    });
  }

  function highlightItem(items, idx) {
    items.forEach(function (el, i) { el.classList.toggle("active", i === idx); });
    if (items[idx]) items[idx].scrollIntoView({ block: "nearest" });
  }

  // Show the app's own range map for a species: switch to Species Range mode,
  // close any full-screen panel, and select the species (which renders it).
  function showSpeciesRange(key) {
    if (!labelsByKey[key]) return;
    var modeEl = document.getElementById("mode-select");
    if (modeEl.value !== "range") { modeEl.value = "range"; modeEl.dispatchEvent(new Event("change", { bubbles: true })); }
    var ep = document.getElementById("entry-page"); if (ep) ep.style.display = "none";
    selectSpecies(key);
    if (map) map.invalidateSize();
  }

  // The point a per-species migration timeline should be computed at: the open
  // checklist's location, else the placed marker, else the current map centre.
  function migrationPoint() {
    var fp = document.getElementById("field-page");
    if (fp && fp.style.display !== "none" && typeof fieldLat === "number") return { lat: fieldLat, lon: fieldLon };
    if (marker) { var ll = marker.getLatLng(); return { lat: ll.lat, lon: ll.lng }; }
    var c = map.getCenter(); return { lat: c.lat, lon: c.lng };
  }

  // "Migration": this one species' weekly probability through the year at a
  // single point — i.e. the Migration (barchart) mode's Timeline tab, run at
  // the relevant point and filtered to just this species.
  function showSpeciesMigration(key) {
    var lbl = labelsByKey[key];
    if (!lbl) return;
    var pt = migrationPoint();
    var modeEl = document.getElementById("mode-select");
    if (modeEl.value !== "barchart") { modeEl.value = "barchart"; modeEl.dispatchEvent(new Event("change", { bubbles: true })); }
    analysisTab = "timeline";
    window.GeoState.save({ analysisTab: analysisTab });
    document.getElementById("an-filter").value = speciesName(lbl);
    renderAnalysis(pt.lat, pt.lon);
  }

  function selectSpecies(key) {
    var lbl = labelsByKey[key];
    if (!lbl) return;
    var el = document.getElementById("species-search");
    el.placeholder = speciesName(lbl) + " (" + lbl.sci + ")";
    el.dataset.selectedKey = key;
    window.GeoState.save({ species: key });
    stopAnimation();
    if (currentMode === "range") renderRangeMap();
  }

  // ---- Inference -----------------------------------------------------------
  // opts.task: "raw" (default, full output) | "column" (opts.speciesIdx) |
  // "richness" (opts.threshold, optional opts.mask). The worker reduces the
  // output so only small arrays cross the thread boundary.
  async function runInference(flatInputs, batchSize, opts) {
    opts = opts || {};
    var id = ++inferenceId;
    return new Promise(function (resolve, reject) {
      pendingInferences.set(id, { resolve: resolve, reject: reject });
      var buf = new Float32Array(flatInputs).buffer;
      var msg = { type: "infer", id: id, flatInputs: buf, batchSize: batchSize, task: opts.task || "raw" };
      if (opts.task === "column") msg.speciesIdx = opts.speciesIdx;
      if (opts.task === "richness") { msg.threshold = opts.threshold; if (opts.mask) msg.mask = opts.mask; }
      worker.postMessage(msg, [buf]);   // mask (if any) is cloned, not transferred
    });
  }

  // Progress bar inside the computing overlay (0..1).
  function setComputeProgress(frac) {
    var bar = document.getElementById("computing-progress-bar");
    if (bar) bar.style.width = Math.max(0, Math.min(1, frac)) * 100 + "%";
  }

  // Uint8Array(nSpecies) marking the active group, or null for "all".
  function groupMask() {
    if (speciesGroup === "all") return null;
    var m = new Uint8Array(labels.length);
    for (var i = 0; i < labels.length; i++) m[i] = labelClass[i] === speciesGroup ? 1 : 0;
    return m;
  }

  // Total inference chunks across all weeks (for the progress bar).
  function totalChunks(weekMissing, chunk) {
    var n = 0;
    for (var i = 0; i < weekMissing.length; i++) n += Math.ceil(weekMissing[i].missing.length / chunk) || 1;
    return n;
  }

  // ---- Overlay -------------------------------------------------------------
  function ensureOverlayCanvas() {
    if (overlayCanvas) return;
    overlayCanvas = document.createElement("canvas");
    overlayCanvas.className = "heatmap-overlay";
    overlayCanvas.style.position = "absolute";
    overlayCanvas.style.pointerEvents = "none";
    map.getPane("overlayPane").appendChild(overlayCanvas);
  }

  function clearOverlay() {
    cachedRender = null;
    if (overlayCanvas) { overlayCanvas.width = 0; overlayCanvas.height = 0; }
  }

  // Bilinear sample of the cached probability field at a lat/lon — the same
  // mapping the smooth renderer uses (linear in lon, row by latitude).
  function sampleGridProb(g, probs, lat, lon) {
    var rf = (g.north - lat) / g.step - 0.5;
    var r0 = Math.floor(rf), fr = Math.max(0, Math.min(1, rf - r0));
    r0 = Math.max(0, Math.min(g.nLat - 1, r0));
    var r1 = Math.max(0, Math.min(g.nLat - 1, r0 + 1));
    var lonU = lon; while (lonU < g.west) lonU += 360; while (lonU > g.east) lonU -= 360;
    var cf = (lonU - g.west) / g.step - 0.5;
    var c0 = Math.floor(cf), fc = Math.max(0, Math.min(1, cf - c0));
    c0 = Math.max(0, Math.min(g.nLon - 1, c0));
    var c1 = Math.max(0, Math.min(g.nLon - 1, c0 + 1));
    var b0 = r0 * g.nLon, b1 = r1 * g.nLon;
    var top = probs[b0 + c0] + (probs[b0 + c1] - probs[b0 + c0]) * fc;
    var bot = probs[b1 + c0] + (probs[b1 + c1] - probs[b1 + c0]) * fc;
    return top + (bot - top) * fr;
  }

  // H3 resolution for the overlay. The base resolution targets a fixed on-screen
  // hex size (~15px edge) so the tile *count* stays ~constant across zoom; the
  // Resolution setting then shifts it by whole zoom levels (each = one H3
  // resolution, ~7x the tiles).
  function h3ResForView() {
    var z = map.getZoom();
    // Metres-per-pixel at the equator (no cos(lat) term): the resolution follows
    // the zoom only, so panning north–south doesn't flip the H3 resolution.
    var mpp = 156543.03392 / Math.pow(2, z);
    var targetM = Math.max(1, 15 * mpp);
    var best = 0, bestD = Infinity;
    for (var r = 0; r <= 14; r++) {
      // Geometric (log) closeness: H3 resolutions are ~2.65x apart in edge, so
      // log distance centres the on-screen size symmetrically around the target.
      var d = Math.abs(Math.log(window.h3.getHexagonEdgeLengthAvg(r, "m") / targetM));
      if (d < bestD) { bestD = d; best = r; }
    }
    return Math.max(0, Math.min(14, best + (hiResFactor | 0)));
  }

  // The distribution overlay is always drawn as filled H3 hexagons (the smooth
  // heatmap is used only if the H3 library failed to load at all).
  function paintOverlay() {
    if (!cachedRender || !map) return;
    if (!window.h3) { paintOverlaySmooth(); return; }
    try { if (cachedRender.h3range) paintRangeH3(); else paintOverlayH3(); } catch (e) { console.warn("h3 overlay", e); }
  }

  // Draw the Species-Range overlay from the per-cell H3 cache (Richness still
  // uses the grid-sampling path in paintOverlayH3).
  function paintRangeH3() {
    ensureOverlayCanvas();
    var cache = h3RangeCache.get(cachedRender.tag) || {};
    var size = map.getSize();
    if (overlayCanvas.width !== size.x || overlayCanvas.height !== size.y) { overlayCanvas.width = size.x; overlayCanvas.height = size.y; }
    L.DomUtil.setPosition(overlayCanvas, map.containerPointToLayerPoint([0, 0]));
    var ctx = overlayCanvas.getContext("2d");
    ctx.clearRect(0, 0, size.x, size.y);
    var targetRes = h3ResForView(), cells = h3CellsInView(targetRes);
    var i, max = 0, v;
    // Normalise to the species' peak across ALL cached cells for this week (not
    // just those in view) so a low-probability region doesn't rescale to full
    // colour when you zoom into it (e.g. an Iberian species "appearing" in
    // Norway). The peak is captured once a broad/zoomed-out view is computed.
    // Important: ignore cells from other H3 resolutions left in the cache from
    // an earlier hiResFactor — they'd skew the max for the cells we actually
    // draw and wash out the colours at the new resolution.
    var allKeys = Object.keys(cache);
    for (i = 0; i < allKeys.length; i++) {
      if (window.h3.getResolution(allKeys[i]) !== targetRes) continue;
      v = cache[allKeys[i]]; if (v != null && v > max) max = v;
    }
    if (max <= 0) max = 0.01;
    cachedRender.maxProb = max;   // legend reflects this species-wide normalisation
    var pmin = +document.getElementById("prob-min").value / 100;
    var pmax = +document.getElementById("prob-max").value / 100;
    for (i = 0; i < cells.length; i++) {
      var raw = cache[cells[i]];
      if (raw == null || raw < pmin || raw > pmax) continue;   // not computed, or filtered out
      var p = Math.pow(raw / max, DISPLAY_GAMMA);
      if (!(p >= 0.01)) continue;
      var bnd = window.h3.cellToBoundary(cells[i]);
      var minLon = 999, maxLon = -999;
      for (var w = 0; w < bnd.length; w++) { if (bnd[w][1] < minLon) minLon = bnd[w][1]; if (bnd[w][1] > maxLon) maxLon = bnd[w][1]; }
      if (maxLon - minLon > 180) continue;
      ctx.beginPath();
      for (var vtx = 0; vtx < bnd.length; vtx++) {
        var pt = map.latLngToContainerPoint([bnd[vtx][0], bnd[vtx][1]]);
        if (vtx === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
      }
      ctx.closePath();
      var col = colormapLookup(p);
      ctx.fillStyle = "rgba(" + col[0] + "," + col[1] + "," + col[2] + "," + Math.min(1, 0.25 + p * 0.75).toFixed(3) + ")";
      ctx.fill();
    }
  }

  // Enumerate the H3 cells (resolution `res`) covering the current viewport by
  // sampling screen points and mapping each to its cell. This is bounded by the
  // screen and never throws — unlike polygonToCells, which fails on large areas
  // at some resolutions and previously forced a fall back to square cells.
  function h3CellsInView(res) {
    var size = map.getSize(), c = map.getCenter();
    var mpp = 156543.03392 * Math.cos(c.lat * Math.PI / 180) / Math.pow(2, map.getZoom());
    var edgePx = Math.max(4, window.h3.getHexagonEdgeLengthAvg(res, "m") / mpp);
    var stepPx = Math.max(5, edgePx * 0.6);   // sample finer than a hex so none is missed
    var seen = {}, out = [];
    for (var y = 0; y <= size.y + stepPx; y += stepPx) {
      var yy = Math.min(y, size.y);
      for (var x = 0; x <= size.x + stepPx; x += stepPx) {
        var ll = map.containerPointToLatLng([Math.min(x, size.x), yy]);
        var cell = window.h3.latLngToCell(Math.max(-89.9, Math.min(89.9, ll.lat)), wrapLon(ll.lng), res);
        if (!seen[cell]) { seen[cell] = 1; out.push(cell); }
      }
    }
    return out;
  }

  function paintOverlayH3() {
    ensureOverlayCanvas();
    var g = cachedRender.grid, probs = cachedRender.probs;
    var size = map.getSize();
    if (overlayCanvas.width !== size.x || overlayCanvas.height !== size.y) { overlayCanvas.width = size.x; overlayCanvas.height = size.y; }
    L.DomUtil.setPosition(overlayCanvas, map.containerPointToLayerPoint([0, 0]));
    var ctx = overlayCanvas.getContext("2d");
    ctx.clearRect(0, 0, size.x, size.y);

    var cells = h3CellsInView(h3ResForView());
    // Only draw hexes whose centre lies within the computed data region, so the
    // overlay never spills predicted colour outside what was actually evaluated.
    for (var i = 0; i < cells.length; i++) {
      var ll = window.h3.cellToLatLng(cells[i]);
      var lonU = ll[1]; while (lonU < g.west) lonU += 360; while (lonU > g.east) lonU -= 360;
      if (ll[0] > g.north + 1e-9 || ll[0] < g.south - 1e-9 || lonU < g.west - 1e-9 || lonU > g.east + 1e-9) continue;
      var p = sampleGridProb(g, probs, ll[0], ll[1]);
      if (!(p >= 0.01)) continue;
      var bnd = window.h3.cellToBoundary(cells[i]);
      // Skip hexes straddling the antimeridian (would smear across the map).
      var minLon = 999, maxLon = -999;
      for (var w = 0; w < bnd.length; w++) { if (bnd[w][1] < minLon) minLon = bnd[w][1]; if (bnd[w][1] > maxLon) maxLon = bnd[w][1]; }
      if (maxLon - minLon > 180) continue;
      ctx.beginPath();
      for (var v = 0; v < bnd.length; v++) {
        var pt = map.latLngToContainerPoint([bnd[v][0], bnd[v][1]]);
        if (v === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
      }
      ctx.closePath();
      var col = colormapLookup(p);
      ctx.fillStyle = "rgba(" + col[0] + "," + col[1] + "," + col[2] + "," + Math.min(1, 0.25 + p * 0.75).toFixed(3) + ")";
      ctx.fill();
    }
  }

  // Smooth-heatmap fallback: bilinearly interpolate the PROBABILITY SCALAR (in
  // longitude, linear in screen-x, and latitude, mapped back per Mercator row),
  // then colourise each pixel. Built at ~screen resolution, drawn ~1:1.
  function paintOverlaySmooth() {
    if (!cachedRender || !map) return;
    ensureOverlayCanvas();

    var g = cachedRender.grid, probs = cachedRender.probs;
    var size = map.getSize();
    if (overlayCanvas.width !== size.x || overlayCanvas.height !== size.y) {
      overlayCanvas.width = size.x;
      overlayCanvas.height = size.y;
    }
    L.DomUtil.setPosition(overlayCanvas, map.containerPointToLayerPoint([0, 0]));
    var ctx = overlayCanvas.getContext("2d");
    ctx.clearRect(0, 0, size.x, size.y);

    var nw = map.latLngToContainerPoint([g.north, g.west]);
    var se = map.latLngToContainerPoint([g.south, g.east]);
    var destX = nw.x, destW = se.x - nw.x, destY = nw.y, destH = se.y - nw.y;
    if (destW <= 0 || destH <= 0) return;

    // Output buffer at (capped) screen resolution.
    var BW = Math.max(2, Math.min(Math.round(destW), 1100));
    var BH = Math.max(2, Math.min(Math.round(destH), 760));
    if (!offscreenCanvas) offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = BW;
    offscreenCanvas.height = BH;
    var octx = offscreenCanvas.getContext("2d");
    var img = octx.createImageData(BW, BH);
    var data = img.data;

    // Fractional cell-COLUMN index per output column (lon is linear in x).
    var col0 = new Int32Array(BW), col1 = new Int32Array(BW), colFrac = new Float64Array(BW);
    for (var ox = 0; ox < BW; ox++) {
      var cf = (ox + 0.5) / BW * g.nLon - 0.5;
      var c0 = Math.floor(cf);
      colFrac[ox] = Math.max(0, Math.min(1, cf - c0));
      col0[ox] = Math.max(0, Math.min(g.nLon - 1, c0));
      col1[ox] = Math.max(0, Math.min(g.nLon - 1, c0 + 1));
    }

    for (var oy = 0; oy < BH; oy++) {
      var sy = destY + (oy + 0.5) / BH * destH;
      var lat = map.containerPointToLatLng([destX, sy]).lat;   // Mercator-correct latitude
      var rf = (g.north - lat) / g.step - 0.5;
      var r0 = Math.floor(rf), fr = Math.max(0, Math.min(1, rf - r0));
      r0 = Math.max(0, Math.min(g.nLat - 1, r0));
      var r1 = Math.max(0, Math.min(g.nLat - 1, r0 + 1));
      var base0 = r0 * g.nLon, base1 = r1 * g.nLon, rowOff = oy * BW * 4;
      for (var ox2 = 0; ox2 < BW; ox2++) {
        var a = col0[ox2], b = col1[ox2], fc = colFrac[ox2];
        // bilinear on the scalar probability
        var top = probs[base0 + a] + (probs[base0 + b] - probs[base0 + a]) * fc;
        var bot = probs[base1 + a] + (probs[base1 + b] - probs[base1 + a]) * fc;
        var p = top + (bot - top) * fr;
        var col = colormapLookup(p);
        var o = rowOff + ox2 * 4;
        data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2];
        data[o + 3] = p >= 0.01 ? Math.round(Math.min(1, 0.25 + p * 0.75) * 255) : 0;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(offscreenCanvas, destX, destY, destW, destH);
  }

  // ---- Viewport grid -------------------------------------------------------
  function viewportGrid() {
    var b = map.getBounds();
    var south = Math.max(b.getSouth(), -90), north = Math.min(b.getNorth(), 90);
    var west = b.getWest(), east = b.getEast();
    if (east - west >= 360) { west = -180; east = 180; }
    else { west = wrapLon(west); east = wrapLon(east); if (east <= west) east += 360; }
    if (north - south < 0.1) north = south + 0.1;
    if (east - west < 0.1) east = west + 0.1;
    // The detail offset shifts sampling by whole zoom levels (one H3 resolution
    // ≈ 2.6458x finer per step), matching the range overlay's resolution steps.
    var step = (ZOOM_STEP[Math.round(map.getZoom())] || 3) / Math.pow(2.6458, hiResFactor | 0);
    south = Math.max(Math.floor(south / step) * step, -90);
    north = Math.min(Math.ceil(north / step) * step, 90);
    west = Math.floor(west / step) * step;
    east = Math.ceil(east / step) * step;
    return { south: south, north: north, west: west, east: east, step: step,
             nLat: Math.round((north - south) / step), nLon: Math.round((east - west) / step) };
  }

  // ---- Cell cache ----------------------------------------------------------
  function cacheKey(speciesKey, week) { return speciesKey + ":" + week; }
  function cellId(lat, lon) { return Math.round(lat * 100) + "," + Math.round(lon * 100); }

  function getCellMap(key, step) {
    var entry = renderCache.get(key);
    if (!entry || entry.step !== step) {
      entry = { step: step, cells: new Map() };
      renderCache.set(key, entry);
      if (renderCache.size > RENDER_CACHE_MAX) renderCache.delete(renderCache.keys().next().value);
    }
    return entry.cells;
  }

  function viewportMissing(cellMap, grid) {
    var pts = [];
    for (var iLat = 0; iLat < grid.nLat; iLat++) {
      var lat = grid.north - (iLat + 0.5) * grid.step;
      for (var iLon = 0; iLon < grid.nLon; iLon++) {
        var lon = wrapLon(grid.west + (iLon + 0.5) * grid.step);
        if (!cellMap.has(cellId(lat, lon))) pts.push({ lat: lat, lon: lon });
      }
    }
    return pts;
  }

  function buildViewportArray(cellMap, grid) {
    var arr = new Float32Array(grid.nLat * grid.nLon);
    var i = 0;
    for (var iLat = 0; iLat < grid.nLat; iLat++) {
      var lat = grid.north - (iLat + 0.5) * grid.step;
      for (var iLon = 0; iLon < grid.nLon; iLon++) {
        var lon = wrapLon(grid.west + (iLon + 0.5) * grid.step);
        arr[i++] = cellMap.get(cellId(lat, lon)) || 0;
      }
    }
    return arr;
  }

  function normalizeProbs(raw) {
    var maxProb = 0;
    for (var i = 0; i < raw.length; i++) if (raw[i] > maxProb) maxProb = raw[i];
    var norm = perceptualNorm(raw, maxProb);
    // Hide cells whose raw probability falls outside the min–max range slider
    // so the same control filters the species-range overlay.
    var pmin = +document.getElementById("prob-min").value / 100;
    var pmax = +document.getElementById("prob-max").value / 100;
    if (pmin > 0 || pmax < 1) {
      for (var j = 0; j < raw.length; j++) if (raw[j] < pmin || raw[j] > pmax) norm[j] = 0;
    }
    return { probs: norm, maxProb: maxProb };
  }

  // Weeks to compute for a range/richness render: just the selected week
  // normally, or all 48 when precomputing for migration animation.
  function weeksToCompute() {
    if (animateAll) {
      var a = [];
      for (var w = 1; w <= 48; w++) a.push(w);
      return a;
    }
    return [+document.getElementById("week-select").value];
  }

  // Cells per inference call. The model emits labels.length (~12k) floats per
  // cell, so we cap the output buffer at ~32 MB to bound worker memory and
  // avoid tab crashes when sweeping large viewports / all 48 weeks.
  function inferChunk() {
    return Math.max(256, Math.floor(8000000 / labels.length));
  }

  // ---- Range map -----------------------------------------------------------
  // The selected species' name shown above the map in Range mode — clickable
  // (same context menu as a species-list name).
  function updateRangeSpecies() {
    var el = document.getElementById("range-species");
    if (!el) return;
    var key = document.getElementById("species-search").dataset.selectedKey;
    if (currentMode === "range" && key && labelsByKey[key]) {
      var wk = +document.getElementById("week-select").value;
      el.innerHTML = nameLinkHtml(labelsByKey[key]) + ' <span class="rng-wk">· ' + escapeHtml(weekText(wk)) + "</span>";
      el.style.display = "block";
    } else {
      el.innerHTML = "";
      el.style.display = "none";
    }
  }

  // Species Range overlay, computed and cached per H3 cell. Only the cells
  // visible at the current zoom that aren't already cached are inferred, so
  // zooming/panning back over an area costs nothing.
  async function renderRangeMap() {
    if (!animateAll) invalidateAnimation();   // a fresh single-week render makes any precomputed animation stale
    var key = document.getElementById("species-search").dataset.selectedKey;
    updateRangeSpecies();
    if (!key || !labelsByKey[key] || !window.h3) return;
    if (rendering) { renderGeneration++; return; }
    var gen = ++renderGeneration;
    var lbl = labelsByKey[key], speciesIdx = lbl.index, name = speciesName(lbl);
    var selectedWeek = +document.getElementById("week-select").value;
    var weeks = weeksToCompute(), CHUNK = inferChunk();
    var res = h3ResForView(), cells = h3CellsInView(res);
    var approxStep = +(window.h3.getHexagonEdgeLengthAvg(res, "m") / 111320).toFixed(3);

    // Collect the (week, cell) pairs not yet in the cache.
    var missing = [];
    weeks.forEach(function (w) {
      var cache = h3RangeCacheFor(key + ":" + w);
      for (var i = 0; i < cells.length; i++) if (!(cells[i] in cache)) missing.push({ w: w, c: cells[i], cache: cache });
    });

    if (missing.length === 0) {   // fully cached for this view
      cachedRender = { h3range: true, tag: key + ":" + selectedWeek };
      paintOverlay();
      setStatus(t("status.rangeCached", { name: name, week: weekText(selectedWeek), n: cells.length.toLocaleString(), step: approxStep }));
      updateLegend(); updateMapCsv();
      return;
    }

    rendering = true;
    showComputingOverlay(true, name);
    var total = Math.ceil(missing.length / CHUNK), done = 0;
    try {
      for (var s = 0; s < missing.length; s += CHUNK) {
        if (gen !== renderGeneration) return;
        var batch = missing.slice(s, s + CHUNK);
        var inputs = new Float32Array(batch.length * 3);
        for (var j = 0; j < batch.length; j++) {
          var ll = window.h3.cellToLatLng(batch[j].c);
          inputs[j * 3] = ll[0]; inputs[j * 3 + 1] = ll[1]; inputs[j * 3 + 2] = batch[j].w;
        }
        // Worker returns just this species' column (batch.length floats).
        var out = await runInference(inputs, batch.length, { task: "column", speciesIdx: speciesIdx });
        for (var k = 0; k < batch.length; k++) batch[k].cache[batch[k].c] = out[k];
        setComputeProgress(++done / total);
        setStatus(t("status.computing", { name: name, week: weekText(selectedWeek), n: missing.length, i: done, total: total }));
        if (gen === renderGeneration) { cachedRender = { h3range: true, tag: key + ":" + selectedWeek }; paintOverlay(); }
      }
      if (gen !== renderGeneration) return;
      cachedRender = { h3range: true, tag: key + ":" + selectedWeek };
      paintOverlay();
      setStatus(t("status.rangeDone", { name: name, week: weekText(selectedWeek), n: cells.length.toLocaleString(), step: approxStep }));
      updateLegend(); updateMapCsv(); scheduleH3Save();
    } catch (e) { setStatus(t("status.error", { msg: e.message })); console.error(e); }
    finally { rendering = false; showComputingOverlay(false); if (gen !== renderGeneration) triggerRender(); }
  }

  // ---- Cached week switch --------------------------------------------------
  function showCachedWeek() {
    var week = +document.getElementById("week-select").value;
    var g = viewportGrid();

    if (currentMode === "richness") {
      var cm = getCellMap(cacheKey(richKey(),week), g.step);
      if (viewportMissing(cm, g).length === 0) {
        var raw = buildViewportArray(cm, g);
        var maxVal = 0;
        for (var i = 0; i < raw.length; i++) if (raw[i] > maxVal) maxVal = raw[i];
        cachedRender = { grid: g, probs: perceptualNorm(raw, maxVal), maxVal: maxVal, product: "richness" };
        paintOverlay();
        setStatus(t("status.richnessCached", { week: weekText(week), n: g.nLat * g.nLon, step: fmtStep(g.step) }));
        updateLegend();
        updateMapCsv();
      } else { renderRichness(); }
      return;
    }

    var key = document.getElementById("species-search").dataset.selectedKey;
    if (!key || !labelsByKey[key] || !window.h3) return;
    // Range: paint from the H3 cache if every visible cell for this week is
    // cached (e.g. animation playback); otherwise compute the missing cells.
    var cache = h3RangeCache.get(key + ":" + week);
    var cells = h3CellsInView(h3ResForView());
    var allCached = cache && cells.every(function (c) { return c in cache; });
    if (allCached) {
      cachedRender = { h3range: true, tag: key + ":" + week };
      paintOverlay();
      setStatus(t("status.rangeCached", { name: speciesName(labelsByKey[key]), week: weekText(week), n: cells.length, step: "" }));
      updateLegend();
      updateMapCsv();
    } else { renderRangeMap(); }
  }

  // ---- Species richness ----------------------------------------------------
  var RICHNESS_THRESHOLD = 0.05;

  async function renderRichness() {
    if (!animateAll) invalidateAnimation();   // a fresh single-week render makes any precomputed animation stale
    if (rendering) { renderGeneration++; return; }
    var gen = ++renderGeneration;
    var selectedWeek = +document.getElementById("week-select").value;
    var weeks = weeksToCompute(), nSpecies = labels.length, CHUNK = inferChunk();
    var g = viewportGrid(), totalPoints = g.nLat * g.nLon;
    var richName = t("legend.count");

    var weekMissing = [];
    weeks.forEach(function (w) {
      var cm = getCellMap(cacheKey(richKey(),w), g.step);
      var miss = viewportMissing(cm, g);
      if (miss.length > 0) weekMissing.push({ week: w, missing: miss, cellMap: cm });
    });

    if (weekMissing.length === 0) {
      var raw = buildViewportArray(getCellMap(cacheKey(richKey(),selectedWeek), g.step), g);
      var maxVal = 0;
      for (var i = 0; i < raw.length; i++) if (raw[i] > maxVal) maxVal = raw[i];
      cachedRender = { grid: g, probs: perceptualNorm(raw, maxVal), maxVal: maxVal, product: "richness" };
      paintOverlay();
      setStatus(t("status.richnessCached", { week: weekText(selectedWeek), n: totalPoints.toLocaleString(), step: fmtStep(g.step) }));
      updateLegend();
      updateMapCsv();
      return;
    }

    rendering = true;
    showComputingOverlay(true, richName);
    var mask = groupMask();
    var chunksTotal = totalChunks(weekMissing, CHUNK), chunksDone = 0;
    try {
      for (var wi = 0; wi < weekMissing.length; wi++) {
        var wm = weekMissing[wi];
        setStatus(t("status.computing", { name: richName, week: weekText(wm.week), n: wm.missing.length, i: wi + 1, total: weekMissing.length }));
        var inputs = new Float32Array(wm.missing.length * 3);
        for (var ii = 0; ii < wm.missing.length; ii++) {
          inputs[ii * 3] = wm.missing[ii].lat;
          inputs[ii * 3 + 1] = wm.missing[ii].lon;
          inputs[ii * 3 + 2] = wm.week;
        }
        var counts = new Float32Array(wm.missing.length);
        for (var start = 0; start < wm.missing.length; start += CHUNK) {
          if (gen !== renderGeneration) return;
          var end = Math.min(start + CHUNK, wm.missing.length);
          // Worker counts species ≥ threshold (optionally masked to a group)
          // and returns one count per cell.
          var out = await runInference(inputs.subarray(start * 3, end * 3), end - start,
            { task: "richness", threshold: RICHNESS_THRESHOLD, mask: mask });
          for (var j = 0; j < end - start; j++) counts[start + j] = out[j];
          setComputeProgress(++chunksDone / chunksTotal);
        }
        if (gen !== renderGeneration) return;
        for (var k = 0; k < wm.missing.length; k++) wm.cellMap.set(cellId(wm.missing[k].lat, wm.missing[k].lon), counts[k]);
        if (wm.week === selectedWeek) {
          var rawW = buildViewportArray(wm.cellMap, g);
          var maxV = 0;
          for (var m = 0; m < rawW.length; m++) if (rawW[m] > maxV) maxV = rawW[m];
          cachedRender = { grid: g, probs: perceptualNorm(rawW, maxV), maxVal: maxV, product: "richness" };
          paintOverlay();
        }
      }
      var rawF = buildViewportArray(getCellMap(cacheKey(richKey(),selectedWeek), g.step), g);
      var maxF = 0;
      for (var n = 0; n < rawF.length; n++) if (rawF[n] > maxF) maxF = rawF[n];
      cachedRender = { grid: g, probs: perceptualNorm(rawF, maxF), maxVal: maxF, product: "richness" };
      paintOverlay();
      setStatus(t("status.richnessDone", { week: weekText(selectedWeek), n: totalPoints.toLocaleString(), step: fmtStep(g.step) }));
      updateLegend();
      updateMapCsv();
    } catch (e) { setStatus(t("status.error", { msg: e.message })); console.error(e); }
    finally { rendering = false; showComputingOverlay(false); if (gen !== renderGeneration) triggerRender(); }
  }

  // ---- Species list --------------------------------------------------------
  // Re-render the per-point species list at the current marker. Used by control
  // changes (compare, 2nd name, group, week, probability range) — applies in
  // both Species List and Species Range mode (both show the list on click).
  function rerenderPointList() {
    if (!marker) return;
    var ll = marker.getLatLng();
    if (currentMode === "list" || currentMode === "range") renderSpeciesList(ll.lat, ll.lng);
  }

  // True when the click landed within ~thresholdPx of any plotted detection
  // marker, so we can avoid covering it with the species-list popup just
  // because the user tapped a hair beside the dot they were aiming at.
  function clickNearDetection(latlng, thresholdPx) {
    if (!map) return false;
    var clickPt = map.latLngToContainerPoint(latlng);
    var th = thresholdPx || 16, hit = false;
    function check(layerGroup) {
      if (!layerGroup) return;
      layerGroup.eachLayer(function (m) {
        if (hit || !m.getLatLng) return;
        var p = map.latLngToContainerPoint(m.getLatLng());
        if (Math.hypot(p.x - clickPt.x, p.y - clickPt.y) <= th) hit = true;
      });
    }
    Object.keys(detPlot || {}).some(function (k) { check(detPlot[k] && detPlot[k].group); return hit; });
    check(mpLayer);   // user-added map points also count
    return hit;
  }
  // Drop the interactive location pin at a point and run the mode's action:
  // List → the point-options popup (Species list / Checklist), Migration →
  // analysis, Range → the inline species list. Shared by map clicks and the
  // place search so a searched location behaves exactly like a clicked one.
  function selectMapPoint(lat, lon) {
    if (placeMarker) { map.removeLayer(placeMarker); placeMarker = null; }
    if (marker) map.removeLayer(marker);
    marker = L.marker([lat, lon]).addTo(map);
    if (currentMode === "barchart") renderAnalysis(lat, lon);
    else if (currentMode === "range") renderSpeciesList(lat, lon);
    else bindPointPopup(marker, lat, lon);   // list (and any click-driven default)
  }
  function onMapClick(e) {
    // Debounce every map click: ignore any click that lands within 200 ms of the
    // previous one (rapid double-taps, or a legend re-render leaking through).
    if (Date.now() < mapClickGuardUntil) return;
    mapClickGuardUntil = Date.now() + 200;
    // List + Range show the per-point species list; Migration the analysis.
    if (["list", "barchart", "range"].indexOf(currentMode) < 0) return;
    // Don't fire the point-options popup if the user was tapping a plotted
    // detection (or just a few pixels off it).
    if (clickNearDetection(e.latlng)) return;
    // Normalize: latitude clamped to [-90, 90]; longitude wrapped to [-180, 180]
    // (a click on a panned world-copy can otherwise give e.g. lon = 635).
    selectMapPoint(Math.max(-90, Math.min(90, e.latlng.lat)), wrapLon(e.latlng.lng));
  }

  function makePopupBtn(label, cls, fn) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "demo-btn " + (cls || "");
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  // Map-click popup: choose the Species list, or open the country's Fatbirder /
  // BirdLife page (resolved by reverse-geocoding the point). Checklists are
  // started from within the Species list itself.
  function bindPointPopup(mk, lat, lon) {
    var wrap = document.createElement("div");
    wrap.className = "map-choose";
    wrap.appendChild(makePopupBtn(t("mode.list"), "", function () { mk.closePopup(); renderSpeciesList(lat, lon); }));
    wrap.appendChild(makePopupBtn(t("link.spInCountry"), "", function () { mk.closePopup(); renderSpeciesInCountry(lat, lon); }));
    wrap.appendChild(makePopupBtn(t("link.fatbirder"), "demo-btn-light", function () {
      mk.closePopup();
      countryInfo(lat, lon).then(function (info) { openExternal(fatbirderUrl(info.cc, info.name)); });
    }));
    wrap.appendChild(makePopupBtn(t("link.birdlife"), "demo-btn-light", function () {
      mk.closePopup();
      countryInfo(lat, lon).then(function (info) { openExternal(birdLifeCountryUrl(info.cc, info.name)); });
    }));
    // National observation/registration services for this point's country
    // (built-in + the user's custom links). Appended once the reverse-geocode
    // resolves so the popup opens instantly.
    countryInfo(lat, lon).then(function (info) {
      var svcs = natServicesFor(info.cc);
      if (!svcs.length) return;
      svcs.forEach(function (s) {
        wrap.appendChild(makePopupBtn(s.label + " ↗", "demo-btn-light", function () {
          mk.closePopup(); openExternal(s.url);
        }));
      });
      var pop = mk.getPopup(); if (pop && pop.isOpen()) pop.update();   // re-layout for added buttons
    }).catch(function () { /* leave as-is */ });
    mk.bindPopup(wrap, { closeButton: true, autoClose: false, autoPan: true, className: "choose-popup", offset: [0, -8] });
    mk.openPopup();
  }

  // Compute the per-species comparison probabilities for the "change" column.
  // Returns { probs: Float32Array|null, refLabel: string } where probs is
  // aligned to the label index, or null when no comparison is selected.
  async function computeComparison(lat, lon, week) {
    var mode = document.getElementById("compare-select").value;
    var nSpecies = labels.length, wkIdx = week - 1;
    if (mode === "prev" || mode === "next") {
      var cw = mode === "prev" ? (week - 1 < 1 ? 48 : week - 1) : (week + 1 > 48 ? 1 : week + 1);
      var out = await runInference(new Float32Array([lat, lon, cw]), 1);
      return { probs: out, refLabel: weekText(cw), kind: "delta" };
    }
    if (mode === "mean" || mode === "annualmax" || mode === "annualtop") {
      var inputs = new Float32Array(48 * 3);
      for (var w = 0; w < 48; w++) { inputs[w * 3] = lat; inputs[w * 3 + 1] = lon; inputs[w * 3 + 2] = w + 1; }
      var all = await runInference(inputs, 48);
      var agg = new Float32Array(nSpecies), s, wk, v;
      if (mode === "annualmax") {
        // Per-species peak probability; the list shows current ÷ peak (ratio).
        for (s = 0; s < nSpecies; s++) {
          var mx = 0;
          for (wk = 0; wk < 48; wk++) { v = all[wk * nSpecies + s]; if (v > mx) mx = v; }
          agg[s] = mx;
        }
        return { probs: agg, refLabel: t("compare.max"), kind: "ratio" };
      }
      if (mode === "annualtop") {
        // Per-species "Annual Top" (focus) value at the current week (0–100).
        var scratch = new Float32Array(48);
        for (s = 0; s < nSpecies; s++) {
          var mxt = 0;
          for (wk = 0; wk < 48; wk++) { v = all[wk * nSpecies + s]; scratch[wk] = v; if (v > mxt) mxt = v; }
          agg[s] = window.GeoAnalysis.focusSeries(scratch, mxt)[wkIdx];
        }
        return { probs: agg, refLabel: t("compare.annualtop"), kind: "focus" };
      }
      for (s = 0; s < nSpecies; s++) {
        var sum = 0;
        for (wk = 0; wk < 48; wk++) sum += all[wk * nSpecies + s];
        agg[s] = sum / 48;
      }
      return { probs: agg, refLabel: t("compare.mean"), kind: "delta" };
    }
    return { probs: null, refLabel: "", kind: null };
  }

  function deltaCell(delta) {
    var pct = Math.round(delta * 100);
    var cls = delta > 0.001 ? "delta-up" : (delta < -0.001 ? "delta-down" : "delta-flat");
    var arrow = delta > 0.001 ? "\u25b2" : (delta < -0.001 ? "\u25bc" : "\u00b7");
    return '<td class="' + cls + '">' + arrow + (pct >= 0 ? "+" : "") + pct + "%</td>";
  }

  // Cell for "Annual max" comparison: current week as a fraction of the
  // species' annual peak (0\u2013100%), tinted red(off-peak)\u2192green(at peak).
  // Shared probability palette: red (hue 10, low) -> green (hue 130, high),
  // matching the migration analysis heatmaps. n in [0, 1].
  function probHueColor(n) {
    n = Math.max(0, Math.min(1, n));
    return "hsl(" + (10 + n * 120) + ", 60%, 42%)";
  }
  function ratioCell(ratio) {
    var r = Math.max(0, Math.min(1, ratio));
    return '<td class="ratio-cell" style="background:' + probHueColor(r) + '">' + (r * 100).toFixed(0) + "%</td>";
  }

  // Cell for the "Annual Top" comparison: focus value 0–100, tinted red→green.
  function focusCell(v) {
    var n = Math.max(0, Math.min(100, v));
    return '<td class="ratio-cell" style="background:' + probHueColor(n / 100) + '">' + Math.round(n) + "</td>";
  }

  // Species List comparison cell as a probability-style bar (used when every
  // value in the column is positive). pct scaled by kind: focus is already
  // 0–100; ratio/delta are fractions → ×100.
  function cmpBarCell(kind, v) {
    var pct = Math.max(0, Math.min(100, kind === "focus" ? v : v * 100));
    var label = kind === "focus" ? String(Math.round(v))
      : Math.round(v * 100) + "%";
    return '<td class="cmp-bar-cell"><span class="cmp-num">' + label + '</span><div class="cmp-bar" style="width:' + Math.round(pct) + '%;background:' + probHueColor(pct / 100) + '"></div></td>';
  }

  // Reverse-geocoded place names for the coords line, cached per location.
  var placeCache = {};
  function placeKey(lat, lon) { return lat.toFixed(3) + "," + lon.toFixed(3); }

  // Set a coords/summary line, prefixed with the resolved place name. The base
  // summary shows immediately; the place name is prepended once resolved (and
  // re-applied on later renders at the same location via the cache).
  function setCoordsWithPlace(el, lat, lon, baseSummary) {
    if (!el) return;
    var k = placeKey(lat, lon);
    el.dataset.base = baseSummary;
    el.dataset.placeKey = k;
    var apply = function (name) { el.textContent = (name ? name + " · " : "") + el.dataset.base; };
    if (placeCache[k] !== undefined) { apply(placeCache[k]); return; }
    el.textContent = baseSummary;
    reverseGeocode(lat, lon).then(function (name) {
      placeCache[k] = name || "";
      if (el.dataset.placeKey === k) apply(placeCache[k]);
    });
  }

  // A detailed, specific place name (the actual locality — building/park/road/
  // neighbourhood, plus the town/city), not the county or country. Cached.
  var placeDetailCache = {};
  function detailedPlaceLabel(j) {
    var a = (j && j.address) || {};
    var specific = (j && j.name) || a.amenity || a.leisure || a.tourism || a.building ||
      a.natural || a.water || a.peak || a.road || a.pedestrian || a.neighbourhood ||
      a.suburb || a.quarter || a.hamlet || a.city_district || a.village || "";
    var town = a.town || a.city || a.village || a.municipality || "";
    if (specific && town && specific !== town) return specific + ", " + town;
    return specific || town || a.county || a.state || a.country || (j && j.display_name) || "";
  }
  function detailedPlaceName(lat, lon) {
    var k = lat.toFixed(4) + "," + lon.toFixed(4);
    if (placeDetailCache[k] !== undefined) return Promise.resolve(placeDetailCache[k]);
    return fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=" + lat + "&lon=" + lon, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { var n = detailedPlaceLabel(j); placeDetailCache[k] = n; return n; })
      .catch(function () { placeDetailCache[k] = ""; return ""; });
  }

  function haversineKm(la1, lo1, la2, lo2) {
    var R = 6371, dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
    var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  // Named natural features / reserves / parks / places near a point, from the
  // Overpass API, nearest first (the things reverse-geocoding tends to skip).
  function nearbyPlaces(lat, lon) {
    var R = 1000;   // metres
    var f = "(nwr(around:" + R + "," + lat + "," + lon + ")[name][natural];" +
      'nwr(around:' + R + ',' + lat + ',' + lon + ')[name][leisure~"^(nature_reserve|park)$"];' +
      'nwr(around:' + R + ',' + lat + ',' + lon + ')[name][boundary~"^(protected_area|national_park)$"];' +
      'nwr(around:' + R + ',' + lat + ',' + lon + ')[name][place];);';
    var q = "[out:json][timeout:25];" + f + "out tags center 120;";
    return fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var seen = {}, out = [];
        (j.elements || []).forEach(function (e) {
          var nm = e.tags && e.tags.name; if (!nm) return;
          var ela = e.lat != null ? e.lat : (e.center && e.center.lat);
          var elo = e.lon != null ? e.lon : (e.center && e.center.lon);
          if (ela == null) return;
          var d = haversineKm(lat, lon, ela, elo);
          if (seen[nm] != null) { if (d < seen[nm]) seen[nm] = d; return; }
          seen[nm] = d; out.push({ name: nm, dist: d });
        });
        out.forEach(function (o) { o.dist = seen[o.name]; });
        out.sort(function (a, b) { return a.dist - b.dist; });
        return out.slice(0, 30);
      });
  }
  function hidePlacePicker() { var p = document.getElementById("place-picker"); if (p) p.style.display = "none"; }
  // Set (and persist for this point) the field-checklist title.
  function setFieldTitle(name) {
    document.getElementById("field-coords").value = name;
    persistFieldTitle((name || "").trim());
  }
  function openPlacePicker() {
    var p = document.getElementById("place-picker"), list = document.getElementById("place-list");
    p.style.display = "block";
    // Section 1: your other checklists — selecting one merges it into this list.
    var lists = buildChecklistItems(getFieldChecklists()).filter(function (it) { return it.pkey !== fieldKey; });
    lists.forEach(function (it) { it.dist = (typeof fieldLat === "number" && it.lat != null) ? haversineKm(fieldLat, fieldLon, it.lat, it.lon) : null; });
    lists.sort(function (a, b) { return (a.dist == null ? Infinity : a.dist) - (b.dist == null ? Infinity : b.dist); });
    var distLabel = function (d) { return d == null ? "" : (d < 1 ? Math.round(d * 1000) + " m" : d.toFixed(1) + " km"); };
    var listsHtml = lists.length ? ('<div class="pp-head">' + escapeHtml(t("ctrl.checklists")) + "</div>" +
      lists.map(function (it) {
        return '<button type="button" class="pp-item pp-merge" data-id="' + escapeHtml(it.pkey) + '">⤭ ' + escapeHtml(it.name) + '<span class="pp-dist">' + distLabel(it.dist) + "</span></button>";
      }).join("")) : "";
    var placesHead = '<div class="pp-head">' + escapeHtml(t("place.nearby")) + "</div>";
    list.innerHTML = listsHtml + placesHead + '<div class="spinner" style="margin:18px auto"></div>';
    nearbyPlaces(fieldLat, fieldLon).then(function (rows) {
      var placesHtml = rows.length ? rows.map(function (r) {
        return '<button type="button" class="pp-item" data-name="' + escapeHtml(r.name) + '">' + escapeHtml(r.name) + '<span class="pp-dist">' + distLabel(r.dist) + "</span></button>";
      }).join("") : '<p class="recent-none">' + escapeHtml(t("place.none")) + "</p>";
      list.innerHTML = listsHtml + placesHead + placesHtml;
    }).catch(function () { list.innerHTML = listsHtml + placesHead + '<p class="recent-none">' + escapeHtml(t("place.none")) + "</p>"; });
  }

  // ---- Field checklist (mobile live entry) ---------------------------------
  // A checklist is a day-scoped record per location, keyed by placeKey@DAY, and
  // is *built from an append-only observation log*: every sighting (a tick, a
  // count change, or an explicit ＋) appends an entry stamped with its time and
  // coordinates. The visible per-species rows are an aggregation of that log,
  // so no detail (when/where each observation happened) is ever lost.
  //   record = { id, title, lat, lon, day, createdAt, log: [ entry, … ] }
  //   entry  = { ts, lat, lon, key, count, act, note }
  function getFieldChecklists() { return window.GeoState.get("fieldChecklists", {}) || {}; }
  function saveFieldChecklists(o) { window.GeoState.save({ fieldChecklists: o }); }
  function todayStr() { var d = new Date(); return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function listIdFor(lat, lon, day) { return placeKey(lat, lon) + "@" + (day || todayStr()); }
  function dayOf(rec) { return rec.day || (rec.createdAt ? String(rec.createdAt).slice(0, 10) : todayStr()); }

  // Migrate a legacy {entries:{key:{seen,count,act,note}}} record to the
  // log-based shape, synthesising one log entry per recorded species.
  function migrateFieldRecord(rec, id) {
    if (!rec || rec.log) return rec;
    var ts = rec.createdAt ? (Date.parse(rec.createdAt) || Date.now()) : Date.now();
    var day = rec.createdAt ? String(rec.createdAt).slice(0, 10) : todayStr();
    var log = [], seen = {}, entries = rec.entries || {};
    Object.keys(entries).forEach(function (key) {
      var e = entries[key] || {};
      if (!e.seen && (e.count == null || e.count === "") && !e.act && !e.note) return;
      log.push({ id: "e" + (ts).toString(36) + Math.random().toString(36).slice(2, 6), ts: ts, lat: rec.lat, lon: rec.lon, key: key, count: e.count != null ? +e.count : null, act: e.act || "", note: e.note || "" });
      seen[key] = true;
    });
    return { id: id, title: rec.title || "", lat: rec.lat, lon: rec.lon, day: day, createdAt: rec.createdAt || new Date(ts).toISOString(), log: log, seen: seen };
  }
  function getFieldRecord(id) {
    var all = getFieldChecklists(), rec = all[id], changed = false;
    if (!rec) return null;
    if (!rec.log) { rec = migrateFieldRecord(rec, id); all[id] = rec; changed = true; }
    if (!rec.seen) { rec.seen = {}; rec.log.forEach(function (e) { rec.seen[e.key] = true; }); changed = true; }   // backfill seen flags
    rec.log.forEach(function (e) { if (!e.id) { e.id = "e" + (e.ts || Date.now()).toString(36) + Math.random().toString(36).slice(2, 6); changed = true; } });
    if (changed) { all[id] = rec; saveFieldChecklists(all); }
    return rec;
  }
  function newFieldRecord(id, lat, lon) {
    return { id: id, title: "", lat: lat, lon: lon, day: todayStr(), createdAt: new Date().toISOString(), log: [], seen: {} };
  }
  // The currently open record (optionally creating it on first write).
  function curFieldRecord(create) {
    if (!fieldKey) return null;
    return getFieldRecord(fieldKey) || (create ? newFieldRecord(fieldKey, fieldLat, fieldLon) : null);
  }
  function putFieldRecord(rec) {
    // Give a freshly-recorded list a real place name (not coordinates) as soon
    // as it has content, using the resolved name for its location when known.
    if (!(rec.title || "").trim() && rec.log.length) {
      var nm = fieldNameCache[String(rec.id).split("@")[0]];
      if (nm) rec.title = nm;
    }
    var all = getFieldChecklists();
    var hasSeen = rec.seen && Object.keys(rec.seen).length;
    if (!rec.log.length && !hasSeen && !(rec.title || "").trim()) delete all[rec.id];   // drop empty + untitled
    else all[rec.id] = rec;
    saveFieldChecklists(all);
    refreshChecklists();
  }

  // Sum a (possibly merged, comma-listed) count value numerically.
  function countNum(c) {
    if (c == null || c === "") return 0;
    if (typeof c === "number") return c;
    return String(c).split(/[^0-9.]+/).reduce(function (s, x) { return s + (+x || 0); }, 0);
  }
  // Aggregate a record's log into per-species rows (summed count, latest
  // activity/note, number of distinct observations). Seen is a separate flag.
  function fcAggregate(rec) {
    var agg = {};
    ((rec && rec.log) || []).forEach(function (e) {
      var a = agg[e.key] || (agg[e.key] = { count: 0, n: 0, act: "", note: "", lastTs: -1 });
      a.count += countNum(e.count); a.n++;
      if ((e.ts || 0) >= a.lastTs) { a.lastTs = e.ts || 0; a.act = e.act || ""; a.note = e.note || ""; }
    });
    return agg;
  }
  // Render-shaped view ({key:{seen,count,act,note,n}}) used by exports/badge.
  // `seen` is the checkbox flag (rec.seen), independent of having entries.
  function getFieldEntries() {
    var rec = curFieldRecord(false); if (!rec) return {};
    var agg = fcAggregate(rec), seenSet = rec.seen || {}, out = {};
    Object.keys(agg).forEach(function (k) {
      var a = agg[k], c = a.count > 0 ? a.count : 0;
      out[k] = { seen: !!seenSet[k], count: c > 0 ? c : null, act: a.act || undefined, note: a.note || undefined, n: a.n };
    });
    Object.keys(seenSet).forEach(function (k) { if (!out[k]) out[k] = { seen: true, count: null, n: 0 }; });
    return out;
  }
  function fcLatest(rec, key) { var last = null; rec.log.forEach(function (e) { if (e.key === key && (!last || (e.ts || 0) >= (last.ts || 0))) last = e; }); return last; }
  // A species' log entries (chronological).
  function fcEntriesFor(rec, key) { return ((rec && rec.log) || []).filter(function (e) { return e.key === key; }).sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); }); }
  function fcIsSeen(key) { var rec = curFieldRecord(false); return !!(rec && rec.seen && rec.seen[key]); }

  // Transient per-species compose draft backing the top-line inputs (count,
  // activity, note); not persisted until committed via ＋ or a first tick.
  var composeDraft = {};
  function cd(key) { return composeDraft[key] || (composeDraft[key] = { count: null, act: "", note: "", sex: "" }); }
  function eid() { return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // Sex/age toggle on each log entry. Cycle order: none → male → female →
  // couple → looks-female (female-type) → back to none. Default is none.
  var SEX_CYCLE = ["", "m", "f", "p", "fl"];
  function sexGlyph(s) {
    return s === "m" ? "♂" : s === "f" ? "♀" : s === "p" ? "⚥" : s === "fl" ? "♀?" : "·";
  }
  // Female-like ("looks female") marker: a single composed gender symbol — a
  // question mark sitting atop the female sign's cross — shown instead of a
  // two-character "♀?". Used wherever the glyph is rendered as HTML; text-only
  // sinks (CSV export, native <option>) fall back to sexGlyph()'s "♀?".
  var FL_GLYPH_SVG = '<svg class="sx-fl" viewBox="0 0 18 28" aria-label="♀?" role="img">' +
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4.67 4.5 A5 5 0 1 1 9 12"/>' +  // female circle, open ~120deg from the stem toward the left (question-mark hook)
      '<line x1="9" y1="12" x2="9" y2="21"/>' +        // female cross — vertical
      '<line x1="5" y1="16.5" x2="13" y2="16.5"/>' +   // female cross — horizontal
    '</g>' +
    '<circle cx="9" cy="24.6" r="1.4" fill="currentColor"/>' +   // dot underneath
    '</svg>';
  function sexGlyphHtml(s) {
    return s === "fl" ? FL_GLYPH_SVG : escapeHtml(sexGlyph(s));
  }
  function nextSex(cur) {
    var i = SEX_CYCLE.indexOf(cur || ""); return SEX_CYCLE[(i + 1) % SEX_CYCLE.length];
  }
  function setFcSex(key, sex) {
    cd(key).sex = sex || "";
    var btn = document.querySelector('#field-list .fc-card[data-key="' + key + '"] .fc-sex-btn');
    if (btn) { btn.innerHTML = sexGlyphHtml(sex); btn.classList.toggle("has-sex", !!sex); }
  }

  // Append an observation entry to the open list (with id, time, location).
  function fcAppend(key, count, note, act, sex) {
    var rec = curFieldRecord(true); if (!rec) return;
    var loc = regLocation(), eId = eid();
    rec.log.push({ id: eId, ts: Date.now(), lat: loc.lat, lon: loc.lon, key: key, count: (count != null && count !== "" ? count : null), act: act || "", note: (note || "").trim(), sex: sex || "" });
    rec.seen = rec.seen || {}; rec.seen[key] = true;
    rec.lat = fieldLat; rec.lon = fieldLon;
    putFieldRecord(rec);
    freshenEntryLocation(eId);
  }
  // ＋ : commit the species' compose draft as a new entry, then clear it.
  function fcCommitCompose(key) {
    var d = composeDraft[key] || {};
    fcAppend(key, d.count, d.note, d.act, d.sex);
    composeDraft[key] = { count: null, act: "", note: "", sex: "" };
  }
  function fcUpdateEntry(id, patch) {
    var rec = curFieldRecord(false); if (!rec) return;
    var e = rec.log.filter(function (x) { return x.id === id; })[0]; if (!e) return;
    for (var k in patch) e[k] = patch[k];
    putFieldRecord(rec);
  }
  function fcDeleteEntry(id) {
    var rec = curFieldRecord(false); if (!rec) return;
    var e = rec.log.filter(function (x) { return x.id === id; })[0];
    rec.log = rec.log.filter(function (x) { return x.id !== id; });
    // If that was the species' last entry it's no longer "seen" — clear the
    // flag so the card's tint goes back to white.
    if (e && rec.seen && rec.seen[e.key] && !fcEntriesFor(rec, e.key).length) delete rec.seen[e.key];
    putFieldRecord(rec);
  }
  // Merge selected entries into one that LISTS the values (counts/activities/
  // notes joined), keeping the earliest time and its location.
  function fcMergeEntries(ids) {
    var rec = curFieldRecord(false); if (!rec) return;
    var sel = rec.log.filter(function (e) { return ids.indexOf(e.id) >= 0; });
    if (sel.length < 2) return;
    sel.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    var counts = [], acts = [], notes = [];
    sel.forEach(function (e) {
      if (e.count != null && e.count !== "") counts.push(String(e.count));
      String(e.act || "").split(" / ").forEach(function (a) { if (a && acts.indexOf(a) < 0) acts.push(a); });
      if (e.note) notes.push(e.note);
    });
    var merged = { id: eid(), key: sel[0].key, ts: sel[0].ts, lat: sel[0].lat, lon: sel[0].lon,
      count: counts.length ? counts.join(", ") : null, act: acts.join(" / "), note: notes.join(" | ") };
    var first = rec.log.indexOf(sel[0]);
    rec.log = rec.log.filter(function (e) { return ids.indexOf(e.id) < 0; });
    rec.log.splice(Math.max(0, first), 0, merged);
    putFieldRecord(rec);
  }
  function fcClear() { var rec = curFieldRecord(false); if (!rec) return; rec.log = []; rec.seen = {}; putFieldRecord(rec); }
  // Merge another list's observations into the open one, then delete the other.
  function fcMerge(otherId) {
    if (!fieldKey || otherId === fieldKey) return;
    var rec = curFieldRecord(true), other = getFieldRecord(otherId);
    if (!rec || !other) return;
    rec.log = rec.log.concat(other.log).sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    var all = getFieldChecklists(); delete all[otherId]; all[rec.id] = rec; saveFieldChecklists(all);
    refreshChecklists();
  }
  // Persist the title for the current list (creating its record).
  function persistFieldTitle(v) {
    var rec = curFieldRecord(true); if (!rec) return;
    rec.title = v; rec.lat = fieldLat; rec.lon = fieldLon;
    putFieldRecord(rec);
  }
  // Old per-point titles (pre per-location records); read-only migration fallback.
  function getFieldTitles() { return window.GeoState.get("fieldTitles", {}) || {}; }

  // Subsequence fuzzy match: query chars must appear in order in the name.
  function fuzzyMatch(name, q) {
    if (!q) return true;
    name = name.toLowerCase(); q = q.toLowerCase().replace(/\s+/g, "");
    var i = 0;
    for (var c = 0; c < name.length && i < q.length; c++) if (name[c] === q[i]) i++;
    return i === q.length;
  }

  // ---- "Far from checklist point" warning ----------------------------------
  // While a checklist is open, watch the device location; if it is more than
  // 2 km from the checklist's point, show a red "!" the user can tap to read a
  // short, localized explanation.
  var FIELD_FAR_KM = 2;
  function showFieldFar(on) {
    var b = document.getElementById("field-far");
    if (b) { b.style.display = on ? "" : "none"; b.title = t("chk.far"); }
    if (!on) { var m = document.getElementById("field-far-msg"); if (m) m.style.display = "none"; }
  }
  function stopFieldGeoWatch() {
    if (fieldGeoWatch != null && navigator.geolocation) navigator.geolocation.clearWatch(fieldGeoWatch);
    fieldGeoWatch = null;
    fieldGeoLast = null;
    showFieldFar(false);
  }
  function startFieldGeoWatch() {
    stopFieldGeoWatch();
    if (!navigator.geolocation) return;
    fieldGeoWatch = navigator.geolocation.watchPosition(function (pos) {
      // Stop once the checklist page is no longer showing.
      if (document.getElementById("field-page").style.display !== "flex") { stopFieldGeoWatch(); return; }
      fieldGeoLast = { lat: pos.coords.latitude, lon: pos.coords.longitude, ts: Date.now() };
      var d = haversineKm(pos.coords.latitude, pos.coords.longitude, fieldLat, fieldLon);
      showFieldFar(d > FIELD_FAR_KM);
    }, function () { /* denied / unavailable — no warning */ }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  }
  // Location to stamp on a new registration: the live device fix when available,
  // else the checklist's anchor point.
  function regLocation() {
    return fieldGeoLast ? { lat: fieldGeoLast.lat, lon: fieldGeoLast.lon } : { lat: fieldLat, lon: fieldLon };
  }
  // Request a one-shot high-accuracy fix and patch the just-logged entry with it,
  // so each registration ends up with a fresh position (not the open-time anchor).
  function freshenEntryLocation(entryId) {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      fieldGeoLast = { lat: pos.coords.latitude, lon: pos.coords.longitude, ts: Date.now() };
      var rec = curFieldRecord(false); if (!rec) return;
      var e = (rec.log || []).filter(function (x) { return x.id === entryId; })[0];
      if (e) { e.lat = pos.coords.latitude; e.lon = pos.coords.longitude; putFieldRecord(rec); }
    }, function () { /* denied / unavailable — keep best-known location */ }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }

  // Build the probability-ranked species list for the clicked/located point.
  // listId pins a specific (possibly past-day) list; otherwise today's list at
  // this place is started/continued.
  async function renderFieldChecklist(lat, lon, listId) {
    fieldQuery = ""; fieldFilter = "all"; composeDraft = {};   // fresh filters + compose drafts each open
    var fs = document.getElementById("field-search"); if (fs) fs.value = "";
    var fsc = document.getElementById("field-search-clear"); if (fsc) fsc.hidden = true;
    if (window.__refreshFilterCycle) window.__refreshFilterCycle();
    var week = +document.getElementById("week-select").value;
    var pmin = +document.getElementById("prob-min").value / 100;
    var pmax = +document.getElementById("prob-max").value / 100;
    setStatus(t("status.predicting", { lat: lat.toFixed(2), lon: lon.toFixed(2), week: week }));
    try {
      var out = await runInference(new Float32Array([lat, lon, week]), 1);
      var rows = [];
      for (var i = 0; i < labels.length; i++) {
        if (out[i] >= pmin && out[i] <= pmax && inGroup(i) && !isHidden(labels[i].key)) {
          rows.push({ key: labels[i].key, name: speciesName(labels[i]), prob: out[i] });
        }
      }
      rows.sort(function (a, b) { return b.prob - a.prob; });
      fieldData = rows;
      fieldLat = lat; fieldLon = lon;
      // Editable title = the user's saved name for this point, else the actual
      // detailed location (resolved async; coordinates meanwhile).
      var fcEl = document.getElementById("field-coords");
      var pkey = placeKey(lat, lon);
      var id = listId || listIdFor(lat, lon);   // today's list at this place by default
      fcEl.dataset.pkey = id;
      fieldKey = id;
      // Stamp last-accessed (for the recency dots in the checklist list); only
      // for lists that already exist in storage — don't create an empty one.
      var allFcs = getFieldChecklists();
      if (allFcs[id]) { allFcs[id].accessedAt = Date.now(); saveFieldChecklists(allFcs); }
      var rec = getFieldRecord(id);
      var saved = (rec && rec.title) || getFieldTitles()[pkey] || fieldNameCache[pkey];
      fcEl.value = saved || (lat.toFixed(4) + "°, " + lon.toFixed(4) + "°");
      var ptok = ++fieldPlaceToken;
      if (!saved) {
        // Resolve a proper place name; show it, remember it as the auto-title,
        // and persist it onto the open list once it has observations so the
        // dropdown never shows raw coordinates.
        detailedPlaceName(lat, lon).then(function (name) {
          if (!name) return;
          fieldNameCache[pkey] = name;
          if (ptok !== fieldPlaceToken) return;          // user moved on
          if (getFieldTitles()[pkey]) return;            // user already named it
          if (!(fcEl.value || "").trim() || /^-?\d.*°/.test(fcEl.value)) fcEl.value = name;
          var r2 = getFieldRecord(id);
          if (r2 && r2.log && r2.log.length && !(r2.title || "").trim()) persistFieldTitle(name);
        });
      }
      document.getElementById("field-page").style.display = "flex";   // full-screen entry page
      navOpen("page", closeAnyFullPage);
      hideFcPicker(); hidePlacePicker();
      showFieldFar(false); startFieldGeoWatch();   // re-check distance for this point
      renderFieldList();
      setStatus(t("status.spResult", { n: rows.length, p: (pmin * 100).toFixed(0), lat: lat.toFixed(2), lon: lon.toFixed(2) }));
    } catch (e) { setStatus(t("status.error", { msg: e.message })); console.error(e); }
  }

  // Country-wide checklist: same UI as the point-anchored checklist but its
  // species rows are the country-wide merged list (model + eBird country list),
  // its id is country:CC@day, the location warning is off (you can be
  // anywhere in the country), and the row snapshot is persisted on the record
  // so reopening from the list shows the species instantly without re-sampling.
  function renderCountryChecklist(cc, name, lat, lon, results, rowsSnapshot) {
    fieldQuery = ""; fieldFilter = "all"; composeDraft = {};
    var fs = document.getElementById("field-search"); if (fs) fs.value = "";
    var fsc = document.getElementById("field-search-clear"); if (fsc) fsc.hidden = true;
    if (window.__refreshFilterCycle) window.__refreshFilterCycle();
    var rows = rowsSnapshot || (results || []).map(function (r) { return { key: r.label.key, name: speciesName(r.label), prob: r.prob || 0 }; });
    fieldData = rows;
    fieldLat = lat; fieldLon = lon;
    var day = todayStr();
    var id = "country:" + cc + "@" + day;
    var fcEl = document.getElementById("field-coords");
    fcEl.dataset.pkey = id;
    fieldKey = id;
    fcEl.value = name || cc;
    // Persist the record (so it shows in the checklist list, survives reload,
    // and reopens instantly with the same species rows snapshot).
    var allFcs = getFieldChecklists();
    var rec = allFcs[id];
    if (!rec) rec = { id: id, title: name || cc, lat: lat, lon: lon, day: day, createdAt: new Date().toISOString(), log: [], seen: {}, kind: "country", cc: cc, rows: rows };
    else { rec.title = name || cc; rec.kind = "country"; rec.cc = cc; rec.rows = rows; rec.accessedAt = Date.now(); }
    allFcs[id] = rec; saveFieldChecklists(allFcs);
    document.getElementById("field-page").style.display = "flex";
    navOpen("page", closeAnyFullPage);
    hideFcPicker(); hidePlacePicker();
    showFieldFar(false); stopFieldGeoWatch();   // country-wide → no point anchor, no "far" warning
    renderFieldList();
    setStatus(t("status.countryChk", { country: name || cc, n: rows.length }));
    refreshChecklists();
  }

  // Checklist activity options. Each value is a stable key; ACT holds the label
  // per language [en, sv, de, es, fr, nl, no, it]. FIELD_ACTS is the dropdown
  // order — sorted from most to least commonly recorded.
  var ACT_LANGS = ["en", "sv", "de", "es", "fr", "nl", "no", "it"];
  var ACT = {
    // — everyday —
    stationary: ["Stationary", "Stationär", "Stationär", "Estacionario", "Stationnaire", "Stationair", "Stasjonær", "Stazionario"],
    resting: ["Resting", "Rastande", "Rastend", "En descanso", "En halte", "Rustend", "Rastende", "In sosta"],
    foraging: ["Foraging", "Födosökande", "Nahrungssuchend", "Alimentándose", "En quête de nourriture", "Foeragerend", "Næringssøkende", "In foraggiamento"],
    flyover: ["Flying over", "Överflygande", "Überfliegend", "Sobrevolando", "Survol", "Overvliegend", "Overflygende", "In volo sopra"],
    song: ["Song/display, not breeding", "Sång/spel, ej häckning", "Gesang/Balz, nicht brütend", "Canto/exhibición, no nidificante", "Chant/parade, hors nidification", "Zang/baltsen, niet broedend", "Sang/spill, ikke hekking", "Canto/parata, non nidificante"],
    call: ["Call/other sounds", "Lockläte/övriga ljud", "Ruf/sonstige Laute", "Reclamo/otros sonidos", "Cri/autres sons", "Roep/overige geluiden", "Lokkelyd, øvrige lyder", "Richiamo/altri suoni"],
    migrating: ["Migrating", "Sträckande", "Ziehend", "Migrando", "En migration", "Trekkend", "Trekkende", "In migrazione"],
    atfeeder: ["At feeder", "Vid matning", "Am Futterplatz", "En comedero", "À la mangeoire", "Bij voederplaats", "Ved fôring", "Alla mangiatoia"],
    // — breeding —
    obshab: ["Seen in breeding season, suitable habitat", "Obs. i häckningstid, lämplig biotop", "Beobachtung zur Brutzeit, geeignetes Habitat", "Observación en época de cría, hábitat adecuado", "Observé en période de nidification, habitat favorable", "Waarneming in broedtijd, geschikt biotoop", "Observasjon i hekketid, passende biotop", "Osservazione in periodo riproduttivo, habitat idoneo"],
    songhab: ["Song/display in breeding season & habitat", "Sång/spel i häckningstid, lämplig biotop", "Gesang/Balz zur Brutzeit, geeignetes Habitat", "Canto/exhibición en época y hábitat de cría", "Chant/parade en période et habitat de nidification", "Zang/baltsen in broedtijd, geschikt biotoop", "Sang/spill i hekketid og passende hekkebiotop", "Canto/parata in periodo e habitat riproduttivo"],
    pairhab: ["Pair in suitable breeding habitat", "Par i lämplig häckbiotop", "Paar im geeigneten Bruthabitat", "Pareja en hábitat de cría adecuado", "Couple en habitat de nidification favorable", "Paar in geschikt broedbiotoop", "Par i passende hekkebiotop", "Coppia in habitat riproduttivo idoneo"],
    permterr: ["Permanent territory", "Permanent revir", "Dauerrevier", "Territorio permanente", "Territoire permanent", "Permanent territorium", "Permanent revir", "Territorio permanente"],
    agitated: ["Agitated behaviour (breeding indication)", "Oroligt beteende (häckningsindikation)", "Erregtes Verhalten (Brutverdacht)", "Comportamiento de alarma (indicio de cría)", "Comportement inquiet (indice de nidification)", "Alarmgedrag (broedindicatie)", "Engstelig adferd, indikasjon på hekking", "Comportamento agitato (indizio di nidificazione)"],
    courtship: ["Mating/courtship at possible site", "Parning/uppvaktning på möjlig plats", "Paarung/Balz am möglichen Brutplatz", "Cópula/cortejo en posible lugar", "Accouplement/parade sur site possible", "Paring/balts op mogelijke plek", "Paring/kurtise på mulig hekkeplass", "Accoppiamento/corteggiamento su sito possibile"],
    nestbuild: ["Nest building", "Bobygge", "Nestbau", "Construcción de nido", "Construction du nid", "Nestbouw", "Reirbygging", "Costruzione del nido"],
    incubating: ["Incubating", "Ruvande", "Brütend", "Incubando", "En incubation", "Broedend", "Rugende", "In cova"],
    foodyoung: ["Food for young", "Mat till ungar", "Futter für Junge", "Alimento para crías", "Nourriture pour les jeunes", "Voer voor jongen", "Mat til unger", "Cibo per i piccoli"],
    nesteggsyoung: ["Nest with eggs or young", "Bo med ägg eller ungar", "Nest mit Eiern oder Jungen", "Nido con huevos o crías", "Nid avec œufs ou jeunes", "Nest met eieren of jongen", "Reir med egg eller unger", "Nido con uova o piccoli"],
    nestyoungheard: ["Nest, young heard", "Bo, ungar hörda", "Nest, Junge gehört", "Nido, crías oídas", "Nid, jeunes entendus", "Nest, jongen gehoord", "Reir, unger hørt", "Nido, piccoli uditi"],
    fledglings: ["Fledglings outside nest, not full-grown", "Ungar utanför bo, ej flygga", "Junge außerhalb des Nests, nicht flügge", "Pollos fuera del nido, no volantones", "Jeunes hors du nid, non volants", "Jongen buiten nest, niet vliegvlug", "Unger utenfor reir, ikke utvokste", "Giovani fuori dal nido, non involati"],
    nestinuse: ["Nest in use", "Bo i bruk", "Nest in Benutzung", "Nido en uso", "Nid utilisé", "Nest in gebruik", "Reir i bruk", "Nido in uso"],
    visitnest: ["Visiting occupied nest", "Besöker bebott bo", "Besucht besetztes Nest", "Visita nido ocupado", "Visite un nid occupé", "Bezoekt bewoond nest", "Besøker bebodd reir", "Visita nido occupato"],
    nestvisitq: ["Nest visit?", "Bobesök?", "Nestbesuch?", "¿Visita al nido?", "Visite du nid ?", "Nestbezoek?", "Reirbesøk?", "Visita al nido?"],
    faecalsac: ["Carrying faecal sac", "Bär exkrementsäck", "Kotballen tragend", "Transportando saco fecal", "Transport de sac fécal", "Draagt uitwerpselzakje", "Bar ekskrementpose", "Trasporto sacca fecale"],
    broodpatch: ["Brood patch", "Ruvfläckar", "Brutfleck", "Placa incubatriz", "Plaque incubatrice", "Broedvlek", "Rugeflekker", "Placca incubatrice"],
    usednest: ["Used nest", "Använt bo", "Benutztes Nest", "Nido usado", "Ancien nid utilisé", "Gebruikt nest", "Brukt reir", "Nido usato"],
    eggshell: ["Eggshell", "Äggskal", "Eierschale", "Cáscara de huevo", "Coquille d'œuf", "Eierschaal", "Eggeskall", "Guscio d'uovo"],
    distraction: ["Distraction display", "Avledningsbeteende", "Ablenkungsverhalten", "Distracción (simula herida)", "Comportement de diversion", "Afleidingsgedrag", "Avledningsmanøver", "Comportamento di distrazione"],
    failed: ["Failed breeding", "Misslyckad häckning", "Fehlgeschlagene Brut", "Cría fallida", "Nidification échouée", "Mislukte broedpoging", "Mislykket hekking", "Nidificazione fallita"],
    // — territory / marking —
    terrnonbreed: ["Territory, not breeding", "Revir, ej häckning", "Revier, nicht brütend", "Territorio, no reproductor", "Territoire, hors nidification", "Territorium, niet broedend", "Revir, ikke hekking", "Territorio, non nidificante"],
    ringed: ["Ringed", "Ringmärkt", "Beringt", "Anillado", "Bagué", "Geringd", "Ringmerket", "Inanellato"],
    marked: ["Individually marked (control)", "Individmärkt (kontroll)", "Individuell markiert (Kontrolle)", "Marcado individual (control)", "Marqué individuellement (contrôle)", "Individueel gemerkt (controle)", "Individmerket (kontroll)", "Marcato individualmente (controllo)"],
    // — migration —
    migattempt: ["Attempted migration", "Sträckförsök", "Zugversuch", "Intento de migración", "Tentative de migration", "Trekpoging", "Trekkforsøk", "Tentativo di migrazione"],
    mign: ["Migrating ↑", "Sträckande ↑", "Ziehend ↑", "Migrando ↑", "En migration ↑", "Trekkend ↑", "Trekkende ↑", "In migrazione ↑"],
    migne: ["Migrating ↗", "Sträckande ↗", "Ziehend ↗", "Migrando ↗", "En migration ↗", "Trekkend ↗", "Trekkende ↗", "In migrazione ↗"],
    mige: ["Migrating →", "Sträckande →", "Ziehend →", "Migrando →", "En migration →", "Trekkend →", "Trekkende →", "In migrazione →"],
    migse: ["Migrating ↘", "Sträckande ↘", "Ziehend ↘", "Migrando ↘", "En migration ↘", "Trekkend ↘", "Trekkende ↘", "In migrazione ↘"],
    migs: ["Migrating ↓", "Sträckande ↓", "Ziehend ↓", "Migrando ↓", "En migration ↓", "Trekkend ↓", "Trekkende ↓", "In migrazione ↓"],
    migsw: ["Migrating ↙", "Sträckande ↙", "Ziehend ↙", "Migrando ↙", "En migration ↙", "Trekkend ↙", "Trekkende ↙", "In migrazione ↙"],
    migw: ["Migrating ←", "Sträckande ←", "Ziehend ←", "Migrando ←", "En migration ←", "Trekkend ←", "Trekkende ←", "In migrazione ←"],
    mignw: ["Migrating ↖", "Sträckande ↖", "Ziehend ↖", "Migrando ↖", "En migration ↖", "Trekkend ↖", "Trekkende ↖", "In migrazione ↖"],
    // — mortality —
    sick: ["Sick", "Sjuk", "Krank", "Enfermo", "Malade", "Ziek", "Syk", "Malato"],
    shot: ["Shot/culled", "Skjuten/avlivad", "Geschossen/getötet", "Disparado/sacrificado", "Tiré/abattu", "Geschoten/gedood", "Skutt/avlivet", "Abbattuto/soppresso"],
    roadkill: ["Roadkill", "Trafikdödad", "Verkehrsopfer", "Atropellado", "Tué sur la route", "Verkeersslachtoffer", "Trafikkdrept", "Investito su strada"],
    predator: ["Killed by predator", "Dödad av predator", "Von Prädator getötet", "Muerto por depredador", "Tué par un prédateur", "Gedood door predator", "Drept av predator", "Ucciso da predatore"],
    disease: ["Died of disease/starvation", "Död av sjukdom/svält", "An Krankheit/Hunger gestorben", "Muerto por enfermedad/inanición", "Mort de maladie/famine", "Gestorven door ziekte/honger", "Død av sykdom/sult", "Morto per malattia/fame"],
    oil: ["Killed by oil", "Dödad av olja", "Durch Öl getötet", "Muerto por petróleo", "Tué par le pétrole", "Gedood door olie", "Drept av olje", "Ucciso dal petrolio"],
    electro: ["Electrocuted", "Dödad av elstöt", "Durch Stromschlag getötet", "Electrocutado", "Électrocuté", "Geëlektrocuteerd", "Drept av elektrokusjon (strømslag)", "Folgorato"],
    net: ["Died in net", "Nätdöd", "Im Netz verendet", "Muerto en red", "Mort dans un filet", "Gestorven in net", "Garndød", "Morto in rete"],
    fishgear: ["Injured by fishing gear", "Skadad av fiskeredskap", "Durch Fanggerät verletzt", "Herido por arte de pesca", "Blessé par engin de pêche", "Verwond door vistuig", "Skadet av fiskeredskap", "Ferito da attrezzi da pesca"],
    collwindow: ["Dead – window collision", "Död – kollision med fönster", "Tot – Kollision mit Fenster", "Muerto – colisión con ventana", "Mort – collision avec vitre", "Dood – botsing met raam", "Død - kollisjon med vindu", "Morto – collisione con vetro"],
    collpower: ["Dead – power line collision", "Död – kollision med kraftledning", "Tot – Kollision mit Stromleitung", "Muerto – colisión con línea eléctrica", "Mort – collision avec ligne électrique", "Dood – botsing met hoogspanningslijn", "Død - kollisjon med kraftledning", "Morto – collisione con linea elettrica"],
    collturbine: ["Dead – wind turbine collision", "Död – kollision med vindkraftverk", "Tot – Kollision mit Windrad", "Muerto – colisión con aerogenerador", "Mort – collision avec éolienne", "Dood – botsing met windturbine", "Død - kollisjon med vindturbin", "Morto – collisione con turbina eolica"],
    colllighthouse: ["Dead – lighthouse collision", "Död – kollision med fyr", "Tot – Kollision mit Leuchtturm", "Muerto – colisión con faro", "Mort – collision avec phare", "Dood – botsing met vuurtoren", "Død - kollisjon med fyr", "Morto – collisione con faro"],
    collaircraft: ["Dead – aircraft collision", "Död – kollision med flygplan", "Tot – Kollision mit Flugzeug", "Muerto – colisión con avión", "Mort – collision avec avion", "Dood – botsing met vliegtuig", "Død - kollisjon med fly", "Morto – collisione con aereo"],
    collfence: ["Dead – fence collision", "Död – kollision med stängsel", "Tot – Kollision mit Zaun", "Muerto – colisión con valla", "Mort – collision avec clôture", "Dood – botsing met hek", "Død - kollisjon med gjerde", "Morto – collisione con recinzione"],
    deadunknown: ["Dead – unknown cause", "Död – okänd dödsorsak", "Tot – unbekannte Ursache", "Muerto – causa desconocida", "Mort – cause inconnue", "Dood – onbekende oorzaak", "Død - ukjent dødsårsak", "Morto – causa sconosciuta"],
    // — traces —
    tracksfresh: ["Fresh tracks", "Färska spår", "Frische Spuren", "Rastros frescos", "Traces fraîches", "Verse sporen", "Ferske spor", "Tracce fresche"],
    tracksold: ["Old tracks", "Äldre spår", "Alte Spuren", "Rastros antiguos", "Traces anciennes", "Oude sporen", "Eldre spor", "Tracce vecchie"],
    droppingsfresh: ["Fresh droppings", "Färsk spillning", "Frischer Kot", "Excrementos frescos", "Crottes fraîches", "Verse uitwerpselen", "Fersk møkk", "Escrementi freschi"],
    droppingsold: ["Old droppings", "Äldre spillning", "Alter Kot", "Excrementos antiguos", "Crottes anciennes", "Oude uitwerpselen", "Eldre møkk", "Escrementi vecchi"],
  };
  // Dropdown order: most → least commonly recorded.
  var FIELD_ACTS = [
    "stationary", "resting", "foraging", "flyover", "song", "call", "migrating", "atfeeder",
    "obshab", "songhab", "pairhab", "permterr", "agitated", "courtship", "nestbuild", "incubating",
    "foodyoung", "nesteggsyoung", "nestyoungheard", "fledglings", "nestinuse", "visitnest",
    "nestvisitq", "faecalsac", "broodpatch", "usednest", "eggshell", "distraction", "failed",
    "terrnonbreed", "ringed", "marked",
    "migattempt", "mign", "migne", "mige", "migse", "migs", "migsw", "migw", "mignw",
    "sick", "shot", "roadkill", "predator", "disease", "oil", "electro", "net", "fishgear",
    "collwindow", "collpower", "collturbine", "colllighthouse", "collaircraft", "collfence", "deadunknown",
    "tracksfresh", "tracksold", "droppingsfresh", "droppingsold",
  ];
  // Localized label for an activity key (current UI language, English fallback).
  function actName(key) {
    var a = ACT[key];
    if (!a) return key;
    var i = ACT_LANGS.indexOf(lang);
    return a[i >= 0 ? i : 0] || a[0];
  }

  // Render the (filtered, probability-sorted) field-entry rows.
  function fmtClock(ts) { var d = new Date(ts || Date.now()); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
  function actLabel(act) { return String(act || "").split(" / ").filter(Boolean).map(function (a) { return actName(a); }).join(" / "); }
  // Compact one-line summary of a logged observation for the card.
  // Compact one-line summary as HTML (the sex marker is a composed SVG glyph).
  function fcEntryHtml(e) {
    var parts = [];
    if (e.count != null && e.count !== "") parts.push(escapeHtml("×" + e.count));
    if (e.sex) parts.push(sexGlyphHtml(e.sex));
    var al = actLabel(e.act); if (al) parts.push(escapeHtml(al));
    parts.push(escapeHtml(fmtClock(e.ts)));
    if (e.note) parts.push(escapeHtml("“" + e.note + "”"));
    return parts.join(" · ");
  }

  // A card per species: a top "compose" line (checkbox, #, activity, note, ＋)
  // plus the most recent logged observations as small lines you can tap to edit.
  function renderFieldList() {
    if (!fieldData) return;
    var entries = getFieldEntries();
    var rec = curFieldRecord(false);
    var list = document.getElementById("field-list");
    var rows = fieldData.slice(), have = {};
    fieldData.forEach(function (r) { have[r.key] = 1; });
    Object.keys(entries).forEach(function (k) {
      if (have[k]) return;
      var lbl = labelsByKey[k];
      rows.push({ key: k, name: lbl ? speciesName(lbl) : k, prob: null });
    });
    var shown = rows.filter(function (r) {
      if (!fuzzyMatch(r.name, fieldQuery)) return false;
      if (fieldFilter === "interesting") return isInteresting(r.key);
      if (fieldFilter === "all") return true;
      var seen = !!(entries[r.key] && entries[r.key].seen);
      return fieldFilter === "seen" ? seen : !seen;
    });
    list.innerHTML = shown.map(function (r) {
      var en = entries[r.key] || {}, d = cd(r.key), lbl = labelsByKey[r.key];
      var ents = rec ? fcEntriesFor(rec, r.key) : [], n = ents.length;
      var hasN = (d.count != null && d.count !== "");
      var entLines = ents.slice(-2).reverse().map(function (e) {
        return '<div class="fc-eline">' + fcEntryHtml(e) + "</div>";
      }).join("");
      if (n > 2) entLines += '<div class="fc-eline fc-emore">' + escapeHtml(t("chk.more", { n: n - 2 })) + "</div>";
      var entriesBlock = n ? '<div class="fc-entries" data-key="' + escapeHtml(r.key) + '">' + entLines + "</div>" : "";
      var badge = n > 1 ? '<span class="fc-ncount" title="' + n + '">×' + n + "</span>" : "";
      return '<div class="fc-card' + (en.seen ? " fc-on" : "") + (d.note ? " fc-note-on" : "") + '" data-key="' + escapeHtml(r.key) + '">' +
        '<div class="fc-top">' +
          '<span class="fc-name sp-link" data-key="' + escapeHtml(r.key) + '" data-name="' + escapeHtml(r.name) + '" data-sci="' + escapeHtml(lbl ? (lbl.sci || "") : "") + '">' + interestingStar(r.key) + escapeHtml(r.name) + badge + "</span>" +
          '<div class="fc-actions">' +
            '<button type="button" class="fc-count' + (hasN ? " has-n" : "") + '" data-key="' + escapeHtml(r.key) + '">' + (hasN ? d.count : "#") + "</button>" +
            '<button type="button" class="fc-act-btn' + (d.act ? " has-act" : "") + '" data-key="' + escapeHtml(r.key) + '" title="' + escapeHtml(t("chk.activity")) + '">' + (d.act ? escapeHtml(actName(d.act)) : "🏷") + "</button>" +
            '<button type="button" class="fc-sex-btn' + (d.sex ? " has-sex" : "") + '" data-key="' + escapeHtml(r.key) + '" title="' + escapeHtml(t("chk.sex")) + '">' + sexGlyphHtml(d.sex || "") + "</button>" +
            '<button type="button" class="fc-add" data-key="' + escapeHtml(r.key) + '" title="' + escapeHtml(t("fc.add")) + '" aria-label="' + escapeHtml(t("fc.add")) + '">＋</button>' +
          "</div>" +
          '<input type="text" class="fc-note" data-key="' + escapeHtml(r.key) + '" placeholder="' + escapeHtml(t("th.notes")) + '" value="' + escapeHtml(d.note || "") + '" />' +
        "</div>" + entriesBlock +
        "</div>";
    }).join("");
    if (!shown.length) list.innerHTML = '<p class="fc-empty">' + escapeHtml(t("analysis.empty")) + "</p>";
    updateFieldSeen();
  }

  // Update the "✓ N" seen-count badge in the field page bar.
  function updateFieldSeen() {
    var el = document.getElementById("field-seen");
    if (!el) return;
    var entries = getFieldEntries(), n = 0;
    for (var k in entries) if (entries[k] && entries[k].seen) n++;
    el.textContent = n ? "✓ " + n : "";
  }

  // ---- Count quick-select (field checklist) --------------------------------
  var fcPickerKey = null;
  // The # picker now edits the species' compose-draft count (committed only by
  // ＋ or the checkbox), not the log.
  function openFcPicker(key, name) {
    fcPickerKey = key;
    document.getElementById("fcp-name").textContent = name || "";
    document.getElementById("fcp-val").textContent = countNum(cd(key).count);
    document.getElementById("fc-picker").style.display = "block";
  }
  function hideFcPicker() { fcPickerKey = null; var p = document.getElementById("fc-picker"); if (p) p.style.display = "none"; }
  function setFcCount(key, val) {
    val = Math.max(0, val | 0);
    cd(key).count = val > 0 ? val : null;
    var btn = document.querySelector('#field-list .fc-card[data-key="' + key + '"] .fc-count');
    if (btn) { btn.textContent = val > 0 ? val : "#"; btn.classList.toggle("has-n", val > 0); }
    var v = document.getElementById("fcp-val"); if (v) v.textContent = val;
  }

  // ---- Activity picker (field checklist) -----------------------------------
  // A scrollable bottom sheet of the (long) activity list, opened from the
  // card's activity button — replaces a cramped <select>. Edits the species'
  // compose-draft activity (committed only by ＋ or the checkbox).
  var fcActKey = null;
  // Resolve a typed query to an activity value: an existing code if the text
  // matches a localized name exactly, otherwise the raw text (a custom value).
  function resolveActQuery(raw) {
    raw = (raw || "").trim(); if (!raw) return "";
    var lc = raw.toLowerCase();
    for (var i = 0; i < FIELD_ACTS.length; i++) if (actName(FIELD_ACTS[i]).toLowerCase() === lc) return FIELD_ACTS[i];
    return raw;
  }
  // (Re)build the list, filtered by the search box. A non-matching query also
  // offers a "＋ <text>" item so a custom activity can be written.
  function renderFcActList() {
    if (!fcActKey) return;
    var cur = cd(fcActKey).act || "";
    var raw = document.getElementById("fca-search").value.trim(), q = raw.toLowerCase();
    var exact = false;
    var matches = FIELD_ACTS.filter(function (a) { var nm = actName(a).toLowerCase(); if (nm === q) exact = true; return !q || nm.indexOf(q) >= 0; });
    var h = '<button type="button" class="fca-item fca-none' + (!cur ? " is-active" : "") + '" data-act="">—</button>';
    if (raw && !exact) h += '<button type="button" class="fca-item fca-custom' + (cur === raw ? " is-active" : "") + '" data-act="' + escapeHtml(raw) + '">＋ ' + escapeHtml(raw) + "</button>";
    matches.forEach(function (a) {
      h += '<button type="button" class="fca-item' + (cur === a ? " is-active" : "") + '" data-act="' + escapeHtml(a) + '">' + escapeHtml(actName(a)) + "</button>";
    });
    document.getElementById("fca-list").innerHTML = h;
  }
  function openFcActPicker(key, name) {
    fcActKey = key;
    document.getElementById("fca-name").textContent = name || "";
    var cur = cd(key).act || "";
    // Prefill the box with a custom value so it stays visible/editable.
    document.getElementById("fca-search").value = (cur && FIELD_ACTS.indexOf(cur) < 0) ? cur : "";
    renderFcActList();
    var p = document.getElementById("fc-act-picker");
    p.style.display = "block";
    var active = p.querySelector(".fca-item.is-active");
    if (active) active.scrollIntoView({ block: "center" });
  }
  function hideFcActPicker() { fcActKey = null; var p = document.getElementById("fc-act-picker"); if (p) p.style.display = "none"; }
  function setFcAct(key, a) {
    var draft = cd(key);
    draft.act = a || "";
    // Picking an activity implies "I saw at least one" — default the count to 1
    // when the user hasn't entered one yet, so they don't have to tap twice.
    if (a && (draft.count == null || draft.count === "" || +draft.count === 0)) {
      setFcCount(key, 1);
    }
    var btn = document.querySelector('#field-list .fc-card[data-key="' + key + '"] .fc-act-btn');
    if (btn) { btn.textContent = a ? actName(a) : "🏷"; btn.classList.toggle("has-act", !!a); }
  }

  // ---- Entry-edit page (per species) ---------------------------------------
  function openEntryEdit(key) { entryEditKey = key; renderEntryEdit(); document.getElementById("entry-page").style.display = "flex"; navOpen("entry", hideEntryEdit); }
  function hideEntryEdit() { document.getElementById("entry-page").style.display = "none"; entryEditKey = null; renderFieldList(); }
  function closeEntryEdit() { navClose("entry"); }
  function renderEntryEdit() {
    var key = entryEditKey, rec = curFieldRecord(false);
    var lbl = labelsByKey[key];
    document.getElementById("entry-title").textContent = lbl ? speciesName(lbl) : key;
    var list = document.getElementById("entry-list");
    var ents = rec ? fcEntriesFor(rec, key).slice().reverse() : [];   // newest first
    if (!ents.length) { list.innerHTML = '<p class="fc-empty">' + escapeHtml(t("analysis.empty")) + "</p>"; return; }
    var actOpts = function (sel) {
      var h = '<option value=""></option>';
      FIELD_ACTS.forEach(function (a) { h += '<option value="' + a + '"' + (sel === a ? " selected" : "") + ">" + escapeHtml(actName(a)) + "</option>"; });
      return h;
    };
    var sexOpts = function (sel) {
      return SEX_CYCLE.map(function (s) {
        return '<option value="' + s + '"' + (sel === s ? " selected" : "") + ">" + sexGlyph(s) + "</option>";
      }).join("");
    };
    list.innerHTML = ents.map(function (e) {
      var meta = fmtClock(e.ts) + (e.lat != null ? " · " + e.lat.toFixed(3) + "," + e.lon.toFixed(3) : "");
      var singleAct = e.act && e.act.indexOf(" / ") < 0 ? e.act : "";   // merged activities aren't editable in the dropdown
      return '<div class="ent-row" data-id="' + escapeHtml(e.id) + '">' +
        '<label class="ent-sel-wrap"><input type="checkbox" class="ent-sel" data-id="' + escapeHtml(e.id) + '"></label>' +
        '<input type="text" class="ent-count" data-id="' + escapeHtml(e.id) + '" inputmode="numeric" value="' + escapeHtml(e.count != null ? String(e.count) : "") + '" placeholder="#" />' +
        '<select class="ent-sex" data-id="' + escapeHtml(e.id) + '" title="' + escapeHtml(t("chk.sex")) + '">' + sexOpts(e.sex || "") + "</select>" +
        '<select class="ent-act" data-id="' + escapeHtml(e.id) + '">' + actOpts(singleAct) + "</select>" +
        '<input type="text" class="ent-note" data-id="' + escapeHtml(e.id) + '" value="' + escapeHtml(e.note || "") + '" placeholder="' + escapeHtml(t("th.notes")) + '" />' +
        '<span class="ent-meta">' + escapeHtml(meta) + "</span>" +
        '<button type="button" class="ent-del" data-id="' + escapeHtml(e.id) + '" aria-label="' + escapeHtml(t("btn.delete")) + '">×</button>' +
        "</div>";
    }).join("");
  }

  // ---- Review & upload page ------------------------------------------------
  // Lets the user split/merge the open record's log entries into ad-hoc
  // "checklists" (groups) and download an eBird Record-Format CSV per group
  // for manual upload at ebird.org/import/upload. A submit-API hook exists
  // but is gated off — eBird's submit endpoint is partner-only.

  // FIELD_ACTS code → eBird breeding/behaviour code. Activities not in this
  // table are emitted as plain text in the species "Identification details".
  var EBIRD_BREEDING = {
    flyover: "F", song: "S",
    obshab: "H", songhab: "S7", pairhab: "P", permterr: "T",
    agitated: "A", courtship: "C",
    nestbuild: "NB", incubating: "ON", foodyoung: "FY",
    nesteggsyoung: "NY", nestyoungheard: "NY", fledglings: "FL",
    nestinuse: "ON", visitnest: "N", nestvisitq: "N",
    faecalsac: "FS", usednest: "UN", eggshell: "UN",
    distraction: "DD", broodpatch: "PE"
  };
  var EBIRD_PROTOCOLS = ["Stationary", "Traveling", "Casual", "Incidental", "Historical"];
  var DEFAULT_GRP = "a";

  function entryGrp(e) { return (e && e.grp) || DEFAULT_GRP; }
  // Sorted list of group keys present in the record's log + persisted upload
  // meta. Empty groups disappear next render — keeps the UI honest.
  function recordGroups(rec) {
    var seen = {};
    ((rec && rec.log) || []).forEach(function (e) { seen[entryGrp(e)] = true; });
    if (rec && rec.upload) Object.keys(rec.upload).forEach(function (g) { seen[g] = true; });
    var keys = Object.keys(seen);
    if (!keys.length) keys.push(DEFAULT_GRP);
    keys.sort();
    return keys;
  }
  function entriesInGroup(rec, grp) {
    return ((rec && rec.log) || []).filter(function (e) { return entryGrp(e) === grp; })
      .sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
  }
  // Per-species aggregate within a group. `count` is the sum of numeric counts
  // (countNum tolerates merged "3, 1" strings); `notes` is "|"-joined uniques;
  // `breedingHint` is the eBird code from the highest-priority activity seen.
  function aggregateForUpload(entries) {
    var by = {}, order = [];
    entries.forEach(function (e) {
      var a = by[e.key];
      if (!a) { a = by[e.key] = { key: e.key, count: 0, hadCount: false, notes: [], acts: [], sexCounts: {}, firstTs: e.ts || 0, lastTs: e.ts || 0 }; order.push(e.key); }
      var n = (e.count != null && e.count !== "") ? countNum(e.count) : 0;
      if (n > 0) { a.count += n; a.hadCount = true; }
      if (e.sex) a.sexCounts[e.sex] = (a.sexCounts[e.sex] || 0) + (n > 0 ? n : 1);
      if (e.note) { var nt = String(e.note).trim(); if (nt && a.notes.indexOf(nt) < 0) a.notes.push(nt); }
      String(e.act || "").split(" / ").forEach(function (x) { x = x.trim(); if (x && a.acts.indexOf(x) < 0) a.acts.push(x); });
      a.firstTs = Math.min(a.firstTs, e.ts || a.firstTs);
      a.lastTs = Math.max(a.lastTs, e.ts || a.lastTs);
    });
    return order.map(function (k) { return by[k]; });
  }
  // Render a species' sex-count breakdown as e.g. "3 ♂, 2 ♀" for the CSV
  // Identification-details column. Empty when no sex info was recorded.
  function sexBreakdown(sexCounts) {
    var parts = [];
    SEX_CYCLE.forEach(function (s) {
      if (!s) return;
      var n = sexCounts[s]; if (n) parts.push(n + " " + sexGlyph(s));
    });
    return parts.join(", ");
  }
  // Translate the species' joined activity codes into (breedingCode, residualText).
  // Breeding code is the first matching mapped activity; residual is plain
  // text for unmapped activities (foraging/stationary/migrating-… etc) so the
  // info isn't lost in the CSV.
  function ebirdActSplit(actCodes) {
    var code = "", residual = [];
    actCodes.forEach(function (a) {
      if (EBIRD_BREEDING[a] && !code) code = EBIRD_BREEDING[a];
      else if (a) residual.push(actName(a));
    });
    return { code: code, residual: residual.join(", ") };
  }

  // Default time pulled from the entries; falls back to local clock.
  function ebirdStartTime(entries) {
    if (!entries.length) return "08:00";
    var t0 = entries[0].ts || Date.now();
    return fmtClock(t0);
  }
  function ebirdDurationMin(entries) {
    if (entries.length < 2) return 0;
    var span = (entries[entries.length - 1].ts || 0) - (entries[0].ts || 0);
    return Math.max(0, Math.round(span / 60000));
  }

  var REVIEW_FIELDS = ["protocol", "start", "duration", "distance", "area", "observers", "allObs",
                       "locName", "state", "country", "effortNotes", "submitNotes"];
  function defaultMeta(rec, entries) {
    return {
      protocol: "Stationary",
      start: ebirdStartTime(entries),
      duration: ebirdDurationMin(entries) || (entries.length ? 1 : 0),
      distance: "",
      area: "",
      observers: 1,
      allObs: "Y",
      locName: rec.title || "",
      state: "",
      country: "",
      effortNotes: "",
      submitNotes: ""
    };
  }
  function readGroupMeta(rec, grp, entries) {
    var dflt = defaultMeta(rec, entries);
    var saved = (rec.upload && rec.upload[grp]) || {};
    var out = {};
    REVIEW_FIELDS.forEach(function (f) { out[f] = (saved[f] !== undefined && saved[f] !== null) ? saved[f] : dflt[f]; });
    return out;
  }
  function writeGroupMeta(rec, grp, patch) {
    rec.upload = rec.upload || {};
    rec.upload[grp] = Object.assign(rec.upload[grp] || {}, patch);
    putFieldRecord(rec);
  }
  function nextGroupKey(rec) {
    // Group keys are single lowercase letters a–z; jump to the lowest unused.
    var used = {}; recordGroups(rec).forEach(function (g) { used[g] = true; });
    for (var i = 0; i < 26; i++) { var k = String.fromCharCode(97 + i); if (!used[k]) return k; }
    return "z";   // unlikely
  }

  // eBird Record-Format CSV — header row + one row per species. Columns and
  // order from eBird's documented import schema; "All observations reported"
  // and "Number" semantics per their import help ("X" for present-no-count).
  function ebirdRecordCsv(rec, grp) {
    var entries = entriesInGroup(rec, grp);
    var meta = readGroupMeta(rec, grp, entries);
    var rows = aggregateForUpload(entries);
    var esc = function (v) { var s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var headers = ["Common Name", "Genus", "Species", "Number", "Identification details",
      "Observation Date", "Observation Time", "State", "Country", "Location Name",
      "Latitude", "Longitude", "Protocol", "Duration (min)", "All observations reported",
      "Distance Covered (km)", "Area Covered (ha)", "Number of Observers",
      "Effort Comments", "Submission Comments"];
    var date = rec.day || todayStr();
    var lines = [headers.join(",")];
    var skipped = 0;
    rows.forEach(function (a) {
      var lbl = labelsByKey[a.key] || {};
      // eBird only accepts birds. Skip non-bird rows so the import doesn't
      // 400; we report the count back so the caller can warn the user.
      var isBird = !!labelsByKey[a.key] || isBirdKey(a.key);
      if (!isBird) { skipped++; return; }
      var sci = (lbl.sci || "").split(/\s+/);
      var genus = sci[0] || "", species = sci.slice(1).join(" ") || "";
      var common = lbl.common || lbl.key || a.key;
      var split = ebirdActSplit(a.acts);
      var detailBits = [];
      if (split.code) detailBits.push(split.code);
      var sx = sexBreakdown(a.sexCounts || {});
      if (sx) detailBits.push(sx);
      if (split.residual) detailBits.push(split.residual);
      if (a.notes.length) detailBits.push(a.notes.join(" | "));
      var num = a.hadCount && a.count > 0 ? String(a.count) : "X";
      lines.push([
        esc(common), esc(genus), esc(species), num, esc(detailBits.join(" — ")),
        date, meta.start || "",
        esc(meta.state || ""), esc(meta.country || ""), esc(meta.locName || rec.title || ""),
        (rec.lat != null ? rec.lat.toFixed(6) : ""), (rec.lon != null ? rec.lon.toFixed(6) : ""),
        meta.protocol || "Stationary",
        (meta.duration === "" || meta.duration == null) ? "" : String(meta.duration),
        (meta.allObs === "N") ? "N" : "Y",
        (meta.protocol === "Traveling" && meta.distance !== "") ? String(meta.distance) : "",
        (meta.protocol === "Area" && meta.area !== "") ? String(meta.area) : "",
        String(meta.observers || 1),
        esc(meta.effortNotes || ""), esc(meta.submitNotes || "")
      ].join(","));
    });
    return { csv: lines.join("\n"), skipped: skipped };
  }

  // Placeholder for an eventual API submit. Kept as a function so the call
  // site doesn't need to change once eBird grants partner credentials.
  function ebirdSubmitGroup(/* rec, grp */) {
    setStatus(t("review.apiStub"));
  }

  var REVIEW_RECID = null;
  function openReviewPage() {
    var rec = curFieldRecord(false);
    if (!rec || !rec.log || !rec.log.length) { setStatus(t("review.empty")); return; }
    REVIEW_RECID = rec.id;
    document.getElementById("review-page").style.display = "flex";
    renderReviewPage();
  }
  function closeReviewPage() {
    document.getElementById("review-page").style.display = "none";
    REVIEW_RECID = null;
  }

  function renderReviewPage() {
    var rec = getFieldRecord(REVIEW_RECID);
    var list = document.getElementById("review-list");
    if (!rec) { list.innerHTML = '<p class="fc-empty">' + escapeHtml(t("review.empty")) + "</p>"; return; }
    var groups = recordGroups(rec);
    var html = groups.map(function (g) { return renderGroupCardHtml(rec, g, groups); }).join("");
    if (!html) html = '<p class="fc-empty">' + escapeHtml(t("review.empty")) + "</p>";
    list.innerHTML = html;
  }

  function renderGroupCardHtml(rec, grp, allGroups) {
    var entries = entriesInGroup(rec, grp);
    var meta = readGroupMeta(rec, grp, entries);
    var rows = aggregateForUpload(entries);
    var esc = escapeHtml;
    var protoOpts = EBIRD_PROTOCOLS.map(function (p) {
      var lab = t("review.proto" + p);
      return '<option value="' + p + '"' + (meta.protocol === p ? " selected" : "") + ">" + esc(lab) + "</option>";
    }).join("");
    var moveOpts = allGroups.filter(function (x) { return x !== grp; })
      .map(function (x) { return '<option value="' + x + '">' + esc(t("review.group") + " " + x.toUpperCase()) + "</option>"; })
      .concat('<option value="__new__">' + esc(t("review.newGroup")) + "</option>").join("");

    var speciesHtml = rows.map(function (a) {
      var lbl = labelsByKey[a.key] || {};
      var nm = lbl.common ? speciesName(lbl) : a.key;
      var split = ebirdActSplit(a.acts);
      var codeOpts = ['<option value=""></option>'].concat(
        ["F","S","H","S7","P","T","A","C","NB","ON","FY","NY","FL","N","FS","UN","DD","PE"].map(function (c) {
          return '<option value="' + c + '"' + (split.code === c ? " selected" : "") + ">" + c + "</option>";
        })
      ).join("");
      var note = (split.residual ? split.residual + (a.notes.length ? " — " : "") : "") + a.notes.join(" | ");
      var srcEntries = entriesInGroup(rec, grp).filter(function (e) { return e.key === a.key; });
      var srcHtml = srcEntries.map(function (e) {
        return '<div class="rv-src" data-eid="' + esc(e.id) + '">' +
          '<span class="rv-src-meta">' + esc(fmtClock(e.ts) + " · " + (e.count != null ? e.count : "·") + (e.act ? " · " + actName(e.act) : "") + (e.note ? " · " + e.note : "")) + "</span>" +
          '<select class="rv-move" data-eid="' + esc(e.id) + '" data-grp="' + esc(grp) + '">' +
            '<option value="">' + esc(t("review.moveTo")) + "</option>" + moveOpts +
          "</select>" +
          "</div>";
      }).join("");
      return '<div class="rv-sp" data-key="' + esc(a.key) + '" data-grp="' + esc(grp) + '">' +
        '<div class="rv-sp-head">' +
          '<span class="rv-sp-name">' + esc(nm) + "</span>" +
          '<input type="text" class="rv-count" data-grp="' + esc(grp) + '" data-key="' + esc(a.key) + '" inputmode="numeric" value="' + esc(a.hadCount && a.count > 0 ? String(a.count) : (a.hadCount ? "0" : "X")) + '" />' +
          '<select class="rv-code" data-grp="' + esc(grp) + '" data-key="' + esc(a.key) + '" title="Breeding/behaviour code">' + codeOpts + "</select>" +
          '<button type="button" class="rv-expand" data-key="' + esc(a.key) + '" data-grp="' + esc(grp) + '" aria-label="Show entries">▾</button>' +
        "</div>" +
        '<input type="text" class="rv-note" data-grp="' + esc(grp) + '" data-key="' + esc(a.key) + '" value="' + esc(note) + '" placeholder="' + esc(t("th.notes")) + '" />' +
        '<div class="rv-src-list" hidden>' + srcHtml + "</div>" +
      "</div>";
    }).join("");

    var showDist = meta.protocol === "Traveling";
    return '<div class="rv-group" data-grp="' + esc(grp) + '">' +
      '<div class="rv-group-head">' +
        '<h3>' + esc(t("review.group") + " " + grp.toUpperCase()) + " · " + entries.length + "</h3>" +
        '<button type="button" class="demo-btn rv-dl" data-grp="' + esc(grp) + '" data-i18n="review.dlEbird">⬇ eBird CSV</button>' +
        '<button type="button" class="demo-btn demo-btn-light rv-api" data-grp="' + esc(grp) + '" title="' + esc(t("review.apiStub")) + '" data-i18n="review.apiEbird">Submit to eBird</button>' +
      "</div>" +
      '<div class="rv-meta">' +
        '<label>' + esc(t("review.protocol")) + ' <select class="rv-m" data-grp="' + esc(grp) + '" data-f="protocol">' + protoOpts + "</select></label>" +
        '<label>' + esc(t("review.start")) + ' <input type="time" class="rv-m" data-grp="' + esc(grp) + '" data-f="start" value="' + esc(meta.start || "") + '"></label>' +
        '<label>' + esc(t("review.duration")) + ' <input type="number" min="0" class="rv-m" data-grp="' + esc(grp) + '" data-f="duration" value="' + esc(String(meta.duration || 0)) + '"></label>' +
        (showDist ? '<label>' + esc(t("review.distance")) + ' <input type="number" min="0" step="0.1" class="rv-m" data-grp="' + esc(grp) + '" data-f="distance" value="' + esc(String(meta.distance || "")) + '"></label>' : "") +
        '<label>' + esc(t("review.observers")) + ' <input type="number" min="1" class="rv-m" data-grp="' + esc(grp) + '" data-f="observers" value="' + esc(String(meta.observers || 1)) + '"></label>' +
        '<label>' + esc(t("review.allObs")) + ' <select class="rv-m" data-grp="' + esc(grp) + '" data-f="allObs"><option value="Y"' + (meta.allObs !== "N" ? " selected" : "") + ">" + esc(t("review.yes")) + '</option><option value="N"' + (meta.allObs === "N" ? " selected" : "") + ">" + esc(t("review.no")) + "</option></select></label>" +
        '<label class="rv-wide">' + esc(t("review.locName")) + ' <input type="text" class="rv-m" data-grp="' + esc(grp) + '" data-f="locName" value="' + esc(meta.locName || "") + '"></label>' +
        '<label>' + esc(t("review.state")) + ' <input type="text" class="rv-m" data-grp="' + esc(grp) + '" data-f="state" value="' + esc(meta.state || "") + '"></label>' +
        '<label>' + esc(t("review.country")) + ' <input type="text" class="rv-m" data-grp="' + esc(grp) + '" data-f="country" value="' + esc(meta.country || "") + '"></label>' +
        '<label class="rv-wide">' + esc(t("review.effortNotes")) + ' <input type="text" class="rv-m" data-grp="' + esc(grp) + '" data-f="effortNotes" value="' + esc(meta.effortNotes || "") + '"></label>' +
        '<label class="rv-wide">' + esc(t("review.submitNotes")) + ' <input type="text" class="rv-m" data-grp="' + esc(grp) + '" data-f="submitNotes" value="' + esc(meta.submitNotes || "") + '"></label>' +
      "</div>" +
      (rows.length ? '<div class="rv-sp-list">' + speciesHtml + "</div>" : '<p class="fc-empty">' + esc(t("review.empty")) + "</p>") +
    "</div>";
  }

  // ---- Review handlers ----
  // Move a single log entry between groups. "__new__" allocates a fresh letter.
  function reviewMoveEntry(rec, eid, targetGrp) {
    var e = rec.log.filter(function (x) { return x.id === eid; })[0]; if (!e) return;
    if (targetGrp === "__new__") targetGrp = nextGroupKey(rec);
    e.grp = targetGrp;
    putFieldRecord(rec);
  }
  // Edit an aggregated species' count / breeding code / shared note. Counts
  // and notes act on the species' entries WITHIN this group: count gets
  // stamped on the most recent entry (others zeroed), code/note on the most
  // recent entry — pragmatic since the source-entries list still lets users
  // touch individual entries when needed.
  function reviewEditSpecies(rec, grp, key, patch) {
    var ents = entriesInGroup(rec, grp).filter(function (e) { return e.key === key; });
    if (!ents.length) return;
    var last = ents[ents.length - 1];
    if (patch.count !== undefined) {
      ents.forEach(function (e) { e.count = null; });
      last.count = patch.count;
    }
    if (patch.code !== undefined) {
      var residual = ents.reduce(function (s, e) {
        var others = String(e.act || "").split(" / ").filter(function (a) { return a && !EBIRD_BREEDING[a]; });
        return s.concat(others);
      }, []);
      // Map code back to first FIELD_ACTS entry that produces it
      var actForCode = null;
      Object.keys(EBIRD_BREEDING).some(function (k) { if (EBIRD_BREEDING[k] === patch.code) { actForCode = k; return true; } });
      var newActs = [];
      if (actForCode) newActs.push(actForCode);
      residual.forEach(function (r) { if (newActs.indexOf(r) < 0) newActs.push(r); });
      last.act = newActs.join(" / ");
      ents.slice(0, -1).forEach(function (e) {
        e.act = String(e.act || "").split(" / ").filter(function (a) { return !EBIRD_BREEDING[a]; }).join(" / ");
      });
    }
    if (patch.note !== undefined) {
      last.note = patch.note;
      ents.slice(0, -1).forEach(function (e) { e.note = ""; });
    }
    putFieldRecord(rec);
  }

  // Pipe-separated per-entry detail string for one species, embedded in the
  // species-summary CSV exports so each report carries the individual time
  // + location of every observation. Power users can split on " | " to expand.
  function observationsSummary(ents) {
    return (ents || []).map(function (e) {
      var bits = [];
      if (e.ts) bits.push(new Date(e.ts).toISOString());
      if (e.lat != null && e.lon != null) bits.push(e.lat.toFixed(5) + "," + e.lon.toFixed(5));
      if (e.count != null && e.count !== "") bits.push("×" + e.count);
      if (e.sex) bits.push(e.sex);
      if (e.act) bits.push(actLabel(e.act));
      if (e.note) bits.push('"' + String(e.note).replace(/"/g, "'") + '"');
      return bits.join(" ");
    }).join(" | ");
  }
  function fieldChecklistCsv() {
    var entries = getFieldEntries(), esc = function (v) { var s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var byKey = {}; (fieldData || []).forEach(function (r) { byKey[r.key] = r; });
    var titleEl = document.getElementById("field-coords");
    var title = (titleEl && titleEl.value || "").trim() || (fieldLat.toFixed(4) + "°, " + fieldLon.toFixed(4) + "°");
    var lid = fieldKey || "";
    var rec = curFieldRecord(false);
    var lines = ["# " + title + " | " + new Date().toISOString().slice(0, 10)];
    lines.push("checklist,list_id,species,common_name,count,activity,notes,observations");
    Object.keys(entries).forEach(function (key) {
      var e = entries[key]; if (!e.seen && (e.count == null || e.count === "") && !e.act && !e.note) return;
      var name = (byKey[key] && byKey[key].name) || (labelsByKey[key] && speciesName(labelsByKey[key])) || key;
      var ents = rec ? fcEntriesFor(rec, key) : [];
      lines.push([esc(title), esc(lid), key, esc(name), e.count != null ? e.count : "", e.act ? actName(e.act) : "", esc(e.note || ""), esc(observationsSummary(ents))].join(","));
    });
    return lines.join("\n");
  }

  // The recorded (seen / counted / activity) species of the open checklist,
  // alphabetical — shared by the PDF export.
  function fieldSeenRows() {
    var entries = getFieldEntries();
    var byKey = {}; (fieldData || []).forEach(function (r) { byKey[r.key] = r; });
    var rec = curFieldRecord(false);
    var rows = [];
    Object.keys(entries).forEach(function (key) {
      var e = entries[key]; if (!e.seen && (e.count == null || e.count === "") && !e.act && !e.note) return;
      var name = (byKey[key] && byKey[key].name) || (labelsByKey[key] && speciesName(labelsByKey[key])) || key;
      var ents = rec ? fcEntriesFor(rec, key) : [];
      rows.push({ name: name, count: e.count != null ? e.count : "", act: e.act ? actName(e.act) : "", note: e.note || "", entries: ents });
    });
    rows.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return rows;
  }

  // Open a clean, print-ready page of the seen birds in a new tab and trigger
  // the print dialog (where the browser offers "Save as PDF"). No PDF library
  // needed — works offline.
  function exportFieldPdf() {
    var title = (document.getElementById("field-coords").value || "").trim() || t("btn.checklist").replace(/^[^\wÀ-ɏ]+\s*/, "");
    var date = new Date().toISOString().slice(0, 10);
    var rows = fieldSeenRows();
    var esc = escapeHtml;
    function obsLineHtml(e) {
      var parts = [];
      if (e.ts) parts.push(esc(fmtClock(e.ts)));
      if (e.lat != null && e.lon != null) parts.push(esc(e.lat.toFixed(5) + ", " + e.lon.toFixed(5)));
      if (e.count != null && e.count !== "") parts.push(esc("×" + e.count));
      if (e.sex) parts.push(sexGlyphHtml(e.sex));
      if (e.act) parts.push(esc(actLabel(e.act)));
      if (e.note) parts.push(esc("“" + e.note + "”"));
      return parts.join(" · ");
    }
    var body = rows.map(function (r, i) {
      var obs = (r.entries || []).map(function (e) { return '<div class="obs">' + obsLineHtml(e) + "</div>"; }).join("");
      return "<tr><td>" + (i + 1) + "</td><td>" + esc(r.name) + obs + "</td><td>" + esc(String(r.count)) + "</td><td>" + esc(r.act) + "</td><td>" + esc(r.note) + "</td></tr>";
    }).join("") || '<tr><td></td><td colspan="4">' + esc(t("analysis.empty")) + "</td></tr>";
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + "</title><style>" +
      "body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#16302b;margin:32px;}" +
      "h1{font-size:19px;color:#0b3a3a;margin:0 0 2px;}" +
      ".meta{color:#5b6f69;font-size:12px;margin-bottom:18px;}" +
      "table{border-collapse:collapse;width:100%;font-size:13px;}" +
      "th,td{text-align:left;padding:6px 9px;border-bottom:1px solid #d8e1dd;vertical-align:top;}" +
      "th{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#5b6f69;}" +
      "thead th{border-bottom:2px solid #bcccc6;}" +
      "td:first-child,th:first-child{width:30px;color:#93a39d;}" +
      "td:nth-child(3),th:nth-child(3){text-align:right;width:64px;}" +
      ".obs{font-size:10.5px;color:#5b6f69;margin-top:2px;font-variant-numeric:tabular-nums;}" +
      "</style></head><body>" +
      "<h1>" + esc(title) + "</h1>" +
      '<div class="meta">' + esc(date) + " &middot; " + rows.length + " " + esc(t("chk.seen").toLowerCase()) + "</div>" +
      "<table><thead><tr><th>#</th><th>" + esc(t("th.species")) + "</th><th>" + esc(t("chk.count")) +
      "</th><th>" + esc(t("chk.activity")) + "</th><th>" + esc(t("th.notes")) + "</th></tr></thead><tbody>" + body + "</tbody></table>" +
      "</body></html>";
    openPrintWindow(html);
  }

  function openPrintWindow(html) {
    var w = window.open("", "_blank");
    if (!w) { setStatus(t("status.error", { msg: "popup blocked" })); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(function () { try { w.print(); } catch (e) { /* user can print manually */ } }, 300);
  }

  // Printable PDF of the detailed Species List (same columns as on screen).
  function exportSpeciesPdf() {
    if (!lastSpeciesPdf || !lastSpeciesPdf.rows.length) { setStatus(t("status.selectSpecies")); return; }
    var d = lastSpeciesPdf, esc = escapeHtml;
    var heading = t("panel.spTitle");
    var meta = (document.getElementById("sp-coords").textContent || "").trim();
    var n2 = !!d.name2Head, cmp = !!d.cmpHead;
    var thead = "<tr><th>#</th><th>" + esc(t("th.species")) + "</th>" +
      (n2 ? "<th>" + esc(d.name2Head) + "</th>" : "") +
      "<th>" + esc(t("th.sci")) + "</th><th class='num'>" + esc(t("th.prob")) + "</th>" +
      (cmp ? "<th class='num'>" + esc(d.cmpHead) + "</th>" : "") + "</tr>";
    var body = d.rows.map(function (r, i) {
      return "<tr><td>" + (i + 1) + "</td><td>" + esc(r.name) + "</td>" +
        (n2 ? "<td>" + esc(r.name2) + "</td>" : "") +
        "<td class='sci'>" + esc(r.sci) + "</td><td class='num'>" + esc(r.prob) + "</td>" +
        (cmp ? "<td class='num'>" + esc(r.cmp) + "</td>" : "") + "</tr>";
    }).join("");
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(heading) + "</title><style>" +
      "body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#16302b;margin:32px;}" +
      "h1{font-size:19px;color:#0b3a3a;margin:0 0 2px;}" +
      ".meta{color:#5b6f69;font-size:12px;margin-bottom:18px;}" +
      "table{border-collapse:collapse;width:100%;font-size:13px;}" +
      "th,td{text-align:left;padding:6px 9px;border-bottom:1px solid #d8e1dd;}" +
      "th{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#5b6f69;}" +
      "thead th{border-bottom:2px solid #bcccc6;}" +
      "td:first-child,th:first-child{width:30px;color:#93a39d;}" +
      "td.sci{font-style:italic;} td.num,th.num{text-align:right;white-space:nowrap;}" +
      "</style></head><body>" +
      "<h1>" + esc(heading) + "</h1>" +
      '<div class="meta">' + esc(meta) + "</div>" +
      "<table><thead>" + thead + "</thead><tbody>" + body + "</tbody></table>" +
      "</body></html>";
    openPrintWindow(html);
  }

  // ---- "Species in country": sample many cells covering the country ---------
  // Single-point Species List inverts to: for each H3 cell tiling the country
  // (at a configurable resolution) infer probabilities, then aggregate the
  // peak probability per species across all cells. Cached by (cc, res) for
  // cells and (cc, res, week) for the species-max vector.
  var countryGeomCache = {}, countryCellsCache = {}, countryAggCache = {}, countryEBirdCache = {};
  // Active per-species aggregation for the country list: 'max' | 'p90' | 'median'.
  var countryAgg = (window.GeoState.get("countryAgg", "max") || "max");
  // Which species-panel context is showing — drives whether the Checklist
  // button creates a point-anchored checklist or a country-wide one.
  var currentSpView = null;
  // eBird country species list (all species ever recorded in the region) —
  // used as the "official" national bird list to merge against the model's
  // predictions. BirdLife DataZone factsheets aren't fetchable from a static
  // browser (its CORS allows only its own origin), so eBird's broader list
  // (CORS *, needs the user's key) is the practical source.
  // Reason the last ebirdCountrySpecies call returned null — used to surface a
  // diagnostic hint in the country caption when the merge can't run, instead
  // of silently dropping the merge view.
  var lastSppError = null;
  async function ebirdCountrySpecies(cc) {
    lastSppError = null;
    if (!cc) { lastSppError = "no-country"; return null; }
    if (countryEBirdCache[cc]) return countryEBirdCache[cc];
    var tok = ebirdKey();
    if (!tok) { lastSppError = "no-key"; return null; }
    try {
      var r = await fetch("https://api.ebird.org/v2/product/spplist/" + encodeURIComponent(cc), { headers: { "X-eBirdApiToken": tok } });
      if (!r.ok) { lastSppError = "http-" + r.status; return null; }
      var arr = await r.json();
      if (!Array.isArray(arr)) { lastSppError = "format"; return null; }
      var set = Object.create(null);
      arr.forEach(function (c) { set[c] = 1; });
      countryEBirdCache[cc] = set;
      return set;
    } catch (e) { lastSppError = "network"; return null; }
  }
  var SP_COUNTRY_MAX_CELLS = 8000;
  function pointInRing(lng, lat, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    }
    return inside;
  }
  function bboxOfRing(ring) {
    var b = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 };
    for (var i = 0; i < ring.length; i++) {
      var p = ring[i]; if (p[1] < b.minLat) b.minLat = p[1]; if (p[1] > b.maxLat) b.maxLat = p[1];
      if (p[0] < b.minLng) b.minLng = p[0]; if (p[0] > b.maxLng) b.maxLng = p[0];
    }
    return b;
  }
  // Nominatim returns the country polygon (GeoJSON) when polygon_geojson=1.
  function fetchCountryGeometry(cc, lat, lon) {
    if (countryGeomCache[cc]) return Promise.resolve(countryGeomCache[cc]);
    var url = "https://nominatim.openstreetmap.org/reverse?format=json&zoom=3&addressdetails=0&polygon_geojson=1&lat=" + lat + "&lon=" + lon;
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { var g = j && j.geojson; if (g && (g.type === "Polygon" || g.type === "MultiPolygon")) { countryGeomCache[cc] = g; return g; } return null; })
      .catch(function () { return null; });
  }
  // H3 cells (at res) covering the country polygon. Try h3 polygonToCells; on
  // failure (large geometries can throw) fall back to a bbox grid filtered by
  // point-in-polygon. For countries with overseas territories (e.g. France
  // returns a 91-piece MultiPolygon spanning −178°..+172°) we keep only the
  // polygon containing the clicked point — otherwise antimeridian-spanning
  // pieces produce huge bboxes / throw and the coverage collapses to ~nothing.
  function cellsCoveringCountry(geom, res, clickLat, clickLon) {
    var polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    if (geom.type === "MultiPolygon" && clickLat != null && clickLon != null) {
      for (var pi = 0; pi < polygons.length; pi++) {
        if (pointInRing(clickLon, clickLat, polygons[pi][0])) { polygons = [polygons[pi]]; break; }
      }
    }
    var out = Object.create(null);
    polygons.forEach(function (poly) {
      var added = false;
      try {
        var cells = window.h3.polygonToCells(poly, res, true);   // isGeoJson = true ([lng,lat])
        if (cells && cells.length) { for (var i = 0; i < cells.length; i++) out[cells[i]] = 1; added = true; }
      } catch (e) { /* fall through */ }
      if (!added) {
        var outer = poly[0], b = bboxOfRing(outer);
        var edgeKm = window.h3.getHexagonEdgeLengthAvg(res, "km");
        var stepLat = Math.max(0.005, edgeKm / 111 * 0.7);
        var stepLng = stepLat / Math.max(0.1, Math.cos(((b.minLat + b.maxLat) / 2) * Math.PI / 180));
        for (var la = b.minLat; la <= b.maxLat + 1e-9; la += stepLat) {
          for (var ln = b.minLng; ln <= b.maxLng + 1e-9; ln += stepLng) {
            if (pointInRing(ln, la, outer)) out[window.h3.latLngToCell(la, ln, res)] = 1;
          }
        }
      }
    });
    return Object.keys(out);
  }
  // For each H3 cell in `cells`, infer (lat, lon, week); keep the per-species
  // max across all cells. One worker call per CHUNK; the raw output is
  // reduced batch-by-batch so memory stays bounded.
  // Compute three per-species aggregations across the cells: max (always) and
  // — when the matrix fits — 90th percentile and median (require per-species
  // sorts). The cap keeps the browser stable at high resolution / large countries.
  var SPECIES_AGG_CAP_CELLS = 3000;
  async function speciesAggsAcrossCells(cells, week, progress) {
    var nSpecies = labels.length, CHUNK = inferChunk();
    var allowMatrix = cells.length <= SPECIES_AGG_CAP_CELLS;
    var maxArr = new Float32Array(nSpecies);
    var mat = allowMatrix ? new Float32Array(cells.length * nSpecies) : null;
    for (var s = 0; s < cells.length; s += CHUNK) {
      var batch = cells.slice(s, s + CHUNK);
      var inputs = new Float32Array(batch.length * 3);
      for (var j = 0; j < batch.length; j++) {
        var ll = window.h3.cellToLatLng(batch[j]);
        inputs[j * 3] = ll[0]; inputs[j * 3 + 1] = ll[1]; inputs[j * 3 + 2] = week;
      }
      var out = await runInference(inputs, batch.length);
      if (mat) mat.set(out, s * nSpecies);
      for (var k = 0; k < batch.length; k++) {
        var base = k * nSpecies;
        for (var i = 0; i < nSpecies; i++) { var v = out[base + i]; if (v > maxArr[i]) maxArr[i] = v; }
      }
      if (progress) progress(Math.min(s + batch.length, cells.length), cells.length);
    }
    if (!mat) return { max: maxArr };
    var p90 = new Float32Array(nSpecies), median = new Float32Array(nSpecies);
    var col = new Float32Array(cells.length);
    var p90Idx = Math.min(cells.length - 1, Math.floor(cells.length * 0.9));
    var medIdx = Math.floor(cells.length / 2);
    for (var i2 = 0; i2 < nSpecies; i2++) {
      for (var c = 0; c < cells.length; c++) col[c] = mat[c * nSpecies + i2];
      var sorted = new Float32Array(col); sorted.sort();
      p90[i2] = sorted[p90Idx];
      median[i2] = sorted[medIdx];
    }
    return { max: maxArr, p90: p90, median: median };
  }
  async function renderSpeciesInCountry(lat, lon) {
    var info = await countryInfo(lat, lon);
    if (!info.cc) { setStatus(t("status.error", { msg: "country lookup failed" })); return; }
    var res = +window.GeoState.get("countryRes", 3) || 3;
    var week = +document.getElementById("week-select").value;
    var pmin = +document.getElementById("prob-min").value / 100;
    var pmax = +document.getElementById("prob-max").value / 100;
    setStatus(t("status.countryGeo", { country: info.name || info.cc }));
    showComputingOverlay(true, info.name || info.cc);
    try {
      var geom = await fetchCountryGeometry(info.cc, lat, lon);
      if (!geom) { setStatus(t("status.error", { msg: "country geometry unavailable" })); return; }
      // Cache cells by (cc, res, rounded click) — different polygons (mainland
      // vs an overseas island) for the same country must not share a cache.
      var cellsKey = info.cc + ":" + res + ":" + Math.round(lat * 2) / 2 + "," + Math.round(lon * 2) / 2;
      var cells = countryCellsCache[cellsKey] || (countryCellsCache[cellsKey] = cellsCoveringCountry(geom, res, lat, lon));
      if (!cells.length) { setStatus(t("status.error", { msg: "no cells" })); return; }
      if (cells.length > SP_COUNTRY_MAX_CELLS) { setStatus(t("status.countryTooMany", { n: cells.length, max: SP_COUNTRY_MAX_CELLS })); return; }
      var aggKey = info.cc + ":" + res + ":" + week;
      var aggs = countryAggCache[aggKey];
      if (!aggs) {
        setStatus(t("status.countrySampling", { country: info.name || info.cc, n: cells.length, week: week, res: res }));
        aggs = await speciesAggsAcrossCells(cells, week, function (done, total) { setComputeProgress(done / total); });
        countryAggCache[aggKey] = aggs;
      }
      var maxArr = aggs[countryAgg] || aggs.max;
      var spp = await ebirdCountrySpecies(info.cc);   // null when no key / fetch fails
      var results = [];
      for (var i = 0; i < labels.length; i++) {
        var lbl = labels[i]; if (!inGroup(i) || !passSpeciesFilter(lbl.key)) continue;
        var prob = maxArr[i];
        var inModel = prob >= pmin && prob <= pmax;
        var inList = !!(spp && spp[lbl.key]);
        if (!inModel && !inList) continue;
        results.push({ label: lbl, prob: prob, inModel: inModel, inList: inList });
      }
      // Both (predicted + recorded) on top by prob; model-only next; list-only
      // last, sorted alphabetically — the "missing from prediction" group.
      results.sort(function (a, b) {
        var ka = a.inModel && a.inList ? 0 : a.inModel ? 1 : 2;
        var kb = b.inModel && b.inList ? 0 : b.inModel ? 1 : 2;
        if (ka !== kb) return ka - kb;
        if (ka === 2) return speciesName(a.label).localeCompare(speciesName(b.label));
        return b.prob - a.prob;
      });
      var sh1 = document.getElementById("sp-species-head");
      if (sh1) sh1.textContent = speciesHeadLabel();
      var nList = spp ? results.filter(function (r) { return !r.inModel && r.inList; }).length : 0;
      currentSpView = { mode: "country", cc: info.cc, name: info.name, lat: lat, lon: lon, results: results };
      var ph = document.getElementById("sp-prob-head");
      var aggLabel = countryAgg === "median" ? t("agg.median") : countryAgg === "p90" ? t("agg.p90") : t("agg.max");
      if (aggs.p90 && aggs.median) {
        ph.textContent = aggLabel + " ▾";
        ph.title = t("agg.tooltip");
        ph.classList.add("clickable-head");
      } else {
        ph.textContent = aggLabel;
        ph.title = t("agg.unavail", { n: cells.length });
        ph.classList.remove("clickable-head");
      }
      document.getElementById("sp-delta-head").textContent = spp ? t("th.source") : "";
      var tbl = document.getElementById("species-list-table");
      tbl.classList.toggle("has-name2", !!secondLang);
      tbl.classList.toggle("hide-sci", !showSci);
      document.getElementById("sp-name2-head").textContent = secondLang ? window.GeoI18N.langByCode(secondLang).name : "";
      var mergeHint = "";
      if (!spp) {
        if (lastSppError === "no-key") mergeHint = " · " + t("merge.noKey");
        else if (lastSppError && lastSppError.indexOf("http-") === 0) mergeHint = " · " + t("merge.httpErr", { code: lastSppError.slice(5) });
        else if (lastSppError) mergeHint = " · " + t("merge.netErr");
        if (mergeHint) setStatus(mergeHint.replace(/^ \xb7 /, ""));
      }
      document.getElementById("sp-coords").textContent = (spp
        ? t("sp.countrySummaryMerged", { country: info.name || info.cc, n: cells.length, week: week, ns: results.length - nList, nl: nList, p: (pmin * 100).toFixed(0) })
        : t("sp.countrySummary", { country: info.name || info.cc, n: cells.length, week: week, ns: results.length, p: (pmin * 100).toFixed(0) })) + mergeHint;
      var cProbs = results.filter(function (r) { return r.inModel; }).map(function (r) { return r.prob; });
      var cLo = cProbs.length ? Math.min.apply(null, cProbs) : 0;
      var cHi = cProbs.length ? Math.max.apply(null, cProbs) : 1;
      var cRange = cHi - cLo;
      document.getElementById("sp-tbody").innerHTML = results.map(function (r) {
        var name2Cell = '<td class="name2">' + (secondLang ? escapeHtml(secondName(r.label)) : "") + "</td>";
        var pctC = r.inModel ? Math.round(r.prob * 100) : null;
        var probCell = r.inModel
          ? '<td class="prob-cell"><span class="prob-num">' + pctC + '%</span><div class="prob-bar" style="width:' + pctC + '%;background:' + probHueColor(cRange > 0 ? (r.prob - cLo) / cRange : 1) + '"></div></td>'
          : '<td class="prob-cell prob-na">—</td>';
        var chip;
        if (!spp) chip = "";
        else if (r.inModel && r.inList) chip = '<span class="src-chip src-both" title="' + escapeHtml(t("src.both")) + '">✓</span>';
        else if (r.inModel) chip = '<span class="src-chip src-model" title="' + escapeHtml(t("src.modelOnly")) + '">?</span>';
        else chip = '<span class="src-chip src-list" title="' + escapeHtml(t("src.listOnly")) + '">●</span>';
        return "<tr" + (!r.inModel ? ' class="row-list-only"' : "") + "><td>" + nameLinkHtml(r.label) + "</td>" + name2Cell + '<td class="sci">' + escapeHtml(r.label.sci) + "</td>" + probCell + '<td class="num det-nd"></td><td>' + chip + "</td></tr>";
      }).join("");
      var sp = document.getElementById("species-panel");
      sp.classList.toggle("as-page", currentMode === "list");
      sp.style.display = "block";
      if (currentMode === "list") { sp.scrollTop = 0; navOpen("page", closeAnyFullPage); }
      document.getElementById("barchart-panel").style.display = "none";
      setStatus(t("status.countryDone", { country: info.name || info.cc, ns: results.length, n: cells.length }));
      // CSV download.
      var hdr = "rank,species_code,common_name" + (secondLang ? ",common_name_" + secondLang : "") + ",scientific_name,max_probability";
      if (spp) hdr += ",predicted,in_ebird_country_list";
      var lines = [hdr];
      results.forEach(function (r, idx) {
        var line = (idx + 1) + ',"' + r.label.key + '","' + speciesName(r.label).replace(/"/g, '""') + '"';
        if (secondLang) line += ',"' + secondName(r.label).replace(/"/g, '""') + '"';
        line += ',"' + r.label.sci.replace(/"/g, '""') + '",' + r.prob.toFixed(6);
        if (spp) line += "," + (r.inModel ? 1 : 0) + "," + (r.inList ? 1 : 0);
        lines.push(line);
      });
      lastCsvData = { filename: "Geomodel_country_" + info.cc + "_week" + week + "_res" + res + ".csv", content: lines.join("\n") };
      showCsvBtn();
      // Snapshot for the PDF export button (was broken in country view because
      // only renderSpeciesList populated lastSpeciesPdf).
      lastSpeciesPdf = {
        name2Head: secondLang ? window.GeoI18N.langByCode(secondLang).name : "",
        cmpHead: spp ? t("th.source") : "",
        rows: results.map(function (r) {
          var src = spp ? (r.inModel && r.inList ? "✓" : r.inModel ? "?" : "●") : "";
          return { name: speciesName(r.label), name2: secondLang ? secondName(r.label) : "", sci: r.label.sci, prob: r.inModel ? ((r.prob * 100).toFixed(1) + "%") : "—", cmp: src };
        }),
      };
    } catch (e) { setStatus(t("status.error", { msg: e.message })); console.error(e); }
    finally { showComputingOverlay(false); }
  }

  async function renderSpeciesList(lat, lon) {
    currentSpView = { mode: "point", lat: lat, lon: lon };
    if (currentMode === "list") saveSession({ mode: "list", page: "species", lat: lat, lon: lon });
    setPointMarker(lat, lon);   // show the pin for the point this list is about
    // Reset the agg toggle on the prob column header (country-only feature).
    var ph0 = document.getElementById("sp-prob-head");
    if (ph0) { ph0.textContent = t("th.prob"); ph0.title = ""; ph0.classList.remove("clickable-head"); }
    var sh0 = document.getElementById("sp-species-head");
    if (sh0) sh0.textContent = speciesHeadLabel();
    var ah0 = document.getElementById("sp-nd-head");
    if (ah0) ah0.textContent = ageHeadLabel();
    updateSortIndicators();
    var week = +document.getElementById("week-select").value;
    var pmin = +document.getElementById("prob-min").value / 100;
    var pmax = +document.getElementById("prob-max").value / 100;
    setStatus(t("status.predicting", { lat: lat.toFixed(2), lon: lon.toFixed(2), week: week }));
    try {
      var out = await runInference(new Float32Array([lat, lon, week]), 1);
      var cmp = await computeComparison(lat, lon, week);
      var hasCompare = !!cmp.probs;
      var kind = cmp.kind;   // "delta" | "ratio" | "focus"
      var results = [];
      for (var i = 0; i < labels.length; i++) {
        if (out[i] >= pmin && out[i] <= pmax && inGroup(i) && passSpeciesFilter(labels[i].key)) {
          var cval = 0;
          if (hasCompare) {
            cval = kind === "ratio" ? (cmp.probs[i] > 0 ? out[i] / cmp.probs[i] : 0)
                 : kind === "focus" ? cmp.probs[i]
                 : (out[i] - cmp.probs[i]);
          }
          results.push({ label: labels[i], prob: out[i], cmpVal: cval });
        }
      }
      results.sort(function (a, b) { return b.prob - a.prob; });
      // When every comparison value is positive, show it as a probability-style
      // bar; otherwise (e.g. week-over-week change) show the value with
      // negatives in red.
      var cmpAllPositive = hasCompare && results.every(function (r) { return r.cmpVal >= 0; });
      // Probability palette is min-max stretched across the visible list (like
      // the analysis heatmap) so the strongest species reads green, weakest red.
      var pHi = results.length ? results[0].prob : 1;            // sorted desc → max first
      var pLo = results.length ? results[results.length - 1].prob : 0;
      var pRange = pHi - pLo;

      document.getElementById("sp-delta-head").textContent =
        !hasCompare ? "" : kind === "focus" ? cmp.refLabel : t(kind === "ratio" ? "th.ratio" : "th.delta", { ref: cmp.refLabel });
      // Optional second-language name column.
      var tbl = document.getElementById("species-list-table");
      tbl.classList.toggle("has-name2", !!secondLang);
      tbl.classList.toggle("hide-sci", !showSci);
      document.getElementById("sp-name2-head").textContent = secondLang ? window.GeoI18N.langByCode(secondLang).name : "";
      setCoordsWithPlace(document.getElementById("sp-coords"), lat, lon,
        t("sp.summary", { lat: lat.toFixed(4), lon: lon.toFixed(4), week: week, n: results.length, p: (pmin * 100).toFixed(0) }));
      document.getElementById("sp-tbody").innerHTML = results.map(function (r) {
        var cmpCell = !hasCompare ? "<td></td>" : cmpAllPositive ? cmpBarCell(kind, r.cmpVal) : deltaCell(r.cmpVal);
        var name2Cell = '<td class="name2">' + (secondLang ? escapeHtml(secondName(r.label)) : "") + '</td>';
        var dKey = escapeHtml(r.label.key);
        var pct = Math.round(r.prob * 100);
        return '<tr><td>' + nameLinkHtml(r.label) + '</td>' + name2Cell + '<td class="sci">' +
               escapeHtml(r.label.sci) + '</td><td class="prob-cell"><span class="prob-num">' + pct +
               '%</span><div class="prob-bar" style="width:' + pct + '%;background:' + probHueColor(pRange > 0 ? (r.prob - pLo) / pRange : 1) + '"></div></td>' +
               '<td class="num det-nd" data-key="' + dKey + '">…</td>' + cmpCell + '</tr>';
      }).join("");
      var sp = document.getElementById("species-panel");
      // In Species-List mode show the list as a full-screen page; in Range mode
      // keep it as an inline card under the map.
      sp.classList.toggle("as-page", currentMode === "list");
      sp.style.display = "block";
      if (currentMode === "list") { sp.scrollTop = 0; navOpen("page", closeAnyFullPage); }
      document.getElementById("barchart-panel").style.display = "none";
      setStatus(t("status.spResult", { n: results.length, p: (pmin * 100).toFixed(0), lat: lat.toFixed(2), lon: lon.toFixed(2) }));

      // Build CSV for species list (includes 2nd-name + comparison columns when active)
      var header = "rank,species_code,common_name";
      if (secondLang) header += ",common_name_" + secondLang;
      header += ",scientific_name,probability";
      if (hasCompare) header += "," + (kind === "ratio" ? "fraction_of_" : kind === "focus" ? "annual_top_" : "delta_vs_") + cmp.refLabel.replace(/[",\s]+/g, "_");
      var csvLines = [header];
      results.forEach(function (r, idx) {
        var line = (idx + 1) + ',"' + r.label.key + '","' + speciesName(r.label).replace(/"/g, '""') + '"';
        if (secondLang) line += ',"' + secondName(r.label).replace(/"/g, '""') + '"';
        line += ',"' + r.label.sci.replace(/"/g, '""') + '",' + r.prob.toFixed(6);
        if (hasCompare) line += "," + r.cmpVal.toFixed(6);
        csvLines.push(line);
      });
      lastCsvData = {
        filename: "Geomodel_species_list_" + lat.toFixed(2) + "_" + lon.toFixed(2) + "_week" + week + ".csv",
        content: csvLines.join("\n")
      };
      // Snapshot the displayed rows/columns for the printable PDF export.
      // Augment rows with all-species recent-detection counts + age (last 30 d).
      augmentRowsWithSightings(lat, lon);
      lastSpeciesPdf = {
        name2Head: secondLang ? window.GeoI18N.langByCode(secondLang).name : "",
        cmpHead: document.getElementById("sp-delta-head").textContent || "",
        rows: results.map(function (r) {
          var cmpText = "";
          if (hasCompare) {
            cmpText = kind === "ratio" ? Math.round(r.cmpVal * 100) + "%"
              : kind === "focus" ? (r.cmpVal * 100).toFixed(0) + "%"
              : (r.cmpVal >= 0 ? "+" : "") + (r.cmpVal * 100).toFixed(1) + "%";
          }
          return { name: speciesName(r.label), name2: secondLang ? secondName(r.label) : "", sci: r.label.sci, prob: (r.prob * 100).toFixed(1) + "%", cmp: cmpText };
        }),
      };
      showCsvBtn();
    } catch (e) { setStatus(t("status.error", { msg: e.message })); console.error(e); }
  }

  // ---- Computing overlay ---------------------------------------------------
  function showComputingOverlay(show, name) {
    var el = document.getElementById("demo-computing");
    if (!el) return;
    el.style.display = show ? "flex" : "none";
    if (show) {
      document.getElementById("computing-text").textContent = name || "";
      document.getElementById("computing-progress-bar").style.width = "0%";
    }
  }

  // ---- Legend ---------------------------------------------------------------
  function updateLegend() {
    var el = document.getElementById("demo-legend");
    if (!el) return;
    if ((currentMode !== "range" && currentMode !== "richness") || !cachedRender) { el.style.display = "none"; return; }

    var isRichness = currentMode === "richness";
    var maxVal = isRichness && cachedRender.maxVal ? Math.round(cachedRender.maxVal) : 0;
    var maxProb = !isRichness && cachedRender.maxProb ? cachedRender.maxProb : 1;

    var html = '<div class="legend-title">' + (isRichness ? t("legend.count") : t("legend.prob")) + '</div><div class="legend-bar">';
    var stops = [];
    for (var i = 0; i <= 10; i++) {
      var lt = i / 10, c = colormapLookup(lt);
      stops.push("rgb(" + c[0] + "," + c[1] + "," + c[2] + ") " + Math.round(lt * 100) + "%");
    }
    html += '<div class="legend-gradient" style="background:linear-gradient(to right,' + stops.join(",") + ')"></div>';
    html += '<div class="legend-ticks">';
    [0, 0.5, 1].forEach(function (tick) {
      var rawT = Math.pow(tick, 1 / DISPLAY_GAMMA);
      html += "<span>" + (isRichness ? Math.round(rawT * maxVal) : Math.round(rawT * maxProb * 100) + "%") + "</span>";
    });
    html += "</div></div>";
    el.innerHTML = html;
    el.style.display = "block";
  }

  // ---- CSV helpers ---------------------------------------------------------
  function downloadCsv(filename, content) {
    var blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function showCsvBtn() {
    document.getElementById("csv-btn-wrap").style.display = "";
  }

  function hideCsvBtn() {
    document.getElementById("csv-btn-wrap").style.display = "none";
    lastCsvData = null;
  }

  function buildRangeMapCsv() {
    var key = document.getElementById("species-search").dataset.selectedKey;
    if (!key || !labelsByKey[key] || !window.h3) return null;
    var week = +document.getElementById("week-select").value;
    var cache = h3RangeCache.get(key + ":" + week) || {};
    var cells = h3CellsInView(h3ResForView());
    var lines = ["h3,latitude,longitude,probability"];
    cells.forEach(function (c) {
      var val = cache[c];
      if (val == null || !(val > 0.001)) return;
      var ll = window.h3.cellToLatLng(c);
      lines.push(c + "," + ll[0].toFixed(4) + "," + ll[1].toFixed(4) + "," + val.toFixed(6));
    });
    if (lines.length === 1) return null;
    var lbl = labelsByKey[key];
    return {
      filename: "Geomodel_range_" + speciesName(lbl).replace(/\s+/g, "_") + "_week" + week + ".csv",
      content: lines.join("\n")
    };
  }

  function buildRichnessCsv() {
    var week = +document.getElementById("week-select").value;
    var g = viewportGrid();
    var cm = getCellMap(cacheKey(richKey(),week), g.step);
    var lines = ["latitude,longitude,species_count"];
    for (var iLat = 0; iLat < g.nLat; iLat++) {
      var lat = g.north - (iLat + 0.5) * g.step;
      for (var iLon = 0; iLon < g.nLon; iLon++) {
        var lon = wrapLon(g.west + (iLon + 0.5) * g.step);
        var val = cm.get(cellId(lat, lon)) || 0;
        lines.push(lat.toFixed(4) + "," + lon.toFixed(4) + "," + Math.round(val));
      }
    }
    return {
      filename: "BirdNET_Geomodel_richness_week" + week + ".csv",
      content: lines.join("\n")
    };
  }

  // ---- Location analysis (Timeline / Probability / Arrivals / Scatter) -----
  // Runs ONE 48-week prediction at the clicked point; all four tabs derive
  // from the cached result. Re-clicking recomputes; tab/filter/sort changes
  // re-render from cache without new inference.
  async function renderAnalysis(lat, lon) {
    var nSpecies = labels.length;
    setPointMarker(lat, lon);   // show the pin for the point this analysis is about
    saveSession({ mode: "barchart", page: "migration", lat: lat, lon: lon });
    document.getElementById("species-panel").style.display = "none";
    document.getElementById("barchart-panel").style.display = "none";
    showComputingOverlay(true, t("panel.bcTitle"));
    setStatus(t("status.predicting48", { lat: lat.toFixed(2), lon: lon.toFixed(2) }));
    try {
      var inputs = new Float32Array(48 * 3);
      for (var w = 0; w < 48; w++) { inputs[w * 3] = lat; inputs[w * 3 + 1] = lon; inputs[w * 3 + 2] = w + 1; }
      var allProbs = await runInference(inputs, 48); // 48 * nSpecies, week-major
      analysisData = { lat: lat, lon: lon, allProbs: allProbs, nSpecies: nSpecies };
      var bc = document.getElementById("barchart-panel");
      bc.classList.add("as-page");   // full-screen page with a back button, like the species list
      bc.style.display = "block";
      bc.scrollTop = 0;
      navOpen("page", closeAnyFullPage);
      updateAnalysisControls();
      renderActiveTab();
    } catch (e) { setStatus(t("status.error", { msg: e.message })); console.error(e); }
    finally { showComputingOverlay(false); }
  }

  // Build the context object the analysis renderers consume.
  function analysisCtx() {
    return {
      allProbs: analysisData.allProbs,
      nSpecies: analysisData.nSpecies,
      labels: labels,
      week: +document.getElementById("week-select").value,
      thresholdFrac: +document.getElementById("prob-min").value / 100,
      thresholdMax: +document.getElementById("prob-max").value / 100,
      filterText: document.getElementById("an-filter").value.trim(),
      topN: +document.getElementById("an-topn").value,
      scatterRankBy: document.getElementById("an-rankby").value,
      scatterSort: scatterSort,
      inGroup: inGroup,
      isHidden: function (key) { return isHidden(key); },
      nameLink: nameLinkHtml,
      speciesName: speciesName,
      escapeHtml: escapeHtml,
      months: window.GeoI18N.months(lang),
      t: t,
      onSortChange: function (s) { scatterSort = s; renderActiveTab(); },
    };
  }

  // Show the active tab as selected and toggle the Top-N control (scatter only).
  function updateAnalysisControls() {
    var tabs = document.querySelectorAll("#an-tabs .an-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("is-active", tabs[i].getAttribute("data-tab") === analysisTab);
    }
    document.getElementById("an-topn-wrap").style.display = analysisTab === "scatter" ? "" : "none";
  }

  function renderActiveTab() {
    if (!analysisData) return;
    var container = document.getElementById("bc-container");
    var ctx = analysisCtx();
    var lat = analysisData.lat, lon = analysisData.lon;
    var nVisible = window.GeoAnalysis.visibleSpecies(ctx).length;

    setCoordsWithPlace(document.getElementById("bc-coords"), lat, lon,
      t("sp.summary", { lat: lat.toFixed(4), lon: lon.toFixed(4), week: ctx.week, n: nVisible, p: (ctx.thresholdFrac * 100).toFixed(0) }));
    setStatus(t("status.spResult", { n: nVisible, p: (ctx.thresholdFrac * 100).toFixed(0), lat: lat.toFixed(2), lon: lon.toFixed(2) }));

    if (analysisTab === "timeline") renderTimelineTab(container, ctx);
    else if (analysisTab === "scatter") window.GeoAnalysis.renderScatter(container, ctx);
    else window.GeoAnalysis.renderHeatmap(container, ctx, analysisTab);   // "prob" | "arrival" | "focus"

    // The Migration page has no CSV download (data is explored on-page).
    hideCsvBtn();
  }

  // Timeline tab: per-species 48-week phenology bars (sorted by annual mean).
  function renderTimelineTab(container, ctx) {
    var wkIdx = ctx.week - 1;
    var rows = window.GeoAnalysis.visibleSpecies(ctx);
    // Sort by current-week probability (largest first).
    rows.sort(function (a, b) { return b.probs[wkIdx] - a.probs[wkIdx]; });

    var globalMax = 0;
    rows.forEach(function (r) {
      var mx = 0; for (var w = 0; w < 48; w++) if (r.probs[w] > mx) mx = r.probs[w];
      r.max = mx;
      if (mx > globalMax) globalMax = mx;
    });
    if (globalMax < 0.01) globalMax = 0.01;

    if (rows.length === 0) { container.innerHTML = '<p class="an-empty">' + escapeHtml(t("analysis.empty")) + "</p>"; return; }

    var MONTH_LABELS = ctx.months;
    var html = "";
    for (var ri = 0; ri < rows.length; ri++) {
      var r = rows[ri];
      html += '<div class="bc-species"><div class="bc-header">' +
        '<span class="bc-rank">' + (ri + 1) + '</span>' +
        '<span class="bc-name">' + nameLinkHtml(r.label) + '</span>' +
        '<span class="bc-sci">' + escapeHtml(r.label.sci) + '</span>' +
        '<span class="bc-avg">' + t("bc.max", { p: (r.max * 100).toFixed(1) }) + '</span>' +
        '</div><div class="bc-bars">';
      for (var w3 = 0; w3 < 48; w3++) {
        var prob = r.probs[w3];
        var norm = prob / globalMax;
        var pct = norm * 100;
        var monthClass = (w3 % 4 === 0) ? " bc-month-start" : "";
        var curClass = (w3 === wkIdx) ? " bc-cur" : "";
        html += '<div class="bc-bar' + monthClass + curClass + '" style="height:' + pct.toFixed(1) + '%;background:' + probHueColor(norm) + '" title="' + (w3 + 1) + ": " + (prob * 100).toFixed(1) + '%"></div>';
      }
      html += '</div><div class="bc-months">';
      for (var m = 0; m < 12; m++) html += "<span>" + escapeHtml(MONTH_LABELS[m]) + "</span>";
      html += "</div></div>";
    }
    container.innerHTML = html;
  }

  // ---- Update CSV for range/richness after render --------------------------
  function updateMapCsv() {
    // Rebuilding the CSV string scans every viewport cell; skip it during
    // animation playback (it refreshes when the animation stops).
    if (animating) return;
    // Neither map view (Species Range / Species Richness) shows an under-map
    // CSV download; map data is explored via the species list / analysis.
    if (currentMode === "range" || currentMode === "richness") hideCsvBtn();
  }

  // ---- Migration animation -------------------------------------------------
  // Precomputes all 48 weeks for the current viewport, then steps through them
  // so the user watches the predicted range/richness shift across the year.
  function setPlayBtn(playing) {
    var b = document.getElementById("play-btn");
    if (b) b.textContent = playing ? t("btn.pause") : t("btn.play");
    var a = animCtrlEl && animCtrlEl.querySelector(".anim-btn");
    if (a) { a.innerHTML = animIconSvg(playing); a.title = playing ? t("btn.pause") : t("btn.play"); a.setAttribute("aria-label", a.title); }
  }

  // Month-divided progress bar (map width) shown during migration playback,
  // marking which week the displayed frame represents.
  function showPlayProgress(on) {
    var el = document.getElementById("play-progress");
    if (!el) return;
    if (on) {
      var ms = window.GeoI18N.months(lang);
      el.querySelector(".pp-months").innerHTML = ms.map(function (m) {
        return "<span>" + escapeHtml(String(m).slice(0, 3)) + "</span>";
      }).join("");
    }
    el.style.display = on ? "block" : "none";
    fitMapHeight();   // the bar sits above the map — refit so it still fills the screen
  }
  function updatePlayProgress(week) {
    var el = document.getElementById("play-progress");
    if (!el || el.style.display === "none") return;
    var pct = (week / 48) * 100;
    el.querySelector(".pp-fill").style.width = pct + "%";
    el.querySelector(".pp-marker").style.left = pct + "%";
  }

  function stopAnimation() {
    animating = false;
    animateAll = false;
    if (animTimer) { clearTimeout(animTimer); animTimer = null; }
    setPlayBtn(false);
    // Keep the (now paused) bar visible for scrubbing when a full 48-week
    // animation is cached; otherwise hide it.
    if (!animReady) showPlayProgress(false);
  }

  // Discard a precomputed animation — called whenever a fresh single-week
  // render supersedes it (pan/zoom, species/mode/group change) — and hide the
  // progress bar.
  function invalidateAnimation() {
    if (animating) {
      animating = false;
      if (animTimer) { clearTimeout(animTimer); animTimer = null; }
      setPlayBtn(false);
    }
    animReady = false;
    showPlayProgress(false);
  }

  // Map a pointer x-coordinate on the progress bar to a week (1–48) and show
  // that week's cached frame, so the user can scrub to find a date.
  function scrubToWeek(clientX) {
    var el = document.getElementById("play-progress");
    if (!el) return;
    var r = el.getBoundingClientRect();
    var frac = (clientX - r.left) / r.width;
    frac = Math.max(0, Math.min(0.999999, frac));
    var week = Math.floor(frac * 48) + 1;
    updatePlayProgress(week);
    var wsel = document.getElementById("week-select");
    if (+wsel.value === week) return;
    wsel.value = week;
    window.GeoState.save({ week: week });
    if (currentMode === "range" || currentMode === "richness") showCachedWeek();
    rerenderPointList();
    updateLegend();
  }

  async function toggleAnimation() {
    if (animating) { stopAnimation(); return; }
    if (currentMode === "range" && !document.getElementById("species-search").dataset.selectedKey) {
      setStatus(t("status.selectSpecies"));
      return;
    }
    animating = true;
    setPlayBtn(true);
    showPlayProgress(true);

    // Precompute every week for the current viewport.
    animateAll = true;
    if (currentMode === "richness") await renderRichness();
    else await renderRangeMap();
    animateAll = false;
    if (!animating) return;
    animReady = true;   // full 48-week set cached → bar stays scrubbable after playback

    // Step through cached weeks.
    var wsel = document.getElementById("week-select");
    var w = +wsel.value || 1;
    (function step() {
      if (!animating) return;
      wsel.value = w;
      showCachedWeek();
      updatePlayProgress(w);
      w = (w % 48) + 1;
      animTimer = setTimeout(step, ANIM_INTERVAL);
    })();
  }

  function closeDropdowns() {
    ["hidden-panel", "checklists-panel", "settings-panel"].forEach(function (idp) {
      var p = document.getElementById(idp);
      if (p) p.style.display = "none";
    });
  }

  // ---- Checklists ----------------------------------------------------------
  // Reverse-geocode to a place name for the header (falls back to coordinates).
  async function reverseGeocode(lat, lon) {
    try {
      var r = await fetch("https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=" + lat + "&lon=" + lon, { headers: { Accept: "application/json" } });
      if (r.ok) { var j = await r.json(); return j.display_name || j.name || null; }
    } catch (e) { /* offline / blocked — use coordinates */ }
    return null;
  }

  // Build display items for the stored checklists. Names get a date suffix
  // when several lists share the same base name (place/title) — e.g. one per day.
  function buildChecklistItems(fcs) {
    var items = [];
    Object.keys(fcs).forEach(function (id) {
      var r = getFieldRecord(id); if (!r) return;
      if (!((r.log && r.log.length) || (r.title || "").trim())) return;
      var base = (r.title || "").trim() || fieldNameCache[String(id).split("@")[0]] || (r.lat.toFixed(3) + "°, " + r.lon.toFixed(3) + "°");
      items.push({ pkey: id, base: base, day: dayOf(r), lat: r.lat, lon: r.lon });
    });
    var counts = {};
    items.forEach(function (it) { counts[it.base] = (counts[it.base] || 0) + 1; });
    items.forEach(function (it) { it.name = counts[it.base] > 1 ? it.base + " · " + it.day : it.base; });
    return items;
  }

  // When a checklist was last opened — explicit stamp, else newest log entry,
  // else creation time. Used to flag the most/recently accessed lists.
  function accessTime(r) {
    if (!r) return 0;
    if (r.accessedAt) return r.accessedAt;
    var ts = (r.log && r.log.length) ? (r.log[r.log.length - 1].ts || 0) : 0;
    if (!ts && r.createdAt) ts = Date.parse(r.createdAt) || 0;
    return ts;
  }

  // Dropdown listing the saved Checklists, most recently accessed first.
  function refreshChecklists() {
    var wrap = document.getElementById("checklists-wrap");
    var btnText = document.getElementById("checklists-btn-text");
    var panel = document.getElementById("checklists-panel");
    if (!wrap || !btnText || !panel) return;

    var fcs = getFieldChecklists();
    var items = buildChecklistItems(fcs);

    // Sort by distance to the current map centre (nearest first — so the green
    // proximity dots cluster at the top, then orange, then red). Last-access
    // time breaks ties between lists at the same distance. Country-wide lists
    // (no point anchor) have Infinity distance and fall to the bottom, sorted
    // among themselves by recency.
    var c0 = map ? map.getCenter() : null;
    items.forEach(function (it) {
      it.acc = accessTime(getFieldRecord(it.pkey));
      it.dist = (c0 && it.lat != null && it.lon != null) ? haversineKm(c0.lat, c0.lng, it.lat, it.lon) : Infinity;
    });
    items.sort(function (a, b) { return (a.dist - b.dist) || (b.acc - a.acc); });

    wrap.style.display = items.length ? "" : "none";
    if (!items.length) panel.style.display = "none";
    btnText.textContent = items.length;   // small count badge on the list icon
    document.getElementById("checklists-toggle").title = t("ctrl.checklists") + " (" + items.length + ")";

    panel.innerHTML = items.map(function (it) {
      var n = escapeHtml(it.name);
      // Proximity dot: green < 500 m, orange ≤ 2 km, red beyond. Country-wide
      // checklists have no point anchor — no proximity dot.
      var dot = "";
      var isCountry = String(it.pkey).indexOf("country:") === 0;
      if (!isCountry && isFinite(it.dist)) {
        var cls = it.dist < 0.5 ? "dd-dot-near" : (it.dist <= 2 ? "dd-dot-mid" : "dd-dot-far");
        var dtxt = it.dist < 1 ? Math.round(it.dist * 1000) + " m" : it.dist.toFixed(1) + " km";
        dot = '<span class="dd-dot ' + cls + '" title="' + dtxt + '"></span>';
      }
      return '<div class="dd-row"><button type="button" class="dd-name dd-open-field" data-pkey="' + escapeHtml(it.pkey) + '" title="' + n + '">' + dot + n + "</button>" +
        '<button type="button" class="dd-csv dd-csv-field" data-pkey="' + escapeHtml(it.pkey) + '" title="' + escapeHtml(t("btn.csv")) + '">⬇</button>' +
        '<button type="button" class="dd-del dd-del-field" data-pkey="' + escapeHtml(it.pkey) + '" title="' + escapeHtml(t("btn.delete")) + '">×</button></div>';
    }).join("");

    panel.querySelectorAll(".dd-open-field").forEach(function (b) {
      b.addEventListener("click", function () { closeDropdowns(); openFieldFromList(this.getAttribute("data-pkey")); });
    });
    panel.querySelectorAll(".dd-csv-field").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var pkey = this.getAttribute("data-pkey"), r = getFieldRecord(pkey);
        if (r) downloadCsv("checklist_" + String(r.title || pkey).replace(/[^\w-]+/g, "_") + ".csv", fieldRecordCsv(pkey));
      });
    });
    panel.querySelectorAll(".dd-del-field").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var pkey = this.getAttribute("data-pkey");
        var all = getFieldChecklists(); delete all[pkey]; saveFieldChecklists(all);
        if (fieldKey === pkey) { fieldKey = null; stopFieldGeoWatch(); document.getElementById("field-page").style.display = "none"; navClose("page"); }
        refreshChecklists();
      });
    });
  }

  // Re-open a field checklist from the list: re-run inference at its point so
  // its species rows are rebuilt, pinned to that exact (possibly past-day) list.
  function openFieldFromList(id) {
    var r = getFieldRecord(id);
    if (!r) return;
    // Country-wide checklists carry their snapshot of species rows; reopen
    // with the snapshot (no re-sampling). Re-running country sampling on every
    // open would be slow and could shift the list if the week/threshold changed.
    if (String(id).indexOf("country:") === 0 || r.kind === "country") {
      renderCountryChecklist(r.cc || id.split("@")[0].replace(/^country:/, ""), r.title || r.cc || id, r.lat, r.lon, null, r.rows || []);
      return;
    }
    renderFieldChecklist(r.lat, r.lon, id);   // full-screen overlay; no mode switch
  }

  function csvEsc(v) { var s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  // Aggregated CSV for a stored field checklist (works for any record).
  function fieldRecordCsv(id) {
    var r = getFieldRecord(id); if (!r) return "";
    var title = (r.title || "").trim() || (r.lat.toFixed(4) + "°, " + r.lon.toFixed(4) + "°");
    var lid = r.id || id || "";
    var agg = fcAggregate(r), lines = ["# " + title + " | " + dayOf(r)];
    lines.push("checklist,list_id,species,common_name,count,activity,notes,observations");
    Object.keys(agg).forEach(function (key) {
      var a = agg[key], name = (labelsByKey[key] && speciesName(labelsByKey[key])) || key;
      var ents = fcEntriesFor(r, key);
      lines.push([csvEsc(title), csvEsc(lid), key, csvEsc(name), a.count > 0 ? a.count : "", a.act ? actName(a.act) : "", csvEsc(a.note || ""), csvEsc(observationsSummary(ents))].join(","));
    });
    return lines.join("\n");
  }
  // Raw observation-log CSV: one row per logged sighting (time + coordinates).
  function fieldLogCsv(id) {
    var r = id ? getFieldRecord(id) : curFieldRecord(false); if (!r) return "";
    var title = (r.title || "").trim() || (r.lat.toFixed(4) + "°, " + r.lon.toFixed(4) + "°");
    var lid = r.id || id || "";
    var lines = ["# " + title + " | " + dayOf(r) + " | observation log"];
    lines.push("checklist,list_id,timestamp,lat,lon,species,common_name,count,sex,activity,notes");
    (r.log || []).slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); }).forEach(function (e) {
      var name = (labelsByKey[e.key] && speciesName(labelsByKey[e.key])) || e.key;
      lines.push([csvEsc(title), csvEsc(lid), new Date(e.ts).toISOString(), e.lat != null ? e.lat.toFixed(5) : "", e.lon != null ? e.lon.toFixed(5) : "",
        e.key, csvEsc(name), csvEsc(e.count != null ? e.count : ""), e.sex || "", csvEsc(actLabel(e.act)), csvEsc(e.note || "")].join(","));
    });
    return lines.join("\n");
  }

  // Editable "Hidden species" list shown in a dropdown popover; each row has
  // an × to remove the species from the hidden ("sanction") list.
  function refreshHiddenUI() {
    var wrap = document.getElementById("hidden-wrap");
    var btnText = document.getElementById("hidden-btn-text");
    var panel = document.getElementById("hidden-panel");
    if (!wrap || !btnText || !panel) return;
    var keys = Object.keys(hiddenSpecies);
    wrap.style.display = keys.length ? "" : "none";
    if (!keys.length) panel.style.display = "none";
    btnText.textContent = t("ctrl.hidden") + " (" + keys.length + ")";
    panel.innerHTML = keys.map(function (k) {
      var lbl = labelsByKey[k];
      var n = escapeHtml(lbl ? speciesName(lbl) : k);
      return '<div class="dd-row"><span class="dd-name" title="' + n + '">' + n + "</span>" +
        '<button type="button" class="dd-del" data-key="' + escapeHtml(k) + '" title="' + escapeHtml(t("loc.unhide")) + '" aria-label="' + escapeHtml(t("loc.unhide")) + '">×</button></div>';
    }).join("");
    panel.querySelectorAll(".dd-del").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); unhideSpecies(this.getAttribute("data-key")); });
    });
    // The hidden-species control is the only thing that can populate the bar in
    // List mode, so re-evaluate whether the bar should show.
    updateControlsBarVisibility();
    fitMapHeight();
  }

  // ---- Restore persisted control values ------------------------------------
  // Remember the active view (mode + open page + point) so a reload — e.g. when
  // a phone discards the tab while you're on an external site — returns you to
  // where you left off, not the default page.
  function saveSession(patch) {
    var s = window.GeoState.get("session", {}) || {};
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
    window.GeoState.save({ session: s });
  }
  function restoreSession() {
    var s = window.GeoState.get("session", null);
    var mode = (s && s.mode) || "list";
    if (["list", "barchart", "range", "richness"].indexOf(mode) < 0) mode = "list";
    var modeEl = document.getElementById("mode-select");
    if (modeEl.value !== mode) { modeEl.value = mode; modeEl.dispatchEvent(new Event("change", { bubbles: true })); }
    if (mode === "range") {
      var sp = window.GeoState.get("species", null);
      if (sp && labelsByKey[sp]) selectSpecies(sp);
    } else if (s && s.page === "species" && isFinite(s.lat) && isFinite(s.lon)) {
      renderSpeciesList(s.lat, s.lon);
    } else if (s && s.page === "migration" && isFinite(s.lat) && isFinite(s.lon)) {
      renderAnalysis(s.lat, s.lon);
    }
  }
  function restoreControls() {
    // Default to Species List mode on a fresh start; restoreSession() reopens
    // the last view afterwards if there is one.
    currentMode = "list";
    document.getElementById("mode-select").value = currentMode;

    // Always start on the current week of the year (overrides any saved week).
    document.getElementById("week-select").value = weekOfToday();

    var cmp = window.GeoState.get("compare", null);
    if (cmp !== null) document.getElementById("compare-select").value = cmp;

    setSecondLang(window.GeoState.get("secondLang", ""));

    showSci = window.GeoState.get("showSci", true) !== false;
    document.getElementById("show-sci-toggle").checked = showSci;
    applyShowSci();

    renderCustomUrls();

    analysisTab = window.GeoState.get("analysisTab", "timeline");
    document.getElementById("an-rankby").value = window.GeoState.get("scatterRankBy", "arrival");

    speciesGroup = window.GeoState.get("group", "all");
    document.getElementById("group-select").value = speciesGroup;
    updateSettingsIcon();

    // H3 detail offset (-2..+2, 0 = auto), set via the on-map hexagon control.
    hiResFactor = Math.max(-2, Math.min(2, +window.GeoState.get("hiResOffset", 0) || 0));
    offlineMaxZoom = Math.max(11, Math.min(17, +window.GeoState.get("offlineMaxZoom", 17) || 17));
    var ozEl = document.getElementById("offline-zoom"); if (ozEl) ozEl.value = String(offlineMaxZoom);

    // Always start with the full probability range 5%–100% on load.
    document.getElementById("prob-min").value = 5;
    document.getElementById("prob-max").value = 100;
    document.getElementById("prob-min-val").textContent = "5%";
    document.getElementById("prob-max-val").textContent = "100%";

    loadHidden();
    loadInteresting();

    var sp = window.GeoState.get("species", null);
    if (sp && labelsByKey[sp]) {
      var el = document.getElementById("species-search");
      el.dataset.selectedKey = sp;
      el.placeholder = speciesName(labelsByKey[sp]) + " (" + labelsByKey[sp].sci + ")";
    }
    updateModeVisibility();
  }

})();
