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

  // ---- Source/dataset config (defined in docs/sources.js / window.AppSources)
  // Aliased here so the rest of app.js keeps calling them unqualified; the
  // cache-reset callback is wired in init().
  var AppSources = window.AppSources;
  var gbifDatasets = AppSources.gbifDatasets,
      lajiDirectActive = AppSources.lajiDirectActive,
      directSources = AppSources.directSources,
      saveDirectSources = AppSources.saveDirectSources,
      sourcesOff = AppSources.sourcesOff,
      isSourceOff = AppSources.isSourceOff,
      setSourceOff = AppSources.setSourceOff,
      gbifDays = AppSources.gbifDays,
      setGbifDays = AppSources.setGbifDays,
      gbifOff = AppSources.gbifOff,
      isGbifOff = AppSources.isGbifOff,
      setGbifOff = AppSources.setGbifOff,
      directKey = AppSources.directKey,
      setDirectKey = AppSources.setDirectKey,
      ebirdKey = AppSources.ebirdKey,
      setEbirdKey = AppSources.setEbirdKey,
      artKey = AppSources.artKey,
      setArtKey = AppSources.setArtKey,
      DEFAULT_GBIF_DATASETS = AppSources.DEFAULT_GBIF_DATASETS,
      GBIF_DS_COUNTRY = AppSources.GBIF_DS_COUNTRY,
      DEFAULT_DIRECT_SOURCES = AppSources.DEFAULT_DIRECT_SOURCES,
      DIRECT_BY_ID = AppSources.DIRECT_BY_ID,
      GBIF_MAX_DAYS = AppSources.GBIF_MAX_DAYS,
      EBIRD_KEY_LS = AppSources.EBIRD_KEY_LS,
      ART_KEY_LS = AppSources.ART_KEY_LS;

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
  // Languages whose common species names are written in lower case (e.g. Swedish
  // "stenskvätta", Norwegian "stillits", Danish "stor skallesluger"). The
  // taxonomy source capitalises them inconsistently — a stray leading capital
  // (Norwegian "Stillits") or full Title Case (Danish "Stor Skallesluger") — so
  // lower-case the first letter of every word. English (title case), German
  // (nouns capitalised) and the other capital-first source columns keep theirs.
  var LOWER_SPECIES_LANGS = { sv: 1, no: 1, da: 1, pt: 1, pl: 1, cs: 1, fi: 1, et: 1 };
  function speciesCase(code, name) {
    if (!name || !LOWER_SPECIES_LANGS[code]) return name;
    return name.replace(/(^|[\s-])(\S)/g, function (m, sep, ch) { return sep + ch.toLowerCase(); });
  }
  function nameInCol(label, code, taxCol) {
    var row = label && taxByCode[label.key];
    if (row) {
      var en = row.com_name || "";
      var loc = row[taxCol] || "";
      if (code === "en") return en || loc || (label && (label.common || label.sci || label.key)) || "";
      if (loc && (!en || loc.toLowerCase() !== en.toLowerCase())) return speciesCase(code, loc);
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
  // Per-group source filters: GBIF backbone class taxonKeys + iNat iconic-taxon
  // names. "all" unions every supported group. eBird/BirdWeather are bird-only
  // feeds (queried only for Birds/All); the Nordic DBs can't filter by taxon at
  // the source, so they fetch everything and are class-filtered in aggregate.
  var GROUP_TAXA = {
    aves:     { gbif: 212, inat: "Aves" },
    mammalia: { gbif: 359, inat: "Mammalia" },
    amphibia: { gbif: 131, inat: "Amphibia" },
    insecta:  { gbif: 216, inat: "Insecta" }
  };
  function groupTaxaList() {
    if (speciesGroup === "all") return [GROUP_TAXA.aves, GROUP_TAXA.mammalia, GROUP_TAXA.amphibia, GROUP_TAXA.insecta];
    return [GROUP_TAXA[speciesGroup] || GROUP_TAXA.aves];
  }
  function gbifTaxonParam() { return groupTaxaList().map(function (g) { return "&taxonKey=" + g.gbif; }).join(""); }   // GBIF ORs repeated taxonKey
  function inatIconicTaxa() { return groupTaxaList().map(function (g) { return g.inat; }).join(","); }
  function groupIsBirds() { return speciesGroup === "all" || speciesGroup === "aves"; }
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
  // Simple line icons (stroke = currentColor) for the action buttons, replacing
  // the old emoji so the UI stays in the white/green/red palette. Paired with a
  // `.ico-label` text span (the i18n applier strips the label's leading emoji).
  function ico(name) {
    var P = {
      sources:  '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 19.1a10 10 0 0 0 0-14.2"/>',
      datasets: '<path d="M12 3 3 7.5 12 12l9-4.5L12 3zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5"/>',
      globe:    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18"/>',
      download: '<path d="M12 3v11M7.5 9.5 12 14l4.5-4.5M5 20h14"/>',
      upload:   '<path d="M12 21V10M7.5 14.5 12 10l4.5 4.5M5 4h14"/>',
      folder:   '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      block:    '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6 18.4 18.4"/>',
      list:     '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
      cloud:    '<path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.4A3.5 3.5 0 0 1 18 18z"/>',
      refresh:  '<path d="M4 9a8 8 0 0 1 13.7-3.3L20 8M20 4v4h-4M20 15a8 8 0 0 1-13.7 3.3L4 16M4 20v-4h4"/>',
      install:  '<rect x="6.5" y="3" width="11" height="18" rx="2"/><path d="M12 7v6M9.5 10.5 12 13l2.5-2.5"/>',
      pin:      '<path d="M12 2a7 7 0 0 0-7 7c0 5 7 12 7 12s7-7 7-12a7 7 0 0 0-7-7z"/><circle cx="12" cy="9" r="2.5"/>',
      lock:     '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
      lockopen: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0"/>',
      edit:     '<path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17.2z"/><path d="M13.5 6.5l4 4"/>',
      user:     '<circle cx="12" cy="8" r="3.6"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>',
      nav:      '<path d="M21 3 3 10.7l7.3 2.9 2.9 7.3z"/>',
      check:    '<path d="M5 12.5l4.5 4.5L19 7"/>',
      target:   '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
      save:     '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7M8 20v-6h8v6"/>',
      tag:      '<path d="M3 11.3 11.3 3H20a1 1 0 0 1 1 1v8.3l-8.3 8.3a1.4 1.4 0 0 1-2 0L3 13.3a1.4 1.4 0 0 1 0-2z"/><circle cx="16" cy="8" r="1.3"/>',
      mail:     '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/>',
      menu:     '<path d="M4 7h16M4 12h16M4 17h16"/>',
      share:    '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8 15.8 6.2M8.2 13.2l7.6 4.6"/>',
      copy:     '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'
    };
    return '<svg class="btn-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || "") + "</svg>";
  }
  // t() with any leading emoji/symbol stripped — for icon buttons rendered
  // dynamically (outside the init-time .ico-label i18n pass).
  function tLabel(key) { return t(key).replace(/^[^\p{L}\p{N}]+/u, ""); }
  // A demo-button with a leading icon + an i18n label span.
  function icoBtn(id, name, key, fallback, extra) {
    return '<button type="button" id="' + id + '" class="demo-btn ico-btn"' + (extra || "") + ">" +
      ico(name) + '<span class="ico-label" data-i18n="' + key + '">' + fallback + "</span></button>";
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
      ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>'
      : '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
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
      if (opts.items && opts.items.length) {
        var list = document.createElement("ul");
        list.className = "ui-modal-list";
        opts.items.forEach(function (it) { var li = document.createElement("li"); li.textContent = it; list.appendChild(li); });
        box.appendChild(list);
      }
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
      if (!opts.alert) btns.appendChild(cancel);   // alert = OK only (just dismiss)
      btns.appendChild(ok);
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
  function modalAlert(message, items) { return uiDialog({ message: message, items: items, input: false, alert: true }); }
  // Shared factory for the hand-built centred overlays (offline download, observer
  // editor, save-location, country menu…) — one implementation of overlay + box +
  // dismiss so each caller only builds its own content. Returns {overlay, box, close}.
  // opts.boxClass appends to "ui-modal"; opts.onClose runs extra cleanup once;
  // opts.backdropClose (default true) dismisses on a click outside the box;
  // opts.escClose dismisses on Escape.
  function createModal(opts) {
    opts = opts || {};
    var ov = document.createElement("div"); ov.className = "ui-modal-overlay";
    var box = document.createElement("div"); box.className = "ui-modal" + (opts.boxClass ? " " + opts.boxClass : "");
    ov.appendChild(box); document.body.appendChild(ov);
    var closed = false, onKey = null;
    function close() {
      if (closed) return; closed = true;
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      if (onKey) document.removeEventListener("keydown", onKey, true);
      if (opts.onClose) opts.onClose();
    }
    if (opts.backdropClose !== false) ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    if (opts.escClose) { onKey = function (e) { if (e.key === "Escape") { e.preventDefault(); close(); } }; document.addEventListener("keydown", onKey, true); }
    return { overlay: ov, box: box, close: close };
  }

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
  // Render an imported note that the user flagged as HTML (KML descriptions are
  // often HTML tables/links). Since the source is a user-supplied file we can't
  // trust it — sanitise via an allow-list: parse into a detached document, drop
  // script-like elements outright, unwrap any tag not on the allow-list (keeping
  // its text), and strip every attribute except a vetted few. Never inject the
  // raw string. Returns escaped plain text if parsing is unavailable.
  var HTML_OK_TAGS = { A:1,B:1,I:1,EM:1,STRONG:1,U:1,S:1,BR:1,P:1,DIV:1,SPAN:1,UL:1,OL:1,LI:1,DL:1,DT:1,DD:1,TABLE:1,THEAD:1,TBODY:1,TR:1,TD:1,TH:1,CAPTION:1,FONT:1,IMG:1,H3:1,H4:1,H5:1,H6:1,SMALL:1,HR:1,CODE:1,PRE:1,BLOCKQUOTE:1 };
  var HTML_DROP_TAGS = { SCRIPT:1,STYLE:1,IFRAME:1,OBJECT:1,EMBED:1,LINK:1,META:1,TITLE:1,NOSCRIPT:1,FORM:1,INPUT:1,BUTTON:1,SELECT:1,TEXTAREA:1,SVG:1 };
  function sanitizeHtml(html) {
    var doc;
    try { doc = new DOMParser().parseFromString("<div>" + String(html == null ? "" : html) + "</div>", "text/html"); }
    catch (e) { return escapeHtml(String(html == null ? "" : html)); }
    var root = doc.body && doc.body.firstChild;
    if (!root) return "";
    (function walk(node) {
      [].slice.call(node.childNodes).forEach(function (ch) {
        if (ch.nodeType === 8) { node.removeChild(ch); return; }   // comments
        if (ch.nodeType !== 1) return;                             // text: keep as-is
        if (HTML_DROP_TAGS[ch.tagName]) { node.removeChild(ch); return; }
        walk(ch);                                                  // sanitise descendants first
        if (!HTML_OK_TAGS[ch.tagName]) {                           // unknown tag → keep its contents only
          while (ch.firstChild) node.insertBefore(ch.firstChild, ch);
          node.removeChild(ch); return;
        }
        [].slice.call(ch.attributes).forEach(function (a) {
          var n = a.name.toLowerCase(), v = String(a.value || "").trim(), keep = false;
          if (ch.tagName === "A" && n === "href" && /^(https?:|mailto:)/i.test(v)) keep = true;
          else if (ch.tagName === "IMG" && n === "src" && /^(https?:|data:image\/)/i.test(v)) keep = true;
          else if (n === "alt" || n === "title") keep = true;
          if (!keep) ch.removeAttribute(a.name);
        });
        if (ch.tagName === "A") { ch.setAttribute("target", "_blank"); ch.setAttribute("rel", "noopener noreferrer"); }
      });
    })(root);
    return root.innerHTML;
  }
  // Does a string look like it carries HTML markup (used to pre-tick the import
  // "note is HTML" box)? A lone "a < b" shouldn't trip it — require a real tag.
  function looksLikeHtml(s) { return /<([a-z][a-z0-9]*)\b[^>]*>|<br\s*\/?>|&[a-z]+;|&#\d+;/i.test(String(s || "")); }
  // URL-scheme safety: escapeHtml does NOT neutralise a `javascript:`/`data:` scheme
  // inside an href (it would execute on click). linkUrl() normalises a user- or
  // sync-supplied external URL to a safe form: http(s) as-is, a bare host gets an
  // https:// prefix, and any other scheme (javascript:/data:/…) is dropped ("").
  // Use linkUrl() when STORING a link, safeHref() when rendering one as an href.
  function linkUrl(u) {
    u = String(u == null ? "" : u).trim();
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return "";   // some other (non-http) scheme → refuse
    return "https://" + u.replace(/^\/+/, "");
  }
  function safeHref(u) { return linkUrl(u) || "#"; }

  // Mode-appropriate guidance shown in the status line when there's no active
  // selection — so the text below the controls always matches the current mode.
  function modeHint() {
    if (currentMode === "list") return t("status.hintList");
    if (currentMode === "historic") return t("status.hintHistoric");
    if (currentMode === "richness") return t("status.hintRichness");
    if (currentMode === "barchart") return t("status.hintBarchart");
    return t("status.selectSpecies");   // range default
  }
  function setStatus(msg) {
    var el = document.getElementById("demo-status");
    if (el) el.textContent = msg;
  }
  // Status with limited inline markup (only app-controlled HTML, e.g. the
  // blinking fetch fraction — never user input).
  function setStatusHtml(html) {
    var el = document.getElementById("demo-status");
    if (el) el.innerHTML = html;
  }

  function weekText(w) {
    var months = window.GeoI18N.months(lang);
    var period = window.GeoI18N.periods(lang);
    var mi = Math.floor((w - 1) / 4);
    var pi = (w - 1) % 4;
    return t("week.fmt", { w: w, period: period[pi], month: months[mi] || months[11] });
  }
  // "early Jun" style label for a BirdNET week — period + month, no week number.
  function weekMonthLabel(w) {
    var months = window.GeoI18N.months(lang), period = window.GeoI18N.periods(lang);
    var mi = Math.floor((w - 1) / 4), pi = (w - 1) % 4;
    return period[pi] + " " + (months[mi] || months[11]);
  }
  // Display an ISO date (YYYY-MM-DD) in the current locale's format (day/month
  // order + separators). Partial/odd values (year-only, ranges, empty) are kept
  // as-is. Parsed at local midnight so the day never shifts across time zones.
  function fmtDate(s) {
    s = String(s || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var d = new Date(s + "T00:00:00");
    if (isNaN(d.getTime())) return s;
    try { return d.toLocaleDateString(lang, { year: "numeric", month: "2-digit", day: "2-digit" }); }
    catch (e) { return s; }
  }

  // Format a grid step (degrees) for the status line — keep significant digits
  // for the fine steps used at deep zoom (so it never shows "0°").
  function fmtStep(s) { return s >= 0.1 ? (Math.round(s * 100) / 100) : +s.toPrecision(2); }

  // Current BirdNET week (1–48) for today's date.
  function weekOfToday() { return weekOfDate(new Date()); }   // shares the model-week formula in weekOfDate()

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
  var H3_CACHE_KEY = "geomodel-h3cache-v1";   // legacy localStorage store (now migrated into the shared pool)
  // The computed range cache now lives in the SAME CacheStorage pool as the map
  // tiles (sw.js TILE_CACHE), as a single blob entry — so tiles + range data
  // share one byte-budget and one LRU. The in-memory Map is the sync access
  // layer; this blob is its persistence. Re-writing it on change re-stamps it as
  // most-recent in the pool, so an actively-used range survives tile pressure
  // while a stale one is evicted like any old tile.
  var MAP_POOL_CACHE = "map-pool";                          // must match sw.js TILE_CACHE
  var H3_POOL_URL = "https://mapcache.local/range-v1";      // synthetic key for the range blob
  var h3CacheMB = 2;          // range-cache slice of the shared pool, MB (0 = off)
  var h3SaveTimer = null;
  function h3RangeCacheFor(tag) {
    var m = h3RangeCache.get(tag);
    if (!m) { m = {}; h3RangeCache.set(tag, m); if (h3RangeCache.size > 600) h3RangeCache.delete(h3RangeCache.keys().next().value); }
    return m;
  }
  function loadH3Cache() {
    try { localStorage.removeItem(H3_CACHE_KEY); } catch (e) {}   // drop the legacy localStorage copy (regenerates in the pool)
    if (h3CacheMB <= 0 || typeof caches === "undefined") return;
    caches.open(MAP_POOL_CACHE).then(function (c) { return c.match(H3_POOL_URL); })
      .then(function (r) { return r ? r.json() : null; })
      .then(function (obj) { if (obj) Object.keys(obj).forEach(function (tag) { if (!h3RangeCache.has(tag)) h3RangeCache.set(tag, obj[tag]); }); })   // keep anything already computed this session
      .catch(function () { /* unavailable / corrupt — ignore */ });
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
    if (typeof caches === "undefined") return;
    if (h3CacheMB <= 0) { caches.open(MAP_POOL_CACHE).then(function (c) { return c.delete(H3_POOL_URL); }).catch(function () {}); return; }
    var capChars = h3CacheMB * 1e6;   // ~1 char ≈ 1 byte for this ascii/numeric data
    var obj = h3CacheToJson(), str = JSON.stringify(obj);
    // Evict oldest tags (Map order) until within the range slice.
    while (str.length > capChars && Object.keys(obj).length > 1) {
      delete obj[Object.keys(obj)[0]];
      str = JSON.stringify(obj);
    }
    caches.open(MAP_POOL_CACHE).then(function (c) {   // put → re-stamps to most-recent in the shared LRU pool
      return c.put(H3_POOL_URL, new Response(str, { headers: { "Content-Type": "application/json" } }));
    }).catch(function () {});
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
  // ---- Fixed centre reticle + centre targeting -----------------------------
  // A red crosshair fixed at the middle of the map. Pan the map so a dot sits
  // under it and that dot's info pops up. This is the crosshair's "read" state.
  function ensureReticleEl() {
    var wrap = document.getElementById("demo-map-wrap"); if (!wrap) return null;
    var el = document.getElementById("map-reticle");
    if (!el) {
      el = document.createElement("div"); el.id = "map-reticle";
      el.innerHTML = '<svg viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
        '<line x1="20" y1="1" x2="20" y2="13"/><line x1="20" y1="27" x2="20" y2="39"/>' +
        '<line x1="1" y1="20" x2="13" y2="20"/><line x1="27" y1="20" x2="39" y2="20"/>' +
        '<circle cx="20" cy="20" r="5"/></svg>';   // central circle r=5 == the hit radius (reticleTarget THRESH)
      wrap.appendChild(el);
    }
    return el;
  }
  // On each settle: whichever observation dot / map point / eBird hotspot is
  // nearest the screen centre is opened — the SAME popup as clicking it for dots
  // and points (onDetMarkerClick / onMpPinClick), and the info tooltip for a
  // hotspot (name + species count, not the external page). Deduped so it isn't
  // re-fired while the same target stays centred.
  var reticleLast = null, reticleHsMarker = null;
  // Opening a target popup can auto-pan the map, which would fire movestart/moveend
  // and re-trigger dismiss/target — a churn that also closes other popups (the
  // stored-locations panel via hideStoredLocations, modals via closeModals). Set a
  // short "acting" window after we open something so those self-induced map events
  // are ignored.
  var reticleActing = false, reticleActTimer = null;
  function reticleGuard() { reticleActing = true; clearTimeout(reticleActTimer); reticleActTimer = setTimeout(function () { reticleActing = false; }, 700); }
  function closeReticleHs() { if (reticleHsMarker) { try { reticleHsMarker.closeTooltip(); } catch (e) {} reticleHsMarker = null; } }
  // As soon as the user pans, close whatever the reticle popped (map-point popup,
  // read-only pin menu, hotspot tooltip) — so panning away dismisses it, no need to
  // tap the little ×. moveend then re-opens whatever is under the centre next.
  function reticleDismiss() {
    if (crossState !== 2 || reticleActing) return;   // ignore our own popup's auto-pan
    try { map.closePopup(); } catch (e) {}
    try { closeDetRowMenu(); } catch (e) {}
    closeReticleHs();
    reticleLast = null;
  }
  function reticleTarget() {
    if (crossState !== 2 || !map || reticleActing) return;   // skip events from our own popup auto-pan
    var size = map.getSize(), center = L.point(size.x / 2, size.y / 2), THRESH = 5;   // dot centre must be within ~5px of the cross centre
    var best = null, bestD = THRESH;
    function consider(d, key, act) { if (d < bestD) { bestD = d; best = { key: key, act: act }; } }
    Object.keys(detPlot).forEach(function (k) {
      var g = detPlot[k] && detPlot[k].group; if (!g || !g.eachLayer) return;
      g.eachLayer(function (lyr) {
        if (!lyr.getLatLng) return;
        var ll = lyr.getLatLng();
        consider(center.distanceTo(map.latLngToContainerPoint(ll)), "det:" + ll.lat.toFixed(5) + "," + ll.lng.toFixed(5),
          function () { onDetMarkerClick({ getLatLng: function () { return ll; } }); });
      });
    });
    (mpPins || []).forEach(function (rec) {
      if (!rec || !rec.m || !rec.m.getLatLng) return;
      consider(center.distanceTo(map.latLngToContainerPoint(rec.m.getLatLng())),
        "mp:" + ((rec.p && rec.p.id) || (rec.p.lat + "," + rec.p.lon)),
        function () { onMpPinClick(rec); });
    });
    if (hotspotsLayer && map.hasLayer(hotspotsLayer) && hotspotsLayer.eachLayer) {
      hotspotsLayer.eachLayer(function (m) {
        if (!m.getLatLng) return;
        var ll = m.getLatLng();
        consider(center.distanceTo(map.latLngToContainerPoint(ll)), "hs:" + ll.lat.toFixed(5) + "," + ll.lng.toFixed(5),
          function () { reticleHsMarker = m; try { m.openTooltip(); } catch (e) {} });
      });
    }
    var key = best ? best.key : null;
    if (key === reticleLast) return;   // this target is already shown
    reticleLast = key;
    closeReticleHs();                  // clear any open hotspot info when the target changes
    if (best) { reticleGuard(); best.act(); }   // ignore the popup's own auto-pan events
  }
  // ---- Crosshair control: 3 states — off (grey) → follow (blue) → read (red) --
  var crossState = 0;   // 0 off · 1 GPS follow · 2 centre-reticle read
  function stopFollow() {
    posWatching = false;
    try { map.stopLocate(); } catch (e) {}
    if (posMarker) { map.removeLayer(posMarker); posMarker = null; }
    if (posFixedMarker) { map.removeLayer(posFixedMarker); posFixedMarker = null; }
  }
  function startFollow() {
    posWatching = true; posCentered = false;
    map.locate({ watch: true, enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
  }
  function stopReticle() {
    var el = document.getElementById("map-reticle"); if (el) el.style.display = "none";
    map.off("moveend", reticleTarget); map.off("movestart", reticleDismiss);
    reticleLast = null; closeReticleHs(); hideDetHover();
  }
  function startReticle() {
    var el = ensureReticleEl(); if (el) el.style.display = "";
    map.on("moveend", reticleTarget); map.on("movestart", reticleDismiss);
    reticleTarget();
  }
  function setCrosshairState(s) {
    crossState = s;
    stopFollow(); stopReticle();
    var btn = document.querySelector(".geo-locate-btn");
    if (btn) btn.classList.remove("cross-follow", "cross-read");
    if (s === 1) { startFollow(); if (btn) btn.classList.add("cross-follow"); setStatus(t("ctrl.followOn")); }
    else if (s === 2) { startReticle(); if (btn) btn.classList.add("cross-read"); setStatus(t("ctrl.reticleOn")); }
  }
  function cycleCrosshair() { setCrosshairState((crossState + 1) % 3); }
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
  // Year lists (one per calendar year, kept until the user deletes them) and a
  // single life list of species the user has recorded. Used to highlight
  // "needs" on the map (missing-from-life = thick yellow edge, missing-from-this-
  // year = thin yellow edge), fed by the species menu + field checklist, and
  // merged across devices on sync. yearLists shape: { "YYYY": { key: true } }.
  var lifeList = {};
  var yearLists = {};
  function curYear() { return String(new Date().getFullYear()); }
  function loadLists() {
    lifeList = {}; (window.GeoState.get("lifeList", []) || []).forEach(function (k) { lifeList[k] = true; });
    yearLists = {}; var yl = window.GeoState.get("yearLists", {}) || {};
    Object.keys(yl).forEach(function (y) { yearLists[y] = {}; (yl[y] || []).forEach(function (k) { yearLists[y][k] = true; }); });
    reconcileLifeFromYears();
  }
  // The life list is the union of everything ever seen, so every species on ANY
  // year list belongs on it. Fill in any that are missing (e.g. older data, or a
  // year list synced from another device). Persists only when it actually adds.
  function reconcileLifeFromYears() {
    var changed = false;
    Object.keys(yearLists).forEach(function (y) {
      Object.keys(yearLists[y]).forEach(function (k) { if (!lifeList[k]) { lifeList[k] = true; changed = true; } });
    });
    if (changed) persistLists();
    return changed;
  }
  function persistLists() {
    var yl = {}; Object.keys(yearLists).forEach(function (y) { yl[y] = Object.keys(yearLists[y]); });
    window.GeoState.save({ lifeList: Object.keys(lifeList), yearLists: yl });
  }
  function inLifeList(k) { return !!lifeList[k]; }
  function inYearList(k, y) { var s = yearLists[y || curYear()]; return !!(s && s[k]); }
  function lifeListActive() { for (var k in lifeList) return true; return false; }
  function yearListActive() { var s = yearLists[curYear()]; if (s) { for (var k in s) return true; } return false; }
  function afterListChange(key) {
    persistLists();
    keepListScroll = true; refreshCurrentView();
    if (typeof detPlot !== "undefined" && detPlot[key]) { rebuildDetLayers(); updateDetLegend(); }
  }
  function toggleLifeList(key) { if (!key) return; if (lifeList[key]) delete lifeList[key]; else lifeList[key] = true; afterListChange(key); }
  function toggleYearList(key) { if (!key) return; var y = curYear(); if (!yearLists[y]) yearLists[y] = {}; if (yearLists[y][key]) delete yearLists[y][key]; else { yearLists[y][key] = true; lifeList[key] = true; } afterListChange(key); }   // a year tick is also a lifer; removing from the year list leaves the life list intact
  // A newly-recorded species (field checklist) ticks both lists; never removes.
  function recordSpeciesSeen(key) {
    if (!key) return; var y = curYear(), changed = false;
    if (!lifeList[key]) { lifeList[key] = true; changed = true; }
    if (!yearLists[y]) yearLists[y] = {};
    if (!yearLists[y][key]) { yearLists[y][key] = true; changed = true; }
    if (changed) { persistLists(); if (typeof detPlot !== "undefined" && detPlot[key]) { rebuildDetLayers(); updateDetLegend(); } }
  }
  // Edge style for a plotted species' dots/stars: thick yellow = missing from the
  // life list (a lifer), thin yellow = missing from this year's list (a year
  // tick), else the normal dark edge. Only applies once the list has entries.
  function listEdgesOn() { return window.GeoState.get("listEdges", true) !== false; }
  function detEdgeStyle(key) {
    if (!listEdgesOn()) return { color: "#1a1a1a", weight: 1 };   // user turned the year/life-list edges off
    if (lifeListActive() && !inLifeList(key)) return { color: "#ffcc00", weight: 4 };
    if (yearListActive() && !inYearList(key)) return { color: "#ffcc00", weight: 2 };
    return { color: "#1a1a1a", weight: 1 };
  }
  // Year/life "needs" weight for a species, using the SAME condition as the legend
  // swatch (detNeedClass) so the map and legend always agree — and, unlike
  // detEdgeStyle, NOT gated by the list-edges toggle, so the yellow star halo
  // always shows. 0 = not needed. thin (year) = 2, thick (life) = 4.
  function detNeedWeight(key) {
    if (lifeListActive() && !inLifeList(key)) return 4;
    if (yearListActive() && !inYearList(key)) return 2;
    return 0;
  }
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
    if (typeof detPlot !== "undefined" && detPlot[key]) { rebuildDetLayers(); updateDetLegend(); }   // drop its dots too
  }
  function unhideSpecies(key) {
    delete hiddenSpecies[key];
    persistHidden(); refreshHiddenUI(); refreshCurrentView();
    if (typeof detPlot !== "undefined" && detPlot[key]) { rebuildDetLayers(); updateDetLegend(); }   // restore its dots
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
    persistInteresting();
    keepListScroll = true;   // re-render in place — don't jump the list back to the top
    refreshCurrentView();
    // If this species is plotted, flip its dots ↔ ★ on the map + legend now.
    if (detPlot[key]) { rebuildDetLayers(); updateDetLegend(); }
  }

  // "★ " prefix for species the user has tagged as interesting (lists/cards).
  // Wrapped in a styled span so the star is visually distinct from the name.
  function interestingStar(key) { return isInteresting(key) ? '<span class="int-star" aria-label="interesting">★</span> ' : ""; }
  // Header label for the "Species" column reflecting the active filter mode.
  function speciesHeadLabel() {
    if (speciesListFilter === "interesting") return "★ " + t("th.species");
    if (speciesListFilter === "yearmiss") return "🟡 " + t("th.species");
    if (speciesListFilter === "lifemiss") return "🟠 " + t("th.species");
    if (speciesListFilter === "hidden") return "🚫 " + t("th.species");
    return t("th.species");
  }
  // Should a row be kept under the current filter mode? Encapsulates the rule
  // so renderSpeciesList and renderSpeciesInCountry stay consistent. The
  // "needs" modes mirror the map's year/life-list edges: yearmiss = not on this
  // year's list, lifemiss = not on the life list (hidden species are excluded).
  function passSpeciesFilter(key) {
    if (speciesListFilter === "interesting") return isInteresting(key);
    if (speciesListFilter === "yearmiss") return !isHidden(key) && !inYearList(key);
    if (speciesListFilter === "lifemiss") return !isHidden(key) && !inLifeList(key);
    if (speciesListFilter === "hidden") return isHidden(key);
    return !isHidden(key);
  }
  // Header label for the "Age" column reflecting the current threshold.
  function ageHeadLabel() {
    if (speciesAgeFilterDays === -1) return ">0 ▾";   // any species with an observation
    return speciesAgeFilterDays ? "≤" + speciesAgeFilterDays + "d ▾" : t("th.nd");
  }
  // Refresh the sort-arrow indicator on the sortable column headers. Class-based
  // (▲/▼ via CSS ::after) so it doesn't disturb the headers' dynamic labels.
  function updateSortIndicators() {
    var cols = { "sp-species-head": "name", "sp-sci-head": "sci", "sp-prob-head": "prob", "sp-delta-head": "cmp" };
    Object.keys(cols).forEach(function (id) {
      var el = document.getElementById(id); if (!el) return;
      var on = speciesListSort.col === cols[id];
      el.classList.toggle("sort-asc", on && speciesListSort.dir === "asc");
      el.classList.toggle("sort-desc", on && speciesListSort.dir === "desc");
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
    var col = speciesListSort.col;
    rows.sort(function (a, b) {
      var ka, kb;
      if (col === "sci") {
        ka = (a.children[2].textContent || "").toLowerCase();
        kb = (b.children[2].textContent || "").toLowerCase();
      } else if (col === "name") {
        ka = a.getAttribute("data-name") || ""; kb = b.getAttribute("data-name") || "";
      } else if (col === "prob") {
        ka = +a.getAttribute("data-prob") || 0; kb = +b.getAttribute("data-prob") || 0;
      } else if (col === "cmp") {
        ka = parseFloat(a.getAttribute("data-cmp")); kb = parseFloat(b.getAttribute("data-cmp"));
        if (isNaN(ka)) ka = -Infinity; if (isNaN(kb)) kb = -Infinity;
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
    if (!currentSpView || (currentSpView.mode !== "point" && currentSpView.mode !== "historic")) return;
    // Default direction is column-appropriate (alphabetical asc / numerical
    // desc). Each column cycles: default → opposite → off → default → ...
    var defaultDir = (col === "sci" || col === "name") ? "asc" : "desc";
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
    var now = Date.now();
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
      tr.style.display = (Math.round((now - entry.latestTs) / 86400000) <= days) ? "" : "none";
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
  // Pop-up overlays (vs. full-screen pages, which may legitimately stack). By
  // default only one of these shows at a time — opening one closes the others.
  var MODAL_IDS = { feedback: 1, gbif: 1, natdb: 1, about: 1, recent: 1, distmap: 1, detlist: 1, offline: 1, sources: 1, blocked: 1, lists: 1, blogs: 1 };
  // Close the floating context menus (species menu + the Detections-list per-row
  // menu) — they should never linger when another window/menu opens.
  function closeContextMenus() {
    try { var sm = document.getElementById("sp-menu"); if (sm) sm.style.display = "none"; } catch (e) {}
    try { closeDetRowMenu(); } catch (e) {}
  }
  // Close the open Leaflet map popups (detection dot, point-options, map-point
  // editor) and the sticky fan-out.
  function closeMapPopups() {
    try { if (typeof map !== "undefined" && map) map.closePopup(); } catch (e) {}
    try { if (typeof marker !== "undefined" && marker && marker.closePopup) marker.closePopup(); } catch (e) {}
    try { clearSpider(); } catch (e) {}
  }
  // Close every open modal overlay except `keep`.
  function closeModals(keep) {
    Object.keys(MODAL_IDS).forEach(function (id) {
      if (id === keep) return;
      var el = document.getElementById(id + "-modal");
      if (el && el.style.display === "flex") navClose(id);
    });
    try { if (typeof hidePerfModal === "function") hidePerfModal(); } catch (e) {}
  }
  function navOpen(id, close) {
    if (MODAL_IDS[id]) { closeMapPopups(); closeModals(id); closeDropdowns(); closeContextMenus(); }   // a modal stands alone
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
    // Returning to the map: re-assert the current mode's controls so the
    // date-range panel (Historic observations) reappears after a round-trip
    // through a full-screen species page.
    updateModeVisibility();
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
    var w = window.open("about:blank", "_blank"); try { if (w) w.opener = null; } catch (e) {}   // prevent reverse tabnabbing
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
  // NBN Atlas (UK) species search by scientific name.
  function nbnUrl(sci) { return "https://species.nbnatlas.org/search?q=" + encodeURIComponent(String(sci || "").trim()); }
  // EuroBirdPortal — animated week-by-week European distribution maps. It addresses
  // a species by a 6-letter code = first 3 of genus + first 3 of species, uppercased
  // (e.g. Jynx torquilla → JYNTOR), so we can deep-link straight to the species map.
  // EBP only covers ~105 species; an uncovered code just shows the empty viewer. A
  // species without a usable binomial falls back to the general viewer.
  var EBP_URL = "https://eurobirdportal.org/ebp/en/";
  function ebpCode(sci) {
    var p = String(sci || "").trim().split(/\s+/);
    if (p.length < 2) return "";
    var g = p[0].replace(/[^a-z]/gi, ""), s = p[1].replace(/[^a-z]/gi, "");
    return (g.length >= 3 && s.length >= 3) ? (g.slice(0, 3) + s.slice(0, 3)).toUpperCase() : "";
  }
  function ebpUrl(sci) {
    var code = ebpCode(sci);
    return code ? "https://eurobirdportal.org/embedded/ebp/en/" + code + "/traces/2000" : EBP_URL;
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
      var url = linkUrl(row.querySelector(".cu-url").value);   // http(s)-only; drops javascript:/data:
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

  // ---- Birding blogs / resources per country --------------------------------
  // Built-in "spec": a curated starter set of long-standing birding blogs &
  // resources keyed by ISO-3166 alpha-2. (A JS object, not a YAML file — this app
  // has no parser / build step; user additions + removals live in localStorage
  // [blogLinks / blogRemoved] and sync via the Drive payload like other settings.)
  // Coverage is partial and user-curated: add/remove links per country in the UI.
  // PERSONAL blogs by individual birders only — NOT official organisations,
  // portals or directories. Seeds are blogs seen in real searches; countries
  // without a confident personal blog are left empty for users to fill in.
  // Verified active in the last ~year (checked 2026-06); dormant blogs were
  // dropped. Countries with no confirmed-active personal blog are left empty.
  var BUILTIN_BLOGS = {
    GB: [ { label: "Brian's Birding Blog", url: "https://briansbirding.blogspot.com/" }, { label: "Austin's Birding Blog", url: "https://austinmorley.blogspot.com/" }, { label: "Non-Stop Birding (Peter Alfrey)", url: "https://peteralfreybirdingnotebook.blogspot.com/" } ],
    IE: [ { label: "NI Birds", url: "https://nibirds.blogspot.com/" }, { label: "The Irish Bird Blog", url: "https://theirishbirdblog.com/" } ],
    NL: [ { label: "Weblog Robert van der Meer", url: "https://robertbirding.wordpress.com/" } ],
    NO: [ { label: "Øygarden Birding", url: "http://oeygardenbirds.blogspot.com/" }, { label: "Utsira as Way of Life", url: "http://atgrims.blogspot.com/" } ],
    FI: [ { label: "Finnish Birding", url: "http://lintuja-sunmuita.blogspot.com/" }, { label: "High Latitude Birder (Olli Haukkovaara)", url: "https://highlatitudebirder.blogspot.com/" } ],
    DE: [ { label: "Vogelguckerin", url: "https://vogelguckerin.de/blog/" } ],
    ES: [ { label: "Birding in Spain's Wild West", url: "https://birdinginspainswildwest.com/" } ],
    FO: [ { label: "Birding Faroes", url: "https://birdingfaroes.wordpress.com/" } ]
  };
  function blogKey(cc, url) { return String(cc).toUpperCase() + "|" + url; }
  function getBlogLinks() { return (window.GeoState.get("blogLinks", []) || []).filter(function (b) { return b && b.cc && b.url; }); }
  function getBlogRemoved() { var m = {}; (window.GeoState.get("blogRemoved", []) || []).forEach(function (k) { m[k] = 1; }); return m; }
  // Effective blogs for a country: built-ins (minus user-removed) + user additions.
  function blogsFor(cc) {
    cc = String(cc || "").toUpperCase();
    var removed = getBlogRemoved(), out = [], seen = {};
    (BUILTIN_BLOGS[cc] || []).forEach(function (b) {
      var k = blogKey(cc, b.url); if (removed[k] || seen[k]) return; seen[k] = 1;
      out.push({ label: b.label, url: b.url, builtin: true });
    });
    getBlogLinks().forEach(function (b) {
      if (String(b.cc).toUpperCase() !== cc) return;
      var k = blogKey(cc, b.url); if (removed[k] || seen[k]) return; seen[k] = 1;   // a deleted user link stays deleted (tombstone)
      out.push({ label: b.label || urlHostLabel(b.url), url: b.url, builtin: false });
    });
    return out;
  }
  var blogsCC = "", blogsCountryName = "";
  function openBlogs(cc, name) {
    blogsCC = String(cc || "").toUpperCase();
    blogsCountryName = name || blogsCC;
    renderBlogs();
    document.getElementById("blogs-modal").style.display = "flex";
    navOpen("blogs", function () { document.getElementById("blogs-modal").style.display = "none"; });
  }
  function renderBlogs() {
    var list = document.getElementById("blogs-list"); if (!list) return;
    var title = document.getElementById("blogs-title");
    if (title) title.textContent = t("blogs.title") + (blogsCountryName ? " · " + blogsCountryName : "");
    var blogs = blogsFor(blogsCC);
    var rows = blogs.map(function (b) {
      return '<div class="offline-row"><a class="blogs-name" href="' + escapeHtml(safeHref(b.url)) + '" target="_blank" rel="noopener">' + escapeHtml(b.label) + " ↗</a>" +
        '<button type="button" class="dd-del blogs-del" data-url="' + escapeHtml(b.url) + '" aria-label="' + escapeHtml(t("offline.delete")) + '">×</button></div>';
    }).join("");
    // Always offer the respective country's blogs page on Fatbirder (a directory,
    // not deletable) so there's a fallback even where there are no personal blogs.
    var fb = '<div class="offline-row blogs-fb"><a class="blogs-name" href="' + escapeHtml(fatbirderUrl(blogsCC, blogsCountryName)) + '" target="_blank" rel="noopener">' + escapeHtml(t("blogs.fatbirder")) + " ↗</a></div>";
    var empty = blogs.length ? "" : '<p class="dd-empty">' + escapeHtml(t("blogs.empty")) + "</p>";
    list.innerHTML = empty + rows + fb;
    list.querySelectorAll(".blogs-del").forEach(function (btn) {
      btn.addEventListener("click", function () { removeBlog(this.getAttribute("data-url")); });
    });
  }
  // Delete: always record a blogRemoved tombstone (for BOTH built-ins and user links)
  // so the delete survives a Drive sync/re-merge; also drop it from blogLinks. Re-adding
  // the same URL clears the tombstone (see addBlog).
  function removeBlog(url) {
    var k = blogKey(blogsCC, url);
    var rem = window.GeoState.get("blogRemoved", []) || []; if (rem.indexOf(k) < 0) rem.push(k);
    window.GeoState.save({ blogRemoved: rem });
    saveChecked({ blogLinks: getBlogLinks().filter(function (b) { return blogKey(b.cc, b.url) !== k; }) });
    renderBlogs();
  }
  function addBlog() {
    modalPrompt(t("blogs.addPrompt"), "https://").then(function (url) {
      url = linkUrl(url); if (!url || url === "https://") return;   // http(s)-only; drops javascript:/data:
      modalPrompt(t("blogs.namePrompt"), urlHostLabel(url)).then(function (label) {
        label = String(label || "").trim() || urlHostLabel(url);
        var links = getBlogLinks();
        if (!links.some(function (b) { return blogKey(b.cc, b.url) === blogKey(blogsCC, url); })) {
          links.push({ cc: blogsCC, url: url, label: label });
          saveChecked({ blogLinks: links });
        }
        // Re-adding a removed built-in un-hides it.
        var k = blogKey(blogsCC, url);
        window.GeoState.save({ blogRemoved: (window.GeoState.get("blogRemoved", []) || []).filter(function (x) { return x !== k; }) });
        renderBlogs();
      });
    });
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
    var w = window.open("about:blank", "_blank"); try { if (w) w.opener = null; } catch (e) {}   // prevent reverse tabnabbing
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

  // normClass moved to the AppNormalize module (docs/normalize.js).
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
  // gbifGeometry + GBIF_FILTER moved to the AppFetch module (docs/fetch.js).
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
  // "What's new" — a dated log of MAJOR user-facing features (not bug fixes),
  // newest first, shown at the bottom of Settings. Keep only the latest 10; add new
  // entries at the TOP when a notable feature ships. Text is kept brief/English.
  var WHATS_NEW = [
    { date: "2026-07-21", text: "The map legend's filters are now dropdown subwindows. Time opens presets (1/2/3 days, weeks, months) plus a from–to date range; the ★/◉/🟡 species filter shows each option with its symbol and meaning. And the red × now deletes fetched areas one at a time — the first click puts a red × on each fetched rectangle (tap it to remove just that area's detections), a second click on the legend × clears everything." },
    { date: "2026-07-20", text: "Deduplicate detections (Settings → Fetching & detections): when the same sighting is registered in two databases — same observer, approximate location, date, count and species — show it once instead of twice. Off by default (shows every source's copy)." },
    { date: "2026-07-18", text: "The map legend now orders species by the habitat model's probability (lowest → highest); for a species with several observations it uses the highest probability among them." },
    { date: "2026-07-17", text: "Faster reopen: the app now remembers the last few locations' downloaded observations, so reopening (or revisiting a place) reuses them instead of re-fetching — and a cached location even opens offline. Fresh data is still fetched for new places or after the reuse window (Settings, default 30 min)." },
    { date: "2026-07-17", text: "Observer lists: the 👤 observer filter has a scope button that cycles All → None → each of your saved lists. Hover an observer's name to isolate their records on the map; tap the name (in the legend OR the detections list) to add them to a list — a multi-observer record first shows a picker of the individual names. The ✎ button opens an editor (pick a list, rename/delete, remove members, and add members by fuzzy-searching observers with observations)." },
    { date: "2026-07-17", text: "Resize the “Sightings radius” with Shift + mouse-wheel over the map (scroll up = larger), as well as the Settings slider — the search box resizes live." },
    { date: "2026-07-14", text: "Share the whole map in one go: the Points panel has a “Share map” button that packs every plotted detection AND your placed points into one link. The recipient (no API keys needed) sees names in their own language, plus each record’s source with a link to verify." },
    { date: "2026-07-10", text: "Share via link: the 🔗 button on a saved location-list or trip (in the Points panel), or on a map point's popup, makes a self-contained URL — the recipient sees the points/detections with no API keys needed (nothing is re-fetched). Opening such a link imports it." },
    { date: "2026-07-06", text: "Close by: the ☰ button (top-left of the map) opens a big-text list of the plotted detections sorted by distance from your live/fixed cross or placed pin. Tap the 📍 to jump back to the map zoomed to fit them. Set how many rows in Settings." },
    { date: "2026-07-01", text: "Stored locations can fetch observations: give each saved spot a radius, tick the ones you want, and hit “Fetch observations” to pull sightings from all of them onto the map at once." },
    { date: "2026-06-30", text: "Stored locations: tap a map point and choose “📍 Save location”, then press-and-hold (or right-click) the crosshair button to recall your saved spots and fly to them." },
    { date: "2026-06-24", text: "Add photos to a checklist species: tap the 📷 button on its card to attach pictures (stored on this device); a 📷 count shows on the card, and the photos are included in the exported checklist report." },
    { date: "2026-06-24", text: "Species groups now fetch live observations too: pick Mammals, Amphibians or Insects (not just Birds) and the sources return that group. eBird/BirdWeather stay birds-only; the others filter by group." },
    { date: "2026-06-23", text: "Birding blogs: a per-country list of personal blogs by individual birders, from the map popup — add and remove your own links (synced)." },
    { date: "2026-06-23", text: "Birdingplaces.eu link from the map popup." },
    { date: "2026-06-22", text: "Offline maps manager: each area colour-coded on the map with a matching legend, in a side panel you can minimize." },
    { date: "2026-06-22", text: "Fullscreen button in the header." },
    { date: "2026-06-20", text: "Live GPS “follow”: the map recentres as you move." }
  ];
  function renderWhatsNew() {
    var el = document.getElementById("whatsnew-list"); if (!el) return;
    el.innerHTML = WHATS_NEW.slice(0, 10).map(function (e) {
      return '<div class="wn-item"><span class="wn-date">' + escapeHtml(e.date) + '</span><span class="wn-text">' + escapeHtml(e.text) + "</span></div>";
    }).join("");
  }
  // Birdingplaces.eu "find a birdingplace" map, centred on the point via the
  // viewer's #zoom/lat/lon hash (e.g. #6.52/41.54/-4.221).
  function birdingPlacesUrl(lat, lon) {
    var z = map ? map.getZoom() : 12;
    return "https://www.birdingplaces.eu/en/find-a-birdingplace#" + z.toFixed(2) + "/" + lat.toFixed(4) + "/" + lon.toFixed(4);
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
  // countryCache + countryInfo/countryCode moved to the AppGeo module (docs/geo.js).

  // GBIF occurrences in a 25 km box over a date range. GBIF has no server-side
  // date sort, so we page the date-filtered results (up to ~900) and sort
  // client-side, returning the 100 most recent.
  async function gbifRecent(sci, lat, lon, range, radiusKm) {
    var base = "https://api.gbif.org/v1/occurrence/search?hasCoordinate=true&limit=300&scientificName=" +
      encodeURIComponent(sci) + "&geometry=" + encodeURIComponent(AppFetch.gbifGeometry(lat, lon, radiusKm || 25)) +
      "&eventDate=" + encodeURIComponent(range) + "&occurrenceStatus=PRESENT&hasGeospatialIssue=false";   // species-specific → quality filters only (no taxonKey)
    var all = [], offset = 0, total = Infinity, pages = 0;
    while (offset < total && pages < 3) {
      var j = await AppFetch.gbifPage(base + "&offset=" + offset);   // retry/backoff on 429/5xx
      if (!j) break;
      total = j.count || 0;
      var res = j.results || [];
      for (var i = 0; i < res.length; i++) all.push(res[i]);
      offset += 300; pages++;
      if (res.length < 300 || j.endOfRecords) break;
    }
    all.sort(function (a, b) { return String(b.eventDate || "").localeCompare(String(a.eventDate || "")); });
    return all.slice(0, 100).map(function (o) {
      return {
        src: "GBIF",
        origin: o.datasetName || "",   // the underlying dataset GBIF aggregated
        cls: AppNormalize.normClass(o.class),
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
  // iNaturalist locale for preferred_common_name. iNat uses "nb" for Norwegian;
  // the rest of our UI codes match iNat's, and an unknown one just falls back to
  // the English name on iNat's side.
  function inatLocale() { return ({ no: "nb" })[lang] || lang; }
  async function inatRecent(sci, lat, lon, d1, d2, radiusKm) {
    var url = "https://api.inaturalist.org/v1/observations?verifiable=true&order_by=observed_on&order=desc&per_page=100" +
      "&locale=" + encodeURIComponent(inatLocale()) +
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
        cls: AppNormalize.normClass((o.taxon && o.taxon.iconic_taxon_name) || ""),
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
  // BirdWeather: a species counts as "here" on a day only with at least bwMinDet()
  // detections at confidence ≥ bwMinConf(). Both tunable in the BirdWeather entry
  // of the Data-sources card.
  function bwMinDet() { var n = +window.GeoState.get("bwMinDet", 2); return (n >= 1 && n <= 50) ? n : 2; }
  function bwMinConf() { var n = +window.GeoState.get("bwMinConf", 0.5); return (n >= 0 && n <= 1) ? n : 0.5; }
  // Per-source fetch timeout (seconds). A source still running after this is
  // aborted; whatever it had already paged is kept and its label turns red.
  // 0 = no timeout. Default 30 s.
  function fetchTimeoutSec() { var n = +window.GeoState.get("fetchTimeoutSec", 30); return (n >= 0 && n <= 600) ? n : 30; }
  function setFetchTimeoutSec(n) { window.GeoState.save({ fetchTimeoutSec: Math.max(0, Math.min(600, +n || 0)) }); allSightingsCache = {}; }
  // Human label for a radius in km — sub-kilometre shown in metres ("500 m").
  function radiusLabel(km) { var r = (km == null) ? recentRadiusKm() : km; return r < 1 ? Math.round(r * 1000) + " m" : r + " km"; }
  // Quasi-exponential slider stops for the fetch radius (km), 100 m → 150 km.
  var RADIUS_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 10, 15, 25, 30, 50, 75, 100, 150];
  function radiusStepIndex(km) {
    var best = 0, bd = Infinity;
    for (var i = 0; i < RADIUS_STEPS.length; i++) { var d = Math.abs(RADIUS_STEPS[i] - km); if (d < bd) { bd = d; best = i; } }
    return best;
  }

  // Species List mode: a dashed rectangle around the pointer showing the box each
  // click fetches observations from (± recentRadiusKm — the same extent
  // gbifGeometry builds). Follows the cursor; hidden in any other mode.
  var fetchAreaRect = null;
  function fetchAreaBounds(latlng) {
    var rkm = recentRadiusKm();
    var dLat = rkm / 111.32;
    var cos = Math.cos(latlng.lat * Math.PI / 180);
    var dLon = rkm / (111.32 * (cos > 0.01 ? cos : 0.01));
    return [[latlng.lat - dLat, latlng.lng - dLon], [latlng.lat + dLat, latlng.lng + dLon]];
  }
  function hideFetchArea() { if (fetchAreaRect && map) map.removeLayer(fetchAreaRect); fetchAreaRect = null; }
  function updateFetchArea(latlng) {
    // Shown in "species at location" (list) AND Historic observations — both
    // fetch the ± recentRadiusKm box around the pointer, so both get the same
    // thin dashed square following the cursor (a live preview).
    if ((currentMode !== "list" && currentMode !== "historic") || !map) { hideFetchArea(); return; }
    var b = fetchAreaBounds(latlng);
    if (!fetchAreaRect) {
      fetchAreaRect = L.rectangle(b, { color: "#2e8b74", weight: 1, opacity: 0.7, dashArray: "4 4", fillColor: "#2e8b74", fillOpacity: 0.04, interactive: false });
      fetchAreaRect.addTo(map);
    } else {
      fetchAreaRect.setBounds(b);
    }
  }
  // Remembered fetched areas: each fetch leaves a THIN dashed green outline of the
  // area it covered (no fill), accumulating on the map and cleared only when the
  // detections are cleared. Deduped so the same spot+radius isn't outlined twice.
  // Remembered fetched-area outlines. Each area keeps its bounds + rectangle so the
  // red × "delete one area" flow can remove just that area's detections (any dot
  // whose point falls inside the rectangle) and its outline.
  var fetchedAreasLayer = null, fetchedAreaKeys = null, fetchedAreas = [];
  var areaDelLayer = null, detAreaDeleteMode = false;
  function rememberFetchedArea(lat, lon, rkm) {
    if (!map || !L.rectangle || !isFinite(lat) || !isFinite(lon)) return;
    rkm = rkm || recentRadiusKm();
    var key = lat.toFixed(3) + "," + lon.toFixed(3) + ":" + rkm;
    addFetchedAreaRect(key, fetchAreaBounds(L.latLng(lat, lon)));
    saveFetchedAreas();
  }
  // Draw one remembered area (outline + bookkeeping). Shared by a live fetch and
  // the boot-time restore; deduped by key.
  function addFetchedAreaRect(key, b) {
    if (!fetchedAreasLayer) { fetchedAreasLayer = L.layerGroup().addTo(map); fetchedAreaKeys = Object.create(null); }
    if (fetchedAreaKeys[key]) return;   // already outlined
    fetchedAreaKeys[key] = 1;
    // Normalise to a real LatLngBounds — fetchAreaBounds() hands us a plain
    // [[s,w],[n,e]] array, but the persistence + per-area delete call .getSouth() /
    // .contains() on it. (L.latLngBounds is idempotent for an existing bounds.)
    b = L.latLngBounds(b);
    var rect = L.rectangle(b, { color: "#2e8b74", weight: 1, opacity: 0.5, dashArray: "2 4", fill: false, interactive: false });
    fetchedAreasLayer.addLayer(rect);
    var area = { id: key, bounds: b, rect: rect, delMarker: null };
    fetchedAreas.push(area);
    if (detAreaDeleteMode) addAreaDelMarker(area);   // a fetch while armed → show its × too
  }
  // The remembered areas persist with the detections (bounds only), so the
  // outlines — and the red ×'s per-area delete — survive a reload.
  function saveFetchedAreas() {
    window.GeoState.save({ fetchedAreas: fetchedAreas.map(function (a) {
      return { id: a.id, s: a.bounds.getSouth(), w: a.bounds.getWest(), n: a.bounds.getNorth(), e: a.bounds.getEast() };
    }) });
  }
  function restoreFetchedAreas() {
    if (!map) return;
    (window.GeoState.get("fetchedAreas", []) || []).forEach(function (a) {
      if (!a || !isFinite(+a.s) || !isFinite(+a.w) || !isFinite(+a.n) || !isFinite(+a.e)) return;
      addFetchedAreaRect(a.id || (+a.s).toFixed(3) + "," + (+a.w).toFixed(3), L.latLngBounds([[+a.s, +a.w], [+a.n, +a.e]]));
    });
  }
  function clearFetchedAreas() {
    if (fetchedAreasLayer) fetchedAreasLayer.clearLayers();
    fetchedAreaKeys = fetchedAreasLayer ? Object.create(null) : null;
    fetchedAreas = [];
    exitAreaDeleteMode();
    window.GeoState.save({ fetchedAreas: [] });
  }
  // ---- Per-area delete (the red ×'s two-stage behaviour) --------------------
  // A small red × pinned to each fetched rectangle's NE corner. Tap one → delete
  // that area (its detections + outline). The legend's red × arms this mode on the
  // first click and deletes everything on the second.
  function addAreaDelMarker(area) {
    if (!map || !L.marker) return;
    if (!areaDelLayer) areaDelLayer = L.layerGroup().addTo(map);
    var icon = L.divIcon({ className: "area-del-icon", html: "×", iconSize: [24, 24], iconAnchor: [12, 12] });
    var mk = L.marker(area.bounds.getNorthEast(), { icon: icon, keyboard: false, zIndexOffset: 2000, title: t("det.delArea") });
    mk.on("click", function (e) { if (L.DomEvent) L.DomEvent.stop(e); mapClickGuardUntil = Date.now() + 250; deleteFetchedArea(area.id); });
    area.delMarker = mk;
    areaDelLayer.addLayer(mk);
  }
  function enterAreaDeleteMode() {
    if (!fetchedAreas.length) return;
    detAreaDeleteMode = true;
    if (!areaDelLayer) areaDelLayer = L.layerGroup().addTo(map);
    areaDelLayer.clearLayers();
    fetchedAreas.forEach(addAreaDelMarker);
  }
  function exitAreaDeleteMode() {
    detAreaDeleteMode = false;
    if (areaDelLayer) areaDelLayer.clearLayers();
  }
  // Delete one fetched area: drop every FETCHED detection row whose point falls
  // inside the rectangle (list-injected rows, r._list, are left to their list),
  // remove any species left empty, then remove the outline + ×.
  function deleteFetchedArea(id) {
    var idx = -1; for (var i = 0; i < fetchedAreas.length; i++) if (fetchedAreas[i].id === id) { idx = i; break; }
    if (idx < 0) return;
    var area = fetchedAreas[idx], b = area.bounds;
    Object.keys(detPlot).forEach(function (k) {
      var e = detPlot[k], rows = e.rows || [];
      var kept = rows.filter(function (r) {
        if (r._list) return true;   // belongs to a shown list, not this fetch
        return !(isFinite(+r.lat) && isFinite(+r.lon) && b.contains([+r.lat, +r.lon]));
      });
      if (kept.length === rows.length) return;                 // untouched
      if (!kept.length) { if (e.group) map.removeLayer(e.group); delete detPlot[k]; delete detSelected[k]; }
      else e.rows = kept;
    });
    if (area.rect && fetchedAreasLayer) fetchedAreasLayer.removeLayer(area.rect);
    if (area.delMarker && areaDelLayer) areaDelLayer.removeLayer(area.delMarker);
    if (fetchedAreaKeys) delete fetchedAreaKeys[id];
    fetchedAreas.splice(idx, 1);
    saveFetchedAreas();
    if (!fetchedAreas.length) exitAreaDeleteMode();
    rebuildDetLayers(); updateDetLegend(); saveDetections();
  }

  // ---- All-species sightings (for per-point species-list augmentation) ------
  // Fetch GBIF + iNaturalist + (with key) eBird detections at the clicked
  // point WITHOUT a species filter, then aggregate by the model's species key
  // so each row in the Species List can show count + days-since-most-recent.
  // Scientific/common-name index + record→species matching moved to the
  // AppAggregate module (docs/aggregate.js). app.js injects the model data and
  // family index into it via AppAggregate.init({...}) during init().
  var allSightingsCache = {};   // "lat,lon" rounded -> Promise<aggregated map>
  var histSightingsCache = {};  // "lat,lon:rkm:range" -> Promise<aggregated map> for Historic observations
  // GBIF datasets fetched on their OWN (each with its own page budget) in
  // addition to the general query, so a busy dataset isn't lost to the page cap.
  // eBird & iNaturalist are fetched via their native APIs instead (fresher, and
  // GBIF copies would double-count), so they're deliberately not here. The list
  // is user-extendable in Settings (gbifDatasets in GeoState).
  // `country` (ISO-2) marks a nation-specific dataset: it's only queried when the
  // search reaches that country (a Swedish dataset returns nothing in Norway, so
  // there's no point spending a request on it). The international ones (no
  // country) are queried everywhere.
  // (source/dataset config moved to the AppSources module, aliased at top.)
  // Render the dataset list into the popup as a Key | URL table (the URL links
  // to the dataset's GBIF page; its name is the link tooltip). Each row removable.
  // The "Data sources" popup: one editable row per direct (non-GBIF) source —
  // Name, Key (for keyed sources) and URL endpoint — with per-row delete.
  // The Data sources popup is master/detail: a tidy LIST of source names, and a
  // per-source DETAIL view (opened by tapping a name) with an explanation, the
  // enable toggle, and its editable settings. srcDetailId = the open source (null
  // = list).
  var srcDetailId = null;
  // Where to create an account (account) and where to obtain the API key (key) for
  // each keyed source — both shown as links in the source detail view.
  var KEY_LINKS = {
    ebird: { account: "https://secure.birds.cornell.edu/identity/account/create", key: "https://ebird.org/api/keygen" },
    artportalen: { account: "https://api-portal.artdatabanken.se/signup", key: "https://api-portal.artdatabanken.se/products" },
    laji: { account: "https://laji.fi/", key: "https://laji.fi/about/806" }
  };
  function srcInfo(id) {
    if (id === "gbif") return { id: "gbif", name: "GBIF", url: "", days: gbifDays(), keyed: false, country: null, global: true, removable: false, isGbif: true };
    var s = directSources().filter(function (x) { return x.id === id; })[0]; if (!s) return null;
    var d = DIRECT_BY_ID[id] || {};
    return { id: id, name: s.name, url: s.url, days: s.days, keyed: !!d.keyed, country: d.country || null, global: false, removable: true, isGbif: false };
  }
  function srcDescKey(info) { return "srcdesc." + (info.isGbif ? "gbif" : (DIRECT_BY_ID[info.id] ? info.id : "custom")); }
  function patchSource(id, field, value) {
    saveDirectSources(directSources().map(function (s) { var o = { id: s.id, name: s.name, url: s.url, days: s.days }; if (s.id === id) o[field] = value; return o; }));
  }
  // Probe a keyed source and paint ✓ / ✗ beside its key field (detail view).
  function runSrcKeyTest(id) {
    var sp = document.querySelector('#sources-table .src-key-status[data-id="' + id + '"]'); if (!sp) return;
    var key = directKey(id);
    if (!key) { sp.textContent = ""; sp.className = "src-key-status"; sp.title = ""; return; }
    sp.textContent = "…"; sp.className = "src-key-status testing"; sp.title = t("sources.keyTesting");
    testSourceKey(id, key).then(function (ok) {
      if (directKey(id) !== key) return;   // key changed again mid-probe — ignore stale result
      if (ok === null) { sp.textContent = ""; sp.className = "src-key-status"; sp.title = ""; }
      else if (ok) { sp.textContent = "✓"; sp.className = "src-key-status ok"; sp.title = t("sources.keyOk"); }
      else { sp.textContent = "✗"; sp.className = "src-key-status bad"; sp.title = t("sources.keyBad"); }
    });
  }
  function renderSourcesTable() {
    var el = document.getElementById("sources-table"); if (!el) return;
    if (srcDetailId) { renderSourceDetail(srcDetailId); return; }
    var hint = document.getElementById("sources-hint"); if (hint) hint.style.display = "";
    var act = document.getElementById("sources-actions"); if (act) act.style.display = "";
    // Plain heading in the list view (no back affordance).
    var title = document.getElementById("sources-title");
    if (title) { title.textContent = t("sources.title"); title.classList.remove("src-title-back"); title.onclick = null; }
    var ids = ["gbif"].concat(directSources().map(function (s) { return s.id; }));
    el.innerHTML = '<div class="src-list">' + ids.map(function (id) {
      var info = srcInfo(id); if (!info) return "";
      var off = isSourceOff(id);
      var region = info.global || !info.country ? "🌍" : escapeHtml(info.country);
      // Fixed-width key column so it lines up across rows: a key icon when one is
      // set, "🔑✗" when a key is required but missing, "–" when none is needed.
      var keyCell, keyTitle, keyCls = "src-row-key";
      if (!info.keyed) { keyCell = "–"; keyTitle = t("sources.nokey"); keyCls += " src-key-na"; }
      else if (directKey(id)) { keyCell = "🔑"; keyTitle = t("sources.keySet"); keyCls += " src-key-set"; }
      else { keyCell = "🔑✗"; keyTitle = t("sources.keyMissing"); keyCls += " src-key-missing"; }
      return '<button type="button" class="src-row' + (off ? " src-off" : "") + '" data-id="' + escapeHtml(id) + '">' +
        '<span class="src-row-dot" title="' + escapeHtml(off ? t("sources.disabled") : t("sources.enabled")) + '"></span>' +
        '<span class="src-row-name">' + escapeHtml(info.name) + "</span>" +
        '<span class="src-row-region">' + region + "</span>" +
        '<span class="' + keyCls + '" title="' + escapeHtml(keyTitle) + '">' + keyCell + "</span>" +
        '<span class="src-row-chev">›</span></button>';
    }).join("") + "</div>";
    el.querySelectorAll(".src-row").forEach(function (b) {
      b.addEventListener("click", function () { srcDetailId = this.getAttribute("data-id"); renderSourcesTable(); });
    });
  }
  function renderSourceDetail(id) {
    var el = document.getElementById("sources-table"); if (!el) return;
    var info = srcInfo(id);
    if (!info) { srcDetailId = null; renderSourcesTable(); return; }
    var hint = document.getElementById("sources-hint"); if (hint) hint.style.display = "none";
    var act = document.getElementById("sources-actions"); if (act) act.style.display = "none";
    // The popup heading becomes the "back to list" link in the detail view, so we
    // drop the separate back button below it.
    var title = document.getElementById("sources-title");
    if (title) {
      title.innerHTML = "‹ " + escapeHtml(t("sources.title"));
      title.classList.add("src-title-back");
      title.onclick = function () { srcDetailId = null; renderSourcesTable(); };
    }
    var off = isSourceOff(id);
    var flag = info.global ? ' <span class="src-cc src-cc-global" title="' + escapeHtml(t("gbif.global")) + '">🌍</span>'
      : (info.country ? ' <span class="src-cc">' + escapeHtml(info.country) + "</span>" : "");
    var h = '<div class="src-detail">' +
      '<h4 class="src-detail-title">' + escapeHtml(info.name) + flag + "</h4>" +
      '<p class="cu-hint src-detail-desc">' + escapeHtml(t(srcDescKey(info))) + "</p>" +
      '<label class="ctrl-check src-detail-on"><input type="checkbox" class="src-on" data-id="' + escapeHtml(id) + '"' + (off ? "" : " checked") + "> <span>" + escapeHtml(t("sources.enabled")) + "</span></label>";
    if (!info.isGbif) h += '<div class="src-detail-field"><label>' + escapeHtml(t("sources.colName")) + '</label><input type="text" class="src-name" value="' + escapeHtml(info.name) + '" /></div>';
    if (info.keyed) h += '<div class="src-detail-field"><label>' + escapeHtml(t("sources.colKey")) + '</label>' +
      '<span class="src-key-wrap"><input type="text" class="src-key" data-id="' + escapeHtml(id) + '" value="' + escapeHtml(directKey(id)) + '" autocomplete="off" spellcheck="false" placeholder="' + escapeHtml(t("sources.keyPh")) + '" />' +
      '<span class="src-key-status" data-id="' + escapeHtml(id) + '"></span>' +
      (KEY_LINKS[id] ?
        (KEY_LINKS[id].account ? '<a class="src-key-link" href="' + escapeHtml(KEY_LINKS[id].account) + '" target="_blank" rel="noopener">' + escapeHtml(t("sources.signup")) + " ↗</a>" : "") +
        (KEY_LINKS[id].key ? '<a class="src-key-link" href="' + escapeHtml(KEY_LINKS[id].key) + '" target="_blank" rel="noopener">' + escapeHtml(t("sources.getKey")) + " ↗</a>" : "")
        : "") +
      "</span></div>";
    h += '<div class="src-detail-field"><label>' + escapeHtml(t("sources.colDays")) + '</label><input type="number" class="src-days" min="1" max="' + (info.isGbif ? 92 : 365) + '" value="' + info.days + '" /></div>';
    if (!info.isGbif) h += '<div class="src-detail-field"><label>' + escapeHtml(t("sources.colUrl")) + '</label><input type="text" class="src-url" value="' + escapeHtml(info.url) + '" autocomplete="off" spellcheck="false" /></div>';
    // BirdWeather-specific "is here" thresholds live with the source, not in Settings:
    // a species counts as present on a day only with ≥ N detections at ≥ confidence.
    if (id === "birdweather") {
      h += '<div class="src-detail-field"><label>' + escapeHtml(t("sources.bwMinDet")) + ' <span class="src-bw-md-val">' + bwMinDet() + '</span></label>' +
        '<div class="radius-row"><input type="range" class="src-bw-md" min="1" max="20" step="1" value="' + bwMinDet() + '" /></div></div>';
      h += '<div class="src-detail-field"><label>' + escapeHtml(t("sources.bwMinConf")) + ' <span class="src-bw-conf-val">' + Math.round(bwMinConf() * 100) + '%</span></label>' +
        '<div class="radius-row"><input type="range" class="src-bw-conf" min="0" max="95" step="5" value="' + Math.round(bwMinConf() * 100) + '" /></div>' +
        '<p class="cu-hint">' + escapeHtml(t("sources.bwHint")) + '</p></div>';
    }
    if (info.removable) h += '<div class="cu-actions"><button type="button" class="demo-btn demo-btn-light src-del-detail">' + escapeHtml(t("sources.remove")) + "</button></div>";
    h += "</div>";
    el.innerHTML = h;
    var onCb = el.querySelector(".src-on"); if (onCb) onCb.addEventListener("change", function () { setSourceOff(id, !this.checked); });
    var nameInp = el.querySelector(".src-name"); if (nameInp) nameInp.addEventListener("change", function () { patchSource(id, "name", this.value.trim()); });
    var urlInp = el.querySelector(".src-url"); if (urlInp) urlInp.addEventListener("change", function () { patchSource(id, "url", this.value.trim()); });
    var daysInp = el.querySelector(".src-days"); if (daysInp) daysInp.addEventListener("change", function () { var v = Math.max(1, Math.min(info.isGbif ? 92 : 365, +this.value || 1)); if (info.isGbif) setGbifDays(v); else patchSource(id, "days", v); });
    var keyInp = el.querySelector(".src-key");
    if (keyInp) {
      keyInp.addEventListener("input", function () { setDirectKey(id, this.value); allSightingsCache = {}; window.GeoState.touch(); });
      keyInp.addEventListener("change", function () { runSrcKeyTest(id); });
      if (directKey(id)) runSrcKeyTest(id);
    }
    var bwMd = el.querySelector(".src-bw-md"), bwMdV = el.querySelector(".src-bw-md-val");
    if (bwMd) {
      bwMd.addEventListener("input", function () { if (bwMdV) bwMdV.textContent = this.value; });
      bwMd.addEventListener("change", function () { window.GeoState.save({ bwMinDet: Math.max(1, Math.min(50, +this.value || 2)) }); allSightingsCache = {}; });
    }
    var bwC = el.querySelector(".src-bw-conf"), bwCV = el.querySelector(".src-bw-conf-val");
    if (bwC) {
      bwC.addEventListener("input", function () { if (bwCV) bwCV.textContent = this.value + "%"; });
      bwC.addEventListener("change", function () { window.GeoState.save({ bwMinConf: Math.max(0, Math.min(95, +this.value || 0)) / 100 }); allSightingsCache = {}; });
    }
    var del = el.querySelector(".src-del-detail");
    if (del) del.addEventListener("click", function () {
      if (DIRECT_BY_ID[id]) { var rem = window.GeoState.get("srcRemoved", []) || []; if (rem.indexOf(id) < 0) { rem.push(id); window.GeoState.save({ srcRemoved: rem }); } }
      saveDirectSources(directSources().filter(function (s) { return s.id !== id; }).map(function (s) { return { id: s.id, name: s.name, url: s.url, days: s.days }; }));
      srcDetailId = null; renderSourcesTable();
    });
  }
  function resetSources() { window.GeoState.save({ directSources: null, srcRemoved: null }); allSightingsCache = {}; srcDetailId = null; renderSourcesTable(); }
  // Settings → Blocked species: list every hidden species with an × to unblock.
  function renderBlockedList() {
    var el = document.getElementById("blocked-list"); if (!el) return;
    var keys = Object.keys(hiddenSpecies);
    if (!keys.length) { el.innerHTML = '<p class="cu-hint">' + escapeHtml(t("blocked.empty")) + "</p>"; return; }
    var nameByKey = Object.create(null);
    keys.forEach(function (k) { var lbl = labelsByKey[k]; nameByKey[k] = lbl ? speciesName(lbl) : k; });   // compute once, not per comparison
    keys.sort(function (a, b) { return nameByKey[a].localeCompare(nameByKey[b]); });
    el.innerHTML = '<table class="src-tbl"><tbody>' + keys.map(function (k) {
      var n = escapeHtml(nameByKey[k]);
      return '<tr><td class="dset-name">' + n + "</td>" +
        '<td class="dset-actions"><button type="button" class="src-del blk-del" data-key="' + escapeHtml(k) + '" aria-label="' + escapeHtml(t("loc.unhide")) + '">×</button></td></tr>';
    }).join("") + "</tbody></table>";
    el.querySelectorAll(".blk-del").forEach(function (b) {
      b.addEventListener("click", function () { unhideSpecies(this.getAttribute("data-key")); renderBlockedList(); });
    });
  }
  // Display name for a species key (current UI language), for the lists view.
  function listKeyName(key) {
    var lbl = labelsByKey[key];
    if (lbl) return speciesName(lbl);
    var e = (typeof detPlot !== "undefined") && detPlot[key];
    return speciesCase(lang, (e && (e.name || e.key)) || key);
  }
  var listsExpanded = {};   // which list sections are expanded (id "life" or a year)
  function listSpeciesRows(id, keys) {
    if (!keys.length) return '<div class="lists-sp-empty">' + escapeHtml(t("lists.empty")) + "</div>";
    var items = keys.map(function (k) { return { k: k, nm: listKeyName(k) }; })
      .sort(function (a, b) { return a.nm.localeCompare(b.nm); });
    // Each species can be EDITED (moved to another year/life list) as well as
    // removed — so a misfiled entry can be corrected without re-adding it.
    var targets = listMoveTargets(id);
    var optsHtml = targets.map(function (tg) { return '<option value="' + escapeHtml(tg.v) + '">' + escapeHtml(tg.l) + "</option>"; }).join("");
    function moveSel(key) {
      if (!targets.length) return "";
      return '<select class="lists-sp-move" data-id="' + escapeHtml(id) + '" data-key="' + escapeHtml(key) + '" title="' + escapeHtml(t("lists.moveTo")) + '">' +
        '<option value="">' + escapeHtml(t("lists.moveTo")) + "</option>" + optsHtml + "</select>";
    }
    return '<div class="lists-species">' + items.map(function (it) {
      return '<div class="lists-sp-row"><span class="lists-sp-nm">' + escapeHtml(it.nm) + "</span>" + moveSel(it.k) +
        '<button type="button" class="lists-sp-del" data-id="' + escapeHtml(id) + '" data-key="' + escapeHtml(it.k) + '" aria-label="' + escapeHtml(t("offline.delete")) + '" title="' + escapeHtml(t("offline.delete")) + '">×</button></div>';
    }).join("") + "</div>";
  }
  // Lists a species can be moved TO from its current list `fromId` ("life" or a
  // year): the life list (if not already there) and every year list (existing +
  // the current year), excluding the source.
  function listMoveTargets(fromId) {
    var out = [];
    if (fromId !== "life") out.push({ v: "life", l: t("lists.life") });
    var years = {}; Object.keys(yearLists).forEach(function (y) { years[y] = 1; }); years[curYear()] = 1;
    Object.keys(years).sort(function (a, b) { return b.localeCompare(a); }).forEach(function (y) {
      if (y !== fromId) out.push({ v: y, l: t("lists.year", { year: y }) });
    });
    return out;
  }
  function listsRemoveSpecies(id, key) {
    if (id === "life") delete lifeList[key];
    else if (yearLists[id]) delete yearLists[id][key];
    persistLists(); rebuildDetLayers(); updateDetLegend(); renderListsModal();
  }
  // Per-point rows for an expanded map-point list (general or detection-saved):
  // each point shows its name (and tag/coords) with an edit (✎) and a remove (×).
  function listPointRows(collName) {
    var c = mpCollections.filter(function (x) { return x.name === collName; })[0];
    if (!c || !(c.points || []).length) return '<div class="lists-sp-empty">' + escapeHtml(t("lists.empty")) + "</div>";
    var head = '<div class="lists-sp-row lists-pt-head"><span class="lists-sp-nm">' + escapeHtml(t("points.name")) + "</span>" +
      '<span class="lists-pt-coord">Lat</span><span class="lists-pt-coord">Lon</span><span class="lists-pt-sp"></span></div>';
    return '<div class="lists-species">' + head + (c.points || []).map(function (p) {
      var tag = (p.tags && p.tags.length && p.tags[0] !== p.name) ? " · " + p.tags.join(", ") : "";
      var label = (p.name || "") + tag;
      if (!label.trim()) label = "—";
      var lat = isFinite(+p.lat) ? (+p.lat).toFixed(5) : "";
      var lon = isFinite(+p.lon) ? (+p.lon).toFixed(5) : "";
      return '<div class="lists-sp-row"><span class="lists-sp-nm" title="' + escapeHtml(label) + '">' + escapeHtml(label) + "</span>" +
        '<span class="lists-pt-coord">' + escapeHtml(lat) + "</span><span class=\"lists-pt-coord\">" + escapeHtml(lon) + "</span>" +
        '<button type="button" class="lists-pt-edit ico-btn" data-coll="' + escapeHtml(collName) + '" data-id="' + escapeHtml(p.id || "") + '" title="' + escapeHtml(t("lists.editPoint")) + '" aria-label="' + escapeHtml(t("lists.editPoint")) + '">' + ico("edit") + "</button>" +
        '<button type="button" class="lists-pt-del" data-coll="' + escapeHtml(collName) + '" data-id="' + escapeHtml(p.id || "") + '" aria-label="' + escapeHtml(t("offline.delete")) + '" title="' + escapeHtml(t("offline.delete")) + '">×</button></div>';
    }).join("") + "</div>";
  }
  // Edit one saved point in place (name / tag / note) — works for general lists
  // and detection-saved lists alike. Writes straight back to the collection.
  function openListPointEditor(collName, id) {
    var c = mpCollections.filter(function (x) { return x.name === collName; })[0]; if (!c) return;
    var p = (c.points || []).filter(function (x) { return x.id === id; })[0]; if (!p) return;
    var esc = escapeHtml;
    var ov = document.createElement("div");
    ov.id = "lp-edit-modal"; ov.className = "kml-modal";
    ov.innerHTML = '<div class="kml-modal-box">' +
      '<button type="button" id="lp-close" class="kml-close" aria-label="Close">×</button>' +
      "<h3>" + esc(t("lists.editPoint")) + "</h3>" +
      '<label class="kml-row">' + esc(t("points.name")) + '<input type="text" id="lp-name" value="' + esc(p.name || "") + '" /></label>' +
      '<label class="kml-row">' + esc(t("points.tags")) + '<input type="text" id="lp-tags" value="' + esc((p.tags || []).join(", ")) + '" placeholder="' + esc(t("points.tagsPh")) + '" /></label>' +
      '<div class="kml-row">' + mpColorRow(p) + "</div>" +
      '<div class="kml-row lp-coord-row"><label>Lat<input type="number" step="any" id="lp-lat" value="' + esc(isFinite(+p.lat) ? +p.lat : "") + '" /></label>' +
        '<label>Lon<input type="number" step="any" id="lp-lon" value="' + esc(isFinite(+p.lon) ? +p.lon : "") + '" /></label></div>' +
      '<label class="kml-row kml-row-col">' + esc(t("points.note")) + '<textarea id="lp-note" rows="3">' + esc(p.note || "") + "</textarea></label>" +
      '<label class="kml-row kml-check"><input type="checkbox" id="lp-note-html"' + (p.noteHtml ? " checked" : "") + " />" + esc(t("points.noteHtml")) + "</label>" +
      '<div class="kml-actions"><button type="button" id="lp-save" class="demo-btn">' + esc(t("points.save")) + "</button></div>" +
      "</div>";
    document.body.appendChild(ov);
    wireMpColorRow();
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    document.getElementById("lp-close").addEventListener("click", close);
    document.getElementById("lp-save").addEventListener("click", function () {
      p.name = (document.getElementById("lp-name").value || "").trim();
      p.tags = mpParseTags(document.getElementById("lp-tags").value);
      p.note = (document.getElementById("lp-note").value || "").trim();
      if (document.getElementById("lp-note-html").checked) p.noteHtml = true; else delete p.noteHtml;
      p.color = mpReadColor();
      // Coordinates are editable too — only adopt valid, in-range numbers.
      var la = parseFloat(document.getElementById("lp-lat").value), lo = parseFloat(document.getElementById("lp-lon").value);
      if (isFinite(la) && la >= -90 && la <= 90) p.lat = la;
      if (isFinite(lo) && lo >= -180 && lo <= 180) p.lon = lo;
      saveMapPoints(); renderMapPoints(); close(); renderListsModal();
    });
  }
  // Move a species from one list to another (edit, not delete): drop it from the
  // source list and add it to the target ("life" or a year).
  function listsMoveSpecies(fromId, key, toId) {
    if (!key || !toId || toId === fromId) return;
    if (fromId === "life") delete lifeList[key]; else if (yearLists[fromId]) delete yearLists[fromId][key];
    if (toId === "life") lifeList[key] = true;
    else { if (!yearLists[toId]) yearLists[toId] = {}; yearLists[toId][key] = true; lifeList[key] = true; }   // onto a year list → also a lifer
    persistLists(); rebuildDetLayers(); updateDetLegend(); renderListsModal();
  }
  // Settings → Year & life lists: the life list + each year's list. Each row
  // expands to show (and individually remove) the species it contains, and
  // carries a × to clear the whole list.
  function renderListsModal() {
    var el = document.getElementById("lists-list"); if (!el) return;
    var rows = [];
    function section(id, label, keys, delHtml) {
      var n = keys.length, open = !!listsExpanded[id] && n > 0;
      rows.push('<tr class="lists-row"><td class="dset-name">' +
        '<button type="button" class="lists-toggle" data-id="' + escapeHtml(id) + '"' + (n ? "" : " disabled") + '>' +
          '<span class="lists-caret">' + (n ? (open ? "▾" : "▸") : "·") + "</span>" +
          '<span class="lists-lbl">' + escapeHtml(label) + "</span>" +
          '<span class="dset-count">' + escapeHtml(t("lists.count", { n: n })) + "</span></button></td>" +
        '<td class="dset-actions">' + delHtml + "</td></tr>");
      if (open) rows.push('<tr class="lists-body-row"><td colspan="2">' + listSpeciesRows(id, keys) + "</td></tr>");
    }
    var lifeKeys = Object.keys(lifeList);
    section("life", t("lists.life"), lifeKeys, lifeKeys.length ? '<button type="button" class="src-del lists-clear-life" aria-label="' + escapeHtml(t("points.clear")) + '">×</button>' : "");
    Object.keys(yearLists).sort(function (a, b) { return b.localeCompare(a); }).forEach(function (y) {
      section(y, t("lists.year", { year: y }), Object.keys(yearLists[y]),
        '<button type="button" class="src-del lists-del-year" data-year="' + escapeHtml(y) + '" aria-label="' + escapeHtml(t("offline.delete")) + '">×</button>');
    });
    // Map-point lists (general right-click lists AND detection-saved observation
    // lists). Each expands to a per-point table where individual points can be
    // edited (name / tag / note) or removed; plus a "protect" toggle that, when
    // on, disables the whole-list delete ×.
    if (mpCollections.length) {
      rows.push('<tr class="lists-subhead"><td colspan="2">' + escapeHtml(t("lists.mapPoints")) + "</td></tr>");
      mpCollections.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (c) {
        var prot = isCollProtected(c.name), n = (c.points && c.points.length) || 0;
        var cid = "coll:" + c.name, open = !!listsExpanded[cid] && n > 0;
        rows.push('<tr class="lists-row"><td class="dset-name">' +
          '<button type="button" class="lists-toggle" data-id="' + escapeHtml(cid) + '"' + (n ? "" : " disabled") + ">" +
            '<span class="lists-caret">' + (n ? (open ? "▾" : "▸") : "·") + "</span>" +
            '<span class="lists-lbl lists-lbl-plain">' + escapeHtml(c.name) + "</span>" +
            '<span class="dset-count lists-count-points">' + escapeHtml(t("lists.countPoints", { n: n })) + "</span></button></td>" +
          '<td class="dset-actions">' +
            '<label class="lists-protect' + (prot ? " on" : "") + '" title="' + escapeHtml(t("lists.protect")) + '"><input type="checkbox" class="lists-protect-cb" data-name="' + escapeHtml(c.name) + '"' + (prot ? " checked" : "") + " />" + ico(prot ? "lock" : "lockopen") + "</label>" +
            '<button type="button" class="src-del lists-del-coll" data-name="' + escapeHtml(c.name) + '"' + (prot ? " disabled" : "") + ' aria-label="' + escapeHtml(t("offline.delete")) + '">×</button>' +
          "</td></tr>");
        if (open) rows.push('<tr class="lists-body-row"><td colspan="2">' + listPointRows(c.name) + "</td></tr>");
      });
    }
    el.innerHTML = '<table class="src-tbl"><tbody>' + rows.join("") + "</tbody></table>";
    el.querySelectorAll(".lists-protect-cb").forEach(function (cb) {
      cb.addEventListener("change", function () { setCollProtected(this.getAttribute("data-name"), this.checked); renderListsModal(); });
    });
    el.querySelectorAll(".lists-del-coll").forEach(function (b) {
      b.addEventListener("click", function () {
        var name = this.getAttribute("data-name");
        if (isCollProtected(name)) return;
        modalConfirm(t("points.deleteCollPrompt", { name: name })).then(function (ok) {
          if (!ok) return;
          delete shownColls[name]; deleteCollection(name); saveShownState(); renderListsModal();
        });
      });
    });
    el.querySelectorAll(".lists-toggle").forEach(function (b) {
      b.addEventListener("click", function () { var id = this.getAttribute("data-id"); listsExpanded[id] = !listsExpanded[id]; renderListsModal(); });
    });
    el.querySelectorAll(".lists-sp-del").forEach(function (b) {
      b.addEventListener("click", function () { listsRemoveSpecies(this.getAttribute("data-id"), this.getAttribute("data-key")); });
    });
    el.querySelectorAll(".lists-pt-edit").forEach(function (b) {
      b.addEventListener("click", function () { openListPointEditor(this.getAttribute("data-coll"), this.getAttribute("data-id")); });
    });
    el.querySelectorAll(".lists-pt-del").forEach(function (b) {
      b.addEventListener("click", function () { removeListPoint(this.getAttribute("data-coll"), this.getAttribute("data-id")); renderListsModal(); });
    });
    el.querySelectorAll(".lists-sp-move").forEach(function (s) {
      s.addEventListener("change", function () { listsMoveSpecies(this.getAttribute("data-id"), this.getAttribute("data-key"), this.value); });
    });
    var cl = el.querySelector(".lists-clear-life");
    if (cl) cl.addEventListener("click", function () {
      modalConfirm(t("lists.clearLifePrompt")).then(function (ok) { if (ok) { lifeList = {}; persistLists(); rebuildDetLayers(); updateDetLegend(); renderListsModal(); } });
    });
    el.querySelectorAll(".lists-del-year").forEach(function (b) {
      b.addEventListener("click", function () {
        var y = this.getAttribute("data-year");
        modalConfirm(t("lists.deleteYearPrompt", { year: y })).then(function (ok) { if (ok) { delete yearLists[y]; delete listsExpanded[y]; persistLists(); rebuildDetLayers(); updateDetLegend(); renderListsModal(); } });
      });
    });
  }
  function renderGbifTable() {
    var el = document.getElementById("gbif-table"); if (!el) return;
    var body = gbifDatasets().map(function (d) {
      var url = d.url || ("https://www.gbif.org/dataset/" + d.key);   // source homepage, else GBIF page
      // Country (ISO-2): the dataset is only queried in that country; 🌍 = global.
      var dcc = d.country || GBIF_DS_COUNTRY[d.key] || "";
      var ccCell = dcc
        ? '<span class="gbif-cc" title="' + escapeHtml(t("gbif.onlyIn", { cc: dcc })) + '">' + escapeHtml(dcc) + "</span>"
        : '<span class="gbif-cc gbif-cc-global" title="' + escapeHtml(t("gbif.global")) + '">🌍</span>';
      return "<tr>" +
        '<td class="src-on-cell"><input type="checkbox" class="gbif-on" data-key="' + escapeHtml(d.key) + '"' + (isGbifOff(d.key) ? "" : " checked") + ' aria-label="' + escapeHtml(t("sources.colOn")) + '" /></td>' +
        "<td>" + ccCell + "</td>" +
        '<td class="gbif-key">' + escapeHtml(d.key) + "</td>" +
        '<td class="gbif-url"><a href="' + escapeHtml(safeHref(url)) + '" target="_blank" rel="noopener" title="' + escapeHtml(d.name || "") + '">' + escapeHtml(url) + "</a></td>" +
        '<td><button type="button" class="gbif-del" data-key="' + escapeHtml(d.key) + '" aria-label="remove">×</button></td></tr>';
    }).join("");
    el.innerHTML = '<table class="gbif-tbl"><thead><tr><th class="src-on-th">' + escapeHtml(t("sources.colOn")) + "</th><th>" + escapeHtml(t("gbif.colCountry")) + "</th><th>" + escapeHtml(t("gbif.colKey")) + "</th><th>" + escapeHtml(t("gbif.colUrl")) + "</th><th></th></tr></thead><tbody>" +
      (body || '<tr><td colspan="5" class="cu-hint">' + escapeHtml(t("gbif.empty")) + "</td></tr>") + "</tbody></table>";
    el.querySelectorAll(".gbif-on").forEach(function (cb) {
      cb.addEventListener("change", function () { setGbifOff(this.getAttribute("data-key"), !this.checked); });
    });
    el.querySelectorAll(".gbif-del").forEach(function (b) {
      b.addEventListener("click", function () { removeGbifDataset(this.getAttribute("data-key")); });
    });
  }
  function removeGbifDataset(key) {
    window.GeoState.save({ gbifDatasets: gbifDatasets().filter(function (d) { return d.key !== key; }) });
    // Remember removed defaults so they aren't re-merged by gbifDatasets().
    if (DEFAULT_GBIF_DATASETS.some(function (d) { return d.key === key; })) {
      var rem = window.GeoState.get("gbifRemoved", []) || [];
      if (rem.indexOf(key) < 0) { rem.push(key); window.GeoState.save({ gbifRemoved: rem }); }
    }
    allSightingsCache = {};
    renderGbifTable();
  }
  // Accept a bare dataset key or a gbif.org/dataset/<key> URL; pull the name from
  // GBIF in the background and refresh.
  // Add a GBIF dataset by hand: a key (or gbif.org/dataset/… URL), an optional
  // country (ISO-2 → only queried there; blank → everywhere), and an optional
  // homepage URL. Returns true on success. Name/homepage are filled from GBIF.
  function addGbifDataset(text, cc, url) {
    var m = String(text || "").match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
    if (!m) { setStatus(t("gbif.badKey")); return false; }
    var key = m[1], country = String(cc || "").trim().toUpperCase().slice(0, 2), homepage = linkUrl(url);   // http(s)-only
    var list = gbifDatasets().slice();
    if (list.some(function (d) { return d.key === key; })) { setStatus(t("gbif.dupe")); return false; }
    // Re-adding a previously-removed default: clear it from the removed list.
    var rem = window.GeoState.get("gbifRemoved", []) || []; var ri = rem.indexOf(key);
    if (ri >= 0) { rem.splice(ri, 1); window.GeoState.save({ gbifRemoved: rem }); }
    list.push({ key: key, name: homepage || "", url: homepage, country: country });
    window.GeoState.save({ gbifDatasets: list }); allSightingsCache = {};
    renderGbifTable();
    // Fill in the title / homepage from GBIF (don't overwrite a URL the user gave).
    fetch("https://api.gbif.org/v1/dataset/" + key).then(function (r) { return r.json(); }).then(function (dj) {
      if (!dj) return;
      var l2 = gbifDatasets().slice(), d = l2.filter(function (x) { return x.key === key; })[0];
      if (d) { d.name = dj.title || d.name; if (!d.url && dj.homepage) d.url = dj.homepage; window.GeoState.save({ gbifDatasets: l2 }); renderGbifTable(); }
    }).catch(function () {});
    return true;
  }
  // GBIF helpers + per-source HTTP fetch adapters moved to the AppFetch
  // module (docs/fetch.js); app.js keeps the orchestration that calls them.
  // normLaji moved to the AppNormalize module (docs/normalize.js).
  // Map a flat list of normalised records to model species (agg) + everything the
  // model doesn't cover (extras), harvesting families for colouring along the way.
  // aggregateRecords moved to the AppAggregate module (docs/aggregate.js).
  // Run a source fetch; on failure record the source name (so the caller can
  // warn that results may be incomplete) and resolve to an empty list instead.
  function guardFetch(failed, name, promise) {
    return Promise.resolve(promise).then(function (r) { return r; }, function (e) {
      failed.push({ name: name, error: (e && e.message) ? e.message : String(e || "error") });
      return [];
    });
  }
  // Reasons collected during a fetch are objects {name, error}; the status line
  // and recent-warn want a plain "name, name" list.
  function failedNames(failed) { return (failed || []).map(function (f) { return f && f.name ? f.name : f; }).join(", "); }
  // Split failed sources into those that failed because their (required) API key is
  // MISSING vs genuine other failures — so a missing key gets its own clear status
  // ("needs a free API key") instead of the generic "didn't respond".
  function splitFailed(failed) {
    var byName = Object.create(null);
    directSources().forEach(function (s) { byName[s.name] = { id: s.id, keyed: !!(DIRECT_BY_ID[s.id] || {}).keyed }; });
    var needKey = [], other = [];
    (failed || []).filter(Boolean).forEach(function (f) {
      var nm = f.name || f, info = byName[nm];
      if (info && info.keyed && !directKey(info.id)) needKey.push(nm); else other.push(f);
    });
    return { needKey: needKey, other: other };
  }
  // After a fetch, pop a single dialog listing each source that failed and why.
  // De-duped against the immediately-previous set so the same error (e.g. a
  // missing eBird key) doesn't nag on every location click.
  var lastFetchErrSig = "";
  function reportFetchErrors(failed) {
    var arr = (failed || []).filter(Boolean);
    if (!arr.length) { lastFetchErrSig = ""; return; }
    var sig = arr.map(function (f) { return f.name + ":" + f.error; }).sort().join("|");
    if (sig === lastFetchErrSig) return;
    lastFetchErrSig = sig;
    modalAlert(t("fetch.errTitle"), arr.map(function (f) { return f.name + " — " + (f.error || t("fetch.errUnknown")); }));
  }
  // The observation sources, behind one interface. `country` (ISO-2) gates a
  // source to its own country — the national databases are only queried when the
  // point is inside that country; the global sources always run (if enabled).
  // The non-GBIF "direct" sources are user-manageable (Settings → Data sources):
  // Name / key / endpoint, editable and deletable. GBIF is excluded (it has its
  // own datasets manager). `country` gates national databases to their own
  // country; `keyed` says which need an API key (stored in their own slot).
  // `days` = how far back each source is queried (eBird is API-capped at 30).
  // Country borders + gating (nearCountry, BORDERS, loadBorders, countryAt,
  // nearbyCountries, countryMatch) moved to the AppGeo module (docs/geo.js).
  // One-time cleanup: the earlier auto-discovery over-collected GBIF datasets.
  // Reset the stored list back to the curated defaults (datasets are now added by
  // hand only). Runs once, so user-added datasets afterwards are kept.
  (function resetAutoGbif() {
    try {
      if (!window.GeoState.get("gbifAutoReset", false)) {
        window.GeoState.save({ gbifDatasets: null, gbifLearnedScopes: null, gbifAutoReset: true });
      }
    } catch (e) {}
  })();
  // (point-in-ring + countryAt/nearbyCountries/countryMatch are in AppGeo now.)
  // Key guardrail: a lightweight probe that says whether a keyed source's API key
  // actually works (a wrong/expired eBird token returns 401/403). Resolves to
  // true (valid), false (rejected), or null (nothing to test / no probe for it).
  function testSourceKey(id, key) {
    key = (key || "").trim();
    if (!key) return Promise.resolve(null);
    if (id === "ebird") {
      return fetch("https://api.ebird.org/v2/data/obs/geo/recent?lat=42.30&lng=-71.10&dist=1&back=1&maxResults=1",
        { headers: { "X-eBirdApiToken": key } }).then(function (r) { return r.ok; }, function () { return false; });
    }
    if (id === "artportalen") {
      return fetch("https://api.artdatabanken.se/species-observation-system/v1/Observations/Search?skip=0&take=1",
        { method: "POST", headers: { "Content-Type": "application/json", "Ocp-Apim-Subscription-Key": key }, body: JSON.stringify({ output: { fieldSet: "Minimum" } }) })
        .then(function (r) { return r.ok; }, function () { return false; });
    }
    if (id === "laji") {
      return fetch("https://api.laji.fi/v0/warehouse/query/unit/count?wgs84CenterPoint=60.1:60.2:24.9:25.0:WGS84&access_token=" + encodeURIComponent(key))
        .then(function (r) { return r.ok; }, function () { return false; });
    }
    return Promise.resolve(null);   // keyed source with no known probe
  }
  function runDirectSource(s, c) {
    var days = (+s.days > 0) ? +s.days : 90;
    var d1 = c.dateBack(days);   // start date = today − days (per source)
    var sig = c.signal;          // per-source abort signal (fetch timeout)
    if (s.id === "ebird") return AppFetch.fetchEbirdAll(c.lat, c.lon, c.tok, c.rkm, s.url, Math.min(30, days), sig).then(AppNormalize.normEbird);
    if (s.id === "inat") return AppFetch.fetchInatAll(c.lat, c.lon, d1, c.d2, c.rkm, s.url, sig).then(AppNormalize.normInat);
    if (s.id === "artsobs") return AppFetch.fetchArtsobsAll(c.lat, c.lon, d1, c.d2, c.rkm, s.url, sig).then(AppNormalize.normArtsobs);
    if (s.id === "artportalen") return AppFetch.fetchArtportalenAll(c.lat, c.lon, d1, c.d2, c.rkm, artKey(), s.url, sig).then(AppNormalize.normArtportalen);
    if (s.id === "laji") return AppFetch.fetchLajiAll(c.lat, c.lon, d1, c.d2, c.rkm, directKey("laji"), s.url, sig).then(AppNormalize.normLaji);
    if (s.id === "birdweather") return AppFetch.fetchBirdweatherAll(c.lat, c.lon, d1, c.d2, c.rkm, s.url, sig).then(function (n) { return AppNormalize.normBirdweather(n, bwMinDet(), bwMinConf()); });
    return Promise.resolve([]);
  }
  function obsSources() {
    var list = [
      { name: "GBIF", country: null, enabled: function () { return !isSourceOff("gbif"); }, run: function (c) { return AppFetch.fetchGbifAll(c.lat, c.lon, c.dateBack(gbifDays()) + "," + c.d2, c.rkm, c.cc, c.signal, null, null, function (done, total) { obsSub["GBIF"] = { done: done, total: total }; obsRender(); }).then(AppNormalize.normGbif); } }
    ];
    directSources().forEach(function (s) {
      // eBird and BirdWeather are bird-only feeds (eBird is birds-only; BirdWeather
      // is BirdNET acoustic). Query them only for the Birds / All groups — for
      // mammals/amphibians/insects they'd return only birds we'd discard.
      if ((s.id === "ebird" || s.id === "birdweather") && !groupIsBirds()) return;
      // Enabled = just the on/off toggle. A keyed source with no key still runs
      // (and shows in the loading line), then fails — surfaced as a clear "API key
      // missing" line in the status strip (see splitFailed), not the failure popup.
      list.push({ name: s.name, country: s.country, enabled: function () { return !isSourceOff(s.id); }, run: function (c) { return runDirectSource(s, c); } });
    });
    return list;
  }
  // Cached fetch of every species' recent detections at a point (last 3 months;
  // eBird is still capped at its 30-day API limit). The resolved object carries
  // `failed` — the source names that errored.
  // ---- Persistent sightings cache -------------------------------------------
  // Re-opening the app used to re-run the last location's observation fetch every
  // time. We now keep the most-recent location fetches (IndexedDB, a structured
  // clone of the aggregated result) so a reopen — or re-clicking a place visited
  // in an earlier session — REUSES the already-downloaded detections instead of
  // hitting the network, as long as the source config is unchanged and the copy
  // is still fresh (within the Settings "reuse" window; default 30 min, 0 = never
  // expire). A NEW location, a changed radius/group, or a changed source config
  // still fetches. (Also helps offline: a cached location opens with no network.)
  // How long a downloaded location stays reusable before a reopen refetches it.
  // User-set in Settings (minutes); default 30 min. 0 = always reuse (never expire).
  function sightTtlMin() { var v = +window.GeoState.get("sightTtlMin", 30); return isFinite(v) && v >= 0 ? v : 30; }
  function sightTtlMs() { return sightTtlMin() * 60000; }
  // Bump when the aggregation/matching logic changes so results cached by the
  // previous code are ignored and the next fetch re-aggregates.
  var SIGHT_CACHE_VER = 2;
  var persistedSightings = {};           // ck -> { ts, sig, ver, out }, loaded once at boot
  function sightCK(lat, lon, rkm, group) { return lat.toFixed(2) + "," + lon.toFixed(2) + ":" + rkm + ":" + group; }
  // Signature of the settings that change what a fetch returns; a mismatch means a
  // cached copy is stale for the current config and must not be reused.
  function sightConfigSig() {
    try {
      var srcs = obsSources().filter(function (s) { return s.enabled(); }).map(function (s) { return s.name; }).sort().join(",");
      return srcs + "|bw" + window.GeoState.get("bwMinDet", 2) + "," + window.GeoState.get("bwMinConf", 0) + "|ds" + ((gbifDatasets || []).length);
    } catch (e) { return ""; }
  }
  function loadPersistedSightings() {
    if (!window.AppIDB) return Promise.resolve();
    return AppIDB.get("sightingsCache").then(function (m) { if (m && typeof m === "object") persistedSightings = m; }).catch(function () {});
  }
  function persistSightings(ck, out) {
    if (!window.AppIDB) return;
    try {
      persistedSightings[ck] = { ts: Date.now(), sig: sightConfigSig(), ver: SIGHT_CACHE_VER, out: out };
      var keys = Object.keys(persistedSightings);
      if (keys.length > 6) {   // keep the 6 most-recently fetched locations
        keys.sort(function (a, b) { return (persistedSightings[b].ts || 0) - (persistedSightings[a].ts || 0); });
        keys.slice(6).forEach(function (k) { delete persistedSightings[k]; });
      }
      AppIDB.put("sightingsCache", persistedSightings).catch(function () {});
    } catch (e) {}
  }
  // onPartial (optional) is called after EACH source resolves with a cumulative
  // aggregation of everything in so far ({agg, extras, bySrc, failed, timedOut,
  // partial:true}) — so the species list can fill in progressively and "pin to
  // map" can plot what has arrived. Only wired on a fresh fetch; a cache hit is
  // already complete. The final promise still resolves with the full result.
  function fetchAllSightingsAt(lat, lon, onPartial, radiusOverride) {
    var rkm = (radiusOverride > 0) ? radiusOverride : recentRadiusKm();
    var fetchGroup = speciesGroup;   // group at fetch-start — aggregate/plot use THIS, not a value the user may switch mid-fetch
    var ck = sightCK(lat, lon, rkm, fetchGroup);   // group-keyed: switching group refetches that class set
    if (allSightingsCache[ck]) return allSightingsCache[ck];
    // Reuse a previously-downloaded result for this exact location (same radius,
    // group + source config) that is still fresh — no network, no refetch on reopen.
    var pf = persistedSightings[ck], ttl = sightTtlMs();
    if (pf && pf.out && pf.ver === SIGHT_CACHE_VER && pf.sig === sightConfigSig() && (ttl === 0 || (Date.now() - (pf.ts || 0)) < ttl)) {
      var cachedPr = Promise.resolve(pf.out);
      allSightingsCache[ck] = cachedPr;
      return cachedPr;
    }
    var fmtD = function (d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); };
    var d2 = fmtD(new Date());   // today; each source's start is today − its own "days" (c.dateBack)
    var failed = [], timedOut = [];
    // Resolve the point's country once (cached reverse-geocode) and gate
    // country-specific sources + GBIF datasets by it — accurate worldwide, with
    // the bounding boxes kept as the border/offline fallback (see countryMatch).
    var pr = AppGeo.countryCode(lat, lon).catch(function () { return ""; }).then(function (cc) {
      var c = { lat: lat, lon: lon, d2: d2, rkm: rkm, cc: cc, tok: ebirdKey(),
        dateBack: function (n) { var d = new Date(); d.setDate(d.getDate() - n); return fmtD(d); } };
      obsNewBatch();   // this fetch's sources own the loading line (supersede any older in-flight batch)
      // Records + per-source counts accumulate as sources resolve; emitPartial()
      // re-aggregates the running set and hands it to onPartial for live rendering.
      var records = [], bySrc = {};
      function emitPartial() {
        if (typeof onPartial !== "function") return;
        try {
          var p = AppAggregate.aggregateRecords(records, fetchGroup);
          p.bySrc = {}; for (var k in bySrc) p.bySrc[k] = bySrc[k];
          p.failed = failed.slice(); p.timedOut = timedOut.slice(); p.partial = true; p.group = fetchGroup;
          onPartial(p);
        } catch (e) { /* a partial render must never break the fetch */ }
      }
      var jobs = obsSources().map(function (s) {
        // A source is skipped only when it's disabled (no key) or country-gated
        // out. A QUERIED source that returns nothing still appears in bySrc as 0,
        // so "eBird 0" (queried, no data) is distinct from eBird being absent.
        if (!s.enabled() || (s.country && !AppGeo.countryMatch(lat, lon, s.country, rkm, cc))) return Promise.resolve({ name: s.name, recs: [], queried: false });
        // Per-source timeout: abort the in-flight request after T s. The paged
        // fetchers break and return whatever they had → partial records survive;
        // a single-shot source aborts to empty. Either way the source's label is
        // flagged red (timedOut) rather than a hard error.
        var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
        var T = fetchTimeoutSec(), tmr = null, killed = false;
        if (ctrl && T > 0) tmr = setTimeout(function () { killed = true; try { ctrl.abort(); } catch (e) {} }, T * 1000);
        var cs = ctrl ? Object.assign({}, c, { signal: ctrl.signal }) : c;
        return guardFetch(failed, s.name, obsTrack(s.name, s.run(cs))).then(function (recs) {
          if (tmr) clearTimeout(tmr);
          if (killed) { timedOut.push(s.name); var fi = failed.indexOf(s.name); if (fi >= 0) failed.splice(fi, 1); }   // a timeout isn't a hard failure
          var rr = recs || [];
          bySrc[s.name] = (bySrc[s.name] || 0) + rr.length;   // queried (0 distinguishes "queried, none" from "not queried")
          if (rr.length) records = records.concat(rr);
          emitPartial();   // re-render the list with everything in so far
          return { name: s.name, recs: rr, queried: true };
        });
      });
      return Promise.all(jobs).then(function () {
        var out = AppAggregate.aggregateRecords(records, fetchGroup); out.failed = failed; out.bySrc = bySrc; out.timedOut = timedOut; out.group = fetchGroup;
        // out.dedupTotal (unique observations kept after de-dup + the bird filter)
        // is computed by aggregateRecords — surfaced in the per-source counts.
        return out;
      });
    });
    allSightingsCache[ck] = pr;   // discovery now runs inside the cc resolution above
    // Cache-eviction policy: a transient TOTAL failure must not become this
    // location's permanent answer, but a PARTIAL success has to stay cached —
    // otherwise reusing the same location ("pin to map", week change, etc.) would
    // re-fetch every time one source flaked or timed out. So evict only when the
    // pipeline rejected, or it returned NO usable data AND a source failed/timed
    // out (a fresh visit then retries). A clean empty result (no birds here, no
    // failures) stays cached too. Only ever evict our own entry (=== pr).
    pr.then(function (out) {
      var noData = !out || !(out.dedupTotal > 0);
      var anyFail = out && ((out.failed && out.failed.length) || (out.timedOut && out.timedOut.length));
      if (noData && anyFail && allSightingsCache[ck] === pr) delete allSightingsCache[ck];
      else if (out && out.dedupTotal > 0) persistSightings(ck, out);   // keep the download so a reopen doesn't refetch
    }, function () { if (allSightingsCache[ck] === pr) delete allSightingsCache[ck]; });
    return pr;
  }
  // Historic-observations counterpart of fetchAllSightingsAt: GBIF only, over a
  // custom date range, returning the SAME aggregated shape ({agg, extras, bySrc,
  // dedupTotal, failed, timedOut}) so the species list and the map-plot can reuse
  // it unchanged. Honors histAbort (the Fetch's per-search abort) and reports
  // GBIF page progress via onProg.
  function fetchHistoricSightingsAt(lat, lon, range, onProg) {
    var rkm = recentRadiusKm();
    var months = histMonthsParam();   // "" = all months, else "&month=5&month=6"
    var fetchGroup = speciesGroup;   // group at fetch-start (see fetchAllSightingsAt)
    var ck = lat.toFixed(2) + "," + lon.toFixed(2) + ":" + rkm + ":" + range + months + ":" + fetchGroup;   // group-keyed (class filter differs per group)
    if (histSightingsCache[ck]) return histSightingsCache[ck];
    var sig = histAbort ? histAbort.signal : null;
    var rp = String(range).split(","), from = rp[0], to = rp[1] || rp[0];
    var pr = AppGeo.countryCode(lat, lon).catch(function () { return ""; }).then(function (cc) {
      return AppFetch.fetchGbifHistoric(lat, lon, from, to, rkm, cc, sig, onProg, months).then(function (raw) {
        // Dedup across sub-ranges by GBIF key (a record with a date RANGE
        // spanning a split boundary could be returned by both halves).
        var seen = Object.create(null), uniq = [];
        (raw || []).forEach(function (o) { if (o && o.key != null) { if (seen[o.key]) return; seen[o.key] = 1; } uniq.push(o); });
        var recs = AppNormalize.normGbif(uniq);
        var out = AppAggregate.aggregateRecords(recs, fetchGroup);   // sets out.dedupTotal
        out.bySrc = { GBIF: recs.length }; out.group = fetchGroup;
        out.failed = []; out.timedOut = [];
        return out;
      });
    });
    histSightingsCache[ck] = pr;
    // As with fetchAllSightingsAt: keep a partial/clean result cached (so "pin to
    // map" reuses it), evict only a no-data failure or a hard rejection/abort so a
    // fresh request retries.
    pr.then(function (out) {
      var noData = !out || !(out.dedupTotal > 0);
      var anyFail = out && ((out.failed && out.failed.length) || (out.timedOut && out.timedOut.length));
      if (noData && anyFail && histSightingsCache[ck] === pr) delete histSightingsCache[ck];
    }, function () { if (histSightingsCache[ck] === pr) delete histSightingsCache[ck]; });
    return pr;
  }
  // While observations load, a single line (the species-page sp-loading line and,
  // when plotting, the map status line) lists EVERY source in the batch — pending
  // ones with a cycling highlight, finished ones marked ✓ with their record
  // count, all kept on screen. When the batch finishes the line settles into a
  // persistent "Loaded: eBird(n), GBIF(k)…" summary (left in place, not removed)
  // so the per-source counts stay readable. The per-row n(d) cells keep a
  // fixed-width CSS spinner so the table never reflows.
  // Each fetch's sources are tagged with a batch id, and the loading line shows
  // ONLY the current (latest) batch — so a fetch started before a previous one
  // finished (another click, a radius/source change, or a slow source) can't make
  // the line list a source twice with two different counts.
  var obsBatch = [];             // {name, done, count, bid} across any in-flight fetches
  var obsSub = Object.create(null);   // source name -> {done, total} sub-progress (GBIF datasets)
  var obsBid = 0;                // current batch id
  var obsTick = 0;               // cycles the highlight through the pending sources
  var obsTimer = null;           // interval advancing the highlight while anything loads
  var obsStatusActive = false;   // a map-plot is mirroring the line into the status bar
  function obsNewBatch() { obsBatch = obsBatch.filter(function (it) { return !it.done; }); obsSub = Object.create(null); obsBid++; }
  function obsCurrent() { var b = obsBid; return obsBatch.filter(function (it) { return it.bid === b; }); }
  function obsPendingCount() { var b = obsBid; var n = 0; obsBatch.forEach(function (it) { if (it.bid === b && !it.done) n++; }); return n; }
  function obsTrack(name, p) {
    var item = { name: name, done: false, count: 0, bid: obsBid };
    obsBatch.push(item);
    obsProgress();
    function settle(v) { item.done = true; item.count = (v && v.length) || 0; delete obsSub[name]; obsProgress(); }
    return Promise.resolve(p).then(function (v) { settle(v); return v; },
                                   function (e) { settle(null); throw e; });
  }
  function obsLine(html) {
    var ld = document.getElementById("sp-loading");
    if (ld) { ld.innerHTML = html; ld.style.display = ""; }
    if (obsStatusActive) setStatusHtml(html);
  }
  function obsProgress() {
    updateSpMapBtn();               // grey out "📍 Map" while any source query is still loading
    if (obsPendingCount() === 0) {  // current batch done → settle into the persistent summary
      if (obsTimer) { clearInterval(obsTimer); obsTimer = null; }
      obsRenderDone();
      return;
    }
    if (!obsTimer) obsTimer = setInterval(function () { obsTick++; obsRender(); }, 700);
    obsRender();
  }
  function obsRender() {
    var cur = obsCurrent(); if (!cur.length) return;
    var pending = cur.filter(function (it) { return !it.done; });
    var hiName = pending.length ? pending[obsTick % pending.length].name : "";
    var parts = cur.map(function (it) {
      var nm = escapeHtml(it.name);
      if (it.done) return '<span class="obs-done">' + nm + " ✓ (" + it.count + ")</span>";
      var sub = obsSub[it.name];   // e.g. GBIF[2/3] — datasets completed / total
      if (sub && sub.total) nm += "[" + sub.done + "/" + sub.total + "]";
      return it.name === hiName ? '<span class="obs-knk">' + nm + "</span>" : '<span class="obs-pend">' + nm + "</span>";
    });
    obsLine(t("sp.plottingFrac", { n: parts.join('<span class="obs-sep"> · </span>') }));
  }
  // Final, persistent line once the batch is done: "Loaded: name(n), name(m)…".
  function obsRenderDone() {
    var cur = obsCurrent(); if (!cur.length) return;   // nothing queried this batch — leave the line as-is
    var parts = cur.map(function (it) { return escapeHtml(it.name) + " (" + it.count + ")"; });
    obsLine(t("sp.loaded", { n: parts.join(", ") }));
  }
  // The species-page loading line, set straight from a fetch's per-source counts
  // (works for a cached fetch too, where obsTrack never ran). Persistent.
  function showSourceCounts(bySrc, dedupTotal, timedOut) {
    var keys = Object.keys(bySrc || {}); if (!keys.length) return;
    var toSet = Object.create(null); (timedOut || []).forEach(function (n) { toSet[n] = 1; });
    var html = t("sp.loaded", { n: keys.map(function (k) {
      var label = escapeHtml(k) + " (" + bySrc[k] + ")";
      return toSet[k] ? '<span class="src-timeout" title="' + escapeHtml(t("sources.timedOut")) + '">' + label + "</span>" : label;   // timed out → red, partial
    }).join(", ") });
    if (dedupTotal != null) html += " · " + escapeHtml(t("sp.deduped", { n: dedupTotal }));   // unique kept after de-dup
    var ld = document.getElementById("sp-loading");
    if (ld) { ld.innerHTML = html; ld.style.display = ""; }
  }
  function hideSourceCounts() { var ld = document.getElementById("sp-loading"); if (ld) ld.style.display = "none"; }
  // The Species-at-location "📍 Map" button plots the observation fetch. It's
  // enabled as soon as ANY data has arrived (partial or complete) so the user can
  // pin what's come in without waiting for every source to finish.
  function updateSpMapBtn() {
    var b = document.getElementById("sp-map-btn"); if (!b) return;
    var r = currentSpView && currentSpView._result;
    b.disabled = !(r && (r.dedupTotal > 0 || (r.agg && Object.keys(r.agg).length) || (r.extras && Object.keys(r.extras).length)));
  }
  // Populate the per-point species-list rows with count + days-since-most-recent
  // from the cached all-species fetch. Cells stay blank for species without any
  // detection in the last 3 months; counts >0 become clickable.
  // Render one (partial or final) fetch result into the species-list rows. On a
  // PARTIAL update we only fill rows that have data (leaving the hourglass on the
  // rest, since more is still coming); on the FINAL pass we also clear empty rows,
  // show the per-source "Loaded:" counts, and stash the result so "pin to map" can
  // plot whatever has arrived without re-fetching.
  function applySightings(tbody, token, result, isFinal) {
    if (!tbody || tbody.dataset.sightingsToken !== token) return;
    if (isFinal) showSourceCounts(result.bySrc, result.dedupTotal, result.timedOut);
    var agg = result.agg, extras = result.extras;
    tbody._sightingsAgg = agg;
    if (currentSpView) currentSpView._result = result;   // latest data for plotAllSightings (partial or final)
    updateSpMapBtn();
    var now = Date.now();
    tbody.querySelectorAll(".det-nd").forEach(function (td) {
      var key = td.getAttribute("data-key"); if (!key) return;   // skip extras rows
      var entry = agg[key];
      if (!entry || !entry.count) { if (isFinal) td.textContent = ""; return; }   // partial: leave the hourglass for not-yet-arrived data
      var days = entry.latestTs ? Math.max(0, Math.round((now - entry.latestTs) / 86400000)) : null;
      td.innerHTML = '<button type="button" class="det-count-btn" data-key="' + escapeHtml(key) + '">' + entry.count + "</button>" +
        (days != null ? '<span class="det-d">(' + days + ")</span>" : "");
    });
    prependExtraSightings(tbody, extras);
    // Re-apply the active age filter and sort as data arrives.
    applyAgeFilter();
    if (speciesListSort.col) sortSpeciesList();
  }
  function augmentRowsWithSightings(lat, lon, histRange, onProg) {
    var token = lat.toFixed(4) + "," + lon.toFixed(4) + (histRange ? ":" + histRange : "");
    var tbody = document.getElementById("sp-tbody");
    if (tbody) tbody.dataset.sightingsToken = token;   // supersede if another click arrives
    hideSourceCounts();   // clear any prior location's "Loaded: …" line before this fetch
    var onPartial = function (partial) { applySightings(tbody, token, partial, false); };   // live-fill rows as each source returns
    var fetchP = histRange ? fetchHistoricSightingsAt(lat, lon, histRange, onProg) : fetchAllSightingsAt(lat, lon, onPartial);
    return fetchP.then(function (result) {
      applySightings(tbody, token, result, true);
      if (!tbody || tbody.dataset.sightingsToken !== token) return;
      var sp = splitFailed(result.failed);
      // Missing-key sources get the actionable "needs a free API key" line; only
      // otherwise fall back to the generic "didn't respond".
      if (sp.needKey.length) setStatus(t("fetch.needKey", { sources: sp.needKey.join(", ") }));
      else if (sp.other.length) setStatus(t("fetch.failed", { sources: failedNames(sp.other) }));
      reportFetchErrors(sp.other);   // missing keys are shown in the status strip, not a popup
    }).catch(function () {
      // Hard failure — clear the hourglasses so they don't spin forever.
      if (tbody && tbody.dataset.sightingsToken === token) {
        tbody.querySelectorAll(".det-nd .det-wait").forEach(function (s) { if (s.parentNode) s.parentNode.textContent = ""; });
      }
    });
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
    var now = Date.now();
    keys.forEach(function (k) {
      var e = extras[k], name = e.name || e.sci;
      var days = e.latestTs ? Math.max(0, Math.round((now - e.latestTs) / 86400000)) : null;
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

  // (eBird/Artdatabanken key storage moved to the AppSources module.)

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
    // Flush the live map first so EVERY push includes the dots/stars and pins
    // currently on screen — even on the first sync (no remote file yet), where
    // applyRemote (which also flushes) never runs. This is what lets plotted
    // detections sync directly, without saving them as a named set first.
    try { if (typeof detPlot !== "undefined" && Object.keys(detPlot).length) saveDetections(); } catch (e) {}
    try { if (typeof saveMapPoints === "function") saveMapPoints(); } catch (e) {}
    var state = {};
    try { state = JSON.parse(localStorage.getItem("geomodel-explorer-v1") || "{}"); } catch (e) {}
    // Belt-and-braces: take the plotted detections straight from memory too, so a
    // large on-screen set still syncs even if the localStorage write above was
    // rejected (e.g. quota) and the round-tripped copy is stale/missing.
    try { if (typeof detPlot !== "undefined" && Object.keys(detPlot).length) state.mapDetections = capDetections(serializeDetPlot(), DET_CAP); } catch (e) {}
    // Saved trips now live in IndexedDB (mirrored in detSetStore), not the blob —
    // re-attach them so the Drive payload shape is unchanged.
    try { if (typeof detSetStore !== "undefined") state.mapDetectionSets = detSetStore.filter(function (s) { return s && s.name; }); } catch (e) {}
    return {
      app: "migration_calendar",
      version: 1,
      exportedAt: new Date().toISOString(),
      state: state,
      ebirdKey: localStorage.getItem(EBIRD_KEY_LS) || "",
      artdbKey: localStorage.getItem(ART_KEY_LS) || ""
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
  // Total observation rows across a mapDetections object (used to tell whether a
  // sync actually brought in new dots, so we only re-fit the map when it did).
  function detRowCount(m) { var n = 0; Object.keys(m || {}).forEach(function (k) { n += ((m[k] || {}).rows || []).length; }); return n; }
  var DET_CAP = 15000;   // max stored/synced detection rows — keep the newest, drop the oldest
  // Cap a mapDetections object to the newest `max` observation rows, dropping the
  // OLDEST first (by date). Lists / year-life lists / checklists / points are
  // small and are never capped — only the bulky detection dots are bounded so
  // the whole store stays under the localStorage quota.
  function capDetections(det, max) {
    if (!det) return {};
    var all = [];
    Object.keys(det).forEach(function (k) {
      var e = det[k] || {};
      (e.rows || []).forEach(function (r) { all.push({ k: k, r: r, t: (r && Date.parse(r.date)) || 0 }); });
    });
    if (all.length <= max) return det;
    all.sort(function (a, b) { return b.t - a.t; });   // newest first
    all.length = max;                                   // keep the newest `max`, drop the oldest
    var out = {};
    all.forEach(function (x) {
      var src = det[x.k];
      if (!out[x.k]) out[x.k] = { key: src.key, name: src.name, color: src.color, cls: src.cls || "", rows: [] };
      out[x.k].rows.push(x.r);
    });
    return out;
  }
  // Persist the merged state, never losing the small/important data: try the
  // detection cap, then progressively smaller caps on a quota error, only ever
  // trimming mapDetections (oldest first). Lists, year/life lists, checklists,
  // points and settings are written untouched. Returns the rows actually kept.
  function writeStateCapped(obj) {
    var caps = [DET_CAP, 8000, 4000, 1500, 0];
    for (var i = 0; i < caps.length; i++) {
      var o = {}; for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) o[k] = obj[k];
      o.mapDetections = capDetections(obj.mapDetections, caps[i]);
      try { localStorage.setItem("geomodel-explorer-v1", JSON.stringify(o)); window.GeoState.invalidate(); return detRowCount(o.mapDetections); }
      catch (e) { /* quota — drop more (older) detections and retry */ }
    }
    throw new Error("storage full even with no detections");
  }
  // Quota safety net for EVERY GeoState.save: if a write is too big, drop the
  // oldest plotted detections (never the lists/starred/points/settings) and retry
  // — so a year/life-list or star toggle is never lost just because the detection
  // store filled localStorage.
  if (window.GeoState && window.GeoState.setQuotaTrim) {
    window.GeoState.setQuotaTrim(function (state, attempt) {
      var caps = [DET_CAP, 8000, 4000, 1500, 500, 0];
      if (attempt >= caps.length) return null;
      var o = {}; for (var k in state) if (Object.prototype.hasOwnProperty.call(state, k)) o[k] = state[k];
      o.mapDetections = capDetections(o.mapDetections, caps[attempt]);
      return o;
    });
  }
  // Merge two saved mapDetections objects (the plotted dots/stars): union each
  // species' observation rows (deduped) so a sync combines both devices' pins.
  function mergeDetections(a, b) {
    a = a || {}; b = b || {}; var out = {};
    Object.keys(a).forEach(function (k) { var e = a[k] || {}; out[k] = { key: e.key || k, name: e.name || "", color: e.color, cls: e.cls || "", rows: (e.rows || []).slice() }; });
    Object.keys(b).forEach(function (k) {
      var e = b[k] || {};
      if (!out[k]) out[k] = { key: e.key || k, name: e.name || "", color: e.color, cls: e.cls || "", rows: (e.rows || []).slice() };
      else { out[k].rows = mergeDetRows(out[k].rows, e.rows); if (!out[k].name) out[k].name = e.name; if (!out[k].cls) out[k].cls = e.cls; }
    });
    return out;
  }
  function applyRemote(data, opts) {
    opts = opts || {};
    if (!data || data.app !== "migration_calendar") throw new Error(t("sync.notBackup"));
    // Flush the live map (plotted dots/stars) to storage FIRST, so the merge
    // unions the points the user is currently looking at — not just the last
    // explicitly-saved snapshot. Without this a sync could drop on-screen dots.
    try { if (typeof detPlot !== "undefined" && Object.keys(detPlot).length) saveDetections(); } catch (e) {}
    try { if (typeof saveMapPoints === "function") saveMapPoints(); } catch (e) {}   // same for the live map points
    var local = {}; try { local = JSON.parse(localStorage.getItem("geomodel-explorer-v1") || "{}"); } catch (e) {}
    // Saved trips live in IndexedDB now, not the blob — merge against the live mirror.
    try { if (typeof detSetStore !== "undefined") local.mapDetectionSets = detSetStore.filter(function (s) { return s && s.name; }); } catch (e) {}
    var incoming = data.state || {};
    var mergedCl = mergeChecklists(local.fieldChecklists, incoming.fieldChecklists);
    // Map points: merge rather than overwrite. Loose pins from both sides are
    // unioned into the working set; named lists are merged/overwritten by name.
    var mergedLoose = mergePins(loosePointsOf(local), loosePointsOf(incoming));
    var mergedSets = mergePointSets(local.mapPointSets, incoming.mapPointSets, opts.interactive);
    // Plotted detections (dots/stars) and the starred-species list: union both
    // sides so syncing merges pins instead of one device overwriting the other.
    var localDetN = detRowCount(local.mapDetections);
    var mergedDet = mergeDetections(local.mapDetections, incoming.mapDetections);
    var gainedDet = detRowCount(mergedDet) > localDetN;   // sync pulled in new dots → re-fit to show them
    var interestUnion = {}; (local.interesting || []).concat(incoming.interesting || []).forEach(function (k) { if (k) interestUnion[k] = 1; });
    // Year + life lists: union the life list, and union each year's set by year.
    var lifeUnion = {}; (local.lifeList || []).concat(incoming.lifeList || []).forEach(function (k) { if (k) lifeUnion[k] = 1; });
    var yearMerge = {};
    [local.yearLists, incoming.yearLists].forEach(function (yl) {
      Object.keys(yl || {}).forEach(function (y) { yearMerge[y] = yearMerge[y] || {}; (yl[y] || []).forEach(function (k) { if (k) yearMerge[y][k] = 1; }); });
    });
    var yearMergeArr = {}; Object.keys(yearMerge).forEach(function (y) { yearMergeArr[y] = Object.keys(yearMerge[y]); });
    // Learned families (for dot colours): union both sides so a species keeps the
    // family — and therefore the colour — learned on either device.
    var mergedFam = {}; [local.detFamilies, incoming.detFamilies].forEach(function (m) { Object.keys(m || {}).forEach(function (k) { if (m[k]) mergedFam[k] = m[k]; }); });
    // Named detection sets ("trips"): tombstoned names are dropped on both sides
    // (so a delete sticks); the rest are unioned by name (same name → union dots
    // and stars), so every device's saved trips survive the merge.
    var setTomb = {}; [local.mapDetectionSetsDel, incoming.mapDetectionSetsDel].forEach(function (a) { (a || []).forEach(function (n) { if (n) setTomb[n] = 1; }); });
    var setByName = Object.create(null), setOrder = [];
    [local.mapDetectionSets, incoming.mapDetectionSets].forEach(function (arr) {
      (Array.isArray(arr) ? arr : []).forEach(function (s) {
        if (!s || !s.name || setTomb[s.name]) return;
        var cur = setByName[s.name];
        if (!cur) { setByName[s.name] = { name: s.name, createdAt: s.createdAt || 0, detections: s.detections || {}, interesting: (s.interesting || []).slice() }; setOrder.push(s.name); }
        else {
          cur.detections = mergeDetections(cur.detections, s.detections);
          var iu = {}; cur.interesting.concat(s.interesting || []).forEach(function (k) { if (k) iu[k] = 1; }); cur.interesting = Object.keys(iu);
          cur.createdAt = Math.max(cur.createdAt, s.createdAt || 0);
        }
      });
    });
    var mergedSetsList = setOrder.map(function (n) { return setByName[n]; });
    // Which lists / detection-sets are SHOWN: union both sides (a list shown on
    // EITHER device stays shown after the merge), keeping only names that still
    // exist — otherwise a list synced in from the other device lands unticked and
    // its markers never render, so it looks like nothing synced.
    var setNames = {}; mergedSets.forEach(function (c) { setNames[c.name] = 1; });
    var shownUnion = {}; [local.mapPointsShownColls, incoming.mapPointsShownColls].forEach(function (a) { (Array.isArray(a) ? a : []).forEach(function (n) { if (n && setNames[n]) shownUnion[n] = 1; }); });
    var detSetNames = {}; mergedSetsList.forEach(function (s) { detSetNames[s.name] = 1; });
    var detShownUnion = {}; [local.mapDetSetsShown, incoming.mapDetSetsShown].forEach(function (a) { (Array.isArray(a) ? a : []).forEach(function (n) { if (n && detSetNames[n]) detShownUnion[n] = 1; }); });
    // Scalar settings: the winning side overrides, the other fills any gaps.
    var primary = opts.incomingWins ? incoming : local;
    var secondary = opts.incomingWins ? local : incoming;
    var newState = {}; Object.keys(secondary).forEach(function (k) { newState[k] = secondary[k]; });
    Object.keys(primary).forEach(function (k) { newState[k] = primary[k]; });
    // A synced/imported payload is untrusted: force every link URL it carries to a
    // safe http(s) form before it lands in localStorage (else a `javascript:` URL in
    // blogLinks/countryLinks/gbifDatasets would be a persistent XSS when rendered).
    ["blogLinks", "countryLinks", "customCountryUrls"].forEach(function (k) {
      if (!Array.isArray(newState[k])) return;
      newState[k] = newState[k].filter(function (e) { return e && e.cc && linkUrl(e.url); })
        .map(function (e) { return { cc: e.cc, url: linkUrl(e.url), label: e.label }; });
    });
    if (Array.isArray(newState.gbifDatasets)) {
      newState.gbifDatasets = newState.gbifDatasets.map(function (d) {
        return (d && d.url) ? { key: d.key, name: d.name, url: linkUrl(d.url), country: d.country } : d;
      });
    }
    // The merged collections override either side's copy.
    newState.fieldChecklists = mergedCl;
    newState.mapPointSets = mergedSets;
    newState.mapDetections = mergedDet;
    newState.interesting = Object.keys(interestUnion);
    newState.lifeList = Object.keys(lifeUnion);
    newState.yearLists = yearMergeArr;
    newState.detFamilies = mergedFam;
    // Blogs: UNION the user-added links (by cc|url) and the removed-tombstones across
    // both sides, so a blog added/deleted on one device isn't clobbered by the other.
    // URLs are sanitised at union time (linkUrl) — a synced payload is untrusted.
    var blogLinkUnion = {};
    (local.blogLinks || []).concat(incoming.blogLinks || []).forEach(function (b) {
      if (!b || !b.cc) return; var u = linkUrl(b.url); if (!u) return;
      var k = String(b.cc).toUpperCase() + "|" + u;
      if (!blogLinkUnion[k]) blogLinkUnion[k] = { cc: String(b.cc).toUpperCase(), url: u, label: b.label };
    });
    var blogRemovedUnion = {};
    (local.blogRemoved || []).concat(incoming.blogRemoved || []).forEach(function (k) { if (k) blogRemovedUnion[k] = 1; });
    newState.blogLinks = Object.keys(blogLinkUnion).map(function (k) { return blogLinkUnion[k]; });
    newState.blogRemoved = Object.keys(blogRemovedUnion);
    // Trips: update the in-memory mirror and persist to IndexedDB (write the merged
    // ones, delete tombstoned ones); keep them OUT of the localStorage blob so it
    // doesn't re-bloat. Fallback (no IDB) keeps them in the blob as before.
    detSetStore = mergedSetsList;
    if (detSetsIdbReady && window.AppIDB) {
      // Surface a storage-full failure rather than silently dropping a synced trip
      // (matches persistDetSet): a failed write leaves the trip in the in-memory
      // mirror but not durable, so flag it instead of swallowing the rejection.
      var onIdbErr = function () { setStatus(t("err.storageFull")); };
      mergedSetsList.forEach(function (s) { if (s && s.name) window.AppIDB.put("set:" + s.name, s).then(null, onIdbErr); });
      Object.keys(setTomb).forEach(function (n) { window.AppIDB.del("set:" + n).then(null, onIdbErr); });
      delete newState.mapDetectionSets;   // trips live in IDB; keep them out of the blob (the scalar copy may have set this)
    } else {
      newState.mapDetectionSets = mergedSetsList;
    }
    newState.mapDetectionSetsDel = Object.keys(setTomb);
    newState.mapPointsShownColls = Object.keys(shownUnion);   // union, so synced-in lists are visible
    newState.mapDetSetsShown = Object.keys(detShownUnion);
    // Working set + active list: a file IMPORT shows the merged loose set (no
    // active list); a background SYNC keeps the user's loaded list active and
    // makes the working set that list's MERGED points, so additions from the
    // other device appear in place.
    var keepActive = opts.interactive ? "" : (local.mapPointSetActive || "");
    var activeSet = keepActive ? mergedSets.filter(function (c) { return c.name === keepActive; })[0] : null;
    if (activeSet) {
      newState.mapPoints = (activeSet.points || []).slice();
      newState.mapPointSetActive = keepActive;
    } else {
      // No active list (or it's gone) → show the merged loose union. NEVER set
      // mapPoints to [] here: that would wipe this device's pins on a sync.
      newState.mapPoints = mergedLoose;
      newState.mapPointSetActive = "";
    }
    // Resilient write: keeps lists / year-life lists / checklists / points and
    // trims only the oldest detections if the store would exceed the quota.
    try { writeStateCapped(newState); } catch (e) { throw new Error("storage write failed: " + e.message); }
    // eBird key: adopt incoming only when it should win, or when we have none.
    if (data.ebirdKey && (opts.incomingWins || !ebirdKey())) setEbirdKey(data.ebirdKey);
    if (data.artdbKey && (opts.incomingWins || !artKey())) setArtKey(data.artdbKey);
    // Reflect the merged pins (dots/stars) on the map + legend immediately.
    try { reloadPlottedFromStore(); } catch (e) {}
    // If the sync brought in detections from the other device, fit the map to
    // the plotted dots so they're actually on screen (they render at their own
    // coordinates, which may be far from the view this device was showing).
    try { if (gainedDet) fitToDetections(); } catch (e) {}
    // Same for the user's map points: reload the merged set into memory and
    // re-render the markers + the Map-points panel (this was missing, so map
    // points appeared unchanged after a sync until a manual reload).
    try { if (typeof loadMapPoints === "function") { loadMapPoints(); renderMapPoints(); if (typeof refreshMpPanel === "function") refreshMpPanel(); } } catch (e) {}
    // Refresh the rest of the open views so a sync takes effect WITHOUT a manual
    // reload: the current species/field page, the checklist list, and any open
    // modal that lists synced data (detections, year/life lists, detection sets).
    try { if (typeof refreshCurrentView === "function") refreshCurrentView(); } catch (e) {}
    try { if (typeof refreshChecklists === "function") refreshChecklists(); } catch (e) {}
    function visible(id) { var m = document.getElementById(id); return m && m.style.display !== "none"; }
    try { if (visible("detlist-modal") && typeof renderDetListModal === "function") renderDetListModal(); } catch (e) {}
    try { if (visible("lists-modal") && typeof renderListsModal === "function") renderListsModal(); } catch (e) {}
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
  // GBIF re-publishes the big platforms under verbose dataset names with no
  // comma/paren to split on (e.g. "iNaturalist research-grade observations",
  // "eBird Observation Dataset") — map those to the clean platform name so the
  // source badge reads "iNaturalist", not the whole dataset title.
  var ORIGIN_PLATFORM = [
    [/^inaturalist\b/i, "iNaturalist"],
    [/^ebird\b/i, "eBird"],
    [/^observation\.org\b/i, "Observation.org"],
    [/artportalen/i, "Artportalen"],
    [/artsobserva|artskart/i, "Artsobservasjoner"],
    [/^global biodiversity/i, "GBIF"]
  ];
  function shortOrigin(s) {
    var raw = String(s || "");
    for (var i = 0; i < ORIGIN_PLATFORM.length; i++) if (ORIGIN_PLATFORM[i][0].test(raw)) return ORIGIN_PLATFORM[i][1];
    var t = raw.split(/,| – | - |\(/)[0].trim();
    return t || raw;
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
  // Downloadable as CSV. eBird's window is 30 days; GBIF/iNaturalist use 3 months.
  async function showRecent(name, sci, lat, lon, key, customRange) {
    clearOverlay();   // selecting "Recent" leaves the distribution view — drop its heatmap overlay (no-op if none)
    var body = document.getElementById("recent-body");
    document.getElementById("recent-title").textContent = name;
    body.innerHTML = '<div class="spinner" style="margin:24px auto"></div>';
    document.getElementById("recent-modal").style.display = "flex";
    navOpen("recent", hideRecent);
    var token = ++recentToken;

    var fmtD = function (d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); };
    var d1, d2;
    if (customRange) { var cr = String(customRange).split(","); d1 = cr[0]; d2 = cr[1] || fmtD(new Date()); }   // Historic mode passes its own range
    else { var to = new Date(), from = new Date(); from.setMonth(from.getMonth() - 3); d1 = fmtD(from); d2 = fmtD(to); }
    var range = d1 + "," + d2;

    var inatWeb = "https://www.inaturalist.org/observations?taxon_name=" + encodeURIComponent(sci) +
      "&lat=" + lat.toFixed(4) + "&lng=" + lon.toFixed(4) + "&radius=25&d1=" + d1 + "&d2=" + d2 + "&order_by=observed_on&order=desc";
    var gbifBase = "https://www.gbif.org/occurrence/search?q=" + encodeURIComponent(sci) +
      "&geometry=" + encodeURIComponent(AppFetch.gbifGeometry(lat, lon, 12.5));
    var countryParam = "";
    var ebLink = (key && isBirdKey(key)) ? '<a href="' + escapeHtml(ebirdUrl(key, sci)) + '" target="_blank" rel="noopener">eBird</a> · ' : "";
    var links = function () {
      return '<div class="recent-links">' + ebLink + '<a class="recent-gbif" href="' + escapeHtml(gbifBase + countryParam) + '" target="_blank" rel="noopener">GBIF</a>' +
        ' · <a href="' + escapeHtml(inatWeb) + '" target="_blank" rel="noopener">' + escapeHtml(t("recent.viewall")) + '</a></div>';
    };
    AppGeo.countryCode(lat, lon).then(function (cc) {
      if (!cc) return;
      countryParam = "&country=" + cc;
      if (token !== recentToken) return;
      var a = document.querySelector("#recent-body .recent-gbif");
      if (a) a.setAttribute("href", gbifBase + countryParam);
    });

    var srcSlug = function (s) { return s === "iNaturalist" ? "inat" : (s || "").toLowerCase(); };
    function render(rows, failed) {
      if (token !== recentToken) return;
      var warn = (failed && failed.length) ? '<div class="recent-warn">' + escapeHtml(t("fetch.failed", { sources: failedNames(failed) })) + "</div>" : "";
      if (!rows.length) {
        body.innerHTML = warn + '<p class="recent-none">' + escapeHtml(t("recent.none")) + "</p>" + links(); return;
      }
      var counts = {};
      rows.forEach(function (r) { counts[r.src] = (counts[r.src] || 0) + 1; });
      var cap = Object.keys(counts).map(function (s) { return s + " " + counts[s]; }).join(" · ");
      var html = rows.map(function (r) {
        var place = r.place || "(map)";
        var cell = r.url ? '<a href="' + escapeHtml(safeHref(r.url)) + '" target="_blank" rel="noopener">' + escapeHtml(place) + "</a>" : escapeHtml(place);
        // GBIF aggregates many datasets — badge such rows by their origin dataset.
        var label = (r.src === "GBIF" && r.origin) ? shortOrigin(r.origin) : r.src;
        var badge = '<span class="rc-src rc-src-' + srcSlug(r.src) + '" title="' + escapeHtml(r.origin || r.src) + '">' + escapeHtml(label || "") + "</span>";
        var clsBadge = r.cls ? '<span class="rc-cls" title="' + escapeHtml(r.cls) + '">' + classGlyph(r.cls) + "</span> " : "";
        return '<tr><td class="rc-date">' + escapeHtml(fmtDate(r.date)) + '</td><td class="rc-srccell">' + badge + '</td><td class="rc-place">' + clsBadge + cell + '</td><td class="rc-who">' + escapeHtml(r.who) + "</td></tr>";
      }).join("");
      body.innerHTML = '<div class="recent-head"><span class="recent-src">' + escapeHtml(cap + " · " + fmtDate(d1) + " – " + fmtDate(d2) + " · " + radiusLabel()) + "</span>" +
        '<span class="recent-head-btns"><button type="button" id="recent-map">' + escapeHtml(t("btn.showInMap")) + "</button>" +
        '<button type="button" id="recent-dl">' + escapeHtml(t("recent.download")) + "</button></span></div>" + warn +
        '<table class="recent-table"><tbody>' + html + "</tbody></table>" + links();
    }

    try {
      var rkm = recentRadiusKm();
      // eBird's API only reaches 30 days back, so it can't honor a historic
      // range — skip it there (GBIF + iNaturalist cover the window) to avoid
      // injecting out-of-range recent records into a historic popup.
      var wantEbird = key && isBirdKey(key) && ebirdKey() && !customRange;
      var failed = [];
      var results = await Promise.all([
        guardFetch(failed, "GBIF", gbifRecent(sci, lat, lon, range, rkm)),
        guardFetch(failed, "iNaturalist", inatRecent(sci, lat, lon, d1, d2, rkm)),
        wantEbird ? guardFetch(failed, "eBird", ebirdRecent(key, lat, lon, rkm)) : Promise.resolve([])
      ]);
      if (token !== recentToken) return;
      var rows = results[0].concat(results[1], results[2]);
      rows.sort(function (a, b) { return String(b.dt || b.date || "").localeCompare(String(a.dt || a.date || "")); });
      lastRecentRows = rows;
      lastRecentMeta = { key: key, name: name, sci: sci, lat: lat, lon: lon };
      render(rows, failed);
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

    // Hand the aggregation module live access to the model data + family index
    // (it owns the record→species matching; these stay owned by app.js).
    // A source/dataset config change invalidates the cached sightings fetches.
    AppSources.init({ onConfigChange: function () { allSightingsCache = {}; } });
    // Start the country-border load; when it arrives, drop the sightings cache
    // so country-gating re-runs with the (now accurate) polygons.
    AppGeo.init({ onBordersLoaded: function () { allSightingsCache = {}; } });
    AppAggregate.init({
      getLabels: function () { return labels; },
      getLabelsByKey: function () { return labelsByKey; },
      getTaxByCode: function () { return taxByCode; },
      getSpeciesGroup: function () { return speciesGroup; },
      recordFamily: recordFamily,
      saveFamIndex: saveFamIndex,
    });
    // Hand the fetch module the config/geo it needs (the GBIF dataset list +
    // disabled set, country-gating, the Laji-vs-GBIF rule, the iNat locale); the
    // orchestration that calls the adapters stays here.
    AppFetch.init({
      gbifDatasets: gbifDatasets,
      isGbifOff: isGbifOff,
      GBIF_DS_COUNTRY: GBIF_DS_COUNTRY,
      lajiDirectActive: lajiDirectActive,
      countryMatch: AppGeo.countryMatch,
      inatLocale: inatLocale,
      gbifTaxonParam: gbifTaxonParam,
      inatIconicTaxa: inatIconicTaxa,
    });
    // Hydrate saved trips from IndexedDB (and migrate any still in the localStorage
    // blob) before anything reads them. Never block startup on a storage hiccup.
    try { await initDetSetStore(); } catch (e) {}
    try { await loadPersistedSightings(); } catch (e) {}   // so a reopen reuses the last downloads instead of refetching
    ensurePersistentStorage();   // keep offline-map tiles + saved data from being evicted
    setTimeout(maybeAskRedownloadOffline, 3000);   // offer to re-fetch any browser-evicted offline areas



    root.innerHTML =
      '<div id="demo-loading"><div class="spinner"></div><span data-i18n="app.loading">Loading\u2026</span></div>' +
      '<div id="demo-app" style="display:none">' +
        '<div id="demo-controls">' +
          '<div class="ctrl-group" id="mode-wrap">' +
            '<label for="mode-select" data-i18n="ctrl.mode">Mode</label>' +
            '<select id="mode-select">' +
              '<option value="list" class="ico-label" data-i18n="mode.list">📍 Recent</option>' +
              '<option value="historic" class="ico-label" data-i18n="mode.historic">Historic</option>' +
              '<option value="barchart" class="ico-label" data-i18n="mode.barchart">Migration</option>' +
              '<option value="range" data-i18n="mode.range">Species Range</option>' +
              '<option value="richness" data-i18n="mode.richness">Species Richness</option>' +
            '</select>' +
          '</div>' +
          '<div class="ctrl-group" id="histrange-wrap" style="display:none">' +
            '<label data-i18n="hist.range">Date range</label>' +
            '<div class="hist-range-row"><input type="date" id="hist-from" /><span>–</span><input type="date" id="hist-to" />' +
              '<button type="button" id="hist-fetch" class="demo-btn" data-i18n="hist.fetch" disabled>Fetch</button></div>' +
            '<details class="hist-months-dd">' +
              '<summary class="hist-months-sum"><span data-i18n="hist.months">Months</span><span class="hist-months-sel" id="hist-months-sel"></span></summary>' +
              '<div class="hist-months" id="hist-months"></div>' +
              '<p class="cu-hint" data-i18n="hist.monthsHint">Leave blank for all months.</p>' +
            '</details>' +
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
                '<path d="M12 2a7 7 0 0 0-7 7c0 5 7 12 7 12s7-7 7-12a7 7 0 0 0-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>' +
              '<span id="mp-btn-text" class="hdr-count"></span>' +
            '</button>' +
            '<div id="mp-panel" class="dd-panel" style="display:none"></div>' +
          '</div>' +
          '<div class="ctrl-group" id="fs-wrap" style="display:none">' +
            '<button type="button" id="hdr-fs-toggle" class="hdr-icon-btn fs-toggle-btn" aria-label="Fullscreen" title="Fullscreen"></button>' +
          '</div>' +
          '<div class="ctrl-group" id="settings-wrap">' +
            '<button type="button" id="settings-toggle" class="settings-icon-btn" aria-haspopup="true" aria-label="Settings" title="Settings"></button>' +
            '<div id="settings-panel" class="dd-panel settings-panel" style="display:none">' +
              '<div class="settings-section" data-i18n="settings.secView">View</div>' +
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
              '<div class="ctrl-group">' +
                '<label for="recent-radius" data-i18n="ctrl.recentradius">Sightings radius</label>' +
                '<div class="radius-row"><input type="range" id="recent-radius" min="0" max="18" step="1" /><span id="recent-radius-val" class="radius-val"></span></div>' +
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
              '<div class="ctrl-group" id="maplabels-wrap">' +
                '<label for="maplabels-select" data-i18n="ctrl.maplabels">Place labels</label>' +
                '<select id="maplabels-select">' +
                  '<option value="off" data-i18n="labels.off">Off</option>' +
                  '<option value="on" data-i18n="labels.on">On</option>' +
                  '<option value="more" data-i18n="labels.more">More</option>' +
                '</select>' +
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
              '<div class="settings-section" data-i18n="settings.secFetch">Fetching &amp; detections</div>' +
              '<div class="ctrl-group">' +
                '<label for="fetch-timeout" data-i18n="ctrl.fetchTimeout">Fetch timeout (s)</label>' +
                '<input id="fetch-timeout" type="number" min="0" max="600" step="1" />' +
                '<p class="cu-hint" data-i18n="ctrl.fetchTimeoutHint">A source still fetching after this many seconds is stopped; the observations it already loaded are kept and its label turns red. 0 = no timeout.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="sight-ttl" data-i18n="ctrl.sightTtl">Reuse downloads (min)</label>' +
                '<input id="sight-ttl" type="number" min="0" max="10080" step="5" />' +
                '<p class="cu-hint" data-i18n="ctrl.sightTtlHint">Reopening the app reuses a location’s already-downloaded observations for this many minutes instead of re-fetching. 0 = reuse indefinitely (only refetch on a new place or a changed radius/group/source).</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="max-points" data-i18n="ctrl.maxpoints">Max points on map</label>' +
                '<input id="max-points" type="number" min="50" max="100000" step="50" />' +
                '<p class="cu-hint" data-i18n="ctrl.maxpointshint">Caps how many detection dots are drawn at once for speed. When more are plotted, only the newest this-many are shown on the map (the rest stay in the Detections list).</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label class="ctrl-check"><input type="checkbox" id="dedup-toggle"> <span data-i18n="ctrl.dedup">Deduplicate detections</span></label>' +
                '<p class="cu-hint" data-i18n="ctrl.deduphint">When the same sighting is registered in two databases (e.g. eBird and Artsobservasjoner) — same observer, approximate location, date, count and species — show it once instead of twice. Off = show every source\'s copy.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="nearby-count" data-i18n="ctrl.nearbycount">Close by — rows shown</label>' +
                '<input id="nearby-count" type="number" min="1" max="500" step="1" />' +
                '<p class="cu-hint" data-i18n="ctrl.nearbycounthint">How many of the nearest detections the Close by list shows, sorted by distance from the live/fixed cross or placed pin.</p>' +
                '<label class="ctrl-check"><input type="checkbox" id="nearby-points-toggle"> <span data-i18n="ctrl.nearbypoints">Also include active map points</span></label>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="rare-pct" data-i18n="ctrl.rarepct">Rare species threshold (%)</label>' +
                '<input id="rare-pct" type="number" min="1" max="100" step="1" />' +
                '<p class="cu-hint" data-i18n="ctrl.rarepcthint">A plotted species is “rare locally” when its detection count is at most this % of the commonest plotted species. Rare dots get a black centre; filter them with the legend’s ◉ Rare.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="hotspot-min" data-i18n="ctrl.hotspotmin">Hotspot min. species</label>' +
                '<select id="hotspot-min">' +
                  '<option value="0" data-i18n="opt.off">Off</option><option value="25">25+</option><option value="50">50+</option><option value="100">100+</option><option value="200">200+</option>' +
                '</select>' +
              '</div>' +
              '<div class="settings-section" data-i18n="settings.secData">Data sources</div>' +
              '<div class="ctrl-group" id="sources-wrap">' +
                '<label data-i18n="sources.label">Data sources</label>' +
                icoBtn("sources-open", "sources", "sources.manage", "Manage data sources…") +
              '</div>' +
              '<div class="ctrl-group" id="gbif-ds-wrap">' +
                '<label data-i18n="ctrl.gbifDatasets">GBIF datasets (fetched separately)</label>' +
                icoBtn("gbif-ds-open", "datasets", "gbif.manage", "Manage datasets…") +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label data-i18n="ctrl.customurls">National databases</label>' +
                icoBtn("natdb-open", "globe", "natdb.manage", "Manage national databases…") +
              '</div>' +
              '<div class="settings-section" data-i18n="settings.secListsShare">Lists &amp; sharing</div>' +
              '<div class="ctrl-group" id="points-kml-wrap">' +
                '<label data-i18n="ctrl.exportPoints">Map points</label>' +
                '<div class="kml-btn-row">' +
                  icoBtn("points-export", "download", "btn.export", "Export") +
                  icoBtn("points-kml-import", "upload", "btn.import", "Import") +
                  '<button type="button" id="points-fmt-toggle" class="demo-btn demo-btn-light kml-fmt-toggle" data-i18n-title="btn.fmtToggle" title="Export format">KML</button>' +
                "</div>" +
                '<input type="file" id="points-kml-file" style="display:none" />' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label data-i18n="lists.title">Year &amp; life lists</label>' +
                icoBtn("lists-open", "list", "lists.manage", "Administer lists…") +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label data-i18n="blocked.title">Blocked species</label>' +
                icoBtn("blocked-open", "block", "blocked.manage", "Manage blocked species…") +
              '</div>' +
              '<div class="ctrl-group" id="sync-wrap">' +
                '<label data-i18n="ctrl.syncData">Share between devices</label>' +
                '<div class="sync-row">' +
                  icoBtn("sync-export", "download", "sync.export", "Export") +
                  icoBtn("sync-import", "upload", "sync.import", "Import") +
                  '<input type="file" id="sync-file" accept=".json,application/json" style="display:none" />' +
                '</div>' +
                '<div class="sync-row" id="gdrive-row">' +
                  icoBtn("gd-connect", "cloud", "gdrive.connect", "Connect Google Drive") +
                  icoBtn("gd-sync", "refresh", "gdrive.syncNow", "Sync now", ' style="display:none"') +
                  '<button type="button" id="gd-disconnect" class="demo-btn" data-i18n="gdrive.disconnect" style="display:none">Disconnect</button>' +
                '</div>' +
                '<input type="text" id="gd-clientid" autocomplete="off" spellcheck="false" data-i18n-ph="gdrive.clientIdPh" placeholder="Google OAuth client ID" style="display:none" />' +
                '<div id="gd-status" class="cu-hint"></div>' +
                '<p class="cu-hint" data-i18n="gdrive.hint">Syncs settings, checklists and points to your private Google Drive app folder. Deletions don’t sync between devices.</p>' +
              '</div>' +
              '<div class="settings-section" data-i18n="settings.secStorage">Storage &amp; offline</div>' +
              '<div class="ctrl-group" id="offline-wrap">' +
                '<label data-i18n="offline.maps">Offline maps</label>' +
                icoBtn("offline-open", "download", "offline.manage", "Manage offline maps…") +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="map-cache" data-i18n="ctrl.mapcache">Map cache</label>' +
                '<select id="map-cache">' +
                  '<option value="0" data-i18n="opt.off">Off</option><option value="25">25 MB</option><option value="100">100 MB</option><option value="250">250 MB</option><option value="500">500 MB</option>' +
                '</select>' +
                '<p class="cu-hint" data-i18n="ctrl.mapcachehint">One shared store for map tiles and computed range data as you pan and zoom. When it is full the least-recently-used data is dropped first. Downloaded offline areas are stored separately and never counted here.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label data-i18n="ctrl.storage">Storage</label>' +
                '<p class="cu-hint" id="storage-usage"></p>' +
              '</div>' +
              '<div class="ctrl-group" id="install-wrap" hidden>' +
                '<label data-i18n="install.label">Offline mode</label>' +
                icoBtn("install-settings", "install", "install.app", "Offline mode") +
                '<div class="install-steps cu-hint" hidden></div>' +
              '</div>' +
              '<div class="settings-section" data-i18n="settings.secDisplay">Display &amp; language</div>' +
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
              '<div class="app-qr"><img src="qr-app.svg" alt="" width="140" height="140" /><span class="app-qr-cap" data-i18n="settings.qrShare">Scan to open / share this app</span></div>' +
              '<button type="button" id="about-open" class="settings-about" data-i18n="ctrl.about">About &amp; how it works</button>' +
              '<div class="settings-section" data-i18n="settings.secWhatsNew">What’s new</div>' +
              '<div id="whatsnew-list" class="whatsnew-list"></div>' +
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
          '<div id="nearby-page" style="display:none">' +
            '<div class="nb-bar">' +
              '<h3 id="nb-title" data-i18n="nearby.title">Close by</h3>' +
              '<button id="nb-tomap" class="nb-tomap" title="Show on map" aria-label="Show on map">' + ico("pin") + '</button>' +
            '</div>' +
            '<div id="nb-ref" class="nb-ref"></div>' +
            '<div id="nb-list" class="nb-list"></div>' +
          '</div>' +
        '</div>' +
        '<div id="csv-btn-wrap" style="display:none">' +
          '<button id="csv-download-btn" class="demo-btn ico-btn" title="Download CSV">' + ico("download") + '<span class="ico-label" data-i18n="btn.csv">CSV</span></button>' +
        '</div>' +
        '<div id="species-panel">' +
          '<div class="sp-page-bar">' +
            '<button id="sp-back" class="fp-back" title="Back to map">‹</button>' +
            '<h3 id="sp-title" data-i18n="panel.spTitle">Recent Observations</h3>' +
          '</div>' +
          '<div class="sp-coords" id="sp-coords"></div>' +
          '<div class="hist-progress" id="sp-hist-prog" style="display:none"><div class="hist-progress-fill hist-progress-indet" id="sp-hist-prog-fill"></div></div>' +
          '<div class="sp-loading" id="sp-loading" style="display:none"></div>' +
          '<div class="sp-actions">' +
            '<button id="sp-checklist-btn" class="demo-btn ico-btn">' + ico("check") + '<span class="ico-label" data-i18n="btn.checklist">Checklist</span></button>' +
            '<button id="sp-map-btn" class="demo-btn demo-btn-light ico-btn" title="Plot all observations on the map">' + ico("pin") + '<span class="ico-label" data-i18n="btn.showInMap">Map</span></button>' +
          '</div>' +
          '<table id="species-list-table">' +
            '<thead><tr><th id="sp-species-head" class="clickable-head" data-i18n="th.species">Species</th><th class="name2" id="sp-name2-head"></th><th id="sp-sci-head" class="clickable-head" data-i18n="th.sci">Scientific name</th><th id="sp-prob-head" class="clickable-head" data-i18n="th.prob">Probability</th><th id="sp-nd-head" class="num clickable-head" data-i18n="th.nd">n(d)</th><th id="sp-delta-head"></th></tr></thead>' +
            '<tbody id="sp-tbody"></tbody>' +
          '</table>' +
          '<div class="sp-actions sp-actions-dl">' +
            '<button id="sp-pdf-btn" class="demo-btn demo-btn-light ico-btn" title="Download PDF">' + ico("download") + "<span>PDF</span></button>" +
          '</div>' +
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
                  '<button id="field-pdf" class="fp-dl-item ico-btn">' + ico("download") + "<span>PDF</span></button>" +
                  '<button id="field-csv" class="fp-dl-item ico-btn">' + ico("download") + '<span class="ico-label" data-i18n="btn.csv">CSV</span></button>' +
                  '<button id="field-log" class="fp-dl-item ico-btn">' + ico("download") + '<span class="ico-label" data-i18n="btn.logcsv">Log</span></button>' +
                  '<div class="fp-dl-sep"></div>' +
                  '<button id="field-map" class="fp-dl-item ico-btn">' + ico("pin") + '<span class="ico-label" data-i18n="btn.showMap">Map</span></button>' +
                  '<button id="field-review" class="fp-dl-item ico-btn">' + ico("upload") + '<span class="ico-label" data-i18n="btn.review">Upload</span></button>' +
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
          '<h2 class="perf-title" data-i18n="popup.title">Species — distributions &amp; observations</h2>' +
          '<p class="perf-desc" data-i18n="popup.desc">Explore species’ ranges, migration timing and recent sightings — all in your browser: a neural habitat model (BirdNET) runs on your device, with live observations from eBird, GBIF, iNaturalist and more.</p>' +
          '<p class="perf-note" data-i18n="popup.keysShort">Fetching data from some sources requires free keys — see Settings → Data sources.</p>' +
          '<p class="perf-feedback"><span data-i18n="popup.feedback"></span> <button type="button" class="feedback-open ico-btn">' + ico("mail") + '<span class="ico-label" data-i18n="feedback.send">Message</span></button></p>' +
          '<div class="install-row"><button type="button" id="install-info" class="demo-btn demo-btn-light" hidden data-i18n="install.app">⤓ Offline mode</button><div class="install-steps cu-hint" hidden></div></div>' +
          '<div class="perf-version" id="perf-version" style="display:none"></div>' +
          '<button id="perf-modal-ok" class="demo-btn" data-i18n="popup.ok">OK</button>' +
        '</div></div>' +
        '<div id="feedback-modal" style="display:none"><div id="feedback-box">' +
          '<button type="button" id="feedback-close" aria-label="Close">×</button>' +
          '<h3 data-i18n="feedback.title">Message</h3>' +
          '<textarea id="feedback-msg" rows="5" data-i18n-ph="feedback.msgPh" placeholder="Your message…"></textarea>' +
          '<input type="email" id="feedback-email" autocomplete="email" data-i18n-ph="feedback.emailPh" placeholder="Your email (optional, for a reply)" />' +
          '<div id="feedback-status" class="cu-hint"></div>' +
          '<div class="feedback-actions">' +
            '<button type="button" id="feedback-cancel" class="demo-btn demo-btn-light" data-i18n="feedback.cancel">Cancel</button>' +
            '<button type="button" id="feedback-send" class="demo-btn" data-i18n="feedback.sendBtn">Send</button>' +
          '</div>' +
        '</div></div>' +
        '<div id="gbif-modal" style="display:none"><div id="gbif-box">' +
          '<button type="button" id="gbif-close" aria-label="Close">×</button>' +
          '<h3 data-i18n="gbif.title">GBIF datasets</h3>' +
          '<p class="cu-hint" data-i18n="gbif.hint">Each is queried on its own page budget so a busy one isn’t lost to the cap. eBird &amp; iNaturalist are already fetched directly. Add datasets by hand: a 2-letter country (blank = everywhere), the GBIF dataset key (or its gbif.org/dataset/… URL), and an optional homepage.</p>' +
          '<div class="gbif-add-row">' +
            '<input type="text" id="gbif-add-cc" autocomplete="off" spellcheck="false" maxlength="2" data-i18n-ph="gbif.addCcPh" placeholder="CC" class="gbif-add-cc" />' +
            '<input type="text" id="gbif-add" autocomplete="off" spellcheck="false" data-i18n-ph="gbif.addPh" placeholder="Dataset key or gbif.org/dataset/… URL" />' +
            '<input type="text" id="gbif-add-url" autocomplete="off" spellcheck="false" data-i18n-ph="gbif.addUrlPh" placeholder="Homepage URL (optional)" />' +
            '<button type="button" id="gbif-add-btn" class="demo-btn" data-i18n="gbif.add">Add</button>' +
          '</div>' +
          '<div id="gbif-table"></div>' +
        '</div></div>' +
        '<div id="natdb-modal" style="display:none"><div id="natdb-box">' +
          '<button type="button" id="natdb-close" aria-label="Close">×</button>' +
          '<h3 data-i18n="ctrl.customurls">National databases</h3>' +
          '<p class="cu-hint" data-i18n="ctrl.customurlsHint">Open extra sites for a country in the map popups. Country code = ISO-3166 (e.g. NO, GB).</p>' +
          '<div id="custom-urls-list"></div>' +
          '<div class="cu-actions">' +
            '<button type="button" id="custom-urls-add" class="demo-btn" data-i18n="ctrl.customurlsAdd">+ Add</button>' +
            '<button type="button" id="custom-urls-reset" class="demo-btn demo-btn-light" data-i18n="ctrl.customurlsReset">Reset</button>' +
          '</div>' +
        '</div></div>' +
        '<div id="detlist-modal" style="display:none"><div id="detlist-box">' +
          '<button type="button" id="detlist-close" aria-label="Close">×</button>' +
          '<div id="detlist-head">' +
            '<h3 id="detlist-title">Detections</h3>' +
            '<div id="detlist-actions">' +
              '<button type="button" id="detlist-save" class="detlist-save-btn ico-btn">' + ico("save") + '<span class="ico-label" data-i18n="detlist.save">Save</span></button>' +
              '<button type="button" id="detlist-nav" class="detlist-save-btn ico-btn" data-i18n-title="nav.title" title="Navigate in Google Maps" aria-label="Navigate in Google Maps">' + ico("nav") + "</button>" +
              '<button type="button" id="detlist-coords" class="detlist-save-btn ico-btn" data-i18n-title="coords.copyBtn" title="Copy coordinates" aria-label="Copy coordinates">' + ico("copy") + "</button>" +
              '<button type="button" id="detlist-sort" class="detlist-sort-toggle">By date</button>' +
            '</div>' +
          '</div>' +
          '<input type="text" id="detlist-search" autocomplete="off" spellcheck="false" data-i18n-ph="detlist.search" placeholder="Filter species…" />' +
          '<div id="detlist-body"></div>' +
        '</div></div>' +
        '<div id="offline-modal" style="display:none"><div id="offline-box">' +
          '<button type="button" id="offline-min" aria-label="Minimize" title="Minimize">–</button>' +
          '<button type="button" id="offline-close" aria-label="Close">×</button>' +
          '<h3 data-i18n="offline.maps">Offline maps</h3>' +
          '<div class="offline-body">' +
            '<p class="cu-hint" data-i18n="offline.hint">Use the ⬇ button on the map to download the current view.</p>' +
            '<div class="offline-zoom-row">' +
              '<label for="offline-zoom" data-i18n="ctrl.offlineZoom">Download max zoom</label>' +
              '<select id="offline-zoom">' +
                '<option value="11">11 · regional</option><option value="13">13 · town</option>' +
                '<option value="15">15 · street</option><option value="17" selected>17 · detailed (full)</option>' +
              '</select>' +
            '</div>' +
            '<div id="offline-list"></div>' +
          '</div>' +
        '</div></div>' +
        '<div id="blogs-modal" style="display:none"><div id="blogs-box">' +
          '<button type="button" id="blogs-close" aria-label="Close">×</button>' +
          '<h3 id="blogs-title" data-i18n="blogs.title">Birding blogs</h3>' +
          '<p class="cu-hint" data-i18n="blogs.hint">Top birding blogs & resources for this country. Open any, add your own, or remove ones you don\'t want — your changes sync.</p>' +
          '<div id="blogs-list"></div>' +
          '<div class="cu-actions"><button type="button" id="blogs-add" class="demo-btn demo-btn-light" data-i18n="blogs.add">+ Add blog</button></div>' +
        '</div></div>' +
        '<div id="sources-modal" style="display:none"><div id="sources-box">' +
          '<button type="button" id="sources-close" aria-label="Close">×</button>' +
          '<h3 id="sources-title" data-i18n="sources.title">Data sources</h3>' +
          '<p class="cu-hint" id="sources-hint" data-i18n-html="sources.hint2">Tap a source to enable it and edit its details.</p>' +
          '<div id="sources-table"></div>' +
          '<div class="cu-actions" id="sources-actions">' +
            '<button type="button" id="sources-reset" class="demo-btn demo-btn-light" data-i18n="sources.reset">Reset to defaults</button>' +
          '</div>' +
        '</div></div>' +
        '<div id="blocked-modal" style="display:none"><div id="blocked-box">' +
          '<button type="button" id="blocked-close" aria-label="Close">×</button>' +
          '<h3 data-i18n="blocked.title">Blocked species</h3>' +
          '<p class="cu-hint" data-i18n="blocked.hint">Blocked species are hidden from the lists, checklist and map. Tap × to unblock.</p>' +
          '<div id="blocked-list"></div>' +
        '</div></div>' +
        '<div id="lists-modal" style="display:none"><div id="lists-box">' +
          '<button type="button" id="lists-close" aria-label="Close">×</button>' +
          '<h3 data-i18n="lists.title">Year &amp; life lists</h3>' +
          '<p class="cu-hint" data-i18n="lists.hint">Add species from a species menu or a field checklist. Species missing from this year\'s list get a thin yellow edge on the map; missing from the life list, a thick one. Old year lists are kept until you delete them.</p>' +
          '<label class="ctrl-check lists-edges-row"><input type="checkbox" id="list-edges-toggle"> <span data-i18n="lists.edgesToggle">Show the year/life-list edges on map markers</span></label>' +
          '<div id="lists-list"></div>' +
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
      var fsWrap = document.getElementById("fs-wrap");
      if (hdr && fsWrap) hdr.appendChild(fsWrap);   // fullscreen toggle next to the Points button
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
      renderWhatsNew();
      setStatus(modeHint());
      fitMapHeight();
      requestAppVersion();
      showLastChange();
      showPerfModal();
      initOfflineIndicator();
      initInstall();
      var hasHere = false; try { hasHere = new URLSearchParams(location.search).has("here"); } catch (e) {}
      if (!hasHere) restoreSession();   // return to the view we left (reload-safe)
      maybeUrlAutoLocate();   // ?here=1 → geolocate + open species list
      maybeImportShared();    // #s=… → import a shared point / list / detection set
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
    worker.onerror = function (err) {
      console.error("Worker error:", err);
      // A fatal worker error (e.g. wasm OOM/abort) means no `infer` reply will ever
      // arrive — reject every in-flight inference so callers' spinners/overlays clear
      // instead of hanging forever.
      failAllPending(err && err.message ? err.message : "inference worker error");
    };

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
    for (var i = 0; i < els.length; i++) {
      var s = t(els[i].getAttribute("data-i18n"));
      // Icon buttons pair an inline SVG with a `.ico-label` text span; drop any
      // leading emoji/symbol the translation still carries so only the SVG shows.
      if (els[i].classList.contains("ico-label")) s = s.replace(/^[^\p{L}\p{N}]+/u, "");
      els[i].textContent = s;
    }
    // data-i18n-html: strings that contain markup (e.g. links) — set as innerHTML.
    // The values are our own trusted translations, not user input.
    var htmlEls = document.querySelectorAll("[data-i18n-html]");
    for (var h = 0; h < htmlEls.length; h++) htmlEls[h].innerHTML = t(htmlEls[h].getAttribute("data-i18n-html"));
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
      '<div id="about-install">' + t("about.installHtml") + "</div>" +   // clear install-for-offline steps (iOS + Android)
      '<div id="about-footer">' +
        '<div id="visit-counter"><img src="https://api.visitorbadge.io/api/visitors?path=https%3A%2F%2Fpcmoan70.github.io%2Fmigration_calendar&label=page%20visits&labelColor=%230f1b24&countColor=%232f6f4f" alt="page visits" /></div>' +
        (lastChangeText ? '<div id="last-change">' + escapeHtml(t("footer.lastchange", { t: lastChangeText })) + "</div>" : "") +
      "</div>";
    // Localize the embedded [data-i18n] bits (e.g. the feedback button), scoped
    // to the About body — NOT applyI18n(), which calls back here (infinite loop).
    var i18nEls = about.querySelectorAll("[data-i18n]");
    for (var i = 0; i < i18nEls.length; i++) i18nEls[i].textContent = t(i18nEls[i].getAttribute("data-i18n"));
  }

  // Build the 48-week dropdown with localized labels.
  function populateWeekSelect() {
    var sel = document.getElementById("week-select");
    var cur = +sel.value || 1;
    var thisW = weekOfToday();
    var html = "";
    for (var w = 1; w <= 48; w++) html += '<option value="' + w + '">' + weekText(w) + (w === thisW ? " · " + t("week.thisweek") : "") + "</option>";
    sel.innerHTML = html;
    sel.value = cur;
  }

  // Re-render whatever panel/overlay is currently shown (after a language change).
  // One-shot: when true, the next species-list render keeps the panel's scroll
  // position instead of jumping to the top (set for in-place updates like
  // starring a species). Consumed at the start of the render functions.
  var keepListScroll = false;
  function refreshCurrentView() {
    if (currentSpView && currentSpView.mode === "country" && document.getElementById("species-panel").style.display !== "none") {
      renderSpeciesInCountry(currentSpView.lat, currentSpView.lon); return;
    }
    if (currentMode === "historic" && currentSpView && currentSpView.mode === "historic" && document.getElementById("species-panel").style.display !== "none") {
      // Re-render the Historic list so a species-header filter/sort cycle applies.
      // The GBIF range fetch is cached, so only the (fast) inference re-runs.
      renderSpeciesList(currentSpView.lat, currentSpView.lon, { from: currentSpView.from, to: currentSpView.to, range: currentSpView.range, months: currentSpView.months });
    } else if (currentMode === "list" && marker && document.getElementById("species-panel").style.display !== "none") {
      // Only re-render (and thus re-open) the species page when it's actually
      // showing — otherwise marking interesting from the map would jump the user
      // off the map onto the "Species at location" list.
      var ll = marker.getLatLng();
      renderSpeciesList(ll.lat, ll.lng);
    } else if (currentMode === "barchart" && analysisData) {
      renderActiveTab();
    } else if ((currentMode === "range" || currentMode === "richness") && cachedRender) {
      showCachedWeek();
    }
    // Field-list re-render so the chk-filter buttons reflect interesting set changes.
    if (document.getElementById("field-page").style.display === "flex") renderFieldList();
    keepListScroll = false;   // clear if no list render consumed it (e.g. barchart mode)
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
    // Track how long the last pointer was held on the map, so a touch can be gated:
    // a pin popup needs a ≥100 ms press (filters accidental brushes) and registering
    // a location via long-press needs ≥500 ms. Capture phase so it also sees presses
    // that start on a marker; mouse/pen are never gated.
    (function () {
      var mc = map.getContainer();
      mc.addEventListener("pointerdown", function (e) {
        mapPtrDownTs = Date.now(); mapPtrIsTouch = (e.pointerType === "touch");
      }, true);
      // touchstart fallback: guarantees the touch flag + start time are set on
      // Android even if pointer events report an unexpected type.
      mc.addEventListener("touchstart", function () { mapPtrDownTs = Date.now(); mapPtrIsTouch = true; }, true);
    })();
    map.on("mousedown movestart", hideStoredLocations);   // dismiss the stored-locations list on any map interaction
    // Follow the pointer with the fetch-area box in Species List mode.
    map.on("mousemove", function (e) { updateFetchArea(e.latlng); });
    map.on("mouseout", hideFetchArea);

    // Shift + mouse-wheel resizes the "Sightings radius" (steps through RADIUS_STEPS)
    // — an alternative to the Settings slider. Capture phase + stopPropagation so it
    // pre-empts Leaflet's scroll-zoom; scroll up = larger, down = smaller.
    map.getContainer().addEventListener("wheel", function (e) {
      if (!e.shiftKey) return;   // plain wheel still zooms the map
      e.preventDefault(); e.stopPropagation();
      var idx = Math.max(0, Math.min(RADIUS_STEPS.length - 1, radiusStepIndex(recentRadiusKm()) + (e.deltaY < 0 ? 1 : -1)));
      var km = RADIUS_STEPS[idx];
      if (km === recentRadiusKm()) return;
      window.GeoState.save({ recentRadiusKm: km }); allSightingsCache = {};
      var rrEl = document.getElementById("recent-radius"); if (rrEl) rrEl.value = String(idx);
      var rrVal = document.getElementById("recent-radius-val"); if (rrVal) rrVal.textContent = radiusLabel(km);
      try { updateFetchArea(map.mouseEventToLatLng(e)); } catch (er) {}                                // resize the live movable preview
      setStatus(t("ctrl.radiusSet", { r: radiusLabel(km) }));
    }, { capture: true, passive: false });

    // "Locate me" crosshair control — zooms to the device's current location.
    var LocateControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var c = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        var a = L.DomUtil.create("a", "geo-locate-btn", c);
        a.href = "#";
        a.title = t("ctrl.crossHold");
        a.setAttribute("aria-label", t("ctrl.crossHold"));
        a.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
          '<circle cx="12" cy="12" r="6"/><line x1="12" y1="1" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="23"/>' +
          '<line x1="1" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/></svg>';
        // Tap cycles the crosshair states (off → follow → read).
        L.DomEvent.on(a, "click", function (e) {
          L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e);
          cycleCrosshair();
        });
        return c;
      }
    });
    map.addControl(new LocateControl());
    map.on("locationerror", function () { setStatus(t("status.locateError")); });

    // "Birds close by" — opens the distance-sorted list page (see openNearby).
    var NearbyControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var c = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        var a = L.DomUtil.create("a", "nearby-btn", c);
        a.href = "#";
        a.title = t("ctrl.nearby");
        a.setAttribute("aria-label", t("ctrl.nearby"));
        a.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>' +
          '<circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>';
        L.DomEvent.on(a, "click", function (e) { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); openNearby(); });
        return c;
      }
    });
    map.addControl(new NearbyControl());
    var nbToMap = document.getElementById("nb-tomap");
    if (nbToMap) nbToMap.addEventListener("click", function () { resumeNearbyFollow(); closeNearby(true); });   // toggling to map resumes follow
    window.addEventListener("resize", function () { if (nearbyIsOpen()) fitNearbyNames(); });   // re-fit names on rotate/resize

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
          '<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>';   // magnifying glass
        // Tap = place search; press-and-hold (touch) or right-click (mouse) =
        // stored-locations list. lpFired suppresses the click a hold produces.
        var lpT = null, lpFired = false, lpX = 0, lpY = 0;
        L.DomEvent.on(a, "touchstart", function (e) {
          lpFired = false; clearTimeout(lpT);
          var tt = e.touches && e.touches[0]; lpX = tt ? tt.clientX : 0; lpY = tt ? tt.clientY : 0;
          lpT = setTimeout(function () { lpFired = true; showStoredLocations(a); }, 500);
        });
        L.DomEvent.on(a, "touchmove", function (e) { var tt = e.touches && e.touches[0]; if (tt && (Math.abs(tt.clientX - lpX) > 12 || Math.abs(tt.clientY - lpY) > 12)) clearTimeout(lpT); });
        L.DomEvent.on(a, "touchend", function () { clearTimeout(lpT); });
        L.DomEvent.on(a, "contextmenu", function (e) { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); showStoredLocations(a); });
        L.DomEvent.on(a, "click", function (e) {
          L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e);
          if (lpFired) { lpFired = false; return; }   // this was a hold, not a tap
          togglePlaceSearch();
        });
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
    // address bar). Lives in the HEADER row, next to the Points (map-pointer)
    // button, same size as the other header icons. Only shown where the
    // Fullscreen API is available.
    if (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen) {
      var fsBtn = document.getElementById("hdr-fs-toggle"), fsWrap = document.getElementById("fs-wrap");
      if (fsBtn && fsWrap) {
        fsWrap.style.display = "";
        fsBtn.title = t("ctrl.fullscreen"); fsBtn.setAttribute("aria-label", t("ctrl.fullscreen"));
        fsBtn.innerHTML = fsIconSvg();
        fsBtn.addEventListener("click", function (e) { e.preventDefault(); toggleFullscreen(); });
      }
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
        a.href = "#"; a.title = t("ctrl.downloadHold"); a.setAttribute("aria-label", t("ctrl.downloadHold"));
        a.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 3v10"/><path d="M8 11l4 4 4-4"/><path d="M4 19h16"/></svg>';
        // Tap = download the current view; press-and-hold (touch) or right-click
        // (mouse) = open the saved offline-maps list.
        var lpT = null, lpFired = false, lpX = 0, lpY = 0;
        L.DomEvent.on(a, "touchstart", function (e) {
          lpFired = false; clearTimeout(lpT);
          var tt = e.touches && e.touches[0]; lpX = tt ? tt.clientX : 0; lpY = tt ? tt.clientY : 0;
          lpT = setTimeout(function () { lpFired = true; openOfflineManager(); }, 500);
        });
        L.DomEvent.on(a, "touchmove", function (e) { var tt = e.touches && e.touches[0]; if (tt && (Math.abs(tt.clientX - lpX) > 12 || Math.abs(tt.clientY - lpY) > 12)) clearTimeout(lpT); });
        L.DomEvent.on(a, "touchend", function () { clearTimeout(lpT); });
        L.DomEvent.on(a, "contextmenu", function (e) { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); openOfflineManager(); });
        L.DomEvent.on(a, "click", function (e) {
          L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e);
          if (lpFired) { lpFired = false; return; }   // this was a hold, not a tap
          openAreaDialog(map.getBounds());
        });
        return c;
      }
    });
    map.addControl(new DownloadControl());

    // "Country" resources (Blogs / BirdLife / national services) for the country at
    // the map centre — a globe button on the right.
    var CountryControl = L.Control.extend({
      options: { position: "topright" },
      onAdd: function () {
        var c = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        var a = L.DomUtil.create("a", "country-btn", c);
        a.href = "#"; a.title = t("popup.country"); a.setAttribute("aria-label", t("popup.country"));
        a.innerHTML = ico("globe");
        L.DomEvent.on(a, "click", function (e) { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); openCountryMenu(); });
        return c;
      }
    });
    map.addControl(new CountryControl());

    // Live position (blue "follow" state): keep the plus marker on the current
    // location. On the first fix, centre the map and populate the click-driven modes
    // at that point. Later fixes move the plus and keep it AT LEAST 10% in from every
    // edge: when it drifts into the outer 10% band, the map pans the MINIMUM needed
    // to push it back inside. So the central 80% of the screen is a hold-still zone.
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
      } else {
        var size = map.getSize(), cp = map.latLngToContainerPoint(e.latlng);
        var mx = size.x * 0.1, my = size.y * 0.1;                          // 10% edge margin
        var tx = Math.min(Math.max(cp.x, mx), size.x - mx);               // clamp the pointer into [10%, 90%]
        var ty = Math.min(Math.max(cp.y, my), size.y - my);
        if (tx !== cp.x || ty !== cp.y) map.panBy([cp.x - tx, cp.y - ty]);   // panBy moves the pointer to (tx,ty): new = cp − offset
      }
      // Live "Birds close by": recompute distances against the fresh position, but
      // only after moving ≥ 50 m from the last render (ignore GPS jitter / churn).
      if (nearbyIsOpen()) {
        var rk = nearbyRefPoint();
        if (rk && rk.kind === "live" &&
            (!nearbyLastRefLL || haversineKm(nearbyLastRefLL.lat, nearbyLastRefLL.lon, e.latlng.lat, e.latlng.lng) * 1000 >= 50)) {
          renderNearby();
        }
      }
    });

    setupAreaOverlays();   // protected/priority-area overlay toggles (off by default)
    loadDetections();      // restore any "Show in map" detection points
    restoreFetchedAreas(); // ...and their fetched-area outlines (per-area red × needs them)
    loadMapPoints();       // user-added pins + saved named lists (from localStorage)
    loadRoute(); updateRouteChip();   // restore the route basket + its pill
    ensureMpLayer();
    renderMapPoints();
    map.on("contextmenu", onMapContextMenu);   // right-click / long-press → add point dialog
    map.on("movestart zoomstart click", clearSpider);   // collapse the fan-out when the view changes / map is clicked
    map.on("movestart zoomstart", function () { clearTimeout(mapClickDelayTimer); });   // a pan/zoom cancels a pending tap→popup
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") clearSpider(); });
    map.on("popupopen", function () {
      closeModals();   // a map popup opened — close any open modal overlay
    });

    // The map view is transient (only needed to restore on reload) but a save()
    // re-serialises the whole state blob (incl. up to 15k plotted-detection rows).
    // Coalesce it so a burst of pans/zooms writes once, and flush on hide/unload.
    var _viewTimer = null, _pendingView = null;
    function flushView() { if (_viewTimer) { clearTimeout(_viewTimer); _viewTimer = null; } if (_pendingView) { window.GeoState.save({ view: _pendingView }); _pendingView = null; } }
    function saveViewSoon(v) { _pendingView = v; if (!_viewTimer) _viewTimer = setTimeout(flushView, 600); }
    window.addEventListener("pagehide", flushView);
    window.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flushView(); });
    map.on("moveend", function () {
      var c = map.getCenter();
      saveViewSoon({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
      // Re-rank an open species search by likelihood at the new centre.
      var sRes = document.getElementById("species-results"), sInp = document.getElementById("species-search");
      if (sRes && sInp && sRes.style.display === "block") showSearch(sInp, sRes);
      if (currentMode !== "range" && currentMode !== "richness") return;
      if (animating) return;   // don't re-render mid-animation
      schedulePaint();
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
    // Tile fetches failing (even when navigator reports "online" — captive portal /
    // dead connection) → treat like offline so the zoom cap upscales cached tiles
    // instead of leaving blank deep tiles; a successful load clears the flag.
    baseLayer.on("tileerror", function () { offlineTilesFailing = true; scheduleOfflineCheck(); });
    baseLayer.on("tileload", function () { if (offlineTilesFailing) { offlineTilesFailing = false; refreshOfflineZoomCap(); } });
    baseLayer.addTo(map);
    baseLayer.bringToBack();
    refreshOfflineZoomCap();   // if offline inside a shallow download, upscale instead of fetching missing tiles
    document.body.setAttribute("data-basemap", which);
    var sel = document.getElementById("maptype-select");
    if (sel) sel.value = which;
    window.GeoState.save({ basemap: which });
    applyLabelsOverlay();   // re-pick label style (dark/light) for the new basemap
  }
  // ---- Extra place-name labels overlay --------------------------------------
  // Carto labels-only tiles laid over the basemap. "on" = names at native zoom
  // (big win on satellite/topo, which carry few/no names). "more" = the labels of
  // the NEXT zoom level rendered into this view (tileSize 128 + zoomOffset 1), so
  // more place names show than the basemap alone.
  var labelsOverlay = null;
  function labelsMode() { return window.GeoState.get("mapLabels", "off"); }
  function applyLabelsOverlay() {
    if (labelsOverlay) { try { map.removeLayer(labelsOverlay); } catch (e) {} labelsOverlay = null; }
    var mode = labelsMode();
    if (!map || mode === "off") return;
    var bm = window.GeoState.get("basemap", "light");
    var style = (bm === "dark" || bm === "satellite") ? "dark_only_labels" : "light_only_labels";
    var opts = { attribution: "", subdomains: "abcd", maxZoom: MAX_ZOOM, maxNativeZoom: 20, noWrap: true, zIndex: 350 };
    if (mode === "more") { opts.tileSize = 128; opts.zoomOffset = 1; }   // pull in the next zoom's (denser) labels
    labelsOverlay = L.tileLayer("https://{s}.basemaps.cartocdn.com/" + style + "/{z}/{x}/{y}{r}.png", opts).addTo(map);
    try { labelsOverlay.bringToFront(); } catch (e) {}   // above basemap tiles, below data markers
  }

  // ---- Offline map areas ----------------------------------------------------
  // Download the basemap + active overlay tiles for a drawn rectangle into a
  // pinned cache (kept until the user deletes it). The SW serves them offline.
  var OFFLINE_TILE_BYTES = 22000;   // rough per-tile size for the estimate
  var OFFLINE_MAX_TILES = 12000;    // guard against an unreasonably huge download
  var offlineMaxZoom = 17;          // max zoom for area downloads — the app's deepest tile zoom (set in Settings)
  var offlineFramesLayer = null;    // frames showing downloaded areas
  var offlineEditing = false;       // true while the "Manage offline maps" modal is open
  // Open the "Manage offline maps" list modal (from Settings, or a long-press on the
  // map-download button). Shared so both entry points behave identically.
  function openOfflineManager() {
    var m = document.getElementById("offline-modal"); if (!m) return;
    closeDropdowns();
    offlineEditing = true;            // bold frames + on-map "×" delete handles
    renderOfflineAreas();             // also re-renders the frames
    m.style.display = "flex";
    navOpen("offline", function () { m.style.display = "none"; offlineEditing = false; renderOfflineFrames(); });
  }
  // Distinct border colours so adjacent downloaded areas are easy to tell apart.
  var OFFLINE_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080", "#9a6324", "#e6ab02"];
  function offlineColor(i) { return OFFLINE_COLORS[i % OFFLINE_COLORS.length]; }
  function getOfflineAreas() { return window.GeoState.get("offlineAreas", []) || []; }
  function saveOfflineAreas(a) { window.GeoState.save({ offlineAreas: a }); }
  // Ask the browser to mark our storage PERSISTENT so it isn't evicted under
  // pressure — without this, mobile browsers can clear the cached offline-map
  // tiles after a while, so they stop loading (there is no time-expiry in our
  // code). Best-effort: Chrome grants by heuristic, Firefox prompts; a denial just
  // leaves the default (evictable) state. Called on the strong "download an area"
  // signal and once at startup.
  function ensurePersistentStorage() {
    try {
      if (!(navigator.storage && navigator.storage.persist && navigator.storage.persisted)) return;
      navigator.storage.persisted().then(function (already) { if (!already) navigator.storage.persist().catch(function () {}); }).catch(function () {});
    } catch (e) {}
  }
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
      renderOfflineFrames();
    });
  }
  // A tile layer for an arbitrary basemap (not necessarily the live one), used to
  // rebuild the exact tile URLs when re-downloading a purged area.
  function offlineLayerFor(basemap) {
    var cfg = BASEMAPS[basemap] || BASEMAPS.light || BASEMAPS[Object.keys(BASEMAPS)[0]];
    return L.tileLayer(cfg.url, { maxZoom: MAX_ZOOM, maxNativeZoom: cfg.maxNativeZoom || MAX_ZOOM, subdomains: cfg.subdomains || "abc", noWrap: true });
  }
  // Re-fetch a recorded area's tiles back into its OWN pinned cache (same id), e.g.
  // after the browser evicted them. Rebuilds URLs from the stored bbox/zoom/basemap.
  function refillOfflineArea(area, onProgress, isAborted) {
    var bb = area && area.bbox; if (!bb || bb.length < 4) return Promise.resolve(-1);
    var bounds = L.latLngBounds([[bb[1], bb[0]], [bb[3], bb[2]]]);
    var urls = buildOfflineUrls(bounds, area.zStart || 0, area.zMax || area.zStart || 0, [offlineLayerFor(area.basemap)]);
    function aborted() { return !!(isAborted && isAborted()); }
    return caches.open("pinned-" + area.id).then(function (cache) {
      return new Promise(function (resolve) {
        var i = 0, active = 0, done = 0, ok = 0, total = urls.length, CONC = 6;
        function pump() {
          if ((i >= urls.length || aborted()) && active === 0) { resolve(ok); return; }
          while (active < CONC && i < urls.length && !aborted()) {
            var url = urls[i++]; active++;
            cacheOneTile(cache, url).then(function () { ok++; }).catch(function () {})
              .then(function () { active--; done++; if (onProgress) onProgress(done, total); pump(); });
          }
        }
        pump();
      });
    }).then(function (ok) {
      if (aborted()) return -1;
      var areas = getOfflineAreas();
      for (var j = 0; j < areas.length; j++) { if (areas[j].id === area.id) { areas[j].tiles = ok; areas[j].bytes = ok * OFFLINE_TILE_BYTES; break; } }
      saveOfflineAreas(areas);
      return ok;
    });
  }
  // Detect recorded areas whose tile cache is gone/empty (evicted by the browser):
  // the localStorage metadata can survive while CacheStorage is purged.
  function checkPurgedOfflineAreas() {
    var areas = getOfflineAreas();
    if (!areas.length || !window.caches) return Promise.resolve([]);
    return Promise.all(areas.map(function (a) {
      if (!(a.tiles > 0)) return Promise.resolve(null);   // nothing was stored → not a purge
      return caches.open("pinned-" + a.id).then(function (c) { return c.keys(); })
        .then(function (keys) { return keys.length === 0 ? a : null; })   // empty cache → purged
        .catch(function () { return a; });                                // cache unreadable/missing → purged
    })).then(function (res) { return res.filter(Boolean); });
  }
  // Re-download a set of purged areas, one at a time, with a status line.
  function redownloadPurgedAreas(areas) {
    ensurePersistentStorage();
    var i = 0;
    (function next() {
      if (i >= areas.length) { setStatus(t("offline.redone")); renderOfflineAreas(); renderOfflineFrames(); return; }
      var a = areas[i++];
      setStatus(t("offline.redownloading", { name: a.name }));
      refillOfflineArea(a, null, function () { return false; }).then(next, next);
    })();
  }
  // Once per session, when online, ask whether to re-download any evicted areas.
  var offlinePurgeCheckDone = false;
  function maybeAskRedownloadOffline() {
    if (offlinePurgeCheckDone || navigator.onLine === false) return;
    offlinePurgeCheckDone = true;
    checkPurgedOfflineAreas().then(function (purged) {
      if (!purged.length) return;
      modalConfirm(t("offline.purgedAsk", { n: purged.length })).then(function (ok) { if (ok) redownloadPurgedAreas(purged); });
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
    var m = createModal({ boxClass: "area-dl", backdropClose: false });   // no backdrop close mid-download
    var box = m.box, close = m.close;
    box.innerHTML =
      '<div class="ui-modal-msg">' + escapeHtml(t("offline.title")) + "</div>" +
      '<div class="area-dl-row">' + escapeHtml(t("offline.maxzoom")) + ": <b>" + zMax + "</b></div>" +
      '<div class="area-dl-est" id="area-est"></div>' +
      '<input class="ui-modal-input" id="area-name" type="text" placeholder="' + escapeHtml(t("offline.namePh")) + '">' +
      '<div class="area-dl-prog" id="area-prog" style="display:none"></div>' +
      '<div class="ui-modal-btns"><button type="button" class="demo-btn demo-btn-light" id="area-cancel">' + escapeHtml(t("btn.cancel")) + '</button>' +
        '<button type="button" class="demo-btn" id="area-go">' + escapeHtml(t("offline.download")) + "</button></div>";
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
      ensurePersistentStorage();   // downloading is strong intent — ask to keep it
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
    list.innerHTML = areas.map(function (a, i) {
      var mb = (a.bytes / 1048576).toFixed(a.bytes < 10485760 ? 1 : 0);
      return '<div class="offline-row" data-id="' + escapeHtml(a.id) + '"><span class="offline-sw" style="background:' + offlineColor(i) + '"></span><span class="offline-name" title="z' + a.zStart + "–" + a.zMax + '">' + escapeHtml(a.name) +
        '<span class="offline-purged" title="' + escapeHtml(t("offline.purged")) + '" style="display:none">⚠</span></span>' +
        '<span class="offline-meta">' + a.tiles.toLocaleString() + " · ~" + mb + " MB</span>" +
        '<button type="button" class="offline-redl ico-btn" data-id="' + escapeHtml(a.id) + '" title="' + escapeHtml(t("offline.redownload")) + '" aria-label="' + escapeHtml(t("offline.redownload")) + '">' + ico("refresh") + "</button>" +
        '<button type="button" class="dd-del offline-del" data-id="' + escapeHtml(a.id) + '" aria-label="' + escapeHtml(t("offline.delete")) + '">×</button></div>';
    }).join("");
    list.querySelectorAll(".offline-del").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = this.getAttribute("data-id"), a = getOfflineAreas().filter(function (x) { return x.id === id; })[0];
        modalConfirm(t("offline.deletePrompt", { name: a ? a.name : "" })).then(function (ok) { if (ok) deleteOfflineArea(id); });
      });
    });
    list.querySelectorAll(".offline-redl").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = this.getAttribute("data-id"), a = getOfflineAreas().filter(function (x) { return x.id === id; })[0];
        if (!a) return;
        if (navigator.onLine === false) { setStatus(t("offline.failed", { name: a.name })); return; }
        ensurePersistentStorage();
        var btn = this; btn.disabled = true; btn.classList.add("busy");
        var meta = btn.parentNode.querySelector(".offline-meta");
        refillOfflineArea(a, function (d, total) { if (meta) meta.textContent = d.toLocaleString() + " / " + total.toLocaleString(); }, function () { return false; })
          .then(function (ok) { setStatus(ok > 0 ? t("offline.saved", { name: a.name }) : t("offline.failed", { name: a.name })); renderOfflineAreas(); },
                function () { setStatus(t("offline.failed", { name: a.name })); renderOfflineAreas(); });
      });
    });
    // Flag any area whose tiles the browser has purged (async cache check).
    checkPurgedOfflineAreas().then(function (purged) {
      purged.forEach(function (a) {
        var row = list.querySelector('.offline-row[data-id="' + a.id + '"]');
        if (row) { row.classList.add("offline-row-purged"); var w = row.querySelector(".offline-purged"); if (w) w.style.display = ""; }
      });
    });
    renderOfflineFrames();
  }
  // Coloured frames on the map marking the downloaded areas. Subtle normally;
  // while the "Manage offline maps" modal is open they're bold + each carries a
  // tappable "×" at its top-right corner for direct deletion.
  function renderOfflineFrames() {
    if (!map || !L.rectangle) return;
    if (!offlineFramesLayer) offlineFramesLayer = L.layerGroup().addTo(map);
    offlineFramesLayer.clearLayers();
    getOfflineAreas().forEach(function (a, i) {
      if (!a.bbox) return;
      var col = offlineColor(i);
      var rect = L.rectangle([[a.bbox[1], a.bbox[0]], [a.bbox[3], a.bbox[2]]], offlineEditing
        ? { className: "offline-frame", color: col, weight: 2.5, opacity: 0.95, fillColor: col, fillOpacity: 0.1, interactive: false }
        : { className: "offline-frame", color: col, weight: 1, opacity: 0.55, dashArray: "4 4", fill: false, interactive: false });
      rect.addTo(offlineFramesLayer);
      if (offlineEditing) {
        var del = L.marker([a.bbox[3], a.bbox[2]], {   // NE corner (N lat, E lon)
          icon: L.divIcon({ className: "offline-x", html: "×", iconSize: [22, 22], iconAnchor: [11, 11] }),
          interactive: true, keyboard: false, title: t("offline.delete"),
        });
        del.on("click", (function (area) {
          return function (ev) {
            if (ev && ev.originalEvent) L.DomEvent.stop(ev.originalEvent);
            modalConfirm(t("offline.deletePrompt", { name: area.name })).then(function (ok) { if (ok) deleteOfflineArea(area.id); });
          };
        })(a));
        del.addTo(offlineFramesLayer);
      }
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
  var offlineTilesFailing = false;   // tiles erroring despite navigator.onLine (dead/captive connection)
  function refreshOfflineZoomCap() {
    if (!baseLayer) return;
    var cap = baseLayer._origMaxNative || MAX_ZOOM;
    if (!navigator.onLine || offlineTilesFailing) {
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
    var m = createModal({ onClose: function () { offlinePromptBusy = false; } });
    var box = m.box, close = m.close;
    box.innerHTML = '<div class="ui-modal-msg">' + escapeHtml(t("offline.coverPrompt")) + "</div>" +
      '<div class="offline-pick">' + areas.map(function (a) {
        var bm = a.basemap && a.basemap !== curBase ? " (" + escapeHtml(t("basemap." + a.basemap) || a.basemap) + ")" : "";
        return '<button type="button" class="demo-btn offline-pick-btn" data-id="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + bm + "</button>";
      }).join("") + "</div>" +
      '<div class="ui-modal-btns"><button type="button" class="demo-btn demo-btn-light" id="offc-cancel">' + escapeHtml(t("btn.cancel")) + "</button></div>";
    box.querySelector("#offc-cancel").addEventListener("click", close);
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
    // Cache fetched hotspots by a ~0.25° grid cell + distance bucket, so panning
    // around (and re-showing the layer) reuses results instead of re-querying eBird.
    var hsCache = {}, hsOrder = [];
    function hsKey(lat, lng, dist) { return (Math.round(lat * 4) / 4) + "," + (Math.round(lng * 4) / 4) + ":" + dist; }
    function hsCachePut(k, rows) {
      hsCache[k] = { rows: rows, ts: Date.now() }; hsOrder.push(k);
      while (hsOrder.length > 80) { var old = hsOrder.shift(); if (hsOrder.indexOf(old) < 0) delete hsCache[old]; }
    }
    function drawHotspots(rows, capped, c, dist) {
      grp.clearLayers();
      var minSp = hotspotMin(), shown = 0;
      (rows || []).forEach(function (h) {
        if (h.lat == null || h.lng == null) return;
        var n = h.numSpeciesAllTime || 0;
        if (minSp && n < minSp) return;   // skip trivial hotspots
        var m = L.circleMarker([h.lat, h.lng], { radius: 4 + Math.min(7, Math.round(n / 40)), color: "#8a4b12", weight: 1.5, fillColor: "#f0992e", fillOpacity: 0.85 });
        var sp = h.numSpeciesAllTime != null ? " · " + n + " " + t("layer.species") : "";
        var last = h.latestObsDt ? " · " + String(h.latestObsDt).slice(0, 10) : "";
        m.bindTooltip("<b>" + escapeHtml(h.locName || "") + "</b><span class='area-tip-sub'>" + escapeHtml(sp + last) + "</span>", { direction: "top", className: "area-tip" });
        // Click → a popup with the eBird hotspot page + a Navigate (Google Maps
        // driving directions) option. (h and m are per-iteration here.)
        var pop = document.createElement("div"); pop.className = "map-choose hs-popup";
        var hd = document.createElement("div"); hd.className = "hs-pop-head";
        hd.innerHTML = "<b>" + escapeHtml(h.locName || "") + "</b>" +
          ((sp || last) ? "<span class='hs-pop-sub'>" + escapeHtml((sp + last).replace(/^ · /, "")) + "</span>" : "");
        pop.appendChild(hd);
        pop.appendChild(makePopupBtn("eBird ↗", "demo-btn-light", function () { m.closePopup(); openExternal("https://ebird.org/hotspot/" + h.locId); }));
        pop.appendChild(makePopupBtn(t("nav.title") + " ↗", "demo-btn-light", function () { m.closePopup(); navigatePoints([{ lat: h.lat, lon: h.lng }]); }));
        m.bindPopup(pop, { closeButton: true, className: "choose-popup", offset: [0, -4] });
        grp.addLayer(m); shown++;
      });
      // eBird caps a query at 500 km, so when the view is bigger the hotspots only
      // cover a 500 km radius round the centre — draw that boundary + say so, so the
      // partial coverage is clear rather than confusing.
      if (capped) {
        grp.addLayer(L.circle([c.lat, c.lng], { radius: dist * 1000, color: "#8a4b12", weight: 1.5, dashArray: "6 5", fill: false, interactive: false }));
        setStatus(t("layer.hotspotsCapped"));
      } else if (!shown) {
        setStatus(t("layer.hotspotsNone"));
      }
    }
    function load() {
      var key = ebirdKey();
      if (!key) { grp.clearLayers(); setStatus(t("layer.hotspotsKey")); return; }
      var c = map.getCenter(), b = map.getBounds();
      var radius = Math.round(haversineKm(c.lat, c.lng, b.getNorth(), b.getEast()));
      var capped = radius > 500;
      var dist = Math.min(500, Math.max(10, Math.ceil(radius / 25) * 25));   // 25 km buckets → cache-friendly
      var ck = hsKey(c.lat, c.lng, dist);
      var cached = hsCache[ck];
      if (cached && (Date.now() - cached.ts) < 3600000) { drawHotspots(cached.rows, capped, c, dist); return; }   // 1 h TTL
      var mine = ++tok;
      var url = "https://api.ebird.org/v2/ref/hotspot/geo?lat=" + c.lat.toFixed(4) + "&lng=" + c.lng.toFixed(4) + "&dist=" + dist + "&fmt=json";
      fetch(url, { headers: { "X-eBirdApiToken": key } })
        .then(function (r) { if (!r.ok) { var er = new Error("HTTP " + r.status); er.status = r.status; throw er; } return r.json(); })
        .then(function (rows) {
          if (mine !== tok || !active) return;
          hsCachePut(ck, rows || []);
          drawHotspots(rows, capped, c, dist);
        }).catch(function (e) {
          if (!active) return;
          grp.clearLayers();
          // 401/403 = eBird rejected the key (invalid/expired). Point the user at it
          // rather than showing a raw "HTTP 403".
          if (e.status === 401 || e.status === 403) setStatus(t("layer.hotspotsKeyBad"));
          else setStatus(t("status.error", { msg: "eBird hotspots " + e.message }));
        });
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
  // Per-species family, harvested from GBIF occurrences (the one source that
  // returns it) and persisted, so a species keeps its family — and thus its
  // colour hue — on later fetches/sources (eBird, iNaturalist) that omit it.
  var famIndex = (window.GeoState && window.GeoState.get("detFamilies", {})) || {};
  function saveFamIndex() { try { window.GeoState.save({ detFamilies: famIndex }); } catch (e) {} }
  function recordFamily(key, fam) {
    fam = (fam || "").trim();
    if (!key || !fam || famIndex[key] === fam) return false;
    famIndex[key] = fam; return true;   // caller persists once per batch
  }
  // Stable non-negative hash of a string.
  function strHash(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  // Species with no known family yet get a distinct colour assigned on first
  // sight and held in memory for THIS session only (cleared on reload), so
  // several unfamilied species don't all look alike. Golden-angle hues spread
  // them around the wheel; the lower saturation hints they're provisional
  // versus the family-coloured ones. Once GBIF supplies the family on a later
  // fetch, the species switches to its family hue and this entry is dropped.
  // A family's base hue is a deterministic function of its NAME (golden-angle
  // hashed round the wheel), and a species' shade/saturation a deterministic
  // function of its key — so the same species draws the same colour on every
  // device, independent of which other species happen to be plotted. (An earlier
  // even-spread over the locally-plotted families gave nicer separation but made
  // colours differ across devices, which the user needs to be stable.)
  function famHue(f) { return Math.round(strHash("fam:" + f) * 137.508) % 360; }
  function keyHue(k) { return Math.round(strHash("key:" + k) * 137.508) % 360; }
  // Recompute every plotted species' colour. Species within a family share its
  // hue band but vary in shade and saturation so they stay distinguishable; a
  // species whose family isn't known yet gets a stable per-key hue (still the
  // same on every device). Run whenever the plotted set changes or a family is
  // newly learned from GBIF — so a dot snaps to its family's hue the moment GBIF
  // supplies the family.
  function recolorDetections() {
    Object.keys(detPlot).forEach(function (k) {
      var f = famIndex[k] || "";
      if (f) {
        var hue = (famHue(f) + (strHash("h:" + k) % 7) - 3 + 360) % 360;          // ±3° jitter within the family band
        detPlot[k].color = "hsl(" + hue + ", " + (48 + strHash("a:" + k) % 26) + "%, " + (40 + strHash("s:" + k) % 24) + "%)";
      } else {
        detPlot[k].color = "hsl(" + keyHue(k) + ", 35%, 52%)";   // no family yet → a stable, distinct per-species colour
      }
    });
  }
  var detPlot = {};     // speciesKey -> { key, name (fallback), color, rows, group }
  var detFocusKey = null;   // legend hover: this species keeps colour, the rest grey out
  var detFocusObs = null;   // legend hover on an observer name: show only that observer's records
  var detProb = Object.create(null);   // species key -> max habitat-model probability over its observations (drives legend order)
  var detProbSig = "";      // the plotted-set signature detProb was computed for
  var detProbBusy = false;  // an inference pass is in flight
  var detDupHidden = new Set();   // rows hidden as cross-database duplicates (dedup setting)
  var detDupSig = "";             // plotted-set + setting signature detDupHidden was computed for
  function dedupDetections() { return window.GeoState.get("dedupDetections", false) === true; }
  var detLegend = null;
  // Legend-driven visibility: dots always draw in their species colour. Click a
  // legend row to "select" it — that isolates the selected species (the rest are
  // hidden); with nothing selected every species shows, in colour.
  var detSelected = {};
  // "Starred only" filter, driven by the legend dropdown: when on, the legend
  // lists (and the map shows) only the species the user has starred.
  var detStarFilter = false;
  var detRareFilter = false;            // legend "Rare" filter: show only locally-rare species
  var detYearFilter = false;            // legend "needs" filter: only species NOT on this year's list
  // Observer filter (legend 👤): null = all observers; else a Set of selected
  // SINGLE observer names ("" = the "no observer" bucket). A per-RECORD filter
  // (unlike the per-species ones), applied where rows are drawn / listed.
  // Observer fields often concatenate several names (e.g. "A | B; C"); the
  // checklist lists the single names, and a record matches if any selected name
  // is a SUBSTRING of its observer string.
  var detObsFilter = null;              // Set of selected names (incl "") or null
  var detObsNames = [];                 // selected non-empty names = substring needles
  var detObsAllowNone = false;          // is "(no observer)" selected
  var detObsPanelOpen = false;          // is the observer checklist showing (transient)
  var detDaysPanelOpen = false;         // is the time-window (days/range) subwindow showing
  var detModePanelOpen = false;         // is the species (★/◉/🟡) subwindow showing
  // The three legend subwindows are mutually exclusive — opening one closes the
  // others so they don't stack on top of the small legend.
  function openDetPanel(which) {
    detDaysPanelOpen = which === "days" ? !detDaysPanelOpen : false;
    detModePanelOpen = which === "mode" ? !detModePanelOpen : false;
    detObsPanelOpen = which === "obs" ? !detObsPanelOpen : false;
  }
  // Some "observer" values are organisation/source tags, not people. They're
  // dropped from the checklist; a record left with only tags counts as "no
  // observer". (Matched case-insensitively, trimmed.)
  var OBS_TAGS = (function () { var m = Object.create(null); ["BirdLife OA"].forEach(function (t) { m[t.toLowerCase()] = 1; }); return m; })();
  function isObsTag(n) { return !!OBS_TAGS[String(n || "").trim().toLowerCase()]; }
  function detObsSplit(s) { return String(s || "").split(/\s*[|;]\s*/).map(function (x) { return x.trim(); }).filter(Boolean); }
  function detObsRealNames(s) { return detObsSplit(s).filter(function (n) { return !isObsTag(n); }); }   // single names, tags removed
  function setDetObsFilter(set) {
    detObsFilter = set || null; detObsNames = []; detObsAllowNone = false;
    if (detObsFilter) detObsFilter.forEach(function (n) { if (n) detObsNames.push(n); else detObsAllowNone = true; });
  }
  function detObsPasses(r) {
    if (detDupHidden.has(r)) return false;   // hidden cross-database duplicate (dedup setting)
    if (detFocusObs) return (r.observer || "").indexOf(detFocusObs) >= 0;   // legend hover isolates one observer
    if (!detObsFilter) return true;
    var obs = (r.observer || "").trim();
    if (!detObsRealNames(obs).length) return detObsAllowNone;   // empty, or only tags → "no observer" bucket
    for (var i = 0; i < detObsNames.length; i++) if (obs.indexOf(detObsNames[i]) >= 0) return true;   // substring match
    return false;
  }
  function detPassesStar(k) { return !detStarFilter || isInteresting((detPlot[k] && detPlot[k].key) || k); }
  function detPassesYear(k) { return !detYearFilter || !inYearList((detPlot[k] && detPlot[k].key) || k); }
  // "Rare locally": a plotted species whose detection count is at most rarePct%
  // of the commonest plotted species' count (default 10%). detRareMax is cached
  // and refreshed before each render (recomputeRareMax) so detIsRare is O(1).
  function rarePct() { var p = +window.GeoState.get("rarePct", 5); return (p > 0 && p <= 100) ? p : 5; }
  var detRareMax = 0;
  function recomputeRareMax() {
    detRareMax = 0;
    Object.keys(detPlot).forEach(function (k) { var n = (detPlot[k].rows || []).length; if (n > detRareMax) detRareMax = n; });
  }
  function detIsRare(k) { var e = detPlot[k]; return !!e && detRareMax > 0 && (e.rows || []).length <= rarePct() / 100 * detRareMax; }
  function detPassesRare(k) { return !detRareFilter || detIsRare(k); }
  // Taxonomic class of a plotted species: model species via the taxonomy table,
  // "extra" species (x:…) carry their own class on the detPlot entry (stored at
  // plot time). Used to honour the Settings "Species group" filter in the legend.
  function detClassOf(k) {
    if (k && k.indexOf("x:") === 0) { var e = detPlot[k]; return (e && e.cls) || ""; }
    return (taxByCode[k] && taxByCode[k].class_name) || "";
  }
  function detPassesGroup(k) { return speciesGroup === "all" || String(detClassOf(k)).toLowerCase() === String(speciesGroup).toLowerCase(); }
  var mapClickGuardUntil = 0;   // onMapClick ignores clicks before this time; each accepted click re-arms it (200 ms debounce), legend re-renders set a longer window
  var mapPtrDownTs = 0, mapPtrIsTouch = false;   // last map pointer-down time + whether it was touch (press-duration gating)
  function touchHeldMs() { return Date.now() - mapPtrDownTs; }   // how long the current touch has been held
  var mapClickDelayTimer = null;   // pending touch-tap → point-popup open (cancelled by a pan/zoom in the delay window)
  function detSelectionActive() { return Object.keys(detSelected).some(function (k) { return detPlot[k] && detPassesStar(k) && detPassesGroup(k) && detPassesRare(k) && detPassesYear(k); }); }
  // `selActive` lets a render loop compute detSelectionActive() ONCE and pass it
  // in, instead of this re-scanning all selected keys for every species.
  function detIsVisible(key, selActive) {
    if (selActive === undefined) selActive = detSelectionActive();
    return !isHidden((detPlot[key] && detPlot[key].key) || key) && detPassesStar(key) && detPassesGroup(key) && detPassesRare(key) && detPassesYear(key) && (!selActive || !!detSelected[key]);
  }
  // Dots are always shown in their species colour (no grey overview mode) — so
  // "all"/"1 day"/etc. all render coloured. Visibility (above) does the filtering.
  var DET_MUTE_COLOR = "#9aa3a0";   // still used for hidden rows' legend swatch
  function detSlim(rows) {
    return (rows || []).filter(function (r) { return r.lat != null && r.lon != null; })
      .map(function (r) { return { lat: +r.lat, lon: +r.lon, url: r.url || "", date: r.date || "", src: r.src || "", origin: r.origin || "", place: r.place || "", count: (r.count != null ? r.count : ""), act: r.act || "", note: String(r.note || "").slice(0, 160), observer: r.observer || "" }; });
  }
  // Localized display name for a plotted species (re-derived from the key so it
  // follows the UI language); falls back to the name stored at plot time.
  // The stored name (e.name) is captured from the source in the user's locale —
  // run it through speciesCase too so extras/locale-keyed species follow the
  // same lower-case convention as model species (e.g. Norwegian "Møller"→"møller").
  function detName(e) {
    var lbl = labelsByKey[e.key];
    if (lbl) return speciesName(lbl);
    // Extra stored under "x:<sci>" — re-resolve to a model species by scientific
    // name (or class-aware epithet) so it localises to the current UI language
    // instead of showing the capture-locale name (e.g. Norwegian "hønsehauk").
    if (e.key && e.key.indexOf("x:") === 0) {
      var sci = e.key.slice(2);
      var l2 = AppAggregate.ensureSciIndex()[sci.toLowerCase()] || AppAggregate.labelBySciEpithet(sci, e.cls) || AppAggregate.labelBySciGenus(sci, e.cls);
      if (l2) return speciesName(l2);
    }
    return speciesCase(lang, e.name || (e.key && e.key.indexOf("x:") === 0 ? e.key.slice(2) : e.key));
  }
  // Detection-list display name with the optional 2nd language in parentheses,
  // e.g. "bokfink (Chaffinch)". Falls back to the plain primary name when there's
  // no 2nd language, no model label (extras), or the two names coincide.
  function detListName(key, primary) {
    var nm = primary || "";
    if (secondLang && key) {
      var lbl = labelsByKey[key];
      if (lbl) { var s2 = secondName(lbl); if (s2 && s2.toLowerCase() !== nm.toLowerCase()) nm += " (" + s2 + ")"; }
    }
    return nm;
  }
  // Legend / list swatch: a coloured ★ for starred species, a coloured dot with a
  // black centre for locally-rare species, a star-with-centre-dot when both, else
  // a plain coloured dot.
  // "needs" ring class for a swatch — a yellow halo mirroring the map dots'
  // edge: thick (life-list miss) or thin (this-year miss). Applied wherever a
  // species swatch is shown so the year/life "needs" cue is consistent.
  function detNeedClass(key) {
    if (!key) return "";
    if (lifeListActive() && !inLifeList(key)) return " det-need-life";
    if (yearListActive() && !inYearList(key)) return " det-need-year";
    return "";
  }
  function detSwatch(color, starred, rare, key) {
    var need = detNeedClass(key);
    if (starred) return '<span class="det-sw det-sw-star' + need + '" style="color:' + color + '">★' + (rare ? '<i class="det-ctr-dot"></i>' : "") + "</span>";
    if (rare) return '<span class="det-sw det-sw-rare' + need + '" style="background:' + color + '"><i class="det-ctr-dot"></i></span>';
    return '<span class="det-sw' + need + '" style="background:' + color + '"></span>';
  }
  // Recency filter (days) for plotted detections. 0 = no filter.
  function detRecencyDays() { return +window.GeoState.get("detRecencyDays", 30); }
  function recentEnough(dateStr, maxDays) {
    if (!maxDays) return true;            // 0/"All" = no filter
    if (!dateStr) return false;           // unknown date → exclude when filtering
    var t = Date.parse(dateStr); if (isNaN(t)) return false;
    return (Date.now() - t) / 86400000 <= maxDays;
  }
  // Absolute from–to date range (YYYY-MM-DD), an alternative to the rolling "last
  // N days" window. Null when neither end is set. When a range is active it takes
  // precedence over the days preset.
  function detDateRange() {
    var r = window.GeoState.get("detDateRange", null);
    return (r && (r.from || r.to)) ? { from: r.from || "", to: r.to || "" } : null;
  }
  // The single time predicate every plotted detection passes through: a set date
  // range if one is active, else the rolling recency window.
  function detDatePasses(dateStr) {
    var rg = detDateRange();
    if (rg) {
      var d = String(dateStr || "").slice(0, 10);
      if (!d) return false;
      if (rg.from && d < rg.from) return false;
      if (rg.to && d > rg.to) return false;
      return true;
    }
    return recentEnough(dateStr, detRecencyDays());
  }
  // Cap on how many detection dots are DRAWN at once (markers are the draw-speed
  // bottleneck). Data is never dropped — the rest still show in the Detections
  // list and sync normally; only the map render is limited to the newest N.
  function detMaxPoints() { var n = +window.GeoState.get("maxMapPoints", 5000); return (n > 0) ? n : 5000; }
  // Map-tile cache buffer (LRU) in MB, enforced by the service worker. One of
  // the fixed steps; default 5 MB. Pushed to the SW on load and on change.
  // One shared "Map cache" budget (MB) covers BOTH the map-tile cache (in the
  // service worker's CacheStorage — the bulk) and the computed H3 range cache.
  // The range cache lives in localStorage, which browsers hard-cap at ~5 MB, so
  // it takes a small carved-out slice; the tiles get the rest. Both evict
  // least-recently-used first, so the total never exceeds the chosen size.
  var MAP_CACHE_STEPS = [0, 25, 100, 250, 500];
  function mapCacheMB() {
    var saved = window.GeoState.get("mapCacheMB", null);
    if (saved != null && MAP_CACHE_STEPS.indexOf(+saved) >= 0) return +saved;
    var old = +window.GeoState.get("tileCacheMB", 100) || 0;   // migrate from the old separate tile setting
    if (old <= 0) return 0;
    return [25, 100, 250, 500].reduce(function (a, b) { return Math.abs(b - old) < Math.abs(a - old) ? b : a; }, 25);
  }
  function h3BudgetMB() { return Math.min(5, mapCacheMB()); }            // small localStorage slice of the shared pool
  function tileCacheMB() { return Math.max(0, mapCacheMB() - h3BudgetMB()); }   // the rest goes to map tiles
  function sendTileCap() {
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller)
        navigator.serviceWorker.controller.postMessage({ type: "tileCacheMB", mb: tileCacheMB() });
    } catch (e) {}
  }
  // Storage-usage readout for Settings. localStorage (the app data — lists,
  // detections, settings) is summed directly (×2 for UTF-16); total origin usage
  // + quota come from the StorageManager (covers the map-cache pool + tiles).
  function fmtBytes(n) {
    if (!isFinite(n) || n < 0) return "—";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
    if (n >= 1e6) return (n / 1e6).toFixed(0) + " MB";
    return Math.max(1, Math.round(n / 1e3)) + " KB";
  }
  function localStorageBytes() {
    var n = 0;
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); n += (k.length + (localStorage.getItem(k) || "").length) * 2; } } catch (e) {}
    return n;
  }
  function renderStorageUsage() {
    var el = document.getElementById("storage-usage"); if (!el) return;
    var app = fmtBytes(localStorageBytes());
    el.textContent = t("ctrl.storageLine", { app: app, used: "…", quota: "…" });
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        var e2 = document.getElementById("storage-usage"); if (!e2) return;
        e2.textContent = t("ctrl.storageLine", { app: app, used: fmtBytes(est.usage || 0), quota: fmtBytes(est.quota || 0) });
      }).catch(function () { el.textContent = t("ctrl.storageLine", { app: app, used: "—", quota: "—" }); });
    } else {
      el.textContent = t("ctrl.storageLine", { app: app, used: "—", quota: "—" });   // no StorageManager
    }
  }
  // All rows that WOULD be drawn (visible species, passing the recency filter).
  function eachDrawableRow(fn) {
    var selActive = detSelectionActive();
    Object.keys(detPlot).forEach(function (k) {
      // Mirror rebuildDetLayers' visibility: a legend hover (detFocusKey) isolates
      // one species and overrides the selection, so the draw-cap set matches what's
      // actually drawn — otherwise a focused-but-unselected species' rows fall
      // outside `allowed` and render empty.
      if (detFocusKey) { if (k !== detFocusKey) return; }
      else if (!detIsVisible(k, selActive)) return;
      var spKey = (detPlot[k] && detPlot[k].key) || k;
      (detPlot[k].rows || []).forEach(function (r) { if (detDatePasses(r.date)) fn(r, spKey); });
    });
  }
  function detDrawableCount() { var n = 0; eachDrawableRow(function () { n++; }); return n; }
  // The set of row objects allowed on the map: the newest detMaxPoints() across
  // all visible species. Returns null when under the cap (draw everything).
  // Year/life-list "needs" species (the yellow-bordered ones) are ALWAYS kept —
  // they're the whole point of plotting, so the newest-N cap must never drop them
  // in favour of commoner species' dots (which would hide them on the map while
  // they still showed in the legend). The rest of the budget is the newest of all.
  function detDrawAllowed() {
    var cap = detMaxPoints(), all = [], must = [];
    eachDrawableRow(function (r, key) { if (detNeedWeight(key)) must.push(r); else all.push(r); });
    if (must.length + all.length <= cap) return null;
    all.sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });   // newest first
    var allowed = new Set(must);                                                        // needs species always drawn
    for (var i = 0; i < all.length && allowed.size < cap; i++) allowed.add(all[i]);
    return allowed;
  }
  // Source label for a row: the GBIF origin dataset (shortened) when present,
  // else the raw source tag (eBird / iNaturalist / Checklist …).
  function srcLabel(r) { return (r.src === "GBIF" && r.origin) ? shortOrigin(r.origin) : (r.src || ""); }
  // Every detection currently shown under the legend (its star / row-selection
  // and recency filters), flattened to one entry per observation row. This is the
  // exact set of dots on the map, so the list always matches what's visible.
  // `near` (optional) = { lat, lon, meters }: restrict to rows within that radius
  // of a clicked dot. Without it, every visible detection on the map is returned.
  function collectVisibleDetections(near) {
    ensureDedup();
    var out = [];
    var center = near ? L.latLng(near.lat, near.lon) : null;
    // Cheap bounding-box half-widths (deg) for the radius test — reject far rows
    // with plain float compares before the per-row L.latLng alloc + haversine.
    var dLat = 0, dLon = 0;
    if (center) { dLat = near.meters / 111320; var cs = Math.cos(near.lat * Math.PI / 180); dLon = near.meters / (111320 * (Math.abs(cs) > 1e-6 ? Math.abs(cs) : 1e-6)); }
    var selActive = detSelectionActive();
    Object.keys(detPlot).forEach(function (k) {
      if (!detIsVisible(k, selActive)) return;
      var e = detPlot[k], nm = detName(e);
      (e.rows || []).forEach(function (r) {
        if (!detDatePasses(r.date)) return;
        if (!detObsPasses(r)) return;          // observer filter (legend 👤)
        if (center) {
          if (Math.abs(r.lat - near.lat) > dLat || Math.abs(r.lon - near.lon) > dLon) return;   // bbox reject (cheap)
          if (map.distance(center, L.latLng(r.lat, r.lon)) > near.meters) return;
        }
        out.push({ key: k, name: nm, color: e.color, lat: r.lat, lon: r.lon, date: r.date || "", src: r.src || "", origin: r.origin || "", url: r.url || "", place: r.place || "", count: (r.count != null ? r.count : ""), act: r.act || "", note: r.note || "", observer: r.observer || "", listName: r._listName || "", mpId: r._mpId || "" });
      });
    });
    return out;
  }
  // ── "Birds close by" — a full-page list of the plotted detections, sorted by
  // distance from the active reference point (blue live cross → red fixed cross →
  // placed pin → map centre). Toggles with the map; toggling back fits the map to
  // the shown detections. Count is configurable in Settings; text is kept large.
  var nearbyShownRows = [];
  // GPS follow is suspended (not stopped for good) while viewing a detection picked
  // from the Close by list — resumed when the list is reopened or toggled to map.
  var nearbyFollowSuspended = false;
  function resumeNearbyFollow() { if (nearbyFollowSuspended) { nearbyFollowSuspended = false; setCrosshairState(1); } }
  var nearbyLastRefLL = null;          // the reference lat/lon used for the last render (live-mode 50 m recalc gate)
  function nearbyCount() { var n = +window.GeoState.get("nearbyCount", 25); return (n > 0 && n <= 500) ? n : 25; }
  function nearbyInclPoints() { return window.GeoState.get("nearbyInclPoints", false) === true; }
  // Active (shown) map points to fold into the list: the working pins (respecting
  // the tag filter) plus shown saved-list points that AREN'T detections — a list's
  // detection points already come through collectVisibleDetections via detPlot.
  function nearbyMapPoints() {
    var out = [];
    (mapPoints || []).forEach(function (p) {
      if (p && isFinite(p.lat) && isFinite(p.lon) && mpVisible(p)) out.push({ point: true, name: p.name || t("nearby.point"), lat: +p.lat, lon: +p.lon });
    });
    (mpCollections || []).forEach(function (c) {
      if (!shownColls[c.name]) return;
      (c.points || []).forEach(function (p) {
        if (p && !p.spKey && isFinite(p.lat) && isFinite(p.lon)) out.push({ point: true, name: p.name || c.name || t("nearby.point"), lat: +p.lat, lon: +p.lon });
      });
    });
    return out;
  }
  function nearbyRefPoint() {
    var m = posMarker || posFixedMarker || marker || placeMarker;   // live blue → fixed red → pin
    if (m && m.getLatLng) { var ll = m.getLatLng(); return { lat: ll.lat, lon: ll.lng, kind: m === posMarker ? "live" : (m === posFixedMarker ? "fixed" : "pin") }; }
    if (map) { var c = map.getCenter(); return { lat: c.lat, lon: c.lng, kind: "center" }; }
    return null;
  }
  function nearbyFmtDist(km) { return km < 1 ? Math.round(km * 1000) + " m" : (km < 10 ? km.toFixed(1) : Math.round(km)) + " km"; }
  // "n(Nd)" behind the species name: n = count for that observation (blank if
  // unknown), Nd = days since it. Empty for map-point rows.
  function nearbyMeta(r) {
    if (r.point) return "";
    var n = (r.count !== "" && r.count != null) ? String(r.count) : "";
    var dstr = String(r.date || "").slice(0, 10);                 // date portion only
    var ts = dstr ? Date.parse(dstr + "T00:00:00") : NaN;         // local midnight → whole calendar days
    var d = isNaN(ts) ? "" : "(" + Math.max(0, Math.floor((Date.now() - ts) / 86400000)) + "d)";
    return n + d;
  }
  function nearbyData() {
    var ref = nearbyRefPoint(); if (!ref) return { ref: null, rows: [] };
    var rows = collectVisibleDetections(null).filter(function (r) { return isFinite(+r.lat) && isFinite(+r.lon); });
    if (nearbyInclPoints()) rows = rows.concat(nearbyMapPoints());   // fold in active map points
    rows.forEach(function (r) { r._dist = haversineKm(ref.lat, ref.lon, +r.lat, +r.lon); });
    rows.sort(function (a, b) { return a._dist - b._dist; });
    return { ref: ref, rows: rows.slice(0, nearbyCount()) };
  }
  function renderNearby() {
    var body = document.getElementById("nb-list"); if (!body) return;
    var refEl = document.getElementById("nb-ref");
    var d = nearbyData();
    nearbyShownRows = d.rows;
    nearbyLastRefLL = d.ref ? { lat: d.ref.lat, lon: d.ref.lon } : null;
    if (refEl) refEl.textContent = d.ref ? (t("nearby.from") + " " + t("nearby.ref." + d.ref.kind)) : "";
    if (!d.rows.length) { body.innerHTML = '<p class="nb-empty">' + escapeHtml(t("nearby.empty")) + "</p>"; return; }
    body.innerHTML = d.rows.map(function (r, i) {
      var sw = r.point
        ? '<span class="nb-sw nb-sw-point">📍</span>'                                   // 📍 marks a saved map point
        : '<span class="nb-sw" style="background:' + escapeHtml(r.color || "#888") + '"></span>';
      var meta = nearbyMeta(r);
      return '<button type="button" class="nb-row' + (r.point ? " nb-row-point" : "") + '" data-i="' + i + '">' +
        sw + '<span class="nb-namewrap"><span class="nb-name">' + escapeHtml(r.name) + "</span>" +
        (meta ? '<span class="nb-meta">' + escapeHtml(meta) + "</span>" : "") + "</span>" +
        '<span class="nb-dist">' + escapeHtml(nearbyFmtDist(r._dist)) + "</span></button>";
    }).join("");
    body.querySelectorAll(".nb-row").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var r = nearbyShownRows[+this.getAttribute("data-i")]; if (!r) return;
        if (crossState === 1) { setCrosshairState(0); nearbyFollowSuspended = true; }   // suspend follow while viewing this observation (else the next fix recentres away)
        closeNearby(false);
        if (map) map.setView([+r.lat, +r.lon], Math.max(map.getZoom(), 14));
      });
    });
    fitNearbyNames();
  }
  // Shrink each species name's font just enough to fit on one line (no ellipsis) —
  // CSS can't fit-text-to-width. Needs the page to be laid out (non-zero widths).
  function fitNearbyNames() {
    var body = document.getElementById("nb-list"); if (!body) return;
    body.querySelectorAll(".nb-name").forEach(function (el) {
      el.style.fontSize = "";                                  // back to the CSS clamp base
      var avail = el.clientWidth, full = el.scrollWidth;
      if (avail > 0 && full > avail) {
        var base = parseFloat(getComputedStyle(el).fontSize) || 24;
        var size = Math.max(11, Math.floor(base * avail / full));
        el.style.fontSize = size + "px";
        if (el.scrollWidth > el.clientWidth) el.style.fontSize = Math.max(11, size - 1) + "px";   // rounding guard
      }
    });
  }
  function nearbyIsOpen() { var p = document.getElementById("nearby-page"); return !!p && p.style.display !== "none"; }
  function openNearby() {
    resumeNearbyFollow();   // reopening the list ends the "viewing a detection" state → follow resumes
    var p = document.getElementById("nearby-page"); if (p) p.style.display = "flex";   // show first so names can be measured/fitted
    document.body.setAttribute("data-nearby", "1");
    renderNearby();
  }
  function closeNearby(fit) {
    var p = document.getElementById("nearby-page"); if (p) p.style.display = "none";
    document.body.removeAttribute("data-nearby");
    if (!map) return;
    map.invalidateSize();
    if (fit && nearbyShownRows.length) {
      var pts = nearbyShownRows.map(function (r) { return [+r.lat, +r.lon]; });
      var ref = nearbyRefPoint(); if (ref) pts.push([ref.lat, ref.lon]);
      try { if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 13)); else map.fitBounds(L.latLngBounds(pts).pad(0.25)); } catch (e) {}
    }
  }
  function toggleNearby() { if (nearbyIsOpen()) closeNearby(true); else openNearby(); }
  var detListSort = "time";            // "time" (date sections) | "species" (per-species rows)
  var detListOpenSp = {};              // species keys expanded in the by-species view
  var detListNear = null;              // location scope: a clicked dot's { lat, lon, meters } (null = whole map)
  var detListQuery = "";               // fuzzy species-name filter for the list
  var detListLastRows = [];            // the exact rows currently shown (for "Save as list")
  // Forgiving filter for the Detections list (named detFuzzy to avoid the other
  // fuzzyMatch() defined later, which would shadow this one): every
  // whitespace-separated piece of the query must appear somewhere in the text
  // (order-independent) — "swal", "barn swal", "swal barn" all match — with a
  // spaces-ignored subsequence fallback so "brnswl" still matches.
  // Tier 1 — "exact"-ish: every whitespace-separated token of the query is a
  // literal substring of the text (order-independent): "swal", "barn swal" match.
  function detExactMatch(q, text) {
    q = String(q || "").toLowerCase().trim(); text = String(text || "").toLowerCase();
    if (!q) return true;
    return q.split(/\s+/).every(function (tok) { return text.indexOf(tok) >= 0; });
  }
  // Tier 2 — partial: the exact match, or a spaces-ignored subsequence so a
  // skip-typed "brnswl" still finds "Barn Swallow".
  function detFuzzy(q, text) {
    if (detExactMatch(q, text)) return true;
    var qc = String(q || "").toLowerCase().replace(/\s+/g, ""), tc = String(text || "").toLowerCase().replace(/\s+/g, ""), qi = 0;
    if (!qc) return true;
    for (var i = 0; i < tc.length && qi < qc.length; i++) { if (tc.charAt(i) === qc.charAt(qi)) qi++; }
    return qi === qc.length;
  }
  // Everything a species can be matched against: the displayed (localised) name,
  // plus its English common name and scientific name — so a Norwegian-language
  // list still finds "Bluethroat" / "Luscinia svecica".
  function detSearchText(d) {
    var parts = [d.name || ""], lbl = labelsByKey[d.key];
    if (lbl) { if (lbl.common) parts.push(lbl.common); if (lbl.sci) parts.push(lbl.sci); }
    else if (d.key && d.key.indexOf("x:") === 0) parts.push(d.key.slice(2));   // extras: sci name is in the key
    return parts.join(" ");
  }
  // Open the consolidated detections list. Clicking a plotted dot scopes it to
  // that spot (`near`); the legend's list button opens it for the whole map.
  function openDetListModal(near) {
    var m = document.getElementById("detlist-modal");
    if (!m) return;
    detListNear = near || null;
    detListOpenSp = {};
    detListQuery = "";
    var si = document.getElementById("detlist-search"); if (si) si.value = "";
    m.style.display = "flex";
    navOpen("detlist", function () { closeDetRowMenu(); m.style.display = "none"; });
    renderDetListModal();
  }
  // One record row: colour swatch, species name, meta (date? + source). Clicking
  // it opens a small menu (star, add the point to a named list, open the source)
  // — see showDetRowMenu. The needed fields ride along as data-attributes.
  function detRowHtml(d, showDate) {
    // Per record: name on top, then small grey sub-lines below it — the activity
    // (where present) and the observation note (where present), each on its own
    // line; the meta column carries date · ×individuals · source.
    var al = d.act ? actLabel(d.act) : "";
    var note = String(d.note || "").trim();
    var meta, subLines;
    if (d.src === "BirdWeather") {
      // The station name/#id is shown in the date-section HEADER (in the slot the
      // observer name uses for other sources), NOT here next to the species. So the
      // species row carries only the count-prefixed source; no sub-line.
      meta = [showDate ? fmtDate(d.date) : "", "×" + (d.count || 1) + " BirdWeather"].filter(Boolean).join(" · ");
      subLines = "";
    } else {
      meta = [showDate ? fmtDate(d.date) : "",
        (d.count != null && d.count !== "") ? "×" + d.count : "",
        srcLabel(d)].filter(Boolean).join(" · ");
      subLines =
        (al ? '<span class="dl-sub" title="' + escapeHtml(al) + '">' + escapeHtml(al) + "</span>" : "") +
        (note ? '<span class="dl-sub dl-note" title="' + escapeHtml(note) + '">' + escapeHtml(note) + "</span>" : "");
    }
    var nameBlock = '<span class="dl-name-wrap"><span class="dl-sp">' + escapeHtml(detListName(d.key, d.name)) + "</span>" + subLines + "</span>";
    var inner = detSwatch(d.color || "#888", isInteresting(d.key), detIsRare(d.key), d.key) +
      nameBlock +
      '<span class="dl-meta">' + escapeHtml(meta) + "</span>";
    var attrs = ' data-key="' + escapeHtml(d.key) + '" data-name="' + escapeHtml(d.name) +
      '" data-lat="' + (d.lat == null ? "" : d.lat) + '" data-lon="' + (d.lon == null ? "" : d.lon) +
      '" data-url="' + escapeHtml(d.url || "") +
      '" data-date="' + escapeHtml(d.date || "") + '" data-act="' + escapeHtml(d.act || "") +
      '" data-note="' + escapeHtml(String(d.note || "")) +
      '" data-listname="' + escapeHtml(d.listName || "") + '" data-mpid="' + escapeHtml(d.mpId || "") + '"';   // listName/mpId present only for records that came from a saved list
    var hasLoc = d.lat != null && !isNaN(+d.lat) && d.lon != null && !isNaN(+d.lon);
    // An always-visible 🎯 that focuses the map on this record (a span, not a
    // nested button — the row itself is the button that opens the full menu).
    var focusBtn = hasLoc ? '<span class="dl-focus" role="button" title="' + escapeHtml(t("detmenu.focusMap")) + '" aria-label="' + escapeHtml(t("detmenu.focusMap")) + '" data-lat="' + d.lat + '" data-lon="' + d.lon + '">' + ico("target") + "</span>" : "";
    return '<button type="button" class="dl-row dl-row-menu"' + attrs + ">" + inner + focusBtn +
      '<span class="dl-go">' + (d.url ? "↗" : "⋯") + "</span></button>";
  }
  // Add a map point to a named point-list (creating the list if needed). When the
  // Add a point straight onto a named list (creating it if new). The list is
  // shown via its checkbox — never duplicated into the always-drawn loose set.
  function addPointToCollection(name, point) {
    name = String(name || "").trim(); if (!name) return false;
    var c = mpCollections.filter(function (x) { return x.name === name; })[0];
    if (!c) { c = { name: name, points: [] }; mpCollections.push(c); }
    c.points.push(point);
    shownColls[c.name] = true;   // tick the list so the just-added point is visible (it's hidden otherwise)
    saveMapPoints(); saveShownState(); renderMapPoints();
    return true;
  }
  // Remove one saved point from a named list (by its id). Returns true if a point
  // was actually removed. The caller re-renders so the dot disappears.
  function removeListPoint(name, id) {
    var c = mpCollections.filter(function (x) { return x.name === name; })[0];
    if (!c || !id) return false;
    var before = (c.points || []).length;
    c.points = (c.points || []).filter(function (p) { return p.id !== id; });
    if (c.points.length === before) return false;
    saveMapPoints(); renderMapPoints();
    return true;
  }
  // Remove every saved point of one species (by species key) from all SHOWN lists
  // — backs the legend's × so removing a list-sourced species actually deletes it
  // instead of having it re-injected on the next render. Returns true if anything
  // was removed.
  function removeListSpecies(key) {
    if (!key) return false;
    var removed = false;
    mpCollections.forEach(function (c) {
      if (!shownColls[c.name]) return;
      var before = (c.points || []).length;
      c.points = (c.points || []).filter(function (p) { return p.spKey !== key; });
      if (c.points.length !== before) removed = true;
    });
    if (removed) saveMapPoints();
    return removed;
  }
  // A saved map point built from a detection row: the species becomes a tag (so
  // the pin can be coloured / filtered / grouped by species), and the note is the
  // date on the first line and the activity on the second — nothing else.
  function detPointFromRow(d) {
    var lines = [];
    if (d.date) lines.push(d.date);
    if (d.act) lines.push(actLabel(d.act));
    // Snapshot the detection so a saved pin can be drawn AND hovered exactly like
    // the plotted detection — its colour/star/rare for the symbol and swatch, and
    // the species key + individual count + date so the hover card can show the
    // same "★name ×N (nd)" line a live detection shows.
    return { id: mpUid(), lat: +d.lat, lon: +d.lon, name: d.name || "",
      tags: d.name ? [d.name] : [], note: lines.join("\n"), source: "detection", createdAt: new Date().toISOString(),
      spColor: d.color || "", spKey: d.key || "", star: !!isInteresting(d.key), rare: !!detIsRare(d.key),
      count: (d.count != null && d.count !== "") ? d.count : "", date: d.date || "", url: d.url || "", act: d.act || "", src: d.src || "" };
  }
  function addDetPoint(d, listName) {
    if (d.lat == null || isNaN(d.lat) || d.lon == null || isNaN(d.lon)) { closeDetRowMenu(); return; }
    addPointToCollection(listName, detPointFromRow(d));
    closeDetRowMenu();
    setStatus(t("detmenu.added", { name: listName }));
  }
  // ---- the small per-record menu in the Detections list ---------------------
  // ---- Shared anchored popup menu -------------------------------------------
  // One transient menu at a time: open (create + append), fill, then position it
  // on-screen; an outside click (capture phase) dismisses it. Shared by the
  // species/record menu (detrow-menu) and the observer add-to-list menus
  // (obs-addmenu) so they don't each re-implement open/position/close plumbing.
  var _anchMenuEl = null, _anchMenuOutside = null;
  function closeAnchoredMenu() {
    if (_anchMenuEl && _anchMenuEl.parentNode) _anchMenuEl.parentNode.removeChild(_anchMenuEl);
    _anchMenuEl = null;
    if (_anchMenuOutside) { document.removeEventListener("click", _anchMenuOutside, true); _anchMenuOutside = null; }
  }
  function openAnchoredMenu(className) {
    closeAnchoredMenu();
    var el = document.createElement("div"); el.className = className;
    document.body.appendChild(el);
    _anchMenuEl = el;
    _anchMenuOutside = function (e) { if (_anchMenuEl && !_anchMenuEl.contains(e.target)) closeAnchoredMenu(); };
    setTimeout(function () { if (_anchMenuEl === el) document.addEventListener("click", _anchMenuOutside, true); }, 0);
    return el;
  }
  function positionAnchoredMenu(el, left, top) {
    el.style.left = Math.max(6, Math.min(left, window.innerWidth - el.offsetWidth - 8)) + "px";
    el.style.top = Math.max(6, Math.min(top, window.innerHeight - el.offsetHeight - 8)) + "px";
  }
  function closeDetRowMenu() { closeAnchoredMenu(); }   // alias kept for its many call sites
  function drmBtn(label, onClick, iconName) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "detrow-menu-item";
    if (iconName) { b.classList.add("ico-btn"); b.innerHTML = ico(iconName) + "<span></span>"; b.lastChild.textContent = label; }
    else b.textContent = label;
    b.addEventListener("click", function (e) { e.stopPropagation(); onClick(); });
    return b;
  }
  function showDetRowMenu(d, x, y, refresh) {
    try { var sm = document.getElementById("sp-menu"); if (sm) sm.style.display = "none"; } catch (e) {}
    closeDropdowns();
    var el = openAnchoredMenu("detrow-menu");
    drmRenderMain(el, d, refresh);
    positionAnchoredMenu(el, x, y);   // after content so the on-screen clamp uses the real size
  }
  // The ONE species menu, used everywhere a species name (or dot/pin) is clicked
  // — a single tap on PC and mobile alike. Sectioned: Information (learn) · This
  // observation (record-specific, only when opened from a dot/pin) · Lists &
  // actions (your data). `d` = { key, name, sci?, and for a record lat/lon/url/
  // date/listName/mpId }.
  function drmRenderMain(el, d, refresh) {
    el.innerHTML = "";
    var redraw = refresh || renderDetListModal;   // detection-list / stored-pin refresh
    var key = d.key, lbl = key && labelsByKey[key];
    var name = d.name || (lbl && speciesName(lbl)) || key || "";
    var sci = d.sci || (lbl && lbl.sci) || name;
    var hasLoc = d.lat != null && !isNaN(+d.lat) && d.lon != null && !isNaN(+d.lon);
    var hasObs = !!(d.url || hasLoc || (d.mpId && d.listName));
    function head(k) { var h = document.createElement("div"); h.className = "detrow-menu-hdr"; h.textContent = t(k); el.appendChild(h); }
    // 1) This observation — record-specific (source / map / route / lists). Top
    // of the menu when the menu was opened from a dot/pin.
    if (hasObs) {
      head("menu.secObs");
      if (d.url) el.appendChild(drmBtn(t("det.openSource"), function () { closeDetRowMenu(); openExternal(d.url); }));
      if (hasLoc) {
        el.appendChild(drmBtn(t("detmenu.focusMap"), function () {
          closeDetRowMenu();
          try { navClose("detlist"); } catch (e) {}   // close the list so the map is visible
          if (map) { mapClickGuardUntil = Date.now() + 250; map.setView([+d.lat, +d.lon], Math.max(map.getZoom() || 0, 14)); }
        }));
        el.appendChild(drmBtn(t("nav.here"), function () { closeDetRowMenu(); navigatePoints([{ lat: +d.lat, lon: +d.lon }]); }, "nav"));
        el.appendChild(drmBtn(t("route.add"), function () { closeDetRowMenu(); addToRoute(+d.lat, +d.lon, name); }));
      }
      el.appendChild(drmBtn(t("detmenu.addList"), function () { drmRenderLists(el, d); }));
      if (d.mpId && d.listName) el.appendChild(drmBtn(t("detmenu.removeFromList"), function () { closeDetRowMenu(); removeListPoint(d.listName, d.mpId); redraw(); }, "block"));
    }
    // 2) Information — learn about the species (model species only).
    if (lbl) {
      head("menu.secInfo");
      el.appendChild(drmBtn(t("menu.apprange"), function () { closeDetRowMenu(); showSpeciesRange(key); }));
      el.appendChild(drmBtn(t("menu.appmig"), function () { closeDetRowMenu(); showSpeciesMigration(key); }));
      el.appendChild(drmBtn(t("menu.recent"), function () {
        closeDetRowMenu();
        var la = hasLoc ? +d.lat : (marker ? marker.getLatLng().lat : map.getCenter().lat);
        var lo = hasLoc ? +d.lon : (marker ? marker.getLatLng().lng : map.getCenter().lng);
        showRecent(name, sci, la, lo, key);
      }));
      el.appendChild(drmBtn(t("menu.distmap"), function () { closeDetRowMenu(); showDistMap(name, sci, key); }));
      el.appendChild(drmBtn(t("menu.wiki"), function () { closeDetRowMenu(); openWikipedia(sci); }));
      if (isBirdKey(key)) el.appendChild(drmBtn(t("menu.birdlife"), function () { closeDetRowMenu(); openBirdLife((lbl && lbl.common) || name, sci); }));
      el.appendChild(drmBtn(t("menu.macaulay"), function () { closeDetRowMenu(); openExternal(macaulayUrl(key, sci)); }));
      el.appendChild(drmBtn(t("menu.xeno"), function () { closeDetRowMenu(); openExternal(xenoCantoUrl(sci)); }));
      el.appendChild(drmBtn(t("menu.nbn"), function () { closeDetRowMenu(); openExternal(nbnUrl(sci)); }));
      if (isBirdKey(key)) el.appendChild(drmBtn(t("menu.ebp"), function () { closeDetRowMenu(); openExternal(ebpUrl(sci)); }));
    }
    // 3) Lists & actions — your data (any keyed species).
    if (key) {
      head("menu.secActions");
      var starred = isInteresting(key);
      el.appendChild(drmBtn(t(starred ? "menu.interestingRemove" : "menu.interestingAdd"), function () { toggleInteresting(key); closeDetRowMenu(); redraw(); }));
      el.appendChild(drmBtn(t(inYearList(key) ? "menu.yearlistRemove" : "menu.yearlistAdd", { year: curYear() }), function () { toggleYearList(key); closeDetRowMenu(); redraw(); }));
      el.appendChild(drmBtn(t(inLifeList(key) ? "menu.lifelistRemove" : "menu.lifelistAdd"), function () { toggleLifeList(key); closeDetRowMenu(); redraw(); }));
      el.appendChild(drmBtn(t("menu.hide"), function () { hideSpecies(key); closeDetRowMenu(); redraw(); }, "block"));
    }
  }
  function drmRenderLists(el, d) {
    var rect = el.getBoundingClientRect();
    el.innerHTML = "";
    var hdr = document.createElement("div"); hdr.className = "detrow-menu-hdr"; hdr.textContent = t("detmenu.addList"); el.appendChild(hdr);
    mpCollections.forEach(function (c) { el.appendChild(drmBtn(c.name, function () { addDetPoint(d, c.name); }, "pin")); });
    el.appendChild(drmBtn(t("detmenu.newList"), function () {
      closeDetRowMenu();
      modalPrompt(t("detmenu.newListPrompt"), "").then(function (n) { if (n && n.trim()) addDetPoint(d, n.trim()); });
    }));
    positionAnchoredMenu(el, rect.left, rect.top);   // keep on-screen after the height change
  }
  // Save a set of detection rows as map points in a named point-list — the same
  // kind right-click creates. Existing list → append; a new name → create.
  // Batched into a single save (unlike per-point addPointToCollection).
  function saveDetRowsToCollection(name, rows) {
    name = String(name || "").trim(); if (!name) return 0;
    var c = mpCollections.filter(function (x) { return x.name === name; })[0];
    if (!c) { c = { name: name, points: [] }; mpCollections.push(c); }
    // Merge + dedupe into an existing list: a point already present (same species +
    // ~location + date) isn't added again, so re-saving the same detections doesn't
    // pile up duplicates. Returns the count of NEW points actually added.
    var pkey = function (p) { return (p.spKey || p.name || "") + "|" + (p.lat != null ? (+p.lat).toFixed(5) : "") + "," + (p.lon != null ? (+p.lon).toFixed(5) : "") + "|" + (p.date || ""); };
    var seen = Object.create(null);
    (c.points || []).forEach(function (p) { seen[pkey(p)] = 1; });
    var added = 0;
    (rows || []).forEach(function (d) {
      if (d.lat == null || isNaN(+d.lat) || d.lon == null || isNaN(+d.lon)) return;
      var p = detPointFromRow(d), k = pkey(p);
      if (seen[k]) return;   // already in this list → skip
      seen[k] = 1; c.points.push(p); added++;
    });
    shownColls[c.name] = true;   // tick the list so the added points are visible
    saveMapPoints(); saveShownState(); renderMapPoints();
    return added;
  }
  function commitDetSave(name, rows) {
    var n = saveDetRowsToCollection(name, rows);   // n = NEW points added after dedupe (0 = all already in the list)
    setStatus(t("detlist.savedToList", { n: n, name: name }));
  }
  // Chooser: existing point-lists to append to, plus "New list…". Saves the given
  // rows. Reuses the per-record menu styling/dismissal.
  function showDetSaveMenu(x, y, rows) {
    closeAnchoredMenu();
    if (!rows || !rows.length) { setStatus(t("detlist.empty")); return; }
    var el = openAnchoredMenu("detrow-menu");
    var hdr = document.createElement("div"); hdr.className = "detrow-menu-hdr"; hdr.textContent = t("detlist.saveTitle"); el.appendChild(hdr);
    mpCollections.forEach(function (c) {
      el.appendChild(drmBtn(c.name, function () { closeDetRowMenu(); commitDetSave(c.name, rows); }, "pin"));
    });
    el.appendChild(drmBtn(t("detmenu.newList"), function () {
      closeDetRowMenu();
      modalPrompt(t("detmenu.newListPrompt"), "").then(function (n) { if (n && n.trim()) commitDetSave(n.trim(), rows); });
    }));
    positionAnchoredMenu(el, x, y);
  }
  // Shrink the popup's place-name heading so the full name fits on one line.
  function fitDetTitle() {
    var el = document.getElementById("detlist-title"); if (!el) return;
    el.style.fontSize = "";                                   // back to the CSS base
    var avail = el.clientWidth, full = el.scrollWidth;
    if (avail > 0 && full > avail) {
      var base = parseFloat(getComputedStyle(el).fontSize) || 18;
      var size = Math.max(12, Math.floor(base * avail / full));
      el.style.fontSize = size + "px";
      if (el.scrollWidth > el.clientWidth) el.style.fontSize = Math.max(12, size - 1) + "px";   // rounding guard
    }
  }
  // The closest USER-DEFINED place name to a point — a manually-placed map point,
  // a point in a saved list, or a stored location — within maxKm. Lets the
  // detections popup show the name the user themselves gave the spot.
  function nearestUserPlace(lat, lon, maxKm) {
    var bestName = "", bestD = maxKm || 0.2;   // default 200 m
    function consider(name, la, lo) {
      name = String(name || "").trim();
      if (!name || la == null || lo == null || !isFinite(+la) || !isFinite(+lo)) return;
      var d = haversineKm(lat, lon, +la, +lo);
      if (d <= bestD) { bestD = d; bestName = name; }
    }
    try { (mapPoints || []).forEach(function (p) { consider(p.name, p.lat, p.lon); }); } catch (e) {}
    try { (mpCollections || []).forEach(function (c) { (c.points || []).forEach(function (p) { consider(p.name, p.lat, p.lon); }); }); } catch (e) {}
    try { getStoredLocations().forEach(function (l) { consider(l.name, l.lat, l.lon); }); } catch (e) {}
    return bestName;
  }
  // Drop duplicated comma-separated tokens in a place name, keeping the LAST
  // occurrence of each (e.g. "Siragrunnen, Sokndal, Teinevigodden, Sokndal" →
  // "Siragrunnen, Teinevigodden, Sokndal").
  function dedupeCommaTokens(s) {
    var parts = String(s || "").split(",").map(function (p) { return p.trim(); });
    var keep = [];
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var key = parts[i].toLowerCase(), laterDup = false;
      for (var j = i + 1; j < parts.length; j++) { if (parts[j].toLowerCase() === key) { laterDup = true; break; } }
      if (!laterDup) keep.push(parts[i]);
    }
    return keep.join(", ");
  }
  // Join a map/place name with a user-defined name, avoiding duplicated strings:
  // if either fully contains the other, keep the richer one; else "map · user".
  function combineNames(mapName, userName) {
    mapName = dedupeCommaTokens(mapName); userName = String(userName || "").trim();
    if (!mapName) return userName;
    if (!userName) return mapName;
    var a = mapName.toLowerCase(), b = userName.toLowerCase();
    if (a === b || a.indexOf(b) >= 0) return mapName;   // user name already in the map name
    if (b.indexOf(a) >= 0) return userName;             // map name already in the user name
    return mapName + " · " + userName;
  }
  function renderDetListModal() {
    var body = document.getElementById("detlist-body");
    if (!body) return;
    closeDetRowMenu();   // any open per-record menu is stale once the list re-renders
    var sortBtn = document.getElementById("detlist-sort");   // single toggle: shows only the ACTIVE mode, title = what a tap switches to
    if (sortBtn) { var sp = detListSort === "species"; sortBtn.textContent = sp ? t("detlist.bySpecies") : t("detlist.byTime"); sortBtn.title = sp ? t("detlist.byTime") : t("detlist.bySpecies"); }
    recolorDetections();   // swatches reflect the latest family colours
    var rows = collectVisibleDetections(detListNear);
    var totalRows = rows.length;   // pre-filter count → drives whether the search box is worth showing
    // Title = the place name at this spot. Prefer an EXPLICITLY named location
    // (eBird hotspot / BirdWeather station); otherwise reverse-geocode to something
    // finer than commune level (a municipality/county name from GBIF/Artsobs is too
    // coarse). Shown immediately, then upgraded when the reverse-geocode resolves.
    var titleEl = document.getElementById("detlist-title");
    if (titleEl) {
      var explicit = "", firstPlace = "";
      if (detListNear) rows.forEach(function (r) {
        var pl = String(r.place || "").trim(); if (!pl) return;
        if (!firstPlace) firstPlace = pl;
        if (!explicit && (r.src === "eBird" || r.src === "BirdWeather")) explicit = pl;
      });
      // A name the user gave this spot (nearby map point / saved point / stored
      // location) is folded in — the map/source name plus the user's own name,
      // de-duplicated so a shared string isn't repeated.
      var userName = detListNear ? nearestUserPlace(detListNear.lat, detListNear.lon) : "";
      var setTitle = function (mapName) {
        var el = document.getElementById("detlist-title"); if (!el) return;
        el.textContent = combineNames(mapName, userName) || t("detlist.title");
        el.title = el.textContent; fitDetTitle();
      };
      setTitle(explicit || firstPlace);
      // If the record has no explicit named location, resolve the best map name:
      // a nearby major geographic feature (lake/peak/… within 250 m) first, else
      // the reverse-geocoded place name (finer than commune).
      if (detListNear && !explicit && window.AppGeo) {
        var la = detListNear.lat, lo = detListNear.lon;
        var same = function () { return detListNear && detListNear.lat === la && detListNear.lon === lo; };
        (AppGeo.nearbyFeature ? AppGeo.nearbyFeature(la, lo, 250) : Promise.resolve(""))
          .then(function (feat) { return feat || (AppGeo.placeName ? AppGeo.placeName(la, lo) : ""); })
          .then(function (nm) { if (nm && same()) setTitle(nm); }).catch(function () {});
      }
    }
    var emptyMsg = rows.length ? t("detlist.noMatch") : t("detlist.empty");
    if (detListQuery) {
      // Prefer exact (substring) matches; only when there are none fall back to
      // the looser partial/subsequence matches, so a precise query isn't buried.
      var exact = rows.filter(function (d) { return detExactMatch(detListQuery, detSearchText(d)); });
      rows = exact.length ? exact : rows.filter(function (d) { return detFuzzy(detListQuery, detSearchText(d)); });
    }
    detListLastRows = rows;   // what "Save as list" / "Navigate" will use
    // Only offer the species filter when the list is long enough to scroll (≥10
    // detections); a short list is easier to just scan. Kept visible if a query is
    // already active so it can be cleared.
    var searchEl = document.getElementById("detlist-search");
    if (searchEl) searchEl.style.display = (totalRows >= 10 || detListQuery) ? "" : "none";
    var saveBtn = document.getElementById("detlist-save"); if (saveBtn) saveBtn.disabled = !rows.length;
    var navBtn = document.getElementById("detlist-nav"); if (navBtn) navBtn.disabled = !rows.length;
    if (!rows.length) { body.innerHTML = '<div class="dl-empty">' + escapeHtml(emptyMsg) + "</div>"; return; }
    var html;
    if (detListSort === "species") {
      // One summary line per species (most-recent date + count); tap to expand
      // that species' individual records (each linking to its source).
      var bySp = {}, spOrder = [];
      rows.forEach(function (d) { if (!bySp[d.key]) { bySp[d.key] = { name: d.name, color: d.color, items: [] }; spOrder.push(d.key); } bySp[d.key].items.push(d); });
      spOrder.sort(function (a, b) { return bySp[a].name.localeCompare(bySp[b].name); });
      html = spOrder.map(function (k) {
        var g = bySp[k];
        var last = g.items.reduce(function (acc, d) { return d.date > acc ? d.date : acc; }, "");
        var open = !!detListOpenSp[k];
        var head = '<button type="button" class="dl-sp-head' + (open ? " open" : "") + '" data-key="' + escapeHtml(k) + '">' +
          detSwatch(g.color || "#888", isInteresting(k), detIsRare(k), k) +
          '<span class="dl-sp">' + escapeHtml(detListName(k, g.name)) + "</span>" +
          '<span class="dl-meta">' + escapeHtml(fmtDate(last)) + "</span>" +
          '<span class="dl-ct">' + g.items.length + "</span>" +
          '<span class="dl-caret">' + (open ? "▾" : "▸") + "</span></button>";
        var sub = open ? '<div class="dl-sp-body">' + g.items.slice().sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); }).map(function (d) { return detRowHtml(d, true); }).join("") + "</div>" : "";
        return '<div class="dl-sp-group">' + head + sub + "</div>";
      }).join("");
    } else {
      // Group by date (newest first), then by OBSERVER within a date: each
      // observer gets the date header repeated with their name and their species
      // rows (A→Z) underneath. Records with no observer fall under a plain date
      // header (sorted last within the date).
      var byDate = {}, dates = [];
      rows.forEach(function (d) { var k = d.date || ""; if (!byDate[k]) { byDate[k] = []; dates.push(k); } byDate[k].push(d); });
      dates.sort(function (a, b) { return b.localeCompare(a); });
      html = dates.map(function (dt) {
        var byObs = {}, obs = [];
        // Group label sits next to the date: the observer for most sources, but the
        // STATION name/#id for BirdWeather (its detections carry no observer).
        byDate[dt].forEach(function (d) { var o = (d.src === "BirdWeather" ? (d.place || "") : (d.observer || "")).trim(); if (!(o in byObs)) { byObs[o] = []; obs.push(o); } byObs[o].push(d); });
        obs.sort(function (a, b) { if (!a !== !b) return a ? -1 : 1; return a.localeCompare(b); });   // named observers first, blank last
        var dateLbl = escapeHtml(fmtDate(dt) || t("detlist.noDate"));
        return obs.map(function (o) {
          var items = byObs[o].slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
          // BirdWeather groups by station name (not an observer) → not clickable.
          var isBW = items[0] && items[0].src === "BirdWeather";
          var obsSpan = !o ? "" : (isBW
            ? ' <span class="dl-obs">· ' + escapeHtml(o) + "</span>"
            : ' <span class="dl-obs dl-obs-add" data-obs="' + escapeHtml(o) + '" title="' + escapeHtml(t("obs.addToList")) + '">· ' + escapeHtml(o) + "</span>");
          var head = dateLbl + obsSpan;
          var full = (fmtDate(dt) || t("detlist.noDate")) + (o ? " · " + o : "");   // plain text → full name(s) on hover when truncated
          return '<div class="dl-date-head"><span class="dl-date-lbl" title="' + escapeHtml(full) + '">' + head + '</span><span class="dl-ct">' + items.length + "</span></div>" +
            items.map(function (d) { return detRowHtml(d, false); }).join("");
        }).join("");
      }).join("");
    }
    body.innerHTML = html;
    Array.prototype.forEach.call(body.querySelectorAll(".dl-sp-head"), function (b) {
      b.addEventListener("click", function () { var k = this.getAttribute("data-key"); if (detListOpenSp[k]) delete detListOpenSp[k]; else detListOpenSp[k] = true; renderDetListModal(); });
    });
    // Click an observer header → add them to an observer list (a picker of the
    // individual names first when the observation has several observers).
    Array.prototype.forEach.call(body.querySelectorAll(".dl-obs-add"), function (s) {
      s.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        observerAddToList(this.getAttribute("data-obs"), this);
      });
    });
    function detRowData(b) {
      return {
        key: b.getAttribute("data-key"), name: b.getAttribute("data-name"),
        lat: parseFloat(b.getAttribute("data-lat")), lon: parseFloat(b.getAttribute("data-lon")),
        url: b.getAttribute("data-url"), date: b.getAttribute("data-date"),
        act: b.getAttribute("data-act"), note: b.getAttribute("data-note"),
        listName: b.getAttribute("data-listname"), mpId: b.getAttribute("data-mpid")
      };
    }
    // One tap on a detection row → the unified species menu (info + this
    // observation + your actions).
    Array.prototype.forEach.call(body.querySelectorAll(".dl-row-menu"), function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        showDetRowMenu(detRowData(b), e.clientX, e.clientY);
      });
    });
    // The 🎯 shortcut: focus the map on this record (stop the click so the row's
    // menu doesn't also open behind it).
    Array.prototype.forEach.call(body.querySelectorAll(".dl-focus"), function (s) {
      s.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        var lat = parseFloat(this.getAttribute("data-lat")), lon = parseFloat(this.getAttribute("data-lon"));
        if (!isFinite(lat) || !isFinite(lon) || !map) return;
        closeDetRowMenu();
        try { navClose("detlist"); } catch (e2) {}
        mapClickGuardUntil = Date.now() + 250;
        map.setView([lat, lon], Math.max(map.getZoom() || 0, 14));
      });
    });
  }
  // Clicking a plotted dot opens the list scoped to that spot (co-located
  // detections within 50 m), still honouring the legend's filters.
  function onDetMarkerClick(marker) {
    var ll = marker.getLatLng();
    setMpDistOrigin(ll.lat, ll.lng);   // selecting a detection dot re-measures + re-sorts the point lists
    openDetListModal({ lat: ll.lat, lon: ll.lng, meters: 50 });
  }
  // Hover tooltip: the distinct species plotted within ~50 m of the point, each
  // with ×N individuals (summed over the nearby records that carry a count) and
  // (n d) days since the most recent of those records.
  var detHoverTip = null;
  function showDetHover(latlng) {
    var near = collectVisibleDetections({ lat: latlng.lat, lon: latlng.lng, meters: 50 });
    if (!near.length) return;
    // Break the spot's records into DATE sections (newest first); under each date
    // header list the species seen that day with ×N individuals and 👥observer
    // count. Shared by every plotted marker (fetched, historic, species-at-
    // location), so they all read the same way.
    var byDate = Object.create(null), dates = [], allObs = Object.create(null);
    near.forEach(function (d) { var k = d.date || ""; if (!byDate[k]) { byDate[k] = []; dates.push(k); } byDate[k].push(d); });
    dates.sort(function (a, b) { return String(b).localeCompare(String(a)); });
    var DCAP = 12;                          // keep the tooltip a sane height at dense spots
    var sections = dates.slice(0, DCAP).map(function (dt) {
      var bySp = Object.create(null), order = [];
      byDate[dt].forEach(function (d) {
        var g = bySp[d.key];
        if (!g) { g = bySp[d.key] = { name: d.name, color: d.color || "#888", count: 0, hasCount: false, obs: Object.create(null) }; order.push(d.key); }
        var n = parseInt(d.count, 10);
        if (isFinite(n) && n > 0) { g.count += n; g.hasCount = true; }
        detObsRealNames(d.observer).forEach(function (nm) { g.obs[nm] = 1; allObs[nm] = 1; });   // single names, tags dropped
      });
      order.sort(function (a, b) { return bySp[a].name.localeCompare(bySp[b].name); });
      var spLines = order.map(function (k) {
        var g = bySp[k], meta = [];
        if (g.hasCount) meta.push("×" + g.count);
        var nObs = Object.keys(g.obs).length;
        if (nObs > 1) meta.push("👥" + nObs);   // reported by several observers
        // Full swatch (colour disc + star + rare centre-dot + need-ring) matching
        // the plotted dots / legend, for quick visual matching.
        var sw = detSwatch(g.color, isInteresting(k), detIsRare(k), k);
        return sw + escapeHtml(detListName(k, g.name)) + (meta.length ? ' <span class="dh-meta">' + escapeHtml(meta.join(" ")) + "</span>" : "");
      });
      return '<div class="dh-date">' + escapeHtml(fmtDate(dt) || t("detlist.noDate")) + "</div>" + spLines.join("<br>");
    });
    var html = sections.join("");
    if (dates.length > DCAP) html += '<div class="dh-more">📅 +' + (dates.length - DCAP) + "</div>";   // older dates omitted from the hover
    // Observers across the whole spot: show as many names as fit one line, then
    // "++" for the rest (keeps the tooltip from overrunning).
    var obsNames = Object.keys(allObs).sort(function (a, b) { return a.localeCompare(b); });
    if (obsNames.length) {
      var budget = 36, acc = "", shown = 0;
      for (var oi = 0; oi < obsNames.length; oi++) {
        var add = (shown ? ", " : "") + obsNames[oi];
        if (shown > 0 && acc.length + add.length > budget) break;
        acc += add; shown++;
      }
      html += '<div class="dh-obs">👤 ' + escapeHtml(acc) + (shown < obsNames.length ? " ++" : "") + "</div>";
    }
    if (!detHoverTip) detHoverTip = L.tooltip({ direction: "top", offset: [0, -5], opacity: 0.97, className: "det-hover-tip" });
    detHoverTip.setLatLng(latlng).setContent(html);
    map.openTooltip(detHoverTip);
  }
  function hideDetHover() { if (detHoverTip) map.closeTooltip(detHoverTip); }
  // SVG path for a 5-point star centred at (cx,cy), outer radius R. Drawn through
  // Leaflet's SVG renderer (not an HTML divIcon) so a star sits in the SAME
  // coordinate space as the circleMarker dots — at the map's fractional zoom
  // levels (zoomSnap = one H3 step) HTML markers drift from SVG vectors by a
  // position-dependent amount, which made stars visibly slide off their dots.
  function detStarPathD(cx, cy, R) {
    var r = R * 0.42, d = "", a = -Math.PI / 2, i, rad, x, y;
    for (i = 0; i < 10; i++) {
      rad = (i % 2 === 0) ? R : r;
      x = cx + rad * Math.cos(a); y = cy + rad * Math.sin(a);
      d += (i === 0 ? "M" : "L") + (Math.round(x * 10) / 10) + "," + (Math.round(y * 10) / 10);
      a += Math.PI / 5;
    }
    return d + "Z";
  }
  // A star-shaped vector marker (L.Path subclass), built lazily so Leaflet is
  // certainly loaded. Same renderer as circleMarker → stays pixel-aligned.
  var _DetStar = null;
  function detStarMarker(latlng, options) {
    if (!_DetStar) {
      _DetStar = L.Path.extend({
        options: { fill: true, fillOpacity: 0.9, radius: 9, weight: 1, color: "#1a1a1a" },
        initialize: function (latlng, options) { L.Util.setOptions(this, options); this._latlng = L.latLng(latlng); },
        setLatLng: function (ll) { this._latlng = L.latLng(ll); return this.redraw(); },
        getLatLng: function () { return this._latlng; },
        _project: function () { this._point = this._map.latLngToLayerPoint(this._latlng); this._updateBounds(); },
        _updateBounds: function () { var r = this.options.radius + (this.options.weight || 0) / 2; this._pxBounds = new L.Bounds(this._point.subtract([r, r]), this._point.add([r, r])); },
        _update: function () { if (this._map) this._updatePath(); },
        _updatePath: function () { this._renderer._setPath(this, detStarPathD(this._point.x, this._point.y, this.options.radius)); },
        _empty: function () { return this._pxBounds && !this._renderer._bounds.intersects(this._pxBounds); },
        _containsPoint: function (p) { return this._point && p.distanceTo(this._point) <= this.options.radius + this._clickTolerance(); }
      });
    }
    return new _DetStar(latlng, options);
  }
  // A shared SVG renderer for all plotted detection markers. `tolerance` pads the
  // click hit-area (Leaflet adds it to each path's _clickTolerance), so the small
  // dots/stars are much easier to tap. Sharing one renderer also keeps every
  // detection marker in the same SVG → stars stay aligned with the dots.
  var _detRenderer = null;
  function detRenderer() { if (!_detRenderer) _detRenderer = L.svg({ tolerance: 12 }); return _detRenderer; }
  // A plotted detection draws as: a ★ for starred species, a (larger) coloured
  // disc for locally-rare ones, a ★ or disc with a black centre dot when both
  // rare and (starred/rare), else a plain coloured circle — all SVG so they keep
  // aligned with each other at the map's fractional zoom levels.
  function renderDetGroup(name, rows, color, starred, rare, allowed, key) {
    var g = L.layerGroup(), visible = 0;
    var fill = color;
    var fillOp = 0.9, strokeOp = 0.9;
    var edge = detEdgeStyle(key);   // year/life-list "needs" → yellow edge (thin year, thick life)
    // Pre-pass: which locations (this species) were reported by ≥2 distinct
    // observers — those get a dashed outer ring (independent corroboration), so a
    // rarity confirmed by several people stands out. Built over the same rows
    // that will actually be drawn (recency + draw-cap filtered).
    var obsByLoc = Object.create(null), drawRows = [];
    rows.forEach(function (r) {
      if (!detDatePasses(r.date)) return;
      if (allowed && !allowed.has(r)) return;   // global cap: only the newest N are drawn
      if (!detObsPasses(r)) return;             // observer filter (legend 👤)
      var lk = (+r.lat).toFixed(4) + "," + (+r.lon).toFixed(4);
      var s = obsByLoc[lk] || (obsByLoc[lk] = Object.create(null));
      var o = (r.observer || "").trim(); if (o) s[o] = 1;
      drawRows.push({ r: r, lk: lk });          // filtered ONCE — the draw pass reuses this row + key
    });
    var ringed = Object.create(null);
    var acousticRinged = Object.create(null);   // dedupe the acoustic (BirdWeather) sound-wave ring per location
    drawRows.forEach(function (it) {
      var r = it.r, lk2 = it.lk;                // already filtered; key computed once above
      visible++;
      // Rows that came from a shown saved list carry that list's colour — draw it
      // as a slightly larger disc BEHIND the species symbol (added first → behind
      // in the shared SVG), so the marker reads as "<species symbol> on <list> disc".
      if (r.listColor) {
        g.addLayer(L.circleMarker([r.lat, r.lon], { radius: starred ? 11 : (rare ? 9 : 8), color: r.listColor, weight: 1.5, opacity: strokeOp, fillColor: r.listColor, fillOpacity: 0.5, interactive: false, bubblingMouseEvents: false, renderer: detRenderer() }));
      }
      // A starred species missing from the year/life list: draw a larger YELLOW
      // star first, then the species-coloured star centred on top — the yellow rim
      // follows the star's edges. Uses detNeedWeight (same condition as the legend
      // swatch), so the map always matches the legend regardless of the edge toggle.
      var nw = starred ? detNeedWeight(key) : 0;
      if (nw) {
        g.addLayer(detStarMarker([r.lat, r.lon], { radius: 9 + nw, fill: true, fillColor: "#ffcc00", fillOpacity: 1, stroke: false, interactive: false, bubblingMouseEvents: false, renderer: detRenderer() }));
      }
      var base = { color: edge.color, weight: edge.weight, opacity: strokeOp, fillColor: fill, fillOpacity: fillOp, bubblingMouseEvents: false, renderer: detRenderer() };
      var m = starred
        ? detStarMarker([r.lat, r.lon], { radius: 9, fill: true, fillColor: fill, fillOpacity: fillOp, color: "#1a1a1a", weight: 1, opacity: strokeOp, bubblingMouseEvents: false, renderer: detRenderer() })
        : L.circleMarker([r.lat, r.lon], L.extend({ radius: rare ? 6 : 5 }, base));
      // Metadata kept for hover/identify and any future reconstruction; the true
      // species colour rides along for hover/recolour.
      m._detRow = r; m._detName = name; m._detColor = fill; m._detTrueColor = color;
      // Click → the co-located detections list for that spot (onDetMarkerClick).
      m.on("click", function (e) {
        if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
        onDetMarkerClick(m);
      });
      // Hover (desktop) → a small tooltip listing the co-located species names.
      m.on("mouseover", function () { showDetHover(m.getLatLng()); });
      m.on("mouseout", hideDetHover);
      g.addLayer(m);
      // Locally-rare → a small black centre dot, its own SVG circle so it stays
      // pixel-aligned with the shape above it at every zoom.
      if (rare) {
        g.addLayer(L.circleMarker([r.lat, r.lon], { radius: 1.8, stroke: false, fillColor: "#111", fillOpacity: Math.min(1, fillOp + 0.1), interactive: false, bubblingMouseEvents: false, renderer: detRenderer() }));
      }
      // Several observers reported this species here → a dashed outer ring (once
      // per location). Hover lists every observer's name.
      if (!ringed[lk2] && Object.keys(obsByLoc[lk2]).length >= 2) {
        ringed[lk2] = 1;
        var rr = (starred ? 9 : (rare ? 6 : 5)) + 3.5;
        g.addLayer(L.circleMarker([r.lat, r.lon], { radius: rr, fill: false, color: "#222", weight: 1, opacity: 0.85, dashArray: "2 2", interactive: false, bubblingMouseEvents: false, renderer: detRenderer() }));
      }
      // Automated acoustic / AI detection (BirdWeather runs BirdNET) → a dashed
      // outer ring in the species colour, evoking emitted sound, so machine-heard
      // records read differently from human sightings. Once per location.
      if (r.src === "BirdWeather" && !acousticRinged[lk2]) {
        acousticRinged[lk2] = 1;
        var ar = (starred ? 9 : (rare ? 6 : 5)) + 4;
        g.addLayer(L.circleMarker([r.lat, r.lon], { radius: ar, fill: false, color: color, weight: 1.4, opacity: 0.9, dashArray: "2 3", interactive: false, bubblingMouseEvents: false, renderer: detRenderer() }));
      }
    });
    g._visibleCount = visible;
    return g;
  }
  // Union two slim-row arrays, de-duping by position+date+source so re-pinning
  // the same observations is idempotent (no piling-up of identical dots).
  function mergeDetRows(a, b) {
    var byId = Object.create(null), out = [];
    (a || []).concat(b || []).forEach(function (r) {
      if (!r) return;
      var id = r.lat + "," + r.lon + "|" + (r.date || "") + "|" + (r.url || "") + "|" + (r.src || "");
      var ex = byId[id];
      if (ex) {
        // Same observation twice — fill in fields the kept copy lacks, so a
        // fresh fetch upgrades older rows (e.g. count/activity not stored before).
        if ((ex.count == null || ex.count === "") && r.count != null && r.count !== "") ex.count = r.count;
        if (!ex.act && r.act) ex.act = r.act;
        return;
      }
      byId[id] = r; out.push(r);
    });
    return out;
  }
  function plotDetections(key, name, rows, fit, defer, cls) {
    var slim = detSlim(rows);
    if (!slim.length) { if (!defer) setStatus(t("det.none")); return; }
    var prev = detPlot[key];
    // Accumulate: re-pinning a species ADDS its new observations to whatever is
    // already on the map (deduped) instead of replacing them — so pinning at
    // several places/searches builds up the full set of dots. No cap.
    var merged = prev ? mergeDetRows(prev.rows, slim) : slim;
    if (prev && prev.group) map.removeLayer(prev.group);
    // Taxonomic class for the Species-group legend filter: use the supplied one,
    // else keep the previous, else derive it for model species from taxonomy.
    var eCls = (cls != null && cls !== "") ? cls : ((prev && prev.cls) || (taxByCode[key] && taxByCode[key].class_name) || "");
    var e = { key: key, name: (name || (prev && prev.name)), color: (prev && prev.color) || "#888", rows: merged, group: null, cls: eCls };
    detPlot[key] = e;
    recolorDetections();   // assign family-based colours now that this species is in the set
    recomputeRareMax();
    // Over the draw cap (single add) → re-render everything under the newest-N
    // limit. Under the cap, or mid-bulk (defer), render just this species; a bulk
    // run's trailing rebuildDetLayers() applies the cap once at the end.
    if (!defer && detDrawableCount() > detMaxPoints()) {
      rebuildDetLayers();
    } else if (detIsVisible(key)) {
      e.group = renderDetGroup(detName(e), merged, e.color, isInteresting(e.key), detIsRare(key), null, e.key);
      e.group.addTo(map);
    }
    if (!defer) { updateDetLegend(); saveDetections(); }   // batch when plotting many at once
    if (fit && e.group) { try { map.fitBounds(e.group.getBounds().pad(0.25)); } catch (err) { /* single point / bad bounds */ } }
  }
  // Rebuild every detection layer from the current selection state (called when
  // a legend row is toggled). Hidden/filtered-out species get no layer; visible
  // ones are drawn in their species colour.
  function rebuildDetLayers() {
    clearSpider();
    ensureDedup();
    if (detFocusKey && !detPlot[detFocusKey]) detFocusKey = null;   // focused species gone → don't mute everything
    recolorDetections();
    recomputeRareMax();
    var allowed = detDrawAllowed();   // newest-N cap across all species (null = under cap)
    // Draw order = z-order (shared SVG renderer). Where several species pile on the
    // same pixel, the HIGHEST-PRIORITY species shows on top. Priority per species:
    //   +2 life list, +1 year list, +1 starred, +1 locally rare.
    // Higher score is drawn LAST (on top); ties break alphabetically so the
    // alphabetically-first species wins (equal scores → name sorted descending,
    // landing 'A…' on top).
    function detPrio(k) {
      return (inLifeList(k) ? 2 : 0) + (inYearList(k) ? 1 : 0) + (isInteresting(k) ? 1 : 0) + (detIsRare(k) ? 1 : 0);
    }
    var keys = Object.keys(detPlot).sort(function (a, b) {
      var pa = detPrio(a), pb = detPrio(b);
      if (pa !== pb) return pa - pb;                                   // higher priority drawn later → on top
      return detName(detPlot[b]).localeCompare(detName(detPlot[a]));   // tie → alphabetically-first species on top
    });
    var selActive = detSelectionActive();
    keys.forEach(function (k) {
      var e = detPlot[k];
      if (e.group) { map.removeLayer(e.group); e.group = null; }
      // Legend hover OVERRIDES the selection: while a species is focused, draw ONLY
      // it (regardless of what's selected); otherwise apply the normal selection.
      if (detFocusKey) { if (k !== detFocusKey) return; }
      else if (!detIsVisible(k, selActive)) return;
      e.group = renderDetGroup(detName(e), e.rows, e.color, isInteresting(e.key), detIsRare(k), allowed, e.key);
      e.group.addTo(map);
    });
  }
  // Legend hover: focus one species — only it stays drawn; every other species'
  // markers are hidden (rebuildDetLayers skips them when detFocusKey is set).
  // Re-rendered only on focus change.
  function focusDetSpecies(key) {
    if (detFocusKey === key || !detPlot[key]) return;
    detFocusKey = key;
    rebuildDetLayers();
  }
  function unfocusDetSpecies() {
    if (!detFocusKey) return;
    detFocusKey = null;
    rebuildDetLayers();
  }
  // Legend hover on an observer name: show only that observer's records (all
  // species), the same way hovering a species isolates that species.
  function focusDetObs(name) {
    if (detFocusObs === name || !name) return;
    detFocusObs = name;
    rebuildDetLayers();
  }
  function unfocusDetObs() {
    if (!detFocusObs) return;
    detFocusObs = null;
    rebuildDetLayers();
  }
  // Plot every species' nearby observations from the cached all-species fetch
  // (GBIF + iNaturalist + eBird) on the map, one coloured layer per species.
  // Capped at 40 species (by count) to keep the legend and CPU sane.
  function plotAllSightings() {
    if (!currentSpView || (currentSpView.mode !== "point" && currentSpView.mode !== "historic")) { setStatus(t("det.none")); return; }
    var hist = currentSpView.mode === "historic" ? currentSpView.range : null;
    // Historic observations are older than the legend's recency window (default
    // 30 days), so plotting them with the filter on would draw nothing. Open the
    // window to "All" so the historic dots actually appear.
    if (hist) window.GeoState.save({ detRecencyDays: 0 });
    // Plot whatever the species list currently holds (partial or complete) so
    // "pin to map" works at any point during the fetch and never restarts it.
    if (currentSpView._result) { obsStatusActive = false; plotSightingsResult(currentSpView._result); return; }
    // No snapshot yet (plotting before the list rendered) — fetch, then plot.
    setStatus(t("sp.plotting"));
    if (!hist) { obsStatusActive = true; obsProgress(); }   // point mode mirrors per-source progress into the status line
    var fetchP = hist ? fetchHistoricSightingsAt(currentSpView.lat, currentSpView.lon, hist) : fetchAllSightingsAt(currentSpView.lat, currentSpView.lon);
    fetchP.then(plotSightingsResult).catch(function () { obsStatusActive = false; setStatus(t("det.none")); });
  }
  // Plot a (partial or complete) all-species result onto the map. Extracted so
  // plotAllSightings can render the current snapshot or a freshly-fetched one.
  function plotSightingsResult(result) {
      obsStatusActive = false;
      // Filter by the group the data was FETCHED under (result.group), not the live
      // one — so switching group mid-fetch can't filter e.g. bird data against mammals.
      var grp = result.group || speciesGroup;
      function modelKeyInGroup(key) { return grp === "all" || ((taxByCode[key] || {}).class_name || "").toLowerCase() === grp; }
      function extraInGroup(cls) { return grp === "all" || (cls && String(cls).toLowerCase() === grp); }
      // Transfer the FILTERED species list to the map: keep a species only when
      // it passes the list's active "days since" filter, using the same
      // most-recent-observation (latestTs) predicate as applyAgeFilter so the map
      // matches the list exactly. 0 (off) and -1 (">0", any observation) keep
      // every observed species; all of a kept species' rows are plotted.
      var ageDays = speciesAgeFilterDays, nowMs = Date.now();
      function passesAge(latestTs) {
        if (!ageDays || ageDays === -1) return true;
        return latestTs ? Math.round((nowMs - latestTs) / 86400000) <= ageDays : false;
      }
      var entries = [];
      Object.keys(result.agg).forEach(function (key) {
        var a = result.agg[key];
        if (a.rows && a.rows.length && modelKeyInGroup(key) && passesAge(a.latestTs)) entries.push({ key: key, name: (labelsByKey[key] && speciesName(labelsByKey[key])) || key, rows: a.rows, count: a.count, cls: (taxByCode[key] || {}).class_name || "" });
      });
      Object.keys(result.extras).forEach(function (k) {
        var ex = result.extras[k];
        if (ex.rows && ex.rows.length && extraInGroup(ex.cls) && passesAge(ex.latestTs)) entries.push({ key: "x:" + k, name: ex.name || ex.sci, rows: ex.rows, count: ex.count, cls: ex.cls || "" });
      });
      var failNote = (result.failed && result.failed.length) ? " · " + t("fetch.failed", { sources: failedNames(result.failed) }) : "";
      if (!entries.length) { setStatus(failNote ? failNote.replace(/^ · /, "") : t("det.none")); return; }
      // A fetch actually put observations on the map → outline the search area (thin
      // dashed green), which is what the red ×'s per-area delete acts on.
      if (currentSpView && isFinite(+currentSpView.lat) && isFinite(+currentSpView.lon)) rememberFetchedArea(+currentSpView.lat, +currentSpView.lon);
      entries.sort(function (a, b) { return b.count - a.count; });
      // Accumulate: plotDetections merges (deduped) into whatever is already on
      // the map, so plotting at several locations builds up the full picture.
      // Use the legend's "Clear" to start over. No species cap — plot them all.
      entries.forEach(function (e) { plotDetections(e.key, e.name, e.rows, false, true, e.cls); });
      rebuildDetLayers();                      // recolour existing dots if families were just learned
      updateDetLegend(); saveDetections();     // one batch update after the loop
      // Fit to the points just added (this location), not the whole accumulated set.
      var bounds = L.latLngBounds([]);
      entries.forEach(function (e) { (e.rows || []).forEach(function (r) { if (r && isFinite(+r.lat) && isFinite(+r.lon)) bounds.extend([+r.lat, +r.lon]); }); });
      if (bounds.isValid()) { try { map.fitBounds(bounds.pad(0.2)); } catch (e3) {} }
      // Surface the map so the user sees the plotted points.
      document.getElementById("species-panel").style.display = "none";
      if (map) map.invalidateSize();
      // Per-source breakdown (raw records each source returned) so it's clear
      // which databases actually contributed — e.g. whether eBird downloaded.
      var bySrc = result.bySrc || {};
      var toSet = Object.create(null); (result.timedOut || []).forEach(function (n) { toSet[n] = 1; });
      var srcParts = Object.keys(bySrc).sort().map(function (s) {
        var lab = escapeHtml(s + " " + bySrc[s]);
        return toSet[s] ? '<span class="src-timeout" title="' + escapeHtml(t("sources.timedOut")) + '">' + lab + "</span>" : lab;   // timed out → red
      });
      var srcNote = srcParts.length ? " · " + srcParts.join(", ") : "";
      if (result.dedupTotal != null) srcNote += " · " + escapeHtml(t("sp.deduped", { n: result.dedupTotal }));   // unique kept after de-dup
      setStatusHtml(escapeHtml(t("sp.plotted", { n: entries.length })) + srcNote + escapeHtml(failNote));
      reportFetchErrors(result.failed);
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
        count: (e.count != null && e.count !== "") ? e.count : "",
        act: e.act || "",
        note: e.note || "",
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
  function removeDetection(key) {
    if (!detPlot[key]) return;
    clearSpider();
    var fromList = removeListSpecies(key);   // also delete from shown lists so it doesn't re-inject
    if (detPlot[key].group) map.removeLayer(detPlot[key].group);
    delete detPlot[key]; delete detSelected[key];
    updateDetLegend(); saveDetections(); saveLegendState();
    if (fromList && typeof refreshMpPanel === "function") refreshMpPanel();   // keep the points-panel count current
  }
  // Reset every legend filter at once (the black ×): the species selection, the
  // ★/◉/🟡 mode filter, the observer filter, and the recency (days) window → All.
  // Dots stay plotted; only the filtering is cleared.
  function clearAllFilters() {
    detSelected = {};
    detStarFilter = false; detRareFilter = false; detYearFilter = false;
    detObsPanelOpen = false; detDaysPanelOpen = false; detModePanelOpen = false;
    setDetObsFilter(null);                                                   // observer → all
    window.GeoState.save({ detRecencyDays: 0, detDateRange: null });        // days + range → All
    saveLegendState(); rebuildDetLayers(); updateDetLegend();
  }
  // The red × clears the WHOLE map of plotted points: fetched dots, plus every
  // shown saved list / detection set (un-ticked so nothing is re-injected — the
  // lists/sets themselves are kept in storage, just hidden). Loose working map
  // pins and the saved lists survive.
  function clearDetections() {
    clearSpider();
    if (storedLocFramesLayer) storedLocFramesLayer.clearLayers();   // selection preview
    clearFetchedAreas();   // remembered fetched-area outlines go with the detections
    Object.keys(detPlot).forEach(function (k) { if (detPlot[k].group) map.removeLayer(detPlot[k].group); });
    detPlot = {}; detSelected = {};
    detStarFilter = false; detRareFilter = false; detYearFilter = false;
    setDetObsFilter(null); detObsPanelOpen = false; detDaysPanelOpen = false; detModePanelOpen = false; detLegendMini = false;
    var hadShown = Object.keys(shownColls).length || Object.keys(shownDetSets).length;
    shownColls = {}; shownDetSets = {};
    updateDetSetOverlays();     // remove detection-set overlays
    saveShownState();
    if (hadShown && typeof renderMapPoints === "function") renderMapPoints();   // drop shown-list pins
    syncListDetections();       // nothing shown now → no re-injection
    updateDetLegend(); saveDetections(); saveLegendState();
    if (typeof refreshMpPanel === "function") refreshMpPanel();   // reflect the un-ticked state
  }
  // Re-render plotted points + legend in the current language (called on lang change).
  function refreshDetections() {
    rebuildDetLayers();
    updateDetLegend();
  }
  // The plotted dots/stars in store shape ({ key, name, color, rows, cls }).
  // Rows injected from shown saved lists (r._list) are NOT persisted here — they
  // belong to their collection and are re-injected by syncListDetections; saving
  // them would duplicate them as "fetched" dots on the next load.
  function serializeDetPlot() {
    var out = {};
    Object.keys(detPlot).forEach(function (k) {
      var e = detPlot[k], rows = (e.rows || []).filter(function (r) { return !r._list; });
      if (!rows.length) return;   // list-only species exist only while their list is shown
      out[k] = { key: e.key, name: e.name, color: e.color, rows: rows, cls: e.cls || "" };
    });
    return out;
  }
  function saveDetections() { window.GeoState.save({ mapDetections: capDetections(serializeDetPlot(), DET_CAP) }); }
  // ---- Named detection sets ("trips") ---------------------------------------
  // A saved snapshot of the plotted dots/stars under a name, so a trip's/day's
  // sightings can be reloaded or deleted as a unit. Stored (and synced) as
  // GeoState.mapDetectionSets = [{ name, createdAt, detections, interesting[] }].
  // A tombstone list (mapDetectionSetsDel) lets a delete propagate across
  // devices — the detection merge only unions, so otherwise a deleted set would
  // come straight back from the other device on the next sync.
  // Saved trips live in IndexedDB (each embeds a full dot snapshot and would blow
  // past localStorage's ~5 MB cap). They're mirrored in memory (detSetStore) so the
  // synchronous callers + the sync payload are unchanged; tombstones stay in
  // localStorage (small) for the merge. detSetsIdbReady=false → localStorage fallback.
  var detSetStore = [];
  var detSetsIdbReady = false;
  // One-time hydrate: pull trips from IDB into the mirror, first migrating any still
  // in the localStorage blob (then drop them from the blob to free the quota — only
  // AFTER the IDB writes are confirmed, so a failure loses nothing). Awaited early in
  // init() before anything reads detSets().
  async function initDetSetStore() {
    if (!(window.AppIDB && window.AppIDB.available())) {
      detSetStore = (window.GeoState.get("mapDetectionSets", []) || []).filter(function (s) { return s && s.name; });
      return;
    }
    try {
      var blobSets = window.GeoState.get("mapDetectionSets", null);
      if (Array.isArray(blobSets) && blobSets.length) {
        for (var i = 0; i < blobSets.length; i++) { var s = blobSets[i]; if (s && s.name) await window.AppIDB.put("set:" + s.name, s); }
        window.GeoState.save({ mapDetectionSets: undefined });   // confirmed in IDB → free the blob
      }
      var all = await window.AppIDB.getAll();
      detSetStore = Object.keys(all).filter(function (k) { return k.indexOf("set:") === 0; }).map(function (k) { return all[k]; }).filter(function (s) { return s && s.name; });
      detSetsIdbReady = true;
    } catch (e) {
      detSetStore = (window.GeoState.get("mapDetectionSets", []) || []).filter(function (s) { return s && s.name; });
      detSetsIdbReady = false;
    }
  }
  function detSets() { return detSetStore.filter(function (s) { return s && s.name; }); }
  function detSetTombstones() { return (window.GeoState.get("mapDetectionSetsDel", []) || []).filter(Boolean); }
  // Persist one trip: IndexedDB when ready, else the localStorage blob (fallback).
  function persistDetSet(name, blob) {
    if (detSetsIdbReady && window.AppIDB) {
      window.AppIDB.put("set:" + name, blob).then(null, function () { setStatus(t("err.storageFull")); });
      return true;
    }
    window.GeoState.save({ mapDetectionSets: detSetStore });
    if (window.GeoState.lastSaveOk && !window.GeoState.lastSaveOk()) { setStatus(t("err.storageFull")); return false; }
    return true;
  }
  // Starred species currently plotted, so a set carries its own stars.
  function plottedInterestingKeys() {
    return Object.keys(detPlot).map(function (k) { return detPlot[k].key || k; }).filter(function (key) { return isInteresting(key); });
  }
  function saveDetSet(name) {
    name = String(name || "").trim(); if (!name) return false;
    var det = serializeDetPlot(); if (!Object.keys(det).length) return false;
    var cur = detSetStore.filter(function (x) { return x.name === name; })[0];
    var blob = { name: name, createdAt: Date.now(), detections: det, interesting: plottedInterestingKeys() };
    if (cur) { cur.detections = blob.detections; cur.interesting = blob.interesting; cur.createdAt = blob.createdAt; }
    else detSetStore.push(blob);
    // Saving a name un-tombstones it (a fresh set with that name should stick).
    window.GeoState.save({ mapDetectionSetsDel: detSetTombstones().filter(function (n) { return n !== name; }) });
    return persistDetSet(name, cur || blob);
  }
  function deleteDetSet(name) {
    var tomb = detSetTombstones(); if (tomb.indexOf(name) === -1) tomb.push(name);
    detSetStore = detSetStore.filter(function (x) { return x.name !== name; });
    window.GeoState.save({ mapDetectionSetsDel: tomb });
    if (detSetsIdbReady && window.AppIDB) window.AppIDB.del("set:" + name);
    else window.GeoState.save({ mapDetectionSets: detSetStore });
  }
  // Persist the legend's UI state — collapsed, the starred-only filter, and the
  // row selection — so the map legend comes back the way the user left it.
  function saveLegendState() {
    window.GeoState.save({ mapLegend: { mini: detLegendMini, starFilter: detStarFilter, rareFilter: detRareFilter, yearFilter: detYearFilter, selected: Object.keys(detSelected), obsFilter: detObsFilter ? Array.from(detObsFilter) : null } });
  }
  function loadDetections() {
    // Self-heal a store left over-quota by an older build: cap the stored
    // detections (oldest dropped) and rewrite, so settings / points / lists can
    // be saved again and a sync isn't blocked. No-op once already within cap.
    try {
      var raw = JSON.parse(localStorage.getItem("geomodel-explorer-v1") || "{}");
      if (detRowCount(raw.mapDetections) > DET_CAP) writeStateCapped(raw);
    } catch (e) {}
    var saved = window.GeoState.get("mapDetections", {}) || {};
    Object.keys(saved).forEach(function (sk) {
      var d = saved[sk]; if (!d || !d.rows || !d.rows.length) return;
      var key = d.key || sk;   // older builds keyed by display name and had no .key
      // Class for the Species-group filter: stored for extras; model species
      // derive it from the taxonomy so older saves still filter correctly.
      var cls = d.cls || (taxByCode[key] && taxByCode[key].class_name) || "";
      detPlot[key] = { key: key, name: d.name || sk, color: d.color, rows: d.rows, group: null, cls: cls };
    });
    // Restore the saved legend state, then render the layers honouring it.
    var ls = window.GeoState.get("mapLegend", {}) || {};
    detLegendMini = !!ls.mini;
    detStarFilter = !!ls.starFilter;
    detRareFilter = !!ls.rareFilter;
    detYearFilter = !!ls.yearFilter;
    setDetObsFilter(Array.isArray(ls.obsFilter) ? new Set(ls.obsFilter) : null);
    detSelected = {};
    (Array.isArray(ls.selected) ? ls.selected : []).forEach(function (k) { if (detPlot[k]) detSelected[k] = true; });
    rebuildDetLayers();
    updateDetLegend();
  }
  // Re-load the plotted detections + starred list from storage (after a sync/
  // import merged them) and re-render the map + legend in place.
  function reloadPlottedFromStore() {
    if (typeof map === "undefined" || !map) return;
    Object.keys(detPlot).forEach(function (k) { if (detPlot[k].group) map.removeLayer(detPlot[k].group); });
    detPlot = {};
    // Pick up families merged in from another device so colours match it.
    try { var ff = (window.GeoState && window.GeoState.get("detFamilies", {})) || {}; Object.keys(ff).forEach(function (k) { if (ff[k]) famIndex[k] = ff[k]; }); } catch (e) {}
    if (typeof loadInteresting === "function") loadInteresting();
    if (typeof loadLists === "function") loadLists();   // pick up merged year/life lists from a sync
    loadDetections();
  }
  // Fit the map to the currently-visible plotted detections — used after a sync
  // pulls in another device's dots so they actually land on screen.
  function fitToDetections() {
    if (!map) return;
    var b = L.latLngBounds([]), selActive = detSelectionActive();
    Object.keys(detPlot).forEach(function (k) {
      if (!detIsVisible(k, selActive)) return;
      (detPlot[k].rows || []).forEach(function (r) { if (r && isFinite(+r.lat) && isFinite(+r.lon) && detDatePasses(r.date)) b.extend([+r.lat, +r.lon]); });
    });
    if (b.isValid()) { try { map.fitBounds(b.pad(0.2)); } catch (e) {} }
  }
  // Collapsed/expanded state for the detection legend (persisted in mapLegend).
  var detLegendMini = false;
  // Distinct observer names across all plotted detections, plus whether any record
  // has no observer. Used to build the legend's 👤 observer checklist.
  // ---- Observer lists -------------------------------------------------------
  // Saved sets of observer names (to filter by).
  function getObserverLists() { return window.GeoState.get("observerLists", []) || []; }
  function saveObserverLists(a) { window.GeoState.save({ observerLists: a }); }
  // Observers that currently have observations plotted (the pool you can add from).
  function allKnownObservers() {
    var set = Object.create(null);
    try { detAllObservers().names.forEach(function (n) { if (n) set[n] = 1; }); } catch (e) {}
    return Object.keys(set).sort(function (a, b) { return a.localeCompare(b); });
  }
  // Popup to manage observer lists: pick a list to edit, rename/delete it, remove
  // members, and add members by fuzzy-searching observers that have observations.
  function openObserverEditor() {
    var m = createModal({ boxClass: "obs-editor", onClose: function () { if (document.getElementById("det-legend")) updateDetLegend(); } });
    var box = m.box, close = m.close;
    var selLi = 0;                         // which list is currently being edited
    function esc(s) { return escapeHtml(s); }
    // Members of the selected list, shown as a table (rebuilt on add/remove).
    function renderMembers() {
      var wrap = box.querySelector(".obs-ed-mwrap"); if (!wrap) return;
      var L = getObserverLists()[selLi]; if (!L) return;
      wrap.innerHTML = (L.observers || []).length
        ? '<table class="obs-ed-mtable"><tbody>' + L.observers.map(function (n, oi) {
            return '<tr><td class="obs-ed-mname">' + esc(n) + '</td><td class="obs-ed-mrm"><button type="button" class="obs-ed-rm" data-oi="' + oi + '" aria-label="' + esc(t("btn.delete")) + '">×</button></td></tr>';
          }).join("") + "</tbody></table>"
        : '<div class="obs-ed-empty">' + esc(t("obs.noMembers")) + "</div>";
      wrap.querySelectorAll(".obs-ed-rm").forEach(function (b) {
        b.addEventListener("click", function () { var a = getObserverLists(); if (a[selLi]) { a[selLi].observers.splice(+this.getAttribute("data-oi"), 1); saveObserverLists(a); renderMembers(); renderResults(); } });
      });
    }
    // Fuzzy-search results for the "add member" box (observers with observations,
    // not already in the list); clicking a result adds them.
    function renderResults() {
      var res = box.querySelector(".obs-ed-sresults"), inp = box.querySelector(".obs-ed-sinput");
      if (!res || !inp) return;
      var q = inp.value.trim(), L = getObserverLists()[selLi];
      if (!L || !q) { res.innerHTML = ""; return; }
      var pool = allKnownObservers().filter(function (n) { return L.observers.indexOf(n) < 0; });
      var matches = pool.filter(function (n) { return fuzzyMatch(n, q); }).slice(0, 40);
      res.innerHTML = matches.length
        ? matches.map(function (n) { return '<button type="button" class="obs-ed-sitem" data-obs="' + esc(n) + '">' + esc(n) + "</button>"; }).join("")
        : '<div class="obs-ed-empty">' + esc(pool.length ? t("obs.noMatches") : t("obs.noneToAdd")) + "</div>";
      res.querySelectorAll(".obs-ed-sitem").forEach(function (b) {
        b.addEventListener("click", function () {
          var a = getObserverLists(), n = this.getAttribute("data-obs");
          if (a[selLi] && a[selLi].observers.indexOf(n) < 0) { a[selLi].observers.push(n); saveObserverLists(a); }
          renderMembers(); renderResults(); inp.focus();
        });
      });
    }
    function render() {
      var lists = getObserverLists();
      if (selLi >= lists.length) selLi = lists.length - 1;
      if (selLi < 0) selLi = lists.length ? 0 : -1;
      var L = selLi >= 0 ? lists[selLi] : null;
      var html =
        '<div class="obs-ed-head"><span>' + esc(t("obs.editTitle")) + "</span>" +
          '<button type="button" class="obs-ed-close" aria-label="' + esc(t("btn.close")) + '">×</button></div>' +
        '<div class="obs-ed-top">' +
          (lists.length ? '<select class="obs-ed-pick">' + lists.map(function (Lx, i) {
            return '<option value="' + i + '"' + (i === selLi ? " selected" : "") + ">" + esc(Lx.name) + "</option>";
          }).join("") + "</select>" : "") +
          '<button type="button" class="obs-ed-new demo-btn demo-btn-light">＋ ' + esc(t("obs.newList")) + "</button>" +
        "</div>";
      if (L) {
        html += '<div class="obs-ed-list">' +
          '<div class="obs-ed-lhead"><input type="text" class="obs-ed-lname" value="' + esc(L.name) + '" />' +
            '<button type="button" class="obs-ed-ldel" aria-label="' + esc(t("btn.delete")) + '" title="' + esc(t("btn.delete")) + '">🗑</button></div>' +
          '<div class="obs-ed-mwrap"></div>' +
          '<div class="obs-ed-search"><input type="text" class="obs-ed-sinput" placeholder="' + esc(t("obs.searchPh")) + '" />' +
            '<div class="obs-ed-sresults"></div></div>' +
          "</div>";
      } else {
        html += '<div class="obs-ed-empty">' + esc(t("obs.noLists")) + "</div>";
      }
      box.innerHTML = html;
      wire();
      if (L) renderMembers();
    }
    function wire() {
      box.querySelector(".obs-ed-close").addEventListener("click", close);
      var pick = box.querySelector(".obs-ed-pick");
      if (pick) pick.addEventListener("change", function () { selLi = +this.value; render(); });
      box.querySelector(".obs-ed-new").addEventListener("click", function () {
        modalPrompt(t("obs.newListPrompt"), "").then(function (nm) { nm = (nm || "").trim(); if (!nm) return; var a = getObserverLists(); a.push({ name: nm, observers: [] }); saveObserverLists(a); selLi = a.length - 1; render(); });
      });
      var nameInp = box.querySelector(".obs-ed-lname");
      if (nameInp) nameInp.addEventListener("change", function () { var a = getObserverLists(); if (a[selLi]) { a[selLi].name = this.value.trim() || a[selLi].name; saveObserverLists(a); } });
      var del = box.querySelector(".obs-ed-ldel");
      if (del) del.addEventListener("click", function () { var a = getObserverLists(); a.splice(selLi, 1); saveObserverLists(a); render(); });
      var sinput = box.querySelector(".obs-ed-sinput");
      if (sinput) sinput.addEventListener("input", renderResults);
    }
    render();
  }
  // Rebuild the legend but keep the observer checklist scrolled where it was.
  function updateDetLegendKeepObsScroll() {
    var lst = document.querySelector("#det-legend .det-obs-list"), st = lst ? lst.scrollTop : 0;
    updateDetLegend();
    var nl = document.querySelector("#det-legend .det-obs-list"); if (nl) nl.scrollTop = st;
  }
  // Small popup (anchored to a clicked observer name) to toggle that observer's
  // membership in each saved list, or start a new list containing them. Uses the
  // shared anchored-menu primitive (openAnchoredMenu / positionAnchoredMenu).
  function showAddToListMenu(name, anchor) {
    var r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;   // capture before the menu (anchor may live inside a menu we replace)
    var menu = openAnchoredMenu("obs-addmenu");
    var lists = getObserverLists();
    menu.innerHTML =
      '<div class="obs-addmenu-head">' + escapeHtml(name) + "</div>" +
      lists.map(function (L, i) {
        var inIt = (L.observers || []).indexOf(name) >= 0;
        return '<button type="button" class="obs-addmenu-item' + (inIt ? " on" : "") + '" data-li="' + i + '">' + (inIt ? "✓ " : "") + escapeHtml(L.name) + "</button>";
      }).join("") +
      '<button type="button" class="obs-addmenu-new">＋ ' + escapeHtml(t("obs.newList")) + "</button>";
    positionAnchoredMenu(menu, r.left, r.bottom + 2);
    menu.querySelectorAll(".obs-addmenu-item").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var a = getObserverLists(), i = +this.getAttribute("data-li"); if (!a[i]) return;
        var idx = a[i].observers.indexOf(name);
        if (idx >= 0) a[i].observers.splice(idx, 1); else a[i].observers.push(name);
        saveObserverLists(a); closeAnchoredMenu(); updateDetLegendKeepObsScroll();
      });
    });
    menu.querySelector(".obs-addmenu-new").addEventListener("click", function (e) {
      e.stopPropagation(); closeAnchoredMenu();
      modalPrompt(t("obs.newListPrompt"), "").then(function (nm) {
        nm = (nm || "").trim(); if (!nm) return;
        var a = getObserverLists(); a.push({ name: nm, observers: [name] }); saveObserverLists(a); updateDetLegendKeepObsScroll();
      });
    });
  }
  // When an observation carries several observers, first show the individual
  // names; picking one drills into that observer's add-to-list menu.
  function showObserverPeopleMenu(names, anchor) {
    var r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    var menu = openAnchoredMenu("obs-addmenu");
    menu.innerHTML = '<div class="obs-addmenu-head">' + escapeHtml(t("obs.people")) + "</div>" +
      names.map(function (n) { return '<button type="button" class="obs-people-item" data-obs="' + escapeHtml(n) + '">' + escapeHtml(n) + "</button>"; }).join("");
    positionAnchoredMenu(menu, r.left, r.bottom + 2);
    menu.querySelectorAll(".obs-people-item").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); showAddToListMenu(this.getAttribute("data-obs"), this); });
    });
  }
  // Entry point from any displayed observer string (legend or detlist): one
  // observer opens the add-to-list menu directly; several open a picker first.
  function observerAddToList(obsString, anchor) {
    var names = detObsRealNames(obsString);
    if (names.length <= 1) showAddToListMenu(names[0] || String(obsString || "").trim(), anchor);
    else showObserverPeopleMenu(names, anchor);
  }
  function detAllObservers() {
    var set = Object.create(null), hasNone = false;
    Object.keys(detPlot).forEach(function (k) {
      (detPlot[k].rows || []).forEach(function (r) {
        var real = detObsRealNames(r.observer);   // split into single names, drop org/source tags
        if (real.length) real.forEach(function (n) { set[n] = 1; });
        else hasNone = true;                       // empty or only tags → "(no observer)"
      });
    });
    return { names: Object.keys(set).sort(function (a, b) { return a.localeCompare(b); }), hasNone: hasNone };
  }
  // The 👤 checklist panel: one ticked row per observer (+ a "no observer" row),
  // ticking restricts the map/list to the selected observers.
  function detObsPanelHtml() {
    var ob = detAllObservers();
    if (!ob.names.length && !ob.hasNone) return "";
    function row(key, label) {
      var on = !detObsFilter || detObsFilter.has(key);
      // Real observers get a clickable name that opens the "add to list" menu;
      // the "(no observer)" row keeps a plain (toggle-only) label.
      var span = key
        ? '<span class="det-obs-name det-obs-addable" data-obs="' + escapeHtml(key) + '" title="' + escapeHtml(t("obs.addToList")) + '">' + escapeHtml(label) + "</span>"
        : "<span>" + escapeHtml(label) + "</span>";
      return '<label class="det-obs-row"><input type="checkbox" class="det-obs-cb" data-obs="' + escapeHtml(key) + '"' + (on ? " checked" : "") + ">" + span + "</label>";
    }
    var rows = ob.names.map(function (o) { return row(o, o); });
    if (ob.hasNone) rows.push(row("", t("det.noObserver")));
    // Head: an ✎ button opens the list editor; the cycle button (where "All" used
    // to be) shows the current scope and steps All → None → each saved list.
    return '<div class="det-obs-panel">' +
      '<div class="det-obs-head">' +
        '<button type="button" class="det-obs-cycle" title="' + escapeHtml(t("det.obsCycleHint")) + '">' + escapeHtml(obsFilterLabel()) + "</button>" +
        '<button type="button" class="det-obs-editlists" title="' + escapeHtml(t("obs.lists")) + '">✎</button></div>' +
      '<div class="det-obs-list">' + rows.join("") + "</div></div>";
  }
  // Time-window subwindow: preset chips (1/2/3 days, weeks, months + All) and a
  // from–to date range. A preset and a range are mutually exclusive — picking one
  // clears the other.
  var DET_DAYS_PRESETS = [
    { unit: "days", vals: [[1, 1], [2, 2], [3, 3]] },
    { unit: "weeks", vals: [[1, 7], [2, 14], [3, 21]] },
    { unit: "months", vals: [[1, 30], [2, 60], [3, 90]] }
  ];
  function detDaysPanelHtml() {
    var rg = detDateRange(), days = detRecencyDays();
    function chip(lbl, active, act, val) {
      return '<button type="button" class="det-days-chip' + (active ? " on" : "") + '" data-act="' + act + '"' +
        (val != null ? ' data-days="' + val + '"' : "") + ">" + escapeHtml(lbl) + "</button>";
    }
    var rows = DET_DAYS_PRESETS.map(function (grp) {
      var chips = grp.vals.map(function (v) { return chip(String(v[0]), !rg && days === v[1], "preset", v[1]); }).join("");
      return '<div class="det-days-line"><span class="det-days-unit">' + escapeHtml(t("det." + grp.unit)) + "</span>" + chips + "</div>";
    }).join("");
    var allChip = '<div class="det-days-line"><span class="det-days-unit"></span>' + chip(t("det.allTime"), !rg && days === 0, "preset", 0) + "</div>";
    var rangeRow = '<div class="det-days-range">' +
      '<label>' + escapeHtml(t("det.dateFrom")) + '<input type="date" class="det-date-from" value="' + escapeHtml(rg ? rg.from : "") + '" /></label>' +
      '<label>' + escapeHtml(t("det.dateTo")) + '<input type="date" class="det-date-to" value="' + escapeHtml(rg ? rg.to : "") + '" /></label>' +
      "</div>";
    return '<div class="det-days-panel">' +
      '<div class="det-panel-head">' + escapeHtml(t("det.recency")) + "</div>" +
      rows + allChip + rangeRow + "</div>";
  }
  // Species subwindow: one row per mode (all / starred / rare / needs-this-year),
  // each a symbol + explanatory text. Radio-style — the active mode is highlighted.
  function detModePanelHtml() {
    var opts = [
      { m: "", sym: "–", txt: t("det.allSpecies") },
      { m: "star", sym: "★", txt: t("det.starred") },
      { m: "rare", sym: "◉", txt: t("det.rare") },
      { m: "year", sym: "🟡", txt: t("det.needsYear", { year: curYear() }) }
    ];
    var cur = detStarFilter ? "star" : detRareFilter ? "rare" : detYearFilter ? "year" : "";
    var rows = opts.map(function (o) {
      return '<button type="button" class="det-mode-row' + (cur === o.m ? " on" : "") + '" data-mode="' + o.m + '">' +
        '<span class="det-mode-sym">' + escapeHtml(o.sym) + "</span><span class=\"det-mode-txt\">" + escapeHtml(o.txt) + "</span></button>";
    }).join("");
    return '<div class="det-mode-panel">' + rows + "</div>";
  }
  // Compact label for the days button: 1d / 2w / 3m for the known presets, ∞ for
  // All, ⇆ when an absolute date range is active, else the raw day count.
  function detDaysLabel() {
    if (detDateRange()) return "⇆";
    var d = detRecencyDays();
    if (!d) return "∞";
    var map = { 1: "1d", 2: "2d", 3: "3d", 7: "1w", 14: "2w", 21: "3w", 30: "1m", 60: "2m", 90: "3m" };
    return map[d] || String(d);
  }
  // Label for the cycle button: All / None / a saved list's name / Custom.
  function obsFilterLabel() {
    if (!detObsFilter) return t("det.allObs");
    if (detObsFilter.size === 0) return t("det.obsNone");
    var lists = getObserverLists();
    for (var i = 0; i < lists.length; i++) if (sameNameSet(detObsFilter, lists[i].observers)) return lists[i].name;
    return t("det.obsCustom");
  }
  // Step the observer scope: All (null) → None (empty) → list0 → list1 → … → All.
  // A custom checkbox selection resets to All on the next step.
  function cycleObsFilter() {
    var lists = getObserverLists(), n = 2 + lists.length, cur = 0;
    if (detObsFilter) {
      if (detObsFilter.size === 0) cur = 1;
      else { cur = -1; for (var i = 0; i < lists.length; i++) if (sameNameSet(detObsFilter, lists[i].observers)) { cur = 2 + i; break; } }
    }
    var next = cur < 0 ? 0 : (cur + 1) % n;
    if (next === 0) setDetObsFilter(null);
    else if (next === 1) setDetObsFilter(new Set());
    else setDetObsFilter(new Set(lists[next - 2].observers));
    saveLegendState(); rebuildDetLayers(); updateDetLegend();
  }
  // True if the current filter Set contains exactly the names in `arr`.
  function sameNameSet(set, arr) {
    if (!set || set.size !== arr.length) return false;
    for (var i = 0; i < arr.length; i++) if (!set.has(arr[i])) return false;
    return true;
  }
  // How many of a species' detections pass the current days + observer filters
  // (NOT the per-species selection). Drives which species the legend lists.
  function detVisibleCount(k) {
    var e = detPlot[k]; if (!e || !e.rows) return 0;
    var n = 0;
    for (var i = 0; i < e.rows.length; i++) { var r = e.rows[i]; if (detDatePasses(r.date) && detObsPasses(r)) n++; }
    return n;
  }
  // Model week (1–48) for an observation date; falls back to the current week.
  function weekOfDate(s) {
    var d = s ? new Date(s) : null;
    if (!d || isNaN(d.getTime())) return weekOfToday();
    var doy = Math.floor((d - new Date(d.getFullYear(), 0, 1)) / 86400000) + 1;
    return Math.max(1, Math.min(48, Math.floor((doy - 1) / 365 * 48) + 1));
  }
  // A signature that changes when the plotted set (species + observation counts)
  // changes — so the habitat probabilities are recomputed only when needed.
  function detPlotSig() {
    var ks = Object.keys(detPlot).sort(), n = 0;
    for (var i = 0; i < ks.length; i++) n += (detPlot[ks[i]].rows ? detPlot[ks[i]].rows.length : 0);
    return ks.join("|") + "#" + n;
  }
  // Duplicate key WITHIN a species: same username + approximate location (~1 km) +
  // date + count. No username → not a same-user cross-database duplicate.
  function detDupKey(r) {
    var obs = (r.observer || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!obs) return null;
    var la = (r.lat != null && isFinite(+r.lat)) ? (+r.lat).toFixed(2) : "";
    var lo = (r.lon != null && isFinite(+r.lon)) ? (+r.lon).toFixed(2) : "";
    return obs + "|" + la + "," + lo + "|" + String(r.date || "").slice(0, 10) + "|" + String(r.count != null ? r.count : "");
  }
  // "Deduplicate detections": hide records that duplicate one another across a
  // DIFFERENT source — same species + username + approx location + date + count
  // (e.g. one sighting registered in both eBird and Artsobservasjoner). Keep one
  // copy (preferring one with a source link). Recomputed only when the plotted set
  // or the setting changes; a no-op (empty set) when the setting is off.
  function ensureDedup() {
    var on = dedupDetections(), sig = on ? detPlotSig() : "off";
    if (sig === detDupSig) return;
    detDupSig = sig; detDupHidden = new Set();
    if (!on) return;
    Object.keys(detPlot).forEach(function (k) {
      var rows = detPlot[k].rows || [], groups = Object.create(null);
      rows.forEach(function (r) { var dk = detDupKey(r); if (dk) (groups[dk] || (groups[dk] = [])).push(r); });
      Object.keys(groups).forEach(function (gk) {
        var g = groups[gk]; if (g.length < 2) return;
        var srcs = Object.create(null); g.forEach(function (r) { srcs[r.src || ""] = 1; });
        if (Object.keys(srcs).length < 2) return;   // all one source → not a cross-database dup, keep all
        var keeper = g[0]; for (var i = 0; i < g.length; i++) { if (g[i].url) { keeper = g[i]; break; } }
        g.forEach(function (r) { if (r !== keeper) detDupHidden.add(r); });
      });
    });
  }
  // For each plotted MODEL species, the HIGHEST habitat-model probability across
  // its observations — evaluated at each observation's own location + week (input
  // to the geomodel). Extras (non-model "x:" keys) get -1 so they sort lowest.
  // Runs one column inference per species; on completion the legend re-renders.
  function computeDetProbs(sig) {
    var jobs = [];
    Object.keys(detPlot).forEach(function (k) {
      var e = detPlot[k], lbl = labelsByKey[e.key || k];
      if (!lbl || lbl.index == null || !e.rows || !e.rows.length) { detProb[k] = -1; return; }
      var seen = Object.create(null), pts = [];
      e.rows.forEach(function (r) {
        if (r.lat == null || r.lon == null || !isFinite(+r.lat) || !isFinite(+r.lon)) return;
        var la = +(+r.lat).toFixed(2), lo = +(+r.lon).toFixed(2), wk = weekOfDate(r.date);
        var pk = la + "," + lo + ":" + wk; if (seen[pk]) return; seen[pk] = 1;
        pts.push(la, lo, wk);
      });
      if (!pts.length) { detProb[k] = -1; return; }
      jobs.push({ k: k, idx: lbl.index, inputs: new Float32Array(pts), n: pts.length / 3 });
    });
    if (!jobs.length) { detProbSig = sig; detProbBusy = false; return; }   // only extras → nothing to infer
    Promise.all(jobs.map(function (j) {
      return runInference(j.inputs, j.n, { task: "column", speciesIdx: j.idx })
        .then(function (out) { var m = 0; for (var i = 0; i < out.length; i++) if (out[i] > m) m = out[i]; detProb[j.k] = m; })
        .catch(function () { detProb[j.k] = -1; });
    })).then(function () {
      detProbSig = sig; detProbBusy = false;      // mark done only on success, so a failed pass retries
      if (detPlotSig() === sig) updateDetLegend();
    }, function () { detProbBusy = false; });      // hard failure → leave detProbSig so it retries
  }
  function maybeComputeDetProbs() {
    if (!worker || detProbBusy) return;
    if (detPlotSig() === detProbSig) return;   // already computed for this exact plotted set
    detProbBusy = true;
    computeDetProbs(detPlotSig());
  }
  function updateDetLegend() {
    var allKeys = Object.keys(detPlot);
    if (!allKeys.length) { if (detLegend) { map.removeControl(detLegend); detLegend = null; } return; }
    ensureDedup();
    maybeComputeDetProbs();   // (re)compute habitat probabilities when the plotted set changed
    // The dropdown's "Starred only" narrows which species the legend lists (and
    // the map shows). The legend itself stays up so the filter can be toggled.
    // Species are ordered by habitat-model probability (lowest → highest); see the
    // sort below.
    recomputeRareMax();
    // The list reflects ALL the active filters: the per-species mode filter
    // (★/◉/🟡/group) AND the days + observer filters (a species with nothing left
    // after those drops out, like its dots do on the map).
    var visCount = Object.create(null);
    allKeys.forEach(function (k) { visCount[k] = detVisibleCount(k); });
    var keys = allKeys.filter(function (k) { return detPassesStar(k) && detPassesGroup(k) && detPassesRare(k) && detPassesYear(k) && visCount[k] > 0; });
    // Legend hover/hold-isolate: if the focused row is no longer in the legend (a
    // filter/refresh removed it), clear the focus so the map doesn't stay stuck
    // isolated to one species after its row's mouseleave never fired.
    if (detFocusKey && keys.indexOf(detFocusKey) < 0) detFocusKey = null;
    if (detFocusObs && detAllObservers().names.indexOf(detFocusObs) < 0) detFocusObs = null;
    var detNameByKey = Object.create(null);
    keys.forEach(function (k) { detNameByKey[k] = detName(detPlot[k]); });   // compute once, not per comparison
    // Order by habitat-model probability, LOWEST → HIGHEST (a species' value is the
    // highest probability among its observations). Ties / not-yet-computed fall back
    // to the localised name so the order is still stable.
    keys.sort(function (a, b) {
      var pa = (a in detProb) ? detProb[a] : -1, pb = (b in detProb) ? detProb[b] : -1;
      if (pa !== pb) return pa - pb;
      return detNameByKey[a].localeCompare(detNameByKey[b]);
    });
    recolorDetections();   // keep swatches current with learned families / plotted set
    // Cap check: when more points are drawable than the Settings limit, only the
    // newest N are plotted — surface a ⚠ on the control line (no count summary).
    var nDet = 0;
    keys.forEach(function (k) { var e = detPlot[k]; nDet += (e.group && e.group._visibleCount != null) ? e.group._visibleCount : e.rows.length; });
    var fetched = detDrawableCount(), capped = fetched > detMaxPoints();
    var capTip = capped ? t("det.cappedTip", { shown: nDet, total: fetched }) : "";
    if (!detLegend) {
      detLegend = L.control({ position: "bottomleft" });
      detLegend.onAdd = function () { var d = L.DomUtil.create("div", "det-legend"); d.id = "det-legend"; L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d); return d; };
      detLegend.addTo(map);
    }
    var el = document.getElementById("det-legend");
    // Only collapse to the corner pill when there are species to summarise.
    // When the active filters leave the list empty, stay expanded so the filter
    // controls (days / mode / observer / clear) remain reachable to recover.
    var showMini = detLegendMini && keys.length > 0;
    el.classList.toggle("det-legend-mini", showMini);
    // Collapsed: a single pill in the corner showing the species count.
    if (showMini) {
      el.innerHTML = '<button type="button" class="det-restore ico-btn" title="' + escapeHtml(t("det.expand")) + '">' + ico("pin") + "<span>" + keys.length + "</span>" + (capped ? ' <span class="det-cap-warn" title="' + escapeHtml(capTip) + '">⚠</span>' : "") + "</button>";
      el.querySelector(".det-restore").addEventListener("click", function () { mapClickGuardUntil = Date.now() + 250; detLegendMini = false; saveLegendState(); updateDetLegend(); });
      return;
    }
    // Three subwindow toggles, each opening a dropdown (mutually exclusive): the
    // time window (days / date range), which species (★/◉/🟡), and the observers.
    var daysLbl = detDaysLabel();
    var daysOn = detRecencyDays() !== 0 || !!detDateRange();
    var modeOn = detStarFilter || detRareFilter || detYearFilter;
    var modeLbl = detStarFilter ? "★" : detRareFilter ? "◉" : detYearFilter ? "🟡" : "–";
    var modeTip = detStarFilter ? t("det.starred") : detRareFilter ? t("det.rare") : detYearFilter ? t("det.needsYear", { year: curYear() }) : t("det.allSpecies");
    // One control line: − minimise · ☰ list · time · ★/◉/🟡 species · 👤 observers ·
    // (black ×) clear filters · (red ×) delete areas / all, plus a ⚠ (right-aligned)
    // only when the draw cap is truncating the map.
    var hasSel = detSelectionActive();
    // The black × clears ALL filters (selection, ★/◉/🟡 mode, observer, recency
    // days + date range). Shown whenever any of them is active.
    var hasFilter = hasSel || detStarFilter || detRareFilter || detYearFilter || !!detObsFilter || (detRecencyDays() !== 0) || !!detDateRange();
    el.innerHTML = '<div class="det-legend-head">' +
        '<button type="button" class="det-min" title="' + escapeHtml(t("det.minimise")) + '" aria-label="' + escapeHtml(t("det.minimise")) + '">−</button>' +
        '<button type="button" class="det-list-btn ico-btn" title="' + escapeHtml(t("detlist.open")) + '" aria-label="' + escapeHtml(t("detlist.open")) + '">' + ico("menu") + "</button>" +
        '<button type="button" class="det-tog det-days-tog' + (daysOn ? " on" : "") + (detDaysPanelOpen ? " open" : "") + '" title="' + escapeHtml(t("det.recency")) + '">' + escapeHtml(daysLbl) + "</button>" +
        '<button type="button" class="det-tog det-mode-tog' + (modeOn ? " on" : "") + (detModePanelOpen ? " open" : "") + '" title="' + escapeHtml(modeTip) + '">' + escapeHtml(modeLbl) + "</button>" +
        '<button type="button" class="det-tog det-obs-tog ico-btn' + (detObsFilter ? " on" : "") + (detObsPanelOpen ? " open" : "") + '" title="' + escapeHtml(t("det.observers")) + '" aria-label="' + escapeHtml(t("det.observers")) + '">' + ico("user") + "</button>" +
        (hasFilter ? '<button type="button" class="det-clear-sel" title="' + escapeHtml(t("det.clearFilters")) + '" aria-label="' + escapeHtml(t("det.clearFilters")) + '">×</button>' : "") +
        '<button type="button" class="det-clear' + (detAreaDeleteMode ? " armed" : "") + '" title="' + escapeHtml(detAreaDeleteMode ? t("det.delAreaHint") : (fetchedAreas.length ? t("det.delAreaArm") : t("det.clearAll"))) + '" aria-label="' + escapeHtml(t("det.clearAll")) + '">×</button>' +
        (capped ? '<span class="det-cap-warn" role="img" title="' + escapeHtml(capTip) + '" aria-label="' + escapeHtml(capTip) + '">⚠</span>' : "") +
      "</div>" +
      (detDaysPanelOpen ? detDaysPanelHtml() : "") +
      (detModePanelOpen ? detModePanelHtml() : "") +
      (detObsPanelOpen ? detObsPanelHtml() : "") +
      (keys.length ? "" : '<div class="det-empty">' + escapeHtml(t("det.noMatch")) + "</div>") +
      keys.map(function (k) {
        var e = detPlot[k], nm = escapeHtml(detName(e));
        var vis = visCount[k] != null ? visCount[k] : e.rows.length;   // detections passing days + observer
        var ct = (vis === e.rows.length) ? String(vis) : (vis + "/" + e.rows.length);
        // When a selection is active, non-selected rows show a grey swatch and
        // dimmed text so it's clear they're hidden on the map.
        var selActive = hasSel, sel = !!detSelected[k];
        var rowCls = "det-row det-row-click" + (selActive && !sel ? " det-row-off" : "") + (sel ? " det-row-on" : "");
        var sw = (selActive && !sel) ? DET_MUTE_COLOR : e.color;
        return '<div class="' + rowCls + '" data-key="' + escapeHtml(k) + '">' + detSwatch(sw, isInteresting(e.key), detIsRare(k), e.key) + '<span class="det-nm" title="' + nm + '">' + nm + '</span><span class="det-ct">' + ct + '</span><button type="button" class="det-del" data-key="' + escapeHtml(k) + '" aria-label="remove">×</button></div>';
      }).join("");
    // Red ×, two-stage: with remembered fetched areas and not yet armed, the first
    // click arms per-area delete (a red × appears on each area). Otherwise it wipes
    // everything (a 2nd click while armed, or when there are no areas to pick from).
    el.querySelector(".det-clear").addEventListener("click", function (e) {
      e.stopPropagation(); mapClickGuardUntil = Date.now() + 250;
      if (!detAreaDeleteMode && fetchedAreas.length) { enterAreaDeleteMode(); updateDetLegend(); }
      else clearDetections();
    });
    var clrSel = el.querySelector(".det-clear-sel");
    if (clrSel) clrSel.addEventListener("click", function (e) {
      e.stopPropagation(); mapClickGuardUntil = Date.now() + 250;
      clearAllFilters();              // selection + mode + observer + recency days, dots kept
    });
    el.querySelector(".det-list-btn").addEventListener("click", function (e) { e.stopPropagation(); mapClickGuardUntil = Date.now() + 250; openDetListModal(); });
    el.querySelector(".det-min").addEventListener("click", function () { mapClickGuardUntil = Date.now() + 250; detLegendMini = true; saveLegendState(); updateDetLegend(); });
    el.querySelectorAll(".det-del").forEach(function (b) { b.addEventListener("click", function (e) { e.stopPropagation(); removeDetection(this.getAttribute("data-key")); }); });
    // Click a row to toggle its visibility selection. Stop the click here so it
    // can't leak to the map and pop the point-options popup at the legend's spot.
    // ⚠ CONFIRMED BEHAVIOUR — keep as-is (user-approved 2026-06-26). Do NOT revert
    // to a plain mouseenter/mouseleave hover on touch (it sticks and breaks
    // multi-select). The contract: mouse = hover-to-isolate; touch quick tap =
    // multi-select toggle; touch press-and-hold = isolate while held, restore on lift.
    //
    // Hover-focus (isolate one species, grey out the rest). On a mouse device a
    // real hover does it; on touch, mouseenter fires on tap but mouseleave never
    // does — so it would stick and break multi-select. Instead, touch gets an
    // explicit PRESS-AND-HOLD: hold a row to isolate its species while held, lift
    // to restore. A quick tap stays a multi-select toggle.
    var canHover = !window.matchMedia || window.matchMedia("(hover: hover)").matches;
    el.querySelectorAll(".det-row-click").forEach(function (row) {
      if (canHover) {
        row.addEventListener("mouseenter", function () { focusDetSpecies(this.getAttribute("data-key")); });
        row.addEventListener("mouseleave", unfocusDetSpecies);
      }
      // Press-and-hold → isolate (touch hover). lpFired marks a hold so the
      // synthesized click that follows doesn't also toggle the selection.
      var lpTimer = null, lpFired = false, lpY = 0;
      row.addEventListener("touchstart", function (e) {
        lpFired = false;
        var key = this.getAttribute("data-key");
        lpY = (e.touches && e.touches[0]) ? e.touches[0].clientY : 0;
        clearTimeout(lpTimer);
        lpTimer = setTimeout(function () { lpFired = true; focusDetSpecies(key); }, 400);
      }, { passive: true });
      row.addEventListener("touchmove", function (e) {
        var y = (e.touches && e.touches[0]) ? e.touches[0].clientY : lpY;
        if (Math.abs(y - lpY) > 10) clearTimeout(lpTimer);   // scrolling → don't isolate
      }, { passive: true });
      var lpEnd = function () { clearTimeout(lpTimer); if (lpFired) unfocusDetSpecies(); };   // lift after a hold → restore
      row.addEventListener("touchend", lpEnd);
      row.addEventListener("touchcancel", lpEnd);
      row.addEventListener("click", function (e) {
        e.stopPropagation();
        mapClickGuardUntil = Date.now() + 250;
        if (lpFired) { lpFired = false; return; }   // this was a press-and-hold, not a select
        detFocusKey = null;   // a tap commits a selection — clear any transient hover-focus
        var k = this.getAttribute("data-key");
        // Multi-select: each click toggles that species, and the picks stick —
        // click several to show them together. Clicking a selected species
        // deselects it; clearing the last one shows all species again.
        if (detSelected[k]) delete detSelected[k]; else detSelected[k] = true;
        saveLegendState();
        rebuildDetLayers();
        updateDetLegend();
      });
    });
    // Days toggle: open the time-window subwindow. These handlers re-render the
    // legend (replacing their own button), so a tap can fall through to the map;
    // stop propagation and arm the map-click guard so it can't drop a map point /
    // open the point popup behind the legend.
    el.querySelector(".det-days-tog").addEventListener("click", function (e) {
      e.stopPropagation(); mapClickGuardUntil = Date.now() + 400;
      openDetPanel("days"); updateDetLegend();
    });
    // A preset chip → set that rolling window (and clear any date range).
    el.querySelectorAll(".det-days-chip").forEach(function (chip) {
      chip.addEventListener("click", function (e) {
        e.stopPropagation(); mapClickGuardUntil = Date.now() + 250;
        window.GeoState.save({ detRecencyDays: +this.getAttribute("data-days"), detDateRange: null });
        saveLegendState(); rebuildDetLayers(); updateDetLegend();
      });
    });
    // A date input → set the from–to range (takes precedence over the presets).
    el.querySelectorAll(".det-date-from, .det-date-to").forEach(function (inp) {
      inp.addEventListener("change", function (e) {
        e.stopPropagation(); mapClickGuardUntil = Date.now() + 250;
        var from = (el.querySelector(".det-date-from") || {}).value || "";
        var to = (el.querySelector(".det-date-to") || {}).value || "";
        window.GeoState.save({ detDateRange: (from || to) ? { from: from, to: to } : null });
        saveLegendState(); rebuildDetLayers(); updateDetLegend();
      });
    });
    // Mode toggle: open the species subwindow.
    el.querySelector(".det-mode-tog").addEventListener("click", function (e) {
      e.stopPropagation(); mapClickGuardUntil = Date.now() + 400;
      openDetPanel("mode"); updateDetLegend();
    });
    // A mode row → set that species filter exclusively (all / starred / rare / needs).
    el.querySelectorAll(".det-mode-row").forEach(function (row) {
      row.addEventListener("click", function (e) {
        e.stopPropagation(); mapClickGuardUntil = Date.now() + 250;
        var m = this.getAttribute("data-mode");
        detStarFilter = m === "star"; detRareFilter = m === "rare"; detYearFilter = m === "year";
        saveLegendState(); rebuildDetLayers(); updateDetLegend();
      });
    });
    // 👤 observer filter: open the checklist subwindow.
    el.querySelector(".det-obs-tog").addEventListener("click", function (e) {
      e.stopPropagation(); mapClickGuardUntil = Date.now() + 400;
      openDetPanel("obs"); updateDetLegend();
    });
    // Tick/untick observers → restrict the map + list to the selected ones. All
    // ticked collapses back to "no filter" (null) so the 👤 icon goes inactive.
    el.querySelectorAll(".det-obs-cb").forEach(function (cb) {
      cb.addEventListener("change", function (e) {
        e.stopPropagation(); mapClickGuardUntil = Date.now() + 250;
        var lst = el.querySelector(".det-obs-list"), st = lst ? lst.scrollTop : 0;   // keep the dropdown scrolled where it was
        var boxes = el.querySelectorAll(".det-obs-cb"), checked = [], allOn = true;
        Array.prototype.forEach.call(boxes, function (b) { if (b.checked) checked.push(b.getAttribute("data-obs")); else allOn = false; });
        setDetObsFilter(allOn ? null : new Set(checked));
        saveLegendState(); rebuildDetLayers(); updateDetLegend();
        var nl = el.querySelector(".det-obs-list"); if (nl) nl.scrollTop = st;       // restore after the re-render
      });
    });
    // Click an observer's name → menu to add/remove them from a saved list.
    // preventDefault stops the surrounding <label> from toggling the checkbox.
    // Hover (mouse only) isolates that observer's records on the map, mirroring
    // the species-row hover.
    var canHoverObs = !window.matchMedia || window.matchMedia("(hover: hover)").matches;
    el.querySelectorAll(".det-obs-name.det-obs-addable").forEach(function (nm) {
      nm.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation(); mapClickGuardUntil = Date.now() + 250;
        showAddToListMenu(this.getAttribute("data-obs"), this);
      });
      if (canHoverObs) {
        nm.addEventListener("mouseenter", function () { focusDetObs(this.getAttribute("data-obs")); });
        nm.addEventListener("mouseleave", unfocusDetObs);
      }
    });
    // Scope cycle button: All → None → each saved list → All.
    var obsCycle = el.querySelector(".det-obs-cycle");
    if (obsCycle) obsCycle.addEventListener("click", function (e) {
      e.stopPropagation(); mapClickGuardUntil = Date.now() + 250;
      cycleObsFilter();
    });
    var edLists = el.querySelector(".det-obs-editlists");
    if (edLists) edLists.addEventListener("click", function (e) { e.stopPropagation(); mapClickGuardUntil = Date.now() + 250; openObserverEditor(); });
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
  var mpSort = "dist";   // points list order: "dist" (nearest first) | "name"
  // Distances + nearest-first sorting in the point lists are measured from the LAST
  // point the user selected on the map (a map click, a pin, a detection dot, or a
  // list row). Falls back to the map centre until something is selected. Selecting
  // a point re-measures and re-sorts via refreshMpPanel().
  var mpDistOrigin = null;   // { lat, lng } or null
  function setMpDistOrigin(lat, lon) {
    if (lat == null || lon == null || isNaN(+lat) || isNaN(+lon)) return;
    mpDistOrigin = { lat: +lat, lng: +lon };
    refreshMpPanel();
  }
  // Saved lists are now shown as toggleable OVERLAYS (tick to show, several at
  // once) rather than loaded into the working set. These hold which saved
  // point-lists / detection sets are currently shown; detSetOverlays holds the
  // live map layer for each shown detection set.
  var shownColls = {};
  var shownDetSets = {};
  var detSetOverlays = {};

  var MP_COLORS = ["#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd","#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf"];
  function mpHashColor(tag) {
    if (!tag) return "#888";
    var h = 0; for (var i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
    return MP_COLORS[Math.abs(h) % MP_COLORS.length];
  }
  function mpColorFor(p) { return mpHashColor((p.tags && p.tags[0]) || ""); }
  // A saved list's colour: an explicit list colour if set (via the list editor),
  // else the automatic name-hashed colour.
  function collColor(c) { return (c && c.color) || mpHashColor(c ? c.name : ""); }
  // Whole-list editor: set a colour + tags applied to every point in the list
  // (and rename it). Opened from the ✎ on a list row in the Points overview.
  function openCollEditModal(name) {
    var c = mpCollections.filter(function (x) { return x.name === name; })[0]; if (!c) return;
    var esc = escapeHtml, auto = mpHex6(mpHashColor(c.name)), cur = mpHex6(c.color || auto);
    // Seed the tag box with tags shared by ALL points (so saving doesn't wipe them).
    var common = null;
    (c.points || []).forEach(function (p) {
      var set = {}; (p.tags || []).forEach(function (x) { set[x] = 1; });
      if (common === null) common = set;
      else Object.keys(common).forEach(function (x) { if (!set[x]) delete common[x]; });
    });
    var tagStr = common ? Object.keys(common).join(", ") : "";
    // "Notes are HTML" starts ticked only if every point that has a note is flagged.
    var noted = (c.points || []).filter(function (p) { return p.note; });
    var allHtml = noted.length > 0 && noted.every(function (p) { return p.noteHtml; });
    var ov = document.createElement("div"); ov.id = "coll-edit-modal"; ov.className = "kml-modal";
    ov.innerHTML = '<div class="kml-modal-box">' +
      '<button type="button" id="ce-close" class="kml-close" aria-label="' + esc(t("btn.close")) + '">×</button>' +
      "<h3>" + esc(t("points.editList")) + "</h3>" +
      '<label class="kml-row">' + esc(t("points.name")) + '<input type="text" id="ce-name" value="' + esc(c.name) + '" /></label>' +
      '<label class="kml-row">' + esc(t("points.tags")) + '<input type="text" id="ce-tags" value="' + esc(tagStr) + '" placeholder="' + esc(t("points.tagsPh")) + '" /></label>' +
      '<span class="mp-color-row"><span class="mp-color-lbl">' + esc(t("points.color")) + "</span>" +
        '<input type="color" id="ce-color" data-auto="' + esc(auto) + '" value="' + esc(cur) + '" />' +
        '<button type="button" id="ce-color-auto" class="mp-color-reset" title="' + esc(t("points.colorAuto")) + '" aria-label="' + esc(t("points.colorAuto")) + '">↺</button></span>' +
      '<label class="kml-row kml-check"><input type="checkbox" id="ce-note-html"' + (allHtml ? " checked" : "") + " />" + esc(t("points.noteHtml")) + "</label>" +
      '<p class="cu-hint">' + esc(t("points.editListHint")) + "</p>" +
      '<div class="kml-actions"><button type="button" id="ce-save" class="demo-btn">' + esc(t("points.save")) + "</button></div>" +
      "</div>";
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    document.getElementById("ce-close").addEventListener("click", close);
    var ci = document.getElementById("ce-color"), reset = document.getElementById("ce-color-auto");
    reset.addEventListener("click", function () { ci.value = ci.getAttribute("data-auto") || "#888888"; });
    document.getElementById("ce-save").addEventListener("click", function () {
      var newName = (document.getElementById("ce-name").value || "").trim();
      var tags = mpParseTags(document.getElementById("ce-tags").value);
      var colVal = (ci.value || "").toLowerCase(), col = (colVal && colVal !== auto.toLowerCase()) ? ci.value : "";   // auto → no explicit colour
      var noteHtml = document.getElementById("ce-note-html").checked;
      var isActive = mpActiveName === c.name;   // capture before any rename
      c.color = col || undefined;
      // Apply the colour + tags + note-is-HTML flag to every point. The colour is
      // written per-point too (not just on the list) so it shows through both draw
      // paths — the active working set colours per-point via mpColorFor, shown lists
      // via collColor.
      var applyFlags = function (p) { p.color = col; p.tags = tags.slice(); if (noteHtml) p.noteHtml = true; else delete p.noteHtml; };
      (c.points || []).forEach(applyFlags);
      // If this list is the one currently loaded onto the map, mirror the edit onto
      // the working set — else saveMapPoints() would copy mapPoints back over c.points.
      if (isActive) mapPoints.forEach(applyFlags);
      // Rename (migrate the shown + protected flags, which are keyed by name).
      if (newName && newName !== c.name && !mpCollections.some(function (x) { return x.name === newName; })) {
        var old = c.name, wasShown = !!shownColls[old], wasProt = isCollProtected(old);
        c.name = newName;
        if (isActive) mpActiveName = newName;
        if (wasShown) { delete shownColls[old]; shownColls[newName] = true; }
        if (wasProt) { setCollProtected(old, false); setCollProtected(newName, true); }
        saveShownState();
      }
      saveMapPoints(); renderMapPoints(); if (typeof refreshMpPanel === "function") refreshMpPanel();
      if (typeof renderListsModal === "function") renderListsModal();
      close();
    });
  }
  // <input type=color> needs a 6-digit hex; expand "#888" → "#888888".
  function mpHex6(c) {
    c = String(c || "");
    if (/^#[0-9a-f]{3}$/i.test(c)) return "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    return /^#[0-9a-f]{6}$/i.test(c) ? c : "#888888";
  }
  // Editor colour row: a "custom colour" checkbox + swatch. Unchecked = auto
  // (tag-derived, else grey). Shared by the live and saved-point editors.
  function mpColorRow(p) {
    // No "custom?" checkbox: the swatch starts at the point's automatic (tag-based)
    // colour; changing it makes the colour custom, and ↺ resets it to automatic.
    // data-auto carries the auto colour so mpReadColor can tell them apart.
    var auto = mpHex6(mpColorFor(p));
    var val = mpHex6((p && p.color) || auto);
    return '<span class="mp-color-row"><span class="mp-color-lbl">' + escapeHtml(t("points.color")) + "</span>" +
      '<input type="color" id="mp-color" data-auto="' + escapeHtml(auto) + '" value="' + escapeHtml(val) + '" />' +
      '<button type="button" id="mp-color-auto" class="mp-color-reset" title="' + escapeHtml(t("points.colorAuto")) + '" aria-label="' + escapeHtml(t("points.colorAuto")) + '">↺</button></span>';
  }
  function mpReadColor() {
    var ci = document.getElementById("mp-color"); if (!ci) return "";
    var auto = (ci.getAttribute("data-auto") || "").toLowerCase(), val = (ci.value || "").toLowerCase();
    return (val && val !== auto) ? ci.value : "";   // still the auto colour → store "" (automatic)
  }
  // ↺ resets the swatch to the point's automatic colour.
  function wireMpColorRow() {
    var reset = document.getElementById("mp-color-auto"), ci = document.getElementById("mp-color");
    if (reset && ci) reset.addEventListener("click", function () { ci.value = ci.getAttribute("data-auto") || "#888888"; });
  }
  // Comma-separated free-form tag input → clean, deduped lowercase-trimmed array.
  function mpParseTags(s) {
    return String(s || "").split(",").map(function (t) { return t.trim(); }).filter(function (t, i, a) { return t && a.indexOf(t) === i; });
  }
  function mpUid() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function loadMapPoints() {
    mapPoints = (window.GeoState.get("mapPoints", []) || []).filter(function (p) { return p && isFinite(p.lat) && isFinite(p.lon); });
    mpFilter = window.GeoState.get("mapPointsFilter", []) || [];
    mpCollections = (window.GeoState.get("mapPointSets", []) || []).filter(function (c) { return c && c.name; });
    mpActiveName = window.GeoState.get("mapPointSetActive", "") || "";
    mpSort = window.GeoState.get("mapPointsSort", "dist") === "name" ? "name" : "dist";
    shownColls = {}; (window.GeoState.get("mapPointsShownColls", []) || []).forEach(function (k) { shownColls[k] = true; });
    shownDetSets = {}; (window.GeoState.get("mapDetSetsShown", []) || []).forEach(function (k) { shownDetSets[k] = true; });
    // Retire the legacy "active list": older builds loaded a saved list into the
    // live working set (mpActiveName), so its pins drew on the map ALWAYS —
    // independent of the list's show-checkbox, which left them stuck-on when
    // unticked. Fold the working set back into its list, tick the list so the
    // pins stay visible (now controllable), and clear the loose set + flag.
    if (mpActiveName) {
      var ac = mpCollections.filter(function (c) { return c.name === mpActiveName; })[0];
      if (ac) { if (mapPoints.length) ac.points = mapPoints.slice(); shownColls[mpActiveName] = true; }
      mapPoints = []; mpActiveName = "";
      window.GeoState.save({ mapPoints: [], mapPointSetActive: "", mapPointSets: mpCollections, mapPointsShownColls: Object.keys(shownColls) });
    }
  }
  // Persist a patch and, if the write hit the localStorage quota (lastSaveOk false),
  // surface a storage-full toast — otherwise these bulky collections (map points /
  // lists / blogs) fail silently and are gone on reload. Mirrors persistDetSet.
  function saveChecked(patch) {
    window.GeoState.save(patch);
    if (window.GeoState.lastSaveOk && !window.GeoState.lastSaveOk()) { setStatus(t("err.storageFull")); return false; }
    return true;
  }
  function saveShownState() {
    saveChecked({ mapPointsShownColls: Object.keys(shownColls), mapDetSetsShown: Object.keys(shownDetSets) });
  }
  function saveMapPoints() {
    // Keep the loaded collection in lock-step with the working set so a list
    // stays current as the user adds/edits/removes pins after loading it.
    if (mpActiveName) {
      var c = mpCollections.filter(function (x) { return x.name === mpActiveName; })[0];
      if (c) c.points = mapPoints.slice();
    }
    saveChecked({ mapPoints: mapPoints, mapPointsFilter: mpFilter, mapPointsShown: mpShown, mapPointSets: mpCollections, mapPointSetActive: mpActiveName });
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
  // Point-lists flagged "protected" can't be deleted (a guard against losing a
  // curated list to a stray ×). Stored as a name list in GeoState.
  function protectedColls() { return window.GeoState.get("mapPointsProtected", []) || []; }
  function isCollProtected(name) { return protectedColls().indexOf(name) >= 0; }
  function setCollProtected(name, on) {
    var list = protectedColls().slice(), i = list.indexOf(name);
    if (on && i < 0) list.push(name); else if (!on && i >= 0) list.splice(i, 1);
    window.GeoState.save({ mapPointsProtected: list });
  }
  // Forget a named list. The pins currently on the map are left untouched.
  function deleteCollection(name) {
    if (isCollProtected(name)) return;   // protected → never deleted
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
      var isHtml = !!p.noteHtml;
      var desc = String(p.note || "");
      var tags = (p.tags || []).join(", ");
      if (tags) desc += (desc ? (isHtml ? "<br>" : "\n") : "") + "Tags: " + tags;
      parts.push("<Placemark>");
      parts.push("<name>" + xml(p.name || "Point") + "</name>");
      // HTML notes are emitted in a CDATA block (KML's convention for rich text) so
      // they survive the round-trip; plain notes are XML-escaped as before.
      if (desc) parts.push("<description>" + (isHtml ? "<![CDATA[" + desc.replace(/]]>/g, "]]&gt;") + "]]>" : xml(desc)) + "</description>");
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
  function pointsHasAny() {
    return (mpActiveName ? 0 : mapPoints.length) + mpCollections.reduce(function (n, c) { return n + ((c.points && c.points.length) || 0); }, 0);
  }
  function exportPointsKml() {
    if (!pointsHasAny()) { setStatus(t("points.exportEmpty")); return; }
    downloadCsv("map_points_" + new Date().toISOString().slice(0, 10) + ".kml", buildPointsKml());
  }
  // ---- KMZ (a ZIP holding doc.kml) — a tiny single-entry ZIP writer/reader,
  // using the browser's deflate-raw (same as share-link payloads). ----
  var _crcTable = null;
  function crc32(bytes) {
    if (!_crcTable) { _crcTable = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _crcTable[n] = c >>> 0; } }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  async function buildKmz(kmlText) {
    var enc = new TextEncoder(), kml = enc.encode(kmlText), name = enc.encode("doc.kml");
    var crc = crc32(kml), uSize = kml.length, method = 0, data = kml;
    if (typeof CompressionStream !== "undefined") {
      try { data = new Uint8Array(await new Response(new Blob([kml]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()); method = 8; }
      catch (e) { data = kml; method = 0; }   // fall back to STORE
    }
    var cSize = data.length;
    var out = new Uint8Array(30 + name.length + cSize + 46 + name.length + 22), dv = new DataView(out.buffer), o = 0;
    dv.setUint32(o, 0x04034b50, true); o += 4; dv.setUint16(o, 20, true); o += 2; dv.setUint16(o, 0, true); o += 2;
    dv.setUint16(o, method, true); o += 2; dv.setUint16(o, 0, true); o += 2; dv.setUint16(o, 0x21, true); o += 2;   // mod time/date (1980)
    dv.setUint32(o, crc, true); o += 4; dv.setUint32(o, cSize, true); o += 4; dv.setUint32(o, uSize, true); o += 4;
    dv.setUint16(o, name.length, true); o += 2; dv.setUint16(o, 0, true); o += 2; out.set(name, o); o += name.length;
    out.set(data, o); o += cSize;
    var cdStart = o;
    dv.setUint32(o, 0x02014b50, true); o += 4; dv.setUint16(o, 20, true); o += 2; dv.setUint16(o, 20, true); o += 2; dv.setUint16(o, 0, true); o += 2;
    dv.setUint16(o, method, true); o += 2; dv.setUint16(o, 0, true); o += 2; dv.setUint16(o, 0x21, true); o += 2;
    dv.setUint32(o, crc, true); o += 4; dv.setUint32(o, cSize, true); o += 4; dv.setUint32(o, uSize, true); o += 4;
    dv.setUint16(o, name.length, true); o += 2; dv.setUint16(o, 0, true); o += 2; dv.setUint16(o, 0, true); o += 2;
    dv.setUint16(o, 0, true); o += 2; dv.setUint16(o, 0, true); o += 2; dv.setUint32(o, 0, true); o += 4; dv.setUint32(o, 0, true); o += 4;
    out.set(name, o); o += name.length;
    var cdSize = o - cdStart;
    dv.setUint32(o, 0x06054b50, true); o += 4; dv.setUint16(o, 0, true); o += 2; dv.setUint16(o, 0, true); o += 2;
    dv.setUint16(o, 1, true); o += 2; dv.setUint16(o, 1, true); o += 2; dv.setUint32(o, cdSize, true); o += 4; dv.setUint32(o, cdStart, true); o += 4; dv.setUint16(o, 0, true);
    return out;
  }
  // Pull the (first) .kml entry's text out of a KMZ ArrayBuffer via its central directory.
  async function extractKmlFromKmz(buf) {
    var bytes = new Uint8Array(buf), dv = new DataView(buf), td = new TextDecoder();
    var eocd = -1, lim = Math.max(0, bytes.length - 22 - 65536);
    for (var i = bytes.length - 22; i >= lim; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error("not a zip");
    var count = dv.getUint16(eocd + 10, true), p = dv.getUint32(eocd + 16, true), target = null;
    for (var e = 0; e < count && dv.getUint32(p, true) === 0x02014b50; e++) {
      var method = dv.getUint16(p + 10, true), cSize = dv.getUint32(p + 20, true);
      var fnLen = dv.getUint16(p + 28, true), exLen = dv.getUint16(p + 30, true), cmLen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      var fn = td.decode(bytes.subarray(p + 46, p + 46 + fnLen));
      if (/\.kml$/i.test(fn)) { target = { method: method, cSize: cSize, lho: lho }; if (/(^|\/)doc\.kml$/i.test(fn)) break; }
      p += 46 + fnLen + exLen + cmLen;
    }
    if (!target) throw new Error("no kml in kmz");
    var lFnLen = dv.getUint16(target.lho + 26, true), lExLen = dv.getUint16(target.lho + 28, true);
    var start = target.lho + 30 + lFnLen + lExLen, comp = bytes.subarray(start, start + target.cSize);
    if (target.method === 0) return td.decode(comp);
    if (target.method !== 8 || typeof DecompressionStream === "undefined") throw new Error("kmz compression");
    var raw = new Uint8Array(await new Response(new Blob([comp]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    return td.decode(raw);
  }
  function downloadBlob(filename, blob) {
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }
  function exportPointsKmz() {
    if (!pointsHasAny()) { setStatus(t("points.exportEmpty")); return; }
    buildKmz(buildPointsKml()).then(function (bytes) {
      downloadBlob("map_points_" + new Date().toISOString().slice(0, 10) + ".kmz", new Blob([bytes], { type: "application/vnd.google-earth.kmz" }));
    }).catch(function () { setStatus(t("kml.parseErr")); });
  }
  // ---- KML import ----
  // Parse a KML document into plain placemark records. Each carries its name,
  // coordinates, description, the enclosing folder name, and any ExtendedData /
  // SimpleData fields — which become the selectable import "fields".
  function parseKmlText(text) {
    var doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error(t("kml.parseErr"));
    var marks = [], fieldSet = {}, folderSet = {};
    var pms = doc.getElementsByTagName("Placemark");
    function txt(el, tag) { var n = el.getElementsByTagName(tag)[0]; return n ? (n.textContent || "").trim() : ""; }
    for (var i = 0; i < pms.length; i++) {
      var pm = pms[i];
      // First coordinates found under this placemark (Point, else first vertex).
      var co = pm.getElementsByTagName("coordinates")[0];
      if (!co) continue;
      var first = (co.textContent || "").trim().split(/\s+/)[0] || "";
      var ll = first.split(",");
      var lon = parseFloat(ll[0]), lat = parseFloat(ll[1]);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      var data = {};
      var ds = pm.getElementsByTagName("Data");
      for (var d = 0; d < ds.length; d++) { var nm = ds[d].getAttribute("name"); var v = txt(ds[d], "value"); if (nm) { data[nm] = v; fieldSet[nm] = 1; } }
      var sds = pm.getElementsByTagName("SimpleData");
      for (var s = 0; s < sds.length; s++) { var snm = sds[s].getAttribute("name"); if (snm) { data[snm] = (sds[s].textContent || "").trim(); fieldSet[snm] = 1; } }
      // Enclosing folder name (nearest ancestor <Folder> with a <name>).
      var folder = "", a = pm.parentNode;
      while (a && a.nodeType === 1) { if (a.tagName === "Folder") { var fn = a.getElementsByTagName("name")[0]; if (fn) { folder = (fn.textContent || "").trim(); break; } } a = a.parentNode; }
      if (folder) folderSet[folder] = 1;
      marks.push({ name: txt(pm, "name"), lat: lat, lon: lon, desc: txt(pm, "description"), data: data, folder: folder });
    }
    return { marks: marks, fields: Object.keys(fieldSet), folders: Object.keys(folderSet) };
  }
  // Resolve a placemark field to text given a mapping token: "name" / "desc" /
  // "folder" / "data:<key>" / "" (none).
  function kmlFieldValue(pm, token) {
    if (!token) return "";
    if (token === "name") return pm.name || "";
    if (token === "desc") return pm.desc || "";
    if (token === "folder") return pm.folder || "";
    if (token.indexOf("data:") === 0) return (pm.data && pm.data[token.slice(5)]) || "";
    return "";
  }
  var kmlImport = null;   // { marks, fields, folders } currently staged for import
  function startKmlImport(text) {
    var parsed;
    try { parsed = parseKmlText(text); } catch (e) { setStatus(t("kml.parseErr")); return; }
    if (!parsed.marks.length) { setStatus(t("kml.none")); return; }
    kmlImport = parsed;
    openKmlImportDialog();
  }
  // A small modal: choose the target list and which placemark field maps to the
  // point's name / tag / note, then import. Built on demand and removed on close.
  function openKmlImportDialog() {
    var p = kmlImport; if (!p) return;
    closeKmlImportDialog();
    // Field options shared by the name/tag/note pickers.
    function opts(extra) {
      var o = extra.slice();
      o.push({ v: "name", l: t("kml.fName") });
      o.push({ v: "desc", l: t("kml.fDesc") });
      if (p.folders.length) o.push({ v: "folder", l: t("kml.fFolder") });
      p.fields.forEach(function (f) { o.push({ v: "data:" + f, l: f }); });
      return o;
    }
    function sel(id, items, cur) {
      return '<select id="' + id + '">' + items.map(function (it) {
        return '<option value="' + escapeHtml(it.v) + '"' + (it.v === cur ? " selected" : "") + ">" + escapeHtml(it.l) + "</option>";
      }).join("") + "</select>";
    }
    var listItems = [{ v: "__new__", l: t("detmenu.newList") }].concat(
      mpCollections.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (c) { return { v: c.name, l: c.name }; }));
    // Sensible defaults: name←Name, tag←folder (if any) else none, note←description.
    var defName = "name", defTag = p.folders.length ? "folder" : "", defNote = "desc";
    // Pre-tick "note is HTML" when the descriptions look like markup (common for
    // KML exported by Google Earth, which wraps rich text / tables in the note).
    var htmlish = p.marks.filter(function (m) { return looksLikeHtml(m.desc); }).length;
    var defHtml = htmlish * 2 >= p.marks.length && htmlish > 0;
    var html = '<div class="kml-modal-box">' +
      '<button type="button" id="kml-close" class="kml-close" aria-label="Close">×</button>' +
      "<h3>" + escapeHtml(t("kml.title")) + "</h3>" +
      '<p class="cu-hint">' + escapeHtml(t("kml.found", { n: p.marks.length })) + "</p>" +
      '<label class="kml-row">' + escapeHtml(t("kml.target")) + sel("kml-target", listItems, "__new__") + "</label>" +
      '<label class="kml-row">' + escapeHtml(t("kml.nameFrom")) + sel("kml-name", opts([]), defName) + "</label>" +
      '<label class="kml-row">' + escapeHtml(t("kml.tagFrom")) + sel("kml-tag", opts([{ v: "", l: t("kml.fNone") }]), defTag) + "</label>" +
      '<label class="kml-row">' + escapeHtml(t("kml.noteFrom")) + sel("kml-note", opts([{ v: "", l: t("kml.fNone") }]), defNote) + "</label>" +
      '<label class="kml-row kml-check"><input type="checkbox" id="kml-note-html"' + (defHtml ? " checked" : "") + " />" + escapeHtml(t("points.noteHtml")) + "</label>" +
      '<div class="kml-actions"><button type="button" id="kml-do" class="demo-btn">' + escapeHtml(t("kml.import")) + "</button></div>" +
      "</div>";
    var ov = document.createElement("div");
    ov.id = "kml-import-modal"; ov.className = "kml-modal";
    ov.innerHTML = html;
    document.body.appendChild(ov);
    ov.addEventListener("click", function (e) { if (e.target === ov) closeKmlImportDialog(); });
    document.getElementById("kml-close").addEventListener("click", closeKmlImportDialog);
    document.getElementById("kml-do").addEventListener("click", doKmlImport);
  }
  function closeKmlImportDialog() { var m = document.getElementById("kml-import-modal"); if (m && m.parentNode) m.parentNode.removeChild(m); }
  function doKmlImport() {
    var p = kmlImport; if (!p) return;
    var target = document.getElementById("kml-target").value;
    var nameTok = document.getElementById("kml-name").value;
    var tagTok = document.getElementById("kml-tag").value;
    var noteTok = document.getElementById("kml-note").value;
    var noteHtmlBox = document.getElementById("kml-note-html");
    var noteIsHtml = !!(noteHtmlBox && noteHtmlBox.checked);
    function finish(listName) {
      var pts = p.marks.map(function (pm) {
        var tag = kmlFieldValue(pm, tagTok).trim();
        var note = kmlFieldValue(pm, noteTok).trim();
        var pt = { id: mpUid(), lat: pm.lat, lon: pm.lon,
          name: kmlFieldValue(pm, nameTok).trim() || pm.name || "",
          tags: tag ? [tag] : [], note: note, source: "kml", createdAt: new Date().toISOString() };
        if (noteIsHtml && note) pt.noteHtml = true;
        return pt;
      });
      var c = mpCollections.filter(function (x) { return x.name === listName; })[0];
      if (!c) { c = { name: listName, points: [] }; mpCollections.push(c); }
      c.points = c.points.concat(pts);
      shownColls[listName] = true; saveShownState();
      saveMapPoints(); renderMapPoints();
      closeKmlImportDialog(); kmlImport = null;
      setStatus(t("kml.imported", { n: pts.length, name: listName }));
    }
    if (target === "__new__") {
      modalPrompt(t("detmenu.newListPrompt"), "").then(function (n) { n = (n || "").trim(); if (n) finish(n); });
    } else finish(target);
  }
  // Open Google Maps with a navigable route through the given points (the start
  // is the user's own location). A single point → directions straight to it;
  // several → waypoints. The Maps URL API allows ~10 stops, so we route to the
  // nearest ones to the current map view and note when some are dropped.
  var GMAP_MAX_STOPS = 10;
  function gmapRoute(pts) {
    var ll = function (x) { return (+x.lat).toFixed(6) + "," + (+x.lon).toFixed(6); };
    if (pts.length === 1) return "https://www.google.com/maps/dir/?api=1&destination=" + ll(pts[0]) + "&travelmode=driving";
    var dest = pts[pts.length - 1], wps = pts.slice(0, pts.length - 1).map(ll).join("|");
    return "https://www.google.com/maps/dir/?api=1&destination=" + ll(dest) + "&waypoints=" + encodeURIComponent(wps) + "&travelmode=driving";
  }
  // Reference point for ordering/capping the navigation stops: the current map
  // marker (the clicked/located spot) when it's visible, else the map centre.
  function navRefPoint() {
    if (marker && map) {
      try { var ll = marker.getLatLng(); if (map.getBounds().contains(ll)) return { lat: ll.lat, lon: ll.lng }; } catch (e) {}
    }
    var c = map && map.getCenter();
    return c ? { lat: c.lat, lon: c.lng } : null;
  }
  function navigatePoints(pts) {
    var seen = {}, uniq = [];
    (pts || []).forEach(function (p) {
      if (!p || !isFinite(+p.lat) || !isFinite(+p.lon)) return;
      var k = (+p.lat).toFixed(4) + "," + (+p.lon).toFixed(4);   // collapse co-located points to one stop
      if (seen[k]) return; seen[k] = 1; uniq.push({ lat: +p.lat, lon: +p.lon });
    });
    if (!uniq.length) { setStatus(t("nav.empty")); return; }
    // Keep the stops nearest the current marker (or map centre) so a capped route
    // covers the most relevant spots…
    var ref = navRefPoint();
    if (ref && uniq.length > 1) uniq.sort(function (a, b) { return haversineKm(ref.lat, ref.lon, a.lat, a.lon) - haversineKm(ref.lat, ref.lon, b.lat, b.lon); });
    var dropped = Math.max(0, uniq.length - GMAP_MAX_STOPS);
    var stops = uniq.slice(0, GMAP_MAX_STOPS);
    // …then order them as a greedy nearest-neighbour chain from the reference, so
    // the driving route runs spot-to-spot instead of zig-zagging.
    if (ref && stops.length > 2) {
      var chain = [], rem = stops.slice(), cur = ref;
      while (rem.length) {
        var bi = 0, bd = Infinity;
        for (var i = 0; i < rem.length; i++) { var dd = haversineKm(cur.lat, cur.lon, rem[i].lat, rem[i].lon); if (dd < bd) { bd = dd; bi = i; } }
        cur = rem[bi]; chain.push(cur); rem.splice(bi, 1);
      }
      stops = chain;
    }
    openExternal(gmapRoute(stops));   // Google Maps driving directions → tap Start for car navigation
    setStatus(dropped ? t("nav.capped", { n: GMAP_MAX_STOPS, dropped: dropped }) : t("nav.opened", { n: stops.length }));
  }
  // ---- Route basket: hand-pick stops (in order), then open one driving route ---
  var routePoints = [];
  function loadRoute() { routePoints = (window.GeoState.get("routePoints", []) || []).filter(function (p) { return p && isFinite(+p.lat) && isFinite(+p.lon); }); }
  function saveRoute() { window.GeoState.save({ routePoints: routePoints }); }
  function addToRoute(lat, lon, name) {
    if (!isFinite(+lat) || !isFinite(+lon)) return;
    routePoints.push({ lat: +lat, lon: +lon, name: name || "" });
    saveRoute(); updateRouteChip();
    setStatus(t("route.added", { n: routePoints.length }));
  }
  function clearRoute() { routePoints = []; saveRoute(); updateRouteChip(); }
  function navigateRoute() {
    if (!routePoints.length) { setStatus(t("nav.empty")); return; }
    var stops = routePoints.slice(0, GMAP_MAX_STOPS);   // add-order is the user's intended order — don't reshuffle
    openExternal(gmapRoute(stops));
    if (routePoints.length > GMAP_MAX_STOPS) setStatus(t("nav.capped", { n: GMAP_MAX_STOPS, dropped: routePoints.length - GMAP_MAX_STOPS }));
    else setStatus(t("nav.opened", { n: stops.length }));
  }
  // A floating pill (shown only while the basket has stops) with the count, a
  // Navigate button and a Clear ×.
  var routeChipEl = null;
  function updateRouteChip() {
    if (!routeChipEl) { routeChipEl = document.createElement("div"); routeChipEl.id = "route-chip"; document.body.appendChild(routeChipEl); }
    if (!routePoints.length) { routeChipEl.style.display = "none"; return; }
    routeChipEl.style.display = "";
    routeChipEl.innerHTML =
      '<span class="route-chip-lbl">' + ico("nav") + "<span>" + escapeHtml(t("route.count", { n: routePoints.length })) + "</span></span>" +
      '<button type="button" class="route-go">' + escapeHtml(t("route.go")) + "</button>" +
      '<button type="button" class="route-clear" aria-label="' + escapeHtml(t("route.clear")) + '" title="' + escapeHtml(t("route.clear")) + '">×</button>';
    routeChipEl.querySelector(".route-go").addEventListener("click", navigateRoute);
    routeChipEl.querySelector(".route-clear").addEventListener("click", clearRoute);
  }
  // ---- Whole-list overlay: a coloured KML of pins for Google My Maps ----------
  // #RRGGBB → KML aabbggrr, so My Maps tints each pin the app's colour.
  function hexToKml(hex) {
    var h = String(hex || "").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return "ff1a73e8";
    return ("ff" + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toLowerCase();
  }
  function kmlForPoints(name, pts) {
    var xml = function (s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
    var styles = {}, styleOrder = [];
    // App symbolism in My Maps: species colour for normal pins, a ★ for starred,
    // and BLACK for rare (the app's black centre-dot) — so rare-only = black dot,
    // starred = coloured star, starred+rare = black star.
    function styleFor(color, star, rare) {
      var kc = rare ? "ff000000" : hexToKml(color);
      var key = (star ? "s" : "d") + (rare ? "r" : "") + kc;
      if (!styles[key]) {
        var icon = star ? "http://maps.google.com/mapfiles/kml/shapes/star.png" : "http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png";
        styles[key] = '<Style id="' + key + '"><IconStyle><color>' + kc + '</color><scale>1.1</scale><Icon><href>' + icon + "</href></Icon></IconStyle></Style>";
        styleOrder.push(key);
      }
      return key;
    }
    var marks = pts.map(function (p) {
      return "<Placemark><name>" + xml(p.name || "Point") + "</name>" +
        (p.desc ? "<description>" + xml(p.desc) + "</description>" : "") +
        "<styleUrl>#" + styleFor(p.color, p.star, p.rare) + "</styleUrl>" +
        "<Point><coordinates>" + (+p.lon).toFixed(6) + "," + (+p.lat).toFixed(6) + ",0</coordinates></Point></Placemark>";
    });
    var parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>', "<name>" + xml(name) + "</name>"];
    styleOrder.forEach(function (k) { parts.push(styles[k]); });
    return parts.concat(marks).concat(["</Document></kml>"]).join("\n");
  }
  function sendPointsToGoogle(name, pts) {
    var list = (pts || []).filter(function (p) { return p && isFinite(+p.lat) && isFinite(+p.lon); });
    if (!list.length) { setStatus(t("nav.empty")); return; }
    var kml = kmlForPoints(name || "Points", list);
    var safe = String(name || "points").replace(/[^\w-]+/g, "_").slice(0, 40) || "points";
    var fname = "gmaps_" + safe + "_" + new Date().toISOString().slice(0, 10) + ".kml";
    try {   // one-tap native share (Google Earth / Drive) where supported, else download
      var file = new File([kml], fname, { type: "application/vnd.google-earth.kml+xml" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: name || "Points" }).then(
          function () { setStatus(t("nav.shared", { n: list.length })); },
          function (e) { if (!e || e.name !== "AbortError") sendKmlFallback(fname, kml, list.length); }
        );
        return;
      }
    } catch (e) {}
    sendKmlFallback(fname, kml, list.length);
  }
  function sendKmlFallback(fname, kml, n) {
    downloadCsv(fname, kml);
    openExternal("https://www.google.com/maps/d/");
    setStatus(t("nav.kml", { n: n }));
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
  var mpPins = [];   // {m, p, editable} for every rendered pin — used to fan out overlaps
  function renderMpPin(p, editable, color) {
    // A detection-saved pin (read-only, carries the species' colour) is drawn
    // like the plotted detection — species colour + ★ for interesting + a black
    // centre dot for rare — sitting on a slightly larger list-coloured disc, so
    // the list is recognisable by its background colour.
    if (!editable && p.spColor) {
      var listCol = color || mpColorFor(p);
      // Draw the list-colour disc in the SAME renderer as the species symbol and
      // add it FIRST, so within that one <svg> the DOM order guarantees the disc
      // sits behind the marker pattern/colour (different renderers wouldn't).
      var halo = L.circleMarker([p.lat, p.lon], { radius: 10, color: listCol, weight: 1.5, opacity: 0.95, fillColor: listCol, fillOpacity: 0.5, renderer: detRenderer() });
      halo.bindTooltip(mpTipHtml(p), { direction: "top", className: "det-hover-tip" });
      var hrec = { m: halo, p: p, editable: false };
      mpPins.push(hrec);
      halo.on("click", function (e) { if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent); onMpPinClick(hrec); });
      mpLayer.addLayer(halo);
      var sym = p.star
        ? detStarMarker([p.lat, p.lon], { radius: 6.5, color: "#1a1a1a", weight: 1, fillColor: p.spColor, fillOpacity: 0.95, interactive: false, renderer: detRenderer() })
        : L.circleMarker([p.lat, p.lon], { radius: 5, color: "#1a1a1a", weight: 1, fillColor: p.spColor, fillOpacity: 0.95, interactive: false, renderer: detRenderer() });
      mpLayer.addLayer(sym);
      if (p.rare) mpLayer.addLayer(L.circleMarker([p.lat, p.lon], { radius: 1.7, weight: 0, fillColor: "#111", fillOpacity: 1, interactive: false, renderer: detRenderer() }));
      return;
    }
    var m = L.circleMarker([p.lat, p.lon], {
      radius: 7, color: "#111", weight: 1, opacity: 0.9,
      fillColor: p.color || color || mpColorFor(p), fillOpacity: editable ? 0.9 : 0.65   // explicit per-point colour wins over list/tag colour
    });
    m.bindTooltip(mpTipHtml(p), { direction: "top", className: p.spColor ? "det-hover-tip" : "area-tip" });
    var rec = { m: m, p: p, editable: editable };
    mpPins.push(rec);
    // Stop propagation so a marker click doesn't open the species-list popup
    // behind it. Co-located pins (several species at one spot) fan out; a lone
    // pin opens its editor (working pins) or just flies/tooltips (saved lists).
    m.on("click", function (e) {
      if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
      onMpPinClick(rec);
    });
    mpLayer.addLayer(m);
  }
  function mpPinAction(rec) {
    var p = rec.p;
    setMpDistOrigin(p.lat, p.lon);   // selecting a pin on the map re-measures + re-sorts the point lists
    if (rec.editable) { openPointEditor(p); return; }
    // Any read-only list pin (detection-saved OR an old manually-tagged point)
    // opens the shared action menu: source link, focus, Navigate here, ＋ Add to
    // route and Add to list — plus the star / year / life / hide toggles when the
    // pin carries a species key. drmRenderMain shows only the rows that apply, so
    // a plain tagged point still gets "Navigate here" / "Add to route".
    var d = { name: p.name || "", key: p.spKey || "", lat: p.lat, lon: p.lon, url: p.url || "", date: p.date || "", act: p.act || "", count: p.count, color: p.spColor || "" };
    var ct = map.latLngToContainerPoint([p.lat, p.lon]), box = map.getContainer().getBoundingClientRect();
    showDetRowMenu(d, box.left + ct.x, box.top + ct.y, function () { renderMapPoints(); });
  }
  // Every rendered pin within `px` screen-pixels of this one (i.e. visually
  // stacked — typically several species saved at the same location/date).
  function mpOverlaps(rec, px) {
    if (!map) return [rec];
    var c = map.latLngToLayerPoint([rec.p.lat, rec.p.lon]), thr = px || 16, out = [];
    mpPins.forEach(function (o) {
      if (map.latLngToLayerPoint([o.p.lat, o.p.lon]).distanceTo(c) <= thr) out.push(o);
    });
    return out;
  }
  function onMpPinClick(rec) {
    clearSpider();
    var group = mpOverlaps(rec, 16);
    if (group.length <= 1) { mpPinAction(rec); return; }
    spiderOutMp(L.latLng(rec.p.lat, rec.p.lon), group);
  }
  // Fan the co-located pins out around their shared point ("rainbow"), each in
  // its per-species colour, with a leader line and its species/date/activity
  // tooltip. Click a fanned pin to open it (working pins). Dismissed by
  // clearSpider (map click / pan / zoom / Escape).
  function spiderOutMp(center, group) {
    var layer = L.layerGroup();
    var n = group.length, R = Math.min(60, 20 + n * 5);
    var cpt = map.latLngToLayerPoint(center);
    group.forEach(function (o, i) {
      o.m._preFanOp = o.m.options.opacity; o.m._preFanFill = o.m.options.fillOpacity;
      try { o.m.setStyle({ opacity: 0.12, fillOpacity: 0.12 }); } catch (e) {}
      spiderHidden.push(o.m);
      var a = 2 * Math.PI * i / n - Math.PI / 2;
      var ll = map.layerPointToLatLng(L.point(cpt.x + R * Math.cos(a), cpt.y + R * Math.sin(a)));
      layer.addLayer(L.polyline([center, ll], { color: "#888", weight: 1, opacity: 0.6, interactive: false }));
      var fm = L.circleMarker(ll, { radius: 7, color: "#111", weight: 1, fillColor: mpColorFor(o.p), fillOpacity: 0.95 });
      fm.bindTooltip(mpTipHtml(o.p), { direction: "top", className: o.p && o.p.spColor ? "det-hover-tip" : "area-tip" });
      fm.on("click", function (e) { if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent); clearSpider(); mpPinAction(o); });
      layer.addLayer(fm);
    });
    layer.addTo(map);
    spiderLayer = layer;
  }
  function renderMapPoints() {
    if (!map) return;
    clearSpider();            // any open fan-out refers to markers about to be replaced
    ensureMpLayer().clearLayers();
    mpPins = [];
    updateDetSetOverlays();   // keep the shown detection-set layers in sync
    mapPoints.forEach(function (p) { if (mpVisible(p)) renderMpPin(p, true); });   // loose working pins (editable, tag colour)
    // Ticked saved point-lists: a list's DETECTION points (those carrying a species
    // key) are plotted through the shared detection pipeline (syncListDetections),
    // so they obey the same legend filters and open the same popups as fetched
    // data. Manually-tagged points (no species key) keep their own pin + editor.
    mpCollections.forEach(function (c) {
      if (!shownColls[c.name]) return;
      var col = collColor(c);
      (c.points || []).forEach(function (p) {
        if (!p || !isFinite(p.lat) || !isFinite(p.lon)) return;
        if (p.spKey) return;   // detection point → detPlot pipeline (handled below)
        renderMpPin(p, false, col);
      });
    });
    syncListDetections();     // merge shown lists' detection points into detPlot
    refreshMpPanel();
    updateMpBadge();
  }
  // Feed the DETECTION points of every shown saved list into the shared detPlot,
  // so the one legend filters them (rare / starred / days / selection) and they
  // open the same popups as fetched data. Injected rows are flagged `_list` (with
  // the list's colour for the halo) so they can be re-derived each render and are
  // never persisted as fetched dots (see serializeDetPlot). Reuses mergeDetRows,
  // recolourDetections, recomputeRareMax, rebuildDetLayers and updateDetLegend.
  function syncListDetections() {
    if (!map || typeof detPlot === "undefined") return;
    var changed = false;
    // 1. Drop previously-injected list rows; remove species left with no rows
    //    (i.e. list-only species whose list is no longer shown).
    Object.keys(detPlot).forEach(function (k) {
      var e = detPlot[k], before = (e.rows || []).length;
      e.rows = (e.rows || []).filter(function (r) { return !r._list; });
      if (e.rows.length !== before) changed = true;
      if (!e.rows.length) { if (e.group) { map.removeLayer(e.group); } delete detPlot[k]; delete detSelected[k]; }
    });
    // 2. Inject the current shown lists' detection points, grouped by species key.
    mpCollections.forEach(function (c) {
      if (!shownColls[c.name]) return;
      var col = collColor(c);
      (c.points || []).forEach(function (p) {
        if (!p || !p.spKey || !isFinite(p.lat) || !isFinite(p.lon)) return;
        var row = { lat: +p.lat, lon: +p.lon, date: p.date || "", url: p.url || "", count: p.count, act: p.act || "", src: p.src || "list", _list: true, listColor: col, _listName: c.name, _mpId: p.id };
        var e = detPlot[p.spKey];
        if (!e) e = detPlot[p.spKey] = { key: p.spKey, name: p.name || p.spKey, color: p.spColor || "#888", rows: [], group: null, cls: (taxByCode[p.spKey] && taxByCode[p.spKey].class_name) || "" };
        e.rows = mergeDetRows(e.rows, [row]);
        changed = true;
      });
    });
    if (!changed) return;   // no list rows added/removed → fetched layers already current
    recolorDetections();
    recomputeRareMax();
    rebuildDetLayers();
    updateDetLegend();
  }
  // Detection sets shown as overlays — one map layer-group per ticked set, kept
  // in sync with shownDetSets. Each set's stored dots are drawn in their colour.
  function renderDetSetOverlay(set) {
    var g = L.layerGroup();
    Object.keys(set.detections || {}).forEach(function (k) {
      var e = set.detections[k] || {};
      (e.rows || []).forEach(function (r) {
        if (r.lat == null || r.lon == null) return;
        var nm = detName({ key: e.key || k, cls: e.cls || "", name: e.name }) || e.name || k;   // localise to the recipient's language / sci-name setting
        // Popup: species + date/count/observer/source and a "verify at source" link,
        // so a shared trip's provenance is visible and checkable. A hover tooltip
        // shows just the species for quick scanning.
        var meta = [];
        if (r.date) meta.push(fmtDate(r.date));
        if (r.count != null && r.count !== "") meta.push("×" + r.count);
        if (r.observer) meta.push(String(r.observer));
        var pop = "<b>" + escapeHtml(nm) + "</b>" +
          (meta.length ? "<div class='area-tip-sub'>" + escapeHtml(meta.join(" · ")) + "</div>" : "") +
          (r.src ? "<div class='dset-src'>" + (r.url
            ? '<a href="' + escapeHtml(safeHref(r.url)) + '" target="_blank" rel="noopener">' + escapeHtml(r.src) + " ↗</a>"
            : escapeHtml(r.src)) + "</div>" : "");
        // A larger, near-invisible hit circle so a 5 px trip dot is easy to TAP.
        var hit = L.circleMarker([r.lat, r.lon], { radius: 12, stroke: false, fillColor: "#000", fillOpacity: 0.01, renderer: detRenderer() });
        hit.bindTooltip(escapeHtml(nm), { direction: "top", className: "det-hover-tip" });
        hit.bindPopup(pop, { className: "area-tip", closeButton: true });
        g.addLayer(hit);
        // Visible dot on top, non-interactive so the taps go to the hit circle.
        var dot = L.circleMarker([r.lat, r.lon], { radius: 5, color: "#1a1a1a", weight: 1, opacity: 0.9, fillColor: e.color || "#888", fillOpacity: 0.85, interactive: false, renderer: detRenderer() });
        g.addLayer(dot);
      });
    });
    return g;
  }
  function updateDetSetOverlays() {
    if (!map) return;
    Object.keys(detSetOverlays).forEach(function (name) {
      if (!shownDetSets[name]) { try { map.removeLayer(detSetOverlays[name]); } catch (e) {} delete detSetOverlays[name]; }
    });
    Object.keys(shownDetSets).forEach(function (name) {
      if (detSetOverlays[name]) return;
      var set = detSets().filter(function (s) { return s.name === name; })[0];
      if (!set) { delete shownDetSets[name]; return; }
      var gl = renderDetSetOverlay(set); gl.addTo(map); detSetOverlays[name] = gl;
    });
  }
  function mpTipHtml(p) {
    var name = escapeHtml(p.name || "(point)");
    // A pin saved from a detection hovers exactly like the live plotted dot: the
    // full species swatch (colour disc + ★ + rare centre-dot + need-ring) then the
    // name and the same "×N (nd)" meta, with the recorded date / activity below.
    if (p.spColor) {
      var meta = [];
      if (p.count != null && p.count !== "") meta.push("×" + p.count);
      var ts = Date.parse(p.date);
      if (!isNaN(ts)) meta.push("(" + Math.max(0, Math.round((Date.now() - ts) / 86400000)) + "d)");
      var head = detSwatch(p.spColor, !!p.star, !!p.rare, p.spKey || null) + name +
        (meta.length ? ' <span class="dh-meta">' + escapeHtml(meta.join(" ")) + "</span>" : "");
      var subL = String(p.note || "").split("\n").map(function (s) { return s.trim(); })
        .filter(function (s) { return s && !/^https?:\/\//i.test(s); });
      return head + (subL.length ? '<span class="area-tip-note">' + subL.map(escapeHtml).join("<br>") + "</span>" : "");
    }
    // Don't repeat a tag that just duplicates the name (detection pins tag the
    // species, which is also the name) — otherwise the species shows twice.
    var tagList = (p.tags || []).filter(function (tg) { return tg && tg !== p.name; });
    var tags = tagList.length ? '<span class="area-tip-sub">' + escapeHtml(tagList.join(" · ")) + "</span>" : "";
    // Notes flagged as HTML (imported KML descriptions) render as sanitised markup;
    // plain notes show their text lines (date / activity / remark), dropping any
    // source URL line — so a saved detection reveals when & what behaviour was
    // recorded even on read-only collection pins (which don't open the editor).
    var note = "";
    if (p.noteHtml && p.note) {
      note = '<span class="area-tip-note area-tip-html">' + sanitizeHtml(p.note) + "</span>";
    } else {
      var noteLines = String(p.note || "").split("\n").map(function (s) { return s.trim(); })
        .filter(function (s) { return s && !/^https?:\/\//i.test(s); });
      note = noteLines.length ? '<span class="area-tip-note">' + noteLines.map(escapeHtml).join("<br>") + "</span>" : "";
    }
    return "<b>" + name + "</b>" + tags + note;
  }
  function updateMpBadge() {
    // Badge = number of saved point-lists (not the count of loose working pins).
    var el = document.getElementById("mp-btn-text"); if (el) { var n = mpCollections.length; el.textContent = n ? String(n) : ""; }
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
    var pop = L.popup({ closeButton: true, autoClose: true, maxWidth: 280, className: "mp-popup" })
      .setLatLng([p.lat, p.lon]).setContent(html);
    mpEditPopup = pop; pop.openOn(map);
    setTimeout(function () { wireEditorPopup(p, isEdit); }, 0);
  }
  var mpEditPopup = null;
  function mpEditorHtml(p, isEdit) {
    var esc = escapeHtml;
    // New points get a "Save to list" picker; the choice (the active list) is
    // remembered, so subsequent points drop straight into the same list. A LOOSE
    // point being edited (no active list) gets it too, so it can be filed later.
    var showListSel = !isEdit || !mpActiveName;
    var listSel = !showListSel ? "" :
      '<label>' + esc(t("points.saveToList")) +
        '<select id="mp-listsel">' +
          '<option value=""' + (mpActiveName ? "" : " selected") + ">" + esc(t("points.listNone")) + "</option>" +
          mpCollections.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (c) {
            return '<option value="' + esc(c.name) + '"' + (c.name === mpActiveName ? " selected" : "") + ">" + esc(c.name) + "</option>";
          }).join("") +
          '<option value="__new__">' + esc(t("points.listNew")) + "</option>" +
        "</select>" +
      "</label>";
    var coordsPill = '<button type="button" class="mp-meta mp-coords-copy" data-lat="' + p.lat + '" data-lon="' + p.lon + '" title="' + esc(t("coords.copyBtn")) + '">' + p.lat.toFixed(5) + ", " + p.lon.toFixed(5) + " " + ico("copy") + "</button>";
    return '<div class="mp-form">' +
      '<input type="text" id="mp-name" aria-label="' + esc(t("points.name")) + '" placeholder="' + esc(t("points.name")) + '" value="' + esc(p.name || "") + '" />' +
      '<input type="text" id="mp-tags" aria-label="' + esc(t("points.tags")) + '" placeholder="' + esc(t("points.tagsPh")) + '" value="' + esc((p.tags || []).join(", ")) + '" />' +
      '<div class="mp-row">' + mpColorRow(p) + coordsPill + "</div>" +
      '<textarea id="mp-note" aria-label="' + esc(t("points.note")) + '" placeholder="' + esc(t("points.note")) + '" rows="2">' + esc(p.note || "") + "</textarea>" +
      listSel +
      '<div class="mp-actions">' +
        '<button type="button" id="mp-save" class="demo-btn">' + esc(t("points.save")) + '</button>' +
        '<button type="button" id="mp-nav" class="demo-btn demo-btn-light ico-btn" title="' + esc(t("nav.title")) + '">' + ico("nav") + "<span>" + esc(t("nav.go")) + "</span></button>" +
        '<button type="button" id="mp-route" class="demo-btn demo-btn-light" title="' + esc(t("route.add")) + '">＋</button>' +
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
    wireMpColorRow();
    var cc = document.querySelector(".mp-coords-copy");
    if (cc) cc.addEventListener("click", function () { copyCoords(this.getAttribute("data-lat"), this.getAttribute("data-lon")); });
    var nv = document.getElementById("mp-nav");
    if (nv) nv.addEventListener("click", function () { navigatePoints([{ lat: p.lat, lon: p.lon }]); });
    var rt = document.getElementById("mp-route");
    if (rt) rt.addEventListener("click", function () { addToRoute(p.lat, p.lon, p.name); });
    var save = document.getElementById("mp-save"); if (!save) return;
    save.addEventListener("click", function () {
      var name = (document.getElementById("mp-name").value || "").trim();
      var tags = mpParseTags(document.getElementById("mp-tags").value);
      var note = (document.getElementById("mp-note").value || "").trim();
      var color = mpReadColor();
      var sel = document.getElementById("mp-listsel");
      var target = sel ? sel.value : "";
      if (isEdit) {
        updateMapPoint(p.id, { name: name, tags: tags, note: note, color: color });
        // A loose pin can be filed into a list from its editor: move the (updated)
        // point into the chosen collection and drop the loose pin.
        if (target && !mpActiveName) {
          var moved = Object.assign({}, mapPoints.filter(function (x) { return x.id === p.id; })[0] || { id: p.id, lat: p.lat, lon: p.lon, name: name, tags: tags, note: note, color: color, source: "manual" });
          var fileIt = function (n) { deleteMapPoint(p.id); addPointToCollection(n, moved); shownColls[n] = true; saveShownState(); renderMapPoints(); };
          if (target === "__new__") { modalPrompt(t("points.saveAsPrompt"), "").then(function (n) { n = (n || "").trim(); if (n) fileIt(n); map.closePopup(); }); return; }
          fileIt(target);
        }
        map.closePopup(); return;
      }
      var pt = { id: mpUid(), lat: p.lat, lon: p.lon, name: name, tags: tags, note: note, color: color, source: "manual", createdAt: new Date().toISOString() };
      if (!target) { addMapPoint(pt); map.closePopup(); return; }   // loose working pin
      var addToList = function (n) { addPointToCollection(n, pt); shownColls[n] = true; saveShownState(); renderMapPoints(); map.closePopup(); };
      if (target === "__new__") {
        modalPrompt(t("points.saveAsPrompt"), "").then(function (n) { n = (n || "").trim(); if (n) addToList(n); });
      } else addToList(target);
    });
    var del = document.getElementById("mp-del");
    if (del) del.addEventListener("click", function () { deleteMapPoint(p.id); map.closePopup(); });
    // National-service website links moved to the right-side Country button — the
    // point editor stays focused on the point itself.
  }
  // Right-click on desktop, long-press on touch — Leaflet fires both as "contextmenu".
  function onMapContextMenu(e) {
    // Registering a location by long-press must be a deliberate ≥500 ms hold (a
    // shorter touch shouldn't drop a point). Mouse right-click is not gated.
    if (mapPtrIsTouch && touchHeldMs() < 500) return;
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
    var center = mpDistOrigin || (map && map.getCenter());   // measure from the last selected point, else map centre
    // The list below the selection shows the points of the TICKED saved lists
    // only — the union of every shown list's pins, each tagged with its list
    // name and drawn in that list's stable colour. (Loose working pins are not
    // listed here; they live on the map and in the "unsaved" banner until saved
    // into a list.)
    var unionPts = [];
    mpCollections.forEach(function (c) {
      if (!shownColls[c.name]) return;
      var col = collColor(c);
      (c.points || []).forEach(function (p) { if (p && isFinite(p.lat) && isFinite(p.lon)) unionPts.push({ p: p, color: col, list: c.name, editable: false }); });
    });
    unionPts.sort(mpSort === "name"
      ? function (a, b) { return (a.p.name || "").localeCompare(b.p.name || ""); }
      : function (a, b) { if (!center) return 0; return haversineKm(center.lat, center.lng, a.p.lat, a.p.lon) - haversineKm(center.lat, center.lng, b.p.lat, b.p.lon); });
    var chipsHtml = allTags.map(function (tag) {
      var active = mpFilter.indexOf(tag) >= 0;
      return '<button type="button" class="mp-chip' + (active ? " is-active" : "") + '" data-tag="' + escapeHtml(tag) + '" style="--mp-c:' + mpHashColor(tag) + '">' + escapeHtml(tag) + "</button>";
    }).join("");
    if (hasUntagged) {
      var actNoTag = mpFilter.indexOf("") >= 0;
      chipsHtml += '<button type="button" class="mp-chip' + (actNoTag ? " is-active" : "") + '" data-tag="">' + escapeHtml(t("points.notag")) + "</button>";
    }
    var listHtml = unionPts.length ? unionPts.map(function (u) {
      var p = u.p;
      var dist = center ? haversineKm(center.lat, center.lng, p.lat, p.lon) : null;
      var dt = dist == null ? "" : (dist < 1 ? Math.round(dist * 1000) + " m" : dist.toFixed(1) + " km");
      var meta = u.list
        ? '<span class="mp-row-list">' + escapeHtml(u.list) + "</span>"
        : (p.tags || []).slice(0, 3).map(function (x) { return '<span class="mp-row-tag" style="--mp-c:' + mpHashColor(x) + '">' + escapeHtml(x) + "</span>"; }).join("");
      return '<div class="dd-row mp-row">' +
        '<button type="button" class="dd-name mp-fly" data-id="' + escapeHtml(u.editable ? p.id : "") + '" data-lat="' + p.lat + '" data-lon="' + p.lon + '"><span class="mp-sw" style="background:' + u.color + '"></span>' + escapeHtml(p.name || "(point)") + "</button>" +
        '<span class="mp-row-meta">' + meta + '<span class="mp-dist">' + escapeHtml(dt) + "</span></span>" +
        (u.editable ? '<button type="button" class="dd-del mp-del" data-id="' + escapeHtml(p.id) + '" aria-label="remove">×</button>' : '<span class="mp-row-ro" title="' + escapeHtml(t("points.show")) + '"></span>') +
        "</div>";
    }).join("") : '<p class="dd-empty">' + escapeHtml(t("points.empty")) + "</p>";
    // Saved lists + detection sets as tick-to-show overlays, each with a swatch:
    // a per-list colour for point-lists, a 🗂 for detection sets (their dots keep
    // their own per-species colours on the map).
    function mpCollRowHtml(type, name, count, swatch, checked, delTip, isProt) {
      // Protected point-lists show a 🔒 instead of the delete × (manage protection
      // in Settings → Administer lists).
      var del = isProt
        ? '<span class="mp-coll-lock" title="' + escapeHtml(t("lists.protect")) + '">' + ico("lock") + "</span>"
        : '<button type="button" class="mp-coll-del" data-type="' + type + '" data-name="' + escapeHtml(name) + '" aria-label="' + escapeHtml(delTip) + '" title="' + escapeHtml(delTip) + '">×</button>';
      var navBtn = '<button type="button" class="mp-coll-nav ico-btn" data-type="' + type + '" data-name="' + escapeHtml(name) + '" title="' + escapeHtml(t("nav.send")) + '" aria-label="' + escapeHtml(t("nav.send")) + '">' + ico("nav") + "</button>";
      var shareBtn = '<button type="button" class="mp-coll-share ico-btn" data-type="' + type + '" data-name="' + escapeHtml(name) + '" title="' + escapeHtml(t("share.link")) + '" aria-label="' + escapeHtml(t("share.link")) + '">' + ico("share") + "</button>";
      // Edit (colour + tags for the whole list) — point-lists only.
      var editBtn = type === "p"
        ? '<button type="button" class="mp-coll-edit ico-btn" data-name="' + escapeHtml(name) + '" title="' + escapeHtml(t("points.editList")) + '" aria-label="' + escapeHtml(t("points.editList")) + '">' + ico("edit") + "</button>"
        : "";
      return '<div class="mp-coll-row">' +
        '<label class="mp-coll-lbl"><input type="checkbox" class="mp-coll-cb" data-type="' + type + '" data-name="' + escapeHtml(name) + '"' + (checked ? " checked" : "") + ">" +
          swatch + '<span class="mp-coll-name">' + escapeHtml(name) + ' <span class="mp-coll-n">(' + count + ")</span></span></label>" +
        navBtn + shareBtn + editBtn + del +
        "</div>";
    }
    var collItems = mpCollections.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (c) {
      return mpCollRowHtml("p", c.name, (c.points && c.points.length) || 0, '<span class="mp-sw" style="background:' + collColor(c) + '"></span>', !!shownColls[c.name], t("points.deleteColl"), isCollProtected(c.name));
    });
    var dsItems = detSets().slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (s) {
      var n = 0; Object.keys(s.detections || {}).forEach(function (k) { n += ((s.detections[k] || {}).rows || []).length; });
      return mpCollRowHtml("d", s.name, n, '<span class="mp-sw-set">' + ico("folder") + "</span>", !!shownDetSets[s.name], t("dset.delete"));
    });
    var collSection = (collItems.length || dsItems.length) ? '<div class="mp-coll-list">' + collItems.join("") + dsItems.join("") + "</div>" : "";
    var hasMapContent = Object.keys(detPlot).length || allShownUserPoints().length;
    panel.innerHTML =
      '<div class="mp-head mp-head-share">' +
        (hasMapContent ? '<button type="button" id="mp-share-map" class="demo-btn ico-btn" title="' + escapeHtml(tLabel("share.mapBtn")) + '">' + ico("share") + '<span class="ico-label">' + escapeHtml(tLabel("share.mapBtn")) + "</span></button>" : "") +
        '<button type="button" id="mp-import-share" class="demo-btn demo-btn-light ico-btn" title="' + escapeHtml(tLabel("share.importFile")) + '">' + ico("upload") + '<span class="ico-label">' + escapeHtml(tLabel("share.importFile")) + "</span></button>" +
        '<input type="file" id="share-file-input" accept=".mcshare,.txt,text/plain" style="display:none" />' +
      "</div>" +
      (Object.keys(detPlot).length ? '<div class="mp-head">' +
        '<button type="button" id="mp-save-det" class="demo-btn ico-btn">' + ico("save") + '<span class="ico-label" data-i18n="points.savePoints">' + escapeHtml(tLabel("points.savePoints")) + "</span></button>" +
        '<button type="button" id="mp-share-det" class="demo-btn demo-btn-light ico-btn">' + ico("share") + '<span class="ico-label">' + escapeHtml(tLabel("share.link")) + "</span></button>" +
      "</div>" : "") +
      collSection +
      (mpHasUnsaved() ? '<div class="mp-unsaved">' + escapeHtml(t("points.unsaved", { n: mapPoints.length })) +
        ' <button type="button" id="mp-saveas" class="mp-saveas-btn">' + escapeHtml(t("points.saveAsList")) + "</button>" +
        ' <button type="button" id="mp-share-pts" class="mp-saveas-btn">🔗 ' + escapeHtml(t("share.link")) + "</button></div>" : "") +
      (chipsHtml ? '<div class="mp-chips">' + chipsHtml + "</div>" : "") +
      (unionPts.length > 1 ?
        '<div class="mp-sort"><span class="mp-sort-lbl">⇅</span>' +
          '<button type="button" class="mp-sort-btn' + (mpSort === "dist" ? " active" : "") + '" data-sort="dist">' + escapeHtml(t("points.byDist")) + "</button>" +
          '<button type="button" class="mp-sort-btn' + (mpSort === "name" ? " active" : "") + '" data-sort="name">' + escapeHtml(t("points.byName")) + "</button>" +
        "</div>" : "") +
      '<div class="mp-list">' + listHtml + "</div>";
    // Wire interactions
    var shareMapBtn = panel.querySelector("#mp-share-map");
    if (shareMapBtn) shareMapBtn.addEventListener("click", function (e) { e.stopPropagation(); shareMap(); });
    var importShareBtn = panel.querySelector("#mp-import-share"), shareFileInput = panel.querySelector("#share-file-input");
    if (importShareBtn && shareFileInput) {
      importShareBtn.addEventListener("click", function (e) { e.stopPropagation(); shareFileInput.click(); });
      shareFileInput.addEventListener("change", function (e) {
        var f = e.target.files && e.target.files[0]; if (!f) return;
        var rd = new FileReader();
        rd.onload = function () { importShared(String(rd.result || "").trim()); };
        rd.onerror = function () { setStatus(t("share.badLink")); };
        rd.readAsText(f); e.target.value = "";
      });
    }
    var sharePtsBtn = panel.querySelector("#mp-share-pts");
    if (sharePtsBtn) sharePtsBtn.addEventListener("click", function (e) { e.stopPropagation(); shareWorkingPoints(); });
    var saveAsBtn = panel.querySelector("#mp-saveas");
    if (saveAsBtn) saveAsBtn.addEventListener("click", function () {
      modalPrompt(t("points.saveAsPrompt"), "").then(function (n) {
        n = (n || "").trim(); if (!n) return;
        var c = mpCollections.filter(function (x) { return x.name === n; })[0];
        if (!c) { c = { name: n, points: [] }; mpCollections.push(c); }
        mapPoints.forEach(function (p) { c.points.push(Object.assign({}, p)); });   // file all loose pins into the list
        mapPoints = []; mpActiveName = ""; shownColls[n] = true;
        saveMapPoints(); saveShownState(); renderMapPoints(); refreshMpPanel();
      });
    });
    panel.querySelectorAll(".mp-sort-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        mpSort = this.getAttribute("data-sort") === "name" ? "name" : "dist";
        window.GeoState.save({ mapPointsSort: mpSort });
        refreshMpPanel();
      });
    });
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
        var lat = parseFloat(this.getAttribute("data-lat")), lon = parseFloat(this.getAttribute("data-lon"));
        if (map && isFinite(lat) && isFinite(lon)) map.setView([lat, lon], Math.max(map.getZoom() || 0, 11));
        // Loose working pins are editable (open the editor); ticked-list pins are
        // read-only overlays — just fly there.
        var id = this.getAttribute("data-id");
        if (id) { var p = mapPoints.filter(function (x) { return x.id === id; })[0]; if (p) openPointEditor(p); }
      });
    });
    panel.querySelectorAll(".mp-del").forEach(function (b) {
      b.addEventListener("click", function () { deleteMapPoint(this.getAttribute("data-id")); });
    });
    // "Clear" unticks every shown list/set (hides the overlays). The loose
    // working pins are left untouched (delete those individually with their ×).
    // Tick a saved list / detection set to show it as an overlay (several together).
    panel.querySelectorAll(".mp-coll-cb").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var type = this.getAttribute("data-type"), name = this.getAttribute("data-name");
        var set = type === "d" ? shownDetSets : shownColls;
        if (this.checked) set[name] = true; else delete set[name];
        saveShownState();
        renderMapPoints();
      });
    });
    // Per-row 🧭: export this list's / set's points as a pin overlay for Google
    // My Maps (no route — routes are a per-observation action).
    panel.querySelectorAll(".mp-coll-nav").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var type = this.getAttribute("data-type"), name = this.getAttribute("data-name"), pts = [];
        if (type === "d") {
          var set = detSets().filter(function (s) { return s.name === name; })[0] || {};
          Object.keys(set.detections || {}).forEach(function (k) {
            var en = set.detections[k] || {};
            (en.rows || []).forEach(function (r) { pts.push({ lat: r.lat, lon: r.lon, name: en.name || k, desc: r.date || "", color: en.color, star: isInteresting(k), rare: detIsRare(k) }); });
          });
        } else {
          var c = mpCollections.filter(function (x) { return x.name === name; })[0] || {};
          var col = mpHashColor(name);
          pts = (c.points || []).map(function (p) { return { lat: p.lat, lon: p.lon, name: p.name || "", desc: (p.note || ""), color: p.spColor || col, star: !!p.star, rare: !!p.rare }; });
        }
        sendPointsToGoogle(name, pts);   // whole list → pin overlay
      });
    });
    // Per-row 🔗: share this list / detection set as a self-contained URL (no keys needed).
    panel.querySelectorAll(".mp-coll-share").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var type = this.getAttribute("data-type"), name = this.getAttribute("data-name");
        if (type === "d") shareDetSet(name); else sharePointList(name);
      });
    });
    // Per-row ✎ opens the whole-list editor (colour + tags + rename).
    panel.querySelectorAll(".mp-coll-edit").forEach(function (b) {
      b.addEventListener("click", function (e) { e.preventDefault(); openCollEditModal(this.getAttribute("data-name")); });
    });
    // Per-row × deletes that saved list / detection set (after confirming).
    panel.querySelectorAll(".mp-coll-del").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var type = this.getAttribute("data-type"), name = this.getAttribute("data-name");
        if (type === "p" && isCollProtected(name)) { setStatus(t("lists.protectedMsg", { name: name })); return; }
        modalConfirm(t(type === "d" ? "dset.deletePrompt" : "points.deleteCollPrompt", { name: name })).then(function (ok) {
          if (!ok) return;
          if (type === "d") { delete shownDetSets[name]; deleteDetSet(name); }
          else { delete shownColls[name]; deleteCollection(name); }
          saveShownState(); renderMapPoints();
        });
      });
    });
    // "Save" captures the current work into a named list/set shown via its tick:
    //   - loose working pins        → a point-list
    //   - otherwise plotted species → a detection set
    // If exactly one matching list/set is already ticked ("selected"), the
    // dialog is pre-filled with its name (save straight into it); otherwise it
    // asks for a new name. The single name dialog is shown either way.
    // "Save detections" → all observations plotted on the map saved as a
    // point-list (new or appended to an existing one). Distinct from the "Save"
    // button below, which stores plotted species as a detection SET.
    var saveDet = panel.querySelector("#mp-save-det");
    if (saveDet) saveDet.addEventListener("click", function (e) {
      e.stopPropagation();
      var rows = collectVisibleDetections(null);   // every visible plotted observation
      if (!rows.length) { setStatus(t("points.empty")); return; }
      var r = this.getBoundingClientRect();
      panel.style.display = "none";   // close the points dropdown so the chooser isn't clipped
      showDetSaveMenu(r.left, r.bottom + 4, rows);
    });
    var shareDet = panel.querySelector("#mp-share-det");
    if (shareDet) shareDet.addEventListener("click", function (e) { e.stopPropagation(); shareCurrentDetections(); });
  }

  // ---- Sticky fan-out for overlapping detection markers ---------------------
  // Clicking a detection dot that sits over others (same/near coordinates)
  // fans the cluster out around the point on a circle. It STAYS open so each
  // clone can be hovered (tooltip) and clicked (→ its observation source).
  // Dismisses on map-background click, pan, zoom, or Escape.
  var spiderLayer = null, spiderHidden = [];
  function clearSpider() {
    if (!spiderLayer) return;
    spiderHidden.forEach(function (m) {
      try { m.setStyle({ opacity: (m._preFanOp != null ? m._preFanOp : 0.9), fillOpacity: (m._preFanFill != null ? m._preFanFill : 0.9) }); } catch (e) {}
      delete m._preFanOp; delete m._preFanFill;
    });
    spiderHidden = [];
    map.removeLayer(spiderLayer); spiderLayer = null;
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
    // Historic observations: a GBIF date-range search instead of the model — show
    // its From/To range and hide the model-week selector.
    var isHist = currentMode === "historic";
    var hr = document.getElementById("histrange-wrap"); if (hr) hr.style.display = isHist ? "" : "none";
    if (isHist) buildHistMonths();   // (re)build the localized month toggles when entering Historic
    // Week applies in every mode (incl. Migration timeline, where it sets the
    // "current week" used by the Probability / Arrivals / Scatter tabs) — but not
    // in the date-range Historic mode.
    document.getElementById("week-select-wrap").style.display = isHist ? "none" : "";
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
      updatePerfMeta();
    }).catch(function () { /* offline — leave blank */ });
  }
  // The running code version (from the active service worker) + last-change time,
  // shown together in the startup popup.
  var appVersion = "";
  function requestAppVersion() {
    try {
      if (!navigator.serviceWorker) return;
      navigator.serviceWorker.addEventListener("message", function (e) {
        if (e.data && e.data.type === "version") { appVersion = e.data.version || ""; updatePerfMeta(); }
      });
      var ask = function (w) { if (w) try { w.postMessage({ type: "getVersion" }); } catch (e) {} };
      if (navigator.serviceWorker.controller) ask(navigator.serviceWorker.controller);
      else navigator.serviceWorker.ready.then(function (reg) { ask(reg.active); }).catch(function () {});
    } catch (e) {}
  }
  function updatePerfMeta() {
    var el = document.getElementById("perf-version"); if (!el) return;
    var parts = [];
    if (appVersion) parts.push(appVersion);
    if (lastChangeText) parts.push(lastChangeText);
    el.textContent = parts.join(" · ");
    el.style.display = parts.length ? "" : "none";
  }

  // One-time performance note shown over the page on load.
  function showPerfModal() {
    var m = document.getElementById("perf-modal");
    if (m) m.style.display = "flex";
    updatePerfMeta();
  }
  function hidePerfModal() {
    var m = document.getElementById("perf-modal");
    if (m) m.style.display = "none";
  }

  // ---- PWA install (exposed only from the info screen + Settings) -----------
  // No floating pill or splash button (those proved flaky). We silently stash
  // the browser's install prompt; a tap on either button runs it, or shows
  // platform-specific manual steps when there's no prompt API (iOS, Firefox …).
  var deferredInstall = null;
  function installIsStandalone() {
    try { return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true; } catch (e) { return false; }
  }
  function installIsIOS() {
    var ua = navigator.userAgent || "";
    return /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function installIsIOSSafari() {
    return installIsIOS() && /safari/i.test(navigator.userAgent || "") && !/crios|fxios|edgios/i.test(navigator.userAgent || "");
  }
  // Show/hide the two install buttons by install state (hidden once installed).
  function refreshInstallUI() {
    var installed = installIsStandalone();
    var info = document.getElementById("install-info");
    if (info) info.hidden = installed;
    var wrap = document.getElementById("install-wrap");
    if (wrap) wrap.hidden = installed;
  }
  function initInstall() {
    window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferredInstall = e; refreshInstallUI(); });
    window.addEventListener("appinstalled", function () { deferredInstall = null; refreshInstallUI(); });
    refreshInstallUI();
  }
  // Tapped an install button: native prompt if the browser offered one, else
  // the right manual steps for this platform, shown in the adjacent hint line.
  function doInstall(btn) {
    var steps = btn && btn.parentNode && btn.parentNode.querySelector(".install-steps");
    if (deferredInstall) {
      deferredInstall.prompt();
      deferredInstall.userChoice.then(function () { deferredInstall = null; refreshInstallUI(); });
      return;
    }
    var msg = installIsIOS() ? (installIsIOSSafari() ? t("install.ios") : t("install.iosOther")) : t("install.manual");
    if (steps) { steps.textContent = msg; steps.hidden = false; }
  }

  // ---- Feedback (EmailJS) ---------------------------------------------------
  // The feedback form sends a message to the project address via EmailJS, so the
  // address is never exposed in the app. The recipient is set in the EmailJS
  // template; only these public IDs live here (the public key is meant to be
  // public). Fill them in from the EmailJS dashboard to enable sending.
  var EMAILJS_PUBLIC_KEY = "-5S2PctOrxEViV5Pf";
  var EMAILJS_SERVICE_ID = "service_1wr4am1";
  var EMAILJS_TEMPLATE_ID = "template_2qq926a";
  function openFeedback() {
    closeDropdowns();
    var st = document.getElementById("feedback-status"); if (st) st.textContent = "";
    document.getElementById("feedback-modal").style.display = "flex";
    navOpen("feedback", hideFeedback);
    var ta = document.getElementById("feedback-msg"); if (ta) ta.focus();
  }
  function hideFeedback() { document.getElementById("feedback-modal").style.display = "none"; }
  function sendFeedback() {
    var msg = (document.getElementById("feedback-msg").value || "").trim();
    var email = (document.getElementById("feedback-email").value || "").trim();
    var st = document.getElementById("feedback-status");
    if (!msg) { st.textContent = t("feedback.empty"); return; }
    if (!window.emailjs || !EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) {
      st.textContent = t("feedback.unavailable"); return;
    }
    var btn = document.getElementById("feedback-send"); btn.disabled = true;
    st.textContent = t("feedback.sending");
    window.emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID,
      { message: msg, reply_to: email, from_name: email || "anonymous" },
      { publicKey: EMAILJS_PUBLIC_KEY })
      .then(function () {
        st.textContent = t("feedback.sent");
        document.getElementById("feedback-msg").value = "";
        setTimeout(function () { navClose("feedback"); }, 1200);
      })
      .catch(function () { st.textContent = t("feedback.sendFail"); })
      .then(function () { btn.disabled = false; });
  }

  // In Species List mode the CSV button sits next to the "＋ Checklist" button;
  // in every other mode it lives directly below the map.
  function relocateCsvButton() {
    var wrap = document.getElementById("csv-btn-wrap");
    if (!wrap) return;
    if (currentMode === "list") {
      var sa = document.querySelector("#species-panel .sp-actions-dl") ||
               document.querySelector("#species-panel .sp-actions");
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
      if (crossState === 1) setCrosshairState(0);   // stop GPS follow so it doesn't keep recentring the new mode's view
      nearbyFollowSuspended = false;   // a mode change ends any Close-by "viewing" state; don't auto-resume follow later
      closeNearby(false);   // don't leave the "birds close by" page over a different mode
      navClose("page");   // drop the page's Back-history entry (it was just closed)
      hideCsvBtn();
      hideFetchArea();   // drop the live pointer box unless we're (still) in list/historic
      hideHistArea();    // drop the historic placed point + Fetch state
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
    // National-databases popup (opens like the GBIF datasets list).
    var natdbOpenBtn = document.getElementById("natdb-open");
    if (natdbOpenBtn) {
      natdbOpenBtn.addEventListener("click", function () {
        closeDropdowns();
        renderCustomUrls();
        document.getElementById("natdb-modal").style.display = "flex";
        navOpen("natdb", function () { document.getElementById("natdb-modal").style.display = "none"; });
      });
      document.getElementById("natdb-close").addEventListener("click", function () { navClose("natdb"); });
      document.getElementById("natdb-modal").addEventListener("click", function (e) { if (e.target === this) navClose("natdb"); });
    }

    var offlineOpenBtn = document.getElementById("offline-open");
    if (offlineOpenBtn) {
      offlineOpenBtn.addEventListener("click", openOfflineManager);
      document.getElementById("offline-close").addEventListener("click", function () { navClose("offline"); });
      document.getElementById("offline-modal").addEventListener("click", function (e) { if (e.target === this) navClose("offline"); });
      // Minimize: collapse the panel to a small bar at the bottom; the map keeps
      // showing the coloured areas + their "×" delete handles (editing stays on).
      document.getElementById("offline-min").addEventListener("click", function () {
        var min = document.getElementById("offline-box").classList.toggle("min");
        this.textContent = min ? "▴" : "–";
        this.title = t(min ? "offline.expand" : "offline.minimize");
        this.setAttribute("aria-label", this.title);
      });
    }

    var blogsCloseBtn = document.getElementById("blogs-close");
    if (blogsCloseBtn) {
      blogsCloseBtn.addEventListener("click", function () { navClose("blogs"); });
      document.getElementById("blogs-modal").addEventListener("click", function (e) { if (e.target === this) navClose("blogs"); });
      document.getElementById("blogs-add").addEventListener("click", addBlog);
    }

    var sourcesOpenBtn = document.getElementById("sources-open");
    if (sourcesOpenBtn) {
      sourcesOpenBtn.addEventListener("click", function () {
        closeDropdowns();
        srcDetailId = null;   // always open on the source LIST
        renderSourcesTable();
        document.getElementById("sources-modal").style.display = "flex";
        navOpen("sources", function () { document.getElementById("sources-modal").style.display = "none"; });
      });
      document.getElementById("sources-close").addEventListener("click", function () { navClose("sources"); });
      document.getElementById("sources-modal").addEventListener("click", function (e) { if (e.target === this) navClose("sources"); });
      document.getElementById("sources-reset").addEventListener("click", resetSources);
    }

    var blockedOpenBtn = document.getElementById("blocked-open");
    if (blockedOpenBtn) {
      blockedOpenBtn.addEventListener("click", function () {
        closeDropdowns();
        renderBlockedList();
        document.getElementById("blocked-modal").style.display = "flex";
        navOpen("blocked", function () { document.getElementById("blocked-modal").style.display = "none"; });
      });
      document.getElementById("blocked-close").addEventListener("click", function () { navClose("blocked"); });
      document.getElementById("blocked-modal").addEventListener("click", function (e) { if (e.target === this) navClose("blocked"); });
    }

    var listsOpenBtn = document.getElementById("lists-open");
    if (listsOpenBtn) {
      var leTog = document.getElementById("list-edges-toggle");
      listsOpenBtn.addEventListener("click", function () {
        closeDropdowns();
        if (leTog) leTog.checked = listEdgesOn();   // reflect current state when opening
        renderListsModal();
        document.getElementById("lists-modal").style.display = "flex";
        navOpen("lists", function () { document.getElementById("lists-modal").style.display = "none"; });
      });
      // Toggle the year/life-list yellow edge on map markers (off when many dots
      // make it distracting).
      if (leTog) leTog.addEventListener("change", function () {
        window.GeoState.save({ listEdges: this.checked });
        rebuildDetLayers(); updateDetLegend();
      });
      document.getElementById("lists-close").addEventListener("click", function () { navClose("lists"); });
      document.getElementById("lists-modal").addEventListener("click", function (e) { if (e.target === this) navClose("lists"); });
    }

    // The H3 range cache shares the unified "Map cache" budget (small slice).
    h3CacheMB = h3BudgetMB();
    loadH3Cache();

    var hsMinEl = document.getElementById("hotspot-min");
    hsMinEl.value = String(+window.GeoState.get("hotspotMin", 200) || 0);
    hsMinEl.addEventListener("change", function () {
      window.GeoState.save({ hotspotMin: +this.value || 0 });
      if (hotspotsLayer && hotspotsLayer._reload) hotspotsLayer._reload();   // re-filter if shown
    });

    // Numeric Settings inputs: seed from a getter, then on change clamp to an
    // integer in [min,max], write it back into the field, persist via save(v),
    // and run an optional after() (re-render). One implementation for all of them.
    function wireNumSetting(id, get, min, max, dflt, save, after) {
      var el = document.getElementById(id); if (!el) return;
      el.value = String(get());
      el.addEventListener("change", function () {
        var v = Math.max(min, Math.min(max, Math.round(+this.value || dflt)));
        this.value = String(v);
        save(v);
        if (after) after();
      });
    }
    function relayerDet() { rebuildDetLayers(); updateDetLegend(); }
    wireNumSetting("rare-pct", rarePct, 1, 100, 5, function (v) { window.GeoState.save({ rarePct: v }); }, relayerDet);
    wireNumSetting("max-points", detMaxPoints, 50, 100000, 5000, function (v) { window.GeoState.save({ maxMapPoints: v }); }, relayerDet);
    wireNumSetting("nearby-count", nearbyCount, 1, 500, 25, function (v) { window.GeoState.save({ nearbyCount: v }); }, function () { if (nearbyIsOpen()) renderNearby(); });
    var nearbyPtsEl = document.getElementById("nearby-points-toggle");
    if (nearbyPtsEl) {
      nearbyPtsEl.checked = nearbyInclPoints();
      nearbyPtsEl.addEventListener("change", function () {
        window.GeoState.save({ nearbyInclPoints: this.checked });
        if (nearbyIsOpen()) renderNearby();
      });
    }
    var dedupEl = document.getElementById("dedup-toggle");
    if (dedupEl) {
      dedupEl.checked = dedupDetections();
      dedupEl.addEventListener("change", function () {
        window.GeoState.save({ dedupDetections: this.checked });
        rebuildDetLayers(); updateDetLegend();   // ensureDedup() re-runs (setting is in its signature)
        if (document.getElementById("detlist-modal") && document.getElementById("detlist-modal").style.display === "flex" && typeof renderDetListModal === "function") renderDetListModal();
      });
    }

    wireNumSetting("fetch-timeout", fetchTimeoutSec, 0, 600, 0, setFetchTimeoutSec, null);
    wireNumSetting("sight-ttl", sightTtlMin, 0, 10080, 0, function (v) { window.GeoState.save({ sightTtlMin: v }); }, null);

    // Historic-observations date range (defaults: last 5 years), persisted.
    var hfEl = document.getElementById("hist-from"), htEl = document.getElementById("hist-to");
    if (hfEl && htEl) {
      var todayStr = new Date().toISOString().slice(0, 10);
      var fiveYrAgo = new Date(); fiveYrAgo.setFullYear(fiveYrAgo.getFullYear() - 5);
      hfEl.value = window.GeoState.get("histFrom", "") || fiveYrAgo.toISOString().slice(0, 10);
      htEl.value = window.GeoState.get("histTo", "") || todayStr;
      hfEl.max = todayStr; htEl.max = todayStr;
      hfEl.addEventListener("change", function () { window.GeoState.save({ histFrom: this.value }); });
      htEl.addEventListener("change", function () { window.GeoState.save({ histTo: this.value }); });
    }

    var crEl = document.getElementById("country-res");   // removed from the UI; guard in case it's absent
    if (crEl) {
      crEl.value = String(+window.GeoState.get("countryRes", 3) || 3);
      crEl.addEventListener("change", function () { window.GeoState.save({ countryRes: +this.value || 4 }); });
    }

    var mcEl = document.getElementById("map-cache");
    if (mcEl) {
      mcEl.value = String(mapCacheMB());
      mcEl.addEventListener("change", function () {
        window.GeoState.save({ mapCacheMB: +this.value || 0 });
        h3CacheMB = h3BudgetMB();   // re-split the shared budget…
        sendTileCap();              // …tiles get the rest (service worker re-trims)
        saveH3Cache();              // re-fit the range cache to its new slice (or clear at Off)
      });
    }
    // Push the tile-cache cap to the SW once it's controlling (and whenever it changes).
    if (navigator.serviceWorker) {
      try { navigator.serviceWorker.ready.then(sendTileCap).catch(function () {}); navigator.serviceWorker.addEventListener("controllerchange", sendTileCap); } catch (e) {}
    }

    var rrEl = document.getElementById("recent-radius");
    var rrVal = document.getElementById("recent-radius-val");
    rrEl.value = String(radiusStepIndex(+window.GeoState.get("recentRadiusKm", 25) || 25));
    if (rrVal) rrVal.textContent = radiusLabel(RADIUS_STEPS[+rrEl.value]);
    rrEl.addEventListener("input", function () { if (rrVal) rrVal.textContent = radiusLabel(RADIUS_STEPS[+this.value]); });
    rrEl.addEventListener("change", function () { window.GeoState.save({ recentRadiusKm: RADIUS_STEPS[+this.value] || 25 }); allSightingsCache = {}; });

    var histFetchBtn = document.getElementById("hist-fetch");
    if (histFetchBtn) histFetchBtn.addEventListener("click", function () {
      if (histPoint) renderHistoricObs(histPoint.lat, histPoint.lon);
      else setStatus(t("status.hintHistoric"));
    });

    var gbifOpen = document.getElementById("gbif-ds-open");
    if (gbifOpen) {
      gbifOpen.addEventListener("click", function () {
        closeDropdowns();
        renderGbifTable();
        document.getElementById("gbif-modal").style.display = "flex";
        navOpen("gbif", function () { document.getElementById("gbif-modal").style.display = "none"; });
      });
      document.getElementById("gbif-close").addEventListener("click", function () { navClose("gbif"); });
      document.getElementById("gbif-modal").addEventListener("click", function (e) { if (e.target === this) navClose("gbif"); });
      var gbifAddInp = document.getElementById("gbif-add");
      var gbifAddCc = document.getElementById("gbif-add-cc");
      var gbifAddUrl = document.getElementById("gbif-add-url");
      var gbifAdd = function () {
        if (addGbifDataset(gbifAddInp.value, gbifAddCc.value, gbifAddUrl.value)) { gbifAddInp.value = ""; gbifAddCc.value = ""; gbifAddUrl.value = ""; }
      };
      document.getElementById("gbif-add-btn").addEventListener("click", gbifAdd);
      [gbifAddInp, gbifAddCc, gbifAddUrl].forEach(function (el) { el.addEventListener("keydown", function (e) { if (e.key === "Enter") gbifAdd(); }); });
    }

    // Consolidated detections list (opened from a plotted dot or the legend's
    // list button). Close button, backdrop click, and the date/species sort toggle.
    document.getElementById("detlist-close").addEventListener("click", function () { navClose("detlist"); });
    document.getElementById("detlist-modal").addEventListener("click", function (e) { if (e.target === this) navClose("detlist"); });
    var sortToggle = document.getElementById("detlist-sort");
    if (sortToggle) sortToggle.addEventListener("click", function () { detListSort = detListSort === "species" ? "time" : "species"; renderDetListModal(); });
    var detlistSearch = document.getElementById("detlist-search");
    if (detlistSearch) detlistSearch.addEventListener("input", function () { detListQuery = this.value; renderDetListModal(); });
    var detlistSave = document.getElementById("detlist-save");
    if (detlistSave) detlistSave.addEventListener("click", function (e) {
      e.stopPropagation();
      var r = this.getBoundingClientRect();
      showDetSaveMenu(r.left, r.bottom + 4, detListLastRows);
    });
    var detlistNav = document.getElementById("detlist-nav");
    if (detlistNav) detlistNav.addEventListener("click", function (e) {
      e.stopPropagation();
      // Navigate to the detection location(s) in Google Maps (directions), NOT the
      // My-Maps KML import — a clicked spot's co-located dots collapse to one stop.
      navigatePoints((detListLastRows || []).map(function (d) { return { lat: d.lat, lon: d.lon }; }));
    });
    var detlistCoords = document.getElementById("detlist-coords");
    if (detlistCoords) detlistCoords.addEventListener("click", function (e) {
      e.stopPropagation();
      // Copy the clicked spot's coordinates (the dot the list was opened from), else
      // the single row's / first row's location.
      var pt = detListNear || (detListLastRows && detListLastRows[0]);
      if (pt) copyCoords(pt.lat, pt.lon != null ? pt.lon : pt.lng);
    });

    document.getElementById("sync-export").addEventListener("click", exportAppData);
    // One Export button + a KML/KMZ format toggle (the label is the current format).
    var fmtTog = document.getElementById("points-fmt-toggle");
    function pointsFmt() { return window.GeoState.get("pointsExportFmt", "kml") === "kmz" ? "kmz" : "kml"; }
    if (fmtTog) {
      fmtTog.textContent = pointsFmt().toUpperCase();
      fmtTog.addEventListener("click", function () {
        var next = pointsFmt() === "kml" ? "kmz" : "kml";
        window.GeoState.save({ pointsExportFmt: next });
        fmtTog.textContent = next.toUpperCase();
      });
    }
    document.getElementById("points-export").addEventListener("click", function () {
      if (pointsFmt() === "kmz") exportPointsKmz(); else exportPointsKml();
    });
    var kmlFile = document.getElementById("points-kml-file");
    document.getElementById("points-kml-import").addEventListener("click", function () { kmlFile.click(); });
    kmlFile.addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) { return; }
      var rd = new FileReader();
      rd.onload = function () {
        var buf = rd.result;
        var h = new Uint8Array(buf, 0, Math.min(4, buf.byteLength || 0));
        var isZip = h.length >= 4 && h[0] === 0x50 && h[1] === 0x4B && h[2] === 0x03 && h[3] === 0x04;   // "PK\x03\x04" → KMZ
        var done = function (kml) { try { startKmlImport(kml); } catch (err) { setStatus(t("kml.parseErr")); } };
        if (isZip) extractKmlFromKmz(buf).then(done).catch(function () { setStatus(t("kml.parseErr")); });
        else done(new TextDecoder().decode(new Uint8Array(buf)));
        e.target.value = "";
      };
      rd.readAsArrayBuffer(f);   // read binary; branch on the ZIP magic for KMZ vs KML text
    });
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
        // One-shot: a single "Synchronize" button signs in, syncs, then
        // disconnects — so it's the only control (Connect/Disconnect hidden).
        var needId = !st.hasClientId;
        gdClientId.style.display = needId ? "" : "none";
        gdConnect.style.display = "none";
        gdSync.style.display = needId ? "none" : "";
        gdDisconnect.style.display = "none";
        gdSync.disabled = !!st.busy;
        var msg = "";
        var failed = st.status === "reconnect" || st.status === "error";
        if (st.status === "syncing") msg = "⟳ " + t("gdrive.syncing");
        else if (st.status === "reconnect") msg = "⚠ " + t("gdrive.reconnect");
        else if (st.status === "error") msg = "⚠ " + t("gdrive.error");
        else if (st.lastSyncAt) msg = "✓ " + t("gdrive.synced") + " · " + fmtClock(st.lastSyncAt);
        // Surface the actual failure reason so a sync error isn't silent.
        if (failed && st.error) msg += " · " + st.error;
        gdStatus.textContent = msg;
        gdStatus.title = failed && st.error ? st.error : "";
        gdStatus.classList.toggle("gd-syncing", st.status === "syncing");
        gdStatus.classList.toggle("gd-error", failed);
      };
      window.GDriveSync.onStatus(renderGd);

      gdConnect.addEventListener("click", function () { window.GDriveSync.connect().catch(function () {}); });
      gdSync.addEventListener("click", function () { gdStatus.textContent = "⟳ " + t("gdrive.syncing"); gdStatus.classList.add("gd-syncing"); window.GDriveSync.syncNow(); });
      gdDisconnect.addEventListener("click", function () { window.GDriveSync.disconnect(); });
      var saveClientId = function () { window.GDriveSync.setClientId(gdClientId.value); };
      gdClientId.addEventListener("change", saveClientId);
    }

    document.getElementById("maptype-select").addEventListener("change", function () {
      setBasemap(this.value);
    });
    var mapLabelsSel = document.getElementById("maplabels-select");
    if (mapLabelsSel) {
      mapLabelsSel.value = labelsMode();
      mapLabelsSel.addEventListener("change", function () { window.GeoState.save({ mapLabels: this.value }); applyLabelsOverlay(); });
    }

    document.getElementById("perf-modal-ok").addEventListener("click", hidePerfModal);
    document.getElementById("perf-modal").addEventListener("click", function (e) {
      if (e.target === this) hidePerfModal();   // click outside the box
    });
    // Install buttons (info screen + Settings) → native prompt or manual steps.
    var installInfoBtn = document.getElementById("install-info");
    if (installInfoBtn) installInfoBtn.addEventListener("click", function () { doInstall(this); });
    var installSettingsBtn = document.getElementById("install-settings");
    if (installSettingsBtn) installSettingsBtn.addEventListener("click", function () { doInstall(this); });
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
      // Re-filter the plotted detections (legend + map dots) to the new group.
      rebuildDetLayers();
      updateDetLegend();
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
    fieldList.addEventListener("change", function (e) {
      var el = e.target;
      if (el.classList && el.classList.contains("fc-img-file")) {
        // Copy files to an array BEFORE clearing el.value — el.files is a live list,
        // so el.value="" would empty it before we use it.
        var key = el.getAttribute("data-key"), files = Array.prototype.slice.call(el.files || []); el.value = "";
        if (files.length) fcAddPhotoToSpecies(key, files);
        return;
      }
      fieldRowUpdate(el);
    });
    // ＋ commits the compose draft; the # opens the count picker; tapping the
    // recent-entries area opens the edit page; tapping empty card reveals note.
    fieldList.addEventListener("click", function (e) {
      if (!e.target.closest) return;
      if (e.target.closest(".fc-img-add")) return;   // the 📷 label opens the file picker natively
      var add = e.target.closest(".fc-add");
      if (add) {
        var addKey = add.getAttribute("data-key"), dr = cd(addKey);
        if (dr.count == null || dr.count === "") dr.count = 1;   // ＋ logs one bird by default
        fcCommitCompose(addKey); renderFieldList(); return;
      }
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
      else if (el.classList.contains("ent-img-file")) {
        var files = Array.prototype.slice.call(el.files || []); el.value = "";   // copy before clearing (el.files is live)
        if (files.length) { fcAddEntryImages(id, files).then(function () { renderEntryEdit(); }); }
      }
    });
    entryList.addEventListener("click", function (e) {
      var imgDel = e.target.closest && e.target.closest(".ent-img-del");
      if (imgDel) { fcRemoveEntryImage(imgDel.getAttribute("data-id"), imgDel.getAttribute("data-img")); renderEntryEdit(); return; }
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
        if (willOpen) { closeContextMenus(); closeMapPopups(); }   // a new popover → close lingering menus/popups
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
    // Refresh the storage readout each time Settings opens (figures change as you cache).
    document.getElementById("settings-toggle").addEventListener("click", function () {
      if (document.getElementById("settings-panel").style.display !== "none") renderStorageUsage();
    });

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

    // Feedback form (EmailJS). The ".feedback-open" triggers live in the perf
    // modal and the (dynamically rendered) About body, so listen via delegation.
    document.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest(".feedback-open")) { e.preventDefault(); openFeedback(); }
    });
    document.getElementById("feedback-close").addEventListener("click", function () { navClose("feedback"); });
    document.getElementById("feedback-cancel").addEventListener("click", function () { navClose("feedback"); });
    document.getElementById("feedback-send").addEventListener("click", sendFeedback);
    document.getElementById("feedback-modal").addEventListener("click", function (e) {
      if (e.target === this) navClose("feedback");
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
      if (!currentSpView || (currentSpView.mode !== "point" && currentSpView.mode !== "historic")) return;
      var range = currentSpView.mode === "historic" ? currentSpView.range : null;   // historic → records over that range
      if (btn.classList.contains("det-count-extra")) {
        showRecent(btn.getAttribute("data-name") || btn.getAttribute("data-sci"), btn.getAttribute("data-sci"), currentSpView.lat, currentSpView.lon, "", range);
        return;
      }
      var key = btn.getAttribute("data-key"), lbl = labelsByKey[key];
      if (!lbl) return;
      showRecent(speciesName(lbl), lbl.sci, currentSpView.lat, currentSpView.lon, key, range);
    });

    // Click Scientific name / # column headers to sort the per-point species
    // list by that column (toggling asc → desc → off, where off returns to the
    // natural Probability-descending ranking).
    document.getElementById("sp-sci-head").addEventListener("click", function () { cycleSpeciesListSort("sci"); });
    document.getElementById("sp-prob-head").addEventListener("click", function () { cycleSpeciesListSort("prob"); });
    document.getElementById("sp-delta-head").addEventListener("click", function () { cycleSpeciesListSort("cmp"); });
    // Click the combined "n(d)" column header to cycle a filter:
    // off → >0 (any observation) → 1d → 3d → 1w → 2w → 3w → 4w → off. Applies live against the
    // cached sightings aggregation (no re-fetch). Filtering is the only
    // interaction on this column now — count-sort was retired with the
    // separate # column.
    document.getElementById("sp-nd-head").addEventListener("click", function () {
      if (!currentSpView || (currentSpView.mode !== "point" && currentSpView.mode !== "historic")) return;
      var seq = [0, -1, 1, 3, 7, 14, 21, 28];   // off → >0 → ≤1d → … → ≤4w → off
      speciesAgeFilterDays = seq[(seq.indexOf(speciesAgeFilterDays) + 1) % seq.length];
      this.textContent = ageHeadLabel();
      applyAgeFilter();
    });

    // Click the "Species" column header to cycle the list through five states:
    // default (natural prob order) → only ★ starred → only 🚫 blocked →
    // alphabetic A→Z → alphabetic Z→A → default. Combines the species filter
    // (starred/blocked) and the alphabetic sort in one control.
    // Clicking the "Species" header cycles filter/sort modes:
    //  0 all · 1 ★ starred · 2 🟡 not on this year's list · 3 🟠 not on life list
    //  · 4 🚫 blocked · 5 A→Z · 6 Z→A.
    document.getElementById("sp-species-head").addEventListener("click", function () {
      var nameAsc = speciesListSort.col === "name" && speciesListSort.dir === "asc";
      var nameDesc = speciesListSort.col === "name" && speciesListSort.dir === "desc";
      var state = speciesListFilter === "interesting" ? 1 :
                  speciesListFilter === "yearmiss" ? 2 :
                  speciesListFilter === "lifemiss" ? 3 :
                  speciesListFilter === "hidden" ? 4 :
                  nameAsc ? 5 : nameDesc ? 6 : 0;
      state = (state + 1) % 7;
      speciesListFilter = ""; speciesListSort = { col: "", dir: "" };
      if (state === 1) speciesListFilter = "interesting";
      else if (state === 2) speciesListFilter = "yearmiss";
      else if (state === 3) speciesListFilter = "lifemiss";
      else if (state === 4) speciesListFilter = "hidden";
      else if (state === 5) speciesListSort = { col: "name", dir: "asc" };
      else if (state === 6) speciesListSort = { col: "name", dir: "desc" };
      this.textContent = speciesHeadLabel();
      this.title = t("th.speciesCycle");
      updateSortIndicators();
      refreshCurrentView();
    });
    document.getElementById("sp-species-head").title = t("th.speciesCycle");

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

    // A species name (.sp-link, in any list/table) → the ONE unified species
    // menu (info · this observation · lists & actions) on a single click/tap.
    document.addEventListener("click", function (e) {
      var link = e.target.closest ? e.target.closest(".sp-link") : null;
      if (link) {
        e.preventDefault();
        showDetRowMenu({ key: link.getAttribute("data-key"), name: link.getAttribute("data-name"), sci: link.getAttribute("data-sci") || "" }, e.clientX, e.clientY, function () {});
        return;
      }
      // Close the dropdown popovers when clicking outside a panel/toggle.
      if (!e.target.closest(".dd-panel") && !e.target.closest(".dd-toggle")) closeDropdowns();
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
  // Last 5 place-search texts (most-recent first), shown when the box is empty.
  function getRecentPlaces() { return (window.GeoState.get("placeRecent", []) || []).filter(Boolean); }
  function pushRecentPlace(text) {
    text = (text || "").trim(); if (!text) return;
    var a = getRecentPlaces().filter(function (x) { return x.toLowerCase() !== text.toLowerCase(); });
    a.unshift(text);
    window.GeoState.save({ placeRecent: a.slice(0, 5) });
  }
  function wirePlaceSearch() {
    var inp = document.getElementById("place-search");
    var res = document.getElementById("place-results");
    if (!inp || !res) return;
    var selIdx = -1, timer = null, reqTok = 0;
    function showRecent() {
      var a = getRecentPlaces();
      if (!a.length) { res.style.display = "none"; res.innerHTML = ""; return; }
      res.innerHTML = '<div class="sr-recent-head">' + escapeHtml(t("place.recent")) + "</div>" +
        a.map(function (x) { return '<div class="sr-item sr-recent" data-q="' + escapeHtml(x) + '">🕘 ' + escapeHtml(x) + "</div>"; }).join("");
      res.style.display = "block";
      res.querySelectorAll(".sr-recent").forEach(function (el) {
        el.addEventListener("click", function () { inp.value = this.getAttribute("data-q"); inp.focus(); clearTimeout(timer); run(); });
      });
    }
    var run = function () {
      var q = inp.value.trim();
      if (q.length < 2) { showRecent(); return; }   // empty/short → offer the recent searches
      var b = map.getBounds();
      var vb = [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].map(function (n) { return n.toFixed(6); }).join(",");
      // bounded=0: the viewbox only BIASES ranking toward the current area — matches
      // anywhere are still returned (a place outside the view isn't dropped), so the
      // search is forgiving of loose / partial names and off-screen places.
      var url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=25&addressdetails=0&bounded=0&viewbox=" +
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
    inp.addEventListener("focus", function () { if (inp.value.trim().length < 2) showRecent(); else if (res.innerHTML) res.style.display = "block"; });
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
        var inp = document.getElementById("place-search");
        if (inp) pushRecentPlace(inp.value);   // remember the text that led to a chosen place
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
  // Reject + clear every in-flight inference (worker died, or postMessage threw).
  function failAllPending(reason) {
    var e = new Error(reason || "inference worker failed");
    pendingInferences.forEach(function (p) { try { p.reject(e); } catch (_) {} });
    pendingInferences.clear();
  }

  async function runInference(flatInputs, batchSize, opts) {
    opts = opts || {};
    var id = ++inferenceId;
    return new Promise(function (resolve, reject) {
      // A null/terminated worker (init failed) must reject cleanly, not throw inside
      // the executor where callers' .catch() can't see it.
      if (!worker) { reject(new Error("inference worker unavailable")); return; }
      pendingInferences.set(id, { resolve: resolve, reject: reject });
      var buf = new Float32Array(flatInputs).buffer;
      var msg = { type: "infer", id: id, flatInputs: buf, batchSize: batchSize, task: opts.task || "raw" };
      if (opts.task === "column") msg.speciesIdx = opts.speciesIdx;
      if (opts.task === "richness") { msg.threshold = opts.threshold; if (opts.mask) msg.mask = opts.mask; }
      try {
        worker.postMessage(msg, [buf]);   // mask (if any) is cloned, not transferred
      } catch (e) {
        pendingInferences.delete(id);
        reject(e);
      }
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
  // Repaints are coalesced to one per animation frame: the inference chunk loop and
  // map "moveend" can each fire many paintOverlay()s in quick succession, and each
  // does a full canvas redraw (re-enumerating in-view hexes + re-projecting every
  // vertex). schedulePaint() collapses a burst to the latest frame; a direct
  // paintOverlay() (the guaranteed final paint) cancels any pending frame so callers
  // that read cachedRender.maxProb right after still observe a completed paint.
  var _paintRAF = 0;
  function schedulePaint() {
    if (_paintRAF) return;
    if (typeof requestAnimationFrame === "undefined") { paintOverlay(); return; }
    _paintRAF = requestAnimationFrame(function () { _paintRAF = 0; paintOverlay(); });
  }
  function paintOverlay() {
    if (_paintRAF) { cancelAnimationFrame(_paintRAF); _paintRAF = 0; }
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
      if (h3ResOf(allKeys[i]) !== targetRes) continue;
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
      var sh = h3Shape(cells[i]); if (sh.straddles) continue;   // skip antimeridian-straddling hexes
      var bnd = sh.bnd;
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
  // The in-view cell list depends only on (res, zoom, viewport size, center), and
  // is asked for several times per render (renderRangeMap, then paintRangeH3 on each
  // coalesced repaint, plus the CSV builder). Memoise the last result so those repeat
  // calls reuse it instead of re-sampling the screen (thousands of latLngToCell wasm
  // calls). Callers only read the array, so returning the shared reference is safe.
  var _civKey = "", _civCells = null;
  function h3CellsInView(res) {
    var size0 = map.getSize(), c0 = map.getCenter();
    var ck = res + ":" + map.getZoom() + ":" + size0.x + "x" + size0.y + ":" + c0.lat.toFixed(5) + "," + c0.lng.toFixed(5);
    if (ck === _civKey && _civCells) return _civCells;
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
    _civKey = ck; _civCells = out;
    return out;
  }

  // Memoise H3 cell geometry: cellToBoundary + the antimeridian-straddle flag are
  // deterministic per cell id (zoom-independent), and getResolution likewise — so
  // cache them instead of calling the H3 wasm per hex on every repaint (paint runs
  // per inference chunk and on every pan/zoom). Capped so a long pan session can't
  // grow them without bound.
  var _h3Shape = Object.create(null), _h3Res = Object.create(null), _h3N = 0;
  function h3Shape(cell) {
    var s = _h3Shape[cell];
    if (s === undefined) {
      if (_h3N > 60000) { _h3Shape = Object.create(null); _h3Res = Object.create(null); _h3N = 0; }   // bound memory
      var bnd = window.h3.cellToBoundary(cell), minLon = 999, maxLon = -999;
      for (var w = 0; w < bnd.length; w++) { var lo = bnd[w][1]; if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo; }
      s = { bnd: bnd, straddles: (maxLon - minLon > 180) };
      _h3Shape[cell] = s; _h3N++;
    }
    return s;
  }
  function h3ResOf(cell) {
    var r = _h3Res[cell];
    if (r === undefined) r = _h3Res[cell] = window.h3.getResolution(cell);
    return r;
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
      // Skip hexes straddling the antimeridian (would smear across the map).
      var sh = h3Shape(cells[i]); if (sh.straddles) continue;
      var bnd = sh.bnd;
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
        if (gen === renderGeneration) { cachedRender = { h3range: true, tag: key + ":" + selectedWeek }; schedulePaint(); }
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
  // weekOverride lets animation playback render a frame WITHOUT touching the
  // week-select control (so the user's chosen week — and the persisted setting —
  // stay put during Play); omitted, it reads the selected week as usual.
  function showCachedWeek(weekOverride) {
    var week = weekOverride != null ? weekOverride : +document.getElementById("week-select").value;
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
          schedulePaint();
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
    setMpDistOrigin(lat, lon);   // point lists now measure/sort from here
    // The deletable dashed outline is remembered only when observations are actually
    // fetched onto the map (in plotSightingsResult) — NOT on a plain click — so a
    // stray tap doesn't leave a persisted, deletable rectangle behind.
    if (currentMode === "barchart") renderAnalysis(lat, lon);
    else if (currentMode === "range") renderSpeciesList(lat, lon);
    else if (currentMode === "historic") placeHistoricPoint(lat, lon);   // place/preview; fetch is an explicit button
    else bindPointPopup(marker, lat, lon);   // list (and any click-driven default)
  }
  function onMapClick(e) {
    // Ignore an accidental brush on the empty map: opening the point popup / placing
    // Debounce every map click: ignore any click that lands within 200 ms of the
    // previous one (rapid double-taps, or a legend re-render leaking through).
    if (Date.now() < mapClickGuardUntil) return;
    mapClickGuardUntil = Date.now() + 200;
    // List + Range show the per-point species list; Migration the analysis;
    // Historic the GBIF date-range search.
    if (["list", "barchart", "range", "historic"].indexOf(currentMode) < 0) return;
    // Don't fire the point-options popup if the user was tapping a plotted
    // detection (or just a few pixels off it).
    if (clickNearDetection(e.latlng)) return;
    // Normalize: latitude clamped to [-90, 90]; longitude wrapped to [-180, 180]
    // (a click on a panned world-copy can otherwise give e.g. lon = 635).
    var lat = Math.max(-90, Math.min(90, e.latlng.lat)), lon = wrapLon(e.latlng.lng);
    // On touch: open the popup after a tiny delay instead of instantly, so a
    // fleeting graze that's really the start of a pan/zoom doesn't pop it up — a
    // movestart/zoomstart (or another tap) in that window cancels it. Mouse = instant.
    clearTimeout(mapClickDelayTimer);
    if (mapPtrIsTouch) mapClickDelayTimer = setTimeout(function () { selectMapPoint(lat, lon); }, 180);
    else selectMapPoint(lat, lon);
  }

  function makePopupBtn(label, cls, fn) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "demo-btn " + (cls || "");
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  // ---- Stored locations (bookmarked map spots) ------------------------------
  // Saved from a map-point popup ("Save location") and recalled by press-and-hold
  // (or right-click) on the Locate-me crosshair. Small data → GeoState/localStorage.
  function getStoredLocations() { return window.GeoState.get("storedLocations", []) || []; }
  function saveStoredLocations(a) { window.GeoState.save({ storedLocations: a }); }
  function addStoredLocation(lat, lon, name, radius, on) {
    var arr = getStoredLocations();
    arr.push({ name: (name || "").trim() || (lat.toFixed(4) + ", " + lon.toFixed(4)), lat: lat, lon: lon,
      radius: (radius > 0) ? radius : recentRadiusKm(), on: on !== false, at: Date.now() });
    saveStoredLocations(arr);
  }
  function removeStoredLocation(i) { var a = getStoredLocations(); if (i >= 0 && i < a.length) { a.splice(i, 1); saveStoredLocations(a); } }
  // From a map point: suggest a place name (reverse-geocode), then save with a
  // name + a fetch radius (defaulting to the "Sightings radius" setting).
  function registerLocationPrompt(lat, lon) {
    function promptSave(suggest) {
      var m = createModal({});
      var box = m.box, close = m.close;
      box.innerHTML = '<div class="ui-modal-msg">' + escapeHtml(t("loc.savePrompt")) + "</div>" +
        '<input type="text" class="ui-modal-input" id="loc-name" value="' + escapeHtml(suggest) + '" />' +
        '<label class="loc-radius-row">' + escapeHtml(t("loc.radius")) +
          ' <input type="number" id="loc-radius" min="1" max="200" step="1" value="' + recentRadiusKm() + '" /> km</label>' +
        '<div class="ui-modal-btns"><button type="button" class="demo-btn demo-btn-light" id="loc-cancel">' + escapeHtml(t("btn.cancel")) + "</button>" +
          '<button type="button" class="demo-btn" id="loc-ok">' + escapeHtml(t("popup.ok")) + "</button></div>";
      box.querySelector("#loc-cancel").addEventListener("click", close);
      box.querySelector("#loc-ok").addEventListener("click", function () {
        var name = (box.querySelector("#loc-name").value || "").trim();
        var r = Math.max(1, Math.min(200, parseInt(box.querySelector("#loc-radius").value, 10) || recentRadiusKm()));
        addStoredLocation(lat, lon, name, r, true);
        close(); setStatus(t("loc.saved"));
      });
      var ni = box.querySelector("#loc-name"); if (ni) { ni.focus(); ni.select(); }
    }
    detailedPlaceName(lat, lon).then(function (nm) { promptSave(nm || ""); }, function () { promptSave(""); });
  }
  // Persist a patch onto a stored location by index.
  function updateStoredLocation(i, patch) {
    var a = getStoredLocations(); if (!a[i]) return;
    for (var k in patch) a[i][k] = patch[k];
    saveStoredLocations(a);
  }
  function hideStoredLocations() { var p = document.getElementById("stored-loc-panel"); if (p) p.style.display = "none"; if (storedLocFramesLayer) storedLocFramesLayer.clearLayers(); }   // drop the selection preview; fetched areas are remembered separately
  // Draw a square (the ± radius box that gets fetched) on the map for every
  // SELECTED stored location, so the user sees which areas are active. Cleared
  // and redrawn as selection / radius changes; empty when nothing is selected.
  var storedLocFramesLayer = null;
  function renderStoredLocFrames() {
    if (!map || !L.rectangle) return;
    if (!storedLocFramesLayer) storedLocFramesLayer = L.layerGroup().addTo(map);
    storedLocFramesLayer.clearLayers();
    getStoredLocations().forEach(function (l) {
      if (l.on === false || !isFinite(l.lat) || !isFinite(l.lon)) return;
      var r = l.radius || recentRadiusKm();
      var dLat = r / 111, dLon = r / ((111 * Math.cos(l.lat * Math.PI / 180)) || 1);
      var rect = L.rectangle([[l.lat - dLat, l.lon - dLon], [l.lat + dLat, l.lon + dLon]],
        { className: "storedloc-frame", color: "#2e8b74", weight: 1, opacity: 0.6, dashArray: "4 4", fill: false, interactive: false });   // thin dashed green outline, no fill
      rect.bindTooltip(escapeHtml(l.name), { direction: "top", className: "area-tip", sticky: true });
      storedLocFramesLayer.addLayer(rect);
    });
  }
  // Pop up the stored-locations list anchored to the crosshair control.
  function showStoredLocations(anchorEl) {
    var wrap = document.getElementById("demo-map-wrap"); if (!wrap || !anchorEl) return;
    var panel = document.getElementById("stored-loc-panel");
    if (!panel) {
      panel = L.DomUtil.create("div", "stored-loc-panel", wrap); panel.id = "stored-loc-panel";
      L.DomEvent.disableClickPropagation(panel); L.DomEvent.disableScrollPropagation(panel);
    }
    var locs = getStoredLocations();
    var nOn = locs.filter(function (l) { return l.on !== false; }).length;
    panel.innerHTML = '<div class="slp-head">' + escapeHtml(t("loc.stored")) +
        (locs.length ? '<button type="button" class="slp-allbtn" data-all="' + (nOn < locs.length ? "1" : "0") + '">' + escapeHtml(nOn < locs.length ? t("loc.selAll") : t("loc.selNone")) + "</button>" : "") + "</div>" +
      (locs.length ? locs.map(function (l, i) {
        return '<div class="slp-row">' +
          '<input type="checkbox" class="slp-on" data-i="' + i + '"' + (l.on !== false ? " checked" : "") + ' title="' + escapeHtml(t("loc.include")) + '" />' +
          '<button type="button" class="slp-go" data-i="' + i + '">📍 ' + escapeHtml(l.name) + "</button>" +
          '<input type="number" class="slp-radius" data-i="' + i + '" min="1" max="200" step="1" value="' + (l.radius || recentRadiusKm()) + '" title="' + escapeHtml(t("loc.radius")) + '" /><span class="slp-km">km</span>' +
          '<button type="button" class="slp-del" data-i="' + i + '" aria-label="' + escapeHtml(t("btn.delete")) + '">×</button></div>';
      }).join("") : '<div class="slp-empty">' + escapeHtml(t("loc.none")) + "</div>") +
      (locs.length ? '<div class="slp-foot"><button type="button" class="slp-fetch">' + escapeHtml(t("loc.fetch")) + "</button></div>" : "");
    var br = anchorEl.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    panel.style.left = Math.round(br.right - wr.left + 6) + "px";
    panel.style.top = Math.round(br.top - wr.top) + "px";
    panel.style.display = "block";
    panel.querySelectorAll(".slp-go").forEach(function (b) {
      b.addEventListener("click", function () {
        var l = getStoredLocations()[+this.getAttribute("data-i")]; if (!l) return;
        hideStoredLocations();
        mapClickGuardUntil = Date.now() + 300;
        map.setView([l.lat, l.lon], Math.max(map.getZoom() || 0, 13));
        selectMapPoint(l.lat, l.lon);
      });
    });
    panel.querySelectorAll(".slp-on").forEach(function (cb) {
      cb.addEventListener("change", function () { updateStoredLocation(+this.getAttribute("data-i"), { on: this.checked }); showStoredLocations(anchorEl); });
    });
    panel.querySelectorAll(".slp-radius").forEach(function (inp) {
      inp.addEventListener("change", function () { updateStoredLocation(+this.getAttribute("data-i"), { radius: Math.max(1, Math.min(200, parseInt(this.value, 10) || recentRadiusKm())) }); });
    });
    var allBtn = panel.querySelector(".slp-allbtn");
    if (allBtn) allBtn.addEventListener("click", function () {
      var turnOn = this.getAttribute("data-all") === "1";
      var a = getStoredLocations(); a.forEach(function (l) { l.on = turnOn; }); saveStoredLocations(a); showStoredLocations(anchorEl);
    });
    panel.querySelectorAll(".slp-del").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); removeStoredLocation(+this.getAttribute("data-i")); showStoredLocations(anchorEl); });
    });
    var fetchBtn = panel.querySelector(".slp-fetch");
    if (fetchBtn) fetchBtn.addEventListener("click", function () { hideStoredLocations(); fetchSelectedStoredLocations(); });
    renderStoredLocFrames();   // show the selected areas as squares on the map
  }
  // Fetch observations from every SELECTED stored location, each within its own
  // radius, and plot them (accumulating on the map). Sequential with a small gap
  // between locations — kind to the source APIs (which also self-rate-limit).
  var storedFetchBusy = false;
  function fetchSelectedStoredLocations() {
    if (storedFetchBusy) return;
    var locs = getStoredLocations().filter(function (l) { return l.on !== false; });
    if (!locs.length) { setStatus(t("loc.noneSelected")); return; }
    locs.forEach(function (l) { rememberFetchedArea(l.lat, l.lon, l.radius || recentRadiusKm()); });   // remember each fetched area's outline (persists until detections cleared)
    storedFetchBusy = true;
    var i = 0;
    (function next() {
      if (i >= locs.length) {
        storedFetchBusy = false;
        // Fit to every fetched location's area once done.
        var b = L.latLngBounds([]);
        locs.forEach(function (l) { var d = (l.radius || recentRadiusKm()) / 111; b.extend([l.lat - d, l.lon - d]); b.extend([l.lat + d, l.lon + d]); });
        if (b.isValid()) { try { map.fitBounds(b.pad(0.1)); } catch (e) {} }
        setStatus(t("loc.fetchedAll", { n: locs.length }));
        return;
      }
      var l = locs[i++];
      var label = t("loc.fetching", { name: l.name, i: i, n: locs.length });
      setStatus(label); photoDbg(label);   // banner too (the status bar is often hidden on mobile)
      fetchAllSightingsAt(l.lat, l.lon, null, l.radius || recentRadiusKm())
        .then(function (result) {
          photoDbg("✓ " + l.name + ": " + ((result && result.dedupTotal) || 0) + " obs");
          try { plotSightingsResult(result); } catch (e) {}
          setTimeout(next, 500);
        }, function () { photoDbg("✗ " + l.name); setTimeout(next, 500); });   // ~0.5s gap between locations
    })();
  }

  // Map-click popup: choose the Species list, or open the country's Fatbirder /
  // BirdLife page (resolved by reverse-geocoding the point). Checklists are
  // started from within the Species list itself.
  // ---- Shareable links -------------------------------------------------------
  // Encode a point / location-list / detection set into a self-contained URL so a
  // recipient sees the embedded data WITHOUT any API keys (nothing is re-fetched).
  // Payload is deflated (CompressionStream, when available) + base64url in the URL
  // hash — the hash is never sent to the server and keeps big sets out of the query.
  function b64urlFromBytes(bytes) {
    var bin = ""; for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function bytesFromB64url(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
    var bin = atob(s), b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }
  function encodeShare(obj) {
    var bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream !== "undefined") {
      try {
        return new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()
          .then(function (buf) { return "1" + b64urlFromBytes(new Uint8Array(buf)); });
      } catch (e) { /* fall through to raw */ }
    }
    return Promise.resolve("0" + b64urlFromBytes(bytes));
  }
  function decodeShare(str) {
    var tag = String(str).charAt(0), bytes = bytesFromB64url(String(str).slice(1));
    if (tag === "1") {
      if (typeof DecompressionStream === "undefined") return Promise.reject(new Error("no-decompress"));
      return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()
        .then(function (buf) { return JSON.parse(new TextDecoder().decode(new Uint8Array(buf))); });
    }
    return Promise.resolve(JSON.parse(new TextDecoder().decode(bytes)));
  }
  // Fallback for shares too big for a URL: hand the encoded payload over as a small
  // file (native share sheet if available, else download). The recipient opens it
  // with "Import shared file" in the Points panel.
  function shareAsFile(enc, title) {
    var fname = "migration-share-" + fmtDateFile(new Date()) + ".mcshare";
    try {
      var file = new File([enc], fname, { type: "text/plain" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: title || t("share.mapName") }).then(
          function () { setStatus(t("share.fileShared")); },
          function (e) { if (!e || e.name !== "AbortError") shareFileDownload(fname, enc); });
        return;
      }
    } catch (e) {}
    shareFileDownload(fname, enc);
  }
  function fmtDateFile(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function shareFileDownload(fname, text) {
    try {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      a.download = fname; document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 1500);
      setStatus(t("share.fileSaved"));
    } catch (e) { uiDialog({ message: t("share.copyManual"), input: true, value: text, alert: true }); }
  }
  function doShare(obj, title) {
    function warn() { uiDialog({ message: t("share.failed"), alert: true }); }
    encodeShare(obj).then(function (enc) {
      // Data lives in a QUERY param, not the hash (share targets strip the #fragment).
      // base64url is query-safe, so no extra encoding is needed.
      var url = location.origin + location.pathname + "?s=" + enc;
      if (url.length > 20000) { setStatus(t("share.tooBigFile")); shareAsFile(enc, title); return; }   // too big for a link → send as a file
      // Verify the link BEFORE handing it over: parse ?s= back out of the URL and
      // decode it — if the URL doesn't carry the data intact or it doesn't
      // reconstruct a valid payload, warn instead of sharing a broken link.
      var got = ""; try { got = new URLSearchParams(new URL(url).search).get("s") || ""; } catch (e) {}
      if (got !== enc) { warn(); return; }
      decodeShare(enc).then(function (payload) {
        if (!payload || (!payload.type && !payload.t)) { warn(); return; }
        // The native share sheet silently dropped the long URL on some devices, so
        // copy the FULL link to the clipboard and show it in a copyable dialog —
        // the reliable way to actually send it. Paste it into any message/app.
        if (navigator.clipboard && navigator.clipboard.writeText) {
          try { navigator.clipboard.writeText(url).then(function () { setStatus(t("share.copied")); }, function () {}); } catch (e) {}
        }
        uiDialog({ message: t("share.copyManual"), input: true, value: url, alert: true });
      }, warn);
    }).catch(warn);
  }
  function packPoints(list) {
    return (list || []).filter(function (p) { return p && isFinite(+p.lat) && isFinite(+p.lon); }).map(function (p) {
      var o = { lat: p.lat, lon: p.lon };
      if (p.name) o.name = p.name;
      if (p.tags && p.tags.length) o.tags = p.tags;
      if (p.note) o.note = p.note;
      if (p.noteHtml) o.noteHtml = true;
      if (p.spKey) o.spKey = p.spKey;
      if (p.spColor) o.spColor = p.spColor;
      if (p.date) o.date = p.date;
      if (p.count != null && p.count !== "") o.count = p.count;
      return o;
    });
  }
  function sharePointList(name) {
    var c = mpCollections.filter(function (x) { return x.name === name; })[0]; if (!c) return;
    doShare({ v: 1, type: "points", name: name, points: packPoints(c.points) }, name);
  }
  // Share the loose working map points (user-placed pins not yet saved as a list).
  function shareWorkingPoints() {
    var pts = packPoints(mapPoints);
    if (!pts.length) { setStatus(t("nav.empty")); return; }
    var name = mpActiveName || t("share.defaultName");
    doShare({ v: 1, type: "points", name: name, points: pts }, name);
  }
  // Per-source record-URL prefixes, so a link is stored as just its ID tail (the
  // prefix is re-added on decode) — keeps the "verify" links compact.
  var SRC_URL_PREFIX = {
    eBird: "https://ebird.org/checklist/",
    iNaturalist: "https://www.inaturalist.org/observations/",
    GBIF: "https://www.gbif.org/occurrence/",
    Artsobs: "https://mobil.artsobservasjoner.no/sighting/",
    Artportalen: "https://www.artportalen.se/sighting/",
    BirdWeather: "https://app.birdweather.com/stations/"
  };
  function urlTail(url, src) {
    url = String(url || ""); if (!url) return "";
    var pfx = SRC_URL_PREFIX[src];
    return (pfx && url.indexOf(pfx) === 0) ? url.slice(pfx.length) : url;   // tail only, else the full url
  }
  function urlFromTail(tail, src) {
    tail = String(tail || ""); if (!tail) return "";
    if (/^https?:\/\//i.test(tail)) return tail;   // a full url was stored
    var pfx = SRC_URL_PREFIX[src]; return pfx ? pfx + tail : tail;
  }
  // Compact share payload for a detections set (v2): dictionaries for species,
  // dates, observers and SOURCES (each unique value stored once), per-observation
  // rows of small integers — [speciesIdx, latΔ, lonΔ, dateIdx, count, observerIdx,
  // sourceIdx] — with ×1e5 (~1 m) integer delta coordinates, plus a parallel `u`
  // array of record-URL tails so the recipient can verify each record at its
  // source. Far smaller than the verbose form and deflates well.
  // Compact share (v3): COLUMNAR — each field is its own array (all species indices,
  // all lat-deltas, …) so deflate finds far more repetition than interleaved rows.
  // Coordinates are ×1e4 (~11 m) integer deltas from a base. Species stored by
  // language-independent KEY + class (recipient localises the name), plus date /
  // observer / source dictionaries and a parallel url-tail column for verification.
  function compactDet(name, detections) {
    var sp = [], spI = {}, dt = [], dtI = {}, ob = [], obI = {}, sr = [], srI = {};
    var cSp = [], cLa = [], cLo = [], cDt = [], cCn = [], cOb = [], cSc = [], urls = [], baseLat = null, baseLon = null;
    function idx(arr, map, v) { if (map[v] == null) { map[v] = arr.length; arr.push(v); } return map[v]; }
    Object.keys(detections || {}).forEach(function (k) {
      var en = detections[k] || {};
      var si = idx(sp, spI, (en.key || k) + "\t" + (en.cls || "") + "\t" + (en.color || "#888"));
      (en.rows || []).forEach(function (r) {
        if (r.lat == null || r.lon == null) return;
        if (baseLat == null) { baseLat = Math.round(r.lat * 1e4) / 1e4; baseLon = Math.round(r.lon * 1e4) / 1e4; }
        cSp.push(si);
        cLa.push(Math.round((r.lat - baseLat) * 1e4));
        cLo.push(Math.round((r.lon - baseLon) * 1e4));
        cDt.push((r.date) ? idx(dt, dtI, r.date) : -1);
        cCn.push((r.count != null && r.count !== "") ? +r.count : 0);
        cOb.push((r.observer && String(r.observer).trim()) ? idx(ob, obI, String(r.observer).trim()) : -1);
        cSc.push((r.src) ? idx(sr, srI, r.src) : -1);
        urls.push(urlTail(r.url, r.src));
      });
    });
    return { v: 3, t: "d", n: name, s: sp.map(function (x) { var p = x.split("\t"); return [p[0], p[1], p[2]]; }), d: dt, o: ob, sr: sr,
      b: [baseLat || 0, baseLon || 0], c: { sp: cSp, la: cLa, lo: cLo, dt: cDt, cn: cCn, ob: cOb, sc: cSc }, u: urls };
  }
  function shareDetSet(name) {
    var s = detSets().filter(function (x) { return x.name === name; })[0]; if (!s) return;
    doShare(compactDet(name, s.detections), name);
  }
  // Share the detections currently loaded from data sources (the live plot), no
  // need to save them as a trip first.
  function shareCurrentDetections() {
    var det = serializeDetPlot();
    if (!det || !Object.keys(det).length) { setStatus(t("det.none")); return; }
    var name = t("share.detName");
    doShare(compactDet(name, det), name);
  }
  // Every user-defined point currently ON the map: loose working pins + shown
  // saved-list points that aren't detections (list detection points already ride
  // in the detections via detPlot).
  function allShownUserPoints() {
    var out = (mapPoints || []).slice();
    (mpCollections || []).forEach(function (c) { if (shownColls[c.name]) (c.points || []).forEach(function (p) { if (p && !p.spKey) out.push(p); }); });
    return out;
  }
  // Share the WHOLE map in one operation: all plotted detections + all user points.
  function shareMap() {
    var det = serializeDetPlot(), pts = allShownUserPoints();
    var hasDet = det && Object.keys(det).length, hasPts = pts.length;
    if (!hasDet && !hasPts) { setStatus(t("det.none")); return; }
    var name = t("share.mapName");
    var payload = { v: 3, t: "m", n: name };
    if (hasDet) payload.d = compactDet(name, det);
    if (hasPts) payload.p = packPoints(pts);
    doShare(payload, name);
  }
  // Reverse compactDet (v2) back into the { type:"det", name, detections } shape the
  // importer expects; other payloads (v1 / point / points) pass through unchanged.
  function expandShared(obj) {
    if (obj && obj.t === "d" && (obj.v === 2 || obj.v === 3)) return expandDetShare(obj);
    return obj;   // v1 / point / points / map wrapper pass through
  }
  // Rebuild the { type:"det", name, detections } shape from v3 (columnar, ×1e4) or
  // legacy v2 (row-oriented, ×1e5). Species keep KEY + class so detName() localises
  // the name for the recipient; src + record url are restored for verification.
  function expandDetShare(obj) {
    var b = obj.b || [0, 0], baseLat = +b[0] || 0, baseLon = +b[1] || 0, dets = {};
    var v3 = obj.v === 3, SC = v3 ? 1e4 : 1e5, c = obj.c || {};
    var n = v3 ? (c.sp || []).length : (obj.r || []).length;
    for (var i = 0; i < n; i++) {
      var si, laI, loI, di, cnt, oi, ri;
      if (v3) { si = c.sp[i] || 0; laI = c.la[i] || 0; loI = c.lo[i] || 0; di = (c.dt && c.dt[i] != null) ? c.dt[i] : -1; cnt = (c.cn && c.cn[i]) || 0; oi = (c.ob && c.ob[i] != null) ? c.ob[i] : -1; ri = (c.sc && c.sc[i] != null) ? c.sc[i] : -1; }
      else { var row = obj.r[i] || []; si = row[0] || 0; laI = row[1] || 0; loI = row[2] || 0; di = (row[3] == null ? -1 : row[3]); cnt = row[4] || 0; oi = (row[5] == null ? -1 : row[5]); ri = (row[6] == null ? -1 : row[6]); }
      var spx = (obj.s && obj.s[si]) || ["", "", "#888"], key = "s" + si;
      if (!dets[key]) dets[key] = { key: spx[0] || "", cls: spx[1] || "", color: spx[2] || "#888", rows: [] };
      var rr = { lat: baseLat + laI / SC, lon: baseLon + loI / SC };
      if (di >= 0 && obj.d && obj.d[di]) rr.date = obj.d[di];
      if (cnt) rr.count = cnt;
      if (oi >= 0 && obj.o && obj.o[oi]) rr.observer = obj.o[oi];
      var src = (ri >= 0 && obj.sr && obj.sr[ri]) ? obj.sr[ri] : "";
      if (src) rr.src = src;
      var tail = obj.u && obj.u[i]; if (tail) rr.url = urlFromTail(tail, src);
      dets[key].rows.push(rr);
    }
    return { type: "det", name: obj.n || "", detections: dets };
  }
  function uniqueShareName(base, taken) { var n = base, i = 2; while (taken(n)) n = base + " (" + (i++) + ")"; return n; }
  function fitSharedLatLngs(pts) {
    if (!map || !pts.length) return;
    try { map.fitBounds(L.latLngBounds(pts).pad(0.2)); } catch (e) {}
  }
  // Apply a payload decoded from #s= at boot. Points / detection sets are imported
  // (after a confirm) into the recipient's saved lists, shown, and fitted; a single
  // point just drops a marker and opens its popup.
  // Add a shared detection set to the store (shown); returns { name, ll }.
  function importDetSetColl(nm, detections) {
    var name = uniqueShareName(nm, function (x) { return detSets().some(function (s) { return s.name === x; }); });
    var blob = { name: name, createdAt: 0, detections: detections, interesting: [] };
    detSetStore.push(blob); persistDetSet(name, blob);
    window.GeoState.save({ mapDetectionSetsDel: detSetTombstones().filter(function (x) { return x !== name; }) });
    shownDetSets[name] = true;
    var ll = []; Object.keys(detections || {}).forEach(function (k) { ((detections[k] || {}).rows || []).forEach(function (r) { if (isFinite(+r.lat) && isFinite(+r.lon)) ll.push([+r.lat, +r.lon]); }); });
    return { name: name, ll: ll };
  }
  // Add a shared point-list collection (shown); returns { name, ll }.
  function importPointsColl(nm, pts) {
    var name = uniqueShareName(nm, function (x) { return mpCollections.some(function (c) { return c.name === x; }); });
    mpCollections.push({ name: name, points: pts.map(function (p) { return Object.assign({}, p, { lat: +p.lat, lon: +p.lon }); }) });
    shownColls[name] = true;
    return { name: name, ll: pts.map(function (p) { return [+p.lat, +p.lon]; }) };
  }
  function detRowCount(detections) {
    var n = 0; Object.keys(detections || {}).forEach(function (k) { n += ((detections[k] || {}).rows || []).length; }); return n;
  }
  function importShared(str) {
    decodeShare(str).then(function (raw) {
      // Whole-map share: detections + user points in one payload.
      if (raw && raw.t === "m") {
        var detObj = raw.d ? expandShared(raw.d) : null;
        var mpts = (raw.p || []).filter(function (p) { return p && isFinite(+p.lat) && isFinite(+p.lon); });
        var nDet = detObj ? detRowCount(detObj.detections) : 0, nPts = mpts.length;
        if (!nDet && !nPts) { setStatus(t("share.badLink")); return; }
        var mnm = String(raw.n || t("share.mapName"));
        modalConfirm(t("share.importMapPrompt", { d: nDet, p: nPts })).then(function (ok) {
          if (!ok) return;
          var ll = [];
          if (nDet) ll = ll.concat(importDetSetColl(mnm, detObj.detections).ll);
          if (nPts) { ll = ll.concat(importPointsColl(mnm, mpts).ll); saveMapPoints(); }
          saveShownState(); renderMapPoints(); fitSharedLatLngs(ll);
          setStatus(t("share.imported", { name: mnm }));
        });
        return;
      }
      var obj = expandShared(raw);
      if (!obj || !obj.type) { setStatus(t("share.badLink")); return; }
      if (obj.type === "point") {
        var la = Math.max(-90, Math.min(90, +obj.lat)), lo = wrapLon(+obj.lon);
        if (!isFinite(la) || !isFinite(lo)) { setStatus(t("share.badLink")); return; }
        if (map) map.setView([la, lo], Math.max(map.getZoom() || 0, 12));
        selectMapPoint(la, lo);
        return;
      }
      var nm = String(obj.name || t("share.defaultName"));
      if (obj.type === "points") {
        var pts = (obj.points || []).filter(function (p) { return p && isFinite(+p.lat) && isFinite(+p.lon); });
        if (!pts.length) { setStatus(t("share.badLink")); return; }
        modalConfirm(t("share.importPrompt", { name: nm, n: pts.length })).then(function (ok) {
          if (!ok) return;
          var r = importPointsColl(nm, pts); saveMapPoints(); saveShownState(); renderMapPoints();
          fitSharedLatLngs(r.ll); setStatus(t("share.imported", { name: r.name }));
        });
        return;
      }
      if (obj.type === "det") {
        var n = detRowCount(obj.detections);
        if (!n) { setStatus(t("share.badLink")); return; }
        modalConfirm(t("share.importPrompt", { name: nm, n: n })).then(function (ok) {
          if (!ok) return;
          var r = importDetSetColl(nm, obj.detections); saveShownState(); renderMapPoints();
          fitSharedLatLngs(r.ll); setStatus(t("share.imported", { name: r.name }));
        });
        return;
      }
      setStatus(t("share.badLink"));
    }).catch(function () { setStatus(t("share.badLink")); });
  }
  function maybeImportShared() {
    var enc = "";
    try { enc = new URLSearchParams(location.search).get("s") || ""; } catch (e) {}
    if (!enc) { var m = (location.hash || "").match(/[#&]s=([^&]+)/); if (m) enc = m[1]; }   // legacy hash links
    if (!enc) return;
    try { history.replaceState(null, "", location.pathname); } catch (e) {}   // consume it → no re-import on reload
    importShared(enc);
  }
  // Copy a point's coordinates as plain "lat, lon" text (decimal degrees) — pastes
  // straight into Google/Apple Maps and most tools.
  function coordsText(lat, lon) { return (+lat).toFixed(5) + ", " + wrapLon(+lon).toFixed(5); }
  function copyCoords(lat, lon) {
    if (!isFinite(+lat) || !isFinite(+lon)) return;
    var txt = coordsText(lat, lon);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { setStatus(t("coords.copied", { coords: txt })); }, function () { modalPrompt(t("coords.copyManual"), txt); });
    } else { modalPrompt(t("coords.copyManual"), txt); }
  }
  // Country resources for the country at the map centre: Blogs, BirdLife, and the
  // national observation/registration services — opened from the right-side globe.
  function openCountryMenu() {
    if (!map) return;
    var c = map.getCenter();
    AppGeo.countryInfo(c.lat, c.lng).then(function (info) { showCountryMenu(info.cc, info.name); },
      function () { showCountryMenu("", ""); });
  }
  function showCountryMenu(cc, name) {
    var m = createModal({ boxClass: "map-choose country-menu", escClose: true });
    var box = m.box, close = m.close;
    var head = document.createElement("div"); head.className = "cm-head";
    var title = document.createElement("span"); title.className = "cm-title";
    title.textContent = name || t("popup.country");
    var x = document.createElement("button");
    x.type = "button"; x.className = "cm-close"; x.textContent = "×"; x.setAttribute("aria-label", t("btn.close"));
    x.addEventListener("click", close);
    head.appendChild(title); head.appendChild(x);
    box.appendChild(head);
    box.appendChild(makePopupBtn(t("blogs.title") + " ▸", "demo-btn-light", function () { close(); openBlogs(cc, name); }));
    box.appendChild(makePopupBtn(t("link.birdlife") + " ↗", "demo-btn-light", function () { close(); openExternal(birdLifeCountryUrl(cc, name)); }));
    natServicesFor(cc).forEach(function (s) {
      box.appendChild(makePopupBtn(s.label + " ↗", "demo-btn-light", function () { close(); openExternal(s.url); }));
    });
  }
  function bindPointPopup(mk, lat, lon) {
    var wrap = document.createElement("div");
    wrap.className = "map-choose";
    wrap.appendChild(makePopupBtn(t("mode.list"), "", function () { mk.closePopup(); renderSpeciesList(lat, lon); }));
    // "Location" submenu: Save location / Share link / Copy coordinates, collapsed
    // under one entry so the popup stays tidy.
    var locSub = document.createElement("div");
    locSub.className = "choose-sub"; locSub.style.display = "none";
    locSub.appendChild(makePopupBtn("📍 " + t("loc.save"), "demo-btn-light", function () { mk.closePopup(); registerLocationPrompt(lat, lon); }));
    locSub.appendChild(makePopupBtn("🔗 " + t("share.link"), "demo-btn-light", function () { mk.closePopup(); doShare({ v: 1, type: "point", lat: lat, lon: lon }, t("share.link")); }));
    locSub.appendChild(makePopupBtn("📋 " + coordsText(lat, lon), "demo-btn-light", function () { mk.closePopup(); copyCoords(lat, lon); }));
    var locBtn = makePopupBtn("📍 " + t("popup.location") + " ▸", "demo-btn-light", function () {
      var show = locSub.style.display === "none";
      locSub.style.display = show ? "" : "none";
      this.textContent = "📍 " + t("popup.location") + (show ? " ▾" : " ▸");
      var pop = mk.getPopup(); if (pop && pop.isOpen()) pop.update();   // re-layout for the expanded items
    });
    wrap.appendChild(locBtn);
    wrap.appendChild(locSub);
    wrap.appendChild(makePopupBtn(t("link.birdingplaces") + " ↗", "demo-btn-light", function () {
      mk.closePopup(); openExternal(birdingPlacesUrl(lat, lon));
    }));
    // Country resources (Blogs / BirdLife / national services) now live in the
    // right-side "Country" button (openCountryMenu), not this per-point popup.
    mk.bindPopup(wrap, { closeButton: true, autoClose: true, autoPan: true, className: "choose-popup", offset: [0, -8] });
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
  function todayStr() { return fmtDateFile(new Date()); }   // same local-date format as fmtDateFile
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
  // A species' log entries (chronological).
  function fcEntriesFor(rec, key) { return ((rec && rec.log) || []).filter(function (e) { return e.key === key; }).sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); }); }
  function fcIsSeen(key) { var rec = curFieldRecord(false); return !!(rec && rec.seen && rec.seen[key]); }

  // Transient per-species compose draft backing the top-line inputs (count,
  // activity, note); not persisted until committed via ＋ or a first tick.
  var composeDraft = {};
  function cd(key) { return composeDraft[key] || (composeDraft[key] = { count: null, act: "", note: "", sex: "" }); }
  function eid() { return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ---- Per-entry photos -----------------------------------------------------
  // Photos attach to a checklist log entry (e.imgs = [imgId, …]). The image data
  // is far too big for localStorage (a phone photo is several MB), so each
  // downscaled JPEG data-URL is stored in IndexedDB under "img:<id>" and the entry
  // keeps only the small id. Local-only — NOT part of the Drive-sync payload.
  function imgId() { return "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function imgKey(id) { return "img:" + id; }
  // Lightweight toast for photo add feedback — shown in-page (the status bar is
  // hidden behind the full-screen field page on mobile).
  function photoDbg(msg) {
    try {
      var d = document.getElementById("photo-dbg");
      if (!d) { d = document.createElement("div"); d.id = "photo-dbg"; d.style.cssText = "position:fixed;left:8px;right:8px;top:8px;z-index:99999;background:#0b3a3a;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:10px 12px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.4);white-space:pre-wrap;"; document.body.appendChild(d); }
      d.textContent = "📷 " + msg;
      if (d._t) clearTimeout(d._t); d._t = setTimeout(function () { try { d.parentNode.removeChild(d); } catch (e) {} }, 9000);
    } catch (e) {}
  }
  // Decode a picked file, downscale its longest side to maxPx, and return a JPEG
  // data-URL. Tries createImageBitmap (honours EXIF orientation), but falls back
  // to a FileReader + <img> + canvas path on ANY failure — Safari/iOS often
  // rejects createImageBitmap with the orientation option (or on HEIC), and the
  // <img> path also handles HEIC photos the picker hands over.
  function fcResizeImage(file, maxPx, quality) {
    maxPx = maxPx || 1600; quality = quality || 0.72;
    function draw(src, w, h) {
      var m = Math.max(w, h), scale = m > maxPx ? maxPx / m : 1;
      var c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", quality);
    }
    function fileReaderPath() {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { var im = new Image(); im.onload = function () { try { resolve(draw(im, im.width, im.height)); } catch (e) { reject(e); } }; im.onerror = function () { reject(new Error("decode")); }; im.src = fr.result; };
        fr.onerror = function () { reject(fr.error); };
        fr.readAsDataURL(file);
      });
    }
    if (window.createImageBitmap) {
      try {
        return createImageBitmap(file, { imageOrientation: "from-image" }).then(function (bmp) {
          var url = draw(bmp, bmp.width, bmp.height);
          if (bmp.close) { try { bmp.close(); } catch (e) {} }
          return url;
        }, fileReaderPath);   // createImageBitmap rejected (Safari/options/HEIC) → fall back
      } catch (e) { return fileReaderPath(); }   // threw synchronously
    }
    return fileReaderPath();
  }
  // Add picked photos to an entry: downscale, store each in IndexedDB, append the
  // id onto the entry, then persist. Resolves when all are stored.
  function fcAddEntryImages(entryId, files) {
    if (!(window.AppIDB && window.AppIDB.available())) { photoDbg("Storage unavailable (no IndexedDB — private mode?)"); return Promise.resolve(); }
    var rec = curFieldRecord(false); if (!rec) { photoDbg("No open checklist to attach to"); return Promise.resolve(); }
    var e = rec.log.filter(function (x) { return x.id === entryId; })[0]; if (!e) { photoDbg("Observation not found (" + entryId + ")"); return Promise.resolve(); }
    // Accept whatever the picker returns: the input is accept="image/*", and a picked
    // photo can arrive with an EMPTY (or non-image) MIME type — filtering on /^image\//
    // silently dropped those, so nothing was stored.
    var dbg = "picked=" + (files ? files.length : "null") + (files && files[0] ? " type='" + (files[0].type || "(empty)") + "' " + Math.round((files[0].size || 0) / 1024) + "KB" : "");
    var arr = Array.prototype.slice.call(files || []).filter(function (f) { return f && (!f.type || /^image\//i.test(f.type)); });
    if (!arr.length) { photoDbg("No photo received. " + dbg); return Promise.resolve(); }
    var added = 0, lastErr = "";
    return arr.reduce(function (p, f) {
      return p.then(function () {
        return fcResizeImage(f).then(function (url) {
          var id = imgId();
          return window.AppIDB.put(imgKey(id), url).then(function () { e.imgs = e.imgs || []; e.imgs.push(id); added++; });
        });
      }).catch(function (err) { lastErr = (err && err.message) || "" + err; });
    }, Promise.resolve()).then(function () {
      putFieldRecord(rec);
      photoDbg(added ? t("chk.photoSaved", { n: added }) : ("⚠ " + (lastErr || "photo failed") + "  [" + dbg + "]"));
    });
  }
  // Remove one photo from an entry (and delete its IndexedDB blob).
  function fcRemoveEntryImage(entryId, id) {
    var rec = curFieldRecord(false); if (!rec) return;
    var e = rec.log.filter(function (x) { return x.id === entryId; })[0]; if (!e || !e.imgs) return;
    e.imgs = e.imgs.filter(function (x) { return x !== id; });
    if (!e.imgs.length) delete e.imgs;
    if (window.AppIDB) window.AppIDB.del(imgKey(id)).then(null, function () {});
    putFieldRecord(rec);
  }
  // Delete every stored photo referenced by these entries (orphan cleanup on
  // entry delete / list clear).
  function fcDropEntryImages(entries) {
    if (!window.AppIDB) return;
    (entries || []).forEach(function (e) { ((e && e.imgs) || []).forEach(function (id) { window.AppIDB.del(imgKey(id)).then(null, function () {}); }); });
  }
  // Load image data-URLs for a set of ids → { id: dataURL } (missing ids omitted).
  function fcLoadImages(ids) {
    if (!ids || !ids.length || !(window.AppIDB && window.AppIDB.available())) return Promise.resolve({});
    var uniq = [], seen = {}; ids.forEach(function (id) { if (id && !seen[id]) { seen[id] = 1; uniq.push(id); } });
    var out = {};
    return Promise.all(uniq.map(function (id) {
      return window.AppIDB.get(imgKey(id)).then(function (v) { if (v) out[id] = v; }, function () {});
    })).then(function () { return out; });
  }
  // Fill an entry row's thumbnail strip (async — images live in IndexedDB).
  function fcRenderEntryThumbs(entryId, ids) {
    var box = document.querySelector('#entry-list .ent-imgs[data-id="' + entryId + '"]');
    if (!box) return;
    fcLoadImages(ids).then(function (map) {
      box.innerHTML = ids.map(function (id) {
        if (!map[id]) return "";
        return '<span class="ent-thumb"><img src="' + map[id] + '" alt="" />' +
          '<button type="button" class="ent-img-del" data-id="' + escapeHtml(entryId) + '" data-img="' + escapeHtml(id) + '" aria-label="' + escapeHtml(t("btn.delete")) + '">×</button></span>';
      }).join("");
    });
  }
  // Card 📷 button: attach photo(s) to a species' most recent observation,
  // creating one (and ticking it seen) if it has none yet, then refresh the card.
  function fcAddPhotoToSpecies(key, files) {
    if (!files || !files.length) return;
    var rec = curFieldRecord(true); if (!rec) return;
    var ents = fcEntriesFor(rec, key);
    if (!ents.length) { fcCommitCompose(key); rec = curFieldRecord(false); ents = rec ? fcEntriesFor(rec, key) : []; }
    if (!ents.length) return;
    var entryId = ents[ents.length - 1].id;
    setStatus(t("chk.savingPhoto"));
    fcAddEntryImages(entryId, files).then(function () { renderFieldList(); });
  }

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
    recordSpeciesSeen(key);   // logging a species ticks it on the year + life lists
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
    if (e) fcDropEntryImages([e]);   // remove its photos from IndexedDB
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
    var counts = [], acts = [], notes = [], imgs = [];
    sel.forEach(function (e) {
      if (e.count != null && e.count !== "") counts.push(String(e.count));
      String(e.act || "").split(" / ").forEach(function (a) { if (a && acts.indexOf(a) < 0) acts.push(a); });
      if (e.note) notes.push(e.note);
      (e.imgs || []).forEach(function (id) { if (imgs.indexOf(id) < 0) imgs.push(id); });   // keep merged entries' photos
    });
    var merged = { id: eid(), key: sel[0].key, ts: sel[0].ts, lat: sel[0].lat, lon: sel[0].lon,
      count: counts.length ? counts.join(", ") : null, act: acts.join(" / "), note: notes.join(" | ") };
    if (imgs.length) merged.imgs = imgs;
    var first = rec.log.indexOf(sel[0]);
    rec.log = rec.log.filter(function (e) { return ids.indexOf(e.id) < 0; });
    rec.log.splice(Math.max(0, first), 0, merged);
    putFieldRecord(rec);
  }
  function fcClear() { var rec = curFieldRecord(false); if (!rec) return; fcDropEntryImages(rec.log); rec.log = []; rec.seen = {}; putFieldRecord(rec); }
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
      var nImg = ents.reduce(function (s, e) { return s + ((e.imgs && e.imgs.length) || 0); }, 0);
      var imgBadge = nImg ? '<span class="fc-imgcount" title="' + nImg + '">📷' + nImg + "</span>" : "";
      return '<div class="fc-card' + (en.seen ? " fc-on" : "") + (d.note ? " fc-note-on" : "") + '" data-key="' + escapeHtml(r.key) + '">' +
        '<div class="fc-top">' +
          '<span class="fc-name sp-link" data-key="' + escapeHtml(r.key) + '" data-name="' + escapeHtml(r.name) + '" data-sci="' + escapeHtml(lbl ? (lbl.sci || "") : "") + '">' + interestingStar(r.key) + escapeHtml(r.name) + badge + imgBadge + "</span>" +
          '<div class="fc-actions">' +
            '<button type="button" class="fc-count' + (hasN ? " has-n" : "") + '" data-key="' + escapeHtml(r.key) + '">' + (hasN ? d.count : "#") + "</button>" +
            '<button type="button" class="fc-act-btn' + (d.act ? " has-act" : "") + '" data-key="' + escapeHtml(r.key) + '" title="' + escapeHtml(t("chk.activity")) + '">' + (d.act ? escapeHtml(actName(d.act)) : ico("tag")) + "</button>" +
            '<button type="button" class="fc-sex-btn' + (d.sex ? " has-sex" : "") + '" data-key="' + escapeHtml(r.key) + '" title="' + escapeHtml(t("chk.sex")) + '">' + sexGlyphHtml(d.sex || "") + "</button>" +
            '<label class="fc-img-add" title="' + escapeHtml(t("chk.addPhoto")) + '" aria-label="' + escapeHtml(t("chk.addPhoto")) + '">📷<input type="file" accept="image/*" class="fc-img-file" data-key="' + escapeHtml(r.key) + '" multiple hidden /></label>' +
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
    if (btn) { if (a) btn.textContent = actName(a); else btn.innerHTML = ico("tag"); btn.classList.toggle("has-act", !!a); }
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
        '<label class="ent-img-add" title="' + escapeHtml(t("chk.addPhoto")) + '" aria-label="' + escapeHtml(t("chk.addPhoto")) + '">📷' +
          '<input type="file" accept="image/*" class="ent-img-file" data-id="' + escapeHtml(e.id) + '" multiple hidden /></label>' +
        '<span class="ent-meta">' + escapeHtml(meta) + "</span>" +
        '<button type="button" class="ent-del" data-id="' + escapeHtml(e.id) + '" aria-label="' + escapeHtml(t("btn.delete")) + '">×</button>' +
        "</div>" +
        '<div class="ent-imgs" data-id="' + escapeHtml(e.id) + '"></div>';
    }).join("");
    ents.forEach(function (e) { if (e.imgs && e.imgs.length) fcRenderEntryThumbs(e.id, e.imgs); });
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
    var esc = csvEsc;   // shared module-level CSV escaper
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
        '<button type="button" class="demo-btn rv-dl ico-btn" data-grp="' + esc(grp) + '">' + ico("download") + '<span class="ico-label" data-i18n="review.dlEbird">' + esc(tLabel("review.dlEbird")) + "</span></button>" +
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


  // Open a clean, print-ready page of the seen birds in a new tab and trigger
  // the print dialog (where the browser offers "Save as PDF"). No PDF library
  // needed — works offline.
  function exportFieldPdf() {
    var title = (document.getElementById("field-coords").value || "").trim() || t("btn.checklist").replace(/^[^\wÀ-ɏ]+\s*/, "");
    var date = new Date().toISOString().slice(0, 10);
    var esc = escapeHtml;
    var rec = curFieldRecord(false);
    var byKey = {}; (fieldData || []).forEach(function (r) { byKey[r.key] = r; });
    function nameFor(key) { return (byKey[key] && byKey[key].name) || (labelsByKey[key] && speciesName(labelsByKey[key])) || key; }
    // One row PER DETECTION (log entry), not per species. Species seen with no
    // logged detection still get a name-only row so nothing is lost.
    var dets = ((rec && rec.log) || []).map(function (e) { return { e: e, name: nameFor(e.key) }; });
    var agg = getFieldEntries();
    Object.keys(agg).forEach(function (key) { if (agg[key].seen && !agg[key].n) dets.push({ e: { key: key }, name: nameFor(key), seenOnly: true }); });
    dets.sort(function (a, b) { var c = a.name.localeCompare(b.name); return c || ((a.e.ts || 0) - (b.e.ts || 0)); });
    // Photo ids across all detections.
    var ids = []; dets.forEach(function (o) { (o.e.imgs || []).forEach(function (id) { ids.push(id); }); });
    setStatus(t("app.loading"));
    function pad2(n) { return (n < 10 ? "0" : "") + n; }
    function dtStr(ts) { if (!ts) return ""; var d = new Date(ts); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + fmtClock(ts); }
    fcLoadImages(ids).then(function (imgMap) {
      var COLS = 7;
      var body = dets.map(function (o) {
        var e = o.e;
        var nameCell = esc(o.name) + (e.sex ? " " + sexGlyphHtml(e.sex) : "");
        var cnt = (e.count != null && e.count !== "") ? esc(String(e.count)) : "";
        var row = "<tr>" +
          "<td>" + nameCell + "</td>" +
          "<td>" + esc(dtStr(e.ts)) + "</td>" +
          '<td class="pr-num">' + cnt + "</td>" +
          "<td>" + esc(e.act ? actLabel(e.act) : "") + "</td>" +
          '<td class="pr-num">' + (e.lon != null ? esc(e.lon.toFixed(5)) : "") + "</td>" +
          '<td class="pr-num">' + (e.lat != null ? esc(e.lat.toFixed(5)) : "") + "</td>" +
          "<td>" + esc(e.note || "") + "</td>" +
        "</tr>";
        var imgs = (e.imgs || []).filter(function (id) { return imgMap[id]; });
        var imgRow = imgs.length ? '<tr class="pr-imgrow"><td colspan="' + COLS + '">' +
          imgs.map(function (id) { return '<img src="' + imgMap[id] + '" alt="" />'; }).join("") + "</td></tr>" : "";
        return row + imgRow;
      }).join("") || '<tr><td colspan="' + COLS + '">' + esc(t("analysis.empty")) + "</td></tr>";
      var inner =
        '<div class="pr-bar"><button type="button" class="pr-print">' + esc(t("chk.savePdf")) + "</button>" +
        '<button type="button" class="pr-close" aria-label="' + esc(t("btn.close")) + '">✕</button></div>' +
        "<h1>" + esc(title) + "</h1>" +
        '<div class="pr-meta">' + esc(date) + " &middot; " + dets.length + " " + esc(t("chk.seen").toLowerCase()) + "</div>" +
        '<table class="pr-det"><thead><tr><th>' + esc(t("th.species")) + "</th><th>" + esc(t("th.datetime")) +
        "</th><th>" + esc(t("chk.count")) + "</th><th>" + esc(t("chk.activity")) + "</th><th>" + esc(t("th.lon")) +
        "</th><th>" + esc(t("th.lat")) + "</th><th>" + esc(t("th.notes")) + "</th></tr></thead><tbody>" + body + "</tbody></table>";
      showPrintReport(inner);
      setStatus("");
    }, function () { setStatus(t("status.error", { msg: "images" })); });
  }
  // Show the report as a full-screen in-app overlay (where photos render exactly
  // as they do in the editor), then window.print() captures ONLY this element via
  // the @media print rules in app.css. This avoids new windows / blob navigation /
  // iframe printing — all unreliable for data-URL images on iOS Safari.
  function showPrintReport(inner) {
    var el = document.getElementById("print-report");
    if (!el) { el = document.createElement("div"); el.id = "print-report"; document.body.appendChild(el); }
    el.innerHTML = inner;
    el.classList.add("show");
    document.body.classList.add("print-report-active");   // scopes the @media print rule to this overlay
    el.querySelector(".pr-print").addEventListener("click", function () { try { window.print(); } catch (e) {} });
    el.querySelector(".pr-close").addEventListener("click", function () { navClose("printreport"); });
    navOpen("printreport", function () { el.classList.remove("show"); el.innerHTML = ""; document.body.classList.remove("print-report-active"); });
  }

  // Write final HTML into an already-open print window (opened earlier in the
  // user gesture), then trigger the print dialog. Waits for any embedded photos
  // (data-URL <img>) to finish decoding first — otherwise print()/Save-as-PDF can
  // fire before they paint and the photos are missing from the PDF. Falls back to
  // a timeout so a stuck image can't block printing forever.
  function writePrintWindow(w, html) {
    try {
      w.document.open(); w.document.write(html); w.document.close(); w.focus();
      var done = false;
      var doPrint = function () { if (done) return; done = true; try { w.print(); } catch (e) { /* user can print manually */ } };
      var imgs = w.document.images || [], pending = 0;
      var tick = function () { if (pending <= 0) setTimeout(doPrint, 60); };   // all decoded → tiny delay for layout
      for (var i = 0; i < imgs.length; i++) {
        if (!imgs[i].complete) {
          pending++;
          var fin = function () { pending--; tick(); };
          imgs[i].addEventListener("load", fin); imgs[i].addEventListener("error", fin);
        }
      }
      if (pending === 0) setTimeout(doPrint, 350);   // no photos (or all cached) → small delay for layout
      else setTimeout(doPrint, 5000);                 // safety: never wait forever on a stuck image
    } catch (e) {}
  }
  function openPrintWindow(html) {
    var w = window.open("", "_blank");
    if (!w) { setStatus(t("status.error", { msg: "popup blocked" })); return; }
    writePrintWindow(w, html);
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
  // In-place quickselect: returns the k-th smallest of a[lo..hi) and partitions
  // so a[i] <= a[k] for i<k and >= for i>k. 3-way partition stays O(n) despite the
  // many duplicate (zero) probabilities in a species' column — replaces a full
  // O(n log n) sort + per-species array copy when we only need p90 + median.
  function quickselectF(a, lo, hi, k) {
    while (hi - lo > 1) {
      var pivot = a[lo + ((hi - lo) >> 1)];
      var lt = lo, gt = hi - 1, i = lo, t;
      while (i <= gt) {
        var x = a[i];
        if (x < pivot) { t = a[lt]; a[lt] = x; a[i] = t; lt++; i++; }
        else if (x > pivot) { t = a[gt]; a[gt] = x; a[i] = t; gt--; }
        else i++;
      }
      if (k < lt) hi = lt; else if (k > gt) lo = gt + 1; else return a[k];
    }
    return a[k];
  }
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
      // Two order statistics via in-place quickselect — no full sort, no per-species
      // allocation. (col is reused/overwritten next iteration, so partitioning it is fine.)
      p90[i2] = quickselectF(col, 0, cells.length, p90Idx);
      median[i2] = quickselectF(col, 0, cells.length, medIdx);
    }
    return { max: maxArr, p90: p90, median: median };
  }
  async function renderSpeciesInCountry(lat, lon) {
    var keepScroll = keepListScroll; keepListScroll = false;   // consume one-shot flag
    var info = await AppGeo.countryInfo(lat, lon);
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
      if (currentMode === "list") { if (!keepScroll) sp.scrollTop = 0; navOpen("page", closeAnyFullPage); }
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

  // ---- Historic observations: a GBIF-only search over a user date range -------
  // Reuses the species-panel table (the Probability column shows the record
  // count, n(d) the last-seen date). Isolated from the normal multi-source fetch.
  var histAbort = null;
  var histPoint = null;     // the placed (not-yet-fetched) search centre
  var histMonths = [];      // selected months (1-12) to restrict the GBIF fetch to; empty = all months
  // Build the 12 month toggles (localized short names) under the date range.
  // Selecting some restricts the fetch to those months across ALL years in the
  // range (GBIF's &month filter); selecting none = every month.
  function histMonthShort(m) {
    var lang = (window.GeoState.get("lang", defaultLang()) || "en");
    var fmt; try { fmt = new Intl.DateTimeFormat(lang, { month: "short" }); } catch (e) { fmt = null; }
    return fmt ? fmt.format(new Date(2021, m - 1, 15)) : String(m);
  }
  // Reflect the current selection in the collapsed dropdown's summary so the user
  // sees which months are active without opening it (blank → all months).
  function updateHistMonthsSel() {
    var el = document.getElementById("hist-months-sel"); if (!el) return;
    el.textContent = histMonths.length ? histMonths.slice().sort(function (a, b) { return a - b; }).map(histMonthShort).join(", ") : "";
  }
  function buildHistMonths() {
    var el = document.getElementById("hist-months"); if (!el) return;
    var html = "";
    for (var m = 1; m <= 12; m++) {
      html += '<button type="button" class="hist-month' + (histMonths.indexOf(m) >= 0 ? " active" : "") + '" data-month="' + m + '">' + escapeHtml(histMonthShort(m)) + "</button>";
    }
    el.innerHTML = html;
    Array.prototype.forEach.call(el.querySelectorAll(".hist-month"), function (b) {
      b.addEventListener("click", function () {
        var m = +this.getAttribute("data-month"), i = histMonths.indexOf(m);
        if (i >= 0) { histMonths.splice(i, 1); this.classList.remove("active"); }
        else { histMonths.push(m); this.classList.add("active"); }
        updateHistMonthsSel();
      });
    });
    updateHistMonthsSel();
  }
  // GBIF query fragment for the selected months ("&month=5&month=6"); "" = all.
  function histMonthsParam() {
    return histMonths.slice().sort(function (a, b) { return a - b; }).map(function (m) { return "&month=" + m; }).join("");
  }
  // Historic mode shows the SAME range preview as "species at location": the
  // dashed square that follows the cursor (updateFetchArea). hideHistArea just
  // clears the placed point + disables Fetch.
  function hideHistArea() { histPoint = null; var b = document.getElementById("hist-fetch"); if (b) b.disabled = true; }
  // A map click in Historic mode only PLACES the point (a pin) — the user can
  // pan/zoom and tweak the range/radius (the cursor square shows it), then Fetch.
  function placeHistoricPoint(lat, lon) {
    histPoint = { lat: lat, lon: lon };
    setPointMarker(lat, lon);
    var b = document.getElementById("hist-fetch"); if (b) b.disabled = false;
    setStatus(t("hist.adjust"));
  }
  // Historic observations renders through renderSpeciesList (so the Probability +
  // stat columns are the model's prediction at the area centre, exactly like
  // "species at location") — only the n(d) counts and the "Map" plot come from a
  // GBIF fetch over the chosen date range. This wrapper validates the dates and
  // arms the per-search abort, then delegates.
  async function renderHistoricObs(lat, lon) {
    var from = (document.getElementById("hist-from").value || "").trim();
    var to = (document.getElementById("hist-to").value || "").trim();
    if (!from || !to) { setStatus(t("hist.needdates")); return; }
    if (from > to) { var tmp = from; from = to; to = tmp; }   // tolerate reversed range
    if (histAbort) { try { histAbort.abort(); } catch (e) {} }
    histAbort = (typeof AbortController !== "undefined") ? new AbortController() : null;
    histSightingsCache = {};   // a fresh Fetch → don't reuse a prior (possibly aborted) historic fetch
    setStatus(t("hist.searching"));
    await renderSpeciesList(lat, lon, { from: from, to: to, range: from + "," + to, months: histMonths.slice() });
  }
  async function renderSpeciesList(lat, lon, hist) {
    // `hist` (optional) = { from, to, range }: Historic-observations mode. The
    // model inference (Probability + stat columns) is identical — only the n(d)
    // counts and the map-plot come from a GBIF fetch over the historic range
    // instead of the recent all-source fetch.
    var keepScroll = keepListScroll; keepListScroll = false;   // consume one-shot flag
    currentSpView = hist
      ? { mode: "historic", lat: lat, lon: lon, from: hist.from, to: hist.to, range: hist.range, months: hist.months || [] }
      : { mode: "point", lat: lat, lon: lon };
    if (currentMode === "list") saveSession({ mode: "list", page: "species", lat: lat, lon: lon });
    var spTitle = document.getElementById("sp-title"); if (spTitle) spTitle.textContent = hist ? t("mode.historic") : t("panel.spTitle");
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
      function buildResults() {
        var r = [];
        for (var i = 0; i < labels.length; i++) {
          if (out[i] >= pmin && out[i] <= pmax && inGroup(i) && passSpeciesFilter(labels[i].key)) {
            var cval = 0;
            if (hasCompare) {
              cval = kind === "ratio" ? (cmp.probs[i] > 0 ? out[i] / cmp.probs[i] : 0)
                   : kind === "focus" ? cmp.probs[i]
                   : (out[i] - cmp.probs[i]);
            }
            r.push({ label: labels[i], prob: out[i], cmpVal: cval });
          }
        }
        r.sort(function (a, b) { return b.prob - a.prob; });
        return r;
      }
      var results = buildResults();
      // If an active species filter (★/🟡/🟠/🚫) leaves the freshly fetched list
      // empty, drop the filter so all observations show instead of a blank list.
      if (results.length === 0 && speciesListFilter !== "") {
        speciesListFilter = "";
        results = buildResults();
        var shFix = document.getElementById("sp-species-head");
        if (shFix) shFix.textContent = speciesHeadLabel();
        updateSortIndicators();
      }
      // When every comparison value is positive, show it as a probability-style
      // bar; otherwise (e.g. week-over-week change) show the value with
      // negatives in red.
      var cmpAllPositive = hasCompare && results.every(function (r) { return r.cmpVal >= 0; });
      // Probability palette is min-max stretched across the visible list (like
      // the analysis heatmap) so the strongest species reads green, weakest red.
      var pHi = results.length ? results[0].prob : 1;            // sorted desc → max first
      var pLo = results.length ? results[results.length - 1].prob : 0;
      var pRange = pHi - pLo;

      var deltaHead = document.getElementById("sp-delta-head");
      deltaHead.textContent =
        !hasCompare ? "" : kind === "focus" ? cmp.refLabel : t(kind === "ratio" ? "th.ratio" : "th.delta", { ref: cmp.refLabel });
      deltaHead.className = hasCompare ? "clickable-head" : "";   // sortable only when a stat column is shown
      // Optional second-language name column.
      var tbl = document.getElementById("species-list-table");
      tbl.classList.toggle("has-name2", !!secondLang);
      tbl.classList.toggle("hide-sci", !showSci);
      document.getElementById("sp-name2-head").textContent = secondLang ? window.GeoI18N.langByCode(secondLang).name : "";
      setCoordsWithPlace(document.getElementById("sp-coords"), lat, lon,
        t("sp.summary", { lat: lat.toFixed(4), lon: lon.toFixed(4), week: weekMonthLabel(week), n: results.length, p: (pmin * 100).toFixed(0) }) +
        " · " + t("sp.radius", { km: recentRadiusKm() }) +
        (hist ? " · " + t("hist.range") + " " + fmtDate(hist.from) + " – " + fmtDate(hist.to) +
          (hist.months && hist.months.length ? " · " + t("hist.months") + " " + hist.months.slice().sort(function (a, b) { return a - b; }).map(histMonthShort).join(", ") : "") : ""));
      document.getElementById("sp-tbody").innerHTML = results.map(function (r) {
        var cmpCell = !hasCompare ? "<td></td>" : cmpAllPositive ? cmpBarCell(kind, r.cmpVal) : deltaCell(r.cmpVal);
        var name2Cell = '<td class="name2">' + (secondLang ? escapeHtml(secondName(r.label)) : "") + '</td>';
        var dKey = escapeHtml(r.label.key);
        var pct = Math.round(r.prob * 100);
        var sortAttrs = ' data-name="' + escapeHtml(speciesName(r.label).toLowerCase()) + '" data-prob="' + r.prob + '"' + (hasCompare ? ' data-cmp="' + r.cmpVal + '"' : "");
        return '<tr' + sortAttrs + '><td>' + nameLinkHtml(r.label) + '</td>' + name2Cell + '<td class="sci">' +
               escapeHtml(r.label.sci) + '</td><td class="prob-cell"><span class="prob-num">' + pct +
               '%</span><div class="prob-bar" style="width:' + pct + '%;background:' + probHueColor(pRange > 0 ? (r.prob - pLo) / pRange : 1) + '"></div></td>' +
               '<td class="num det-nd" data-key="' + dKey + '"><span class="det-wait" title="' + escapeHtml(t("status.loadingDet")) + '"></span></td>' + cmpCell + '</tr>';
      }).join("");
      obsProgress();   // animate the loading placeholders until counts arrive
      if (speciesListSort.col) sortSpeciesList();   // apply name/prob/stat sort now (count sort re-applies once data loads)
      var sp = document.getElementById("species-panel");
      // In Species-List mode show the list as a full-screen page; in Range mode
      // keep it as an inline card under the map. Historic observations is a
      // full-screen page too.
      sp.classList.toggle("as-page", currentMode === "list" || currentMode === "historic");
      sp.style.display = "block";
      if (currentMode === "list" || currentMode === "historic") { if (!keepScroll) sp.scrollTop = 0; navOpen("page", closeAnyFullPage); }
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
      // Augment rows with detection counts + age: recent (last 30 d) for a point,
      // or over the chosen range in Historic mode (with a GBIF page-progress
      // readout in the status line so a long fetch shows activity).
      if (hist) {
        var histTok = currentSpView.range;
        // Bring back the page-based progress bar for the (potentially long) GBIF
        // range fetch. It animates (indeterminate) until the first page, then
        // fills by page; hidden once the whole fetch resolves.
        var prog = document.getElementById("sp-hist-prog");
        var fill = document.getElementById("sp-hist-prog-fill");
        if (prog) prog.style.display = "";
        if (fill) { fill.classList.add("hist-progress-indet"); fill.style.width = ""; }
        augmentRowsWithSightings(lat, lon, hist.range, function (done, total) {
          if (!currentSpView || currentSpView.range !== histTok) return;
          var f = document.getElementById("sp-hist-prog-fill");
          if (f && total > 0) { f.classList.remove("hist-progress-indet"); f.style.width = Math.min(100, Math.round(done / total * 100)) + "%"; }
          setStatus(total > 0 ? t("hist.stagePages", { done: done, total: total }) : t("hist.stageFetch"));
        }).then(function () {
          if (!currentSpView || currentSpView.range !== histTok) return;   // a newer search owns the bar
          var p = document.getElementById("sp-hist-prog"); if (p) p.style.display = "none";
        });
      } else {
        augmentRowsWithSightings(lat, lon);
      }
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

  // Put the week selector (and the map/list) back to where it was before Play.
  // `rerender` true when nothing else will re-render afterwards (explicit stop);
  // false when the caller is about to render for the restored week anyway.
  // Playback never moved the week-select control, so "restoring" is just
  // repainting the user's selected week (away from the last animated frame) and
  // dropping the progress highlight. `rerender:false` (invalidateAnimation) leaves
  // the repaint to the caller.
  function restoreAnimWeek(rerender) {
    if (!rerender) return;
    var wsel = document.getElementById("week-select");
    if (wsel) updatePlayProgress(+wsel.value || 1);
    if (currentMode === "range" || currentMode === "richness") showCachedWeek();
    rerenderPointList();
    updateLegend();
  }

  function stopAnimation() {
    animating = false;
    animateAll = false;
    if (animTimer) { clearTimeout(animTimer); animTimer = null; }
    setPlayBtn(false);
    restoreAnimWeek(true);   // return to the pre-Play week — don't leave it moved
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
    restoreAnimWeek(false);   // the caller re-renders for the restored week
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
    // Play is a preview: it must not move the user's week. Playback renders frames
    // via showCachedWeek(weekOverride) without touching week-select, so there's
    // nothing to "save/restore" — the selected week is simply repainted on stop.
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

    // Step through cached weeks. Render each frame via the override so the
    // week-select control (and the saved setting) are NOT moved during playback;
    // the user's selected week is restored visually when Play stops.
    var w = +document.getElementById("week-select").value || 1;
    (function step() {
      if (!animating) return;
      showCachedWeek(w);
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
        '<button type="button" class="dd-csv dd-csv-field ico-btn" data-pkey="' + escapeHtml(it.pkey) + '" title="' + escapeHtml(t("btn.csv")) + '">' + ico("download") + "</button>" +
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

    speciesGroup = window.GeoState.get("group", "aves");
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
    loadLists();

    var sp = window.GeoState.get("species", null);
    if (sp && labelsByKey[sp]) {
      var el = document.getElementById("species-search");
      el.dataset.selectedKey = sp;
      el.placeholder = speciesName(labelsByKey[sp]) + " (" + labelsByKey[sp].sci + ")";
    }
    updateModeVisibility();
  }

})();
