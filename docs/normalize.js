/**
 * Source record normalisation (part of the "fetching layer").
 *
 * Extracted from app.js. Each observation source (eBird / GBIF / iNaturalist /
 * Artsobservasjoner / Artportalen / Laji.fi) returns its own JSON shape; these
 * pure functions map every source onto ONE uniform record shape that the
 * AppAggregate layer then matches to model species:
 *   { src, speciesCode, sciName, comName, family, cls, kingdom, lat, lon,
 *     date, dt, url, origin, place, observer, count, act, note, noFuzzy }
 *
 * Revealing module (same pattern as GeoState / AppAggregate). Everything here is
 * a pure transform — no DOM, no network, no GeoState, no app state — so it needs
 * no init() and loads before app.js. The raw HTTP fetch adapters that PRODUCE
 * these arrays still live in app.js (they're coupled to source config / geo);
 * app.js pipes their output through AppNormalize.norm*().
 *
 * Exposes: normClass + normEbird / normInat / normGbif / normArtsobs /
 * normArtportalen / normLaji.
 */
window.AppNormalize = (function () {
  "use strict";

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
  // Plants and fungi carry obscure class names (Magnoliopsida, Agaricomycetes, …)
  // that normClass can't all enumerate — but the KINGDOM is a clean signal. When
  // the record's kingdom is Plantae/Fungi, classify by that so the group filter
  // (which compares against "plantae"/"fungi") keeps them; else fall back to class.
  function classOrKingdom(className, kingdom) {
    var kk = String(kingdom || "").toLowerCase();
    if (/^plant/.test(kk)) return "Plantae";
    if (/^fung/.test(kk)) return "Fungi";
    return normClass(className);
  }
  // Norwegian Artsdatabanken (Artsobservasjoner) records the HOODED Crow — by far the
  // common Scandinavian crow, vernacular "kråke" — under the binomial "Corvus corone".
  // Internationally, and in the model, that name is the CARRION Crow ("svartkråke",
  // genuinely scarce in Norway). Uncorrected, every kråke exact-matches svartkråke and
  // inflates it massively.
  function isCoroneName(sn) { return /^\s*corvus corone\s*$/i.test(String(sn || "")); }
  // Direct Artsobservasjoner: the Norwegian vernacular disambiguates precisely —
  // "kråke" → Hooded (Corvus cornix); "svartkråke" (and anything else) keeps its name.
  function fixNorwegianSci(sn, name) {
    if (isCoroneName(sn) && String(name || "").trim().toLowerCase() === "kråke") return "Corvus cornix";
    return sn;
  }
  // GBIF's Norway "Corvus corone" is ~94% Artsobservasjoner's kråke (Hooded Crow filed
  // under the lumped name) republished via GBIF; Carrion Crow is a Norwegian rarity. No
  // vernacular is carried here, so fold ALL Norwegian "Corvus corone" to Corvus cornix
  // — stops the svartkråke inflation and lets it dedup with the direct Artsobs copy.
  // (Genuine NO Carrion Crows fold in too — an accepted trade-off; SE/DK are untouched,
  // where Carrion Crow is real.)
  function fixGbifNordicCrow(sn, countryCode) {
    if (isCoroneName(sn) && String(countryCode || "").toUpperCase() === "NO") return "Corvus cornix";
    return sn;
  }

  // ---- Uniform observation sources ------------------------------------------
  // Every source is normalised to one record shape so a single aggregator maps
  // them to model species / extras. A record is:
  //   { src, speciesCode, sciName, comName, family, cls, lat, lon, date, dt, url, origin, place }
  function inatLatLon(o) {
    if (o.geojson && o.geojson.coordinates) return { lat: +o.geojson.coordinates[1], lon: +o.geojson.coordinates[0] };
    if (o.location) { var pr = String(o.location).split(","); return { lat: parseFloat(pr[0]), lon: parseFloat(pr[1]) }; }
    return { lat: null, lon: null };
  }
  function normEbird(arr) {
    return (arr || []).map(function (o) {
      return { src: "eBird", speciesCode: o.speciesCode || "", sciName: o.sciName || "", comName: o.comName || "", family: "", cls: "Aves",
        lat: o.lat != null ? +o.lat : null, lon: o.lng != null ? +o.lng : null, date: (o.obsDt || "").slice(0, 10), dt: o.obsDt || "",
        url: o.subId ? "https://ebird.org/checklist/" + o.subId : "", origin: "", place: o.locName || "", observer: o.userDisplayName || "", count: o.howMany != null ? o.howMany : "" };
    });
  }
  function normInat(arr) {
    var out = [];
    (arr || []).forEach(function (o) {
      var tax = o.taxon || {}, rank = String(tax.rank || "").toLowerCase();
      if (rank && rank !== "species" && rank !== "subspecies" && rank !== "variety" && rank !== "form") return;
      var sn = tax.name; if (!sn || !/\s/.test(sn)) return;
      var ll = inatLatLon(o);
      out.push({ src: "iNaturalist", speciesCode: "", sciName: sn, comName: tax.preferred_common_name || "", family: "", cls: normClass(tax.iconic_taxon_name),
        lat: isFinite(ll.lat) ? ll.lat : null, lon: isFinite(ll.lon) ? ll.lon : null, date: o.observed_on || (o.time_observed_at || "").slice(0, 10), dt: o.time_observed_at || o.observed_on || "",
        url: o.id ? "https://www.inaturalist.org/observations/" + o.id : "", origin: "", place: o.place_guess || "", observer: (o.user && (o.user.login || o.user.name)) || "", count: "", note: o.description || "" });
    });
    return out;
  }
  // GBIF's recordedBy for a multi-observer record is either an array or a single
  // string. The app splits observers on "|"/";" (not "," — that appears inside
  // "Last, First" names), so join arrays with " | ". Artportalen (via GBIF) instead
  // publishes co-observers as a COMMA-separated string; convert those to the same
  // "|" convention so each observer splits out — enabling per-observer filtering and
  // adding individuals to observer lists.
  function gbifObserver(o) {
    var rb = Array.isArray(o.recordedBy) ? o.recordedBy.filter(Boolean).join(" | ") : String(o.recordedBy || "");
    if (/artportalen/i.test(o.datasetName || "") && rb.indexOf("|") < 0) rb = rb.split(/\s*,\s*/).filter(Boolean).join(" | ");
    return rb;
  }
  function normGbif(arr) {
    var out = [];
    (arr || []).forEach(function (o) {
      // Drop higher-rank identifications (ORDER/FAMILY/GENUS) and strip the author
      // citation GBIF appends; only species-level binomials become rows.
      var rank = String(o.taxonRank || "").toUpperCase();
      if (rank && rank !== "SPECIES" && rank !== "SUBSPECIES" && rank !== "VARIETY" && rank !== "FORM") return;
      var sn = o.species || o.scientificName; if (!sn) return;
      sn = sn.replace(/\s+\([^)]*\)\s*/g, " ").replace(/,\s*\d{4}.*$/, "").trim();
      if (!/\s/.test(sn)) return;
      sn = fixGbifNordicCrow(sn, o.countryCode);   // NO "Corvus corone" is Artsobs' kråke → Corvus cornix
      // Never let a dataset/source title masquerade as the common name: some GBIF
      // records carry vernacularName == the dataset (e.g. "iNaturalist research-
      // grade observations"), which would otherwise show as the species name.
      var vn = o.vernacularName || "";
      if (vn && (/research-grade observation|observation dataset/i.test(vn) || (o.datasetName && vn.toLowerCase() === String(o.datasetName).toLowerCase()))) vn = "";
      out.push({ src: "GBIF", speciesCode: "", sciName: sn, comName: vn, family: o.family || "", cls: classOrKingdom(o.class, o.kingdom), kingdom: o.kingdom || "",
        lat: o.decimalLatitude != null ? +o.decimalLatitude : null, lon: o.decimalLongitude != null ? +o.decimalLongitude : null,
        date: (o.eventDate || "").slice(0, 10), dt: o.eventDate || "", url: o.key ? "https://www.gbif.org/occurrence/" + o.key : "", origin: o.datasetName || "", place: o.locality || "",
        observer: gbifObserver(o), count: o.individualCount != null ? o.individualCount : "",
        act: o.behavior || "", note: o.occurrenceRemarks || "" });
    });
    return out;
  }
  // Artsobs link → the observation RECORD, not a photo. The API's DetailUrl is the
  // sighting page only when the record has no media; with a photo it points at the
  // image file (…/MediaLibrary/…image.jpg). The sighting id (= CatalogNumber) is
  // stable, so build the record URL from it and fall back to the Artskart feature
  // link for non-Artsobservasjoner institutions.
  function artsobsUrl(o) {
    var d = String(o.DetailUrl || ""), m = d.match(/\/sighting\/(\d+)/i);
    var id = m ? m[1] : (/artsobservasjoner\.no/i.test(d) && /^\d+$/.test(String(o.CatalogNumber || "")) ? String(o.CatalogNumber) : "");
    if (id) return "https://mobil.artsobservasjoner.no/sighting/" + id;
    // Fallback is an API-supplied URL — only pass an http(s) one through (never a
    // javascript:/data: scheme, since it ends up in an href).
    var fb = o.ObsUrl || d || "";
    return /^https?:\/\//i.test(fb) ? fb : "";
  }
  function normArtsobs(obj) {
    var out = [];
    ((obj && obj.Observations) || []).forEach(function (o) {
      var sn = o.ScientificName; if (!sn || !/\s/.test(sn)) return;
      sn = fixNorwegianSci(sn, o.Name);   // kråke is filed under "Corvus corone" here — remap to Corvus cornix
      // Coordinates are WGS84 but decimal-comma strings; dates are dd.mm.yyyy.
      var la = parseFloat(String(o.Latitude || "").replace(",", ".")), lo = parseFloat(String(o.Longitude || "").replace(",", "."));
      var dm = String(o.CollectedDate || "").match(/(\d{2})\.(\d{2})\.(\d{4})/), date = dm ? (dm[3] + "-" + dm[2] + "-" + dm[1]) : "";
      out.push({ src: "Artsobs", speciesCode: "", sciName: sn, comName: o.Name || "", family: o.family || "", cls: classOrKingdom(o.klass || o.Klass || o["class"], o.kingdom || o.Kingdom), kingdom: o.kingdom || o.Kingdom || "",
        lat: isFinite(la) ? la : null, lon: isFinite(lo) ? lo : null, date: date, dt: date,
        url: artsobsUrl(o), origin: "", place: o.Municipality || o.County || "", observer: o.Collector || "", count: o.Count != null ? o.Count : "",
        act: o.Activity || o.ActivityName || o.activity || "", note: o.Comment || o.Note || o.comment || "" });
    });
    return out;
  }
  function normArtportalen(arr) {
    var out = [];
    (arr || []).forEach(function (o) {
      var tax = o.taxon || {}, loc = o.location || {}, ev = o.event || {};
      var sn = tax.scientificName; if (!sn || !/\s/.test(sn)) return;
      var oid = String((o.occurrence && o.occurrence.occurrenceId) || ""), m = oid.match(/[Ss]ighting[:\/](\d+)/);
      out.push({ src: "Artportalen", speciesCode: "", sciName: sn, comName: tax.vernacularName || "", family: tax.family || "", cls: classOrKingdom(tax["class"], tax.kingdom), kingdom: tax.kingdom || "",
        lat: loc.decimalLatitude != null ? +loc.decimalLatitude : null, lon: loc.decimalLongitude != null ? +loc.decimalLongitude : null,
        date: (ev.startDate || "").slice(0, 10), dt: ev.startDate || "", url: m ? "https://www.artportalen.se/sighting/" + m[1] : "", origin: "", place: loc.locality || loc.municipality || "",
        observer: (o.occurrence && o.occurrence.recordedBy) || "", count: (o.occurrence && o.occurrence.individualCount != null) ? o.occurrence.individualCount : "",
        act: (o.occurrence && o.occurrence.activity && (o.occurrence.activity.value || o.occurrence.activity)) || "",
        note: (o.occurrence && o.occurrence.occurrenceRemarks) || "" });
    });
    return out;
  }
  // FinBIF "Birds" informal-taxon-group and its sub-groups (Birds of prey, Owls,
  // Waterbirds…). A taxon may carry the broad group or only a leaf, so we test
  // membership against the whole set.
  var LAJI_BIRD_GROUPS = { "MVL.1": 1, "MVL.1141": 1, "MVL.1161": 1, "MVL.1162": 1, "MVL.1241": 1 };
  function normLaji(arr) {
    var out = [];
    (arr || []).forEach(function (ft) {
      var p = ft.properties || {}, coords = ft.geometry && ft.geometry.coordinates;
      while (Array.isArray(coords) && Array.isArray(coords[0])) coords = coords[0];   // Point, or first vertex of a polygon
      var lon = coords && coords[0], la = coords && coords[1];
      var sn = p["unit.linkings.taxon.scientificName"]; if (!sn || !/\s/.test(sn)) return;
      var com = p["unit.linkings.taxon.nameEnglish"] || p["unit.linkings.taxon.nameFinnish"] || "";
      var cnt = p["unit.interpretations.individualCount"];
      var dm = String(p["gathering.displayDateTime"] || "").match(/\d{4}-\d{2}-\d{2}/);
      var doc = p["document.documentId"] || "";
      // Classify from FinBIF's own taxonomy: the informal-taxon-group set marks Aves
      // for the birds-only path. Non-birds get a BLANK class (not "Other") — a blank
      // class is KEPT by the aggregator's group filter, and since Laji is noFuzzy the
      // EXACT scientific-name match to a model species (which carries the real class)
      // decides. Emitting "Other" here dropped every mammal/amphibian/insect in the
      // matching group (they can never equal Mammalia/Amphibia/Insecta).
      var groups = p["unit.linkings.taxon.informalTaxonGroups"];
      var gtext = Array.isArray(groups) ? groups.join(",") : String(groups || "");
      var isBird = (gtext.match(/MVL\.\d+/g) || []).some(function (id) { return LAJI_BIRD_GROUPS[id]; });
      var lajiKingdom = p["unit.linkings.taxon.kingdomScientificName"] || "";
      out.push({ src: "Laji.fi", speciesCode: "", sciName: sn, comName: com, family: "",
        cls: isBird ? "Aves" : classOrKingdom("", lajiKingdom), kingdom: lajiKingdom, noFuzzy: true,
        lat: la != null ? +la : null, lon: lon != null ? +lon : null,
        date: dm ? dm[0] : "", dt: dm ? dm[0] : "",
        url: doc ? "https://laji.fi/view?uri=" + encodeURIComponent(doc) : "",
        origin: "", place: p["gathering.locality"] || "", observer: "", count: (cnt != null ? cnt : ""), note: "" });
    });
    return out;
  }
  // BirdWeather GraphQL detection nodes → one "present" record per species +
  // station + calendar day (the "is here" aggregation). BirdWeather runs BirdNET,
  // so scientific names align with the model's labels; these are AI acoustic IDs,
  // not human-verified. Each daily record carries the detection COUNT (shown as
  // ×N), the station name + #id, and a link to that station's page on BirdWeather
  // (the source data, scoped to the station). Many detections collapse to one dot.
  function normBirdweather(nodes, minDet, minConf) {
    if (!Array.isArray(nodes)) return [];
    minDet = (minDet > 0) ? minDet : 1;          // min confident detections/day to count as "present"
    minConf = (minConf > 0) ? minConf : 0;       // confidence floor — only count detections "above threshold"
    var byKey = Object.create(null);
    for (var i = 0; i < nodes.length; i++) {
      var d = nodes[i]; if (!d || !d.species) continue;
      if (minConf && d.confidence != null && d.confidence < minConf) continue;   // below the probability threshold → ignore
      var sn = d.species.scientificName || ""; if (!sn) continue;
      var co = d.coords || {}; if (co.lat == null || co.lon == null) continue;
      var ts = d.timestamp || "";
      var day = String(ts).slice(0, 10);
      var sid = (d.station && d.station.id) || "";
      var stn = (d.station && d.station.name) || "";
      var k = sn + "|" + (sid || stn) + "|" + day;
      var rec = byKey[k];
      if (!rec) {
        rec = byKey[k] = { src: "BirdWeather", speciesCode: "", sciName: sn, comName: d.species.commonName || "",
          family: "", cls: "Aves", kingdom: "", lat: +co.lat, lon: +co.lon,   // BirdWeather = BirdNET acoustic = birds
          date: day, dt: ts,
          url: sid ? "https://app.birdweather.com/stations/" + encodeURIComponent(sid) : "",   // source data: the station's BirdWeather page
          origin: "BirdNET acoustic", place: stn + (sid ? (stn ? " · " : "Station ") + "#" + sid : ""),   // name + station ID
          observer: "", count: 0, act: "", note: "", n: 0 };
      }
      rec.n++;
      if (ts > rec.dt) rec.dt = ts;   // latest detection that day (ISO strings sort lexically)
    }
    var out = [];
    for (var key in byKey) {
      var r = byKey[key];
      if (r.n < minDet) continue;   // too few confident detections that day → not "here"
      r.count = r.n;                // detection count → shown as "×N" beside the source
      delete r.n;
      out.push(r);                  // note left empty: no sub-line under the species name
    }
    return out;
  }

  return {
    normClass: normClass,
    normEbird: normEbird,
    normInat: normInat,
    normGbif: normGbif,
    normArtsobs: normArtsobs,
    normArtportalen: normArtportalen,
    normLaji: normLaji,
    normBirdweather: normBirdweather,
  };
})();
