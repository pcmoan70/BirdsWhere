# BirdsWhere

**Live app:** <https://pcmoan70.github.io/BirdsWhere/>

An interactive, **100% in-browser** explorer of species **distribution, migration and live
observations**. Everything runs on your device — there is **no server and no backend of our own**;
live observations are pulled straight from third-party databases in your browser, and around them
sit a full field-logging workflow, offline maps and cross-device sync. Observation search covers
birds, mammals, amphibians and insects, as well as **plants and fungi**.

The **distribution maps**, the **migration estimates** and the **rarity-based sorting of observations**
are based on the [BirdNET Geomodel](https://github.com/birdnet-team/geomodel), which estimates how
likely each of **12,012 species** is to occur at a given place and week of the year (run on your
device via [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/)). These are model estimates
of what *could* be present — not a record of what anyone has actually seen; the live observations
layered on top are the real sightings.

> Model outputs are estimates, not ground truth; BirdWeather detections are AI acoustic
> identifications, not human-verified.

---

## Contents

- [The map & its modes](#the-map--its-modes)
- [Species Range & Richness](#species-range--richness-the-model)
- [Location analysis (Migration mode)](#location-analysis-migration-mode)
- [Recent Observations (species list)](#recent-observations-species-list)
- [Historic observations](#historic-observations)
- [Live observation sources](#live-observation-sources)
- [Detections on the map](#detections-on-the-map)
- [The map legend & filters](#the-map-legend--filters)
- [Detections list & "Close by"](#detections-list--close-by)
- [Points, lists & saved sets](#points-lists--saved-sets)
- [Sharing](#sharing)
- [The species menu](#the-species-menu)
- [Field checklist & eBird upload](#field-checklist--ebird-upload)
- [Country resources & place links](#country-resources--place-links)
- [Navigation & GPS](#navigation--gps)
- [Offline use & install (PWA)](#offline-use--install-pwa)
- [Persistence, settings & languages](#persistence-settings--languages)
- [Run locally](#run-locally) · [Deploy](#deploy-github-pages) · [Project layout](#project-layout) · [Attribution](#attribution--licensing)

---

## The map & its modes

A Leaflet map with a **Mode** selector in the header:

- **📍 Recent** — click the map for a ranked species list at that point, with live recent-observation counts.
- **Historic** — search GBIF for a chosen date range and set of months around a point.
- **📍 Migration** — the location-analysis panel (phenology, arrivals, scatter) for a clicked point.
- **Species Range** — a probability heatmap for one chosen species, animatable across the year.
- **Species Richness** — predicted species count per grid cell, also animatable.

**Base maps:** Voyager, Streets, CyclOSM, Topographic, Esri Topo, Satellite — deep zoom (down to ~0.25°
cells) with bilinear smoothing on the model layers. A **Resolution** control trades finer
detail for speed. **More place names** (Settings → Map) renders vector labels (MapLibre GL over
OpenFreeMap's OpenMapTiles data, no key) on the Voyager and Satellite maps, so local names surface
smoothly by zoom + importance with collision avoidance (yr.no-style); it falls back to raster labels
where WebGL is unavailable.

**Species-group filter** (Settings → *Species group*): **All · Birds · Mammals · Amphibians ·
Insects · Plants · Fungi**. It restricts every view — model layers, the species list, the
map dots and the observation fetch. The model covers birds/mammals/amphibians/insects;
**Plants 🌿 and Fungi 🍄 are observation-only** (Range/Richness/Migration are hidden for them).

**Overlay layers** (layer control): **WDPA · Protected Planet**, **Ramsar wetlands**,
**Natura 2000** (EU SPA/SCI), **Emerald Network** (Bern Convention — the non-EU counterpart
to Natura 2000), **Land cover** (CORINE / Copernicus-EEA — habitat backdrop, Europe/EEA),
**GBIF occurrence density** (a seasonal heatmap of where records concentrate),
**OSM protected areas**, **Birding spots** (OSM bird hides, observation towers & viewpoints —
clickable markers for where to watch from), and **eBird hotspots** (clickable — each opens a popup
with an eBird link and *Navigate*; needs the eBird key). All are streamed from the providers;
nothing is stored. Hover a layer's checkbox for a tip on what it shows.

---

## Species Range & Richness (the model)

- **Species Range** — pick a species; the map shades occurrence probability (red → green) for
  the selected week. **▶ Play migration** animates the range across all 48 weeks without
  changing your selected week; **⏸ Pause** stops it.
- **Species Richness** — the predicted number of species per grid cell, also animatable across
  the year.

Everything is computed on-device in a Web Worker; results are cached per week/area so
re-showing a week is instant.

The same predicted probability is reused beyond these two views: it **orders the species lists**
(the per-point Species List and the plotted-detections legend are both ranked by likelihood) and
defines **"locally rare"** — a species at or below the *Rare species threshold* is flagged with the
**◉** icon and can be filtered on, regardless of how often it has actually been reported.

---

## Location analysis (Migration mode)

Click the map in **Migration** mode for a tabbed panel derived from a single 48-week
prediction at that point:

- **Timeline** — per-species phenology bars across the year.
- **Probability** — species × 48-week heatmap (red → green).
- **Arrivals** — a diverging heatmap of the arrival score `(P[next] − P[prev]) / max_year`
  (green = arriving, red = departing).
- **Annual Top** — a running total of arrival scores; the part of the year each species is most present.
- **Scatter** — the top-N species plotted as *(arrival, probability)*, with a sortable table.

**Top N** and **Rank by** (Arrivals / Probability / Both) tune which species are shown.

---

## Recent Observations (species list)

Click the map in **Recent** mode for the predicted species at that point, ranked by
probability. Options:

- An optional **comparison column** — Δ probability vs the previous / next week or the annual
  mean, **% of annual max**, or **Annual Top**.
- With live sources enabled, each row fills in a **recent-observation count** and a
  **"days since most recent"** age (*n(d)*), updating progressively as each source returns.
  Click a count to open the merged recent-observations modal (CSV-downloadable, plottable) — the
  same panel as **"More of these"** in a species menu, which fetches recent sightings of that
  species within **50 km** (eBird / GBIF / iNaturalist).
- Species the model doesn't cover but that the sources reported are appended below the
  predicted rows, tagged with a class glyph.

**The colour dot** before each species name carries its **status**, the same way the map
marker does — no separate status columns:

| dot cue | meaning |
|---|---|
| **★** (in the species colour) | starred / interesting |
| centre dot | rare here |
| bronze ring | not on this year's list |
| yellow ring | not on your life list |
| red slash | blocked |

**"Rare here"** means the **habitat model** gives the species at most the *Rare species
threshold* probability at that point (Settings, default 10 %) — it is **not** a count of
reports, so a much-reported vagrant still counts as rare and a well-modelled common bird
never does. **Filtering** by these states (and clearing them) lives in the **Species header
panel**; clicking a column header opens that column's filter + sort panel (see below).

The Species column panel also holds **species lists**: build a selection and *Save selection as
list* to reuse it, and tap a **premade group** (Raptors, Owls, Ducks & geese, Waders, Gulls &
terns, Herons, Woodpeckers, Finches, Crows & jays, Hummingbirds, Pigeons, Warblers) to filter the
plotted species to that taxonomic group — derived offline from the bundled IOC taxonomy (Order /
Family), and shown only for groups with a match in what's currently plotted.

---

## Historic observations

**Historic** mode searches **GBIF** for a custom **date range** and (optionally) a set of
**months** around the point. Drag the dashed fetch box or change the radius, then press
**Fetch**; results list species with their record counts and last-seen dates, and can be
plotted on the map like any other detections.

---

## Live observation sources

Recent real-world sightings are fetched directly from third-party APIs, matched to the
model's species, and merged — around a configurable **sightings radius**. Managed in
**Settings → Data sources** (per-source *On* toggle, name, key, fetch-window days, endpoint);
failed or timed-out sources are flagged in the status line.

**Direct sources**

| source | scope | key |
|---|---|---|
| **GBIF** | global base layer (a set of datasets, below) | none |
| **iNaturalist** | global | none |
| **eBird** | global (adds observer names; ~30-day window) | free API key |
| **BirdWeather** | global — live **BirdNET acoustic** stations | none |
| **Artsobservasjoner** | Norway only | none |
| **Artportalen** | Sweden only | free subscription key |
| **Laji.fi** | Finland only | free access token |

Country-scoped sources are queried only when the point (plus its radius) reaches that
country. **BirdWeather** collapses machine detections to one "present" record per species,
station and day, tunable by **min detections/day** and **min confidence**. **eBird** and
**BirdWeather** are birds-only; the other sources honour the species-group filter.

**GBIF datasets** (Settings → *GBIF datasets*, each individually toggled): **Observation.org**,
**Birda**, **Pl@ntNet** and **eBird EOD** (global, historic) — plus nation-tagged
**Artportalen (SE)**, **Artsobservasjoner (NO)**, **Laji.fi / Notebook (FI)**, **DOFbasen (DK)**,
**eElurikkus / EELIS (EE)**, **SmartBirds / BSPB (BG)**, **naturgucker (DE)**, **Birds of Ireland (IE)**,
**AIRONE Wintering Birds (IT)**, **Salzburg biodiversity DB (AT)**, **Oiseaux des Jardins + Faune-Occitanie
(FR, historic)**, **SABAP2 (ZA)** and **Birdata (AU)**. You can add your own datasets by hand (country
code + dataset key or gbif.org URL).

**Sightings radius** — set it with the Settings slider **or Shift + mouse-wheel over the map**
(scroll up = larger). It steps a 0.1 … 150 km ladder (default **25 km**), controls the fetch
box for Recent/Historic mode (previewed as a live dashed square), and sets the default radius
of newly saved locations.

**Fetching & detections** settings include a **Fetch timeout**, a **Download — last N days**
window (how far back a normal fetch reaches, applied to every source — eBird stays capped at its
30-day API limit, GBIF at ~92; `0` = each source's own default; Fetch on open keeps its own
separate window), a **Reuse downloads (min)** window (reopening reuses a location's
already-downloaded observations for N minutes rather than re-fetching; default 30, a cached
location can even open offline), and a **cross-database de-duplication** toggle (show a sighting
registered in two databases once instead of twice — off by default).

---

## Detections on the map

**Show in map** / **📍 Map** plots the fetched observations as coloured SVG dots, one colour
per species:

- **Rare here** → a small **black centre dot**.
- **Starred** species → drawn as a **star** rather than a disc.
- **≥ 2 observers** at a spot for that species → a **dashed corroboration ring**; hover lists them.
- **BirdWeather (acoustic)** records → a **dashed "sound-wave" ring** in the species colour, so
  machine-heard records read differently from human sightings.
- **Year / life "needs" edges** (toggleable): a **thin bronze** rim (🟠) = missing from this
  year's list, a **thick yellow** rim (🟡) = missing from your life list — the same colour
  convention as the species-list status columns, the legend and the species menu.
- When several dots share a pixel, the **highest-priority** one draws on top (life list +2,
  year list +1, starred +1, rare +1; ties alphabetical).
- Each fetch leaves a **thin dashed green outline** of the area it covered; these accumulate.

Clicking a dot opens the co-located-species list for that spot; **Save** stores those points
into a named point-list.

---

## The map legend & filters

The legend (bottom-left) lists the plotted species **ordered by the habitat model's predicted
probability** (lowest → highest; a species with several observations uses its highest one).
Each row shows a swatch, the name, a `visible/total` count and a per-row × to drop it.
Tap a row to isolate/select it; press-and-hold isolates on the map.

The control line opens three mutually-exclusive **filter subwindows**:

- **Time** — presets in a grid (days 1–6, weeks 1–6, months 1–3), an **all/∞** chip, a
  **From–To** date range, and a **month-of-year** chip row (Jan–Dec) that slices the shown
  observations to particular months — handy for narrowing a fetched Historic range without
  re-fetching (in Historic mode the month toggles above the date picker filter the plotted
  dots live too).
- **Species** — **– All · ★ Starred · ◉ Rare · 🟠 Not on this year's list · 🟡 Not on your life list**.
- **👤 Observers** — a checklist of observers with a scope button that cycles **All → None →
  each saved observer list**, plus an editor (**✎**).

Plus **−** minimise (to a corner pill), a black **× Clear filters** (keeps the dots), and a
red **×** that clears all detections — or, when fetched-area outlines exist, first arms
**per-area delete** (a red × on each area removes just that area's detections; a second click
clears everything). A **⚠** appears when the *Max points on map* draw cap is hiding dots.

There's also a standalone red **×** on the **right of the map** (near the offline-download button),
shown only while observations are plotted: one tap clears them all off the map and the × disappears.

---

## Detections list & "Close by"

- **☰ Detections list** — a large-text list sorted **By date** (grouped by date, then
  observer/station) or **By species**, with a narrow **Filter species** box and the day / rarity+year-list
  / observer filters beside it. Each row's **🎯** flies the map to the record; tapping the row opens its
  species menu. The header carries the place-name title (led by a copy-coordinates button) plus **Save**
  (as a point list), **Navigate** (Google Maps) and **＋➤ Add to route** (drops this spot into the route
  bar). With the *2nd name* option on, rows append the secondary-language name in parentheses.
- **Close by** — the **☰** button (top-left of the map) opens a big-text list of the plotted
  detections **sorted by distance** from your live GPS cross, fixed cross, placed pin or the map
  centre. Each row shows the count, days-since and distance; tapping **📍** jumps the map to it.
  It recomputes as you move, can optionally include your placed map points, and its row count is
  a Setting.

---

## Points, lists & saved sets

- **Map points** — right-click (desktop) or long-press (touch) the map to drop a pin and open
  the **point editor**: name, tags, a per-point colour (or automatic), a note (optionally
  rendered as HTML), a copyable-coordinates pill, and a *Save to list* picker. The **Points**
  header button (badge = number of lists) opens a panel of tick-to-show lists, per-tag filter
  chips, a Distance/Name sort, and the merged points sorted by distance. **Press-and-hold or
  right-click** that button for the **Edit & protect lists** admin: rename a list, set its
  colour/tags for every point, **protect** it from deletion (🔒), delete it, or expand it to
  edit/remove individual points.
- **Import / export** — points import and export as **KML and KMZ** (Settings → *Map points*).
  Import reports the placemarks found and lets you map each placemark field (name / description /
  folder / ExtendedData) to the point's name, tags and note, with a *Note contains HTML* option.
- **Observer lists & nicknames** — build named sets of observers, filter the map/list to them
  via the legend's 👤 scope cycle, hover a name to isolate their records, or tap a name (in the
  legend or the detections list) to add them to a list.
- **Stored locations** — from a point's *Location ▸ → 📍 Save location*, name a spot and give it
  a radius. Press-and-hold the **locate** control to recall them, fly to any one, and tick
  several to **Fetch observations** from all of them (each within its own radius) onto the map.
  A **⟳ "load on open"** tick column (header above the checkboxes) marks spots to auto-fetch:
  enable **Fetch on open** (Settings) — with its own **"last N days to fetch"** window — and the
  app fetches + plots those spots' observations on every plain open, reusing the download cache
  (so it's instant within the reuse window; skipped for shared / `?here` links).
- **Detection sets** — named snapshots of a whole plot (dots, dates, observers, sources, stars)
  that appear as **🗂 tick-to-show overlay rows** in the Points panel; they sync across devices
  and are shareable as a link/file. (Deleting one removes it on every device via a tombstone.)

---

## Sharing

- **A location** — the point popup's *Location ▸ → 🔗 Share link* makes a **plain, readable URL**
  carrying just the coordinates (`…?lat=&lon=&zoom=`). Open it to land on that exact spot with the
  pin down; it stays in the address bar, so it's bookmarkable.
- **A list or detection set** — the **🔗** on its Points-panel row makes a self-contained link.
- **The whole map** — **Share map** packs every plotted detection *and* your shown points into one
  link.
- Recipients need **no API keys** — shared data is embedded in the link and never re-fetched, and
  species names show in the recipient's own language with each record's source for verification.
- **File fallback** — a link over ~20 000 characters is handed over as a `.mcshare` file instead,
  re-imported from the Points panel.
- **QR** — Settings shows a static QR that opens/shares the **app itself** (not any data).
- Opening a shared link imports it after a confirmation, then strips the parameter so it won't
  re-import on reload.

### Shortcut URLs

Open the app straight onto a point's observations — handy as a home-screen bookmark or a link from
another app. Options are `;`- or `&`-separated `key=value` pairs.

**Parameters**

- **`location`** — `here` (geolocate to your current position) **or** explicit `lat,lon` coordinates
  (e.g. `60.12312,32.00123`; latitude −90…90, longitude −180…180).
- **`radius`** — sightings search radius in km (e.g. `5`); persisted, so it also updates the Settings
  slider.
- **`show`** — `map` (default: land on the map with the dots dropping in as they load) or `list` (open
  the ranked list page directly).
- **`sortby`** — `rarity_increasing` (default; most likely / commonest species first),
  `rarity_decreasing` (rarest first), or `time_recent` (most recently observed first).

**Examples** (base: `https://pcmoan70.github.io/BirdsWhere/`)

```
?here=1
    Geolocate and open the per-point species list at your current position (legacy shortcut).

?location=here
    Same as above, via the richer parameter.

?location=here;radius=5;show=list;sortby=time_recent
    Geolocate, 5 km radius, open the list, most-recently-seen species first.

?location=60.12312,32.00123;radius=10;show=map;sortby=rarity_decreasing
    Go to those coordinates, 10 km radius, land on the map, rarest species first.

?location=59.9139,10.7522
    Go to a fixed point (Oslo) with the current defaults.
```

---

## The species menu

Right-click / long-press / tap any species name for:

- **Information** — Distribution map (a Wikipedia range image), **Wikipedia**, **BirdLife
  DataZone** (birds), **Macaulay Library** photos/audio (narrowed to the observation's season — a
  ±1-month `beginMonth`/`endMonth` window — so images match the time of year), **Xeno-canto** audio,
  **NBN Atlas (UK)**, **EuroBirdPortal** (birds, deep-linked to the species).
- **Lists & actions** — **Show only this species** (when it has observations plotted: isolates that
  species on the map + detections list, like a legend selection; tap again on the same species to show
  everything), then state-showing **toggles**: **Interesting** (★), **Year list**, **Life
  list** (each coloured when the species is in that set, greyed when not), and **Hidden**, which
  toggles both ways (**red** = this click hides the species, **green** = this click brings it
  back — so a blocked species surfaced via the list's 🚫 filter can be unblocked here). Also
  **＋ Add to route**.

---

## Field checklist & eBird upload

A per-location birding log started from the species list or a country. Each species card has a
tick, a count stepper (±1 / ±10 / ±25), an **activity picker** (54 codes incl. breeding codes
and traces), a **sex toggle** (◦ → ♂ → ♀ → ⚥ → ♀?), a **note**, **📷 photos** (stored on the
device, included in the exported report), and **＋** to confirm — each entry GPS-stamped, with a
warning when far from the checklist's saved point.

The **⋮** menu exports **🖨 Print / Save as PDF**, **⬇ CSV**, **⬇ Log** (one row per entry with
ISO timestamp, coordinates, count, sex, activity, note), and **📍 Map** (plot entries by
species). **⬆ Upload** opens a **Review & upload** page that groups entries into checklists —
each with protocol, start time, duration, distance, area, observers, effort notes — and produces
an **eBird Record Format CSV** ready for [ebird.org/import](https://ebird.org/import/upload)
(birds only; direct API submit is a partner-only stub).

---

## Country resources & place links

- **Map-click popup** — **📍 Recent** (species list), a **📍 Location** submenu (*Save location*,
  *Share link*, *Copy coordinates*), a **Birdingplaces** link (birdingplaces.eu at the point),
  and, for Sweden & Norway, a **Fågelkartan** link to that point's county / fylke page.
- **Country button (globe, right side)** — reads the country at the map centre and opens **Birding
  blogs** (a curated, per-country list of personal birder blogs you can add to and remove — synced),
  the **BirdLife DataZone** country factsheet, and the **national observation services** for that
  country (plus any custom links you add in Settings → *National databases*).

---

## Navigation & GPS

- **Locate me** (crosshair, top-left) cycles three states: **off** → **follow** (the map
  re-centres on your live position as you move) → **read** (a fixed centre cursor: pan a plotted
  dot, map point or eBird hotspot under it to open it). Press-and-hold recalls **stored locations**.
- **Route basket** — add points/species stops; a floating **Route (N) · Navigate** pill opens the
  whole ordered route in Google Maps. It survives reload. **Save route** keeps it as a named list in the
  Points panel; ticking that list again (or reopening the app with it shown) brings the numbered stops
  and the Navigate bar back, so a saved route reloads ready to navigate. Saved routes are marked with a
  **➤** badge in the Points panel, and their **🧭** button opens Google Maps directions through the stops
  directly (ordinary point-lists instead export as pins for Google My Maps).
- **Fullscreen** toggle, and a **Nearby places** picker.

---

## Offline use & install (PWA)

Installable as a Progressive Web App. A **service worker** serves the app shell **cache-first**
(once installed, code runs from the device and isn't re-downloaded while online — fresh code
arrives only when the app's `VERSION` is bumped on deploy, after a full reload), with the model /
labels / taxonomy / vendor libraries cache-first too, and map tiles + computed range data in a
size-capped pool.

**Install** — open the app **online at least once** so it can cache itself, then:

- **iPhone / iPad:** open in **Safari** (iOS 11.3+) → **Share** ⎙ → **Add to Home Screen**
  (only Safari can install web apps on iOS).
- **Android:** in **Chrome** (or Edge / Firefox / Brave) → **⋮ → Install app**; or tap the in-app
  **⤓ Offline mode** button when it appears.

**Offline maps** — download the areas you need with the map's **⤓** button (**press-and-hold** for
the manager). Areas are colour-coded frames you can delete individually; if the browser evicts
tiles, the app detects it and offers to re-download. Pinned areas are never auto-purged.

**Google Drive sync** — an optional **manual, one-shot** sync (⟳ *Sync now*): it signs in with a
`drive.appdata`-only scope, does one pull → merge → push of your **settings, checklists, map
points/lists and eBird key** to a hidden per-user Drive file, then disconnects (token kept in
memory only; no background sync).

---

## Persistence, settings & languages

- **Persistence** — settings, week, view, species/year/life lists, checklists, points and plotted
  detections survive across visits. Small settings live in **localStorage**; bulky per-list data
  (saved sets, detections) lives in **IndexedDB** to avoid the ~5 MB cap, hydrated into memory once
  at boot.
- **Languages** — the **UI is fully translated into 15 languages** (en, sv, de, es, fr, nl, it, pt,
  pl, cs, no, da, fi, et, lt); other languages fall back to English UI text while still showing
  localised species names. **Species common names are available in ~45 languages** from
  `taxonomy.csv`.
- **CSV export** throughout (recent detections, species lists, checklist CSV/Log, eBird
  Record-Format CSV). A **Share between devices** section also **exports/imports all your data as a
  backup file** (merging checklists on import) and shows the app QR.
- Settings additionally cover base map & resolution, map-data cache size, second-name and
  scientific-name display, the rare-species threshold, max map points, hotspot minimum species,
  and country sampling resolution.

---

## Your data & privacy

Everything you create — saved **points**, **lists / trips**, **field checklists** (and attached
photos), **stored locations**, your ★/year/life/hidden species, observer lists and all **settings**
— is kept **only on your device** (localStorage + IndexedDB). There is **no account and no server of
ours**; nothing is uploaded on its own.

Your data leaves the device only when **you** act:

- a **🔗 share link** or **Share map** — packs the points / detections you pick into a URL you hand out;
- an **export** — CSV, KML/KMZ, GeoJSON or PDF, or the full backup file;
- the optional one-tap **Google Drive backup**, into your *own* Drive's private app folder.

Separately, simply using the app sends the **map coordinates you are viewing** to the third-party
observation databases (GBIF, eBird, iNaturalist…) and the map / place-name provider, so they can
return sightings and names — but never anything you have saved. The AI model itself runs fully
on-device: computing a prediction sends your location nowhere.

---

## Run locally

Static site — serve the `docs/` folder with any static server (a server is required; the app uses
a Web Worker + `fetch()`, so `file://` won't work):

```bash
cd docs
python -m http.server 8000
# open http://localhost:8000
```

## Deploy (GitHub Pages)

The site lives in `docs/`. In **Settings → Pages**: **Source: Deploy from a branch**,
**Branch: `main`**, **Folder: `/docs`**. Pushing to `main` publishes the live site.
**On any user-visible change, bump `VERSION` in `docs/sw.js`** — otherwise returning users keep
serving the stale cached app shell.

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
  geomodel_fp16.onnx    Model weights (FP16)
  labels.txt            Output-index → species_code / sci / common
  taxonomy.csv          Multilingual common names (joined to labels by species_code)
  countries-lite.json   Simplified country borders (source gating)
  vendor/               ORT wasm, Leaflet, h3-js (vendored for offline)
```

## Attribution & licensing

- **App code**: MIT (see `LICENSE`).
- **BirdNET Geomodel** by the [BirdNET team](https://github.com/birdnet-team/geomodel): source
  MIT; **trained weights (`geomodel_fp16.onnx`) are CC BY-SA 4.0** and redistributed here under
  those terms (share-alike + attribution required).
- **Bundled libraries** (`docs/vendor/`): Leaflet (BSD-2-Clause), ONNX Runtime Web (MIT), h3-js
  (Apache-2.0). Loaded from a CDN: @emailjs/browser (MIT), Google Identity Services.
- Observations © their respective providers (eBird / Cornell Lab, GBIF, iNaturalist,
  Artsdatabanken, SLU Artdatabanken, FinBIF / Laji.fi, BirdWeather, Observation.org). Map tiles
  © OpenStreetMap contributors, © CARTO, OpenTopoMap, Esri, UNEP-WCMC, EEA.

Full third-party license texts and attributions are in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
