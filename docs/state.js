/**
 * Persisted UI state for the Species Distribution & Migration Explorer.
 *
 * Stores language, last mode/week/threshold, last map view, and a list of
 * user-named saved locations in localStorage so the page restores on reload.
 * Exposed as window.GeoState (no module system; loaded via <script>).
 */
window.GeoState = (function () {
  "use strict";

  var KEY = "geomodel-explorer-v1";
  var listeners = [];

  // Snapshot the persisted change-stamp at load, BEFORE this session's own init
  // writes bump it. Google Drive sync uses this to decide, on open, whether the
  // remote copy is newer than what this device last saved (init churn must not
  // make the local copy look spuriously newer than the remote).
  var bootStamp = (function () {
    try { return +(JSON.parse(localStorage.getItem(KEY) || "{}").updatedAt) || 0; }
    catch (e) { return 0; }
  })();

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function write(obj) {
    obj.updatedAt = Date.now();   // local change-stamp; orders cross-device sync writes
    try {
      localStorage.setItem(KEY, JSON.stringify(obj));
    } catch (e) {
      /* storage unavailable / quota — non-fatal */
    }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) { /* a bad listener must not break saves */ }
    }
  }

  // Merge a partial patch into the stored state.
  function save(patch) {
    var s = read();
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
    write(s);
    return s;
  }

  function get(key, fallback) {
    var s = read();
    return s[key] !== undefined ? s[key] : fallback;
  }

  function locations() {
    var s = read();
    return Array.isArray(s.locations) ? s.locations : [];
  }

  function addLocation(name, lat, lon) {
    var locs = locations();
    var id = "loc-" + Date.now();
    locs.push({ id: id, name: name, lat: lat, lon: lon });
    save({ locations: locs });
    return id;
  }

  function removeLocation(id) {
    save({ locations: locations().filter(function (l) { return l.id !== id; }) });
  }

  // Register a callback fired after every write (used by Drive sync to schedule
  // a push when local data changes).
  function onChange(cb) { if (typeof cb === "function") listeners.push(cb); }

  // The change-stamp as it was at page load (see bootStamp above).
  function bootUpdatedAt() { return bootStamp; }

  // Bump the change-stamp without altering data — for changes kept outside this
  // store (e.g. the eBird key) that should still mark local as newer for sync.
  function touch() { write(read()); }

  return {
    get: get,
    save: save,
    locations: locations,
    addLocation: addLocation,
    removeLocation: removeLocation,
    onChange: onChange,
    bootUpdatedAt: bootUpdatedAt,
    touch: touch,
  };
})();
