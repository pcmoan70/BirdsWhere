/**
 * Service worker — makes the explorer work offline once it has been opened
 * online at least once.
 *
 * Strategy by request type:
 *   - App shell (html/js/css/i18n/manifest/icon)  network-first, cache fallback
 *       → fresh code when online, full offline fallback.
 *   - Big immutable data (model, labels, taxonomy) + vendored libs  cache-first
 *       → fetched once, then served instantly offline.
 *   - Map tiles  cache-first, capped (LRU-ish FIFO trim)
 *       → visited areas stay available offline without unbounded growth.
 *   - Geocode / Overpass / species APIs  network-first, cache fallback
 *       → fresh when online, last-known answer when offline.
 *
 * Bump VERSION to invalidate all caches on the next deploy.
 */
var VERSION = "v197";
var SHELL_CACHE = "shell-" + VERSION;   // app code + small assets
var DATA_CACHE = "data-" + VERSION;     // model / labels / taxonomy / vendor libs
var TILE_CACHE = "tiles-" + VERSION;    // map tiles
var API_CACHE = "api-" + VERSION;       // geocode / overpass / species lookups
var MAX_TILES = 11000;                  // normal (LRU) tile cache cap (~250 MB at ~22 KB/tile)
var PINNED_PREFIX = "pinned-";          // explicitly downloaded offline areas (never auto-purged)

// Precached on install so the very next (possibly offline) load has the shell.
var SHELL = [
  "./",
  "index.html",
  "app.js",
  "app.css",
  "analysis.js",
  "state.js",
  "gdrive-sync.js",
  "i18n/strings.js",
  "manifest.webmanifest",
  "icon.svg",
  "vendor/leaflet/leaflet.css",
  "vendor/leaflet/leaflet.js",
  "vendor/h3-js.js",
  "vendor/leaflet/images/marker-icon.png",
  "vendor/leaflet/images/marker-icon-2x.png",
  "vendor/leaflet/images/marker-shadow.png",
  "vendor/leaflet/images/layers.png",
  "vendor/leaflet/images/layers-2x.png",
];

// Large files + inference runtime: cache-first, but precache too so a fully
// offline first reload can still run inference (worth the one-time download
// the user already accepted by choosing "full offline").
var DATA = [
  "inference-worker.js",
  "geomodel_fp16.onnx",
  "labels.txt",
  "taxonomy.csv",
  "vendor/ort/ort.wasm.min.js",
  "vendor/ort/ort-wasm-simd-threaded.mjs.js",
  "vendor/ort/ort-wasm-simd-threaded.wasm",
];

var TILE_HOSTS = /(\.basemaps\.cartocdn\.com|\.tile\.openstreetmap\.org|\.tile\.opentopomap\.org|server\.arcgisonline\.com|data-gis\.unep-wcmc\.org|bio\.discomap\.eea\.europa\.eu)/;
var API_HOSTS = /(nominatim\.openstreetmap\.org|overpass-api\.de|api\.inaturalist\.org|api\.gbif\.org|api\.ebird\.org|wikipedia\.org|wikidata\.org|wikimedia\.org)/;

self.addEventListener("install", function (event) {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then(function (c) {
        return c.addAll(SHELL.map(reload));
      }),
      // Data files are big; tolerate individual failures so install still
      // succeeds (they fall back to runtime caching on first use).
      caches.open(DATA_CACHE).then(function (c) {
        return Promise.all(
          DATA.map(function (u) {
            return c.add(reload(u)).catch(function () {});
          })
        );
      }),
    ]).then(function () {
      return self.skipWaiting();
    })
  );
});

function reload(url) {
  return new Request(url, { cache: "reload" });
}

self.addEventListener("activate", function (event) {
  var keep = [SHELL_CACHE, DATA_CACHE, TILE_CACHE, API_CACHE];
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names.map(function (n) {
            // Keep current caches and all pinned offline areas (version-independent).
            if (keep.indexOf(n) === -1 && n.indexOf(PINNED_PREFIX) !== 0) return caches.delete(n);
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;

  if (TILE_HOSTS.test(url.hostname)) {
    // ArcGIS "identify"/"query" calls share the tile hosts but are tiny,
    // position-specific JSON — don't let them fill (and evict) the tile cache.
    if (/\/(identify|query|find)/i.test(url.pathname)) return;
    event.respondWith(tileResponse(req));
    return;
  }
  if (API_HOSTS.test(url.hostname)) {
    event.respondWith(networkFirst(req, API_CACHE));
    return;
  }
  if (sameOrigin) {
    if (/\.(onnx|csv|wasm|mjs)$/.test(url.pathname) ||
        /\/vendor\//.test(url.pathname) ||
        /labels\.txt$/.test(url.pathname) ||
        /inference-worker\.js$/.test(url.pathname)) {
      event.respondWith(cacheFirst(req, DATA_CACHE));
    } else {
      event.respondWith(networkFirst(req, SHELL_CACHE));
    }
    return;
  }
  // Other cross-origin (e.g. fonts): try network, fall back to any cache.
  event.respondWith(
    fetch(req).catch(function () {
      return caches.match(req);
    })
  );
});

function cacheFirst(req, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () {
        // Offline and not in this cache — fall back to any other cache. The
        // Leaflet marker/layer images are precached in the shell, so this is
        // what lets markers and icons render offline before they were ever
        // fetched into the data cache.
        return caches.match(req);
      });
    });
  });
}

function networkFirst(req, cacheName) {
  // Bypass the browser HTTP cache for the network attempt ("no-store") so a
  // fresh deploy is picked up immediately — GitHub Pages' max-age would
  // otherwise let the SW serve a stale copy even though we try the network
  // first. We keep our own copy in CacheStorage for the offline fallback.
  // Build from the Request (not just its URL) so request headers — e.g. the
  // eBird X-eBirdApiToken — are preserved on the network attempt.
  return caches.open(cacheName).then(function (cache) {
    return fetch(new Request(req, { cache: "no-store" }))
      .then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(function () {
        return cache.match(req);
      });
  });
}

// Tile request: serve from a pinned offline-area cache if present (never
// purged), otherwise the normal LRU tile cache.
function tileResponse(req) {
  return caches.keys().then(function (names) {
    var pinned = names.filter(function (n) { return n.indexOf(PINNED_PREFIX) === 0; });
    return (function tryPinned(i) {
      if (i >= pinned.length) return null;
      return caches.open(pinned[i]).then(function (c) { return c.match(req); })
        .then(function (hit) { return hit || tryPinned(i + 1); });
    })(0);
  }).then(function (pinnedHit) {
    if (pinnedHit) return pinnedHit;
    return cacheFirstCapped(req, TILE_CACHE, MAX_TILES);
  });
}

// Cache-first with an LRU cap: a hit is re-stored (moved to most-recent) so a
// revisit refreshes its timestamp; a stored miss trims the oldest back to cap.
function cacheFirstCapped(req, cacheName, max) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(req).then(function (hit) {
      if (hit) {
        var fresh = hit.clone();
        cache.delete(req).then(function () { cache.put(req, fresh); });   // re-stamp (LRU)
        return hit;
      }
      return fetch(req).then(function (res) {
        if (res && (res.ok || res.type === "opaque")) {
          cache.put(req, res.clone()).then(function () {
            trim(cache, max);
          });
        }
        return res;
      });
    });
  });
}

function trim(cache, max) {
  cache.keys().then(function (keys) {
    if (keys.length <= max) return;
    var excess = keys.length - max;
    for (var i = 0; i < excess; i++) cache.delete(keys[i]);
  });
}
