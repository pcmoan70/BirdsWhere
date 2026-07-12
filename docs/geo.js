/**
 * Country / geo subsystem.
 *
 * Fourth modularisation step. Reverse-geocodes a point to its country
 * (Nominatim, cached), loads the bundled simplified country borders, and answers
 * "should a country-scoped source run at this point?" (countryMatch) via
 * polygon-in-box tests, with a Nordic bounding-box fallback until the borders
 * load (offline first run).
 *
 * Revealing module. The only thing it needs from app.js is a callback to run
 * when the borders finish loading (app.js clears its sightings cache then, since
 * gating just got more accurate) - injected via AppGeo.init({ onBordersLoaded }),
 * which also kicks off the one-time border load.
 *
 * Exposes: countryInfo, countryCode, countryMatch (app.js + AppFetch use these).
 */
window.AppGeo = (function () {
  "use strict";

  var onBordersLoaded = function () {};
  function init(deps) {
    deps = deps || {};
    if (deps.onBordersLoaded) onBordersLoaded = deps.onBordersLoaded;
    loadBorders();
  }

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
  // A precise place name for a point (finer than commune/municipality): the primary
  // named feature, else the finest locality — never the municipality/county/state.
  // Cached by ~10 m so repeated popups don't re-hit Nominatim. "" if none resolves.
  var placeCache = {};
  function placeName(lat, lon) {
    var k = (+lat).toFixed(4) + "," + (+lon).toFixed(4);
    if (placeCache[k] !== undefined) return Promise.resolve(placeCache[k]);
    return fetch("https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&addressdetails=1&accept-language=en&lat=" + lat + "&lon=" + lon, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var name = "";
        if (j) {
          var a = j.address || {};
          // Admin levels that are too coarse (commune and up) — never use these.
          var coarse = [a.municipality, a.county, a.state, a.state_district, a.region, a.province, a.country]
            .filter(Boolean).map(String);
          var fine = a.natural || a.water || a.bay || a.peak || a.wetland || a.wood ||
            a.leisure || a.tourism || a.building || a.road || a.hamlet || a.isolated_dwelling ||
            a.neighbourhood || a.suburb || a.quarter || a.village || a.town || a.city_district || a.city || "";
          name = j.name || "";
          if (name && coarse.indexOf(name) >= 0) name = "";   // j.name is just the commune → not precise enough
          if (!name) name = fine;
          if (name && coarse.indexOf(name) >= 0) name = "";   // finest we found is still commune-level → give up
        }
        placeCache[k] = name; return name;
      })
      .catch(function () { placeCache[k] = ""; return ""; });
  }
  // National-database gate. Norway and Sweden sit side by side, so a longitude
  // line approximates their border far better than overlapping rectangles: NO is
  // west of it, SE east. The border longitude rises with latitude (~11.4°E at
  // 59°N to ~20.5°E at the NO/SE/FI tripoint). `marginKm` (the search radius)
  // widens the zone, so a point whose radius reaches the other side queries both.
  function noSeBorderLon(lat) { return 11.4 + 0.91 * (lat - 59); }
  function nearCountry(lat, lon, cc, marginKm) {
    var mk = marginKm || 0, dLat = mk / 111, dLon = mk / ((111 * Math.cos(lat * Math.PI / 180)) || 1);
    var bl = noSeBorderLon(lat);
    if (cc === "NO") return lat >= 57.5 - dLat && lat <= 71.5 + dLat && lon >= 3.5 - dLon && lon <= bl + dLon;
    if (cc === "SE") return lat >= 55.0 - dLat && lat <= 69.3 + dLat && lon >= bl - dLon && lon <= 24.6 + dLon;
    // Finland and Denmark are box-bounded (no shared land border to split).
    if (cc === "FI") return lat >= 59.5 - dLat && lat <= 70.2 + dLat && lon >= 19.0 - dLon && lon <= 31.7 + dLon;
    if (cc === "DK") return lat >= 54.4 - dLat && lat <= 57.9 + dLat && lon >= 7.9 - dLon && lon <= 15.3 + dLon;
    return false;
  }
  // Should a source/dataset scoped to country `sourceCC` run at this point?
  //   - no country → global, always;
  //   - the reverse-geocoded country (`cc`) matches → yes (accurate, worldwide);
  //   - else the search radius reaches the country's box → yes (covers borders,
  //     and is the only signal when `cc` is unknown, e.g. offline).
  // Bundled simplified country borders (ISO-2 → { b:[bbox], r:[flat rings] }),
  // loaded once. Lets us tell which countries a search circle actually touches
  // — accurate worldwide, replacing the Nordic-only bounding boxes.
  var BORDERS = null;
  // Bundled simplified country borders loaded once (countries-lite.json). On
  // arrival it fires onBordersLoaded so app.js can invalidate its sightings
  // cache (country-gating just became more accurate). Kicked off by init().
  function loadBorders() {
    try {
      fetch("countries-lite.json").then(function (r) { return r.ok ? r.json() : null; })
        .then(function (b) { if (b) { BORDERS = b; onBordersLoaded(); } })
        .catch(function () {});
    } catch (e) {}
  }
  // Ray-casting point-in-polygon against a flat [lon,lat,lon,lat,…] ring.
  // NOTE: distinct from the overlay pointInRing() (arrays of [lon,lat] pairs)
  // defined later — they used to share the name "pointInRing", and JS hoisting
  // silently let the later one shadow this one, so countryAt was running the
  // wrong implementation on flat border rings (always returned ""). Renamed.
  function pointInRingFlat(lon, lat, f) {
    var inside = false, n = f.length / 2;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = f[2 * i], yi = f[2 * i + 1], xj = f[2 * j], yj = f[2 * j + 1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function countryAt(lat, lon) {
    if (!BORDERS) return "";
    for (var cc in BORDERS) {
      var c = BORDERS[cc], b = c.b;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;   // bbox reject
      for (var ri = 0; ri < c.r.length; ri++) if (pointInRingFlat(lon, lat, c.r[ri])) return cc;
    }
    return "";
  }
  // Every country the queried AREA touches — the centre's reverse-geocoded
  // country plus any whose territory the search box (±rkm, the same box the
  // fetches use) overlaps, so a search straddling a land border (e.g. Norway ↔
  // Sweden) queries both countries' native databases. Tests the real box — a
  // 5×5 grid over it (incl. corners, which reach ~41% further than an rkm
  // circle) plus any country border that merely passes through the box.
  // Memoised per location+radius.
  var nearCountryCache = {};
  function nearbyCountries(lat, lon, rkm, cc) {
    var k = lat.toFixed(2) + "," + lon.toFixed(2) + ":" + rkm + ":" + (cc || "");
    if (nearCountryCache[k]) return nearCountryCache[k];
    var set = Object.create(null);
    if (cc) set[cc] = 1;
    if (BORDERS) {
      var cos = Math.cos(lat * Math.PI / 180);
      var dLat = rkm / 111.32, dLon = rkm / (111.32 * (cos > 0.01 ? cos : 0.01));
      var s = lat - dLat, n = lat + dLat, w = lon - dLon, e = lon + dLon;   // the queried box
      // (a) which country each grid point (corners, edges, interior) falls in.
      for (var gy = 0; gy <= 4; gy++) {
        var py = s + (n - s) * gy / 4;
        for (var gx = 0; gx <= 4; gx++) {
          var c2 = countryAt(py, w + (e - w) * gx / 4);
          if (c2) set[c2] = 1;
        }
      }
      // (b) a country whose border passes through the box but whose sliver
      // contained no grid point (a ring vertex sitting inside the box).
      for (var ccx in BORDERS) {
        if (set[ccx]) continue;
        var c = BORDERS[ccx], b = c.b;
        if (b[2] < w || b[0] > e || b[3] < s || b[1] > n) continue;   // bbox no-overlap
        for (var ri = 0; ri < c.r.length && !set[ccx]; ri++) {
          var f = c.r[ri];
          for (var vi = 0; vi < f.length; vi += 2) {
            if (f[vi] >= w && f[vi] <= e && f[vi + 1] >= s && f[vi + 1] <= n) { set[ccx] = 1; break; }
          }
        }
      }
    }
    nearCountryCache[k] = set; return set;
  }
  function countryMatch(lat, lon, sourceCC, rkm, cc) {
    if (!sourceCC) return true;
    if (cc && cc === sourceCC) return true;
    // Polygon-based when borders are loaded (accurate worldwide); the Nordic
    // bounding boxes remain the fallback until they are (offline first load).
    if (BORDERS) return !!nearbyCountries(lat, lon, rkm, cc)[sourceCC];
    return nearCountry(lat, lon, sourceCC, rkm);
  }


  return {
    init: init,
    countryInfo: countryInfo,
    countryCode: countryCode,
    placeName: placeName,
    countryMatch: countryMatch,
  };
})();
