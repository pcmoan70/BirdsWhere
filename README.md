# Species & Checklists

An interactive, **100% in-browser** explorer of species distribution, migration, and
**live observations**, powered by the [BirdNET Geomodel](https://github.com/birdnet-team/geomodel)
running client-side via [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/).
No server, no backend of our own — the neural network runs on your device, and live
observations are pulled directly from third-party APIs.

The model predicts occurrence probabilities for **12,012 species** (birds, mammals,
amphibians, insects) from `(latitude, longitude, week 1–48)`. On top of the model, the
app overlays recent real-world observations and a full field-logging workflow.

## Features

### Map views (Leaflet)
- **Species Range** — probability heatmap for a chosen species, with **▶ Play migration**
  animating the range across all 48 weeks. (Animation previews the year without changing
  your selected week.)
- **Species Richness** — predicted species count per grid cell, also animatable.
- **Base maps**: Light, Dark, Streets, Topographic, Satellite. Deep zoom (to ~0.25° cells)
  with bilinear smoothing.
- **Species-group filter** — restrict every view to birds, mammals, amphibians, insects, or all.

### Location analysis (click the map)
A tabbed panel derived from a single 48-week prediction at the point:
- **Timeline** — per-species phenology bars across the year.
- **Probability** — species × 48-week heatmap (red → green).
- **Arrivals** — diverging heatmap of the arrival score `(P[next] − P[prev]) / max_year`
  (green = arriving, red = departing).
- **Annual Top** — running total of arrival scores; the part of the year a species is most present.
- **Scatter** — top-N species plotted as (arrival, probability), plus a sortable table.

### Species list (per point)
Ranked predicted species at a clicked location, with an optional comparison column:
Δ probability vs previous/next week or the annual mean, **% of annual max**, or **Annual Top**.
When live sources are enabled, each row also fills in **recent observation counts** and a
"days since most recent" age (the list updates progressively as each source returns).

### Live observations
Recent real-world sightings are fetched directly from third-party APIs and matched to the
model's species, around a configurable **sightings radius**:
- **GBIF** and **iNaturalist** — global, no key required.
- **eBird** — global; needs a free API key (adds observer names; 30-day window).
- **Artsobservasjoner** (Norway), **Artportalen** (Sweden, free key), **Laji.fi** (Finland,
  free key) — queried only inside their country.
- **BirdWeather** — a global network of live **BirdNET acoustic** stations; AI sound
  detections aggregated to one "present" record per species, station and day (configurable
  minimum detections/day and confidence). No key.

Sources are managed in **Settings → Data sources** (per-source detail view, enable toggles,
API-key entry with a key-state indicator, fetch window). Failed/timed-out sources are flagged.

### Detections on the map
"Show on map" plots observations as coloured dots (one layer per species) with a legend,
a recency filter, rare-species styling (black centre), a corroboration ring (≥2 observers),
and a dashed **sound-wave ring** for acoustic (BirdWeather) detections. When several species
share a pixel, the highest-priority one shows on top (life list +2, year list +1, starred +1,
rare +1; ties alphabetical). Click a dot for the co-located species; **Add to list** saves
points into a named **point-list** (merge + dedupe).

### Field checklist (mobile birding log)
A per-location list started from the species list or a country. Each card has a tick, a
count stepper, an activity picker (54 codes incl. breeding/traces), a sex toggle, a note,
and ＋ to confirm — GPS-stamped automatically. The ⋮ menu offers **PDF / CSV / Log** export,
**📍 Map** (plot entries by species), and **⬆ Upload** (an eBird-record-format CSV for
ebird.org/import). Year & life lists drive on-map "needs" edges (thin = year, thick = life).

### Species detail card
Right-click / long-press any species name for quick links: **Wikipedia**, **BirdLife
DataZone** (birds), **Macaulay Library**, **Xeno-canto**, **NBN Atlas (UK)**,
**EuroBirdPortal** (deep-linked to the species), national portals, a **Distribution map**
popup, plus **★ Mark interesting** and **Do not show** (manageable in Settings).

### Overlay layers (layer control)
WDPA / Protected Planet, Ramsar wetlands, Natura 2000, OSM nature reserves, and **eBird
hotspots** (clickable; needs the eBird key) — all streamed from the providers, nothing stored.

### Navigation & GPS
**Locate me** (✛) live-follows your position, keeping the marker within the central area of
the screen. A route basket builds a Google Maps multi-stop route to chosen points. A
fullscreen toggle sits at the right of the header.

### Offline & sync (PWA)
Installable. A service worker (`sw.js`) caches the app shell (network-first), the model /
labels / taxonomy / vendor libs (cache-first), and map tiles + computed range data in a
size-capped pool; areas can be pinned for offline use. Optional one-shot **Google Drive sync**
of your settings, lists and points.

**Install for offline use** — open the app **online at least once** so it can cache itself, then:
- **iPhone / iPad:** open the page in **Safari** (iOS 11.3 or newer) → **Share** ⎙ → **Add to Home Screen**. On iOS only Safari can install web apps.
- **Android:** in **Chrome** (or Edge / Firefox / Brave) → **⋮ menu → Install app** (or "Add to Home screen"); or tap the in-app **Offline mode** button when it appears.
- For **offline maps**, download the areas you need first (Settings → Offline maps, or the ⤓ button on the map). The same steps are shown in the app under **Settings → About & how it works**.

### Persistence & i18n
Settings, week, view, lists, checklists and detections persist across visits (localStorage
for small settings, **IndexedDB** for bulky lists/detections). UI in **15 languages**, and
species common names in ~30 languages from `taxonomy.csv`. CSV export throughout.

## Run locally

Static site — serve the `docs/` folder with any static server (a server is required; the app
uses a Web Worker + `fetch()`, so `file://` won't work):

```bash
cd docs
python -m http.server 8000
# open http://localhost:8000
```

## Deploy (GitHub Pages)

The site lives in `docs/`. In **Settings → Pages**: **Source: Deploy from a branch**,
**Branch: `main`**, **Folder: `/docs`**. Pushing to `main` publishes the live site.
**On any user-visible change, bump `VERSION` in `docs/sw.js`** or returning users keep the
stale cached app.

## Project layout

```
docs/
  index.html            Standalone page (mount point + ordered <script> tags)
  app.js                Orchestrator: map, modes, controls, settings, detections, checklist
  inference-worker.js   ONNX Runtime Web worker (the model runs here)
  analysis.js           Probability / Arrivals / Scatter renderers (location analysis)
  sources.js            Data-source registry + enabled/keys config (AppSources)
  fetch.js              Per-source HTTP adapters + shared retry/backoff (AppFetch)
  normalize.js          Each source's JSON → one uniform record shape (AppNormalize)
  aggregate.js          Match records to model species via name index (AppAggregate)
  geo.js                Reverse-geocode + country gating (AppGeo)
  state.js / idb.js     localStorage + IndexedDB persistence (GeoState / AppIDB)
  gdrive-sync.js        Optional one-shot Google Drive sync (GDriveSync)
  i18n/strings.js       UI strings (15 languages) + language ↔ taxonomy column map
  sw.js                 Service worker (offline caching, per-type strategy)
  app.css               Styles
  geomodel_fp16.onnx    Model weights (FP16, ~7 MB)
  labels.txt            Output-index → species_code/sci/common
  taxonomy.csv          Multilingual common names (joined to labels by species_code)
  countries-lite.json   Simplified country borders (source gating)
  vendor/               ORT wasm, Leaflet, h3-js (vendored for offline)
```

## Attribution & licensing

- **App code**: MIT (see `LICENSE`).
- **BirdNET Geomodel** by the [BirdNET team](https://github.com/birdnet-team/geomodel):
  source MIT; **trained weights (`geomodel_fp16.onnx`) are CC BY-SA 4.0** and redistributed
  here under those terms (share-alike + attribution required).
- **Bundled libraries** (`docs/vendor/`): Leaflet (BSD-2-Clause), ONNX Runtime Web (MIT),
  h3-js (Apache-2.0). Loaded from a CDN: @emailjs/browser (MIT), Google Identity Services.
- Observations © their respective providers (eBird/Cornell Lab, GBIF, iNaturalist,
  Artsdatabanken, SLU Artdatabanken, FinBIF/Laji.fi, BirdWeather). Map tiles © OpenStreetMap
  contributors, © CARTO, OpenTopoMap, Esri, UNEP-WCMC, EEA.

Full third-party license texts and attributions are in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

Predictions are model estimates, not ground truth; BirdWeather detections are AI acoustic
identifications, not human-verified.
