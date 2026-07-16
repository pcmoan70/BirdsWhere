# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An interactive, **100% in-browser** explorer of species distribution, migration, and live observations ("Species & Checklists"). The BirdNET Geomodel (12,012 species) runs client-side via ONNX Runtime Web — no server, no backend, no API of our own. On top of the model it overlays live observations pulled directly from third-party APIs (eBird / GBIF / iNaturalist / Artsobservasjoner / Artportalen / Laji.fi).

## Build / run / deploy

There is **no build step, no framework, no npm, no bundler**. Everything is hand-written ES5-style vanilla JS loaded via `<script>` tags. There are **no automated tests** in this repo.

```bash
# Run locally — static site, but a server is required (Web Worker + fetch; file:// fails)
cd docs && python -m http.server 8000   # → http://localhost:8000
```

**Deploy = `git push` to `main`.** GitHub Pages serves the `docs/` folder of `main` directly, so any push to `main` publishes the live site at `https://pcmoan70.github.io/migration_calendar/`. There is no CI/build between commit and production — treat every push to `main` as a deploy.

### Two things that MUST happen on a user-visible change

1. **Bump `VERSION` in `docs/sw.js`** (currently `v460`). The service worker caches the app shell; without a version bump, returning users keep serving the **stale cached** HTML/JS/CSS and never see your change. This is the single most common deploy footgun here.
2. **`docs/last-change.txt`** is auto-stamped by `.githooks/pre-commit` on every commit (shown as "Last change" in the footer). Note `core.hooksPath` is **not** currently set — if the stamp isn't updating, wire it with `git config core.hooksPath .githooks`.

## Architecture

### Loading & module pattern
`docs/index.html` is the only HTML. It loads scripts in a **deliberate dependency order** (i18n → state → idb → gdrive-sync → analysis → sources → geo → fetch → normalize → aggregate → vendor libs → `app.js`). Order matters — everything is global, there are no imports.

Each non-app module is a **revealing module** exposing one global (`window.AppSources`, `window.AppFetch`, `window.AppNormalize`, `window.AppAggregate`, `window.AppGeo`, `window.GeoState`, `window.AppIDB`, `window.GeoAnalysis`, `window.GeoI18N`, `window.GDriveSync`). `app.js` is the orchestrator that **owns the model data and all UI state**, and injects live accessors into the other modules via `Module.init({ ...callbacks })`. The split was done by extracting code out of `app.js` *byte-for-byte*, so injected locals keep the same names they had inside the monolith — preserve that when editing.

### Key files (`docs/`)
- **`app.js`** (~11k lines) — the whole interactive app: Leaflet map, the modes (Range / Richness / Species List / analysis), all controls/settings UI, inference orchestration, the raw HTTP fetch adapters' *callers*, and `window.AppData` (the Drive sync payload build/merge). Owns model `labels`, `taxByCode`, the family-colour index, and the sightings cache. Most work happens here.
- **`inference-worker.js`** — ONNX Runtime Web in a Web Worker. Input `(batch, 3) = [lat, lon, week 1–48]`, output `(batch, nSpecies)` sigmoid. Reduces output **inside the worker** by `task`: `"raw"`, `"column"` (one species), `"richness"` (count ≥ threshold, optional group mask) — so only small arrays cross back to the UI thread.
- **Data layer (pipeline):** `sources.js` (which sources/datasets/keys are enabled, GeoState-backed config) → `fetch.js` (`AppFetch`: GBIF helpers + per-source HTTP adapters) → `normalize.js` (`AppNormalize`: each source's JSON → one uniform record shape) → `aggregate.js` (`AppAggregate`: match records to model species via a sci/common-name index).
- **`geo.js`** (`AppGeo`) — reverse-geocode a point to a country (Nominatim, cached) and gate country-scoped sources via bundled simplified borders (`countries-lite.json`).
- **`state.js`** (`GeoState`) — localStorage persistence (`geomodel-explorer-v1`), with an in-memory write-through cache and a quota-trim hook. **`idb.js`** (`AppIDB`) — tiny IndexedDB key/value store for bulky per-list data (saved trips, detections) that would blow the ~5 MB localStorage cap; hydrated into memory once at boot so synchronous GeoState callers are unchanged.
- **`gdrive-sync.js`** (`GDriveSync`) — optional, **manual one-shot** sync via the Drive `appdata` folder (OAuth token model, token dropped after each sync). Transport/auth only; payload build + merge live in `app.js`'s `AppData`.
- **`analysis.js`** (`GeoAnalysis`) — stateless renderers for the location-analysis views (Probability / Arrivals / Scatter) from a single 48-week prediction.
- **`i18n/strings.js`** (`GeoI18N`) — UI strings (en, sv) + the language↔`taxonomy.csv` column map. Species common names come from `taxonomy.csv` (~30 languages, joined to `labels.txt` by `species_code`).
- **`sw.js`** — service worker. Per-type cache strategy; app shell is **cache-first** (served from the device, never re-downloaded while online — fresh code only on a `VERSION` bump, which makes bumping mandatory), model/labels/taxonomy and vendor libs are **cache-first**. Map tiles + the app's computed range-data share one version-independent LRU pool (`map-pool`).

### Model assets (`docs/`, large, redistributed)
`geomodel_fp16.onnx` (FP16 weights, CC BY-SA 4.0), `labels.txt` (output-index → species), `taxonomy.csv` (multilingual names). Vendored libs under `docs/vendor/` (ORT wasm, Leaflet, h3-js) so the app runs fully offline once cached.

## Conventions
- **Vanilla ES5-style JS** (`var`, IIFEs, no transpile) to match the existing code. No new dependencies or build tooling.
- Keep changes surgical (see the global CLAUDE.md §2). The modularisation deliberately mirrors the old monolith — don't rename injected accessors or reorder the `index.html` script tags without reason.
- When behaviour visible in the UX changes, update `README.md`, the in-app Help/documentation panel, and log to `CHANGES.md`; bump `sw.js` `VERSION`.

## Planning artifacts
`tasks/` holds working plans (`todo.md`, dated `*_[yyyymmdd].md`, `lessons.md`) per the global workflow. Recent work (see git log) has been a staged migration of bulky storage from localStorage to IndexedDB (`tasks/storage-redesign.md`).
